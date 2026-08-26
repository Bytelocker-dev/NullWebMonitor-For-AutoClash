"use strict";

// The watchdog restarts the monitor when it dies and clears anything it left
// behind. Two things matter most: it must actually come back, and it must
// never kill a process it has not positively identified as the old monitor —
// PIDs get reused, and a watchdog that kills the wrong thing is worse than no
// watchdog at all.
// Run: node test-watchdog.js

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const watchdog = require(path.join(__dirname, "..", "watchdog.js"));

// --- backoff -----------------------------------------------------------------

{
  const min = 2000;
  const max = 60000;

  // A crash loop must slow down rather than hammer the machine.
  let delay = watchdog.nextDelay(0, 100, { min, max });
  assert.strictEqual(delay, min, "the first restart waits the minimum");

  delay = watchdog.nextDelay(delay, 100, { min, max });
  assert.strictEqual(delay, min * 2, "a quick second crash doubles the wait");

  for (let i = 0; i < 10; i += 1) delay = watchdog.nextDelay(delay, 100, { min, max });
  assert.strictEqual(delay, max, "the wait is capped");

  // A process that stayed up was not crash-looping, so start over.
  assert.strictEqual(
    watchdog.nextDelay(max, 10 * 60 * 1000, { min, max }),
    min,
    "a long healthy run resets the backoff"
  );
}

// --- identifying the old process ---------------------------------------------

{
  // A PID that is not running at all is nothing to clean up.
  assert.strictEqual(watchdog.processMatches(2 ** 30, "bot.js"), false, "a dead PID does not match");

  // This test process is alive but is not the monitor, so it must not match.
  // If this ever returns true the watchdog would kill an innocent process.
  assert.strictEqual(
    watchdog.processMatches(process.pid, "bot.js"),
    false,
    "an unrelated live process is not treated as the old monitor"
  );

  // And it does match a process that really is running the entry file.
  const child = spawn(process.execPath, [path.join(__dirname, "test-watchdog-child.js")], {
    stdio: "ignore",
  });
  try {
    // Give Windows a moment to publish the command line.
    const deadline = Date.now() + 8000;
    let matched = false;
    while (Date.now() < deadline && !matched) {
      matched = watchdog.processMatches(child.pid, "test-watchdog-child.js");
    }
    assert.ok(matched, "a live process running the entry file is identified");
  } finally {
    try { process.kill(child.pid); } catch { /* already gone */ }
  }
}

// --- it actually restarts ------------------------------------------------------

async function restartCheck() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-"));
  fs.copyFileSync(path.join(__dirname, "..", "watchdog.js"), path.join(dir, "watchdog.js"));

  // A monitor that dies immediately, and counts how often it was started.
  fs.writeFileSync(
    path.join(dir, "crasher.js"),
    [
      'const fs = require("fs");',
      'const path = require("path");',
      'const file = path.join(__dirname, "starts.txt");',
      'fs.appendFileSync(file, "start\\n");',
      "process.exit(3);",
    ].join("\n")
  );

  const child = spawn(process.execPath, ["watchdog.js"], {
    cwd: dir,
    stdio: "ignore",
    env: {
      ...process.env,
      WATCHDOG_ENTRY: "crasher.js",
      WATCHDOG_MIN_BACKOFF_MS: "60",
      WATCHDOG_MAX_BACKOFF_MS: "120",
      // A port nothing else is on. Without this the watchdog waits on whatever
      // is holding the default, which is usually the real monitor.
      WEB_PORT: "8489",
    },
  });

  const startsFile = path.join(dir, "starts.txt");
  const deadline = Date.now() + 15000;
  let starts = 0;
  while (Date.now() < deadline && starts < 3) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    starts = fs.existsSync(startsFile) ? fs.readFileSync(startsFile, "utf8").trim().split("\n").length : 0;
  }

  assert.ok(starts >= 3, `the monitor is restarted after it dies, saw ${starts} starts`);

  const crashLog = path.join(dir, "crash-log.txt");
  assert.ok(fs.existsSync(crashLog), "crashes are written down");
  const text = fs.readFileSync(crashLog, "utf8");
  assert.ok(text.includes("code 3"), "the exit code is recorded:\n" + text.slice(0, 300));

  // Shutting the watchdog down must not leave its own bookkeeping behind.
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  try { process.kill(child.pid, 0); process.kill(child.pid); } catch { /* already gone */ }

  fs.rmSync(dir, { recursive: true, force: true });
}

restartCheck()
  .then(() => console.log("All watchdog checks passed."))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
