// One combined mode: the page opens straight into Night Shift (FNAF 1 style),
// the mode picker is gone, and Begin runs the night with the Director live.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  startServer,
  launchBrowser,
  createPage,
  appBootBlockers,
  skipIfBlocked,
} from "./harness.mjs";

const PORT = 8098;
const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "notes", "screens");
let server, browser, blockers;

test.before(async () => {
  server = startServer(PORT);
  browser = await launchBrowser();
  await server.ready;
  blockers = await appBootBlockers(server.origin);
});

test.after(async () => {
  await browser?.close();
  await server?.stop();
});

test("combined: opens into Night Shift, no mode picker, Begin runs the night", async (t) => {
  if (skipIfBlocked(t, blockers)) return;
  const { context, page, consoleErrors } = await createPage(browser);
  try {
    await page.goto(server.origin + "/", { waitUntil: "load" });
    await page.waitForSelector("#viewport canvas");
    await page.waitForTimeout(1500);

    assert.ok(await page.evaluate(() => document.body.classList.contains("fnaf")), "night must be active on load");
    assert.ok(await page.evaluate(() => document.getElementById("modeToggle").classList.contains("hidden")), "mode picker hidden");
    assert.match(await page.textContent("#modeLabel"), /Night Shift|FNAF/i);

    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, "combined-ready.png") });

    await page.click("#start");
    await page.waitForTimeout(4000);
    const running = await page.evaluate(() => document.getElementById("sessionState").textContent);
    assert.match(running, /Night 1/, "Begin must start the night");
    await page.screenshot({ path: path.join(SHOTS, "combined-begun.png") });

    assert.deepEqual(consoleErrors, [], "console must be free of errors");
  } finally {
    await context.close();
  }
});
