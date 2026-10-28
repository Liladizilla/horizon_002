import { init } from '@dimforge/rapier3d-compat';

let ready: Promise<void> | null = null;
/** Rapier's WASM must be initialised once before any world is created. */
export function initRapier(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}
