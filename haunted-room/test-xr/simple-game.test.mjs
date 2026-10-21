// The simple game: four doors, scares through them. The page must load clean,
// Begin must run it, and a triggered scare must play through without errors.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, launchBrowser, createPage } from "./harness.mjs";

const PORT = 8099;
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

test("simple game: loads, begins, and plays a triggered scare without errors", async () => {
  const { context, page, consoleErrors } = await createPage(browser);
  try {
    await page.goto(server.origin + "/simple.html?test=1", { waitUntil: "load" });
    await page.waitForSelector("#viewport canvas");
    await page.waitForTimeout(1500);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, "simple-ready.png") });

    await page.click("#start");
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => window.__simple.state().phase), "running");

    await page.click('[data-scare="front"]');
    await page.waitForTimeout(1500); // silence -> lights -> door -> figure
    await page.screenshot({ path: path.join(SHOTS, "simple-figure.png") });
    await page.waitForTimeout(1200); // lunge
    await page.screenshot({ path: path.join(SHOTS, "simple-lunge.png") });

    // Calibration: the first scripted scare arrives on its own, about 8 s in.
    await page.waitForTimeout(12000);
    const after = await page.evaluate(() => ({
      scares: window.__simple.scares.snapshot().scaresSoFar,
      phase: window.__simple.profile.export().phase,
    }));
    assert.ok(after.scares >= 1, `a calibration scare should have played (saw ${after.scares})`);
    assert.ok(["calibrating", "adapting"].includes(after.phase), `profile phase ${after.phase}`);

    assert.deepEqual(consoleErrors, [], "console must be free of errors");
  } finally {
    await context.close();
  }
});
