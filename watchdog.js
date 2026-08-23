"use strict";

/* Keeps the monitor running.
 *
 * Three things can go wrong and each needs a different answer:
 *   - bot.js throws or is killed        -> this file restarts it
 *   - this file dies                    -> the .bat loop restarts it
 *   - the window is closed, or a reboot -> Install-Watchdog-Task.ps1
 *
 * On every restart anything the previous run left behind is cleared first: the
 * old process tree, which on Windows can include PowerShell children that
 * outlive their parent, and the TCP port, which lingers briefly afterwards.
 *
 * Run: node watchdog.js      (the launcher does this for you)
 */

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const ENTRY = process.env.WATCHDOG_ENTRY || "bot.js";
const PID_FILE = path.join(process.cwd(), "monitor.pid");
const CRASH_LOG = path.join(process.cwd(), "crash-log.txt");
const CRASH_LOG_LINES = 200;

const LIMITS = {
  min: Number(process.env.WATCHDOG_MIN_BACKOFF_MS || 2000),
  max: Number(process.env.WATCHDOG_MAX_BACKOFF_MS || 60000),
};

// A run this long counts as healthy, so the next crash starts from the
// shortest wait rather than continuing yesterday's escalation.
const HEALTHY_RUN_MS = Number(process.env.WATCHDOG_HEALTHY_RUN_MS || 120000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Back off on a crash loop, but never so far that a real outage goes unattended.
 * A run that lasted counts as recovery and resets the wait. */
function nextDelay(previous, ranMs, limits = LIMITS) {
  if (ranMs >= HEALTHY_RUN_MS) return limits.min;
  if (!previous) return limits.min;
  return Math.min(previous * 2, limits.max);
}

/* Is this PID a live process that is running our entry file?
 *
 * Both halves matter. PIDs are reused, so "the PID in the file is alive" is not
 * evidence of anything on its own — killing on that alone would eventually kill
 * something innocent. Anything unverifiable is left alone. */
function processMatches(pid, entry = ENTRY) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;

  try {
    process.kill(id, 0); // does not signal, only asks whether it exists
  } catch (error) {
    if (error.code === "EPERM") return false; // alive but not ours to touch
    return false;
  }

  try {
    const output = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId=${id}" | Select-Object -ExpandProperty CommandLine`,
      ],
      { encoding: "utf8", timeout: 10000, windowsHide: true }
    );
    return output.toLowerCase().includes(String(entry).toLowerCase());
  } catch {
    // No answer means no proof, and no proof means no kill.
    return false;
  }
}

/* Kill the whole tree. /T matters: the monitor shells out to PowerShell, and
 * those children survive their parent otherwise. */
function killTree(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 15000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function readPidFile() {
  try {
    return Number(fs.readFileSync(PID_FILE, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

function clearPidFile() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Already gone, which is the state we wanted.
  }
}

/* Whatever the last run left behind. Called before every start, not only the
 * first, because a killed monitor can leave the same mess mid-session. */
function reapStale(entry = ENTRY) {
  const pid = readPidFile();
  if (!pid) return false;

  if (processMatches(pid, entry)) {
    console.log(`[watchdog] Previous monitor (pid ${pid}) is still running. Stopping it.`);
    killTree(pid);
    clearPidFile();
    return true;
  }

  clearPidFile();
  return false;
}

function configuredPort() {
  const fromEnv = Number(process.env.WEB_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const line = fs
      .readFileSync(path.join(process.cwd(), ".env"), "utf8")
      .split(/\r?\n/)
      .find((entry) => entry.trim().startsWith("WEB_PORT="));
    return line ? Number(line.split("=")[1].trim()) || 8477 : 8477;
  } catch {
    return 8477;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "0.0.0.0");
  });
}

/* Windows holds a closed socket for a moment. Starting into that window gives
 * an EADDRINUSE that looks like a real conflict but is only timing. */
async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portFree(port)) return true;
    await sleep(500);
  }
  console.warn(
    `[watchdog] Port ${port} is still held by something else. Starting anyway — the monitor will say so if it cannot bind.`
  );
  return false;
}

function recordCrash(entry, code, signal, ranMs) {
  const reason = signal ? `signal ${signal}` : `code ${code}`;
  const line = `${new Date().toISOString()}  ${entry} exited with ${reason} after ${Math.round(ranMs / 1000)}s`;
  console.error(`[watchdog] ${line}`);

  try {
    let existing = "";
    try {
      existing = fs.readFileSync(CRASH_LOG, "utf8");
    } catch {
      // First crash, nothing to append to.
    }
    const lines = (existing + line + "\n").split("\n").filter(Boolean);
    fs.writeFileSync(CRASH_LOG, lines.slice(-CRASH_LOG_LINES).join("\n") + "\n");
  } catch (error) {
    console.error(`[watchdog] Could not write the crash log: ${error.message}`);
  }
}

let child = null;
let stopping = false;

function runOnce(entry) {
  return new Promise((resolve) => {
    child = spawn(process.execPath, [entry], { cwd: process.cwd(), stdio: "inherit" });

    try {
      fs.writeFileSync(PID_FILE, String(child.pid));
    } catch (error) {
      console.error(`[watchdog] Could not record the monitor pid: ${error.message}`);
    }

    child.on("exit", (code, signal) => {
      child = null;
      clearPidFile();
      resolve({ code, signal });
    });

    child.on("error", (error) => {
      console.error(`[watchdog] Could not start ${entry}: ${error.message}`);
      child = null;
      clearPidFile();
      resolve({ code: -1, signal: null });
    });
  });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (child && child.pid) killTree(child.pid);
  clearPidFile();
  process.exit(0);
}

async function main() {
  console.log(`[watchdog] Supervising ${ENTRY}. Close this window to stop everything.`);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  const port = configuredPort();
  reapStale();

  let delay = 0;
  for (;;) {
    await waitForPort(port);

    const startedAt = Date.now();
    const { code, signal } = await runOnce(ENTRY);
    const ranMs = Date.now() - startedAt;

    if (stopping) return;

    // A clean exit is the monitor being told to stop, not a crash.
    if (code === 0 && !signal) {
      console.log("[watchdog] Monitor exited cleanly. Nothing to restart.");
      return;
    }

    recordCrash(ENTRY, code, signal, ranMs);
    delay = nextDelay(delay, ranMs);
    console.log(`[watchdog] Restarting in ${Math.round(delay / 1000)}s.`);
    await sleep(delay);
    reapStale();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[watchdog] ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = { nextDelay, processMatches, reapStale, killTree, recordCrash, configuredPort, waitForPort };
