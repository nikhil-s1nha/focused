# Focused

The active build is **[The Quiet Room](haunted-room/README.md)** — a two-minute adaptive horror WebXR experience for Meta Quest 3S.

```sh
cd haunted-room
npm ci
npm test
npm start
```

Open http://127.0.0.1:8080 on the scene laptop. Start in Manual demo; use `npm run mock` in another terminal and select Live stream to test the sensor relay. See the project README for the partner input contract, Quest USB/trusted-HTTPS setup, and device acceptance checklist.

Built from the October 17 adaptive-horror handoff requirements. The referenced starter ZIP was not supplied; this is a Three.js implementation. No real hardware or physical Quest operation is claimed by the automated tests.
