import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * Head rig built from a scanned human head (Lee Perry-Smith, CC-BY 3.0),
 * re-materialed as a cyan hologram. The scan keeps the skull proportions that
 * a procedural sphere gets wrong at this size, which is what made it read as
 * an alien egg.
 *
 * The mesh is normalised to HEAD_WIDTH world units (120 px in the UI) and
 * centred; the height follows the real proportions (~1.34).
 */

export type HeadMaterial = "normal" | "hologram";

export const HEAD_WIDTH = 1.2;
export const MOUTH_UNIFORMS = { open: { value: 0 } };

/** 1 = the model faces +Z (as the three.js asset does). */
const FORWARD = 1;

export interface HeadRig {
  group: THREE.Group;
  eyes: THREE.Mesh[];
  mouth: THREE.Mesh;
  materials: THREE.ShaderMaterial[];
  size: THREE.Vector3;
}

const MODEL_URL = new URL("models/head.glb", document.baseURI).href;

/** Fraction of the bust height kept from the top (0.52 = head + jaw). */
const HEAD_CUT = 0.46;

/** Drop triangles that sit entirely below `y` (neck and shoulders). */
function clipBelow(source: THREE.BufferGeometry, y: number): THREE.BufferGeometry {
  const position = source.attributes.position;
  const kept: number[] = [];

  for (let i = 0; i < position.count; i += 3) {
    const y0 = position.getY(i);
    const y1 = position.getY(i + 1);
    const y2 = position.getY(i + 2);
    if (y0 < y && y1 < y && y2 < y) continue;
    for (const index of [i, i + 1, i + 2]) {
      kept.push(position.getX(index), position.getY(index), position.getZ(index));
    }
  }

  const clipped = new THREE.BufferGeometry();
  clipped.setAttribute("position", new THREE.Float32BufferAttribute(kept, 3));
  clipped.computeVertexNormals();
  return clipped;
}

function findMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((object) => {
    if (found) return;
    const candidate = object as THREE.Mesh;
    if (candidate.isMesh) found = candidate;
  });
  return found;
}

export async function loadHead(material: HeadMaterial = "normal"): Promise<HeadRig> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(MODEL_URL);

  const mesh = findMesh(gltf.scene);
  if (!mesh) throw new Error("head mesh not found in glb");

  // The scan is a bust (head, neck and shoulders); keep only the head.
  mesh.updateWorldMatrix(true, false);
  let geometry = mesh.geometry.toNonIndexed();
  geometry.applyMatrix4(mesh.matrixWorld);
  geometry.computeBoundingBox();

  const full = geometry.boundingBox!;
  const cutY = full.min.y + (full.max.y - full.min.y) * HEAD_CUT;
  geometry = clipBelow(geometry, cutY);
  geometry.computeBoundingBox();

  const box = geometry.boundingBox!;
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);

  // Centre at the origin, then normalise the width.
  geometry.translate(-centre.x, -centre.y, -centre.z);
  const scale = HEAD_WIDTH / size.x;
  geometry.scale(scale, scale, scale);
  geometry.computeVertexNormals();

  const dims = size.clone().multiplyScalar(scale);

  const group = new THREE.Group();
  const headMaterial =
    material === "normal" ? createNormalMaterial() : createHologramMaterial(1.0);

  // Regions where the scan's own eyes and lips are flattened out so our
  // emissive features are the only facial detail (hologram variant only).
  if (headMaterial.uniforms.uEye) {
    headMaterial.uniforms.uEye.value.set(dims.x * 0.17, dims.y * 0.075);
    headMaterial.uniforms.uEyeR.value.set(dims.x * 0.19, dims.y * 0.12);
    headMaterial.uniforms.uMouth.value.set(0, -dims.y * 0.23);
    headMaterial.uniforms.uMouthR.value.set(dims.x * 0.17, dims.y * 0.16);
  }
  const head = new THREE.Mesh(geometry, headMaterial);
  head.frustumCulled = false;
  group.add(head);

  // Eyes and mouth sit on the front of the face, positioned from head
  // proportions rather than UV coordinates.
  const eyeMaterial = createFeatureMaterial();
  eyeMaterial.uniforms.uOpen.value = 1;
  const eyes = [-1, 1].map((side) => {
    const material = eyeMaterial.clone();
    material.uniforms.uOpen.value = 1;
    const eye = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    eye.scale.set(dims.x * 0.17, dims.y * 0.026, 1);
    eye.position.set(side * dims.x * 0.17, dims.y * 0.075, FORWARD * (dims.z * 0.34));
    eye.rotation.z = side * -0.07;
    group.add(eye);
    return eye;
  });
  eyeMaterial.dispose();

  const mouthMaterial = createFeatureMaterial();
  mouthMaterial.uniforms.uOpen = MOUTH_UNIFORMS.open;
  const mouth = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mouthMaterial);
  mouth.scale.set(dims.x * 0.125, dims.y * 0.019, 1);
  mouth.position.set(0, -dims.y * 0.255, FORWARD * (dims.z * 0.35));
  group.add(mouth);

  return {
    group,
    eyes,
    mouth,
    materials: [headMaterial, ...eyes.map((eye) => eye.material as THREE.ShaderMaterial), mouthMaterial],
    size: dims,
  };
}

/**
 * View-space normal colours, exactly like MeshNormalMaterial: the face reads as
 * a lit, chunky 3D surface instead of a projection. Scanlines and glitches come
 * from the post pass, so the look stays consistent.
 */
function createNormalMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    side: THREE.FrontSide,
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying float vWorldY;

      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldY = world.y;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying float vWorldY;

      void main() {
        vec3 normalColor = normalize(vNormal) * 0.5 + 0.5;
        // Dissolve the clipped neck instead of ending on a hard edge.
        float fade = smoothstep(-0.86, -0.70, vWorldY);
        gl_FragColor = vec4(normalColor, fade);
      }
    `,
  });
}

/** Cyan hologram: fresnel rim, scan bands, panel seams and speckle. */
function createHologramMaterial(intensity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color("#7fd6ff") },
      uIntensity: { value: intensity },
      uEye: { value: new THREE.Vector2(0.2, 0.12) },
      uEyeR: { value: new THREE.Vector2(0.14, 0.08) },
      uMouth: { value: new THREE.Vector2(0, -0.4) },
      uMouthR: { value: new THREE.Vector2(0.12, 0.09) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vLocal;

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormal = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - world.xyz);
        vLocal = position;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vLocal;

      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uTime;
      uniform vec2 uEye;
      uniform vec2 uEyeR;
      uniform vec2 uMouth;
      uniform vec2 uMouthR;

      float oval(vec2 p, vec2 centre, vec2 radius) {
        vec2 d = (p - centre) / radius;
        return dot(d, d);
      }

      void main() {
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        float rim = pow(1.0 - facing, 3.0);

        // Horizontal scan bands travelling upwards.
        float bands = fract(vLocal.y * 42.0 - uTime * 0.35);
        float band = smoothstep(0.0, 0.45, bands) * smoothstep(1.0, 0.55, bands);

        // Robotic panel seams: brow line and jaw line.
        float brow = smoothstep(0.006, 0.0, abs(vLocal.y - 0.30));
        float jaw = smoothstep(0.006, 0.0, abs(vLocal.y + 0.34));
        float seam = clamp(brow + jaw, 0.0, 1.0);

        // Flatten the scanned eyes and lips: no rim, no seam, just a faint fill
        // so the face reads as a smooth mask behind our own features.
        float mask = min(
          min(oval(vLocal.xy, uEye, uEyeR), oval(vLocal.xy, -uEye, uEyeR)),
          oval(vLocal.xy, uMouth, uMouthR)
        );
        float flat_ = 1.0 - smoothstep(0.45, 1.0, mask);
        rim *= 1.0 - 0.96 * flat_;
        seam *= 1.0 - flat_;

        float noise = fract(sin(dot(vLocal.xz * 48.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
        float speckle = step(0.985, noise) * 0.6;

        float glow = 0.42 + 0.95 * rim;
        vec3 color = uColor * (glow * (0.6 + 0.4 * band) + speckle) + uColor * seam * 0.55;
        float alpha = clamp((0.2 + 0.75 * rim) * uIntensity + seam * 0.2, 0.0, 1.0);
        alpha *= 1.0 - 0.45 * flat_;
        alpha *= smoothstep(-0.80, -0.66, vLocal.y);

        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });
}

/** Emissive eyes and mouth: a bright core with soft edges. */
function createFeatureMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uOpen: { value: 0 },
      uBlink: { value: 1 },
      uColor: { value: new THREE.Color("#e8fbff") },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uOpen;
      uniform float uBlink;

      float sdRound(vec2 p, vec2 halfSize, float r) {
        vec2 q = abs(p) - halfSize + r;
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }

      void main() {
        vec2 p = (vUv - 0.5) * vec2(1.0, 1.0);
        float height = mix(0.18, 1.0, uOpen) * uBlink;
        float d = sdRound(p, vec2(0.42, 0.5 * height), 0.28);
        float core = smoothstep(0.06, -0.06, abs(d));
        float halo = smoothstep(0.28, 0.0, abs(d)) * 0.2;
        float alpha = clamp(core + halo, 0.0, 1.0);
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });
}
