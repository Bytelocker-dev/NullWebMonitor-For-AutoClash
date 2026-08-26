"use strict";

// Log fault classifier. Every sample below is a real line taken from the
// AutoClash logs on this machine, so the patterns stay honest.
// Run: node test-parser.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const botSource = fs.readFileSync(path.join(__dirname, "..", "bot.js"), "utf8");

function grab(name) {
  const lines = botSource.split(/\r?\n/);
  const from = lines.findIndex((line) => line.startsWith(`function ${name}(`));
  if (from === -1) throw new Error(`bot.js has no top-level function ${name}`);
  const to = lines.findIndex((line, index) => index > from && line === "}");
  return lines.slice(from, to + 1).join("\n");
}

const patternBlock = botSource.slice(
  botSource.indexOf("const LOG_PATTERNS"),
  botSource.indexOf("function classifyLogLine(")
);

const parser = new Function(
  [
    patternBlock,
    grab("classifyLogLine"),
    grab("classifyLogLines"),
    grab("recordLogHealth"),
    grab("logHealthSummary"),
    "return { classifyLogLine, classifyLogLines, recordLogHealth, logHealthSummary };",
  ].join("\n")
)();

const expect = (line, kind, severity) => {
  const result = parser.classifyLogLine(line);
  assert.ok(result, `should classify: ${line}`);
  assert.strictEqual(result.kind, kind, `kind for: ${line}`);
  assert.strictEqual(result.severity, severity, `severity for: ${line}`);
};

// --- hard faults ------------------------------------------------------------

expect("[ADB ERROR] device offline", "device-error", "error");
expect("[ADB ERROR] device '127.0.0.1:16384' not found", "device-error", "error");
expect("[ADB ERROR] tap failed: device offline", "device-error", "error");
expect("[ADB] Device offline - waiting for reconnect", "device-error", "error");
expect("[ZOOM_MULTI] Device connection failed", "device-error", "error");
expect("[WATCHDOG] Self-capture fallback failed: grab(): no usable screenshot after 8 attempts", "capture-error", "error");

// --- stuck / restart / failure ---------------------------------------------

expect("[SEARCH] Stuck searching, triggering recovery", "stuck", "warn");
expect("[WATCHDOG] Main loop reset not consumed, restarting bot worker", "restart", "warn");
expect("[WATCHDOG] Battle timeout with no popup handled", "watchdog", "warn");
expect("[WATCHDOG] Ranked battle timeout", "watchdog", "warn");
expect("[RAID] Cycle failed, exiting raid loop", "failure", "warn");
expect("[BUILDER]Army setup failed, recovering and resuming Builder Base", "failure", "warn");
expect("[BUILDER]Battle failed after retry, recovering and resuming Builder Base", "failure", "warn");

// --- self-healing -----------------------------------------------------------

expect("[RECOVERY]Relaunched", "recovery", "info");
expect("[ARMY]Army button not found, triggering recovery", "recovery", "info");
expect("[ERROR] Hard popup handled, resetting to start of main loop", "recovery", "info");
expect("[RAID] Attempting return to home after failure", "recovery", "info");

// --- scheduling -------------------------------------------------------------

expect("[SCHEDULE]Humanized break started: 38 minute(s) - closing Clash", "break-start", "info");
expect("[SCHEDULE]Humanized break ended, relaunching Clash", "break-end", "info");

// --- noise stays noise ------------------------------------------------------
// These fire hundreds of times in a healthy run and must never raise an alert.

expect("[WEEKLY]Weekly Store not found", "not-found", "noise");
expect("[CC] Treasury not found", "not-found", "noise");
expect("[BUILDER]Trash army button not found", "not-found", "noise");
expect("[ADB] Closing Clash of Clans", "clash-closed", "noise");
expect("[CLAN GAME]Unable to start", "failure", "noise");

// Ordinary gameplay is not classified at all.
for (const line of ["[SEARCH]Finding battle", "[BATTLE]Stars: 2", "[WALL]Checking loot for wall upgrades"]) {
  assert.strictEqual(parser.classifyLogLine(line), null, `should ignore: ${line}`);
}

// --- health rollup ----------------------------------------------------------

const log = { name: "test" };
parser.recordLogHealth(log, parser.classifyLogLines([
  "[ADB ERROR] device offline",
  "[SEARCH] Stuck searching, triggering recovery",
  "[RECOVERY]Relaunched",
  "[WEEKLY]Weekly Store not found",
  "[WEEKLY]Weekly Store not found",
]));

const summary = parser.logHealthSummary(log);
assert.strictEqual(summary.lastHour.errors, 1, "one error counted");
assert.strictEqual(summary.lastHour.warnings, 1, "one warning counted");
assert.strictEqual(summary.lastHour.recoveries, 1, "one recovery counted");
assert.strictEqual(summary.counts["not-found"], 2, "noise is counted but not alerted");
assert.ok(summary.recent.every((entry) => entry.severity !== "noise"), "noise never reaches the recent list");

// Old entries fall out of the one-hour window.
log.health.recent[0].at = Date.now() - 2 * 60 * 60 * 1000;
parser.recordLogHealth(log, []);
assert.ok(parser.logHealthSummary(log).recent.length < 3, "entries older than an hour are dropped");

console.log("All parser checks passed.");
