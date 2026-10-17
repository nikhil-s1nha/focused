const endpoint = process.env.SIGNAL_URL || "http://127.0.0.1:8080/api/signal";
const start = performance.now();
let busy = false;
console.log(
  `SYNTHETIC feed → ${endpoint}. Ctrl+C stops; viewer should enter WAIT after 3 seconds.`,
);
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const t = (performance.now() - start) / 1000;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.PUBLISH_TOKEN
          ? { Authorization: `Bearer ${process.env.PUBLISH_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        type: "signal",
        source: "synthetic",
        intensity: 0.5 + 0.48 * Math.sin(t * 0.18),
        signal_quality: 0.95,
        timestamp: Date.now() / 1000,
      }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) console.error("Relay rejected:", res.status);
  } catch (e) {
    console.error(e.message);
  } finally {
    busy = false;
  }
}, 100);
