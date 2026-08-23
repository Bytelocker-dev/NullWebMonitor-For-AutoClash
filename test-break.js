"use strict";

// Humanized break handling. AutoClash closes Clash for the duration of a break,
// so the log goes completely silent and the run would otherwise be reported as
// stalled (red) a few minutes in. These checks use the real log format.
// Run: node test-break.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const botSource = fs.readFileSync(path.join(__dirname, "bot.js"), "utf8");

// Pulls one top-level function out of bot.js by scanning to its closing brace.
function grab(name) {
  const lines = botSource.split(/\r?\n/);
  const from = lines.findIndex((line) => line.startsWith(`function ${name}(`));
  if (from === -1) throw new Error(`bot.js has no top-level function ${name}`);
  const to = lines.findIndex((line, index) => index > from && line === "}");
  if (to === -1) throw new Error(`could not find the end of ${name}`);
  return lines.slice(from, to + 1).join("\n");
}

const helpers = new Function(
  "fs",
  "path",
  [
    grab("normalizeKey"),
    grab("lineContains"),
    grab("analyzeLogLines"),
    grab("parseBreakMinutes"),
    grab("isOnBreak"),
    grab("breakSecondsLeft"),
    grab("lineClockToDate"),
    grab("scanLogTailForBreak"),
    "return { analyzeLogLines, parseBreakMinutes, isOnBreak, breakSecondsLeft, scanLogTailForBreak };",
  ].join("\n")
)(fs, path);

// Exactly how AutoClash writes it - no clock prefix in the file.
const BREAK_START = "[SCHEDULE]Humanized break started: 38 minute(s) - closing Clash";
const BREAK_CLOSE = "[ADB] Closing Clash of Clans";
const BREAK_END = "[SCHEDULE]Humanized break ended, relaunching Clash";

// --- classification ---------------------------------------------------------

assert.strictEqual(helpers.analyzeLogLines([BREAK_START, BREAK_CLOSE]), "humanized-break", "break lines classify as a break");
assert.strictEqual(helpers.analyzeLogLines([BREAK_CLOSE]), null, "closing Clash alone is not a session end");

// --- duration parsing -------------------------------------------------------

assert.strictEqual(helpers.parseBreakMinutes([BREAK_START, BREAK_CLOSE]), 38, "duration is read from the line");
assert.strictEqual(helpers.parseBreakMinutes(["[SCHEDULE]Humanized break started: 12 minute(s) - closing Clash"]), 12, "other durations parse");
assert.strictEqual(helpers.parseBreakMinutes(["Humanized break started: 5 minutes"]), 5, "plural form parses");
assert.strictEqual(helpers.parseBreakMinutes([BREAK_END]), null, "the end line carries no duration");
assert.strictEqual(helpers.parseBreakMinutes([]), null, "empty input is safe");

// --- break window -----------------------------------------------------------

assert.strictEqual(helpers.isOnBreak({ breakUntil: Date.now() + 60000 }), true, "inside the window");
assert.strictEqual(helpers.isOnBreak({ breakUntil: Date.now() - 1000 }), false, "past the window");
assert.strictEqual(helpers.isOnBreak({ breakUntil: 0 }), false, "no break set");
assert.strictEqual(helpers.isOnBreak({}), false, "missing field is not a break");

const left = helpers.breakSecondsLeft({ breakUntil: Date.now() + 120000 });
assert.ok(left > 110 && left <= 120, `about two minutes left, got ${left}`);
assert.strictEqual(helpers.breakSecondsLeft({ breakUntil: 0 }), 0, "no countdown when not on break");

// --- scanning a real log file ----------------------------------------------
// The file has no timestamps, so the start time comes from its mtime. This is
// what lets a restart mid-break recover the correct state.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brk-"));
const logPath = path.join(dir, "log.txt");

function writeLog(lines, minutesAgo) {
  fs.writeFileSync(logPath, `${lines.join("\n")}\n`);
  const when = new Date(Date.now() - minutesAgo * 60 * 1000);
  fs.utimesSync(logPath, when, when);
}

// A 38 minute break that started 10 minutes ago is still running.
writeLog(["[BUILDER]Checking for Donations", BREAK_START, BREAK_CLOSE], 10);
let scan = helpers.scanLogTailForBreak(logPath);
assert.ok(scan, "an in-progress break is detected");
assert.strictEqual(scan.minutes, 38, "duration carried through");
assert.ok(scan.endsAt > Date.now(), "end time is in the future");
assert.ok(Math.abs(scan.endsAt - (Date.now() + 28 * 60 * 1000)) < 60000, "about 28 minutes remain");

// The same break, but started 40 minutes ago, is over.
writeLog(["[BUILDER]Checking for Donations", BREAK_START, BREAK_CLOSE], 40);
assert.strictEqual(helpers.scanLogTailForBreak(logPath), null, "an expired break is not reported");

// An explicit end line ends the break regardless of the clock.
writeLog([BREAK_START, BREAK_CLOSE, BREAK_END, "[SEARCH]Finding battle"], 5);
assert.strictEqual(helpers.scanLogTailForBreak(logPath), null, "the break-ended line closes the break");

// Plenty of activity after the break line means the mtime is no longer the
// break's start, so it must not be trusted.
writeLog([BREAK_START, BREAK_CLOSE, "[SEARCH]a", "[SEARCH]b", "[SEARCH]c"], 5);
assert.strictEqual(helpers.scanLogTailForBreak(logPath), null, "later activity invalidates the mtime guess");

// No break in the file at all.
writeLog(["[SEARCH]Finding battle", "[ATTACK] TH accepted: th17"], 1);
assert.strictEqual(helpers.scanLogTailForBreak(logPath), null, "no break line, no break");

assert.strictEqual(helpers.scanLogTailForBreak(path.join(dir, "missing.txt")), null, "a missing file is safe");
assert.strictEqual(helpers.scanLogTailForBreak(""), null, "an empty path is safe");

fs.rmSync(dir, { recursive: true, force: true });

console.log("All break checks passed.");
