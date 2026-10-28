import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { clamp, lerp, smoothstep } from '../core/math';
import type { GameSettings } from '../core/settings';
import type { WeatherKind } from '../core/types';

/** Final grade: subtle vignette, chromatic aberration, colour-blind modes. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: 0.32 },
    aberration: { value: 0.4 },
    saturation: { value: 1.08 },
    lift: { value: new THREE.Vector3(0.995, 1.0, 1.008) },
    colorBlindMode: { value: 0 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float aberration;
    uniform float saturation;
    uniform vec3 lift;
    uniform int colorBlindMode;
    varying vec2 vUv;
    vec3 cb(vec3 c) {
      // Simple, well-known daltonisation approximations.
      if (colorBlindMode == 1) { // protanopia
        return vec3(0.567*c.r + 0.433*c.g, 0.558*c.r + 0.442*c.g, 0.242*c.g + 0.758*c.b);
      } else if (colorBlindMode == 2) { // deuteranopia
        return vec3(0.625*c.r + 0.375*c.g, 0.7*c.r + 0.3*c.g, 0.3*c.g + 0.7*c.b);
      } else if (colorBlindMode == 3) { // tritanopia
        return vec3(0.95*c.r + 0.05*c.g, 0.433*c.g + 0.567*c.b, 0.475*c.g + 0.525*c.b);
      }
      return c;
    }
    void main() {
      vec2 uv = vUv;
      vec2 dir = uv - 0.5;
      float d = length(dir);
      vec2 offset = dir * d * 0.0022 * aberration;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + offset).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - offset).b;
      col *= lift;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, saturation);
      col = cb(col);
      float vig = smoothstep(1.05, 0.32, d * 1.35);
      col *= mix(1.0, vig, vignette);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export interface SceneEnv {
  sunDir: THREE.Vector3;
  hour: number;
  weather: WeatherKind;
  wetness: number;
  fogDensity: number;
}

export class Renderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
  sky: Sky;
  composer: EffectComposer | null = null;
  gradePass: ShaderPass | null = null;
  bloomPass: UnrealBloomPass | null = null;
  smaaPass: SMAAPass | null = null;
  pmrem: THREE.PMREMGenerator;
  envRT: THREE.WebGLRenderTarget | null = null;
  private envTime = 0;
  settings: GameSettings;
  private renderScale = 1;
  private frameTimes: number[] = [];

  constructor(canvas: HTMLCanvasElement, settings: GameSettings) {
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: settings.antialias === 'off', powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = true;

    this.camera = new THREE.PerspectiveCamera(settings.fov, window.innerWidth / window.innerHeight, 0.35, 9000);
    this.camera.position.set(0, 8, -18);

    this.scene.fog = new THREE.FogExp2(0xa8c4d8, 0.00022);

    // ---- sky ----
    this.sky = new Sky();
    this.sky.scale.setScalar(45000);
    const uniforms = this.sky.material.uniforms;
    uniforms.turbidity.value = 3.4;
    uniforms.rayleigh.value = 1.6;
    uniforms.mieCoefficient.value = 0.006;
    uniforms.mieDirectionalG.value = 0.82;
    this.scene.add(this.sky);

    // ---- lights ----
    this.sun = new THREE.DirectionalLight(0xfff2dd, 3.1);
    this.sun.castShadow = settings.shadows;
    this.sun.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 340;
    this.sun.shadow.camera.left = -85;
    this.sun.shadow.camera.right = 85;
    this.sun.shadow.camera.top = 85;
    this.sun.shadow.camera.bottom = -85;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Near-neutral sky fill: a strongly blue hemisphere turns every ground
    // surface the colour of water once the sun is only partially dominant.
    this.hemi = new THREE.HemisphereLight(0xcdd2d6, 0x6f5c46, 0.9);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.18);
    this.scene.add(this.ambient);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();

    this.setupComposer();
    window.addEventListener('resize', () => this.onResize());
  }

  private setupComposer() {
    const s = this.settings;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (s.antialias === 'off' && !s.bloom) { this.composer = null; return; }
    const composer = new EffectComposer(this.renderer);
    composer.setSize(window.innerWidth, window.innerHeight);
    void size;
    composer.addPass(new RenderPass(this.scene, this.camera));
    if (s.bloom) {
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.32, 0.62, 0.86);
      composer.addPass(this.bloomPass);
    }
    this.gradePass = new ShaderPass(GradeShader);
    composer.addPass(this.gradePass);
    if (s.antialias === 'smaa') {
      this.smaaPass = new SMAAPass();
      composer.addPass(this.smaaPass);
    }
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  rebuildComposer() {
    if (this.composer) this.composer.dispose();
    this.composer = null; this.bloomPass = null; this.gradePass = null; this.smaaPass = null;
    this.setupComposer();
  }

  applySettings(s: GameSettings) {
    this.settings = s;
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    this.renderer.shadowMap.enabled = s.shadows;
    this.sun.castShadow = s.shadows;
    if (this.sun.shadow.mapSize.width !== s.shadowMapSize) {
      this.sun.shadow.mapSize.set(s.shadowMapSize, s.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    if (this.gradePass) {
      this.gradePass.uniforms.colorBlindMode.value = s.colorBlind === 'protanopia' ? 1 : s.colorBlind === 'deuteranopia' ? 2 : s.colorBlind === 'tritanopia' ? 3 : 0;
    }
    this.onResize();
  }

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
  }

  /** Dynamic resolution: nudge render scale to hold the frame budget. */
  adaptResolution(dt: number, targetMs: number) {
    if (!this.settings.dynamicResolution) return;
    this.frameTimes.push(dt * 1000);
    if (this.frameTimes.length > 45) this.frameTimes.shift();
    if (this.frameTimes.length < 45) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    let next = this.renderScale;
    if (avg > targetMs * 1.14) next = Math.max(0.62, this.renderScale - 0.03);
    else if (avg < targetMs * 0.82) next = Math.min(1, this.renderScale + 0.015);
    if (Math.abs(next - this.renderScale) > 0.005) {
      this.renderScale = next;
      const scale = next * this.settings.renderScale;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * scale);
    }
  }

  updateEnvironment(env: SceneEnv, cameraPos: THREE.Vector3) {
    const hour = env.hour;
    // Sun elevation: sunrise 6h, noon 12h, sunset 18h.
    const dayT = (hour - 6) / 12; // 0..1 over the day
    const elevation = Math.sin(clamp(dayT, -0.35, 1.35) * Math.PI) * 68;
    const azimuth = 170 + dayT * 200;
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    env.sunDir.copy(sunDir);

    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(sunDir);
    // Sunrise/sunset tint
    const nightFactor = smoothstep(-8, 6, elevation);
    u.turbidity.value = env.weather === 'clear' ? 3.2 : 6.5;
    u.rayleigh.value = lerp(0.6, 2.2, nightFactor);

    const isNight = elevation < -2;
    this.sun.position.copy(cameraPos).addScaledVector(sunDir, 120);
    this.sun.target.position.copy(cameraPos);
    this.sun.intensity = smoothstep(-6, 12, elevation) * 2.6 * (env.weather === 'clear' ? 1 : 0.6);
    this.sun.color.setHSL(lerp(0.08, 0.13, smoothstep(0, 25, elevation)), lerp(0.65, 0.25, smoothstep(0, 25, elevation)), lerp(0.62, 0.95, smoothstep(0, 25, elevation)));
    this.hemi.intensity = lerp(0.09, 0.22, nightFactor) * (env.weather === 'clear' ? 1 : 0.85);
    this.ambient.intensity = lerp(0.02, 0.05, nightFactor);

    // Weather-driven fog and exposure
    const fog = this.scene.fog as THREE.FogExp2;
    const baseFog = 0.00022;
    let density = baseFog;
    let fogColor = new THREE.Color(0xa8c4d8);
    switch (env.weather) {
      case 'fog': density = 0.0022; fogColor.setHex(0xb9c6cc); break;
      case 'rain': density = 0.00075; fogColor.setHex(0x8d9aa6); break;
      case 'storm': density = 0.0012; fogColor.setHex(0x6c7885); break;
      case 'sandstorm': density = 0.0016; fogColor.setHex(0xc2a273); break;
      case 'snow': density = 0.0011; fogColor.setHex(0xcfd9e2); break;
      case 'overcast': density = 0.00055; fogColor.setHex(0x9fb0bf); break;
      default: break;
    }
    if (isNight) fogColor.multiplyScalar(0.35);
    fog.density = lerp(fog.density, density, 0.06);
    fog.color.lerp(fogColor, 0.06);
    this.sky.material.uniforms.mieCoefficient.value = isNight ? 0.003 : env.weather === 'clear' ? 0.005 : 0.02;
    this.renderer.toneMappingExposure = lerp(0.9, 0.55, smoothstep(4, -6, elevation)) * (env.weather === 'storm' ? 0.85 : 1);

    // Refresh the environment map a few times a second so reflections track the sky.
    this.envTime += 1;
    if (this.envTime % 30 === 0 || !this.envRT) {
      const rt = this.pmrem.fromScene(this.buildSkyOnlyScene(), 0.02);
      if (this.envRT) this.envRT.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
    }
    this.scene.environmentIntensity = isNight ? 0.08 : 0.09;

    // Shadow camera follows the player, snapped to reduce shimmering.
    const snap = 4;
    this.sun.position.set(
      Math.round(cameraPos.x / snap) * snap + sunDir.x * 120,
      Math.round(cameraPos.y / snap) * snap + sunDir.y * 120,
      Math.round(cameraPos.z / snap) * snap + sunDir.z * 120,
    );
    this.sun.target.position.set(Math.round(cameraPos.x / snap) * snap, Math.round(cameraPos.y / snap) * snap, Math.round(cameraPos.z / snap) * snap);
    this.sun.target.updateMatrixWorld();
  }

  private skyScene: THREE.Scene | null = null;
  private buildSkyOnlyScene(): THREE.Scene {
    if (!this.skyScene) {
      this.skyScene = new THREE.Scene();
      const skyCopy = new Sky();
      skyCopy.scale.setScalar(45000);
      skyCopy.material.uniforms = {
        turbidity: { value: 3.2 }, rayleigh: { value: 1.6 }, mieCoefficient: { value: 0.005 },
        mieDirectionalG: { value: 0.82 }, sunPosition: { value: new THREE.Vector3(1, 0.3, 0) }, up: { value: new THREE.Vector3(0, 1, 0) },
      } as unknown as typeof skyCopy.material.uniforms;
      this.skyScene.add(skyCopy);
      this.skyScene.userData.sky = skyCopy;
    }
    const skyCopy = this.skyScene.userData.sky as Sky;
    skyCopy.material.uniforms.sunPosition.value.copy(this.sky.material.uniforms.sunPosition.value);
    skyCopy.material.uniforms.rayleigh.value = this.sky.material.uniforms.rayleigh.value;
    skyCopy.material.uniforms.turbidity.value = this.sky.material.uniforms.turbidity.value;
    skyCopy.material.uniforms.mieCoefficient.value = this.sky.material.uniforms.mieCoefficient.value;
    return this.skyScene;
  }

  render(dt: number) {
    if (this.gradePass) this.gradePass.uniforms.time.value += dt;
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  /** Renders one frame to a data URL for photo mode. */
  capture(): string {
    return this.renderer.domElement.toDataURL('image/png');
  }
}
