import * as THREE from 'three';
import { clamp } from '../core/math';

/** Soft round sprite used by all particle systems. */
function particleTexture(): THREE.Texture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; maxLife: number;
  size: number; grow: number;
  r: number; g: number; b: number;
  drag: number; gravity: number;
}

/**
 * Bounded CPU particle pool rendered as a single Points draw call.
 * Old particles are recycled, so memory never grows without limit.
 */
export class ParticleSystem {
  points: THREE.Points;
  private particles: Particle[] = [];
  private geometry: THREE.BufferGeometry;
  private positions: Float32Array;
  private colors: Float32Array;
  private sizes: Float32Array;
  private alphas: Float32Array;
  private max: number;
  private cursor = 0;

  constructor(max: number, texture: THREE.Texture) {
    this.max = max;
    this.positions = new Float32Array(max * 3);
    this.colors = new Float32Array(max * 3);
    this.sizes = new Float32Array(max);
    this.alphas = new Float32Array(max);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture }, scale: { value: window.innerHeight * 0.5 } },
      vertexShader: /* glsl */`
        attribute float size;
        attribute float alpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float scale;
        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D map;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          if (t.a * vAlpha < 0.01) discard;
          gl_FragColor = vec4(vColor, t.a * vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    for (let i = 0; i < max; i++) {
      this.particles.push({ x: 0, y: -9999, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size: 1, grow: 0, r: 1, g: 1, b: 1, drag: 0.5, gravity: 0 });
    }
  }

  spawn(p: Partial<Particle> & { x: number; y: number; z: number }) {
    const particle = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    particle.x = p.x; particle.y = p.y; particle.z = p.z;
    particle.vx = p.vx ?? 0; particle.vy = p.vy ?? 0; particle.vz = p.vz ?? 0;
    particle.life = p.life ?? 1; particle.maxLife = particle.life;
    particle.size = p.size ?? 0.6; particle.grow = p.grow ?? 1.4;
    particle.r = p.r ?? 1; particle.g = p.g ?? 1; particle.b = p.b ?? 1;
    particle.drag = p.drag ?? 0.6; particle.gravity = p.gravity ?? -0.4;
  }

  update(dt: number) {
    const pos = this.positions, col = this.colors, siz = this.sizes, alp = this.alphas;
    for (let i = 0; i < this.max; i++) {
      const p = this.particles[i];
      if (p.life <= 0) { alp[i] = 0; pos[i * 3 + 1] = -9999; continue; }
      p.life -= dt;
      const k = 1 - Math.exp(-p.drag * dt);
      p.vx -= p.vx * k; p.vz -= p.vz * k;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const t = clamp(p.life / p.maxLife, 0, 1);
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      col[i * 3] = p.r; col[i * 3 + 1] = p.g; col[i * 3 + 2] = p.b;
      siz[i] = p.size * (1 + (1 - t) * p.grow);
      alp[i] = t * t;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.attributes.size.needsUpdate = true;
    this.geometry.attributes.alpha.needsUpdate = true;
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = window.innerHeight * 0.5;
  }

  clear() { for (const p of this.particles) p.life = 0; }
}

/**
 * Rolling ring buffer of skid-mark quads. Each wheel that is sliding appends a
 * quad per frame; the buffer wraps so memory is constant.
 */
export class SkidMarks {
  mesh: THREE.Mesh;
  private maxQuads: number;
  private positions: Float32Array;
  private colors: Float32Array;
  private cursor = 0;
  private lastPoint: (THREE.Vector3 | null)[] = [null, null, null, null];
  constructor(maxQuads = 2600) {
    this.maxQuads = maxQuads;
    this.positions = new Float32Array(maxQuads * 4 * 3);
    this.colors = new Float32Array(maxQuads * 4 * 4);
    const indices = new Uint32Array(maxQuads * 6);
    for (let q = 0; q < maxQuads; q++) {
      const b = q * 4;
      indices[q * 6 + 0] = b; indices[q * 6 + 1] = b + 1; indices[q * 6 + 2] = b + 2;
      indices[q * 6 + 3] = b + 1; indices[q * 6 + 4] = b + 3; indices[q * 6 + 5] = b + 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 4));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    for (let i = 3; i < this.colors.length; i += 4) this.colors[i] = 0;
  }

  addSegment(wheelIndex: number, point: THREE.Vector3, normal: THREE.Vector3, width: number, intensity: number) {
    const last = this.lastPoint[wheelIndex];
    if (!last) { this.lastPoint[wheelIndex] = point.clone(); return; }
    const dir = new THREE.Vector3().subVectors(point, last);
    const len = dir.length();
    if (len < 0.12) return;
    if (len > 6) { this.lastPoint[wheelIndex] = point.clone(); return; }
    dir.normalize();
    const side = new THREE.Vector3().crossVectors(dir, normal).normalize().multiplyScalar(width * 0.5);
    const q = this.cursor;
    this.cursor = (this.cursor + 1) % this.maxQuads;
    const p = this.positions;
    const b = q * 12;
    p[b + 0] = last.x - side.x; p[b + 1] = last.y - side.y + 0.012; p[b + 2] = last.z - side.z;
    p[b + 3] = last.x + side.x; p[b + 4] = last.y + side.y + 0.012; p[b + 5] = last.z + side.z;
    p[b + 6] = point.x - side.x; p[b + 7] = point.y - side.y + 0.012; p[b + 8] = point.z - side.z;
    p[b + 9] = point.x + side.x; p[b + 10] = point.y + side.y + 0.012; p[b + 11] = point.z + side.z;
    const alpha = clamp(intensity, 0, 1) * 0.55;
    const c = this.colors;
    for (let v = 0; v < 4; v++) {
      c[q * 16 + v * 4 + 0] = 0.05;
      c[q * 16 + v * 4 + 1] = 0.05;
      c[q * 16 + v * 4 + 2] = 0.06;
      c[q * 16 + v * 4 + 3] = alpha;
    }
    this.lastPoint[wheelIndex] = point.clone();
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  liftWheel(wheelIndex: number) { this.lastPoint[wheelIndex] = null; }

  clear() {
    this.positions.fill(0);
    this.colors.fill(0);
    this.lastPoint = [null, null, null, null];
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }
}

/** Rain / snow / sand overlay implemented as a shader-driven point field. */
export class WeatherParticles {
  points: THREE.Points;
  private material: THREE.ShaderMaterial;
  kind = 'none';
  intensity = 0;

  constructor(count = 6000) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const rnd = () => Math.random();
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (rnd() - 0.5) * 90;
      pos[i * 3 + 1] = rnd() * 40;
      pos[i * 3 + 2] = (rnd() - 0.5) * 90;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 }, intensity: { value: 0 }, kind: { value: 0 },
        opacity: { value: 0.55 }, scale: { value: window.innerHeight * 0.5 },
      },
      vertexShader: /* glsl */`
        attribute float dummy;
        uniform float time;
        uniform float intensity;
        uniform int kind;
        varying float vAlpha;
        void main() {
          vec3 p = position;
          float speed = kind == 2 ? 2.2 : 14.0;
          p.y = mod(p.y - time * speed, 42.0);
          p.x += sin(time * 0.7 + p.z * 0.05) * (kind == 2 ? 1.6 : 0.2) + time * (kind == 1 ? 0.0 : 4.0);
          p.x = mod(p.x + 45.0, 90.0) - 45.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (kind == 2 ? 3.2 : 2.2) * scale / max(-mv.z, 1.0);
          gl_Position = projectionMatrix * mv;
          vAlpha = intensity * (1.0 - smoothstep(20.0, 34.0, -mv.z));
        }
      `,
      fragmentShader: /* glsl */`
        uniform float opacity;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.1, length(d));
          if (a * vAlpha * opacity < 0.01) discard;
          gl_FragColor = vec4(0.85, 0.90, 0.96, a * vAlpha * opacity);
        }
      `,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.visible = false;
  }

  setWeather(kind: 'rain' | 'snow' | 'sandstorm' | 'none', intensity: number) {
    this.points.visible = kind !== 'none' && intensity > 0.02;
    this.material.uniforms.kind.value = kind === 'rain' ? 0 : kind === 'sandstorm' ? 1 : 2;
    this.material.uniforms.intensity.value = intensity;
    if (kind === 'sandstorm') this.material.uniforms.opacity.value = 0.35;
    else this.material.uniforms.opacity.value = 0.6;
    this.kind = kind; this.intensity = intensity;
  }

  update(dt: number, camera: THREE.Camera) {
    this.material.uniforms.time.value += dt;
    this.material.uniforms.scale.value = window.innerHeight * 0.5;
    // Keep the field centred on the camera.
    this.points.position.set(camera.position.x, 0, camera.position.z);
  }
}

export function createEffectTexture() { return particleTexture(); }
