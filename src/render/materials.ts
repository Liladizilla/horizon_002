/**
 * Material library.
 *
 * Every surface here is a real PBR material driven by the procedural maps in
 * `textures.ts`, plus shared shader injections that give the whole world:
 *
 *  - multi-scale ground detail (grass / rock / sand blended by bake-time biome
 *    weights and slope), including detail normal mapping, so the ground reads as
 *    surface rather than flat vertex colour;
 *  - wetness: rain darkens albedo and drops the roughness in low, flat areas;
 *  - exponential *height* fog, so valleys haze over and peaks stay crisp instead
 *    of everything washing out at one distance.
 *
 * The injections are written as three `onBeforeCompile` patches so we keep the
 * engine's lighting model (IBL, PBR, shadows, tone mapping) instead of
 * hand-rolling a shader.
 */
import * as THREE from 'three';
import { makeAsphaltMaps, makeGravelMaps, makeDirtMaps, makeGroundDetails, makeConcreteMaps, makeFoliageMaps, makeFlakeNormal, type SurfaceMaps, type GroundDetails } from './textures';

export interface MaterialSet {
  terrain: THREE.MeshStandardMaterial;
  asphalt: THREE.MeshStandardMaterial;
  dirt: THREE.MeshStandardMaterial;
  gravel: THREE.MeshStandardMaterial;
  markings: THREE.MeshStandardMaterial;
  water: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  rock: THREE.MeshStandardMaterial;
  building: THREE.MeshStandardMaterial;
  foliageDepth?: THREE.Material;
  /** Updated every frame from the weather system. */
  shared: SharedUniforms;
}

export interface SharedUniforms {
  wetness: { value: number };
  time: { value: number };
  fogFalloff: { value: number };
  fogBase: { value: number };
}

export interface MaterialOptions {
  anisotropy: number;
  /** Enables the extra ground-detail cost; off on the lowest preset. */
  groundDetail: boolean;
}

const FOG_BASE = -4;

/**
 * Shared injection: world position varying (for height fog + ground detail) and
 * an exponential height-fog model. Applied to every lit material in the world.
 */
function injectCommon(material: THREE.Material, uniforms: SharedUniforms, opts: { fog: boolean; worldPos: boolean }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFogFalloff = uniforms.fogFalloff;
    shader.uniforms.uFogBase = uniforms.fogBase;

    if (opts.worldPos) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform float uFogFalloff;\nuniform float uFogBase;');
    }

    if (opts.fog) {
      // Height fog: thicker near the ground, thin at altitude, with a soft
      // distance falloff. Replaces the built-in distance-only fog chunk.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        /* glsl */`
        #ifdef USE_FOG
          float fogDist = length(vWPos - cameraPosition);
          float fogAlt = max(vWPos.y - uFogBase, 0.0);
          float localDensity = fogDensity * (0.35 + 0.65 * exp(-fogAlt * uFogFalloff));
          float fogFactor = 1.0 - exp(-pow(localDensity * fogDist * 1.35, 2.0));
          fogFactor = clamp(fogFactor, 0.0, 1.0);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
        #endif
        `,
      );
    }
  };
  material.customProgramCacheKey = () => `hd-common-${opts.fog ? 1 : 0}-${opts.worldPos ? 1 : 0}`;
}

/** Wetness + rain response shared by every exposed surface. */
function injectWetness(material: THREE.Material, uniforms: SharedUniforms, _baseRoughness: number, darkening = 0.55) {
  const previous = material.onBeforeCompile?.bind(material);
  material.onBeforeCompile = (shader) => {
    previous?.(shader, undefined as unknown as THREE.WebGLRenderer);
    shader.uniforms.uWetness = uniforms.wetness;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWetness;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         diffuseColor.rgb *= mix(1.0, ${darkening.toFixed(2)}, uWetness);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         // Water film fills the micro-relief: glossier, and much more so where the
         // surface is flat (uphill faces shed water).
         roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.34, uWetness);`,
      );
  };
}

/**
 * Terrain: blends three detail sets (grass/rock/sand) in world space using the
 * per-vertex biome weights baked by the chunk builder, at two tiling scales to
 * break up repetition, and perturbs the normal from the detail height fields.
 */
function injectGroundDetail(material: THREE.MeshStandardMaterial, details: GroundDetails, uniforms: SharedUniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGrassA = { value: details.grass.albedo };
    shader.uniforms.uGrassN = { value: details.grass.normal };
    shader.uniforms.uRockA = { value: details.rock.albedo };
    shader.uniforms.uRockN = { value: details.rock.normal };
    shader.uniforms.uSandA = { value: details.sand.albedo };
    shader.uniforms.uSandN = { value: details.sand.normal };
    shader.uniforms.uWetness = uniforms.wetness;
    shader.uniforms.uTime = uniforms.time;
    shader.uniforms.uFogFalloff = uniforms.fogFalloff;
    shader.uniforms.uFogBase = uniforms.fogBase;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec3 aDetail;      // (grass, sand, rock) weights
         varying vec3 vWPos;
         varying vec3 vDetail;
         varying float vFlat;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vDetail = aDetail;
         vFlat = clamp(normalize(normalMatrix * normal).y, 0.0, 1.0);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWPos;
         varying vec3 vDetail;
         varying float vFlat;
         uniform sampler2D uGrassA; uniform sampler2D uGrassN;
         uniform sampler2D uRockA;  uniform sampler2D uRockN;
         uniform sampler2D uSandA;  uniform sampler2D uSandN;
         uniform float uWetness;
         uniform float uTime;
         uniform float uFogFalloff;
         uniform float uFogBase;`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */`
        #include <map_fragment>
        // ---- multi-scale ground detail -------------------------------------
        vec2 wuv = vWPos.xz;
        vec3 w = vDetail / max(1e-3, vDetail.x + vDetail.y + vDetail.z);
        // Two scales, rotated 37 degrees apart, kill the obvious tiling period.
        mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
        vec2 uvA = wuv * 0.45;
        vec2 uvB = rot * wuv * 0.16;
        vec3 grassA = texture2D(uGrassA, uvA).rgb * texture2D(uGrassA, uvB).rgb * 5.2;
        vec3 rockA = texture2D(uRockA, uvA * 0.7).rgb * texture2D(uRockA, uvB * 0.8).rgb * 4.6;
        vec3 sandA = texture2D(uSandA, uvA * 1.3).rgb * texture2D(uSandA, uvB * 0.9).rgb * 4.0;
        vec3 detail = grassA * w.x + sandA * w.y + rockA * w.z;
        // Re-normalise to an average of 1.0 so the biome colour still sets the
        // hue, then clamp: without this the detail map sets the exposure and
        // grass turns fluorescent.
        detail /= max(0.001, dot(detail, vec3(0.33)));
        // Multiplying two samples tilts the hue, so pull the result back toward
        // its own luminance before it multiplies the biome colour.
        float dl = dot(detail, vec3(0.2126, 0.7152, 0.0722));
        detail = mix(vec3(dl), detail, 0.45);
        detail = clamp(detail, vec3(0.4), vec3(1.6));
        diffuseColor.rgb *= mix(vec3(1.0), detail, 0.95);
        // ---- macro variation --------------------------------------------------
        // Detail textures only carry 1-5 m scales; without a slower layer every
        // field reads as one flat wash. Two octaves of cheap value noise break
        // the ground into patches of growth, dry grass and shadowed hollows.
        {
          vec2 p = vWPos.xz;
          vec2 i1 = floor(p * 0.075);
          vec2 i2 = floor(p * 0.021);
          float n1 = fract(sin(dot(i1, vec2(127.1, 311.7))) * 43758.5453);
          float n2 = fract(sin(dot(i2, vec2(269.5, 183.3))) * 41337.1234);
          float patchA = mix(0.72, 1.18, n1);
          float patchB = mix(0.82, 1.14, n2);
          diffuseColor.rgb *= patchA * patchB;
          // Warm, straw-coloured dry patches on the larger octave.
          diffuseColor.rgb = mix(
            diffuseColor.rgb,
            diffuseColor.rgb * vec3(1.18, 1.06, 0.72),
            smoothstep(0.62, 0.98, n2) * 0.45
          );
        }
        // Flat, low ground collects water and turns dark and glossy.
        float damp = uWetness * mix(0.35, 1.0, vFlat);
        diffuseColor.rgb *= mix(1.0, 0.5, damp);
        `,
      )
      .replace(
        '#include <normal_fragment_begin>',
        /* glsl */`
        #include <normal_fragment_begin>
        // ---- detail normals -------------------------------------------------
        {
          mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
          vec2 uvA = vWPos.xz * 0.45;
          vec2 uvB = rot * vWPos.xz * 0.16;
          vec3 nG = (texture2D(uGrassN, uvA).xyz + texture2D(uGrassN, uvB).xyz - vec3(1.0));
          vec3 nR = (texture2D(uRockN, uvA * 0.7).xyz + texture2D(uRockN, uvB * 0.8).xyz - vec3(1.0));
          vec3 nS = (texture2D(uSandN, uvA * 1.3).xyz + texture2D(uSandN, uvB * 0.9).xyz - vec3(1.0));
          vec3 w = vDetail / max(1e-3, vDetail.x + vDetail.y + vDetail.z);
          vec3 dn = nG * w.x + nS * w.y + nR * w.z;
          // Tangent space X/Z -> world X/Z for a ground-facing surface.
          vec3 worldPerturb = vec3(dn.x, 0.0, dn.y);
          float strength = 0.6 * (1.0 - uWetness * 0.5);
          normal = normalize(normal + worldPerturb * strength);
        }
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = mix(roughnessFactor, 0.28, uWetness * vFlat);`,
      )
      .replace(
        '#include <fog_fragment>',
        /* glsl */`
        #ifdef USE_FOG
          float fogDist = length(vWPos - cameraPosition);
          float fogAlt = max(vWPos.y - uFogBase, 0.0);
          float localDensity = fogDensity * (0.35 + 0.65 * exp(-fogAlt * uFogFalloff));
          float fogFactor = 1.0 - exp(-pow(localDensity * fogDist * 1.35, 2.0));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(fogFactor, 0.0, 1.0));
        #endif
        `,
      );
  };
  material.customProgramCacheKey = () => 'hd-ground-detail-v1';
}

const S = (v: number) => v;

export function createMaterials(opts: MaterialOptions): MaterialSet {
  const aniso = Math.max(1, Math.min(16, opts.anisotropy));
  const asphaltMaps: SurfaceMaps = makeAsphaltMaps(aniso);
  const gravelMaps = makeGravelMaps(aniso);
  const dirtMaps = makeDirtMaps(aniso);
  const details = makeGroundDetails(aniso);
  const concreteMaps = makeConcreteMaps(aniso);
  const foliageMaps = makeFoliageMaps(aniso);
  const flake = makeFlakeNormal(4);

  const shared: SharedUniforms = {
    wetness: { value: 0 },
    time: { value: 0 },
    fogFalloff: { value: 0.014 },
    fogBase: { value: FOG_BASE },
  };

  // ---- terrain -------------------------------------------------------------
  const terrain = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.0,
    dithering: true,
    envMapIntensity: 0.35,
  });
  if (opts.groundDetail) injectGroundDetail(terrain, details, shared);
  else {
    injectCommon(terrain, shared, { fog: true, worldPos: true });
    injectWetness(terrain, shared, 0.93, 0.5);
  }

  // ---- roads ---------------------------------------------------------------
  const roadMat = (maps: SurfaceMaps, roughness: number, colour: number, envMapIntensity: number) => {
    const m = new THREE.MeshStandardMaterial({
      color: colour,
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      roughness,
      metalness: 0.02,
      envMapIntensity,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      dithering: true,
    });
    // Subtle: full-strength aggregate normals turn a road into cobblestones.
    m.normalScale.set(0.55, 0.55);
    injectCommon(m, shared, { fog: true, worldPos: true });
    injectWetness(m, shared, roughness, 0.58);
    return m;
  };

  const asphalt = roadMat(asphaltMaps, 1.0, 0xb4b4b6, 0.75);
  const gravel = roadMat(gravelMaps, 1.0, 0xc4beb2, 0.5);
  const dirt = roadMat(dirtMaps, 1.0, 0xb4a794, 0.4);

  const markings = new THREE.MeshStandardMaterial({
    color: 0xe6e2d2,
    roughness: 0.62,
    metalness: 0.0,
    envMapIntensity: 0.7,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  injectCommon(markings, shared, { fog: true, worldPos: true });
  injectWetness(markings, shared, 0.62, 0.35);

  const water = new THREE.MeshStandardMaterial({
    color: 0x061a26,
    roughness: 0.22,
    metalness: 0.08,
    transparent: true,
    opacity: 0.98,
    envMapIntensity: 0.55,
  });
  injectCommon(water, shared, { fog: true, worldPos: true });
  // Animated ripples. A flat plane with a mirror environment reads as ice; two
  // cross-scrolling wave trains break the reflection into glints and give the
  // sea a direction without needing a water simulation.
  {
    const previous = water.onBeforeCompile;
    water.onBeforeCompile = (shader, renderer) => {
      previous?.(shader, renderer);
      shader.uniforms.uTime = shared.time;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <normal_fragment_begin>',
          /* glsl */`
          #include <normal_fragment_begin>
          {
            vec2 p = vWPos.xz;
            float t = uTime * 1.35;
            vec2 g = vec2(
              cos(p.x * 0.21 + t) * 0.021 + cos(p.x * 0.073 - t * 0.6 + p.y * 0.05) * 0.03,
              cos(p.y * 0.19 - t * 0.85) * 0.021 + cos(p.y * 0.061 + t * 0.5 - p.x * 0.04) * 0.03
            );
            normal = normalize(normal + vec3(g.x, 0.0, g.y));
          }
          `,
        );
    };
    water.customProgramCacheKey = () => 'hd-water-v1';
  }

  // ---- props ---------------------------------------------------------------
  const foliage = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: foliageMaps.map,
    normalMap: foliageMaps.normalMap,
    roughnessMap: foliageMaps.roughnessMap,
    roughness: 0.86,
    metalness: 0.0,
    envMapIntensity: 0.6,
    // Leaves are thin: light them from behind as well so canopies are not black
    // silhouettes when the sun is behind them.
    side: THREE.DoubleSide,
  });
  injectCommon(foliage, shared, { fog: true, worldPos: true });
  injectWetness(foliage, shared, 0.86, 0.4);

  const rock = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.02,
    flatShading: false,
    envMapIntensity: 0.7,
  });
  injectCommon(rock, shared, { fog: true, worldPos: true });
  injectWetness(rock, shared, 0.88, 0.45);

  const building = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: concreteMaps.map,
    normalMap: concreteMaps.normalMap,
    roughnessMap: concreteMaps.roughnessMap,
    roughness: 0.82,
    metalness: 0.03,
    envMapIntensity: 0.8,
  });
  injectCommon(building, shared, { fog: true, worldPos: true });
  injectWetness(building, shared, 0.82, 0.4);

  return { terrain, asphalt, dirt, gravel, markings, water, foliage, rock, building, shared };
}

/**
 * Paint/glass/tyre materials for cars. Kept here so the whole project has one
 * place where surface response is tuned.
 */
export function createCarMaterials(appearance: { color: string; finish: 'gloss' | 'metallic' | 'matte' | 'chrome' | 'pearl' }, shared: SharedUniforms) {
  const flake = makeFlakeNormal(4);
  const isMatte = appearance.finish === 'matte';
  const isChrome = appearance.finish === 'chrome';
  const paint = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(appearance.color),
    metalness: isChrome ? 1 : appearance.finish === 'pearl' ? 0.42 : 0.62,
    roughness: isMatte ? 0.62 : isChrome ? 0.05 : appearance.finish === 'metallic' ? 0.24 : 0.17,
    clearcoat: isMatte ? 0.2 : 1.0,
    clearcoatRoughness: isMatte ? 0.45 : 0.035,
    normalMap: appearance.finish === 'metallic' ? flake : null,
    normalScale: new THREE.Vector2(0.12, 0.12),
    envMapIntensity: 0.85,
    sheen: appearance.finish === 'pearl' ? 0.5 : 0,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0xffd9f2),
  });
  if (paint.normalMap) paint.map = null;
  injectCommon(paint, shared, { fog: true, worldPos: true });
  injectWetness(paint, shared, 0.2, 0.25);

  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x070a0d,
    metalness: 0.0,
    roughness: 0.03,
    transparent: true,
    opacity: 0.62,
    transmission: 0.35,
    thickness: 0.02,
    ior: 1.52,
    envMapIntensity: 1.15,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
  });
  injectCommon(glass, shared, { fog: true, worldPos: true });

  const tyre = new THREE.MeshStandardMaterial({ color: 0x0d0e11, roughness: 0.94, metalness: 0.0, envMapIntensity: 0.35 });
  injectCommon(tyre, shared, { fog: true, worldPos: true });
  injectWetness(tyre, shared, 0.94, 0.3);

  const rim = new THREE.MeshStandardMaterial({ color: 0xb9bec7, metalness: 1.0, roughness: 0.24, envMapIntensity: 1.5 });
  injectCommon(rim, shared, { fog: true, worldPos: true });

  const trim = new THREE.MeshStandardMaterial({ color: 0x101216, roughness: 0.55, metalness: 0.25, envMapIntensity: 0.9 });
  injectCommon(trim, shared, { fog: true, worldPos: true });

  const chrome = new THREE.MeshStandardMaterial({ color: 0xdfe3ea, metalness: 1.0, roughness: 0.08, envMapIntensity: 1.6 });
  injectCommon(chrome, shared, { fog: true, worldPos: true });

  return { paint, glass, tyre, rim, trim, chrome };
}

export { S as clampScale };
