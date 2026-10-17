import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createSceneServer } from "../server.mjs";
import { sanitizeSpectate } from "../spectate.mjs";

test("sanitizeSpectate keeps only known fields inside strict ranges", () => {
  assert.deepEqual(
    sanitizeSpectate({ type: "pose", p: [0, 1.6, 0], q: [0, 0, 0, 1], l: 0.4, raw: [1] }),
    { type: "pose", p: [0, 1.6, 0], q: [0, 0, 0, 1], l: 0.4 },
  );
  assert.equal(sanitizeSpectate({ type: "pose", p: [0, 1, NaN], q: [0, 0, 0, 1] }), null);
  assert.equal(sanitizeSpectate({ type: "pose", p: [999, 0, 0], q: [0, 0, 0, 1] }), null);
  assert.deepEqual(
    sanitizeSpectate({ type: "event", ev: { type: "lunge", side: "left", id: "doll", seconds: 0.22, eeg: [1, 2] } }),
    { type: "event", ev: { type: "lunge", side: "left", id: "doll", seconds: 0.22 } },
  );
  assert.equal(sanitizeSpectate({ type: "event", ev: { type: "Bad Type!" } }), null);
  assert.equal(sanitizeSpectate({ type: "event", ev: { type: "door", side: "up" } }).ev.side, undefined);
  assert.deepEqual(sanitizeSpectate({ type: "phase", phase: "end", reason: "caught" }), {
    type: "phase",
    phase: "end",
    reason: "caught",
  });
  assert.equal(sanitizeSpectate({ type: "phase", phase: "explode" }), null);
  assert.equal(sanitizeSpectate({ type: "other" }), null);
  assert.equal(sanitizeSpectate(null), null);
});

// Frames are buffered from the moment the socket is created: the server sends
// catch-up frames the instant a client connects, before a test could listen.
async function connect(base) {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/spectate");
  ws.inbox = [];
  ws.on("message", (raw) => ws.inbox.push(JSON.parse(raw)));
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  return ws;
}
async function next(ws) {
  for (let i = 0; i < 200; i++) {
    if (ws.inbox.length) return ws.inbox.shift();
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("no frame");
}

test("spectator relay forwards sanitized frames to other clients and catches up late joiners", async () => {
  const { server, spectators } = createSceneServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headset = await connect(base);
  const tv = await connect(base);
  try {
    const got = next(tv);
    headset.send(JSON.stringify({ type: "event", ev: { type: "door", side: "right", open: 1, secret: "x" } }));
    assert.deepEqual(await got, { type: "event", ev: { type: "door", side: "right", open: 1 } });

    // invalid frames are dropped, not forwarded
    headset.send("not json");
    headset.send(JSON.stringify({ type: "pose", p: [0, 0, "no"], q: [0, 0, 0, 1] }));
    const real = next(tv);
    headset.send(JSON.stringify({ type: "phase", phase: "begin" }));
    assert.deepEqual(await real, { type: "phase", phase: "begin" });

    // a TV page opened mid-session gets the last phase and pose immediately
    headset.send(JSON.stringify({ type: "pose", p: [0, 1.6, 0], q: [0, 0.7, 0, 0.7] }));
    await next(tv);
    const late = await connect(base);
    const first = await next(late);
    assert.equal(first.type, "phase");
    const second = await next(late);
    assert.equal(second.type, "pose");
    late.close();

    // the sender never receives its own frames
    headset.inbox.length = 0;
    headset.send(JSON.stringify({ type: "phase", phase: "reset" }));
    await next(tv);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(headset.inbox.length, 0);
    assert.ok(spectators.clients.size >= 2);
  } finally {
    headset.close();
    tv.close();
    await new Promise((r) => server.close(r));
  }
});
