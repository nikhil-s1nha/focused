import test from "node:test";
import assert from "node:assert/strict";
import { parseDevices, classify } from "../scripts/quest.mjs";

const out = (rows) => `List of devices attached\n${rows.join("\n")}\n\n`;

test("parseDevices reads serial/state pairs and ignores the header", () => {
  const d = parseDevices(out(["2G0YC1\tdevice", "abc\tunauthorized"]));
  assert.deepEqual(d, [
    { serial: "2G0YC1", state: "device" },
    { serial: "abc", state: "unauthorized" },
  ]);
  assert.deepEqual(parseDevices(out([])), []);
});

test("classify prioritizes ready, then unauthorized, offline, none", () => {
  assert.deepEqual(classify(parseDevices(out(["a\tdevice"]))), {
    status: "ready",
    serial: "a",
  });
  assert.equal(classify(parseDevices(out(["a\tunauthorized"]))).status, "unauthorized");
  assert.equal(classify(parseDevices(out(["a\toffline"]))).status, "offline");
  assert.equal(classify([]).status, "none");
});
