import * as THREE from "three";

/**
 * Procedural bust: head, neck and shoulder stub, built so the whole silhouette
 * is 1.2 world units wide by 2.0 tall. With the camera framing in
 * createAvatar that maps exactly to the 120x200 px box in the UI, so swapping
 * the mesh later only requires keeping the same bounding box.
 */

const HEAD_BOTTOM = -0.25;
const HEAD_TOP = 1.0;
const NECK_BOTTOM = -0.6;
const SHOULDER_BOTTOM = -1.0;

export const FACE = {
  eyes: { x: 0.19, y: 0.55, z: 0.43 },
  eyeWidth: 0.17,
  eyeHeight: 0.05,
  mouth: { y: 0.24, z: 0.43 },
  mouthWidth: 0.24,
  mouthHeight: 0.035,
};

export const MOUTH_UNIFORMS = {
  open: { value: 0 },
};

export function createBust(): {
  group: THREE.Group;
  head: THREE.Mesh;
  eyes: THREE.Mesh[];
  mouth: THREE.Mesh;
  materials: THREE.ShaderMaterial[];
} {
  const group = new THREE.Group();
  const materials: THREE.ShaderMaterial[] = [];

  const headMaterial = createHologramMaterial(1.0);
  materials.push(headMaterial);

  const headGeometry = createHeadGeometry();
  const head = new THREE.Mesh(headGeometry, headMaterial);
  head.position.y = (HEAD_TOP + HEAD_BOTTOM) / 2;
  group.add(head);

  const neck = new THREE.Mesh(createNeckGeometry(), createHologramMaterial(0.75));
  materials.push(neck.material as THREE.ShaderMaterial);
  group.add(neck);

  const shoulders = new THREE.Mesh(createShoulderGeometry(), createHologramMaterial(0.6));
  materials.push(shoulders.material as THREE.ShaderMaterial);
  group.add(shoulders);

  const eyeMaterial = createFeatureMaterial();
  eyeMaterial.uniforms.uOpen.value = 1;
  const eyes = [-1, 1].map((side) => {
    const eye = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), eyeMaterial.clone());
    (eye.material as THREE.ShaderMaterial).uniforms.uOpen.value = 1;
    eye.scale.set(FACE.eyeWidth, FACE.eyeHeight, 1);
    eye.position.set(side * FACE.eyes.x, FACE.eyes.y, FACE.eyes.z);
    eye.rotation.z = side * -0.06;
    group.add(eye);
    return eye;
  });
  eyeMaterial.dispose();
  materials.push(...eyes.map((eye) => eye.material as THREE.ShaderMaterial));

  const mouthMaterial = createFeatureMaterial();
  mouthMaterial.uniforms.uOpen = MOUTH_UNIFORMS.open;
  const mouth = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mouthMaterial);
  mouth.scale.set(FACE.mouthWidth, FACE.mouthHeight, 1);
  mouth.position.set(0, FACE.mouth.y, FACE.mouth.z);
  group.add(mouth);
  materials.push(mouthMaterial);

  // Fit the whole bust to the 120x200 px box: 2.0 units tall, silhouette
  // centred on the origin so gestures rotate around the middle of the chest.
  const bounds = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  bounds.getSize(size);
  bounds.getCenter(centre);
  const scale = 2.0 / size.y;
  group.scale.setScalar(scale);
  group.position.set(-centre.x * scale, -centre.y * scale, -centre.z * scale);

  return { group, head, eyes, mouth, materials };
}

/** Sphere sculpted into a skull with a tapered jaw and a subtle chin. */
function createHeadGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(1, 64, 48);
  const position = geometry.attributes.position as THREE.BufferAttribute;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    let y = position.getY(i);
    let z = position.getZ(i);

    // Skull proportions: narrower than tall, slightly flattened from the side.
    let px = x * 0.56;
    let pz = z * 0.47;
    let py = y * 0.625;

    // Jaw taper: the lower half narrows towards the chin.
    const jaw = THREE.MathUtils.smoothstep(-py, 0, 0.625);
    const taper = 1 - 0.24 * jaw;
    px *= taper;
    pz *= taper;

    // Nudge the chin forward and flatten the back of the skull a little.
    if (pz > 0) pz += 0.045 * jaw * jaw;
    else pz *= 0.94;

    // Brow ridge: a soft bump above the eyes.
    const brow = Math.exp(-Math.pow((py - 0.18) / 0.12, 2)) * Math.exp(-Math.pow(px / 0.4, 2));
    if (pz > 0) pz += 0.012 * brow;

    position.setXYZ(i, px, py, pz);
  }

  geometry.computeVertexNormals();
  return geometry;
}

function createNeckGeometry(): THREE.BufferGeometry {
  const height = HEAD_BOTTOM - NECK_BOTTOM + 0.12;
  const geometry = new THREE.CylinderGeometry(0.16, 0.21, height, 40, 1, true);
  geometry.translate(0, (HEAD_BOTTOM + NECK_BOTTOM) / 2 - 0.02, 0);
  return geometry;
}

function createShoulderGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);
  geometry.scale(0.6, 0.32, 0.34);
  geometry.rotateX(Math.PI);
  geometry.translate(0, SHOULDER_BOTTOM + 0.32, 0);
  return geometry;
}

/** Cyan hologram: fresnel rim, horizontal bands and a faint inner glow. */
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
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vLocal;
      varying float vWorldY;

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormal = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - world.xyz);
        vLocal = position;
        vWorldY = world.y;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vLocal;
      varying float vWorldY;

      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uTime;

      void main() {
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        float rim = pow(1.0 - facing, 2.4);

        // Horizontal scan bands travelling upwards, in object space.
        float bands = fract(vLocal.y * 46.0 - uTime * 0.35);
        float band = smoothstep(0.0, 0.45, bands) * smoothstep(1.0, 0.55, bands);

        // Sparse signal noise.
        float noise = fract(sin(dot(vLocal.xz * 48.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
        float speckle = step(0.985, noise) * 0.6;

        float glow = 0.38 + 1.35 * rim;
        vec3 color = uColor * (glow * (0.6 + 0.4 * band) + speckle);
        float alpha = clamp((0.2 + 0.85 * rim) * uIntensity, 0.0, 1.0);

        gl_FragColor = vec4(color * alpha, alpha);
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

      // Rounded bar; uOpen stretches it vertically for the mouth.
      float sdRound(vec2 p, vec2 halfSize, float r) {
        vec2 q = abs(p) - halfSize + r;
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }

      void main() {
        vec2 p = (vUv - 0.5) * vec2(1.0, 1.0);
        float height = mix(0.18, 1.0, uOpen) * uBlink;
        float d = sdRound(p, vec2(0.42, 0.5 * height), 0.28);
        float core = smoothstep(0.06, -0.06, abs(d));
        float halo = smoothstep(0.35, 0.0, abs(d)) * 0.25;
        float alpha = clamp(core + halo, 0.0, 1.0);
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });
}
