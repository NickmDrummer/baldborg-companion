import * as THREE from "three";
import { createBust, MOUTH_UNIFORMS } from "./bust";

export type Mood = "neutral" | "wry" | "concerned" | "stern" | "amused" | "ominous" | "pleased";

export interface AvatarApi {
  dispose: () => void;
  setMood: (mood: Mood) => void;
  setSpeaking: (speaking: boolean) => void;
  setGlitchIntensity: (value: number) => void;
}

const VIEW_HEIGHT = 2.2;

export function createAvatar(container: HTMLElement): AvatarApi {
  const width = container.clientWidth || 200;
  const height = container.clientHeight || 220;

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.className = "avatar-canvas";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(
    (-VIEW_HEIGHT * (width / height)) / 2,
    (VIEW_HEIGHT * (width / height)) / 2,
    VIEW_HEIGHT / 2,
    -VIEW_HEIGHT / 2,
    0.1,
    10,
  );
  camera.position.z = 3;

  const bust = createBust();
  scene.add(bust.group);

  // Render the scene into a texture so the glitch pass can distort it.
  const target = new THREE.WebGLRenderTarget(width, height, {
    samples: 4,
    depthBuffer: true,
    stencilBuffer: false,
  });

  const postScene = new THREE.Scene();
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postMaterial = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      tDiffuse: { value: target.texture },
      uTime: { value: 0 },
      uGlitch: { value: 0 },
      uResolution: { value: new THREE.Vector2(width, height) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform float uGlitch;
      uniform vec2 uResolution;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      void main() {
        vec2 uv = vUv;

        // Horizontal block displacement during glitch bursts.
        float rows = 72.0;
        float row = floor(uv.y * rows);
        float seed = hash(vec2(row, floor(uTime * 14.0)));
        float gate = step(1.0 - uGlitch * 0.4, seed);
        uv.x += (seed - 0.5) * 0.09 * gate * uGlitch;

        // Small vertical jitter while glitching, never a wrap.
        uv.y += (hash(vec2(row, 3.0)) - 0.5) * 0.01 * uGlitch;

        // Chromatic aberration.
        float split = 0.0012 + 0.009 * uGlitch;
        float r = texture2D(tDiffuse, uv + vec2(split, 0.0)).r;
        vec4 base = texture2D(tDiffuse, uv);
        float b = texture2D(tDiffuse, uv - vec2(split, 0.0)).b;
        vec3 color = vec3(r, base.g, b);

        // Scanlines in screen space.
        color *= 0.84 + 0.16 * sin(vUv.y * uResolution.y * 3.14159);

        // Occasional light sweep.
        float sweep = smoothstep(0.03, 0.0, abs(fract(vUv.y + uTime * 0.1) - 0.5));
        color += vec3(0.04, 0.1, 0.14) * sweep * (0.3 + uGlitch);

        // Sparkle.
        color += (hash(vUv * uResolution + uTime) - 0.5) * 0.02;

        // The scene already renders premultiplied colour into the target.
        float alpha = base.a;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
  postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial));

  let glitch = 0;
  let glitchBurst = 0;
  let baseGlitch = 0.08;
  let speaking = false;
  let mood: Mood = "neutral";
  let blink = 1;
  let nextBlink = 2.5 + Math.random() * 3;
  let blinkPhase = -1;
  let nextGlitch = 4 + Math.random() * 6;
  let disposed = false;

  const started = performance.now();
  let last = started;

  const moodPose: Record<Mood, { tilt: number; yaw: number; eye: number }> = {
    neutral: { tilt: 0, yaw: 0, eye: 1 },
    wry: { tilt: 0.05, yaw: 0.12, eye: 0.85 },
    concerned: { tilt: -0.03, yaw: -0.04, eye: 1.05 },
    stern: { tilt: -0.07, yaw: 0, eye: 0.75 },
    amused: { tilt: 0.04, yaw: 0.06, eye: 0.9 },
    ominous: { tilt: 0.02, yaw: 0, eye: 1.1 },
    pleased: { tilt: 0.02, yaw: 0.03, eye: 0.95 },
  };

  function frame() {
    if (disposed) return;
    const now = performance.now();
    const delta = Math.min((now - last) / 1000, 0.05);
    const time = (now - started) / 1000;
    last = now;

    // Glitch bursts: occasional signal failures.
    nextGlitch -= delta;
    if (nextGlitch <= 0) {
      glitchBurst = 0.12 + Math.random() * 0.2;
      nextGlitch = 3 + Math.random() * 7;
    }
    if (glitchBurst > 0) {
      glitchBurst -= delta;
      glitch = Math.min(1, glitch + delta * 8);
    } else {
      glitch = Math.max(baseGlitch, glitch - delta * 6);
    }

    // Blink every few seconds.
    nextBlink -= delta;
    if (nextBlink <= 0) {
      blinkPhase = 0;
      nextBlink = 3 + Math.random() * 4;
    }
    if (blinkPhase >= 0) {
      blinkPhase += delta / 0.11;
      blink = 1 - Math.sin(Math.min(1, blinkPhase) * Math.PI);
      if (blinkPhase >= 1) {
        blinkPhase = -1;
        blink = 1;
      }
    }

    const pose = moodPose[mood];
    const sway = Math.sin(time * 0.7) * 0.035;
    bust.group.rotation.y = pose.yaw + sway;
    bust.group.rotation.z = pose.tilt + Math.sin(time * 0.5) * 0.012;
    bust.group.rotation.x = Math.sin(time * 0.9) * 0.01;
    bust.group.position.y = Math.sin(time * 1.1) * 0.008;

    for (const material of bust.materials) {
      if (material.uniforms.uTime) material.uniforms.uTime.value = time;
      if (material.uniforms.uBlink) material.uniforms.uBlink.value = blink * pose.eye;
    }

    if (speaking) {
      MOUTH_UNIFORMS.open.value = 0.35 + Math.abs(Math.sin(time * 11)) * 0.65;
    } else {
      MOUTH_UNIFORMS.open.value = 0.06 + Math.abs(Math.sin(time * 1.3)) * 0.04;
    }

    postMaterial.uniforms.uTime.value = time;
    postMaterial.uniforms.uGlitch.value = glitch;

    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);

    requestAnimationFrame(frame);
  }

  const resize = () => {
    const w = container.clientWidth || width;
    const h = container.clientHeight || height;
    renderer.setSize(w, h);
    target.setSize(w, h);
    postMaterial.uniforms.uResolution.value.set(w, h);
    camera.left = (-VIEW_HEIGHT * (w / h)) / 2;
    camera.right = (VIEW_HEIGHT * (w / h)) / 2;
    camera.top = VIEW_HEIGHT / 2;
    camera.bottom = -VIEW_HEIGHT / 2;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  requestAnimationFrame(frame);

  return {
    dispose() {
      disposed = true;
      observer.disconnect();
      renderer.dispose();
      target.dispose();
      postMaterial.dispose();
      renderer.domElement.remove();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
    },
    setMood(next) {
      mood = next;
    },
    setSpeaking(next) {
      speaking = next;
    },
    setGlitchIntensity(value) {
      baseGlitch = THREE.MathUtils.clamp(value, 0, 1);
    },
  };
}
