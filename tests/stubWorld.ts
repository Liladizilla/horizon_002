import * as THREE from 'three';
import { buildRoadNetwork, type RoadField, RoadGraph } from '../src/world/roads';
import { baseHeight, SEA_LEVEL } from '../src/world/terrain';
import { lerp } from '../src/core/math';
import type { GameWorld } from '../src/world/world';
import type { SurfaceSample } from '../src/core/types';

/**
 * Headless stand-in for `GameWorld`.
 *
 * The real world class owns Three.js meshes, WebGL materials and chunk
 * streaming, none of which exist under Node. Route building, the AI and the
 * race logic only need the analytic terrain and the road field, so the tests
 * rebuild exactly those two pieces with the production code paths.
 */
export class StubWorld {
  readonly field: RoadField;
  readonly graph: RoadGraph;
  readonly seaLevel = SEA_LEVEL;
  wetness = 0;

  constructor() {
    this.field = buildRoadNetwork();
    this.graph = new RoadGraph(this.field);
  }

  heightAt(x: number, z: number): number {
    let h = baseHeight(x, z);
    const rc = this.field.heightContribution(x, z);
    if (rc.blend > 0.001) h = lerp(h, rc.y, rc.blend);
    return Math.max(h, -3.2);
  }

  driveY(x: number, z: number): number {
    const h = this.heightAt(x, z);
    const road = this.field.nearest(x, z);
    if (road.sample && road.dist < road.sample.width * 0.55) return Math.max(h, road.sample.y);
    return h;
  }

  surfaceSampler = (x: number, y: number, z: number, normalY: number): SurfaceSample => {
    const road = this.field.surfaceAt(x, z, y, normalY);
    if (road.onRoad > 0.45) return { id: road.surface, wetness: this.wetness };
    if (y < SEA_LEVEL + 0.6) return { id: 'water', wetness: 1 };
    if (normalY < 0.72) return { id: 'gravel', wetness: this.wetness };
    return { id: 'grass', wetness: this.wetness };
  };

  roadInfoAt(x: number, z: number) {
    const n = this.field.nearest(x, z);
    return { dist: n.dist, width: n.sample ? n.sample.width : 0, roadId: n.sample ? n.sample.roadId : null };
  }

  onRoad(x: number, z: number, tolerance = 0) {
    const info = this.roadInfoAt(x, z);
    return info.roadId !== null && info.dist < info.width * 0.5 + tolerance;
  }

  nearestRoad(x: number, z: number) { return this.field.nearest(x, z); }

  safeRespawn(x: number, z: number) {
    const road = this.field.nearest(x, z);
    if (road.sample) {
      const s = road.sample;
      return { x: s.x, y: this.driveY(s.x, s.z) + 0.5, z: s.z, yaw: Math.atan2(s.dx, s.dz) };
    }
    return { x, y: this.driveY(x, z) + 0.5, z, yaw: 0 };
  }

  /** Cast helper so the stub can be handed to functions typed against GameWorld. */
  asWorld(): GameWorld { return this as unknown as GameWorld; }
}

/** Minimal actor shape used by AIDriver: position + quaternion + readout. */
export function fakeActor(pos: THREE.Vector3, readout: Partial<{ speedMs: number; forwardSpeedMs: number }> = {}) {
  return {
    position: pos,
    curQuat: new THREE.Quaternion(),
    sim: { readout: { speedMs: 0, forwardSpeedMs: 0, ...readout } },
    controls: { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false },
  };
}
