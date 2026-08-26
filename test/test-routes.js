// Boots web-server.js with stub deps in a throwaway cwd, then exercises the
// routes. Never touches Discord or AutoClash.
const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVER_DIR = path.resolve(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
fs.writeFileSync(path.join(dir, ".env"), "WEB_PASSWORD=hunter2\r\n");
process.chdir(dir);

process.env.WEB_PASSWORD = "hunter2";
process.env.WEB_PORT = "8999";
process.env.WEB_HOST = "127.0.0.1";

const instances = [
  { id: "main", label: "AutoClash", device: "127.0.0.1:5556", version: "pro", active: true, exePath: "C:/fake/AutoClash.exe" },
  { id: "ld9", label: "LD9", device: "127.0.0.1:5555", version: "pro", active: false, exePath: "C:/fake2/AutoClash.exe" },
];
const logs = [
  { name: "TestLog", path: "C:/logs/*.txt", activePath: "C:/logs/a.txt", status: "active", pausedReason: null, lastActivity: Date.now(), recentLines: ["line one", "line two"] },
];

let discordRunning = false;
let instanceRunning = true;
let launchCalls = [];
const cfgStore = {};
let lastTap = null;
let pushEnabled = false;
let pushSent = 0;
const incidentsDir = path.join(dir, "incidents");
fs.mkdirSync(incidentsDir, { recursive: true });
fs.writeFileSync(path.join(incidentsDir, "1700000000000-aabbccdd.jpg"), Buffer.from("ffd8ffe000104a464946", "hex"));
const { startWebServer } = require(path.join(SERVER_DIR, "web-server.js"));

const web = startWebServer({
  logs,
  control: { instances, autoUpdateEnabled: false },
  resolveInstance: (id) => instances.find((i) => i.id === id) || null,
  exeAction: async (action, instance) => `${instance.label} ${action} ok`,
  openExe: async () => "opened",
  launch: (instance) => { launchCalls.push(instance.id); return `Launching ${instance.label}`; },
  closeExe: async () => "closed",
  openLd: async () => "ld opened",
  closeLd: async () => "ld closed",
  screen: async () => { const f = path.join(dir, "s.png"); fs.writeFileSync(f, Buffer.from("89504e470d0a1a0a", "hex")); return f; },
  fullScreen: async () => { const f = path.join(dir, "f.png"); fs.writeFileSync(f, Buffer.from("89504e470d0a1a0a", "hex")); return f; },
  liveFrame: async () => Buffer.from("ffd8ffe000104a464946", "hex"),
  discordStatus: () => ({ configured: true, running: discordRunning, connected: discordRunning, startedAt: Date.now(), lastError: "", channelId: "123", controlPanelEnabled: true, logChannels: [{ name: "TestLog", channelId: "123" }] }),
  startDiscord: async () => { discordRunning = true; return "Discord bot started."; },
  stopDiscord: () => { discordRunning = false; return "Discord bot stopped."; },
  readIncidents: (limit) => [
    { id: "1700000000000-aabbccdd", at: Date.now(), kind: "recovery", severity: "warn", log: "TestLog", instance: "AutoClash", message: "restarted", image: "1700000000000-aabbccdd.jpg" },
    { id: "1700000000001-11223344", at: Date.now(), kind: "event", severity: "info", log: "TestLog", instance: null, message: "note", image: null },
  ].slice(0, limit),
  incidentDir: () => incidentsDir,
  runStateCached: () => ({ running: instanceRunning, processCount: instanceRunning ? 3 : 0, version: "2.0.9", adbPort: "16416", account: "accountone", known: true }),
  runState: async () => ({ running: instanceRunning, processCount: instanceRunning ? 3 : 0, version: "2.0.9", adbPort: "16416", account: "accountone", title: "AutoClash Pro v2.0.9 | Android Device-1 (16416) | accountone" }),
  accounts: () => [{ name: "accountone", enabled: true }, { name: "accounttwo", enabled: true }],
  villages: (instance) => ({ currentAccount: "accountone", currentTownHall: "TH17", accounts: [{ name: "accountone", isActive: true, townHall: "TH17" }] }),
  runtimeStateKeys: () => ["CC_LOOT_CYCLE_START"],
  configEnums: () => ({ SELECTED_ATTACK_STRATEGY: ["valkyrie_1side", "edragon"] }),
  schemaDiff: () => ({ added: ["ZZ_NEW_KEY"], removed: [] }),
  readInstanceConfig: () => ({ ACTIVE_HOURS_ENABLED: false, BUILDER_MAX_ATTACKS: 5, CC_LOOT_CYCLE_START: 1 }),
  readAccountConfig: (i, account) => (account === "accountone" ? { BUILDER_MAX_ATTACKS: 5 } : null),
  writeInstanceConfig: async (i, updates) => {
    if (instanceRunning) throw new Error("still running");
    Object.assign(cfgStore, updates);
    return { changed: Object.keys(updates).length, backup: "config.bak.json" };
  },
  writeAccountConfig: async (i, account, updates) => {
    if (instanceRunning) throw new Error("still running");
    Object.assign(cfgStore, updates);
    return { changed: Object.keys(updates).length, backup: "config.bak.json" };
  },
  revertConfig: async () => {
    if (instanceRunning) throw new Error("still running");
    return { restored: "config.bak.json" };
  },
  history: () => ({ days: [{ date: "2026-08-20", gold_gained: 10, elixir_gained: 5, dark_gained: 1, total_attacks: 3, donations_completed: 0, runtime_seconds: 3600 }], sessions: [{ at: 1, runtime_seconds: 3600, total_attacks: 3, goldPerHour: 10, elixirPerHour: 5, darkPerHour: 1, attacksPerHour: 3 }] }),
  dailySummary: () => ({ dayKey: "2026-08-20", windows: [], totals: { gold: 1, elixir: 0, dark: 0, attacks: 2, runtimeSeconds: 60 }, incidents: { total: 0, errors: 0, warnings: 0, list: [] } }),
  screenSize: async () => ({ width: 1600, height: 900 }),
  tap: async (instance, x, y) => { lastTap = { instance: instance.id, x, y }; return `Tapped on ${instance.label}.`; },
  pushStatus: () => ({ enabled: pushEnabled, server: "https://ntfy.sh", minSeverity: "warn", topicSet: true }),
  testPush: async () => { pushSent += 1; },
  sessionStats: () => ({ title: "S", description: "**1** attacks", fields: [{ name: "Gold", value: "gained **5**" }], footer: { text: "stats.db" } }),
  dailyStats: () => ({ title: "D", description: "d", fields: [], footer: { text: "x" } }),
  allTimeStats: () => ({ title: "A", description: "a", fields: [], footer: { text: "alltime" } }),
  sessionStatsRaw: () => ({ source: "stats.db", stats: { runtime_seconds: 3600, total_attacks: 10, gold_gained: 5000, elixir_gained: 4000, dark_gained: 100, donations_completed: 3, walls_upgraded: 2, obstacles_removed: 1, upgrades_done: 1, research_done: 0, bb_attacks: 7, bb_walls_upgraded: 4, stars_0: 1, stars_1: 6, stars_2: 3, stars_3: 0 } }),
  dailyStatsRaw: () => ({ date: "2026-08-21", source: "stats.db", stats: { bb_attacks: 9, bb_walls_upgraded: 5 } }),
  allTimeStatsRaw: () => ({ firstDate: "2026-08-01", lastDate: "2026-08-21", source: "stats.db", sessions: 42, days: 20, stats: { runtime_seconds: 72000, total_attacks: 250, gold_gained: 150000000 } }),
  statusEmbed: () => ({ title: "status", description: "", fields: [] }),
  recentLines: () => "lines",
  logHealth: () => ({ counts: { recovery: 2 }, since: Date.now(), lastHour: { errors: 1, warnings: 0, recoveries: 2 }, recent: [{ at: Date.now(), kind: "device-error", severity: "error", line: "[ADB ERROR] device offline" }] }),
  checkUpdate: async () => ({ updateAvailable: true, updateClicked: false }),
  updateFlags: () => ({ main: { label: "AutoClash", available: true, checkedAt: Date.now() } }),
  readConfig: () => ({ DISCORD_TOKEN: "tok", CHECK_INTERVAL_SECONDS: "5", WEB_PASSWORD_HASH: "scrypt$a$b" }),
  saveConfig: () => {},
});

const BASE = "http://127.0.0.1:8999";
let cookie = "";
let failures = 0;

async function call(method, route, body, useCookie = true) {
  const headers = { "content-type": "application/json" };
  if (useCookie && cookie) headers.cookie = cookie;
  const res = await fetch(BASE + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const type = res.headers.get("content-type") || "";
  const payload = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, payload };
}

function check(label, condition, extra = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition ? "" : `  <- ${extra}`}`);
  if (!condition) failures += 1;
}

setTimeout(async () => {
  let r;

  r = await call("GET", "/api/state");
  check("unauthenticated /api/state is 401", r.status === 401, JSON.stringify(r.payload));

  r = await call("GET", "/manifest.webmanifest", null, false);
  check("manifest served without a session", r.status === 200 && r.payload.name === "XOR WebMonitor for AutoClash" && r.payload.display === "standalone", JSON.stringify(r.payload).slice(0,120));

  r = await call("GET", "/sw.js", null, false);
  check("service worker served without a session", r.status === 200 && String(r.payload).includes("fetch"), r.status);

  r = await call("GET", "/icon-192.png", null, false);
  check("icon served without a session", r.status === 200 && r.payload.slice(1, 4).toString() === "PNG", r.status);

  r = await call("POST", "/api/login", { password: "wrong" });
  check("wrong password rejected", r.status === 401, JSON.stringify(r.payload));

  r = await call("POST", "/api/login", { password: "hunter2" });
  check("correct password accepted", r.status === 200 && cookie.startsWith("acsession="), JSON.stringify(r.payload));

  r = await call("GET", "/api/state");
  check("state returns instances + logs",
    r.status === 200 && r.payload.instances.length === 2 && r.payload.logs[0].name === "TestLog",
    JSON.stringify(r.payload).slice(0, 200));

  check("state exposes update flag", r.payload.updates?.main?.available === true);
  check("state does NOT leak exe secrets", !JSON.stringify(r.payload).includes("DISCORD_TOKEN"));

  r = await call("POST", "/api/action", { action: "start", instanceId: "main" });
  check("per-instance action runs", r.status === 200 && r.payload.output === "AutoClash start ok", JSON.stringify(r.payload));

  r = await call("POST", "/api/action", { action: "start" });
  check("global action targets only active windows",
    r.status === 200 && r.payload.output === "AutoClash: AutoClash start ok" && !r.payload.output.includes("LD9"),
    JSON.stringify(r.payload));

  r = await call("POST", "/api/action", { action: "rm -rf", instanceId: "main" });
  check("unknown action rejected", r.status === 500 && /Unknown action/.test(r.payload.error), JSON.stringify(r.payload));

  r = await call("POST", "/api/action", { action: "start", instanceId: "nope" });
  check("unknown instance rejected", r.status === 404, JSON.stringify(r.payload));

  r = await call("GET", "/api/screen/main");
  check("screen returns png bytes", r.status === 200 && r.payload.slice(0, 4).toString("hex") === "89504e47", r.status);
  check("screen file deleted after send", !fs.existsSync(path.join(dir, "s.png")));

  r = await call("GET", "/api/stats/main/session");
  check("session stats embed", r.status === 200 && r.payload.embed.title === "S", JSON.stringify(r.payload));

  r = await call("GET", "/api/stats/main/daily");
  check("daily stats embed", r.status === 200 && r.payload.embed.title === "D");

  r = await call("POST", "/api/update/check", { instanceId: "main" });
  check("update check", r.status === 200 && r.payload.updateAvailable === true);

  r = await call("GET", "/api/config");
  check("config read", r.status === 200 && r.payload.env.CHECK_INTERVAL_SECONDS === "5");

  r = await call("GET", "/index.html");
  check("static index served", r.status === 200 && r.payload.toString().includes("XOR WebMonitor"));

  r = await call("GET", "/../.env");
  check("path traversal blocked", r.status === 403 || r.status === 404, r.status);

  const envAfter = fs.readFileSync(path.join(dir, ".env"), "utf8");
  check("plaintext WEB_PASSWORD removed from .env", !/^WEB_PASSWORD=/m.test(envAfter), envAfter);
  check("WEB_PASSWORD_HASH written to .env", /WEB_PASSWORD_HASH=scrypt\$/.test(envAfter), envAfter);

  r = await call("GET", "/api/live/main");
  check("live frame returns jpeg", r.status === 200 && r.payload.slice(0, 3).toString("hex") === "ffd8ff", r.status);

  r = await call("GET", "/api/stats/all");
  check("combined stats for both windows", r.status === 200 && r.payload.instances.length === 2 && r.payload.instances[0].session.title === "S", JSON.stringify(r.payload).slice(0, 150));

  r = await call("GET", "/api/stats/all");
  check("stats carry raw main-base numbers",
    r.status === 200 && r.payload.instances[0].sessionRaw.stats.gold_gained === 5000,
    JSON.stringify(r.payload.instances[0].sessionRaw || null).slice(0, 120));
  check("stats carry raw builder-base numbers",
    r.payload.instances[0].sessionRaw.stats.bb_attacks === 7 && r.payload.instances[0].sessionRaw.stats.bb_walls_upgraded === 4);
  check("daily raw is separate from session raw",
    r.payload.instances[0].dailyRaw.stats.bb_attacks === 9 && r.payload.instances[0].dailyRaw.date === "2026-08-21");
  check("alltime raw is aggregated across sessions",
    r.payload.instances[0].alltimeRaw.sessions === 42 && r.payload.instances[0].alltimeRaw.stats.gold_gained === 150000000);

  r = await call("GET", "/api/stats/main/alltime");
  check("alltime stats endpoint returns embed", r.status === 200 && r.payload.embed.title === "A");

  // --- config editing ---
  r = await call("POST", "/api/action", { action: "launch", instanceId: "main" });
  check("launch action reaches the sequencer", r.status === 200 && launchCalls[0] === "main" && /Launching/.test(r.payload.output), JSON.stringify(r.payload));

  r = await call("GET", "/api/config/instance/main");
  check("instance config readable while running",
    r.status === 200 && r.payload.state.running === true && r.payload.config.BUILDER_MAX_ATTACKS === 5,
    JSON.stringify(r.payload).slice(0, 140));
  check("config exposes accounts and runtime-state keys",
    r.payload.accounts.length === 2 && r.payload.runtimeStateKeys.includes("CC_LOOT_CYCLE_START"));

  r = await call("POST", "/api/config/instance/main", { updates: { BUILDER_MAX_ATTACKS: 9 } });
  check("write REFUSED while the bot is running",
    r.status === 409 && Object.keys(cfgStore).length === 0,
    JSON.stringify(r.payload));

  r = await call("POST", "/api/config/revert/main/", {});
  check("revert refused while running", r.status === 409);

  instanceRunning = false;

  r = await call("POST", "/api/config/instance/main", { updates: { BUILDER_MAX_ATTACKS: 9 } });
  check("write allowed once stopped",
    r.status === 200 && cfgStore.BUILDER_MAX_ATTACKS === 9 && r.payload.backup === "config.bak.json",
    JSON.stringify(r.payload));

  r = await call("GET", "/api/config/account/main/accountone");
  check("account config readable", r.status === 200 && r.payload.config.BUILDER_MAX_ATTACKS === 5);

  r = await call("GET", "/api/config/account/main/nosuchaccount");
  check("unknown account is 404", r.status === 404);

  r = await call("GET", "/api/config/instance/nope");
  check("unknown instance is 404", r.status === 404);

  r = await call("POST", "/api/config/revert/main/", {});
  check("revert works once stopped", r.status === 200 && r.payload.restored === "config.bak.json");

  instanceRunning = true;

  r = await call("GET", "/api/discord");
  check("discord status starts stopped", r.status === 200 && r.payload.running === false);

  r = await call("POST", "/api/discord", { action: "start" });
  check("discord start", r.status === 200 && r.payload.status.running === true, JSON.stringify(r.payload));

  r = await call("POST", "/api/discord", { action: "stop" });
  check("discord stop", r.status === 200 && r.payload.status.running === false);

  r = await call("POST", "/api/discord", { action: "nuke" });
  check("unknown discord action rejected", r.status === 400, JSON.stringify(r.payload));

  r = await call("GET", "/api/state");
  check("state carries discord status", r.status === 200 && typeof r.payload.discord.running === "boolean");

  r = await call("GET", "/api/incidents");
  check("incident list", r.status === 200 && r.payload.incidents.length === 2 && r.payload.incidents[0].kind === "recovery", JSON.stringify(r.payload).slice(0, 150));

  r = await call("GET", "/api/incident-image/1700000000000-aabbccdd.jpg");
  check("incident image served", r.status === 200 && r.payload.slice(0, 3).toString("hex") === "ffd8ff", r.status);

  r = await call("GET", "/api/incident-image/..%2f..%2f.env");
  check("incident image name is validated", r.status === 400, r.status);

  r = await call("GET", "/api/incident-image/9999999999999-deadbeef.jpg");
  check("missing incident image is 404", r.status === 404, r.status);

  r = await call("POST", "/api/tap", { instanceId: "main", x: 0.5, y: 0.25 });
  check("tap forwards ratios", r.status === 200 && lastTap.x === 0.5 && lastTap.y === 0.25 && lastTap.instance === "main", JSON.stringify(lastTap));

  r = await call("POST", "/api/tap", { instanceId: "nope", x: 0.5, y: 0.5 });
  check("tap on unknown window rejected", r.status === 404);

  r = await call("GET", "/api/history/main?days=14");
  check("history returns days and sessions", r.status === 200 && r.payload.days.length === 1 && r.payload.sessions.length === 1);

  r = await call("GET", "/api/summary");
  check("daily summary", r.status === 200 && r.payload.dayKey === "2026-08-20");

  r = await call("POST", "/api/push/test");
  check("push test refused while push is off", r.status === 400 && pushSent === 0, JSON.stringify(r.payload));

  pushEnabled = true;
  r = await call("POST", "/api/push/test");
  check("push test sends when enabled", r.status === 200 && pushSent === 1);

  r = await call("GET", "/api/push");
  check("push status", r.status === 200 && r.payload.enabled === true);

  r = await call("GET", "/api/villages/main");
  check("villages returns breakdown", r.status === 200 && r.payload.ok && r.payload.breakdown.currentAccount === "accountone");

  r = await call("GET", "/api/doctor");
  check("doctor returns diagnostic checks", r.status === 200 && r.payload.ok && Array.isArray(r.payload.results));

  r = await call("POST", "/api/logout");
  check("logout ok", r.status === 200);
  r = await call("GET", "/api/state");
  check("session invalid after logout", r.status === 401);

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll smoke checks passed.");
  process.exit(failures ? 1 : 0);
}, 400);
