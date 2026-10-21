// Full desktop demo walkthrough in a continuously-rendering headless browser:
// begin -> low input builds to PEAK (encounters fire) -> high input RELIEF ->
// poor quality WAIT -> recovery -> session end -> summary panel.
// Complements the unit suites by proving the real UI wiring end to end.
import test from "node:test";
import assert from "node:assert/strict";
import {
  startServer,
  launchBrowser,
  createPage,
  appBootBlockers,
  skipIfBlocked,
} from "./harness.mjs";

const PORT = 8099;
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

const stat = (page, id) =>
  page.evaluate((i) => document.getElementById(i).textContent, id);
const setRange = (page, id, value) =>
  page.evaluate(
    ([i, v]) => {
      const el = document.getElementById(i);
      el.value = v;
      el.dispatchEvent(new Event("input"));
    },
    [id, value],
  );
async function waitForState(page, want, timeoutMs) {
  await page.waitForFunction(
    (w) => document.getElementById("stateStat").textContent.startsWith(w),
    want,
    { timeout: timeoutMs },
  );
}

test("demo flow: build, peak, encounters, relief, dropout, ending, summary", async (t) => {
  if (skipIfBlocked(t, blockers)) return;
  const { context, page, consoleErrors } = await createPage(browser);
  try {
    await page.goto(server.origin + "/", { waitUntil: "load" });
    await page.waitForTimeout(800);

    // 60 s session so the ending is reachable in test time.
    await page.selectOption("#duration", "60");
    await page.click("#start");
    assert.ok(
      await page.$eval("#overlay", (el) => el.classList.contains("hidden")),
      "overlay hides on begin",
    );

    // Low input: dwell then build to PEAK; encounters fire along the way.
    await page.click("#presetTense");
    assert.equal(await page.$eval("#intensity", (el) => el.value), "0.05");
    let sawEncounter = false;
    const encounterWatch = setInterval(async () => {
      try {
        if ((await stat(page, "encounterStat")) !== "–") sawEncounter = true;
      } catch {}
    }, 500);
    await waitForState(page, "PEAK", 40000);
    const peakTension = parseFloat(await stat(page, "tensionStat"));
    assert.ok(peakTension >= 0.6, `tension high at PEAK (got ${peakTension})`);

    // High input: smoothing + dwell then RELIEF, tension falls.
    await page.click("#presetCalm");
    await waitForState(page, "RELIEF", 30000);
    clearInterval(encounterWatch);
    assert.ok(sawEncounter, "at least one encounter fired during build/peak");
    await page.waitForTimeout(2500);
    const reliefTension = parseFloat(await stat(page, "tensionStat"));
    assert.ok(
      reliefTension < peakTension,
      `tension falls in RELIEF (${reliefTension} < ${peakTension})`,
    );

    // Poor quality -> WAIT, then recovery.
    await setRange(page, "quality", "0.2");
    await waitForState(page, "WAIT", 15000);
    await setRange(page, "quality", "1");
    await page.waitForFunction(
      () => document.getElementById("stateStat").textContent !== "WAIT",
      { timeout: 15000 },
    );

    // Run out the 60 s session; summary panel appears.
    await page.waitForFunction(
      () =>
        !document.getElementById("summaryPanel").classList.contains("hidden"),
      { timeout: 70000 },
    );
    const summary = await page.$eval(
      "#summaryContent",
      (el) => el.textContent,
    );
    assert.match(summary, /Peak tension/, "summary shows peak tension");
    await page.click("#dismissSummary");
    assert.ok(
      await page.$eval("#summaryPanel", (el) =>
        el.classList.contains("hidden"),
      ),
      "summary dismisses",
    );

    // Reset returns to ready.
    await page.click("#reset");
    assert.ok(
      !(await page.$eval("#overlay", (el) => el.classList.contains("hidden"))),
      "overlay returns on reset",
    );
    assert.deepEqual(consoleErrors, [], "zero console errors end to end");
  } finally {
    await context.close();
  }
});
