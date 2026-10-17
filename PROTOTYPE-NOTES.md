# Historical EEG observatory prototype

The repository root's Vite/Three.js files (`src/`, `tests/`, `index.html`, `mock-server.js`, root package files) predate the adaptive-horror handoff. They are retained as a source checkpoint, not the current product.

Run and extend **haunted-room/**. Its POST `/api/signal` → `/signals` contract uses Unix seconds. The old observatory's EEG channel/band-power contract uses a different payload and millisecond timestamps; do not connect them interchangeably.

The old build completed once and four client/protocol tests passed before later partial config edits. It has not been revalidated at this handoff. Its old ws dependency is below the version used and audited in the active application. Its optional `certs/` TLS config and local Vite proxy are unrelated to the current Node scene server. Do not use the root npm commands for the active demo.
