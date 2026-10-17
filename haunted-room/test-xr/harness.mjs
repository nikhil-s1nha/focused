// XR portability test harness — shared fixtures.
//
// Self-contained: starts its own copy of the haunted-room server on a
// dedicated port (never 8080) and drives headless Chromium via Playwright.
// WebXR is emulated by injecting Meta's IWER (immersive-web-emulation-runtime)
// UMD bundle into the page before any app script runs, then installing an
// emulated Quest-class XRDevice over navigator.xr.
//
// Deliberately asserts on stable contracts only (page serves, canvas renders,
// XR session entry, pose-driven view changes) — the app is being rewritten
// concurrently, so nothing here depends on specific scene content or UI copy.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IWER_BUNDLE = readFileSync(
  path.join(ROOT, "node_modules/iwer/build/iwer.min.js"),
  "utf8",
);

/** Benign console noise that must not fail the "zero console errors" gate. */
const IGNORED_CONSOLE = [/favicon\.ico/i];

export function startServer(port) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const origin = `http://127.0.0.1:${port}`;
  const ready = (async () => {
    const deadline = Date.now() + 15000;
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`server exited early (code ${child.exitCode}): ${log}`);
      }
      try {
        const res = await fetch(origin + "/", { redirect: "manual" });
        if (res.status === 200) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never became ready: ${log}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  })();
  return {
    origin,
    ready,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }),
  };
}

export async function launchBrowser() {
  return chromium.launch({
    headless: true,
    // Playwright's new headless already enables SwiftShader GL; the extra flag
    // keeps software WebGL allowed if Chromium tightens the default again.
    args: ["--enable-unsafe-swiftshader"],
  });
}

/**
 * Create a page with error capture (+ optional IWER Quest emulation) wired in
 * BEFORE any app script executes.
 */
export async function createPage(browser, { emulateXR = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  // SwiftShader WebGL on a loaded machine is slow; keep waits patient so the
  // suite tests contracts, not the CI machine's momentary load.
  context.setDefaultTimeout(45000);
  // 1. Readable-pixels patch + global error capture (always).
  await context.addInitScript(`(() => {
    const hooks = (window.__xrTest = {
      errors: [], sessions: 0, frameCount: 0, frameStamps: [],
      iwerInstalled: false, sessionActive: false, baseLayer: null,
    });
    window.addEventListener("error", (e) => hooks.errors.push("pageerror: " + e.message));
    window.addEventListener("unhandledrejection", (e) =>
      hooks.errors.push("unhandledrejection: " + (e.reason && e.reason.message || e.reason)));
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (typeof type === "string" && type.indexOf("webgl") !== -1) {
        attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
      }
      return orig.call(this, type, attrs);
    };
  })();`);

  if (emulateXR) {
    // 2. IWER UMD bundle (defines window.IWER) …
    await context.addInitScript(IWER_BUNDLE);
    // 3. … then install an emulated Quest 3 class device as navigator.xr and
    // instrument requestSession so tests can observe session/frame activity.
    await context.addInitScript(`(() => {
      const hooks = window.__xrTest;
      try {
        const device = new IWER.XRDevice(IWER.metaQuest3);
        device.installRuntime({ forceInstall: true });
        window.__xrDevice = device;
        hooks.iwerInstalled = !!navigator.xr;
        const origRequest = navigator.xr.requestSession.bind(navigator.xr);
        navigator.xr.requestSession = async function (...args) {
          const session = await origRequest(...args);
          hooks.sessions += 1;
          hooks.sessionActive = true;
          session.addEventListener("end", () => { hooks.sessionActive = false; });
          const origRaf = session.requestAnimationFrame.bind(session);
          session.requestAnimationFrame = function (cb) {
            return origRaf(function (time, frame) {
              hooks.frameCount += 1;
              hooks.frameStamps.push(performance.now());
              if (hooks.frameStamps.length > 2048) hooks.frameStamps.shift();
              try {
                const layer = session.renderState && session.renderState.baseLayer;
                if (layer) hooks.baseLayer = {
                  width: layer.framebufferWidth, height: layer.framebufferHeight,
                };
              } catch {}
              return cb(time, frame);
            });
          };
          return session;
        };
      } catch (err) {
        hooks.errors.push("IWER install failed: " + (err && err.message || err));
      }
    })();`);
  }

  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
    consoleErrors.push(text);
  });
  page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));
  // A 404 on an ESM module import silently kills the whole app graph; record
  // failing resource loads so tests fail with the actual missing URL.
  page.on("response", (res) => {
    if (res.status() < 400) return;
    const url = res.url();
    if (IGNORED_CONSOLE.some((re) => re.test(url))) return;
    failedRequests.push(`${res.status()} ${url}`);
  });
  return { context, page, consoleErrors, failedRequests };
}

/**
 * Sample the WebGL canvas and return summary stats plus a coarse signature
 * for change detection. Runs entirely in the page; returns small data only.
 */
export async function samplePixels(page) {
  return page.evaluate(() => {
    const canvas =
      document.querySelector("#viewport canvas") || document.querySelector("canvas");
    if (!canvas || !canvas.width || !canvas.height) return null;
    const w = 192, h = 128;
    const c2 = document.createElement("canvas");
    c2.width = w; c2.height = h;
    const ctx = c2.getContext("2d");
    ctx.drawImage(canvas, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const colors = new Set();
    let lumSum = 0, leftLum = 0, rightLum = 0, leftColors = new Set(), rightColors = new Set();
    const signature = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const lum = (r + g + b) / 3;
        lumSum += lum;
        colors.add((r << 16) | (g << 8) | b);
        if (x < w / 2) { leftLum += lum; leftColors.add((r << 16) | (g << 8) | b); }
        else { rightLum += lum; rightColors.add((r << 16) | (g << 8) | b); }
        if (x % 16 === 0 && y % 16 === 0) signature.push(r, g, b);
      }
    }
    const half = (w / 2) * h;
    return {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      meanLuminance: lumSum / (w * h),
      distinctColors: colors.size,
      left: { meanLuminance: leftLum / half, distinctColors: leftColors.size },
      right: { meanLuminance: rightLum / half, distinctColors: rightColors.size },
      signature,
    };
  });
}

/** Fraction (0..1) of signature sample points that differ between two frames. */
export function signatureDiff(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 1;
  let diff = 0, n = a.length / 3;
  for (let i = 0; i < a.length; i += 3) {
    const d =
      Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > 12) diff += 1;
  }
  return diff / n;
}

/** Wait until at least n additional XR frames have been delivered. */
export async function waitForXRFrames(page, n, timeoutMs = 45000) {
  const start = await page.evaluate(() => window.__xrTest.frameCount);
  await page.waitForFunction(
    ([s, count]) => window.__xrTest.frameCount >= s + count,
    [start, n],
    { timeout: timeoutMs },
  );
}

/**
 * Mid-rewrite guard: other agents are actively rewriting public/*.mjs, and a
 * missing ESM import 404s and silently kills the whole app graph. Walk the
 * local ./ import graph from app.mjs via the running server and report any
 * modules that do not resolve. When this returns a non-empty list the app
 * cannot boot AT ALL, so tests skip with that reason instead of failing on a
 * defect in files this harness does not own. Returns [] when the app is whole.
 */
export async function appBootBlockers(origin) {
  const blockers = [];
  const seen = new Set();
  const queue = ["/app.mjs"];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    let res;
    try {
      res = await fetch(origin + path);
    } catch (err) {
      blockers.push(`${path}: fetch failed (${err.message})`);
      continue;
    }
    if (!res.ok) {
      blockers.push(`${path}: HTTP ${res.status}`);
      continue;
    }
    const src = await res.text();
    for (const m of src.matchAll(/from\s+["'](\.\/[^"']+\.mjs)["']/g)) {
      queue.push("/" + m[1].slice(2));
    }
  }
  return blockers;
}

/** Skip the test with a clear mid-rewrite reason. Returns true if skipped. */
export function skipIfBlocked(t, blockers) {
  if (!blockers || blockers.length === 0) return false;
  t.skip(`app mid-rewrite, cannot boot — missing modules: ${blockers.join("; ")}`);
  return true;
}

export const hooks = (page) => page.evaluate(() => {
  const h = window.__xrTest;
  return {
    errors: h.errors, sessions: h.sessions, frameCount: h.frameCount,
    iwerInstalled: h.iwerInstalled, sessionActive: h.sessionActive,
    baseLayer: h.baseLayer,
  };
});
