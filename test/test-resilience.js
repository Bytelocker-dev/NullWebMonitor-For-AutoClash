"use strict";

// Three failure modes seen in a real overnight run:
//   1. ntfy pushes died on a title containing an em dash
//   2. a missing ADB device logged a stack trace every few seconds, forever
//   3. Discord channel renames hit 429 and then slept for minutes at a time
// Run: node test-resilience.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "bot.js"), "utf8");
const lines = source.split(/\r?\n/);

function grab(name) {
  const from = lines.findIndex((line) =>
    line.startsWith(`function ${name}(`) ||
    line.startsWith(`async function ${name}(`) ||
    line.startsWith(`const ${name} =`)
  );
  if (from === -1) throw new Error(`bot.js has no top-level ${name}`);

  const head = lines[from];
  // A one-line const, with or without a trailing comment.
  if (head.startsWith(`const ${name} =`) && head.includes(";")) return head;

  const closer = head.startsWith(`const ${name} =`) ? "};" : "}";
  const to = lines.findIndex((line, i) => i > from && line === closer);
  if (to === -1) throw new Error(`could not find the end of ${name}`);
  return lines.slice(from, to + 1).join("\n");
}

function build(names, exported, injected) {
  const argNames = Object.keys(injected);
  const argValues = Object.values(injected);
  const body = names.map(grab).join("\n") + `\nreturn { ${exported.join(", ")} };`;
  return new Function(...argNames, body)(...argValues);
}

const quiet = { error() {}, warn() {}, log() {} };

// --- 1. push notifications survive non-ASCII ---------------------------------

async function pushChecks() {
  const calls = [];
  const errors = [];

  const fakeFetch = async (url, options) => {
    // Node's fetch rejects header values outside latin-1. Reproduce that, or
    // the test would pass against the very bug it exists to catch.
    for (const value of Object.values((options && options.headers) || {})) {
      for (const char of String(value)) {
        if (char.codePointAt(0) > 255) {
          throw new TypeError(
            `Cannot convert argument to a ByteString because the character at index 0 has a value of ${char.codePointAt(0)} which is greater than 255.`
          );
        }
      }
    }
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => "" };
  };

  const mod = build(
    ["PUSH_SEVERITY_RANK", "parseBooleanEnv", "pushConfig", "sendPush"],
    ["sendPush"],
    { fetch: fakeFetch, console: { ...quiet, error: (m) => errors.push(String(m)) } }
  );

  process.env.NTFY_ENABLED = "true";
  process.env.NTFY_TOPIC = "test-topic";
  process.env.NTFY_MIN_SEVERITY = "warn";

  await mod.sendPush({
    severity: "error",
    kind: "device-error",
    instance: "AutoClash v2.0.7 Shady",
    message: "device offline — waiting for reconnect",
  });

  assert.strictEqual(errors.length, 0, "an em dash must not break the push:\n" + errors.join("\n"));
  assert.strictEqual(calls.length, 1, "one request is sent");

  const sent = calls[0];
  for (const value of Object.values(sent.options.headers || {})) {
    for (const char of String(value)) {
      assert.ok(char.codePointAt(0) <= 255, `header value stays latin-1: ${value}`);
    }
  }

  // The title still has to reach the phone intact, so it belongs in the body.
  const body = typeof sent.options.body === "string" ? sent.options.body : "";
  assert.ok(body.includes("—"), "the em dash survives in the payload");
  assert.ok(body.includes("Shady"), "the instance name is in the payload");
  assert.ok(body.includes("device offline"), "the message is in the payload");
}

// --- 2. channel renames respect Discord's own rate limit ---------------------

async function renameChecks() {
  const renames = [];
  const config = {
    renameChannel: async (channelId, name) => void renames.push({ channelId, name }),
  };

  const mod = build(
    ["RENAME_MIN_INTERVAL_MS", "channelRenameHistory", "updateChannelName"],
    ["updateChannelName", "channelRenameHistory"],
    { console: quiet }
  );

  const log = { channelId: "111", channelBaseName: "main-farm", status: "running" };

  await mod.updateChannelName(log, config);
  assert.strictEqual(renames.length, 1, "the first rename goes through");
  assert.ok(renames[0].name.includes("main-farm"), "the base name is kept");

  await mod.updateChannelName(log, config);
  assert.strictEqual(renames.length, 1, "an unchanged name is not re-sent");

  // Discord allows two renames per ten minutes per channel. A bot flapping
  // between running and paused would blow through that in seconds.
  log.status = "paused";
  await mod.updateChannelName(log, config);
  log.status = "running";
  await mod.updateChannelName(log, config);
  log.status = "stalled";
  await mod.updateChannelName(log, config);
  assert.ok(renames.length <= 2, `at most two renames inside the window, got ${renames.length}`);

  // Once the window passes, the newest status is applied — not a stale one
  // queued earlier.
  for (const entry of mod.channelRenameHistory.values()) entry.lastAt -= 11 * 60 * 1000;
  await mod.updateChannelName(log, config);
  const last = renames[renames.length - 1];
  assert.ok(last.name.includes("\u{1F534}"), `the newest status wins, got ${last.name}`);
}

// --- 3. a missing ADB device does not spam the console -----------------------

async function visualChecks() {
  const messages = [];
  const mod = build(
    ["VISUAL_FAILURE_BACKOFF_MS", "noteVisualFailure"],
    ["noteVisualFailure"],
    { console: { ...quiet, error: (m) => messages.push(String(m)), warn: (m) => messages.push(String(m)) } }
  );

  const log = { name: "Shady" };
  const error = new Error("error: device '127.0.0.1:16384' not found\nADB screencap returned no data");

  for (let i = 0; i < 10; i += 1) mod.noteVisualFailure(log, error);
  assert.strictEqual(messages.length, 1, `the same failure is reported once, got ${messages.length}`);

  // And the check should stop running for a while rather than retrying every
  // few seconds against a device that is not there.
  assert.ok(log.visualBackoffUntil > Date.now(), "a backoff window is set");
  assert.ok(log.visualBackoffUntil - Date.now() > 60 * 1000, "the backoff is long enough to be worth having");

  // A different failure is still worth hearing about.
  mod.noteVisualFailure(log, new Error("something else entirely"));
  assert.strictEqual(messages.length, 2, "a new kind of failure is reported");
}

Promise.resolve()
  .then(pushChecks)
  .then(renameChecks)
  .then(visualChecks)
  .then(() => console.log("All resilience checks passed."))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
