// Flat (non-XR) portability contract: the page must load clean in a stock
// Chromium with software WebGL, mount a canvas, and actually draw the room.
import test from "node:test";
import assert from "node:assert/strict";
import {
  startServer,
  launchBrowser,
  createPage,
  samplePixels,
} from "./harness.mjs";

const PORT = 8097;
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

test("smoke: page loads with zero console/page errors and a #viewport canvas", async () => {
  const { context, page, consoleErrors } = await createPage(browser);
  try {
    const res = await page.goto(server.origin + "/", { waitUntil: "load" });
    assert.equal(res.status(), 200, "index must serve with HTTP 200");

    // The app module appends the renderer canvas to #viewport.
    await page.waitForSelector("#viewport canvas");

    // VRButton (or its graceful fallback) must be mounted. Three's VRButton
    // always sets id="VRButton" on the element it creates.
    await page.waitForSelector("#VRButton");

    // Give async module init / WebSocket connect a moment to surface errors.
    await page.waitForTimeout(1500);
    const pageHookErrors = await page.evaluate(() => window.__xrTest.errors);
    assert.deepEqual(consoleErrors, [], "console must be free of errors");
    assert.deepEqual(pageHookErrors, [], "no uncaught errors/rejections");
  } finally {
    await context.close();
  }
});

test("smoke: without XR emulation the VR button degrades gracefully", async () => {
  const { context, page } = await createPage(browser);
  try {
    await page.goto(server.origin + "/", { waitUntil: "load" });
    await page.waitForSelector("#VRButton");
    // Headless desktop Chromium has no immersive-vr: the button must settle on
    // a non-crashing informative state, never a dead "ENTER VR".
    await page.waitForFunction(() => {
      const t = (document.getElementById("VRButton")?.textContent || "").trim();
      return t.length > 0 && t !== "ENTER VR";
    });
    const label = await page.evaluate(() =>
      document.getElementById("VRButton").textContent.trim(),
    );
    assert.match(label, /VR/i, `fallback label mentions VR (got "${label}")`);
  } finally {
    await context.close();
  }
});

test("render: the WebGL canvas draws a non-black, non-uniform image", async () => {
  const { context, page, consoleErrors } = await createPage(browser);
  try {
    await page.goto(server.origin + "/", { waitUntil: "load" });
    await page.waitForSelector("#viewport canvas");
    await page.waitForTimeout(2500); // let a few frames render

    const stats = await samplePixels(page);
    assert.ok(stats, "canvas must be sampleable");
    assert.ok(stats.canvasWidth > 0 && stats.canvasHeight > 0, "canvas has size");
    // The room is deliberately dark; "renders" means meaningfully above pure
    // black and with real structural variation, not a flat clear color.
    assert.ok(
      stats.meanLuminance > 1,
      `mean luminance ${stats.meanLuminance.toFixed(2)} must exceed pure black`,
    );
    assert.ok(
      stats.distinctColors > 50,
      `expected varied image, got ${stats.distinctColors} distinct colors`,
    );
    assert.deepEqual(consoleErrors, [], "rendering must not produce console errors");
  } finally {
    await context.close();
  }
});
