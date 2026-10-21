// TV view: a second page with ?spectate=1 must mirror the headset page's head
// pose and replay its scares, with no errors on either page.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, launchBrowser, createPage } from "./harness.mjs";

const PORT = 8095;
const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "notes", "screens");
let server, browser;

test.before(async () => {
  server = startServer(PORT);
  browser = await launchBrowser();
  await server.ready;
});
test.after(async () => {
  await browser?.close();
  await server?.stop();
});

test("spectator page mirrors head pose and replays door scares from the player page", async () => {
  const tv = await createPage(browser);
  const player = await createPage(browser);
  try {
    await tv.page.goto(server.origin + "/simple.html?spectate=1", { waitUntil: "load" });
    await tv.page.waitForSelector("#viewport canvas");
    await player.page.goto(server.origin + "/simple.html?test=1", { waitUntil: "load" });
    await player.page.waitForSelector("#viewport canvas");
    await player.page.waitForTimeout(1200);

    // Turn the player's head to the left (yaw +90 degrees) by dragging the view.
    await player.page.click("#start");
    await player.page.mouse.move(640, 400);
    await player.page.mouse.down();
    await player.page.mouse.move(640 + 520, 400, { steps: 10 });
    await player.page.mouse.up();
    await player.page.waitForTimeout(500);
    // The TV camera follows: its yaw is no longer facing the front door.
    const yawOf = (p) =>
      p.evaluate(() => {
        const e = window.__simple.cameraEuler();
        return e.y;
      });
    const playerYaw = await yawOf(player.page);
    const tvYaw = await yawOf(tv.page);
    assert.ok(Math.abs(playerYaw) > 0.5, `player turned (${playerYaw})`);
    assert.ok(Math.abs(tvYaw - playerYaw) < 0.1, `tv follows (${tvYaw} vs ${playerYaw})`);

    // A scare on the player's page opens the same door on the TV.
    await player.page.click('[data-scare="back"]');
    await tv.page.waitForFunction(() => window.__simple.room.getDoor("back") > 0.5, null, { timeout: 5000 });
    mkdirSync(SHOTS, { recursive: true });
    await tv.page.screenshot({ path: path.join(SHOTS, "spectator-tv.png") });

    assert.deepEqual(tv.consoleErrors, [], "tv console must be clean");
    assert.deepEqual(player.consoleErrors, [], "player console must be clean");
  } finally {
    await tv.context.close();
    await player.context.close();
  }
});
