import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { sanitizeSignal } from "./relay.mjs";
import { sanitizeSpectate } from "./spectate.mjs";
import { createSignalLink } from "./signal-link/receiver.mjs";
const root = path.dirname(fileURLToPath(import.meta.url));
export function createSceneServer({
  tls = null,
  publishToken = process.env.PUBLISH_TOKEN,
  signalToken = process.env.SIGNAL_TOKEN,
} = {}) {
  const signalLink = createSignalLink({ signalToken });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  // Spectator relay: the headset page publishes pose/events/phase; TV pages replay them.
  const spectators = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  let lastPhase = null,
    lastPose = null;
  const handler = (req, res) => {
    const pathname = new URL(req.url, "http://local").pathname;
    if (signalLink.handle(req, res, pathname)) return;
    if (pathname === "/api/signal") {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" }).end();
        return;
      }
      if (
        publishToken &&
        req.headers.authorization !== `Bearer ${publishToken}`
      ) {
        res.writeHead(401).end();
        return;
      }
      let bytes = 0,
        parts = [];
      req.on("data", (p) => {
        bytes += p.length;
        if (bytes <= 8192) parts.push(p);
      });
      req.on("end", () => {
        if (bytes > 8192) {
          res.writeHead(413).end();
          return;
        }
        let frame;
        try {
          frame = sanitizeSignal(JSON.parse(Buffer.concat(parts).toString()));
        } catch {}
        if (!frame) {
          res.writeHead(400).end("Invalid signal");
          return;
        }
        const text = JSON.stringify(frame);
        for (const ws of sockets.clients)
          if (ws.readyState === 1 && ws.bufferedAmount < 32768) ws.send(text);
        res.writeHead(204, { "Cache-Control": "no-store" }).end();
      });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    if (pathname === "/healthz") {
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        })
        .end(JSON.stringify({ ok: true, viewers: sockets.clients.size }));
      return;
    }
    let file;
    if (pathname === "/vendor/three.module.js")
      file = path.join(root, "node_modules/three/build/three.module.js");
    else if (pathname === "/vendor/three.core.js")
      file = path.join(root, "node_modules/three/build/three.core.js");
    else if (pathname.startsWith("/vendor/addons/"))
      file = path.join(
        root,
        "node_modules/three/examples/jsm",
        pathname.slice("/vendor/addons/".length),
      );
    else
      file = path.join(
        root,
        "public",
        pathname === "/" ? "index.html" : pathname,
      );
    const allowed = [
      path.join(root, "public") + path.sep,
      path.join(root, "node_modules/three") + path.sep,
    ];
    if (!allowed.some((prefix) => file.startsWith(prefix))) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end("Not found");
        return;
      }
      const ext = path.extname(file);
      res.writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript",
            ".mjs": "text/javascript",
            ".css": "text/css",
          }[ext] || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Permissions-Policy": "xr-spatial-tracking=(self)",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    });
  };
  const server = tls
    ? https.createServer(tls, handler)
    : http.createServer(handler);
  server.on("upgrade", (req, socket, head) => {
    const upgradePath = new URL(req.url, "http://local").pathname;
    if (upgradePath === "/spectate") {
      spectators.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", () => {});
        // Late joiners (a TV page opened mid-session) catch up immediately.
        if (lastPhase) ws.send(lastPhase);
        if (lastPose) ws.send(lastPose);
        ws.on("message", (raw) => {
          let frame;
          try {
            frame = sanitizeSpectate(JSON.parse(raw.toString()));
          } catch {}
          if (!frame) return;
          const text = JSON.stringify(frame);
          if (frame.type === "phase") lastPhase = text;
          else if (frame.type === "pose") lastPose = text;
          for (const peer of spectators.clients)
            if (peer !== ws && peer.readyState === 1 && peer.bufferedAmount < 32768)
              peer.send(text);
        });
      });
      return;
    }
    if (upgradePath !== "/signals") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => {});
      sockets.emit("connection", ws, req);
    });
  });
  server.on("close", () => signalLink.close());
  return { server, sockets, spectators, signalLink };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const tls =
    process.env.TLS_CERT && process.env.TLS_KEY
      ? {
          cert: fs.readFileSync(process.env.TLS_CERT),
          key: fs.readFileSync(process.env.TLS_KEY),
        }
      : null;
  const { server } = createSceneServer({ tls });
  const host = process.env.HOST || "127.0.0.1",
    port = Number(process.env.PORT || 8080);
  server.listen(port, host, () =>
    console.log(
      `Focused room: ${tls ? "https" : "http"}://${host}:${port} | publisher: POST /api/signal | viewer: /signals`,
    ),
  );
}
