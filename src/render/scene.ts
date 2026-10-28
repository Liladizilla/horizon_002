import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { clamp, lerp, smoothstep } from '../core/math';
import { makeCloudTexture } from './textures';
import type { GameSettings } from '../core/settings';
import type { WeatherKind } from '../core/types';

/** Final grade: subtle vignette, chromatic aberration, colour-blind modes. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: 0.38 },
    aberration: { value: 0.4 },
    saturation: { value: 1.06 },
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
    uniform float time;
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
      // Filmic S-curve: deepen the shadows a touch and roll the highlights off
      // instead of clipping them, which is what makes flat renders read as CG.
      col = clamp(col, 0.0, 4.0);
      col = col * col * (3.0 - 2.0 * col) * 0.35 + col * 0.65;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, saturation);
      // Split tone: cool the shadows, warm the highlights.
      col += vec3(-0.012, -0.004, 0.016) * (1.0 - smoothstep(0.0, 0.35, l));
      col += vec3(0.018, 0.010, -0.012) * smoothstep(0.55, 1.0, l);
      col = cb(col);
      float vig = smoothstep(1.05, 0.30, d * 1.35);
      col *= mix(1.0, vig, vignette);
      // Very light grain keeps gradients from banding and hides dither step.
      float grain = fract(sin(dot(uv * vec2(1.0 + time * 0.0003), vec2(12.9898, 78.233))) * 43758.5453);
      col += (grain - 0.5) * 0.006;
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
  /** Second, wider shadow cascade so distant scenery still casts shadows. */
  sunFar: THREE.DirectionalLight;
  clouds: THREE.Mesh;
  private cloudUniforms: Record<string, THREE.IUniform>;
  gtao: GTAOPass | null = null;
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
  private elapsed = 0;

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
    // Draw-call accounting: with a composer the stats would otherwise be reset
    // by every pass, so the reported number is reset once per frame here and
    // accumulates across the GTAO / grade passes.
    this.renderer.info.autoReset = false;

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
    // The Preetham sky is physically scaled in absolute luminance: through ACES
    // at our world exposure it clips to white. Scale it into range so the
    // gradient (deep blue zenith, warm horizon) survives tone mapping.
    this.sky.material.fragmentShader = this.sky.material.fragmentShader.replace(
      'gl_FragColor = vec4( texColor, 1.0 );',
      'gl_FragColor = vec4( texColor * 0.42, 1.0 );',
    );
    this.sky.material.needsUpdate = true;
    this.scene.add(this.sky);

    // ---- lights ----
    // --- near cascade: tight box around the car, crisp contact shadows ------
    this.sun = new THREE.DirectionalLight(0xfff2dd, 3.1);
    this.sun.castShadow = settings.shadows;
    this.sun.shadow.mapSize.set(Math.min(4096, settings.shadowMapSize), Math.min(4096, settings.shadowMapSize));
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.sun.shadow.camera.left = -42;
    this.sun.shadow.camera.right = 42;
    this.sun.shadow.camera.top = 42;
    this.sun.shadow.camera.bottom = -42;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.028;
    this.sun.shadow.radius = 2.2;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // --- far cascade: four times the area, blurrier, for landscape shadows ---
    this.sunFar = new THREE.DirectionalLight(0xfff2dd, 0);
    this.sunFar.castShadow = settings.shadows && settings.quality !== 'low';
    this.sunFar.shadow.mapSize.set(Math.min(2048, settings.shadowMapSize), Math.min(2048, settings.shadowMapSize));
    this.sunFar.shadow.camera.near = 1;
    this.sunFar.shadow.camera.far = 620;
    this.sunFar.shadow.camera.left = -170;
    this.sunFar.shadow.camera.right = 170;
    this.sunFar.shadow.camera.top = 170;
    this.sunFar.shadow.camera.bottom = -170;
    this.sunFar.shadow.bias = -0.0009;
    this.sunFar.shadow.normalBias = 0.09;
    this.sunFar.shadow.radius = 3.5;
    this.scene.add(this.sunFar);
    this.scene.add(this.sunFar.target);

    // --- cloud layer ---------------------------------------------------------
    // A large inverted dome with a drifting fbm cloud texture, lit by the sun
    // direction and faded at the horizon so it meets the sky gradient.
    this.cloudUniforms = {
      uMap: { value: makeCloudTexture(2) },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
      uCoverage: { value: 0.45 },
      uOpacity: { value: 0.9 },
      uSunColor: { value: new THREE.Color(0xfff1dc) },
      uShadowColor: { value: new THREE.Color(0x6d7f95) },
      uHorizon: { value: new THREE.Color(0xb9cfe4) },
    };
    const cloudGeo = new THREE.SphereGeometry(7000, 48, 32, 0, Math.PI * 2, 0, Math.PI * 0.52);
    const cloudMat = new THREE.ShaderMaterial({
      uniforms: this.cloudUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      transparent: true,
      fog: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform float uTime;
        uniform float uCoverage;
        uniform float uOpacity;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uShadowColor;
        uniform vec3 uHorizon;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          if (d.y < 0.005) discard;
          // Project the dome onto a virtual cloud plane: higher up = further away,
          // which gives natural perspective to the layer.
          vec2 uv = d.xz / max(d.y, 0.06) * 0.045 + vec2(uTime * 0.0016, uTime * 0.0009);
          float c1 = texture2D(uMap, uv * 1.0).r;
          float c2 = texture2D(uMap, uv * 2.7 + vec2(0.31, 0.17)).r;
          float c = (c1 * 0.66 + c2 * 0.42) / 1.08;
          // Tight threshold: clouds should be distinct masses with blue between
          // them, not a uniform white haze.
          float lo = 0.62 - uCoverage * 0.26;
          float density = smoothstep(lo, lo + 0.14, c);
          // Sun-forward scattering: crowns bright, undersides grey.
          float sunDot = clamp(dot(d, normalize(uSunDir)) * 0.5 + 0.5, 0.0, 1.0);
          float thickness = smoothstep(0.0, 0.55, c2);
          vec3 col = mix(uSunColor * (0.9 + sunDot * 0.75), uShadowColor, thickness * 0.6);
          // Fade into the horizon haze.
          float horizon = smoothstep(0.0, 0.28, d.y);
          col = mix(uHorizon, col, horizon);
          float alpha = density * uOpacity * smoothstep(0.02, 0.22, d.y) * (0.35 + horizon * 0.65);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    this.clouds = new THREE.Mesh(cloudGeo, cloudMat);
    this.clouds.renderOrder = -0.5;
    this.clouds.frustumCulled = false;
    this.scene.add(this.clouds);

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
    if (s.antialias === 'off' && !s.bloom && !s.ambientOcclusion) { this.composer = null; return; }
    const composer = new EffectComposer(this.renderer);
    composer.setSize(window.innerWidth, window.innerHeight);
    void size;
    composer.addPass(new RenderPass(this.scene, this.camera));
    if (s.ambientOcclusion) {
      // Ground-truth ambient occlusion: gives contact darkening under cars,
      // trees, buildings and kerbs — the cue that most reads as "modelled".
      const gtao = new GTAOPass(this.scene, this.camera, window.innerWidth, window.innerHeight);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 0.85;
      const aoRadius = s.quality === 'ultra' ? 2.2 : 1.6;
      gtao.updateGtaoMaterial({
        radius: aoRadius,
        distanceExponent: 1.6,
        thickness: 1.2,
        scale: 1.0,
        samples: s.quality === 'ultra' ? 16 : 8,
        distanceFallOff: 1.0,
        screenSpaceRadius: false,
      });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 8 });
      composer.addPass(gtao);
      this.gtao = gtao;
    }
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
    this.composer = null; this.bloomPass = null; this.gradePass = null; this.smaaPass = null; this.gtao = null;
    this.setupComposer();
  }

  applySettings(s: GameSettings) {
    this.settings = s;
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    this.renderer.shadowMap.enabled = s.shadows;
    this.sun.castShadow = s.shadows;
    this.sunFar.castShadow = s.shadows && s.quality !== 'low';
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
    this.gtao?.setSize(w, h);
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
    this.sun.position.copy(cameraPos).addScaledVector(sunDir, 90);
    this.sun.target.position.copy(cameraPos);
    this.sunFar.position.copy(cameraPos).addScaledVector(sunDir, 260);
    this.sunFar.target.position.copy(cameraPos);
    this.sunFar.intensity = this.sun.intensity * 0.55;
    this.sunFar.color.copy(this.sun.color);
    this.sun.intensity = smoothstep(-6, 12, elevation) * 2.6 * (env.weather === 'clear' ? 1 : 0.6);
    this.sun.color.setHSL(lerp(0.08, 0.13, smoothstep(0, 25, elevation)), lerp(0.65, 0.25, smoothstep(0, 25, elevation)), lerp(0.62, 0.95, smoothstep(0, 25, elevation)));
    this.hemi.intensity = lerp(0.09, 0.22, nightFactor) * (env.weather === 'clear' ? 1 : 0.85);
    this.ambient.intensity = lerp(0.02, 0.05, nightFactor);

    // Weather-driven fog and exposure
    const fog = this.scene.fog as THREE.FogExp2;
    const baseFog = 0.00016;
    let density = baseFog;
    let fogColor = new THREE.Color(0x94b0c8);
    switch (env.weather) {
      case 'fog': density = 0.0022; fogColor.setHex(0xb9c6cc); break;
      case 'rain': density = 0.00075; fogColor.setHex(0x8d9aa6); break;
      case 'storm': density = 0.0012; fogColor.setHex(0x6c7885); break;
      case 'sandstorm': density = 0.0016; fogColor.setHex(0xc2a273); break;
      case 'snow': density = 0.0011; fogColor.setHex(0xcfd9e2); break;
      case 'overcast': density = 0.00042; fogColor.setHex(0x9fb0bf); break;
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
    const snap = 2;
    const sx = Math.round(cameraPos.x / snap) * snap;
    const sy = Math.round(cameraPos.y / snap) * snap;
    const sz = Math.round(cameraPos.z / snap) * snap;
    this.sun.position.set(sx + sunDir.x * 90, sy + sunDir.y * 90, sz + sunDir.z * 90);
    this.sun.target.position.set(sx, sy, sz);
    this.sun.target.updateMatrixWorld();
    const snapFar = 8;
    const fx = Math.round(cameraPos.x / snapFar) * snapFar;
    const fy = Math.round(cameraPos.y / snapFar) * snapFar;
    const fz = Math.round(cameraPos.z / snapFar) * snapFar;
    this.sunFar.position.set(fx + sunDir.x * 260, fy + sunDir.y * 260, fz + sunDir.z * 260);
    this.sunFar.target.position.set(fx, fy, fz);
    this.sunFar.target.updateMatrixWorld();

    // ---- clouds -----------------------------------------------------------
    this.elapsed += 1 / 60;
    this.cloudUniforms.uTime.value = this.elapsed;
    (this.cloudUniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
    const coverByWeather: Record<string, number> = {
      clear: 0.62, overcast: 1.15, rain: 1.25, storm: 1.5, fog: 1.0, snow: 1.3, sandstorm: 0.9,
    };
    const targetCover = coverByWeather[env.weather] ?? 0.4;
    this.cloudUniforms.uCoverage.value = lerp(this.cloudUniforms.uCoverage.value as number, targetCover, 0.02);
    const sunUp = smoothstep(-4, 14, elevation);
    (this.cloudUniforms.uSunColor.value as THREE.Color).setRGB(
      lerp(0.32, 1.0, sunUp),
      lerp(0.30, 0.96, sunUp),
      lerp(0.36, 0.92, sunUp),
    );
    (this.cloudUniforms.uShadowColor.value as THREE.Color).setRGB(
      lerp(0.06, 0.44, sunUp),
      lerp(0.07, 0.49, sunUp),
      lerp(0.10, 0.58, sunUp),
    );
    (this.cloudUniforms.uHorizon.value as THREE.Color).copy(fog.color).lerp(new THREE.Color(0xffffff), 0.12);
    this.clouds.position.copy(cameraPos);
    this.clouds.visible = !isNight || env.weather !== 'clear';
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
    this.renderer.info.reset();
    if (this.gradePass) this.gradePass.uniforms.time.value += dt;
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  /** Renders one frame to a data URL for photo mode. */
  capture(): string {
    return this.renderer.domElement.toDataURL('image/png');
  }
}
