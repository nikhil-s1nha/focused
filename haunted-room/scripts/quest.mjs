#!/usr/bin/env node
// One-command Quest bring-up: `npm run quest [-- --record] [-- --port 8080]`.
// Ensures adb exists, starts the scene server if needed, waits for an
// authorized headset, forwards the port, opens Quest Browser on the page and
// re-applies the forward whenever the headset reconnects.
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUEST_BROWSER = "com.oculus.browser";

export function parseDevices(output) {
  return String(output)
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[0])
    .map(([serial, state]) => ({ serial, state }));
}

export function classify(devices) {
  const ready = devices.filter((d) => d.state === "device");
  if (ready.length) return { status: "ready", serial: ready[0].serial };
  if (devices.some((d) => d.state === "unauthorized"))
    return { status: "unauthorized" };
  if (devices.some((d) => d.state === "offline")) return { status: "offline" };
  return { status: "none" };
}

export const MESSAGES = {
  none: "No headset found. Plug in the USB-C cable and wake the Quest (put it on).",
  unauthorized:
    "Headset found but not authorized. Put the headset ON and accept the 'Allow USB debugging' prompt (tick 'Always allow').",
  offline: "Headset is offline. Unplug/replug USB, or run: adb kill-server",
};

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, a, o = {}) =>
  spawnSync(cmd, a, { encoding: "utf8", ...o });

function ensureAdb() {
  if (run("adb", ["version"]).status === 0) return true;
  console.log("adb not found.");
  if (process.platform === "darwin" && run("which", ["brew"]).status === 0) {
    console.log("Installing android-platform-tools with Homebrew...");
    const r = run("brew", ["install", "android-platform-tools"], {
      stdio: "inherit",
    });
    if (r.status === 0 && run("adb", ["version"]).status === 0) return true;
  }
  console.log(
    "Install Android platform-tools (macOS: brew install android-platform-tools) and re-run.",
  );
  return false;
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/healthz", timeout: 800 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureServer(port) {
  if (await ping(port)) {
    console.log(`Scene server already running on :${port}`);
    return null;
  }
  console.log(`Starting scene server on :${port} ...`);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: "inherit",
  });
  for (let i = 0; i < 40; i++) {
    if (await ping(port)) return child;
    await sleep(250);
  }
  throw new Error("Scene server did not come up");
}

function adbState() {
  return classify(parseDevices(run("adb", ["devices"]).stdout || ""));
}

function bringUp(serial, port) {
  const s = ["-s", serial];
  const rev = run("adb", [...s, "reverse", `tcp:${port}`, `tcp:${port}`]);
  if (rev.status !== 0) {
    console.log("adb reverse failed:", rev.stderr || rev.stdout);
    return false;
  }
  const url = `http://localhost:${port}/simple.html?quest=1`;
  run("adb", [
    ...s, "shell", "am", "start",
    "-a", "android.intent.action.VIEW", "-d", url, "-p", QUEST_BROWSER,
  ]);
  console.log(`Forwarded and opened ${url} in Quest Browser.`);
  return true;
}

function startRecording(serial) {
  if (run("which", ["scrcpy"]).status !== 0) {
    console.log(
      "--record needs scrcpy (macOS: brew install scrcpy). Skipping recording; " +
        "you can also use the Meta Quest phone app's Cast/record.",
    );
    return null;
  }
  const file = path.join(root, `quest-session-${Date.now()}.mp4`);
  console.log(`Recording headset view to ${file} (Ctrl+C to stop)`);
  return spawn("scrcpy", ["-s", serial, "--no-audio", "--record", file], {
    stdio: "inherit",
  });
}

async function main() {
  if (!ensureAdb()) process.exit(1);
  const port = Number(opt("port", process.env.PORT || 8080));
  const server = await ensureServer(port);
  let lastSerial = null,
    warned = "",
    recorder = null;

  const shutdown = () => {
    if (lastSerial)
      run("adb", ["-s", lastSerial, "reverse", "--remove", `tcp:${port}`]);
    recorder?.kill();
    server?.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("Waiting for Quest over USB... (Ctrl+C to quit)");
  for (;;) {
    const st = adbState();
    if (st.status === "ready") {
      if (st.serial !== lastSerial) {
        warned = "";
        if (bringUp(st.serial, port)) {
          lastSerial = st.serial;
          if (flag("record") && !recorder) recorder = startRecording(st.serial);
        }
      }
    } else {
      if (lastSerial) console.log("Headset disconnected; waiting to reconnect.");
      lastSerial = null;
      if (warned !== st.status) {
        console.log(MESSAGES[st.status]);
        warned = st.status;
      }
    }
    await sleep(2000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
