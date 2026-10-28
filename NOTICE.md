# Third-party notices

Horizon Drive's own code, art, audio, vehicle names and event names are original.
It links the following open-source libraries at runtime:

| Library | Version | Licence | Use |
| --- | --- | --- | --- |
| [three](https://threejs.org/) | ^0.186.1 | MIT | WebGL2 renderer, sky shader, post-processing |
| [@dimforge/rapier3d-compat](https://rapier.rs/) | ^0.21.0 | Apache-2.0 | Rigid-body physics (WASM) |
| [ws](https://github.com/websockets/ws) | ^8.18.3 | MIT | Optional multiplayer server (dev/runtime) |
| [vite](https://vite.dev/) | ^7.2.2 | MIT | Dev server and bundler (dev) |
| [vitest](https://vitest.dev/) | ^3.2.4 | MIT | Headless test runner (dev) |
| [playwright](https://playwright.dev/) | ^1.64.1 | Apache-2.0 | Browser smoke tests (dev) |

All 3D models, textures (including the procedurally generated road, terrain and
particle textures), engine/tyre/wind synthesis, music loops, UI and the world map
are generated in code by this project. No assets, names, logos or map data are
taken from any commercial racing game.
