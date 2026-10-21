# Focused

The active build is **[The Quiet Room](haunted-room/README.md)** — a two-minute adaptive horror WebXR experience for Meta Quest 3S.

The current game is at `/simple.html`. The graph monitor is at `/roboflow.html`:
it can send selected graph frames to a Roboflow model or Workflow and pass matching
events to the game's scare director. There is also a separate local graph detector
for trying the flow without an API key. [Setup](haunted-room/ROBOFLOW-SETUP.txt).

```sh
cd haunted-room
npm ci
npm test
npm start
```

Open http://127.0.0.1:8080 on the scene laptop. Start in Manual demo; use `npm run mock` in another terminal and select Live stream to test the sensor relay. See the project README for the partner input contract, Quest USB/trusted-HTTPS setup, and device acceptance checklist.

Built from the October 17 adaptive-horror handoff requirements. The referenced starter ZIP was not supplied; this is a Three.js implementation. No real hardware or physical Quest operation is claimed by the automated tests.

For continuation, read **[CLAUDE.md](CLAUDE.md)** first. It records the exact checkpoint, tests, known limitations, and the requested expansion backlog. The root EEG observatory files are historical; see [PROTOTYPE-NOTES.md](PROTOTYPE-NOTES.md).
