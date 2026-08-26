"use strict";

// Session persistence. The monitor restarts often, so sessions must survive a
// restart — but the file on disk must never contain something replayable.
// Run: node test-sessions.js

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVER_DIR = path.resolve(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
fs.writeFileSync(path.join(dir, ".env"), "WEB_PASSWORD_HASH=scrypt$aa$bb\r\n");
process.chdir(dir);

process.env.WEB_PASSWORD_HASH = "scrypt$aa$bb";
process.env.WEB_ENABLED = "true";

const sessionFile = path.join(dir, "web-sessions.json");
const tokenKey = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

// The server module is a factory; drive its session logic through a real
// instance on a throwaway port.
const { startWebServer } = require(path.join(SERVER_DIR, "web-server.js"));

const stubDeps = {
  logs: [],
  control: { instances: [], autoUpdateEnabled: false },
  resolveInstance: () => null,
  exeAction: async () => "",
  openExe: async () => "",
  closeExe: async () => "",
  openLd: async () => "",
  closeLd: async () => "",
  screen: async () => "",
  liveFrame: async () => Buffer.alloc(0),
  fullScreen: async () => "",
  sessionStats: () => ({}),
  dailyStats: () => ({}),
  sessionStatsRaw: () => null,
  dailyStatsRaw: () => null,
  statusEmbed: () => ({}),
  recentLines: () => "",
  logHealth: () => ({ counts: {}, since: Date.now(), lastHour: { errors: 0, warnings: 0, recoveries: 0 }, recent: [] }),
  checkUpdate: async () => ({}),
  updateFlags: () => ({}),
  readConfig: () => ({}),
  saveConfig: () => {},
  discordStatus: () => ({ configured: false, running: false, connected: false, startedAt: 0, lastError: "", channelId: "", controlPanelEnabled: false, logChannels: [] }),
  startDiscord: async () => "",
  stopDiscord: () => "",
  readIncidents: () => [],
  incidentDir: () => dir,
  history: () => ({ days: [], sessions: [] }),
  dailySummary: () => ({}),
  screenSize: async () => ({ width: 0, height: 0 }),
  tap: async () => "",
  pushStatus: () => ({ enabled: false, server: "", minSeverity: "warn", topicSet: false }),
  testPush: async () => {},
};

let failures = 0;
function check(label, condition, extra = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition ? "" : `  <- ${extra}`}`);
  if (!condition) failures += 1;
}

const BASE = "http://127.0.0.1:8996";
process.env.WEB_PORT = "8996";
process.env.WEB_HOST = "127.0.0.1";
startWebServer(stubDeps);

async function login(password = "pw") {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, cookie: setCookie ? setCookie.split(";")[0] : "" };
}

async function stateWith(cookie) {
  const res = await fetch(`${BASE}/api/state`, { headers: cookie ? { cookie } : {} });
  return res.status;
}

setTimeout(async () => {
  // The hash in .env is a dummy, so a real login cannot succeed. Exercise the
  // persistence layer by writing a session the same way issueSession does.
  const token = crypto.randomBytes(32).toString("hex");
  const expires = Date.now() + 60 * 60 * 1000;
  fs.writeFileSync(sessionFile, JSON.stringify({ [tokenKey(token)]: expires }), "utf8");

  // A fresh server instance must pick the session up from disk.
  process.env.WEB_PORT = "8995";
  startWebServer(stubDeps);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const restored = await fetch("http://127.0.0.1:8995/api/state", { headers: { cookie: `acsession=${token}` } });
  check("session survives a restart", restored.status === 200, `status ${restored.status}`);

  const wrong = await fetch("http://127.0.0.1:8995/api/state", { headers: { cookie: "acsession=not-a-real-token" } });
  check("unknown token still rejected", wrong.status === 401, `status ${wrong.status}`);

  // The stored key must be a hash, never the cookie value itself.
  const onDisk = fs.readFileSync(sessionFile, "utf8");
  check("token is not stored in plaintext", !onDisk.includes(token), "raw token found in web-sessions.json");
  check("token hash is stored", onDisk.includes(tokenKey(token)));

  // Expired entries are dropped on load.
  const stale = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(sessionFile, JSON.stringify({ [tokenKey(stale)]: Date.now() - 1000 }), "utf8");
  process.env.WEB_PORT = "8994";
  startWebServer(stubDeps);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const expiredRes = await fetch("http://127.0.0.1:8994/api/state", { headers: { cookie: `acsession=${stale}` } });
  check("expired session is not restored", expiredRes.status === 401, `status ${expiredRes.status}`);

  // A corrupt file must not stop the panel from starting.
  fs.writeFileSync(sessionFile, "{ this is not json", "utf8");
  process.env.WEB_PORT = "8993";
  let survived = true;
  try {
    startWebServer(stubDeps);
  } catch {
    survived = false;
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterCorrupt = await fetch("http://127.0.0.1:8993/api/session").then((r) => r.status).catch(() => 0);
  check("corrupt session file does not crash startup", survived && afterCorrupt === 200, `survived=${survived} status=${afterCorrupt}`);

  process.chdir(SERVER_DIR);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll session checks passed.");
  process.exit(failures ? 1 : 0);
}, 400);
