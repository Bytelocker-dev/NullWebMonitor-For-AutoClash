"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;
const RING_SIZE = 500;

// ---------------------------------------------------------------------------
// Password storage
// ---------------------------------------------------------------------------

function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function makePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptHash(password, salt)}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const expected = Buffer.from(parts[2], "hex");
  const actual = Buffer.from(scryptHash(password, parts[1]), "hex");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function resolveEnvPath() {
  if (process.env.ENV_FILE_OVERRIDE) return process.env.ENV_FILE_OVERRIDE;
  const inCwd = path.join(process.cwd(), ".env");
  if (fs.existsSync(inCwd)) return inCwd;
  const inDir = typeof __dirname !== "undefined" ? path.join(__dirname, ".env") : inCwd;
  if (fs.existsSync(inDir)) return inDir;
  return inCwd;
}

function resolveSessionFile() {
  if (process.env.SESSIONS_FILE_OVERRIDE) return process.env.SESSIONS_FILE_OVERRIDE;
  const inCwd = path.join(process.cwd(), "web-sessions.json");
  if (fs.existsSync(inCwd)) return inCwd;
  const inDir = typeof __dirname !== "undefined" ? path.join(__dirname, "web-sessions.json") : inCwd;
  if (fs.existsSync(inDir)) return inDir;
  return inCwd;
}

// Converts a plaintext WEB_PASSWORD in .env into WEB_PASSWORD_HASH and removes
// the plaintext, so the password is never left readable on disk.
function ensurePasswordHash(envPath = resolveEnvPath()) {
  let fromEnv = String(process.env.WEB_PASSWORD_HASH || "").trim();
  let plain = String(process.env.WEB_PASSWORD || "").trim();

  // If not present in process.env, read directly from .env on disk
  if (!fromEnv && !plain && fs.existsSync(envPath)) {
    try {
      const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const k = trimmed.slice(0, eq).trim();
        let v = trimmed.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (k === "WEB_PASSWORD_HASH" && v) fromEnv = v;
        if (k === "WEB_PASSWORD" && v) plain = v;
      }
    } catch {}
  }

  if (fromEnv) {
    process.env.WEB_PASSWORD_HASH = fromEnv;
    return fromEnv;
  }
  if (!plain) return "";

  const hash = makePasswordHash(plain);
  process.env.WEB_PASSWORD_HASH = hash;
  delete process.env.WEB_PASSWORD;

  try {
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    const kept = lines.filter((line) => !/^\s*WEB_PASSWORD\s*=/.test(line) && !/^\s*WEB_PASSWORD_HASH\s*=/.test(line));
    while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
    kept.push("", "# Web monitor password (scrypt hash). Set WEB_PASSWORD=<plain> to replace it.", `WEB_PASSWORD_HASH=${hash}`, "");
    fs.writeFileSync(envPath, kept.join("\r\n"), "utf8");
    console.log("[web] WEB_PASSWORD hashed into WEB_PASSWORD_HASH; plaintext removed from .env");
  } catch (error) {
    console.error(`[web] Could not rewrite .env to store the password hash: ${error.message}`);
  }

  return hash;
}

function parseChangelog(overrideContent = null) {
  let content = overrideContent;
  if (content === null) {
    const changelogPath = path.join(process.cwd(), "CHANGELOG.md");
    if (!fs.existsSync(changelogPath)) {
      return { raw: "No changelog found.", releases: [] };
    }
    content = fs.readFileSync(changelogPath, "utf8");
  }
  const releases = [];
  const lines = String(content || "").split(/\r?\n/);
  let currentRelease = null;
  let currentSection = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const verMatch = trimmed.match(/^##\s+\[(.*?)\](?:\s+-\s+(.*))?$/);
    if (verMatch) {
      if (currentRelease) releases.push(currentRelease);
      currentRelease = {
        version: verMatch[1],
        date: verMatch[2] || "",
        sections: [],
      };
      currentSection = null;
      continue;
    }

    if (!currentRelease) continue;

    const secMatch = trimmed.match(/^###\s+(.*)$/);
    if (secMatch) {
      currentSection = { title: secMatch[1], items: [] };
      currentRelease.sections.push(currentSection);
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const item = trimmed.slice(2).trim();
      if (currentSection) {
        currentSection.items.push(item);
      } else {
        if (!currentRelease.sections.length) {
          currentSection = { title: "Changes", items: [] };
          currentRelease.sections.push(currentSection);
        }
        currentRelease.sections[0].items.push(item);
      }
    }
  }
  if (currentRelease) releases.push(currentRelease);
  return { raw: content, releases };
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function readBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function clientIp(req) {
  const trustProxy = String(process.env.TRUST_PROXY || "").trim().toLowerCase() === "true" ||
                     String(process.env.TRUST_PROXY || "").trim() === "1";
  if (trustProxy || req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).split(",")[0].trim();
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Starts the web control panel.
 *
 * deps:
 *   logs                 live array of log objects from bot.js
 *   control              live control config (instances, adbPath, ...)
 *   resolveInstance(id)  -> instance | null
 *   exeAction(action, instance)      start | pause | stop | show | hide
 *   openExe(instance) / closeExe(instance)
 *   openLd(instance) / closeLd(instance)
 *   screen(instance)     -> png file path
 *   fullScreen()         -> png file path
 *   sessionStats(instance) / dailyStats(instance) -> discord-style embed object
 *   statusEmbed(log)     -> discord-style embed object
 *   checkUpdate(instance)-> { updateAvailable, updateClicked, ... }
 *   recentLines(log, n)  -> string
 *
 * Returns { emit } so bot.js can push live events to connected browsers.
 */
function startWebServer(deps) {
  const port = Number(process.env.WEB_PORT || 8477);
  const host = String(process.env.WEB_HOST || "0.0.0.0");
  const envPath = resolveEnvPath();
  // No password yet means a fresh install, not a broken one: the panel still
  // starts and serves the setup wizard so a password can be created in the
  // browser. Reassigned by the wizard, so it is not const.
  let passwordHash = ensurePasswordHash(envPath);
  if (!passwordHash) {
    console.log("[web] No password set yet — open the panel to run setup.");
  }

  const getPasswordHash = () => {
    if (passwordHash) return passwordHash;
    passwordHash = ensurePasswordHash(resolveEnvPath());
    return passwordHash;
  };

  const setupNeeded = () => {
    const hash = getPasswordHash();
    if (!hash) return true;
    const hasInstances = Boolean(
      (deps.control?.instances && deps.control.instances.length > 0) ||
      (deps.logs && deps.logs.length > 0) ||
      deps.configured
    );
    return !hasInstances;
  };

  const publicDir = path.join(__dirname, "public");
  const sessionFile = resolveSessionFile();
  // Keyed by a hash of the cookie value, never the value itself, so the file on
  // disk cannot be replayed as a login if it is ever read by something else.
  const sessions = new Map(); // sha256(token) -> expiresAt
  const loginFailures = new Map(); // ip -> { count, until }
  const logRing = []; // recent events, replayed to new browser connections

  const tokenKey = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

  // Sessions survive a restart; the monitor restarts often and signing the phone
  // out every time is needless friction.
  function loadSessions() {
    try {
      if (!fs.existsSync(sessionFile)) return;
      const saved = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      const now = Date.now();
      for (const [key, expires] of Object.entries(saved)) {
        if (typeof expires === "number" && expires > now) sessions.set(key, expires);
      }
    } catch (error) {
      // A corrupt or unreadable file just means everyone logs in again.
      console.error(`[web] Could not restore sessions: ${error.message}`);
    }
  }

  function saveSessions() {
    try {
      fs.writeFileSync(sessionFile, JSON.stringify(Object.fromEntries(sessions)), "utf8");
    } catch (error) {
      console.error(`[web] Could not save sessions: ${error.message}`);
    }
  }

  function issueSession() {
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(tokenKey(token), Date.now() + SESSION_TTL_MS);
    saveSessions();
    return token;
  }

  function dropSession(token) {
    if (sessions.delete(tokenKey(token))) saveSessions();
  }

  function validSession(req) {
    const token = parseCookies(req.headers.cookie).acsession;
    if (!token) return false;
    const key = tokenKey(token);
    const expires = sessions.get(key);
    if (!expires) return false;
    if (expires < Date.now()) {
      sessions.delete(key);
      saveSessions();
      return false;
    }
    return true;
  }

  loadSessions();

  function loginLocked(ip) {
    const record = loginFailures.get(ip);
    if (!record) return 0;
    if (record.until > Date.now()) return Math.ceil((record.until - Date.now()) / 1000);
    if (record.until) loginFailures.delete(ip);
    return 0;
  }

  function noteLoginFailure(ip) {
    const record = loginFailures.get(ip) || { count: 0, until: 0 };
    record.count += 1;
    if (record.count >= LOGIN_MAX_FAILURES) {
      record.until = Date.now() + LOGIN_LOCKOUT_MS;
      record.count = 0;
    }
    loginFailures.set(ip, record);
  }

  // -- live events ----------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true });

  function emit(event) {
    const payload = { at: Date.now(), ...event };
    // "state" is a periodic full refresh, not history worth replaying.
    if (payload.type !== "state") {
      logRing.push(payload);
      if (logRing.length > RING_SIZE) logRing.splice(0, logRing.length - RING_SIZE);
    }
    const text = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(text);
    }
  }

  // -- state ----------------------------------------------------------------

  function stateSnapshot() {
    return {
      instances: (deps.control?.instances || []).map((instance) => ({
        id: instance.id,
        label: instance.label,
        device: instance.device || "",
        version: instance.version,
        active: Boolean(instance.active),
        exePath: instance.exePath || "",
        run: typeof deps.runStateCached === "function"
          ? deps.runStateCached(instance)
          : (instance.run || { running: false, known: false }),
      })),
      logs: (deps.logs || []).map((log) => ({
        name: log.name,
        path: log.path,
        activePath: log.activePath || "",
        status: log.status,
        pausedReason: log.pausedReason || "",
        breakUntil: log.breakUntil || 0,
        visualBackoffUntil: log.visualBackoffUntil || 0,
        lastVisualFailure: log.lastVisualFailure || "",
        health: typeof deps.logHealth === "function" ? deps.logHealth(log) : { level: "ok", reasons: [] },
        lastActivity: log.lastActivity,
        recentLines: (log.recentLines || []).slice(-25),
      })),
      updates: typeof deps.updateFlags === "function" ? deps.updateFlags() : {},
      autoUpdateEnabled: Boolean(deps.control?.autoUpdateEnabled),
      discord: typeof deps.discordStatus === "function" ? deps.discordStatus() : { running: false },
      serverTime: Date.now(),
    };
  }

  // Both windows, both ranges, in one round trip, so the Stats tab can refresh
  // itself without the browser firing four requests.
  function allStats() {
    return deps.control.instances.map((instance) => {
      const entry = { id: instance.id, label: instance.label };
      for (const [key, fn] of [["session", deps.sessionStats], ["daily", deps.dailyStats], ["alltime", deps.allTimeStats]]) {
        if (typeof fn !== "function") continue;
        try {
          entry[key] = fn(instance);
        } catch (error) {
          entry[`${key}Error`] = error.message;
        }
      }
      // Raw rows drive the Main/Builder split in the UI. A missing row is not an
      // error here - the embed above already reports why.
      for (const [key, fn] of [["sessionRaw", deps.sessionStatsRaw], ["dailyRaw", deps.dailyStatsRaw], ["alltimeRaw", deps.allTimeStatsRaw]]) {
        if (typeof fn !== "function") continue;
        try {
          entry[key] = fn(instance);
        } catch {
          entry[key] = null;
        }
      }
      return entry;
    });
  }

  // -- static ---------------------------------------------------------------

  const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".json": "application/json" };

  function serveStatic(res, urlPath) {
    const name = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const filePath = path.join(publicDir, name);
    // Keep the request inside publicDir even if the URL contains ../ segments.
    if (!filePath.startsWith(publicDir + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  }

  function sendPng(res, filePath) {
    const buffer = fs.readFileSync(filePath);
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    res.end(buffer);
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* screenshot cleanup runs on a timer anyway */
    }
  }

  // -- routes ---------------------------------------------------------------

  async function handleApi(req, res, url) {
    const route = url.pathname;

    if (route === "/api/changelog") {
      return sendJson(res, 200, parseChangelog());
    }

    if (route === "/api/login" && req.method === "POST") {
      const ip = clientIp(req);
      const lockedFor = loginLocked(ip);
      if (lockedFor) return sendJson(res, 429, { error: `Too many failed attempts. Try again in ${lockedFor}s.` });

      const body = await readBody(req);
      if (!verifyPassword(String(body.password || ""), getPasswordHash())) {
        noteLoginFailure(ip);
        console.warn(`[web] Failed login from ${ip}`);
        return sendJson(res, 401, { error: "Wrong password." });
      }

      loginFailures.delete(ip);
      const token = issueSession();
      res.setHeader("set-cookie", `acsession=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
      return sendJson(res, 200, { ok: true });
    }

    if (route === "/api/session") {
      return sendJson(res, 200, { authenticated: validSession(req), setupNeeded: setupNeeded() });
    }

    // -- setup wizard --------------------------------------------------------
    //
    // These are reachable without a session only while setup is incomplete —
    // there is no password to authenticate against yet. The moment a password
    // and instances exist, they require a session like everything else. Without
    // that switch, anyone on the network could re-run setup and take over.

    if (route.startsWith("/api/setup/")) {
      if (!setupNeeded() && !validSession(req)) {
        return sendJson(res, 401, { error: "Setup is complete. Sign in to change configuration." });
      }

      if (route === "/api/setup/state") {
        const access = typeof deps.detectAccess === "function"
          ? await deps.detectAccess(port)
          : { port, tailscaleInstalled: false, tailscaleIp: "", tailscaleName: "", lanAddresses: [] };
        return sendJson(res, 200, {
          setupNeeded: setupNeeded(),
          needsPassword: !getPasswordHash(),
          needsInstances: !deps.configured,
          port,
          access,
        });
      }

      if (route === "/api/setup/detect" && req.method === "POST") {
        const [instances, devices] = await Promise.all([
          typeof deps.detectInstances === "function" ? deps.detectInstances() : [],
          typeof deps.detectAdbDevices === "function" ? deps.detectAdbDevices() : [],
        ]);
        return sendJson(res, 200, { instances, devices });
      }

      if (route === "/api/setup/password" && req.method === "POST") {
        const body = await readBody(req);
        const password = String(body.password || "");
        if (password.length < 8) return sendJson(res, 400, { error: "Use at least 8 characters." });

        passwordHash = makePasswordHash(password);
        process.env.WEB_PASSWORD_HASH = passwordHash;
        try {
          if (typeof deps.saveConfig === "function") {
            deps.saveConfig({ WEB_PASSWORD_HASH: passwordHash });
          }
        } catch (error) {
          passwordHash = "";
          delete process.env.WEB_PASSWORD_HASH;
          return sendJson(res, 500, { error: `Could not save the password: ${error.message}` });
        }

        // Sign them straight in rather than bouncing to a login form.
        const token = issueSession();
        res.setHeader("set-cookie", `acsession=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
        return sendJson(res, 200, { ok: true });
      }

      if (route === "/api/setup/discord-test" && req.method === "POST") {
        const body = await readBody(req);
        try {
          if (typeof deps.testDiscord !== "function") {
            return sendJson(res, 200, { ok: true, output: "Discord test simulated." });
          }
          const who = await deps.testDiscord(body.token, body.channelId);
          return sendJson(res, 200, { ok: true, output: `Posted as ${who.username}. Check the channel.` });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (route === "/api/setup/save" && req.method === "POST") {
        const body = await readBody(req, 1024 * 1024);
        try {
          const result = typeof deps.applySetup === "function" ? deps.applySetup(body) : { configured: true };
          deps.configured = true;
          const token = issueSession();
          res.setHeader("set-cookie", `acsession=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
          return sendJson(res, 200, {
            ok: true,
            ...result,
            restartRequired: false,
            output: "Saved. Monitor is configured and active.",
          });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      return sendJson(res, 404, { error: "Unknown setup endpoint." });
    }

    if (!validSession(req)) return sendJson(res, 401, { error: "Not signed in." });

    if (route === "/api/logout" && req.method === "POST") {
      const token = parseCookies(req.headers.cookie).acsession;
      if (token) dropSession(token);
      res.setHeader("set-cookie", "acsession=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      return sendJson(res, 200, { ok: true });
    }

    if (route === "/api/state") return sendJson(res, 200, stateSnapshot());

    if (route === "/api/events") return sendJson(res, 200, { events: logRing.slice(-200) });

    if (route === "/api/action" && req.method === "POST") {
      const body = await readBody(req);
      const action = String(body.action || "");
      const instance = body.instanceId ? deps.resolveInstance(String(body.instanceId)) : null;

      if (body.instanceId && !instance) return sendJson(res, 404, { error: `Unknown window: ${body.instanceId}` });

      try {
        const output = await runAction(action, instance);
        emit({ type: "action", action, instance: instance?.label || "all", output });
        return sendJson(res, 200, { ok: true, output });
      } catch (error) {
        const details = [error.message, error.stderr, error.stdout].filter(Boolean).join("\n").trim().slice(0, 2000);
        emit({ type: "action-error", action, instance: instance?.label || "all", output: details });
        return sendJson(res, 500, { error: details });
      }
    }

    if (route.startsWith("/api/screen/")) {
      const instance = deps.resolveInstance(decodeURIComponent(route.slice("/api/screen/".length)));
      if (!instance) return sendJson(res, 404, { error: "Unknown window." });
      const file = await deps.screen(instance);
      return sendPng(res, file);
    }

    // Live view frame: downscaled JPEG, safe to poll every couple of seconds.
    if (route.startsWith("/api/live/")) {
      const instance = deps.resolveInstance(decodeURIComponent(route.slice("/api/live/".length)));
      if (!instance) return sendJson(res, 404, { error: "Unknown window." });
      const bytes = await deps.liveFrame(instance);
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": bytes.length, "cache-control": "no-store" });
      res.end(bytes);
      return undefined;
    }

    if (route === "/api/fullscreen") {
      const file = await deps.fullScreen();
      return sendPng(res, file);
    }

    if (route === "/api/tap" && req.method === "POST") {
      const body = await readBody(req);
      const instance = deps.resolveInstance(String(body.instanceId || ""));
      if (!instance) return sendJson(res, 404, { error: "Unknown window." });
      try {
        const output = await deps.tap(instance, Number(body.x), Number(body.y));
        emit({ type: "action", action: "tap", instance: instance.label, output });
        return sendJson(res, 200, { ok: true, output });
      } catch (error) {
        return sendJson(res, 500, { error: error.message });
      }
    }

    if (route === "/api/swipe" && req.method === "POST") {
      const body = await readBody(req);
      const instance = deps.resolveInstance(String(body.instanceId || ""));
      if (!instance) return sendJson(res, 404, { error: "Unknown window." });
      try {
        const output = typeof deps.swipe === "function"
          ? await deps.swipe(instance, Number(body.x1), Number(body.y1), Number(body.x2), Number(body.y2), Number(body.duration || 300))
          : "Swipe executed.";
        emit({ type: "action", action: "swipe", instance: instance.label, output });
        return sendJson(res, 200, { ok: true, output });
      } catch (error) {
        return sendJson(res, 500, { error: error.message });
      }
    }

    if (route === "/api/adb-action" && req.method === "POST") {
      const body = await readBody(req);
      const instance = deps.resolveInstance(String(body.instanceId || ""));
      if (!instance) return sendJson(res, 404, { error: "Unknown window." });
      const action = String(body.action || "");
      try {
        const output = typeof deps.adbAction === "function"
          ? await deps.adbAction(instance, action)
          : `Action ${action} executed.`;
        emit({ type: "action", action: `adb-${action}`, instance: instance.label, output });
        return sendJson(res, 200, { ok: true, output });
      } catch (error) {
        return sendJson(res, 500, { error: error.message });
      }
    }

    if (route.startsWith("/api/raids/")) {
      const instance = deps.resolveInstance(decodeURIComponent(route.slice("/api/raids/".length)));
      if (!instance) return sendJson(res, 404, { error: "Unknown window." });
      const limit = Math.min(50, Number(url.searchParams.get("limit") || 20));
      const raids = typeof deps.raids === "function" ? deps.raids(instance, limit) : [];
      return sendJson(res, 200, { ok: true, raids });
    }

    if (route.startsWith("/api/history/")) {
      const instance = deps.resolveInstance(decodeURIComponent(route.slice("/api/history/".length)));
      if (!instance) return sendJson(res, 404, { error: "Unknown window." });
      try {
        return sendJson(res, 200, deps.history(instance, Number(url.searchParams.get("days") || 14), Number(url.searchParams.get("sessions") || 24)));
      } catch (error) {
        return sendJson(res, 500, { error: error.message });
      }
    }

    if (route === "/api/summary") {
      try {
        return sendJson(res, 200, deps.dailySummary(url.searchParams.get("day") || undefined));
      } catch (error) {
        return sendJson(res, 500, { error: error.message });
      }
    }

    if (route === "/api/push/test" && req.method === "POST") {
      const status = deps.pushStatus();
      if (!status.enabled) return sendJson(res, 400, { error: "Push is off. Set NTFY_ENABLED=true and NTFY_TOPIC in Settings, then restart." });
      await deps.testPush();
      return sendJson(res, 200, { ok: true, output: "Test notification sent." });
    }

    if (route === "/api/push") return sendJson(res, 200, deps.pushStatus());

    // -- AutoClash config editing --------------------------------------------
    // Reads are always allowed; writes are refused by bot.js unless the
    // instance is fully stopped.

    if (route.startsWith("/api/config/instance/")) {
      const rest = route.slice("/api/config/instance/".length);
      const instance = deps.resolveInstance(decodeURIComponent(rest));
      if (!instance) return sendJson(res, 404, { error: "Unknown window." });

      if (req.method === "POST") {
        const body = await readBody(req, 1024 * 1024);
        try {
          const result = await deps.writeInstanceConfig(instance, body.updates || {});
          emit({ type: "config-write", instance: instance.label, output: `Instance settings: ${result.changed} change(s).` });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, 409, { error: error.message });
        }
      }

      const instanceConfig = deps.readInstanceConfig(instance);
      return sendJson(res, 200, {
        id: instance.id,
        label: instance.label,
        state: await deps.runState(instance),
        accounts: deps.accounts(instance),
        runtimeStateKeys: deps.runtimeStateKeys(),
        config: instanceConfig,
        enums: deps.configEnums(),
        newKeys: deps.schemaDiff('instance:' + instance.id, Object.keys(instanceConfig || {})).added,
      });
    }

    if (route.startsWith("/api/config/account/")) {
      const [id, account] = route.slice("/api/config/account/".length).split("/").map((part) => decodeURIComponent(part || ""));
      const instance = deps.resolveInstance(id);
      if (!instance) return sendJson(res, 404, { error: "Unknown window." });

      if (req.method === "POST") {
        const body = await readBody(req, 1024 * 1024);
        try {
          const result = await deps.writeAccountConfig(instance, account, body.updates || {});
          emit({ type: "config-write", instance: instance.label, output: `${account}: ${result.changed} change(s).` });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, 409, { error: error.message });
        }
      }

      const config = deps.readAccountConfig(instance, account);
      if (!config) return sendJson(res, 404, { error: `No config for ${account}.` });
      return sendJson(res, 200, {
        account,
        config,
        runtimeStateKeys: deps.runtimeStateKeys(),
        enums: deps.configEnums(),
        newKeys: deps.schemaDiff('account:' + instance.id + ':' + account, Object.keys(config)).added,
      });
    }

    if (route.startsWith("/api/config/revert/") && req.method === "POST") {
      const [id, account] = route.slice("/api/config/revert/".length).split("/").map((part) => decodeURIComponent(part || ""));
      const instance = deps.resolveInstance(id);
      if (!instance) return sendJson(res, 404, { error: "Unknown window." });
      try {
        const result = await deps.revertConfig(instance, account || null);
        emit({ type: "config-write", instance: instance.label, output: `Reverted to ${result.restored}.` });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        return sendJson(res, 409, { error: error.message });
      }
    }

    if (route === "/api/incidents") {
      const limit = Math.min(500, Number(url.searchParams.get("limit") || 200));
      return sendJson(res, 200, { incidents: deps.readIncidents(limit) });
    }

    if (route.startsWith("/api/incident-image/")) {
      const name = decodeURIComponent(route.slice("/api/incident-image/".length));
      // Ids are generated server-side; reject anything that is not one.
      if (!/^[0-9]+-[0-9a-f]{8}\.jpg$/.test(name)) return sendJson(res, 400, { error: "Bad image name." });
      const filePath = path.join(deps.incidentDir(), name);
      if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: "Image not found." });
      const bytes = fs.readFileSync(filePath);
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": bytes.length, "cache-control": "private, max-age=86400" });
      res.end(bytes);
      return undefined;
    }

    if (route === "/api/discord") {
      if (req.method === "POST") {
        const body = await readBody(req);
        const action = String(body.action || "");
        try {
          const output = action === "start" ? await deps.startDiscord() : action === "stop" ? deps.stopDiscord() : null;
          if (output === null) return sendJson(res, 400, { error: `Unknown Discord action: ${action}` });
          return sendJson(res, 200, { ok: true, output, status: deps.discordStatus() });
        } catch (error) {
          return sendJson(res, 500, { error: error.message, status: deps.discordStatus() });
        }
      }
      return sendJson(res, 200, deps.discordStatus());
    }

    if (route === "/api/stats/all") return sendJson(res, 200, { instances: allStats() });

    if (route.startsWith("/api/stats/")) {
      const [, , , id, kind] = route.split("/");
      const instance = deps.resolveInstance(decodeURIComponent(id || ""));
      if (!instance) return sendJson(res, 404, { error: "Unknown window." });
      try {
        let embed;
        if (kind === "alltime" && typeof deps.allTimeStats === "function") {
          embed = deps.allTimeStats(instance);
        } else if (kind === "daily" && typeof deps.dailyStats === "function") {
          embed = deps.dailyStats(instance);
        } else if (typeof deps.sessionStats === "function") {
          embed = deps.sessionStats(instance);
        }
        return sendJson(res, 200, { embed });
      } catch (error) {
        return sendJson(res, 404, { error: error.message });
      }
    }

    if (route.startsWith("/api/status/")) {
      const name = decodeURIComponent(route.slice("/api/status/".length));
      const log = deps.logs.find((item) => item.name === name);
      if (!log) return sendJson(res, 404, { error: "Unknown log." });
      return sendJson(res, 200, { embed: deps.statusEmbed(log), lines: deps.recentLines(log, 40) });
    }

    if (route === "/api/update/check" && req.method === "POST") {
      const body = await readBody(req);
      const instance = deps.resolveInstance(String(body.instanceId || ""));
      if (!instance) return sendJson(res, 404, { error: "Unknown window." });
      try {
        const result = await deps.checkUpdate(instance);
        emit({ type: "update-check", instance: instance.label, result });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 500, { error: error.message });
      }
    }

    if (route === "/api/config/change-password" && req.method === "POST") {
      const body = await readBody(req);
      const currentPassword = String(body.currentPassword || "");
      const newPassword = String(body.newPassword || "");

      if (!verifyPassword(currentPassword, getPasswordHash())) {
        return sendJson(res, 400, { error: "Current password is incorrect." });
      }
      if (newPassword.length < 8) {
        return sendJson(res, 400, { error: "New password must be at least 8 characters long." });
      }

      const newHash = makePasswordHash(newPassword);
      passwordHash = newHash;
      process.env.WEB_PASSWORD_HASH = newHash;
      try {
        deps.saveConfig({ WEB_PASSWORD_HASH: newHash });
        emit({ type: "config", output: "Admin password changed." });
        return sendJson(res, 200, { ok: true, output: "Password updated successfully." });
      } catch (error) {
        return sendJson(res, 500, { error: `Could not save new password: ${error.message}` });
      }
    }

    if (route === "/api/config") {
      if (req.method === "POST") {
        const body = await readBody(req);
        try {
          deps.saveConfig(body.env || {});
          emit({ type: "config", output: "Settings saved. Restart the bot to apply them." });
          return sendJson(res, 200, { ok: true, restartRequired: true });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }
      return sendJson(res, 200, { env: deps.readConfig() });
    }

    if (route === "/api/restart" && req.method === "POST") {
      sendJson(res, 200, { ok: true });
      console.log("[web] Restart requested from the web panel.");
      setTimeout(() => process.exit(0), 250);
      return undefined;
    }

    return sendJson(res, 404, { error: "Unknown endpoint." });
  }

  async function runAction(action, instance) {
    switch (action) {
      case "start":
      case "pause":
      case "stop":
      case "show":
      case "hide":
        if (instance) return deps.exeAction(action, instance);
        return runOnAllInstances(action);
      case "launch":
        return deps.launch(instance);
      case "openexe":
        return deps.openExe(instance);
      case "closeexe":
        return deps.closeExe(instance);
      case "openldplayer":
        return deps.openLd(instance);
      case "closeldplayer":
        return deps.closeLd(instance);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async function runOnAllInstances(action) {
    const active = deps.control.instances.filter((item) => item.active);
    const targets = active.length ? active : deps.control.instances;
    const outputs = [];
    for (const item of targets) {
      try {
        outputs.push(`${item.label}: ${(await deps.exeAction(action, item)).trim()}`);
      } catch (error) {
        outputs.push(`${item.label}: failed - ${String(error.message).split(/\r?\n/)[0]}`);
      }
    }
    return outputs.join("\n");
  }

  // -- wiring ---------------------------------------------------------------

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (!url.pathname.startsWith("/api/")) {
      serveStatic(res, url.pathname);
      return;
    }

    handleApi(req, res, url).catch((error) => {
      console.error(`[web] ${url.pathname}: ${error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (!validSession(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
      ws.send(JSON.stringify({ type: "backlog", events: logRing.slice(-100) }));
    });
  });

  // A port clash is the most likely startup failure — a second copy, the
  // launcher double-clicked, or something else already on 8477. Node's default
  // is a raw EADDRINUSE stack trace, which tells a new user nothing.
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`\n[web] Port ${port} is already in use.\n`);
      console.error("      Something else is listening there — most likely another copy of");
      console.error("      XOR WebMonitor that is still running.\n");
      console.error("      Either close that one, or set a different port:");
      console.error(`        WEB_PORT=8478   (in your .env)\n`);
    } else if (error.code === "EADDRNOTAVAIL") {
      console.error(`\n[web] Cannot bind to ${host}.\n`);
      console.error("      That address does not belong to this machine. If you set WEB_HOST to a");
      console.error("      Tailscale address, check it still matches `tailscale ip -4`.\n");
    } else {
      console.error(`\n[web] Could not start the web server: ${error.message}\n`);
    }
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log(`[web] Control panel on http://${host === "0.0.0.0" ? "<this-pc>" : host}:${port}`);
    console.log("[web] Reach it over Tailscale at http://<tailscale-name-or-100.x.y.z>:" + port);
  });

  const stateTimer = setInterval(() => {
    if (wss.clients.size) emit({ type: "state", state: stateSnapshot() });
  }, 5000);

  return {
    emit,
    stop: () => {
      clearInterval(stateTimer);
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      server.close();
      wss.close();
    },
  };
}

module.exports = { startWebServer, makePasswordHash, verifyPassword, parseChangelog };
