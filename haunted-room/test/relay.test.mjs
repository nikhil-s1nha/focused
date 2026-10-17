import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createSceneServer } from "../server.mjs";
const sample = {
  type: "signal",
  source: "synthetic",
  intensity: 0.42,
  signal_quality: 0.9,
  timestamp: Date.now() / 1000,
  raw: [999],
  private: "omit",
};
test("HTTP relay validates, limits payloads and strips extra fields before WebSocket broadcast", async () => {
  const { server, sockets } = createSceneServer({ publishToken: "test-only" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ws = new WebSocket(base.replace("http:", "ws:") + "/signals");
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  try {
    const post = (body, token = "test-only") =>
      fetch(base + "/api/signal", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const received = new Promise((r, j) => {
      const timeout = setTimeout(() => j(Error("No relay frame")), 2000);
      ws.once("message", (raw) => {
        clearTimeout(timeout);
        r(JSON.parse(raw));
      });
    });
    assert.equal((await post(sample)).status, 204);
    const frame = await received;
    assert.deepEqual(Object.keys(frame).sort(), [
      "intensity",
      "signal_quality",
      "source",
      "timestamp",
      "type",
    ]);
    assert.equal(frame.source, "synthetic");
    assert.equal((await post({ ...sample, intensity: 3 })).status, 400);
    assert.equal((await post(sample, "wrong")).status, 401);
    assert.equal(
      (await post({ ...sample, raw: "a".repeat(9000) })).status,
      413,
    );
    for (const url of [
      "/",
      "/app.mjs",
      "/vendor/three.module.js",
      "/vendor/three.core.js",
      "/vendor/addons/webxr/VRButton.js",
    ])
      assert.equal((await fetch(base + url)).status, 200, url);
    assert.equal((await fetch(base + "/server.mjs")).status, 404);
  } finally {
    ws.terminate();
    for (const client of sockets.clients) client.terminate();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    sockets.close();
  }
});
