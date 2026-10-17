// Emulated-Quest portability contract: with Meta's IWER runtime installed as
// navigator.xr (metaQuest3 profile — closest published stand-in for Quest 3S),
// the app must offer VR, enter an immersive-vr session, render stereo frames,
// respond to head pose, and survive controller input.
import test from "node:test";
import assert from "node:assert/strict";
import {
  startServer,
  launchBrowser,
  createPage,
  samplePixels,
  signatureDiff,
  waitForXRFrames,
  hooks,
  appBootBlockers,
  skipIfBlocked,
} from "./harness.mjs";

const PORT = 8098;
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

/** Load the page with IWER installed and wait for the app to offer VR. */
async function loadWithXR() {
  const fixture = await createPage(browser, { emulateXR: true });
  const { page, failedRequests } = fixture;
  await page.goto(server.origin + "/", { waitUntil: "load" });
  await page.waitForTimeout(500);
  assert.deepEqual(failedRequests, [], "all app resources must load");
  await page.waitForSelector("#viewport canvas");
  const installed = await page.evaluate(() => window.__xrTest.iwerInstalled);
  assert.ok(installed, "IWER runtime must be installed over navigator.xr");
  await page.waitForFunction(
    () => (document.getElementById("VRButton")?.textContent || "").trim() === "ENTER VR",
  );
  return fixture;
}

/** Click ENTER VR and wait until the session is live and producing frames. */
async function enterVR(page) {
  await page.click("#VRButton");
  await page.waitForFunction(() => window.__xrTest.sessionActive);
  // SwiftShader can render at single-digit FPS; be patient, assert liveness.
  await waitForXRFrames(page, 5);
}

test("xr-entry: page offers ENTER VR and an immersive session starts rendering", async (t) => {
  if (skipIfBlocked(t, blockers)) return;
  const { context, page, consoleErrors } = await loadWithXR();
  try {
    await enterVR(page);
    const h = await hooks(page);
    assert.equal(h.sessions, 1, "exactly one XR session requested");
    assert.ok(h.sessionActive, "session is live");
    assert.ok(h.frameCount >= 5, `XR frame loop runs (got ${h.frameCount} frames)`);
    assert.equal(
      (await page.evaluate(() =>
        document.getElementById("VRButton").textContent.trim())),
      "EXIT VR",
      "VRButton reflects presenting state",
    );
    assert.deepEqual(consoleErrors, [], "no console errors during session entry");
    assert.deepEqual(h.errors, [], "no uncaught errors during session entry");
  } finally {
    await context.close();
  }
});

test("stereo: XR base layer is stereo-sized and both eye halves render content", async (t) => {
  if (skipIfBlocked(t, blockers)) return;
  const { context, page } = await loadWithXR();
  try {
    await enterVR(page);
    const h = await hooks(page);
    assert.ok(h.baseLayer, "renderState.baseLayer observed during XR frames");
    assert.ok(
      h.baseLayer.width >= h.baseLayer.height,
      `stereo framebuffer is wide (got ${h.baseLayer.width}x${h.baseLayer.height})`,
    );
    const stats = await samplePixels(page);
    assert.ok(stats, "canvas sampleable while presenting");
    for (const [eye, s] of [["left", stats.left], ["right", stats.right]]) {
      assert.ok(
        s.meanLuminance > 1 && s.distinctColors > 25,
        `${eye} eye renders content (lum ${s.meanLuminance.toFixed(2)}, ` +
          `${s.distinctColors} colors)`,
      );
    }
  } finally {
    await context.close();
  }
});

test("head-pose: rotating/moving the emulated headset changes the rendered view", async (t) => {
  if (skipIfBlocked(t, blockers)) return;
  const { context, page } = await loadWithXR();
  try {
    await enterVR(page);
    await waitForXRFrames(page, 5);
    const before = await samplePixels(page);

    // Drive the IWER device: yaw the head ~90° left and offset it.
    await page.evaluate(() => {
      const d = window.__xrDevice;
      const half = Math.PI / 4; // quaternion for 90° yaw about +Y
      d.quaternion.set(0, Math.sin(half), 0, Math.cos(half));
      d.position.set(0.4, 1.7, 0.3);
    });
    await waitForXRFrames(page, 10);
    const after = await samplePixels(page);

    const changed = signatureDiff(before.signature, after.signature);
    assert.ok(
      changed > 0.1,
      `view must change with head pose (changed fraction ${changed.toFixed(3)})`,
    );
    const h = await hooks(page);
    assert.deepEqual(h.errors, [], "no errors while updating head pose");
  } finally {
    await context.close();
  }
});

test("input: synthetic controller trigger squeeze produces select without errors", async (t) => {
  if (skipIfBlocked(t, blockers)) return;
  const { context, page, consoleErrors } = await loadWithXR();
  try {
    await enterVR(page);
    const controllers = await page.evaluate(() =>
      Object.keys(window.__xrDevice.controllers || {}),
    );
    assert.ok(controllers.length >= 1, `emulated controllers exist (${controllers})`);

    // Squeeze and release the trigger on the right controller. IWER maps the
    // trigger to the primary action, so this exercises the app's select /
    // selectstart / selectend paths and its per-frame inputSources polling.
    await page.evaluate(() => {
      const right = window.__xrDevice.controllers.right ||
        Object.values(window.__xrDevice.controllers)[0];
      right.updateButtonValue("trigger", 1);
    });
    await waitForXRFrames(page, 8);
    await page.evaluate(() => {
      const right = window.__xrDevice.controllers.right ||
        Object.values(window.__xrDevice.controllers)[0];
      right.updateButtonValue("trigger", 0);
    });
    await waitForXRFrames(page, 8);

    const h = await hooks(page);
    assert.ok(h.sessionActive, "session survives controller input");
    assert.deepEqual(h.errors, [], "no uncaught errors from controller input");
    assert.deepEqual(consoleErrors, [], "no console errors from controller input");
  } finally {
    await context.close();
  }
});

test("perf-signal: ~5s emulated-session FPS and draw stats (record-only)", async (t) => {
  if (skipIfBlocked(t, blockers)) return;
  const { context, page } = await loadWithXR();
  try {
    await enterVR(page);
    await page.evaluate(() => {
      window.__xrTest.frameStamps.length = 0;
    });
    await page.waitForTimeout(5000);
    const stamps = await page.evaluate(() => window.__xrTest.frameStamps.slice());
    // Liveness floor only: headless SwiftShader renders at single-digit FPS on
    // a loaded CI machine, which says nothing about Quest silicon. The number
    // is recorded for trend-watching, not gated.
    assert.ok(stamps.length >= 5, `XR frames keep flowing (got ${stamps.length} in 5s)`);
    const spanSec = (stamps[stamps.length - 1] - stamps[0]) / 1000;
    const fps = (stamps.length - 1) / spanSec;

    // renderer.info is only available if the app exposes its renderer.
    const info = await page.evaluate(() => {
      const r = window.__renderer;
      if (!r || !r.info) return null;
      return {
        drawCalls: r.info.render.calls,
        triangles: r.info.render.triangles,
        geometries: r.info.memory.geometries,
        textures: r.info.memory.textures,
      };
    });
    if (info) {
      console.log(
        `[perf] draw calls=${info.drawCalls} triangles=${info.triangles} ` +
          `geometries=${info.geometries} textures=${info.textures}`,
      );
      assert.ok(
        info.drawCalls <= 150,
        `draw calls ${info.drawCalls} within Quest budget (<=150)`,
      );
    } else {
      console.log(
        "[perf] window.__renderer not exposed by app — draw call budget not " +
          "checkable; recording FPS only",
      );
    }
    console.log(
      `[perf] emulated-session avg FPS over ${spanSec.toFixed(1)}s: ${fps.toFixed(1)} ` +
        "(headless SwiftShader — NOT representative of Quest silicon; " +
        "liveness signal only)",
    );
  } finally {
    await context.close();
  }
});
