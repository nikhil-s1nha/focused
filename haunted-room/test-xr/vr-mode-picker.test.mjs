// VR mode picker: an emulated Quest controller aims at the FNAF 1 panel,
// squeezes the trigger, and the session must start in FNAF 1 with no errors.
import test from "node:test";
import assert from "node:assert/strict";
import {
  startServer,
  launchBrowser,
  createPage,
  appBootBlockers,
  skipIfBlocked,
  waitForXRFrames,
  hooks,
} from "./harness.mjs";

const PORT = 8097;
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

test("vr: controller selects the FNAF 1 mode panel and the session starts in it", async (t) => {
  if (skipIfBlocked(t, blockers)) return;
  const { context, page, consoleErrors } = await createPage(browser, { emulateXR: true });
  try {
    await page.goto(server.origin + "/", { waitUntil: "load" });
    await page.waitForTimeout(800);
    await page.click("#VRButton").catch(() => {});
    await page.waitForFunction(() => window.__xrTest.sessionActive, null, { timeout: 45000 });
    await waitForXRFrames(page, 4);

    // Aim the right controller at the FNAF 1 panel (world x -0.48, y 0.98, z -1.25).
    // The rig sits at z=2, so the controller's local-floor position is offset.
    await page.evaluate(() => {
      const c = window.__xrDevice.controllers.right || Object.values(window.__xrDevice.controllers)[0];
      c.position.set(-0.48, 0.98, -2.25);
      c.quaternion.set(0, 0, 0, 1);
    });
    await waitForXRFrames(page, 4);
    await page.evaluate(() => {
      const c = window.__xrDevice.controllers.right || Object.values(window.__xrDevice.controllers)[0];
      c.updateButtonValue("trigger", 1);
    });
    await waitForXRFrames(page, 6);
    await page.evaluate(() => {
      const c = window.__xrDevice.controllers.right || Object.values(window.__xrDevice.controllers)[0];
      c.updateButtonValue("trigger", 0);
    });
    await waitForXRFrames(page, 6);

    const mode = await page.evaluate(() => window.__fnaf?.session?.mode ?? null);
    assert.equal(mode, "fnaf1", "FNAF 1 started from the VR panel");
    const h = await hooks(page);
    assert.deepEqual(h.errors, [], "no uncaught errors");
    assert.deepEqual(consoleErrors, [], "no console errors");
  } finally {
    await context.close();
  }
});
