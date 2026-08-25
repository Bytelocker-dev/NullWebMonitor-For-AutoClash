const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const WebSocketClient = globalThis.WebSocket || require("ws");

const STATE_FILE = path.join(process.cwd(), "bot-state.json");
const SCREENSHOT_DIR = path.join(process.cwd(), "control-screenshots");
const selectedAutoControlInstances = new Map();
const restartLogsByKey = new Map();
let autoClashUpdateOperation = null;
let autoClashUpdateBlockedBy = null;

function resolveScriptPath(scriptName) {
  const inDir = path.join(__dirname, scriptName);
  if (fs.existsSync(inDir)) return inDir;
  const inCwd = path.join(process.cwd(), scriptName);
  if (fs.existsSync(inCwd)) return inCwd;
  return inDir;
}

// Web control panel. webEmit stays a no-op until the panel starts, so the bot
// runs unchanged when WEB_ENABLED is off.
const { startWebServer } = require("./web-server");
const autoClashUpdateStatus = new Map();
let webEmit = () => {};

// Discord is toggleable at runtime from the web panel's Discord tab. Every
// Discord call routes through this object, so flipping `enabled` is enough to
// silence the bot without restarting the monitor.
const discordRuntime = {
  enabled: false,
  configured: false,
  token: "",
  channelId: "",
  gateway: null,
  startedAt: 0,
  lastError: "",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withAutoClashUpdateLock(label, waitForTurn, task) {
  while (autoClashUpdateOperation) {
    if (!waitForTurn) return { busy: true, owner: autoClashUpdateOperation.label };
    await autoClashUpdateOperation.promise.catch(() => {});
  }

  let release;
  const operation = {
    label,
    promise: new Promise((resolve) => {
      release = resolve;
    }),
  };
  autoClashUpdateOperation = operation;

  try {
    return await task();
  } finally {
    if (autoClashUpdateOperation === operation) autoClashUpdateOperation = null;
    release();
  }
}

function parseNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function listFilesRecursive(directory) {
  if (!fs.existsSync(directory)) return [];

  const files = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function removeEmptyDirectories(directory) {
  if (!fs.existsSync(directory)) return;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      removeEmptyDirectories(path.join(directory, entry.name));
    }
  }

  if (directory !== SCREENSHOT_DIR && fs.existsSync(directory) && fs.readdirSync(directory).length === 0) {
    fs.rmdirSync(directory);
  }
}

function deleteFileQuietly(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Cleanup should never stop the bot.
  }
}

function requireReadableFile(filePath, label = "file") {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} was not created: ${filePath || "empty path"}`);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`${label} is empty or not a file: ${filePath}`);
  }
}

function cleanupScreenshots(options = {}) {
  const maxAgeHours = options.maxAgeHours || parseNumberEnv("SCREENSHOT_RETENTION_HOURS", 24);
  const maxBytes = Math.floor((options.maxSizeMb || parseNumberEnv("SCREENSHOT_MAX_SIZE_MB", 1500)) * 1024 * 1024);
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;

  let fileStats = listFilesRecursive(SCREENSHOT_DIR)
    .map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  for (const file of fileStats) {
    if (file.mtimeMs < cutoff) {
      deleteFileQuietly(file.filePath);
    }
  }

  fileStats = listFilesRecursive(SCREENSHOT_DIR)
    .map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let totalBytes = fileStats.reduce((sum, file) => sum + file.size, 0);
  for (const file of fileStats) {
    if (totalBytes <= maxBytes) break;
    deleteFileQuietly(file.filePath);
    totalBytes -= file.size;
  }

  try {
    removeEmptyDirectories(SCREENSHOT_DIR);
  } catch {
    // Empty directory cleanup is best-effort.
  }
}

function isRetryableDiscordStatus(status) {
  return status === 429 || status >= 500;
}

async function fetchDiscordWithRetry(url, options, label) {
  const delays = [1200, 3500, 8000];
  let lastText = "";
  let lastStatus = 0;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const response = await fetch(url, options);
    lastStatus = response.status;
    lastText = await response.text();

    if (response.ok) {
      return { response, text: lastText };
    }

    if (!isRetryableDiscordStatus(response.status) || attempt === delays.length) {
      break;
    }

    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delays[attempt];
    console.error(`[discord] ${label} returned ${response.status}. Retrying in ${Math.round(waitMs / 1000)}s.`);
    await sleep(waitMs);
  }

  throw new Error(`Discord responded with ${lastStatus}: ${lastText}`);
}

function parseDiscordJson(text) {
  return text ? JSON.parse(text) : null;
}

function resolveEnvPath() {
  if (process.env.ENV_FILE_OVERRIDE) return process.env.ENV_FILE_OVERRIDE;
  const inCwd = path.join(process.cwd(), ".env");
  if (fs.existsSync(inCwd)) return inCwd;
  const inDir = typeof __dirname !== "undefined" ? path.join(__dirname, ".env") : inCwd;
  if (fs.existsSync(inDir)) return inDir;
  return inCwd;
}

function loadEnv() {
  const envPath = resolveEnvPath();
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawVal = trimmed.slice(equalsIndex + 1).trim();
    let val = rawVal;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    }
    if (key) {
      process.env[key] = val;
    }
  }
}

// Reads .env as a plain key/value map, for the web settings page.
function readEnvFile() {
  const envPath = resolveEnvPath();
  if (!fs.existsSync(envPath)) return {};

  const values = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const rawVal = trimmed.slice(equalsIndex + 1).trim();
    let val = rawVal;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    }
    values[key] = val;
  }
  return values;
}

// Merges edits into .env, keeping every key the web page did not send. Secrets
// are never overwritten with an empty value, so a blanked-out field in the UI
// cannot wipe the Discord token or the password hash.
function writeEnvFile(updates) {
  const envPath = resolveEnvPath();
  const merged = readEnvFile();

  for (const [key, rawValue] of Object.entries(updates || {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid setting name: ${key}`);
    const value = String(rawValue ?? "");
    if (!value.trim() && (key === "DISCORD_TOKEN" || key.startsWith("WEB_PASSWORD"))) continue;
    merged[key] = value;
  }

  const body = Object.entries(merged)
    .map(([key, value]) => {
      const str = String(value ?? "");
      const formatted = (/[\s#"']/.test(str) || str.includes("=") || str.includes("\n"))
        ? `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
        : str;
      return `${key}=${formatted}`;
    })
    .join("\r\n");
  fs.writeFileSync(envPath, `${body}\r\n`, "utf8");
}

function requiredEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing ${name} in the .env file`);
  }
  return value;
}

function parseLogFiles(rawValue) {
  const rawLogs = [];

  rawValue.split(";").forEach((item, index) => {
    const trimmed = item.trim();
    if (!trimmed) return;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex >= 0) {
      const name = trimmed.slice(0, equalsIndex).trim() || `log-${index + 1}`;
      const logPath = trimmed.slice(equalsIndex + 1).trim().replace(/^"|"$/g, "");
      rawLogs.push({ name, path: logPath });
      return;
    }

    const logPath = trimmed.replace(/^"|"$/g, "");
    rawLogs.push({ name: path.basename(logPath, path.extname(logPath)) || `log-${index + 1}`, path: logPath });
  });

  const seenPaths = new Set();
  const logs = [];
  for (const item of rawLogs) {
    const norm = path.resolve(item.path).toLowerCase();
    if (!seenPaths.has(norm)) {
      seenPaths.add(norm);
      logs.push(item);
    }
  }

  if (logs.length === 0) {
    throw new Error("LOG_FILES does not have any configured log files");
  }

  return logs.map((log, index) => ({
    ...log,
    index,
    channelId: null,
    channelBaseName: null,
    lastChannelName: null,
    activePath: null,
    position: 0,
    recentLines: [],
    livePendingLines: [],
    liveThreadId: null,
    liveThreadMessageCount: 0,
    statusMessageId: null,
    statusPinnedMessageId: null,
    alertMessageId: null,
    status: "starting",
    lastActivity: Date.now(),
    alertedStalled: false,
    restartHandled: false,
    sleepingNotified: false,
    pausedReason: null,
    goldBelowThresholdCount: 0,
    deviceOfflineReconnectCount: 0,
    lastGoldRestartAt: 0,
    lastAdbRecoveryAt: 0,
    lastVisualCheckAt: 0,
    lastVisualRecoveryAt: 0,
    breakUntil: 0,
    lastStuckCheckAt: 0,
    lastAutoUpdateCheckAt: 0,
    lastAutoUpdateHandledAt: 0,
    existedBefore: undefined,
  }));
}

function envKeyForLog(logName, suffix) {
  return `${logName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

function defaultChannelName(logName) {
  return logName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "log";
}

function optionalChannelId(name) {
  const value = (process.env[name] || "").trim();
  return /^\d{15,25}$/.test(value) ? value : null;
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (error) {
    console.error(`Could not read ${STATE_FILE}: ${error.message}`);
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function stateKey(log) {
  return `${log.name}:${log.channelId}`;
}

function applySavedState(log, state) {
  const saved = state[stateKey(log)];
  if (!saved) return;

  log.statusMessageId = saved.statusMessageId || null;
  log.statusPinnedMessageId = saved.statusPinnedMessageId || null;
  log.alertMessageId = saved.alertMessageId || null;
  log.liveThreadId = saved.liveThreadId || null;
  log.liveThreadMessageCount = Number(saved.liveThreadMessageCount || 0);
}

function rememberLogState(log, state) {
  state[stateKey(log)] = {
    statusMessageId: log.statusMessageId,
    statusPinnedMessageId: log.statusPinnedMessageId,
    alertMessageId: log.alertMessageId,
    liveThreadId: log.liveThreadId,
    liveThreadMessageCount: log.liveThreadMessageCount || 0,
  };
  saveState(state);
}

function hasWildcard(value) {
  return value.includes("*") || value.includes("?");
}

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

function findNewestMatchingFile(logPath) {
  const normalized = logPath.replace(/^"|"$/g, "");

  if (hasWildcard(normalized)) {
    const directory = path.dirname(normalized);
    const filePattern = wildcardToRegExp(path.basename(normalized));
    return findNewestFileInDirectory(directory, filePattern);
  }

  if (!fs.existsSync(normalized)) return null;

  const stats = fs.statSync(normalized);
  if (stats.isDirectory()) {
    return findNewestFileInDirectory(normalized, /\.txt$/i);
  }

  return normalized;
}

function findNewestFileInDirectory(directory, filePattern) {
  if (!fs.existsSync(directory)) return null;

  const candidates = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && filePattern.test(entry.name))
    .map((entry) => {
      const fullPath = path.join(directory, entry.name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates.length > 0 ? candidates[0].fullPath : null;
}

async function sendDiscordMessage(token, channelId, content, allowedMentions = undefined) {
  const { text } = await fetchDiscordWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content, allowed_mentions: allowedMentions }),
  }, "send message");

  return parseDiscordJson(text);
}

async function sendDiscordPayload(token, channelId, payload) {
  const { text } = await fetchDiscordWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }, "send payload");

  return parseDiscordJson(text);
}

async function createDiscordThread(token, channelId, name) {
  return discordRequest(token, `/channels/${channelId}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      type: 11,
      auto_archive_duration: 1440,
    }),
  });
}

async function editDiscordPayload(token, channelId, messageId, payload) {
  const { text } = await fetchDiscordWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }, "edit payload");

  return parseDiscordJson(text);
}

async function deleteDiscordMessage(token, channelId, messageId) {
  try {
    await fetchDiscordWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bot ${token}`,
      },
    }, "delete message");
  } catch (error) {
    if (!String(error.message).includes("Discord responded with 404")) {
      throw error;
    }
  }
}

async function pinDiscordMessage(token, channelId, messageId) {
  await discordRequest(token, `/channels/${channelId}/pins/${messageId}`, {
    method: "PUT",
  });
}

async function deleteDiscordChannel(token, channelId) {
  await discordRequest(token, `/channels/${channelId}`, {
    method: "DELETE",
  });
}

async function sendDiscordFile(token, channelId, content, filePath, options = {}) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content }));
  requireReadableFile(filePath, "Discord upload file");
  const bytes = fs.readFileSync(filePath);
  form.append("file", new Blob([bytes], { type: "image/png" }), path.basename(filePath));

  try {
    const { text } = await fetchDiscordWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
      },
      body: form,
    }, "send file");

    return parseDiscordJson(text);
  } finally {
    if (options.deleteAfterSend) deleteFileQuietly(filePath);
  }
}

async function discordRequest(token, route, options = {}) {
  const { text } = await fetchDiscordWithRetry(`https://discord.com/api/v10${route}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      // Discord rejects a JSON body without this; callers that pass a raw
      // string body would otherwise get a 50035 CONTENT_TYPE_INVALID.
      ...(typeof options.body === "string" ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  }, route);

  return parseDiscordJson(text);
}

async function discordSelfId(token) {
  const me = await discordRequest(token, "/users/@me");
  return me.id;
}

// Clears the bot's own leftovers from a channel before it posts fresh ones, so
// restarts do not stack duplicate panels and status embeds.
//
// Only messages authored by this bot are touched - messages from you or anyone
// else are never deleted. Deletion is permanent.
async function purgeOwnMessages(token, channelId, botId, limit = 100) {
  if (!channelId || !botId) return 0;

  let messages;
  try {
    messages = await discordRequest(token, `/channels/${channelId}/messages?limit=${Math.min(100, limit)}`);
  } catch (error) {
    console.error(`[clean] Could not read channel ${channelId}: ${error.message}`);
    return 0;
  }
  if (!Array.isArray(messages)) return 0;

  const mine = messages.filter((message) => message.author?.id === botId);
  if (!mine.length) return 0;

  // Bulk delete only accepts messages under 14 days old.
  const cutoff = Date.now() - 13.5 * 24 * 60 * 60 * 1000;
  const fresh = mine.filter((message) => new Date(message.timestamp).getTime() > cutoff);
  const old = mine.filter((message) => new Date(message.timestamp).getTime() <= cutoff);
  let removed = 0;

  if (fresh.length > 1) {
    try {
      await discordRequest(token, `/channels/${channelId}/messages/bulk-delete`, {
        method: "POST",
        body: JSON.stringify({ messages: fresh.map((message) => message.id) }),
      });
      removed += fresh.length;
    } catch (error) {
      console.error(`[clean] Bulk delete failed, falling back one by one: ${error.message}`);
      old.push(...fresh);
    }
  } else {
    old.push(...fresh);
  }

  for (const message of old) {
    try {
      await deleteDiscordMessage(token, channelId, message.id);
      removed += 1;
      await sleep(350); // stay inside the per-channel delete rate limit
    } catch (error) {
      if (!isUnknownDiscordChannelError(error)) {
        console.error(`[clean] Could not delete ${message.id}: ${error.message}`);
      }
    }
  }

  return removed;
}

async function renameDiscordChannel(token, channelId, name) {
  const { text } = await fetchDiscordWithRetry(`https://discord.com/api/v10/channels/${channelId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  }, "rename channel");

  return parseDiscordJson(text);
}

// Discord slugifies channel names itself — spaces become dashes, capitals are
// lowered — so compare against the slug. Comparing against the raw typed name
// would look like a change every start and burn the two-renames-per-10-minutes
// budget for nothing.
async function renamePanelChannel(control) {
  const wanted = defaultChannelName(control.channelName || "");
  if (!wanted || !control.channelId) return;

  try {
    const channel = await discordRequest(control.token, `/channels/${control.channelId}`);
    if (channel && channel.name === wanted) return;

    await renameDiscordChannel(control.token, control.channelId, wanted);
    console.log(`Control panel channel renamed to #${wanted}.`);
  } catch (error) {
    // Renaming needs Manage Channels. Without it the panel still works, so
    // this is a note rather than a failure.
    console.error(`[control] Could not rename the panel channel: ${error.message}`);
  }
}

// Discord allows two channel renames per ten minutes per channel. A bot that
// flaps between running and paused burns that in seconds, and the 429 that
// follows carries a retry-after measured in minutes, which used to stall the
// caller. Track the last rename per channel and simply skip until the window
// reopens — the next status change applies whatever the state is by then.
const RENAME_MIN_INTERVAL_MS = 5 * 60 * 1000;
const channelRenameHistory = new Map(); // channelId -> { lastAt, applied }

async function updateChannelName(log, config) {
  // Never rename the shared control panel channel to an instance's name
  const controlId = (config && (config.controlChannelId || config.channelId)) || (typeof control !== "undefined" ? control?.channelId : null);
  if (controlId && log.channelId === controlId) return;

  const isBreak = log.status === "paused" && (String(log.pausedReason || "").includes("humanized") || Boolean(log.breakUntil && Date.now() < log.breakUntil));
  const emoji =
    log.status === "stalled"
      ? "\u{1F534}"
      : isBreak
        ? "\u{1F7E0}"
        : log.status === "paused"
          ? "\u{1F7E1}"
          : log.status === "finished"
            ? "\u{26AA}"
            : "\u{1F7E2}";
  const nextName = `${emoji}-${log.channelBaseName}`;

  if (log.lastChannelName === nextName) return;

  const history = channelRenameHistory.get(log.channelId);
  const now = Date.now();
  if (history && now - history.lastAt < RENAME_MIN_INTERVAL_MS) return;

  try {
    await config.renameChannel(log.channelId, nextName);
    channelRenameHistory.set(log.channelId, { lastAt: now, applied: nextName });
    log.lastChannelName = nextName;
  } catch (err) {
    if (!isUnknownDiscordChannelError(err)) {
      console.warn(`[${log.name}] Discord channel rename warning: ${err.message}`);
    }
  }
}

async function deleteAlertMessage(log, config) {
  if (!log.alertMessageId) return;

  try {
    await config.deleteMessage(log.channelId, log.alertMessageId);
  } catch (error) {
    console.error(`[${log.name}] Could not delete the previous alert: ${error.message}`);
  } finally {
    log.alertMessageId = null;
    rememberLogState(log, config.state);
  }
}

function initializeLog(log) {
  log.lastActivity = Date.now();
  log.activePath = findNewestMatchingFile(log.path);

  if (log.activePath) {
    log.position = fs.statSync(log.activePath).size;
    log.existedBefore = true;
  } else {
    log.position = 0;
    log.existedBefore = false;
  }

  // A restart in the middle of a break would otherwise look like a stall, so
  // recover the break from the log file rather than waiting for a new line.
  const onBreak = scanLogTailForBreak(log.activePath);
  if (onBreak) {
    log.breakUntil = onBreak.endsAt;
    log.pausedReason = "humanized-break";
    log.status = "paused";
    log.restartHandled = true;
    console.log(`[${log.name}] Resumed a humanized break in progress, ends ${new Date(onBreak.endsAt).toLocaleTimeString()}.`);
  }
}

function readNewLines(log, currentSize, maxLinesPerCheck) {
  const bytesToRead = currentSize - log.position;
  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(log.activePath, "r");

  try {
    fs.readSync(fd, buffer, 0, bytesToRead, log.position);
  } finally {
    fs.closeSync(fd);
  }

  const lines = buffer
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  // maxLinesPerCheck exists to keep Discord status embeds short, but dropping
  // lines here loses them from the live log too - which bites exactly when a
  // break ends and Clash relaunches with a burst of output. Keep everything,
  // with a ceiling so a rotated or truncated file cannot blow up memory.
  // ponytail: 2000 is a sanity bound, not a tuning knob.
  return lines.slice(-Math.max(maxLinesPerCheck, 2000));
}

function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function lineContains(lines, pattern) {
  return lines.some((line) => pattern.test(line));
}

function analyzeLogLines(lines) {
  if (lineContains(lines, /bot end condition met,\s*stopping bot/i)) {
    return "completed";
  }

  if (lineContains(lines, /outside active hours,\s*sleeping bot until start time/i)) {
    return "sleeping";
  }

  if (lineContains(lines, /humanized break started/i)) {
    return "humanized-break";
  }

  if (
    lineContains(lines, /\[LOG\]\s*Session log ended/i) ||
    lineContains(lines, /Session log ended/i) ||
    lineContains(lines, /\b(bot\s+)?stopped\b/i)
  ) {
    return "ended";
  }

  return null;
}

// "Humanized break started: 38 minute(s) - closing Clash" -> 38.
// The bot closes Clash during a break, so no further lines arrive; without the
// stated duration the log would look stalled a few minutes in.
function parseBreakMinutes(lines) {
  for (const line of lines) {
    const s = String(line);
    let match = s.match(/(?:humanized\s+)?break\s*(?:started|start|scheduled)?\s*[:\-]?\s*(\d+)\s*min/i);
    if (match) return Number(match[1]);
    match = s.match(/taking\s+(?:a\s+)?(?:humanized\s+)?break\s+(?:for\s+)?(\d+)\s*min/i);
    if (match) return Number(match[1]);
    match = s.match(/\[BREAK\]\s*(\d+)\s*min/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function isOnBreak(log) {
  return Boolean(log.breakUntil && Date.now() < log.breakUntil);
}

function breakSecondsLeft(log) {
  return isOnBreak(log) ? Math.max(0, Math.round((log.breakUntil - Date.now()) / 1000)) : 0;
}

// Reads the tail of the active log file to work out whether a break is running
// right now. The announcing line carries both a clock time and a duration
// ("03:21:54 | Humanized break started: 38 minute(s)"), so the exact end time
// can be reconstructed - which also survives a restart in the middle of a break.
function scanLogTailForBreak(logFilePath, now = new Date()) {
  if (!logFilePath || !fs.existsSync(logFilePath)) return null;

  let text;
  try {
    const size = fs.statSync(logFilePath).size;
    const readBytes = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(readBytes);
    const fd = fs.openSync(logFilePath, "r");
    try {
      fs.readSync(fd, buffer, 0, readBytes, size - readBytes);
    } finally {
      fs.closeSync(fd);
    }
    text = buffer.toString("utf8");
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  let breakIndex = -1;
  let minutes = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = parseBreakMinutes([lines[i]]);
    if (found) {
      breakIndex = i;
      minutes = found;
      break;
    }
  }
  if (breakIndex === -1) return null;

  const after = lines.slice(breakIndex + 1);

  // AutoClash writes "Humanized break ended, relaunching Clash" when it resumes.
  if (after.some((line) => /humanized break ended/i.test(line))) return null;

  // AutoClash log lines carry no clock, so the break start is taken from the
  // file's last-modified time - which is exactly when that line was written,
  // because closing Clash stops all further output. Only trust it while the
  // break line really is the end of the file.
  const startedAt = lineClockToDate(lines[breakIndex], now) || (after.length <= 2 ? new Date(fs.statSync(logFilePath).mtimeMs) : null);
  if (!startedAt) return null;

  const endsAt = new Date(startedAt.getTime() + minutes * 60 * 1000);
  if (now.getTime() >= endsAt.getTime()) return null;
  return { startedAt: startedAt.getTime(), endsAt: endsAt.getTime(), minutes };
}

// "03:21:54 PM | ..." or "01:13:12 AM" -> a Date today. If that lands in the future the line must
// belong to yesterday, so step back a day.
function lineClockToDate(line, now = new Date()) {
  const match = String(line).match(/(\d{1,2}):(\d{2}):(\d{2})(?:\s*(AM|PM))?/i);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const meridiem = match[4] ? match[4].toUpperCase() : null;

  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;

  const date = new Date(now);
  date.setHours(hours, minutes, seconds, 0);
  if (date.getTime() > now.getTime() + 60 * 1000) date.setDate(date.getDate() - 1);
  return date;
}

// ---------------------------------------------------------------------------
// Log line classifier. Patterns are taken from real AutoClash output, ordered
// most specific first. "noise" lines are counted but never alerted on: things
// like "Weekly Store not found" fire hundreds of times in a normal run.
// ---------------------------------------------------------------------------

const LOG_PATTERNS = [
  // Hard device and capture faults - the run cannot make progress.
  { re: /\[ADB ERROR\]\s*device .*not found/i, kind: "device-error", severity: "error" },
  { re: /\[ADB ERROR\].*device offline/i, kind: "device-error", severity: "error" },
  { re: /device offline\s*-\s*waiting for reconnect/i, kind: "device-error", severity: "error" },
  { re: /device connection failed/i, kind: "device-error", severity: "error" },
  { re: /no usable screenshot after \d+ attempts/i, kind: "capture-error", severity: "error" },
  { re: /exec-out (screencap timed out|failed),\s*using fallback/i, kind: "capture-error", severity: "warn" },

  // The bot noticing it is stuck and doing something about it.
  { re: /stuck searching,\s*triggering recovery/i, kind: "stuck", severity: "warn" },
  { re: /main loop reset not consumed,\s*restarting bot worker/i, kind: "restart", severity: "warn" },
  { re: /\[WATCHDOG\].*timeout/i, kind: "watchdog", severity: "warn" },

  // Failures that abort a cycle.
  { re: /cycle failed,\s*exiting/i, kind: "failure", severity: "warn" },
  { re: /army setup failed/i, kind: "failure", severity: "warn" },
  { re: /battle failed after retry/i, kind: "failure", severity: "warn" },
  { re: /\[CLAN GAME\]\s*unable to start/i, kind: "failure", severity: "noise" },

  // Self-healing.
  { re: /\[RECOVERY\]\s*relaunched/i, kind: "recovery", severity: "info" },
  { re: /triggering recovery/i, kind: "recovery", severity: "info" },
  { re: /recovering and resuming/i, kind: "recovery", severity: "info" },
  { re: /hard popup handled/i, kind: "recovery", severity: "info" },
  { re: /attempting return to home after failure/i, kind: "recovery", severity: "info" },
  { re: /\[ERROR\]\s*dismissed popup/i, kind: "recovery", severity: "info" },

  // Scheduling.
  { re: /humanized break started/i, kind: "break-start", severity: "info" },
  { re: /humanized break ended/i, kind: "break-end", severity: "info" },

  // Frequent and harmless - counted so trends are visible, never alerted.
  { re: /not found/i, kind: "not-found", severity: "noise" },
  { re: /closing clash of clans/i, kind: "clash-closed", severity: "noise" },
];

function classifyLogLine(line) {
  for (const pattern of LOG_PATTERNS) {
    if (pattern.re.test(line)) return { kind: pattern.kind, severity: pattern.severity, line: String(line).trim() };
  }
  return null;
}

function classifyLogLines(lines) {
  return lines.map(classifyLogLine).filter(Boolean);
}

// Rolling per-log health counters, so the panel can show "3 recoveries and 1
// device error in the last hour" instead of just a green or red dot.
function recordLogHealth(log, events) {
  if (!log.health) log.health = { counts: {}, recent: [], since: Date.now() };

  const now = Date.now();
  for (const event of events) {
    log.health.counts[event.kind] = (log.health.counts[event.kind] || 0) + 1;
    if (event.severity !== "noise") {
      log.health.recent.push({ at: now, ...event });
    }
  }

  const oneHourAgo = now - 60 * 60 * 1000;
  log.health.recent = log.health.recent.filter((entry) => entry.at >= oneHourAgo).slice(-60);
  return log.health;
}

function logHealthSummary(log) {
  const recent = log.health?.recent || [];
  return {
    counts: log.health?.counts || {},
    since: log.health?.since || Date.now(),
    lastHour: {
      errors: recent.filter((entry) => entry.severity === "error").length,
      warnings: recent.filter((entry) => entry.severity === "warn").length,
      recoveries: recent.filter((entry) => entry.kind === "recovery").length,
    },
    recent: recent.slice(-15).reverse(),
  };
}

function recentPauseReason(log) {
  // A break in progress outlives the recent-lines window it was announced in.
  if (isOnBreak(log)) return "humanized-break";
  const recent = log.recentLines.slice(-12);
  return analyzeLogLines(recent);
}

function findControlInstanceForLog(log, config) {
  const control = config.control;
  if (!control?.instances?.length) return null;

  const logKeys = [
    normalizeKey(log.name),
    normalizeKey(log.channelBaseName),
    normalizeKey(path.basename(log.path || "")),
  ].filter(Boolean);

  return (
    control.instances.find((instance) => {
      const instanceKeys = [
        normalizeKey(instance.id),
        normalizeKey(instance.label),
        normalizeKey(instance.exePath),
        normalizeKey(resolveAutoClashExePath(instance)),
      ].filter(Boolean);
      return logKeys.some((logKey) => instanceKeys.some((instanceKey) => instanceKey === logKey || instanceKey.includes(logKey)));
    }) ||
    control.instances[log.index] ||
    (control.instances.length === 1 ? control.instances[0] : null)
  );
}

function findLogForControlInstance(instance, logs, config) {
  return logs.find((log) => findControlInstanceForLog(log, config)?.id === instance.id) || null;
}

function automaticControlEnabled(instance) {
  return Boolean(instance?.active);
}

function snapshotLogFile(log) {
  const activePath = findNewestMatchingFile(log.path);
  if (!activePath || !fs.existsSync(activePath)) {
    return { activePath: null, size: -1, lastActivity: log.lastActivity };
  }

  return {
    activePath,
    size: fs.statSync(activePath).size,
    lastActivity: log.lastActivity,
  };
}

async function waitForNewLogActivity(log, snapshot, startedAt, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const activePath = findNewestMatchingFile(log.path);

    if (activePath && fs.existsSync(activePath)) {
      const currentSize = fs.statSync(activePath).size;
      if (!snapshot.activePath && currentSize > 0) return true;
      if (snapshot.activePath && activePath !== snapshot.activePath && currentSize > 0) return true;
      if (snapshot.activePath === activePath && currentSize > snapshot.size) return true;
    }

    if (log.lastActivity > startedAt && log.status === "active") return true;
    await sleep(2000);
  }

  return false;
}

function restartKeyForLog(log) {
  return Buffer.from(log.name).toString("base64url").slice(0, 80);
}

// ---------------------------------------------------------------------------
// Incident log: a durable record of every notable event, with a screenshot for
// crashes and recoveries. Kept in its own folder so the screenshot retention
// sweep never deletes the evidence.
// ---------------------------------------------------------------------------

function incidentDir() {
  return path.join(process.cwd(), "incidents");
}

function incidentIndexPath() {
  return path.join(incidentDir(), "incidents.jsonl");
}

function readIncidents(limit = 200) {
  const file = incidentIndexPath();
  if (!fs.existsSync(file)) return [];

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const line of lines.slice(-limit)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn final line can happen if the process died mid-write; skip it.
    }
  }
  return entries.reverse();
}

// Keeps the newest `keep` entries and deletes images belonging to the rest.
function pruneIncidents(keep = Number(process.env.INCIDENT_KEEP || 400)) {
  const file = incidentIndexPath();
  if (!fs.existsSync(file)) return;

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length <= keep) return;

  const dropped = lines.slice(0, lines.length - keep);
  for (const line of dropped) {
    try {
      const entry = JSON.parse(line);
      if (entry.image) deleteFileQuietly(path.join(incidentDir(), entry.image));
    } catch {
      // Unparseable line has no image to clean up.
    }
  }
  fs.writeFileSync(file, `${lines.slice(-keep).join("\n")}\n`, "utf8");
}

async function recordIncident(config, details) {
  try {
    fs.mkdirSync(incidentDir(), { recursive: true });
    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const entry = {
      id,
      at: Date.now(),
      kind: details.kind || "event",
      severity: details.severity || "info",
      log: details.logName || null,
      instance: details.instanceLabel || null,
      message: String(details.message || "").slice(0, 4000),
      image: null,
    };

    // Screenshots are only worth the disk space on crashes and recoveries.
    if (details.capture?.device) {
      const name = `${id}.jpg`;
      try {
        const bytes = await captureLiveFrame(config.control, details.capture, {
          maxWidth: Number(process.env.INCIDENT_IMAGE_WIDTH || 1280),
          quality: Number(process.env.INCIDENT_IMAGE_QUALITY || 80),
        });
        fs.writeFileSync(path.join(incidentDir(), name), bytes);
        entry.image = name;
      } catch (error) {
        entry.captureError = error.message.slice(0, 300);
      }
    }

    fs.appendFileSync(incidentIndexPath(), `${JSON.stringify(entry)}\n`, "utf8");
    pruneIncidents();
    webEmit({ type: "incident", incident: entry });
    await sendPush(entry);
    return entry;
  } catch (error) {
    console.error(`[incident] Could not record incident: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phone push notifications via ntfy. Only warn/error incidents are pushed, so
// a normal run is silent.
// ---------------------------------------------------------------------------

const PUSH_SEVERITY_RANK = { info: 0, warn: 1, error: 2 };

function pushConfig() {
  const topic = String(process.env.NTFY_TOPIC || "").trim();
  return {
    enabled: parseBooleanEnv("NTFY_ENABLED", false) && Boolean(topic),
    topic,
    server: String(process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, ""),
    minSeverity: String(process.env.NTFY_MIN_SEVERITY || "warn").toLowerCase(),
  };
}

async function sendPush(entry) {
  const push = pushConfig();
  if (!push.enabled) return;
  if ((PUSH_SEVERITY_RANK[entry.severity] ?? 0) < (PUSH_SEVERITY_RANK[push.minSeverity] ?? 1)) return;

  const tag = entry.severity === "error" ? "rotating_light" : entry.severity === "warn" ? "warning" : "information_source";
  try {
    // Published as JSON rather than through X-Title and friends. HTTP header
    // values are latin-1 only, and an instance name or an em dash in the title
    // made fetch throw before the request ever left. The JSON body is UTF-8.
    const response = await fetch(push.server, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: push.topic,
        title: `AutoClash: ${entry.kind}${entry.instance ? ` — ${entry.instance}` : ""}`,
        message: String(entry.message || "").replace(/`/g, "").slice(0, 900),
        priority: entry.severity === "error" ? 4 : 3,
        tags: [tag],
      }),
    });
    if (!response.ok) throw new Error(`ntfy responded ${response.status}`);
  } catch (error) {
    console.error(`[push] Could not send notification: ${error.message}`);
  }
}

// Turns classified fault lines into incidents, rate limited per kind so a
// pattern that fires hundreds of times a day produces a handful of entries
// rather than hundreds. Only errors get a screenshot.
const faultCooldowns = new Map(); // `${logName}:${kind}` -> last reported at

async function reportLogFaults(log, config, events) {
  if (!events.length) return;
  if (!parseBooleanEnv("LOG_FAULT_INCIDENTS", true)) return;

  const cooldownMs = Math.max(60, Number(process.env.LOG_FAULT_COOLDOWN_SECONDS || 900)) * 1000;
  const now = Date.now();
  const instance = findControlInstanceForLog(log, config);

  // One incident per kind per window, carrying how many times it fired.
  const byKind = new Map();
  for (const event of events) {
    if (!byKind.has(event.kind)) byKind.set(event.kind, { ...event, count: 0 });
    byKind.get(event.kind).count += 1;
  }

  for (const [kind, event] of byKind) {
    const key = `${log.name}:${kind}`;
    if (now - (faultCooldowns.get(key) || 0) < cooldownMs) continue;
    faultCooldowns.set(key, now);

    const times = event.count > 1 ? ` (${event.count}x in this batch)` : "";
    await recordIncident(config, {
      kind,
      severity: event.severity,
      logName: log.name,
      instanceLabel: instance?.label || null,
      message: `${log.name}: ${event.line}${times}`,
      capture: event.severity === "error" ? instance : null,
    });
  }
}

async function sendLogEvent(log, config, message, options = {}) {
  webEmit({ type: "event", log: log.name, output: message });
  await recordIncident(config, {
    kind: options.kind || "event",
    severity: options.severity || "info",
    logName: log.name,
    instanceLabel: options.instance?.label || null,
    message,
    capture: options.capture ? options.instance : null,
  });
  await config.send(log.channelId, message);
}

function recentLogLinesText(log, count = 10) {
  return log.recentLines.length > 0
    ? log.recentLines.slice(-count).join("\n").replace(/```/g, "'''").slice(-1800)
    : "No recent lines saved yet.";
}

async function sendRecentLogLines(log, config, reason = "Recent log lines") {
  await config.send(log.channelId, `**${log.name} last 10 lines - ${reason}**\n\`\`\`text\n${recentLogLinesText(log, 10)}\n\`\`\``);
}

async function sendBeforeRecoveryScreenshot(log, config, instance, reason, existingFile = null) {
  try {
    const file = existingFile || await captureAdbScreen(config.control, instance);
    await config.sendFile(log.channelId, `**Before recovery** - \`${instance.label}\`\n${reason}`, file, { deleteAfterSend: true });
  } catch (error) {
    console.error(`[${log.name}] Could not send before-recovery screenshot: ${error.message}`);
  }
}

async function notifySleeping(log, config) {
  if (log.sleepingNotified) return;
  log.sleepingNotified = true;
  log.restartHandled = true;
  await sendLogEvent(log, config, `\`${log.name}\` is sleeping because it is outside active hours.`);
}

async function notifyCompleted(log, config) {
  if (log.restartHandled) return;
  log.status = "finished";
  log.pausedReason = "completed";
  log.restartHandled = true;
  await updateChannelName(log, config);
  await upsertStatusEmbed(log, config);
  await sendLogEvent(log, config, `\`${log.name}\` finished its work and stopped normally.`);
}

async function handleRestartCandidate(log, config, reason) {
  if (config.autoRestartMode === "off" || log.restartHandled) return;

  const instance = findControlInstanceForLog(log, config);
  if (!automaticControlEnabled(instance)) return;
  if (!instance) {
    log.restartHandled = true;
    await sendLogEvent(log, config, `\`${log.name}\` stopped, but no matching AutoClash exe was found for restart.`, { kind: "crash", severity: "error" });
    return;
  }

  if (config.autoRestartMode === "auto") {
    log.restartHandled = true;
    await sendRecentLogLines(log, config, reason);
    await executeExeActionWithRetry(config.control, "stop", instance, { attempts: 6, delayMs: 5000 });
    await sleep(1200);
    await closeLdPlayer(config.control, instance);
    await sleep(config.adbRecoveryStartDelaySeconds * 1000);
    await executeExeActionWithRetry(config.control, "start", instance, { attempts: 6, delayMs: 5000 });
    await sendLogEvent(log, config, `\`${log.name}\` stopped (${reason}). LDPlayer was closed and Auto-restart was sent to \`${instance.label}\`.`, { kind: "recovery", severity: "warn", instance, capture: true });
    return;
  }
}

function countClashRestartTriggerLines(lines) {
  return lines.filter((line) =>
    /\[STATUS\]\s*Gold still below threshold,\s*waiting for next check/i.test(line)
  ).length;
}

function hasAdbScreencapError(lines) {
  return lines.some((line) =>
    /\bADB\b.*exec-out screencap timed out,\s*using fallback screencap/i.test(line) ||
    /\bADB\b.*exec-out failed,\s*using fallback screencap/i.test(line)
  );
}

function countDeviceOfflineReconnectLines(lines) {
  return lines.filter((line) => /Device offline\s*-\s*waiting for reconnect/i.test(line)).length;
}

const adbWarned = new Set();

// ADB is optional until configured. Without this guard the periodic checks
// spawn PowerShell every cycle and log a parameter-binding error, which is
// exactly what a fresh install would see on first boot.
function adbReady(control, context) {
  const adbPath = String(control?.adbPath || "").trim();
  if (adbPath && fs.existsSync(adbPath)) return true;
  if (!adbWarned.has(context)) {
    adbWarned.add(context);
    console.warn(`[adb] No adb.exe configured, skipping ${context}. Set AUTOCONTROL_ADB_PATH in Settings.`);
  }
  return false;
}

async function runAdb(control, instance, args) {
  if (!adbReady(control, "adb command")) throw new Error("ADB is not configured. Set the adb.exe path in Settings.");
  if (!instance?.device) {
    throw new Error(`${instance?.label || "AutoClash"} does not have an ADB device configured`);
  }

  await execFileText(control.adbPath, ["connect", instance.device], { cwd: process.cwd() }).catch(() => "");
  return execFileText(control.adbPath, ["-s", instance.device, ...args], { cwd: process.cwd() });
}

async function restartClashOfClans(control, instance) {
  const packageName = "com.supercell.clashofclans";
  const stopOutput = await runAdb(control, instance, ["shell", "am", "force-stop", packageName]);
  await sleep(2500);
  const startOutput = await runAdb(control, instance, [
    "shell",
    "monkey",
    "-p",
    packageName,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ]);

  return [`force-stop: ${stopOutput.trim()}`, `start: ${startOutput.trim()}`].join("\n").trim();
}

async function detectCocConnectionLost(control, instance) {
  const dir = SCREENSHOT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${instance.id}-connection-lost-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  const scriptPath = resolveScriptPath("detect-coc-connection-lost.ps1");
  const output = await execFileText("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-AdbPath",
    control.adbPath,
    "-Device",
    instance.device,
    "-OutputPath",
    file,
  ], { cwd: path.dirname(scriptPath), timeout: 20000 });

  return {
    detected: /detected=True/i.test(output),
    output: output.trim(),
    file,
  };
}

// A stopped emulator makes every visual check fail the same way, once per
// interval, forever. Report the first one and then stand down for a while:
// nothing useful happens until the device comes back.
const VISUAL_FAILURE_BACKOFF_MS = 5 * 60 * 1000;

function noteVisualFailure(log, error) {
  const message = String(error && error.message ? error.message : error);
  const summary = message.split(/\r?\n/)[0].slice(0, 200);

  log.visualBackoffUntil = Date.now() + VISUAL_FAILURE_BACKOFF_MS;
  if (log.lastVisualFailure === summary) return;

  log.lastVisualFailure = summary;
  console.error(`[${log.name}] visual check failed, pausing it for ${Math.round(VISUAL_FAILURE_BACKOFF_MS / 60000)} min: ${summary}`);
}

async function handleCocConnectionLostVisual(log, config) {
  if (!config.visualCheckEnabled) return;
  if (!adbReady(config.control, "the connection-lost check")) return;

  const now = Date.now();
  if (log.visualBackoffUntil && now < log.visualBackoffUntil) return;
  if (now - log.lastVisualCheckAt < config.visualCheckIntervalSeconds * 1000) return;
  log.lastVisualCheckAt = now;

  const instance = findControlInstanceForLog(log, config);
  if (!automaticControlEnabled(instance)) return;
  if (!instance?.device) return;

  let result;
  try {
    result = await detectCocConnectionLost(config.control, instance);
  } catch (error) {
    noteVisualFailure(log, error);
    return;
  }

  // The device answered, so anything that failed before is history.
  log.visualBackoffUntil = 0;
  log.lastVisualFailure = "";

  // The check runs every 30s per instance and writes a full-size PNG each time.
  // Keep it only when it is actually evidence for an alert, otherwise it piles
  // up at gigabytes per day.
  if (!result.detected || now - log.lastVisualRecoveryAt < 120000) {
    deleteFileQuietly(result.file);
    return;
  }
  log.lastVisualRecoveryAt = now;

  try {
    await sendBeforeRecoveryScreenshot(
      log,
      config,
      instance,
      "CoC Connection lost popup detected before restarting Clash of Clans.",
      result.file
    );
    await sendRecentLogLines(log, config, "CoC Connection lost popup");
    await restartClashOfClans(config.control, instance);
    await sendLogEvent(
      log,
      config,
      `\`${log.name}\` detected the CoC Connection lost popup. Clash of Clans was restarted on \`${instance.label}\`.`,
      { kind: "recovery", severity: "warn", instance, capture: true }
    );
  } catch (error) {
    const details = [result.output, error.message, error.stderr, error.stdout].filter(Boolean).join("\n").trim().slice(0, 1800);
    await sendLogEvent(log, config, `\`${log.name}\` detected the CoC Connection lost popup, but Clash restart failed:\n\`\`\`text\n${details}\n\`\`\``, { kind: "recovery-failed", severity: "error", instance, capture: true });
  }
}

async function closeLdPlayer(control, instance) {
  if (!instance?.device) {
    throw new Error(`${instance?.label || "AutoClash"} does not have an ADB device configured`);
  }

  // MuMu has no `adb emu` console, so go straight to its manager.
  if (emulatorKind(control) === "mumu") {
    try {
      return await closeLdPlayerByConsole(control, instance);
    } catch (error) {
      const windowOutput = await closeLdPlayerByWindow(instance);
      return [`MuMuManager shutdown failed: ${error.message}`, `Windows fallback: ${windowOutput.trim() || "Done"}`].join("\n");
    }
  }

  await execFileText(control.adbPath, ["connect", instance.device], { cwd: process.cwd() }).catch(() => "");
  try {
    return await execFileText(control.adbPath, ["-s", instance.device, "emu", "kill"], { cwd: process.cwd() });
  } catch (error) {
    const fallbackOutput = await closeLdPlayerByConsole(control, instance).catch(async (consoleError) => {
      const windowOutput = await closeLdPlayerByWindow(instance);
      return [
        `LDConsole fallback failed: ${consoleError.message}`,
        windowOutput.trim() ? `Windows fallback: ${windowOutput.trim()}` : "Windows fallback: Done",
      ].join("\n");
    });
    return [
      `ADB emu kill failed: ${error.message}`,
      fallbackOutput.trim() ? `LDPlayer fallback: ${fallbackOutput.trim()}` : "LDPlayer fallback: Done",
    ].join("\n");
  }
}

async function closeLdPlayerByWindow(instance) {
  const scriptPath = resolveScriptPath("close-ldplayer-instance.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Label",
    instance.label,
  ];
  return execFileText("powershell", args, { cwd: path.dirname(scriptPath) });
}

// Emulator backend. MuMu and LDPlayer are both driven by an instance index
// derived from the ADB port; only the console path, the port step and the
// subcommand names differ. Set EMULATOR=mumu or EMULATOR=ldplayer in .env to
// force one; otherwise MuMu wins when its manager is installed.
function mumuManagerPath(control) {
  return (
    process.env.MUMU_MANAGER_PATH ||
    control?.mumuManagerPath ||
    "C:\\Program Files\\Netease\\MuMuPlayer\\nx_main\\MuMuManager.exe"
  );
}

function ldConsolePath(control) {
  return process.env.LDPLAYER_CONSOLE_PATH || control?.ldConsolePath || "C:\\LDPlayer\\LDPlayer9\\ldconsole.exe";
}

function emulatorKind(control) {
  const configured = String(process.env.EMULATOR || "").trim().toLowerCase();
  if (configured === "mumu" || configured === "ldplayer") return configured;
  return fs.existsSync(mumuManagerPath(control)) ? "mumu" : "ldplayer";
}

// MuMu ADB ports start at 16384 and step by 32; LDPlayer starts at 5555, step 2.
function emulatorIndexForInstance(kind, instance) {
  const match = String(instance?.device || "").match(/:(\d+)$/);
  const port = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(port)) return null;

  const index = kind === "mumu" ? (port - 16384) / 32 : (port - 5555) / 2;
  return Number.isInteger(index) && index >= 0 ? index : null;
}

async function runEmulatorCommand(control, instance, action) {
  const kind = emulatorKind(control);
  const consolePath = kind === "mumu" ? mumuManagerPath(control) : ldConsolePath(control);
  if (!fs.existsSync(consolePath)) {
    throw new Error(`${kind === "mumu" ? "MuMuManager" : "LDPlayer console"} was not found: ${consolePath}`);
  }

  const index = emulatorIndexForInstance(kind, instance);
  if (index === null) {
    throw new Error(`Could not derive ${kind} index from ADB device: ${instance?.device || "empty"}`);
  }

  const args =
    kind === "mumu"
      ? ["control", "-v", String(index), action === "launch" ? "launch" : "shutdown"]
      : [action === "launch" ? "launch" : "quit", "--index", String(index)];

  return execFileText(consolePath, args, { cwd: path.dirname(consolePath), timeout: 20000 });
}

async function closeLdPlayerByConsole(control, instance) {
  return runEmulatorCommand(control, instance, "shutdown");
}

async function openLdPlayer(control, instance) {
  return runEmulatorCommand(control, instance, "launch");
}

async function restartAutoClashAfterDeviceOffline(log, config, instance) {
  await executeExeActionWithRetry(config.control, "stop", instance, { attempts: 6, delayMs: 5000 });
  await sleep(1200);
  await executeExeActionWithRetry(config.control, "start", instance, { attempts: 6, delayMs: 5000 });
  await sendLogEvent(
    log,
    config,
    `\`${log.name}\` detected "Device offline - waiting for reconnect" more than 4 times. AutoClash Stop/Start was sent to \`${instance.label}\`.`
  );
}

async function handleDeviceOfflineReconnect(log, config, lines) {
  const matches = countDeviceOfflineReconnectLines(lines);
  if (matches === 0) return;

  log.deviceOfflineReconnectCount += matches;
  if (log.deviceOfflineReconnectCount <= 4) return;

  const instance = findControlInstanceForLog(log, config);
  if (!automaticControlEnabled(instance)) {
    log.deviceOfflineReconnectCount = 0;
    return;
  }
  if (!instance) {
    log.deviceOfflineReconnectCount = 0;
    await sendLogEvent(log, config, `\`${log.name}\` detected repeated Device offline reconnects, but no matching AutoClash instance was found.`);
    return;
  }

  try {
    log.deviceOfflineReconnectCount = 0;
    await sendRecentLogLines(log, config, "Device offline reconnect");
    await restartAutoClashAfterDeviceOffline(log, config, instance);
  } catch (error) {
    const details = [error.message, error.stderr, error.stdout].filter(Boolean).join("\n").trim().slice(0, 1800);
    await sendLogEvent(log, config, `\`${log.name}\` detected repeated Device offline reconnects, but AutoClash restart failed:\n\`\`\`text\n${details}\n\`\`\``, { kind: "recovery-failed", severity: "error", instance, capture: true });
  }
}

async function handleAdbScreencapRecovery(log, config, lines) {
  if (!hasAdbScreencapError(lines)) return;

  const now = Date.now();
  if (now - log.lastAdbRecoveryAt < 120000) return;
  log.lastAdbRecoveryAt = now;

  const instance = findControlInstanceForLog(log, config);
  if (!automaticControlEnabled(instance)) return;
  if (!instance) {
    await sendLogEvent(log, config, `\`${log.name}\` detected an ADB screencap error, but no matching AutoClash instance was found.`);
    return;
  }

  try {
    await sleep(config.adbRecoveryStopDelaySeconds * 1000);
    await sendRecentLogLines(log, config, "ADB screencap error");
    await executeExeActionWithRetry(config.control, "stop", instance, { attempts: 6, delayMs: 5000 });
    await sleep(1200);
    await closeLdPlayer(config.control, instance);
    await sleep(config.adbRecoveryStartDelaySeconds * 1000);
    await executeExeActionWithRetry(config.control, "start", instance, { attempts: 6, delayMs: 5000 });

    await sendLogEvent(
      log,
      config,
      `\`${log.name}\` detected an ADB screencap error. AutoClash was stopped, LDPlayer was closed, and AutoClash was started again on \`${instance.label}\`.`
    );
  } catch (error) {
    const details = [error.message, error.stderr, error.stdout].filter(Boolean).join("\n").trim().slice(0, 1800);
    await sendLogEvent(log, config, `\`${log.name}\` detected an ADB screencap error, but recovery failed:\n\`\`\`text\n${details}\n\`\`\``, { kind: "recovery-failed", severity: "error", instance, capture: true });
  }
}

async function handleClashRestartTriggers(log, config, lines) {
  const matches = countClashRestartTriggerLines(lines);
  if (matches === 0) return;

  log.goldBelowThresholdCount += matches;
  if (log.goldBelowThresholdCount < 1) return;

  const now = Date.now();
  if (now - log.lastGoldRestartAt < 120000) return;

  log.lastGoldRestartAt = now;
  log.goldBelowThresholdCount = 0;

  const instance = findControlInstanceForLog(log, config);
  if (!automaticControlEnabled(instance)) return;
  if (!instance) {
    await sendLogEvent(log, config, `\`${log.name}\` detected a Clash restart trigger, but no matching AutoClash instance was found.`);
    return;
  }

  try {
    await sendBeforeRecoveryScreenshot(
      log,
      config,
      instance,
      "Clash restart trigger detected before restarting Clash of Clans."
    );
    await sendRecentLogLines(log, config, "Clash restart trigger");
    await restartClashOfClans(config.control, instance);
    await sendLogEvent(
      log,
      config,
      `\`${log.name}\` detected a Clash restart trigger. Clash of Clans was restarted on \`${instance.label}\`.`
    );
  } catch (error) {
    const details = [error.message, error.stderr, error.stdout].filter(Boolean).join("\n").trim().slice(0, 1800);
    await sendLogEvent(log, config, `\`${log.name}\` detected a Clash restart trigger, but Clash restart failed:\n\`\`\`text\n${details}\n\`\`\``, { kind: "recovery-failed", severity: "error", instance, capture: true });
  }
}

function buildStatusEmbed(log, config) {
  const activeFile = log.activePath ? path.basename(log.activePath) : "No file detected";
  const secondsWithoutActivity = Math.floor((Date.now() - log.lastActivity) / 1000);
  const lineLimit = log.status === "stalled" ? 10 : 5;
  const isStalled = log.status === "stalled";
  const isPaused = log.status === "paused";
  const isFinished = log.status === "finished";
  const recentLines =
    log.recentLines.length > 0
      ? log.recentLines.slice(-lineLimit).join("\n").replace(/```/g, "'''").slice(-3800)
      : log.status === "stalled"
        ? "No recent lines saved."
        : isPaused
          ? "Humanized break active. Waiting before continuing."
          : isFinished
            ? "Finished normally. Waiting for the next run."
            : "Working. Discord updates only when the status changes.";
  const secondsLeft = breakSecondsLeft(log);
  const statusText = isStalled
    ? "Stopped / no new lines"
    : isPaused
      ? secondsLeft
        ? `On a break - back <t:${Math.floor(log.breakUntil / 1000)}:R>`
        : "On a break"
      : isFinished
        ? "Finished normally"
        : "Working";
  // A humanized break is a healthy pause, so it gets orange rather than the
  // yellow used for other paused states - matching the web panel.
  const isBreak = isPaused && String(log.pausedReason || "").includes("humanized");
  const emoji = isStalled ? "🔴" : isBreak ? "🟠" : isPaused ? "🟡" : isFinished ? "⚪" : "🟢";
  const color = isStalled ? 0xff3b30 : isBreak ? 0xff8c1a : isPaused ? 0xf1c40f : isFinished ? 0x95a5a6 : 0x2ecc71;

  const instance = findControlInstanceForLog(log, config);
  const run = instance ? instanceRunStateCached(instance) : null;

  const fields = [
    {
      name: "Status",
      value: statusText,
      inline: true,
    },
    {
      name: "Last activity",
      value: `${discordRelativeTime(log.lastActivity)}${secondsWithoutActivity >= 60 ? "" : ` (${secondsWithoutActivity}s)`}`,
      inline: true,
    },
  ];

  if (run?.account) {
    let accVal = `**${run.account}**`;
    if (run.thLevel) accVal += ` (${run.thLevel})`;
    if (run.multiVillage?.enabled && run.running && run.multiVillage.remainingText) {
      accVal += `\n⏳ **${run.multiVillage.remainingText}**`;
      if (run.multiVillage.nextAccount) {
        accVal += ` _(Next: ${run.multiVillage.nextAccount})_`;
      }
    }
    fields.push({
      name: "Active Account",
      value: accVal,
      inline: true,
    });
  }

  fields.push({
    name: "File",
    value: `\`${activeFile}\``,
    inline: false,
  });

  return {
    title: `${emoji} ${log.name}`,
    description: `\`\`\`text\n${recentLines || " "}\n\`\`\``,
    color,
    fields,
    footer: {
      text: log.activePath || log.path,
    },
    timestamp: new Date().toISOString(),
  };
}

async function upsertStatusEmbed(log, config) {
  const payload = {
    content: "",
    embeds: [buildStatusEmbed(log, config)],
    components: logStatusComponents(log),
  };

  if (!log.statusMessageId) {
    const newMessage = await config.sendPayload(log.channelId, payload);
    log.statusMessageId = newMessage.id;
    rememberLogState(log, config.state);
    await pinStatusEmbed(log, config);
    return;
  }

  try {
    await config.editPayload(log.channelId, log.statusMessageId, payload);
    await pinStatusEmbed(log, config);
  } catch (error) {
    const message = String(error.message);
    const shouldCreateNewMessage =
      message.includes("10008") ||
      message.includes("50005") ||
      message.includes("Cannot edit a message authored by another user") ||
      message.includes("30046") ||
      message.includes("Maximum number of edits") ||
      message.includes("Discord responded with 429");

    if (!shouldCreateNewMessage) {
      throw error;
    }

    const newMessage = await config.sendPayload(log.channelId, payload);
    log.statusMessageId = newMessage.id;
    log.statusPinnedMessageId = null;
    rememberLogState(log, config.state);
    await pinStatusEmbed(log, config);
  }
}

async function pinStatusEmbed(log, config) {
  if (!config.pinMessage || !log.statusMessageId || log.statusPinnedMessageId === log.statusMessageId) return;

  try {
    await config.pinMessage(log.channelId, log.statusMessageId);
    log.statusPinnedMessageId = log.statusMessageId;
    rememberLogState(log, config.state);
  } catch (error) {
    console.error(`[${log.name}] Could not pin the status panel: ${error.message}`);
  }
}

function logStatusComponents(log) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "Last 10 lines", custom_id: `loglines:${restartKeyForLog(log)}` },
      ],
    },
  ];
}

function isUnknownDiscordChannelError(error) {
  const message = String(error?.message || "");
  return message.includes("10003") || message.includes("Unknown Channel");
}

function liveThreadMessageLimit(config) {
  const value = Number(config.liveLogMaxThreadMessages || 10000);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 10000;
}

async function ensureLiveThread(log, config) {
  if (log.liveThreadId) return log.liveThreadId;

  const thread = await config.createThread(log.channelId, `${log.name} live log`);
  log.liveThreadId = thread.id;
  log.liveThreadMessageCount = 0;
  rememberLogState(log, config.state);
  return log.liveThreadId;
}

async function rotateLiveThread(log, config, reason) {
  if (log.liveThreadId) {
    try {
      await config.deleteChannel(log.liveThreadId);
    } catch (error) {
      if (!isUnknownDiscordChannelError(error)) {
        console.error(`[${log.name}] Could not delete live thread: ${error.message}`);
      }
    }
  }

  log.liveThreadId = null;
  log.liveThreadMessageCount = 0;
  rememberLogState(log, config.state);

  const threadId = await ensureLiveThread(log, config);
  if (reason) {
    await config.send(threadId, `Live thread rotated: ${reason}.`);
    log.liveThreadMessageCount += 1;
    rememberLogState(log, config.state);
  }

  return threadId;
}

async function sendLiveThreadMessage(log, config, message) {
  const sendAndCount = async () => {
    const threadId = await ensureLiveThread(log, config);
    await config.send(threadId, message);
    log.liveThreadMessageCount = (log.liveThreadMessageCount || 0) + 1;
    rememberLogState(log, config.state);
  };

  try {
    const limit = liveThreadMessageLimit(config);
    if (log.liveThreadId && (log.liveThreadMessageCount || 0) >= limit) {
      await rotateLiveThread(log, config, `message limit ${limit}`);
    }

    await sendAndCount();
  } catch (error) {
    if (!isUnknownDiscordChannelError(error)) {
      throw error;
    }

    log.liveThreadId = null;
    log.liveThreadMessageCount = 0;
    rememberLogState(log, config.state);
    await sendAndCount();
  }
}

async function flushLiveLog(log, config) {
  if (!config.liveLogEnabled || log.livePendingLines.length === 0) return;

  const lines = log.livePendingLines.splice(0, 35);
  const content = lines.join("\n").replace(/```/g, "'''").slice(-1850);

  try {
    await sendLiveThreadMessage(log, config, `**${log.name} live log**\n\`\`\`text\n${content}\n\`\`\``);
  } catch (error) {
    log.livePendingLines.unshift(...lines);
    throw error;
  }
}

async function checkLog(log, config) {
  await handleAutoClashUpdate(log, config);
  await handleCocConnectionLostVisual(log, config);
  await checkStuckScreen(log, config).catch((error) => console.error(`[stuck] ${log.name}: ${error.message}`));

  const newestPath = findNewestMatchingFile(log.path);

  if (!newestPath) {
    if (log.existedBefore !== false) {
      await config.send(log.channelId, `Alert: \`${log.name}\` does not exist or cannot be read: \`${log.path}\``);
      log.existedBefore = false;
      log.status = "stalled";
      await updateChannelName(log, config);
      await upsertStatusEmbed(log, config);
    }
    return;
  }

  log.existedBefore = true;

  if (log.activePath !== newestPath) {
    log.activePath = newestPath;
    log.position = fs.statSync(newestPath).size;
    log.recentLines = [];
    log.lastActivity = Date.now();
    log.status = "active";
    log.alertedStalled = false;
    log.restartHandled = false;
    log.sleepingNotified = false;
    log.pausedReason = null;
    await deleteAlertMessage(log, config);
    await updateChannelName(log, config);
    await upsertStatusEmbed(log, config);
    return;
  }

  const currentSize = fs.statSync(log.activePath).size;

  if (currentSize < log.position) {
    log.position = 0;
    await sendLogEvent(log, config, `\`${log.name}\` appears to have restarted or rotated.`);
  }

  if (currentSize > log.position) {
    const lines = readNewLines(log, currentSize, config.maxLinesPerCheck);
    const wasStalled = log.status === "stalled";
    const wasPaused = log.status === "paused";
    const wasFinished = log.status === "finished";
    const pauseReason = analyzeLogLines(lines);
    log.position = currentSize;
    log.recentLines.push(...lines);
    log.recentLines = log.recentLines.slice(-config.maxStoredLines);
    webEmit({ type: "lines", log: log.name, lines });

    // Classify what just arrived: crashes, device faults, recoveries, restarts.
    const classified = classifyLogLines(lines);
    if (classified.length) {
      recordLogHealth(log, classified);
      const notable = classified.filter((event) => event.severity === "error" || event.severity === "warn");
      if (notable.length) webEmit({ type: "log-events", log: log.name, events: notable });
      await reportLogFaults(log, config, notable);
    }

    if (config.liveLogEnabled && lines.length > 0) {
      log.livePendingLines.push(...lines);
      log.livePendingLines = log.livePendingLines.slice(-200);
    }
    await handleAdbScreencapRecovery(log, config, lines);
    await handleDeviceOfflineReconnect(log, config, lines);
    await handleClashRestartTriggers(log, config, lines);
    log.lastActivity = Date.now();
    log.status = "active";

    await updateChannelName(log, config);

    if (pauseReason === "sleeping") {
      log.pausedReason = "sleeping";
      await notifySleeping(log, config);
      return;
    }

    if (pauseReason === "completed") {
      log.pausedReason = "completed";
      await notifyCompleted(log, config);
      return;
    }

    if (pauseReason === "humanized-break") {
      const minutes = parseBreakMinutes(lines) ?? parseBreakMinutes(log.recentLines.slice(-12));
      if (minutes) log.breakUntil = Date.now() + (minutes * 60) * 1000;
      log.pausedReason = "humanized-break";
      log.status = "paused";
      log.restartHandled = true;
      await updateChannelName(log, config);
      await upsertStatusEmbed(log, config);
      return;
    }

    if (pauseReason === "ended") {
      log.pausedReason = "ended";
      await handleRestartCandidate(log, config, "session log ended");
      return;
    }

    // Lines are flowing again, so any break is over.
    log.pausedReason = null;
    log.breakUntil = 0;
    log.sleepingNotified = false;

    if ((wasStalled || wasPaused || wasFinished) && lines.length > 0) {
      log.alertedStalled = false;
      log.restartHandled = false;
      await deleteAlertMessage(log, config);
      await upsertStatusEmbed(log, config);
    }
    return;
  }

  // A break is a planned pause with a known end time. Hold the paused state for
  // its whole duration instead of letting the quiet period read as a stall.
  if (isOnBreak(log)) {
    if (log.status !== "paused" || log.pausedReason !== "humanized-break") {
      log.status = "paused";
      log.pausedReason = "humanized-break";
      log.restartHandled = true;
      await updateChannelName(log, config);
      await upsertStatusEmbed(log, config);
    }
    return;
  }

  const secondsWithoutActivity = Math.floor((Date.now() - log.lastActivity) / 1000);
  if (secondsWithoutActivity >= config.stalledAfterSeconds && !log.alertedStalled) {
    // Last chance before calling it a stall: the log file itself may say a
    // break is running, even if we never saw the announcing line.
    const scanned = scanLogTailForBreak(log.activePath);
    if (scanned) {
      log.breakUntil = scanned.endsAt;
      log.pausedReason = "humanized-break";
      log.status = "paused";
      log.restartHandled = true;
      await updateChannelName(log, config);
      await upsertStatusEmbed(log, config);
      return;
    }

    const pauseReason = log.pausedReason || recentPauseReason(log);
    if (pauseReason === "humanized-break") {
      log.alertedStalled = true;
      log.restartHandled = true;
      log.status = "paused";
      await updateChannelName(log, config);
      await upsertStatusEmbed(log, config);
      return;
    }

    if (pauseReason === "sleeping") {
      log.alertedStalled = true;
      await notifySleeping(log, config);
      return;
    }

    if (pauseReason === "completed") {
      log.alertedStalled = true;
      await notifyCompleted(log, config);
      return;
    }

    log.alertedStalled = true;
    log.status = "stalled";
    await updateChannelName(log, config);
    await upsertStatusEmbed(log, config);
    await deleteAlertMessage(log, config);
    await handleRestartCandidate(log, config, pauseReason === "ended" ? "session log ended" : "no new log lines");
    const alertMessage = await config.send(
      log.channelId,
      `@everyone Alert: \`${log.name}\` has had no new lines for ${secondsWithoutActivity} seconds. ` +
        "The application may have stopped.",
      { parse: ["everyone"] }
    );
    log.alertMessageId = alertMessage.id;
    rememberLogState(log, config.state);
  }
}

function parseBooleanEnv(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function parseAutoControlInstances(rawValue) {
  // No built-in instances: a fresh install has none until the setup wizard
  // writes them. Shipping example paths would point at a machine that is not
  // yours and silently mask a missing configuration.
  const fallback = [];

  const raw = String(rawValue || "").trim();
  if (!raw) return fallback;

  const instances = [];
  for (const item of raw.split(";")) {
    const parts = item.split("|").map((part) => part.trim());
    if (parts.length < 3) continue;
    instances.push({
      id: parts[0],
      label: parts[1],
      exePath: parts[2],
      device: parts[3] || "",
      version: normalizeAutoControlVersion(parts[4]),
      active: parseBooleanValue(parts[5], false),
      logsDir: parts[6] || "",
    });
  }

  return instances.length ? instances : fallback;
}

function parseBooleanValue(value, fallback = false) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on", "active"].includes(normalized);
}

function normalizeAutoControlVersion(value) {
  return String(value || "").trim().toLowerCase() === "basic" ? "basic" : "pro";
}

function statsPointForInstance(instance) {
  if (normalizeAutoControlVersion(instance?.version) === "basic") {
    return { x: 118, y: 202 };
  }

  return { x: 78, y: 355 };
}

function processHintsForInstance(control, instance) {
  if (normalizeAutoControlVersion(instance?.version) === "basic") {
    return {
      processName: "AutoClash Basic",
      windowTitle: "AutoClash Basic",
    };
  }

  // AutoClash renames its exe every release (AutoClash-2.0.9.exe and so on),
  // so a pinned process name goes stale. Take it from the configured exe when
  // the user has not set one.
  const fromExe = path.basename(String(instance?.exePath || ""), ".exe");
  return {
    processName: control.exeProcessName || fromExe || "AutoClash",
    windowTitle: control.exeWindowTitle,
  };
}

function resolveAutoClashExePath(instance) {
  const configuredPath = String(instance?.exePath || "").trim();
  if (!configuredPath) return "";

  if (fs.existsSync(configuredPath)) {
    const stat = fs.statSync(configuredPath);
    if (stat.isFile()) return configuredPath;
    if (stat.isDirectory()) {
      const candidates = fs.readdirSync(configuredPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name))
        .map((entry) => path.join(configuredPath, entry.name))
        .filter((filePath) => {
          const name = path.basename(filePath).toLowerCase();
          if (!name.includes("autoclash")) return false;
          return !/(adb|unins|uninstall|setup|installer|update|crash|helper|elevate)/i.test(name);
        })
        .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      return candidates[0]?.filePath || "";
    }
  }

  const parentDir = path.dirname(configuredPath);
  if (parentDir && parentDir !== configuredPath && fs.existsSync(parentDir)) {
    const fileName = path.basename(configuredPath).replace(/[-_. ]?v?\d+(?:\.\d+)+(?:[-_. ]?\d+)?/ig, "").toLowerCase();
    const candidates = fs.readdirSync(parentDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name))
      .map((entry) => path.join(parentDir, entry.name))
      .filter((filePath) => {
        const name = path.basename(filePath).toLowerCase();
        return name.includes("autoclash") || (fileName && name.includes(fileName));
      })
      .filter((filePath) => !/(adb|unins|uninstall|setup|installer|update|crash|helper|elevate)/i.test(path.basename(filePath)))
      .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return candidates[0]?.filePath || configuredPath;
  }

  return configuredPath;
}

// Discord IDs of the people allowed to press control buttons. Anyone who can
// see the channel can otherwise click Start/Stop/Desktop-screenshot, so an
// empty list here means "unrestricted" and is logged loudly on startup.
function parseOwnerIds(raw) {
  return String(raw || "")
    .split(/[,;\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function autoControlConfig(token, fallbackChannelId) {
  const instances = parseAutoControlInstances(process.env.AUTOCONTROL_INSTANCES);
  return {
    enabled: parseBooleanEnv("AUTOCONTROL_ENABLED", false),
    sendPanelOnStart: parseBooleanEnv("AUTOCONTROL_SEND_PANEL_ON_START", true),
    autoUpdateEnabled: parseBooleanEnv("AUTOCONTROL_AUTO_UPDATE_ENABLED", false),
    token,
    ownerIds: parseOwnerIds(process.env.DISCORD_OWNER_ID),
    channelId: optionalChannelId("AUTOCONTROL_CHANNEL_ID") || fallbackChannelId,
    channelName: (process.env.AUTOCONTROL_CHANNEL_NAME || "XOR WebMonitor Panel").trim(),
    adbPath: process.env.AUTOCONTROL_ADB_PATH || "",
    statsCrop: process.env.AUTOCONTROL_STATS_CROP || "227,31,781,590",
    ldConsolePath: process.env.LDPLAYER_CONSOLE_PATH || "C:\\LDPlayer\\LDPlayer9\\ldconsole.exe",
    buttonBottomOffset: Number(process.env.AUTOCONTROL_BUTTON_BOTTOM_OFFSET || 24),
    exeProcessName: process.env.AUTOCONTROL_EXE_PROCESS_NAME || "",
    exeWindowTitle: process.env.AUTOCONTROL_EXE_WINDOW_TITLE || "AutoClash Pro",
    instances,
  };
}

function truncateDiscordText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function controlPanelPayload(control) {
  const options = control.instances.slice(0, 25).map((instance, index) => ({
    label: truncateDiscordText(instance.label || `AutoClash ${index + 1}`, 80),
    value: truncateDiscordText(instance.id || `auto${index + 1}`, 100),
    description: truncateDiscordText(instance.device ? `ADB ${instance.device}` : "No ADB device set", 100),
  }));

  // Fit as many windows as the 1024-character field allows rather than cutting
  // at a fixed count, so someone running 8 instances still sees them all.
  const rendered = control.instances.map((instance) => {
    const device = instance.device || "no ADB device";
    const autoStart = instance.active ? "auto-start" : "manual";
    const run = instanceRunStateCached(instance);
    let accountLine = "";
    if (run.account) {
      accountLine = ` · 🏰 **${run.account}**${run.thLevel ? ` (${run.thLevel})` : ""}`;
      if (run.multiVillage?.enabled && run.running && run.multiVillage.remainingText) {
        accountLine += ` · ⏳ **${run.multiVillage.remainingText}**`;
        if (run.multiVillage.nextAccount) {
          accountLine += ` _(Next: ${run.multiVillage.nextAccount})_`;
        }
      }
    }
    return `**${instance.label}**\n\`${device}\` · ${normalizeAutoControlVersion(instance.version)} · ${autoStart}${accountLine}`;
  });

  const shown = [];
  let budget = 1024;
  for (const line of rendered) {
    if (budget - (line.length + 2) < 40) break; // leave room for the "+N more" note
    shown.push(line);
    budget -= line.length + 2;
  }
  const hidden = rendered.length - shown.length;
  const instanceLines = shown.join("\n\n") + (hidden > 0 ? `\n\n_+${hidden} more_` : "");

  // Rows are grouped by what they act on: pick a window, run the bot, look at
  // it, manage the apps, then everything at once. Colours carry meaning -
  // green starts, red stops, grey is read-only.
  const rows = [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "autoclash:select",
          placeholder: "1. Pick a window to control",
          min_values: 1,
          max_values: 1,
          options,
        },
      ],
    },
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "Start", emoji: { name: "▶️" }, custom_id: "autoclash:selected:start" },
        { type: 2, style: 2, label: "Pause", emoji: { name: "⏸️" }, custom_id: "autoclash:selected:pause" },
        { type: 2, style: 4, label: "Stop", emoji: { name: "⏹️" }, custom_id: "autoclash:selected:stop" },
      ],
    },
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "Screenshot", emoji: { name: "📱" }, custom_id: "autoclash:selected:screen" },
        { type: 2, style: 2, label: "Session", emoji: { name: "⚔️" }, custom_id: "autoclash:selected:sessionstats" },
        { type: 2, style: 2, label: "Today", emoji: { name: "📅" }, custom_id: "autoclash:selected:dailystats" },
        { type: 2, style: 2, label: "Desktop", emoji: { name: "🖥️" }, custom_id: "autoclash:global:fullscreen" },
      ],
    },
    {
      type: 1,
      components: [
        { type: 2, style: 1, label: "Open AutoClash", custom_id: "autoclash:selected:openexe" },
        { type: 2, style: 1, label: "Close AutoClash", custom_id: "autoclash:selected:closeexe" },
        { type: 2, style: 1, label: "Open emulator", custom_id: "autoclash:selected:openldplayer" },
        { type: 2, style: 1, label: "Close emulator", custom_id: "autoclash:selected:closeldplayer" },
      ],
    },
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "Start all", custom_id: "autoclash:global:start" },
        { type: 2, style: 4, label: "Stop all", custom_id: "autoclash:global:stop" },
        { type: 2, style: 2, label: "Show all", custom_id: "autoclash:global:show" },
        { type: 2, style: 2, label: "Hide all", custom_id: "autoclash:global:hide" },
      ],
    },
  ];

  return {
    embeds: [
      {
        title: "🎮 AutoClash Control Panel",
        description: "Pick a window in the menu, then use the rows below it.\nThe last row acts on every window at once.",
        color: 0x4c8dff,
        fields: [
          {
            name: `Windows (${control.instances.length})`,
            value: truncateDiscordText(instanceLines || "No AutoClash windows configured.", 1024),
          },
        ],
        footer: { text: "AutoClash Monitor · web panel has live view, stats and incidents" },
        timestamp: new Date().toISOString(),
      },
    ],
    components: rows,
  };
}

function execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function executeExeAction(control, action, instance) {
  const hints = processHintsForInstance(control, instance);
  const scriptPath = resolveScriptPath("control-autoclash-window.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Action",
    action,
    "-ProcessName",
    hints.processName,
    "-WindowTitle",
    hints.windowTitle,
  ];
  const exePath = resolveAutoClashExePath(instance);
  if (exePath) args.push("-ExePath", exePath);
  if (["start", "pause", "stop"].includes(action)) {
    args.push("-ControlButtonBottomOffset", String(control.buttonBottomOffset || 24));
  }
  args.push("-RestoreMinimized");

  // The raw PowerShell failure is a wall of stack trace that buries the one
  // thing that matters: AutoClash is not open, so there is no button to press.
  try {
    return await execFileText("powershell", args, { cwd: path.dirname(scriptPath) });
  } catch (error) {
    if (/No AutoClash window found/.test(error.message)) {
      throw new Error(
        `AutoClash is not running for ${instance?.label || "this instance"}. Launch it first, then send ${action} again.`
      );
    }
    throw error;
  }
}

async function executeExeActionWithRetry(control, action, instance, options = {}) {
  const attempts = Math.max(1, options.attempts || 3);
  const delayMs = Math.max(250, options.delayMs || 5000);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await executeExeAction(control, action, instance);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      console.warn(`[control] ${instance.label} ${action} attempt ${attempt} failed: ${error.message}`);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function openAutoClashExe(instance) {
  const exePath = resolveAutoClashExePath(instance);
  if (!exePath || !fs.existsSync(exePath) || !fs.statSync(exePath).isFile()) {
    throw new Error(`No AutoClash exe found for ${instance?.label || "selected window"}. Saved path: ${instance?.exePath || "empty"}`);
  }

  const child = spawn(exePath, [], {
    cwd: path.dirname(exePath),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return exePath;
}

async function closeAutoClashExe(instance) {
  const exePath = resolveAutoClashExePath(instance);
  if (!exePath || !fs.existsSync(exePath) || !fs.statSync(exePath).isFile()) {
    throw new Error(`No AutoClash exe found for ${instance?.label || "selected window"}. Saved path: ${instance?.exePath || "empty"}`);
  }

  const scriptPath = resolveScriptPath("close-autoclash-exe.ps1");
  const output = await execFileText("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ExePath",
    exePath,
  ], {
    cwd: path.dirname(scriptPath),
    timeout: 15000,
  });
  return { exePath, output };
}

async function activateAutoClashLaunchWindow() {
  const scriptPath = resolveScriptPath("activate-autoclash-launch.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
  ];
  return execFileText("powershell", args, { cwd: path.dirname(scriptPath), timeout: 25000 });
}

async function runAutoClashUpdateHandler(instance, config) {
  const exePath = resolveAutoClashExePath(instance);
  const expectedRoot = exePath ? path.dirname(exePath) : "";
  const scriptPath = resolveScriptPath("handle-autoclash-update.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
  ];
  if (expectedRoot) args.push("-ExpectedRoot", expectedRoot);

  const output = await execFileText("powershell", args, {
    cwd: path.dirname(scriptPath),
    timeout: 270000,
  });

  const result = {
    output: output.trim(),
    updateAvailable: /UpdateAvailable=True/i.test(output),
    updateInProgress: /UpdateInProgress=True/i.test(output),
    updateClicked: /UpdateClicked=True/i.test(output),
    updateComplete: /UpdateComplete=True/i.test(output),
    ownerExePath: output.match(/^OwnerExePath=(.+)$/im)?.[1]?.trim() || "",
    updaterPath: output.match(/^UpdaterPath=(.+)$/im)?.[1]?.trim() || "",
  };

  if (expectedRoot) {
    const normalizedRoot = `${path.resolve(expectedRoot).toLowerCase()}${path.sep}`;
    for (const reportedPath of [result.ownerExePath, result.updaterPath].filter(Boolean)) {
      if (!path.resolve(reportedPath).toLowerCase().startsWith(normalizedRoot)) {
        throw new Error(`Update window path does not belong to ${instance.label}: ${reportedPath}`);
      }
    }
  }

  autoClashUpdateStatus.set(instance.id, {
    label: instance.label,
    available: result.updateAvailable,
    inProgress: result.updateInProgress,
    complete: result.updateComplete,
    checkedAt: Date.now(),
  });

  return result;
}

async function openAutoClashWindowAfterUpdate(instance) {
  const exePath = openAutoClashExe(instance);
  const activationOutput = (await activateAutoClashLaunchWindow()).trim();
  console.log(`[update] ${instance.label}: ${activationOutput || "AutoClash opened."} ${exePath}`);
  await sleep(Math.max(4, Number(process.env.APP_LAUNCH_SETTLE_SECONDS || 20)) * 1000);
  return exePath;
}

async function handleAutoClashUpdate(log, config) {
  if (!config.control?.autoUpdateEnabled) return;

  if (autoClashUpdateBlockedBy) {
    const blockedLogRecovered =
      autoClashUpdateBlockedBy.logName === log.name &&
      log.lastActivity > autoClashUpdateBlockedBy.startedAt &&
      log.status === "active";
    if (blockedLogRecovered) {
      console.log(`[update] ${autoClashUpdateBlockedBy.instanceLabel}: log activity resumed; update queue unlocked.`);
      autoClashUpdateBlockedBy = null;
    } else {
      return;
    }
  }

  const now = Date.now();
  if (now - log.lastAutoUpdateCheckAt < 30000) return;
  log.lastAutoUpdateCheckAt = now;

  const instance = findControlInstanceForLog(log, config);
  if (!automaticControlEnabled(instance)) return;

  const lockResult = await withAutoClashUpdateLock(instance.label, false, async () => {
    let result;
    try {
      result = await runAutoClashUpdateHandler(instance, config);
    } catch (error) {
      const details = [error.message, error.stderr, error.stdout].filter(Boolean).join("\n").trim().slice(0, 1500);
      console.error(`[${log.name}] AutoClash update check failed: ${details}`);
      return;
    }

    if (!result.updateAvailable) return;
    if (now - log.lastAutoUpdateHandledAt < 300000) return;
    log.lastAutoUpdateHandledAt = now;

    const updateAction = result.updateClicked ? "Update Now was clicked" : "the updater was already open";
    await sendLogEvent(log, config, `\`${log.name}\` detected an AutoClash update for \`${instance.label}\`; ${updateAction}.`);

    if (!result.updateComplete) {
      await sendLogEvent(log, config, `\`${log.name}\` AutoClash update started, but completion was not confirmed:\n\`\`\`text\n${result.output.slice(0, 1500)}\n\`\`\``, { kind: "update-failed", severity: "error", instance, capture: true });
      return;
    }

    await openAutoClashWindowAfterUpdate(instance);
    const snapshot = snapshotLogFile(log);
    const maxAttempts = Math.max(1, Number(process.env.APP_AUTOSTART_MAX_ATTEMPTS || 2));
    const waitSeconds = Math.max(20, Number(process.env.APP_AUTOSTART_LOG_WAIT_SECONDS || 90));
    const startedAt = Date.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await executeExeActionWithRetry(config.control, "stop", instance, { attempts: 3, delayMs: 4000 });
      } catch (error) {
        console.warn(`[update] ${instance.label}: stop before start failed: ${error.message}`);
      }

      await sleep(1200);
      await executeExeActionWithRetry(config.control, "start", instance, { attempts: 6, delayMs: 5000 });
      if (await waitForNewLogActivity(log, snapshot, startedAt, waitSeconds)) {
        await sendLogEvent(log, config, `\`${log.name}\` AutoClash update completed. \`${instance.label}\` is open, started, and writing new log lines.`, { kind: "update", severity: "info", instance, capture: true });
        return;
      }
    }

    autoClashUpdateBlockedBy = {
      instanceId: instance.id,
      instanceLabel: instance.label,
      logName: log.name,
      startedAt,
    };
    await sendLogEvent(
      log,
      config,
      `\`${instance.label}\` was updated and opened, but no new log lines were detected. The update queue is paused and no other AutoClash will be updated until this instance resumes.`
    );
  });

  if (lockResult?.busy) {
    console.log(`[update] ${instance.label}: skipped while ${lockResult.owner} owns the update queue.`);
  }
}

async function startAutoClashInstanceAndWaitForLogCore(instance, log, config, progressSend = config.send) {
  const snapshot = snapshotLogFile(log);
  const startedAt = Date.now();
  let exePath = openAutoClashExe(instance);
  const activationOutput = (await activateAutoClashLaunchWindow()).trim();
  console.log(`[autostart] ${instance.label}: ${activationOutput || "AutoClash opened."}`);
  await sleep(Math.max(4, Number(process.env.APP_LAUNCH_SETTLE_SECONDS || 20)) * 1000);

  if (config.control?.autoUpdateEnabled) {
    const updateResult = await runAutoClashUpdateHandler(instance, config);
    if (updateResult.updateAvailable) {
      await progressSend(
        config.control.channelId,
        `AutoStart: AutoClash update detected for \`${instance.label}\`. Waiting for the updater to finish.`
      );

      if (!updateResult.updateComplete) {
        throw new Error(`AutoClash update was detected for ${instance.label}, but completion was not confirmed:\n${updateResult.output.slice(0, 1500)}`);
      }

      exePath = await openAutoClashWindowAfterUpdate(instance);
      await progressSend(
        config.control.channelId,
        `AutoStart: AutoClash update completed for \`${instance.label}\`. Continuing with Stop/Start.`
      );
    }
  }

  const maxAttempts = Math.max(1, Number(process.env.APP_AUTOSTART_MAX_ATTEMPTS || 2));
  const waitSeconds = Math.max(20, Number(process.env.APP_AUTOSTART_LOG_WAIT_SECONDS || 90));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await executeExeActionWithRetry(config.control, "stop", instance, { attempts: 6, delayMs: 5000 });
    } catch (error) {
      console.warn(`[autostart] ${instance.label}: stop before start failed: ${error.message}`);
    }

    await sleep(1200);
    await executeExeActionWithRetry(config.control, "start", instance, { attempts: 6, delayMs: 5000 });
    await progressSend(
      config.control.channelId,
      `AutoStart: Start clicked for \`${instance.label}\`. Waiting for new log lines from \`${log.name}\`.`
    );

    const hasNewLines = await waitForNewLogActivity(log, snapshot, startedAt, waitSeconds);
    if (hasNewLines) {
      return { exePath, attempts: attempt };
    }

    if (attempt < maxAttempts) {
      await progressSend(
        config.control.channelId,
        `AutoStart: \`${instance.label}\` did not write new log lines after attempt ${attempt}. Sending Stop/Start again.`
      );
    }
  }

  throw new Error(`No new log lines were detected for ${log.name} after ${maxAttempts} start attempt(s).`);
}

async function startAutoClashInstanceAndWaitForLog(instance, log, config, progressSend = config.send) {
  return withAutoClashUpdateLock(instance.label, true, async () => {
    return startAutoClashInstanceAndWaitForLogCore(instance, log, config, progressSend);
  });
}

async function runAutoStartSequence(logs, config) {
  if (!parseBooleanEnv("APP_AUTOSTART_SEQUENCE", false)) return;
  if (!config.control?.instances?.length) return;

  const tempMessages = [];
  const succeeded = [];
  const skipped = [];
  const failed = [];
  const progressSend = async (channelId, message, allowedMentions) => {
    const sent = await config.send(channelId, message, allowedMentions);
    if (sent?.id) tempMessages.push({ channelId, messageId: sent.id });
    return sent;
  };

  const activeInstances = config.control.instances.filter((instance) => instance.active);
  if (activeInstances.length === 0) {
    await config.send(config.control.channelId, "AutoStart is enabled, but no AutoClash exe is marked Active.");
    return;
  }

  await progressSend(
    config.control.channelId,
    `AutoStart sequence started for ${activeInstances.length} active AutoClash exe(s).`
  );

  for (const instance of activeInstances) {
    const log = findLogForControlInstance(instance, logs, config);
    if (!log) {
      skipped.push(`${instance.label}: no matching log`);
      await progressSend(
        config.control.channelId,
        `AutoStart: \`${instance.label}\` was skipped because no matching log was found.`
      );
      continue;
    }

    try {
      await progressSend(config.control.channelId, `AutoStart: opening \`${instance.label}\` and starting \`${log.name}\`.`);
      const result = await startAutoClashInstanceAndWaitForLog(instance, log, config, progressSend);
      succeeded.push(`${instance.label}: ${log.name} (${result.attempts} attempt${result.attempts === 1 ? "" : "s"})`);
      await progressSend(
        config.control.channelId,
        `AutoStart: \`${instance.label}\` is running. New log lines detected for \`${log.name}\` after ${result.attempts} attempt(s).`
      );
    } catch (error) {
      const details = [error.message, error.stderr, error.stdout].filter(Boolean).join("\n").trim().slice(0, 1500);
      failed.push(`${instance.label}: ${error.message}`);
      await progressSend(
        config.control.channelId,
        `AutoStart: \`${instance.label}\` failed:\n\`\`\`text\n${details}\n\`\`\``
      );
    }
  }

  for (const item of tempMessages) {
    try {
      await config.deleteMessage(item.channelId, item.messageId);
      await sleep(250);
    } catch (error) {
      console.warn(`[autostart] Could not delete temporary message ${item.messageId}: ${error.message}`);
    }
  }

  const statusLine =
    failed.length === 0 && skipped.length === 0
      ? "AutoStart finished. All active AutoClash exe(s) are running."
      : "AutoStart finished with notes.";
  const parts = [statusLine];
  if (succeeded.length > 0) parts.push(`Running:\n${succeeded.map((item) => `- ${item}`).join("\n")}`);
  if (skipped.length > 0) parts.push(`Skipped:\n${skipped.map((item) => `- ${item}`).join("\n")}`);
  if (failed.length > 0) parts.push(`Failed:\n${failed.map((item) => `- ${item}`).join("\n")}`);

  await config.send(config.control.channelId, parts.join("\n\n").slice(0, 1900));
}

async function captureStats(control, instance) {
  const dir = SCREENSHOT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${instance.id}-stats-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  const statsPoint = statsPointForInstance(instance);
  const hints = processHintsForInstance(control, instance);
  const scriptPath = resolveScriptPath("capture-autoclash-window.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-OutputPath",
    file,
    "-ProcessName",
    hints.processName,
    "-WindowTitle",
    hints.windowTitle,
  ];
  const exePath = resolveAutoClashExePath(instance);
  if (exePath) args.push("-ExePath", exePath);
  args.push("-Crop", control.statsCrop, "-EnsureStatsTab", "-StatsX", String(statsPoint.x), "-StatsY", String(statsPoint.y));
  await execFileText("powershell", args, { cwd: path.dirname(scriptPath) });
  requireReadableFile(file, "AutoClash stats screenshot");
  return file;
}

function autoClashRootDir(instance) {
  const exePath = resolveAutoClashExePath(instance);
  if (exePath && fs.existsSync(exePath) && fs.statSync(exePath).isFile()) {
    return path.dirname(exePath);
  }

  const configuredPath = String(instance?.exePath || "").trim();
  if (configuredPath && fs.existsSync(configuredPath)) {
    const stat = fs.statSync(configuredPath);
    return stat.isDirectory() ? configuredPath : path.dirname(configuredPath);
  }

  return "";
}

// ---------------------------------------------------------------------------
// Live window info. AutoClash window titles carry the running version, the
// emulator's ADB port and the account that is active right now:
//   AutoClash Pro v2.0.9 | Android Device-1 (16416) | myaccount
// Windows are matched to instances by resolved exe path, the same identity
// control-autoclash-window.ps1 uses, so the panel cannot disagree with the
// buttons.
// ---------------------------------------------------------------------------

const windowCache = { at: 0, rows: [] };
const WINDOW_CACHE_MS = 10000;

async function readAutoClashWindows({ force = false } = {}) {
  if (!force && Date.now() - windowCache.at < WINDOW_CACHE_MS) return windowCache.rows;

  try {
    const scriptPath = resolveScriptPath("list-autoclash-windows.ps1");
    const output = await execFileText("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ], { cwd: path.dirname(scriptPath), timeout: 20000 });
    const parsed = JSON.parse(output.trim() || "[]");
    windowCache.rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    console.error(`[windows] Could not list AutoClash windows: ${error.message}`);
    windowCache.rows = [];
  }
  windowCache.at = Date.now();
  return windowCache.rows;
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
}

// Every process for this instance, windowed or not.
function processesForInstance(rows, instance) {
  const exePath = resolveAutoClashExePath(instance);
  return rows.filter((row) => samePath(row.path, exePath));
}

// The one with a visible window carries the title we care about.
function windowForInstance(rows, instance) {
  return processesForInstance(rows, instance).find((row) => row.hasWindow && row.title) || null;
}

// Config may only be written when nothing is running for this instance:
// AutoClash rewrites config.json on account rotation and again as it exits.
// Note this is stricter than the Stop button, which leaves the process alive.
// Cache-only view for the frequent state poll, so rendering the Control cards
// never spawns PowerShell. A refresh is kicked off in the background when the
// cache goes stale.

const instanceAccountTracking = new Map();

function extractThLevel(accountName, accountConfig = null) {
  if (accountConfig && typeof accountConfig === "object") {
    for (const key of ["TOWNHALL_LEVEL", "HOME_TOWNHALL_LEVEL", "TH_LEVEL", "TOWNHALL", "HOME_TOWNHALL"]) {
      if (accountConfig[key] !== undefined && accountConfig[key] !== "") {
        return `TH${accountConfig[key]}`;
      }
    }
  }
  const match = String(accountName || "").match(/(?:^|[^a-zA-Z0-9])(?:th|townhall|th-)\s*(\d{1,2})(?:$|[^a-zA-Z0-9])/i);
  if (match) {
    return `TH${match[1]}`;
  }
  return "";
}

function parseLogFileNameDate(fileName, stat = null) {
  const match = String(fileName).match(/log-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})(?:-(\d{2}))?\.txt/i);
  if (match) {
    const [_, y, m, d, h, min, s] = match;
    const date = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s || 0));
    if (!isNaN(date.getTime())) return date.getTime();
  }
  return stat ? (stat.birthtimeMs || stat.mtimeMs) : Date.now();
}

function scanLogTailForProfile(rootDir, switchMinutes = 30, now = new Date()) {
  if (!rootDir || !fs.existsSync(rootDir)) return null;
  const logsDir = path.join(rootDir, "logs");
  if (!fs.existsSync(logsDir)) return null;

  try {
    const files = fs.readdirSync(logsDir)
      .filter((f) => f.startsWith("log-") && f.endsWith(".txt"))
      .map((f) => {
        const full = path.join(logsDir, f);
        const stat = fs.statSync(full);
        return { name: f, full, mtime: stat.mtimeMs, birthtime: stat.birthtimeMs, stat };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (!files.length) return null;
    const latestFile = files[0].full;
    const sessionStartTime = parseLogFileNameDate(files[0].name, files[0].stat);
    const size = files[0].stat.size;
    const readBytes = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(readBytes);
    const fd = fs.openSync(latestFile, "r");
    try {
      fs.readSync(fd, buffer, 0, readBytes, size - readBytes);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());

    const switchEvents = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/(?:\[PROFILES?\]\s*(?:Starting on|Switching to|Switched to)|(?:Starting on|Switching to|Switched to)\s+profile)\s+([a-zA-Z0-9_\-\.]+)/i)
        || line.match(/\[PROFILES?\](?:Profile\s+loaded\s+OK\s+for|Loaded\s+profile)\s+([a-zA-Z0-9_\-\.]+)/i);
      if (match && !/^(?:builder|home|village|main|clash)/i.test(match[1])) {
        const account = match[1].trim();
        const clockDate = lineClockToDate(line, now);
        switchEvents.push({ lineIndex: i, account, clockDate });
      }
    }

    if (switchEvents.length > 0) {
      const latest = switchEvents[switchEvents.length - 1];
      const switchIndex = switchEvents.length - 1;
      const switchMs = Math.max(1, switchMinutes) * 60 * 1000;
      const switchedAt = latest.clockDate ? latest.clockDate.getTime() : (sessionStartTime + (switchIndex * switchMs));
      return { account: latest.account, switchedAt, sessionStartTime };
    }

    return { account: null, switchedAt: sessionStartTime, sessionStartTime };
  } catch {}

  return null;
}

function resolveInstanceAccountDetails(instance, activeAccountName, isRunning) {
  const instanceConfig = readJsonQuietly(instanceConfigPath(instance)) || {};
  const rawAccounts = listAccounts(instance);
  const rootDir = autoClashRootDir(instance);
  const switchMinutes = Math.max(1, Number(instanceConfig.VILLAGE_SWITCH_MINUTES || instanceConfig.MULTI_VILLAGE_SWITCH_MINUTES || 60));
  const logProfile = scanLogTailForProfile(rootDir, switchMinutes);

  let currentAccount = String(activeAccountName || "").trim();
  let logSwitchedAt = 0;
  if (logProfile) {
    if (!currentAccount || isRunning) currentAccount = logProfile.account || currentAccount;
    logSwitchedAt = logProfile.switchedAt;
  }

  if (!currentAccount && !isRunning && instanceConfig.START_PROFILE) {
    currentAccount = String(instanceConfig.START_PROFILE).trim();
  }

  const currentAccountCfg = currentAccount ? readJsonQuietly(accountConfigPath(instance, currentAccount)) : null;
  const thLevel = extractThLevel(currentAccount, currentAccountCfg);

  const multiVillageEnabled = parseBooleanValue(instanceConfig.MULTI_VILLAGE_ENABLED, false);
  const switchCondition = String(instanceConfig.VILLAGE_SWITCH_CONDITION || "Time");

  const accountsWithTh = rawAccounts.map((acc) => {
    const accCfg = readJsonQuietly(accountConfigPath(instance, acc.name));
    return {
      name: acc.name,
      enabled: Boolean(acc.enabled),
      thLevel: extractThLevel(acc.name, accCfg),
      active: acc.name.toLowerCase() === currentAccount.toLowerCase(),
    };
  });

  const enabledAccounts = accountsWithTh.filter((acc) => acc.enabled);

  const currentAccountCfgPath = currentAccount ? accountConfigPath(instance, currentAccount) : "";
  let profileFileMtime = 0;
  if (currentAccountCfgPath && fs.existsSync(currentAccountCfgPath)) {
    try {
      profileFileMtime = fs.statSync(currentAccountCfgPath).mtimeMs;
    } catch {}
  }

  let effectiveSwitchedAt = 0;
  if (profileFileMtime > 0 && (Date.now() - profileFileMtime) < 12 * 60 * 60 * 1000) {
    effectiveSwitchedAt = profileFileMtime;
  } else if (logSwitchedAt > 0) {
    effectiveSwitchedAt = logSwitchedAt;
  }

  const key = instance?.id || instance?.label || "default";
  let tracking = instanceAccountTracking.get(key);
  const now = Date.now();

  if (!tracking || (currentAccount && tracking.account && tracking.account.toLowerCase() !== currentAccount.toLowerCase())) {
    tracking = {
      account: currentAccount,
      switchedAt: effectiveSwitchedAt > 0 ? effectiveSwitchedAt : now,
    };
    instanceAccountTracking.set(key, tracking);
  } else if (effectiveSwitchedAt > 0 && Math.abs(effectiveSwitchedAt - tracking.switchedAt) > 1000) {
    tracking.switchedAt = effectiveSwitchedAt;
  }

  let remainingMinutes = 0;
  let remainingSeconds = 0;
  let switchDueAt = 0;
  let nextAccount = "";

  if (multiVillageEnabled && isRunning && switchMinutes > 0) {
    const switchMs = switchMinutes * 60 * 1000;
    const baseTime = effectiveSwitchedAt > 0 ? effectiveSwitchedAt : tracking.switchedAt;
    const elapsedMs = Math.max(0, now - baseTime);
    const cycleElapsed = elapsedMs % switchMs;
    const remainingMs = Math.max(0, switchMs - cycleElapsed);
    remainingMinutes = Math.floor(remainingMs / 60000);
    remainingSeconds = Math.floor((remainingMs % 60000) / 1000);
    switchDueAt = now + remainingMs;

    if (enabledAccounts.length > 1) {
      const currentIndex = enabledAccounts.findIndex((acc) => acc.name.toLowerCase() === currentAccount.toLowerCase());
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % enabledAccounts.length : 0;
      nextAccount = enabledAccounts[nextIndex]?.name || "";
    }
  }

  const remainingText = multiVillageEnabled && isRunning
    ? (remainingMinutes > 0 || remainingSeconds > 0
        ? `${remainingMinutes}:${String(remainingSeconds).padStart(2, "0")} left`
        : "switching soon")
    : "";

  return {
    account: currentAccount,
    thLevel,
    multiVillage: {
      enabled: multiVillageEnabled,
      switchCondition,
      switchMinutes,
      accountSwitchedAt: tracking.switchedAt,
      switchDueAt,
      remainingMinutes,
      remainingSeconds,
      remainingText,
      currentAccount,
      nextAccount,
      totalAccounts: enabledAccounts.length,
      accounts: accountsWithTh,
    },
  };
}

function instanceRunStateCached(instance) {
  if (Date.now() - windowCache.at >= WINDOW_CACHE_MS) {
    readAutoClashWindows().catch(() => {});
  }
  const rows = windowCache.rows;
  const processes = processesForInstance(rows, instance);
  const win = windowForInstance(rows, instance);
  const isRunning = processes.length > 0;
  const rawAccount = win?.account || "";
  const details = resolveInstanceAccountDetails(instance, rawAccount, isRunning);

  return {
    running: isRunning,
    processCount: processes.length,
    version: win?.version || "",
    adbPort: win?.adbPort || "",
    account: details.account,
    thLevel: details.thLevel,
    multiVillage: details.multiVillage,
    known: windowCache.at > 0,
  };
}

async function instanceRunState(instance) {
  const rows = await readAutoClashWindows();
  const processes = processesForInstance(rows, instance);
  const win = windowForInstance(rows, instance);
  const isRunning = processes.length > 0;
  const rawAccount = win?.account || "";
  const details = resolveInstanceAccountDetails(instance, rawAccount, isRunning);

  return {
    running: isRunning,
    processCount: processes.length,
    version: win?.version || "",
    adbPort: win?.adbPort || "",
    account: details.account,
    thLevel: details.thLevel,
    multiVillage: details.multiVillage,
    title: win?.title || "",
  };
}

// ---------------------------------------------------------------------------
// AutoClash profile configs.
//
// Layout, measured on this machine:
//   profiles/config.json            139 keys, instance-level (ACTIVE_HOURS_*,
//                                   BOT_END_CONDITION_*, EMULATOR_*)
//   profiles/<account>/config.json  106 keys, per-account settings + state
//   profiles/__global__/config.json defaults template - never written
//
// These files are owned by a running bot. Reads are always defensive; writes
// only happen when nothing is running for that instance.
// ---------------------------------------------------------------------------

// Keys AutoClash uses as bookkeeping rather than settings. Shown, but grouped
// apart so they are not edited by accident.
const RUNTIME_STATE_KEYS = new Set([
  "CC_LOOT_CYCLE_START",
  "CC_LOOT_GOLD_DONE",
  "CC_LOOT_ELIXIR_DONE",
  "CC_LOOT_DARK_DONE",
  "OBSTACLE_REMOVAL_LAST_TIME",
  "BB_OBSTACLE_REMOVAL_LAST_TIME",
  "WEEKLY_DEAL_CLAIMED_PERIOD_START",
  "CLAN_GAMES",
  "ACCOUNT_CREATION_SUFFIX_COUNTER",
]);

// ---------------------------------------------------------------------------
// First-run setup.
//
// A fresh install has no .env, so the web server starts unconfigured and serves
// a wizard. Everything here supports that: detecting what is already on the
// machine, and writing the answers back to .env.
// ---------------------------------------------------------------------------

function detectAccessNative(port) {
  const lanAddresses = [];
  let tailscaleIp = "";
  let tailscaleInstalled = false;
  try {
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const addr of addrs || []) {
        if (addr.family !== "IPv4" && addr.family !== 4) continue;
        if (addr.internal) continue;
        const ip = addr.address;
        if (ip.startsWith("127.") || ip.startsWith("169.254.") || ip === "0.0.0.0") continue;
        const isTs = name.toLowerCase().includes("tailscale") || (ip.startsWith("100.") && (() => {
          const second = Number(ip.split(".")[1]);
          return second >= 64 && second <= 127;
        })());
        if (isTs) {
          tailscaleInstalled = true;
          tailscaleIp = ip;
        } else {
          lanAddresses.push(ip);
        }
      }
    }
  } catch {}
  return {
    port: Number(port || 8477),
    tailscaleInstalled,
    tailscaleIp,
    tailscaleName: tailscaleIp ? os.hostname().toLowerCase() : "",
    tailscaleProfile: "Private",
    firewallRuleExists: false,
    lanAddresses,
  };
}

async function detectAccess(port) {
  const fallback = detectAccessNative(port);
  try {
    const output = await execFileText("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, "detect-access.ps1"),
      "-Port",
      String(port || 8477),
    ], { cwd: __dirname, timeout: 60000 });
    const parsed = JSON.parse(output.trim() || "{}");
    return {
      ...fallback,
      ...parsed,
      tailscaleInstalled: parsed.tailscaleInstalled || fallback.tailscaleInstalled,
      tailscaleIp: parsed.tailscaleIp || fallback.tailscaleIp,
      tailscaleName: parsed.tailscaleName || fallback.tailscaleName,
      lanAddresses: (parsed.lanAddresses && parsed.lanAddresses.length) ? parsed.lanAddresses : fallback.lanAddresses,
    };
  } catch (error) {
    console.error(`[setup] Access detection fallback to native: ${error.message}`);
    return fallback;
  }
}

// Finds ADB devices using whichever adb.exe we can locate, so the wizard can
// offer real device addresses instead of asking the user to guess.
async function detectAdbDevices(adbPath) {
  // A fresh install has no configured adb path and usually no adb on PATH, so
  // fall back to the copy that ships inside each AutoClash folder.
  const bundled = (await detectInstances().catch(() => []))
    .map((instance) => instance.adbPath)
    .filter(Boolean);

  const candidates = [...new Set([adbPath, ...bundled, "adb"].filter(Boolean))];
  for (const exe of candidates) {
    try {
      const out = await execFileText(exe, ["devices"], { cwd: process.cwd(), timeout: 15000 });
      const devices = out
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2 && parts[1] === "device")
        .map((parts) => parts[0]);
      if (devices.length) return devices;
    } catch {
      // try the next candidate
    }
  }
  return [];
}

// Pre-fills the Instances step from AutoClash windows that are already running.
async function detectInstances() {
  const rows = await readAutoClashWindows({ force: true });
  const byFolder = new Map();

  for (const row of rows) {
    if (!row.path) continue;
    const folder = path.dirname(row.path);
    const adbPort = row.adbPort ? String(row.adbPort) : "";
    const baseName = path.basename(folder) || "AutoClash";
    const device = adbPort ? `127.0.0.1:${adbPort}` : "";
    const key = folder.toLowerCase();

    const candidate = {
      pid: row.pid,
      folder,
      hasWindow: Boolean(row.hasWindow),
      suggestedName: baseName,
      device,
      version: row.version || "",
      account: row.account || "",
      emulator: adbPort ? (Number(adbPort) >= 16384 ? "mumu" : "ldplayer") : "",
      logsDir: fs.existsSync(path.join(folder, "logs")) ? path.join(folder, "logs") : "",
      adbPath: fs.existsSync(path.join(folder, "Tools", "adb", "adb.exe"))
        ? path.join(folder, "Tools", "adb", "adb.exe")
        : "",
    };

    if (byFolder.has(key)) {
      const existing = byFolder.get(key);
      if (!existing.device && candidate.device) {
        existing.device = candidate.device;
        existing.emulator = candidate.emulator;
      }
      if (!existing.account && candidate.account) {
        existing.account = candidate.account;
      }
      if (!existing.hasWindow && candidate.hasWindow) {
        existing.hasWindow = true;
        existing.pid = candidate.pid;
      }
      if (!existing.version && candidate.version) {
        existing.version = candidate.version;
      }
    } else {
      byFolder.set(key, candidate);
    }
  }

  return Array.from(byFolder.values());
}

// Serialises the wizard's answers into .env using the existing writer, so the
// same merge and secret-preserving rules apply.
function applySetup(payload) {
  const instances = Array.isArray(payload.instances) ? payload.instances : [];
  if (!instances.length) throw new Error("Add at least one AutoClash instance.");

  const updates = {};
  const instanceParts = [];
  const logParts = [];
  const usedIds = new Set();

  instances.forEach((raw, index) => {
    const name = String(raw.name || "").trim();
    const folder = String(raw.folder || "").trim();
    if (!name) throw new Error(`Instance ${index + 1} needs a name.`);
    if (!folder) throw new Error(`"${name}" needs the AutoClash folder.`);
    if (/[|;]/.test(name)) throw new Error(`"${name}" cannot contain | or ; — those separate entries in .env.`);
    if (!fs.existsSync(folder)) throw new Error(`Folder not found for "${name}": ${folder}`);

    // Disambiguate ID if duplicate names exist
    let id = name;
    if (usedIds.has(id.toLowerCase())) {
      let suffix = 2;
      while (usedIds.has(`${id.toLowerCase()}_${suffix}`)) suffix += 1;
      id = `${name}_${suffix}`;
    }
    usedIds.add(id.toLowerCase());

    const device = String(raw.device || "").trim();
    const version = normalizeAutoControlVersion(raw.version);
    const active = raw.active === false ? "false" : "true";
    const logsDir = String(raw.logsDir || path.join(folder, "logs")).trim();

    // id|label|exePath|device|version|autostart|logsDir
    instanceParts.push([id, name, folder, device, version, active, logsDir].join("|"));
    logParts.push(`${id}=${logsDir}`);

    // Each instance can post to its own Discord channel, separate from the
    // control panel's. The channel name is what the bot renames that channel to
    // as status changes (🟢/🟠/🔴), so it is worth letting the user choose.
    const channelId = String(raw.channelId || "").trim();
    if (channelId) updates[envKeyForLog(id, "CHANNEL_ID")] = channelId;
    updates[envKeyForLog(id, "CHANNEL_NAME")] = String(raw.channelName || "").trim() || name;
  });

  updates.AUTOCONTROL_INSTANCES = instanceParts.join(";");
  updates.LOG_FILES = logParts.join(";");
  updates.AUTOCONTROL_ENABLED = "true";

  const adbPath = String(payload.adbPath || "").trim();
  if (adbPath) updates.AUTOCONTROL_ADB_PATH = adbPath;

  const emulator = String(payload.emulator || "").trim().toLowerCase();
  if (emulator === "mumu" || emulator === "ldplayer") updates.EMULATOR = emulator;

  const access = payload.access || {};
  if (access.host) updates.WEB_HOST = String(access.host).trim();
  if (access.port) updates.WEB_PORT = String(Number(access.port) || 8477);

  const discord = payload.discord || {};
  if (discord.token) {
    updates.DISCORD_TOKEN = String(discord.token).trim();
    updates.DISCORD_ENABLED = "true";
  }
  if (discord.channelId) {
    updates.DISCORD_CHANNEL_ID = String(discord.channelId).trim();
    updates.AUTOCONTROL_CHANNEL_ID = String(discord.channelId).trim();
    // The panel channel is renamed once on start so it is obvious which channel
    // belongs to the monitor. No status emoji here — the panel is not an
    // instance and has no running/paused/down state of its own.
    updates.AUTOCONTROL_CHANNEL_NAME = String(discord.channelName || "").trim() || "XOR WebMonitor Panel";
  }
  if (discord.ownerId) updates.DISCORD_OWNER_ID = String(discord.ownerId).trim();

  const ntfy = payload.ntfy || {};
  if (ntfy.topic) {
    updates.NTFY_TOPIC = String(ntfy.topic).trim();
    updates.NTFY_ENABLED = "true";
  }

  writeEnvFile(updates);
  for (const [key, val] of Object.entries(updates)) {
    process.env[key] = val;
  }
  return { instances: instances.length };
}

// Posts a single message so the user finds out immediately whether their token
// and channel ID are right, instead of after a restart.
async function testDiscord(token, channelId) {
  const clean = String(token || "").trim();
  const channel = String(channelId || "").trim();
  if (!clean || !channel) throw new Error("Both a bot token and a channel ID are required.");

  const me = await discordRequest(clean, "/users/@me");
  await sendDiscordMessage(clean, channel, "XOR WebMonitor test message — setup is working.");
  return { username: me.username, id: me.id };
}

// ---------------------------------------------------------------------------
// Config schema discovery.
//
// AutoClash ships no schema, so both of these learn from the config files that
// are on disk. That is what lets the panel keep pace with AutoClash updates
// without the panel itself needing an update.
// ---------------------------------------------------------------------------

// Distinct values each key takes across every profile on this machine. A key
// with a small set becomes a dropdown, so a new attack strategy shows up as
// soon as any profile uses it.
function discoverEnums(instances) {
  const seen = new Map();

  for (const instance of instances || []) {
    const dir = profilesDirForInstance(instance);
    if (!dir || !fs.existsSync(dir)) continue;

    const files = [path.join(dir, "config.json")];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) files.push(path.join(dir, entry.name, "config.json"));
      }
    } catch {
      continue;
    }

    for (const file of files) {
      const parsed = readJsonQuietly(file);
      if (!parsed) continue;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string" && typeof value !== "number") continue;
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key).add(value);
      }
    }
  }

  const enums = {};
  for (const [key, values] of seen) {
    // Two to six distinct values reads as a choice; more than that is free text
    // such as a path, clan tag or threshold.
    if (values.size >= 2 && values.size <= 6) enums[key] = [...values];
  }
  return enums;
}

function schemaSnapshotPath() {
  const inDir = path.join(__dirname, "config-schema.json");
  if (fs.existsSync(inDir)) return inDir;
  return path.join(process.cwd(), "config-schema.json");
}

// Flags keys that appeared since we last looked, so an AutoClash update
// surfaces its additions instead of burying them among a hundred rows.
function diffSchema(scopeKey, keys) {
  const file = schemaSnapshotPath();
  const snapshot = readJsonQuietly(file) || {};
  const previous = snapshot[scopeKey];
  const current = [...keys].sort();

  // First sighting is not "new" — otherwise everything is flagged at once.
  const added = previous ? current.filter((key) => !previous.includes(key)) : [];
  const removed = previous ? previous.filter((key) => !current.includes(key)) : [];

  if (!previous || added.length || removed.length) {
    snapshot[scopeKey] = current;
    try {
      fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
    } catch (error) {
      console.error(`[config] Could not save the schema snapshot: ${error.message}`);
    }
  }

  return { added, removed };
}

function profilesDirForInstance(instance) {
  const rootDir = autoClashRootDir(instance);
  return rootDir ? path.join(rootDir, "profiles") : "";
}

function instanceConfigPath(instance) {
  const dir = profilesDirForInstance(instance);
  return dir ? path.join(dir, "config.json") : "";
}

function accountConfigPath(instance, account) {
  const dir = profilesDirForInstance(instance);
  // Account names come from the filesystem, but this still receives them back
  // from the browser - keep the path inside profiles/.
  if (!dir || !/^[A-Za-z0-9._-]+$/.test(String(account || "")) || account === "__global__") return "";
  const target = path.join(dir, account, "config.json");
  return target.startsWith(dir + path.sep) ? target : "";
}

function readJsonQuietly(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`[config] Could not read ${filePath}: ${error.message}`);
    return null;
  }
}

function listAccounts(instance) {
  const dir = profilesDirForInstance(instance);
  if (!dir || !fs.existsSync(dir)) return [];

  const enabled = readJsonQuietly(path.join(dir, "active_profiles.json"))?.profiles || {};
  let order = [];
  try {
    order = fs.readFileSync(path.join(dir, "order.txt"), "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    // order.txt is optional; fall back to directory order.
  }

  const dirs = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "__global__")
    .map((entry) => entry.name);

  const ordered = [...order.filter((name) => dirs.includes(name)), ...dirs.filter((name) => !order.includes(name))];
  return ordered.map((name) => ({ name, enabled: Boolean(enabled[name]) }));
}

// Waits until the file stops changing. AutoClash flushes config as it exits, so
// writing immediately after a close would race that flush and lose the edit.
async function waitForFileToSettle(filePath, quietMs = 3000, timeoutMs = 30000) {
  const startedAt = Date.now();
  let last = -1;
  while (Date.now() - startedAt < timeoutMs) {
    let mtime = 0;
    try {
      mtime = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
    } catch {
      mtime = 0;
    }
    if (mtime === last) return true;
    last = mtime;
    await sleep(quietMs);
  }
  return false;
}

function backupConfig(filePath) {
  if (!fs.existsSync(filePath)) return "";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${filePath.replace(/\.json$/i, "")}.${stamp}.bak.json`;
  fs.copyFileSync(filePath, backup);

  // Keep the last 10 backups per file so this cannot grow without bound.
  try {
    const dir = path.dirname(filePath);
    const prefix = `${path.basename(filePath).replace(/\.json$/i, "")}.`;
    const backups = fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".bak.json"))
      .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    backups.slice(10).forEach((entry) => deleteFileQuietly(path.join(dir, entry.name)));
  } catch (error) {
    console.error(`[config] Backup pruning failed: ${error.message}`);
  }
  return backup;
}

// Merges only the keys the form sent, so anything the UI does not know about
// survives untouched. Writes via temp file + rename so a crash cannot leave a
// truncated config behind.
async function writeConfigFile(filePath, updates) {
  const current = readJsonQuietly(filePath);
  if (!current) throw new Error(`Config not found or unreadable: ${filePath}`);

  await waitForFileToSettle(filePath);

  const merged = { ...current };
  let changed = 0;
  for (const [key, value] of Object.entries(updates || {})) {
    if (!(key in current)) throw new Error(`Unknown setting: ${key}`);
    if (JSON.stringify(current[key]) === JSON.stringify(value)) continue;
    merged[key] = value;
    changed += 1;
  }
  if (!changed) return { changed: 0, backup: "" };

  const backup = backupConfig(filePath);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
  return { changed, backup: path.basename(backup) };
}

function newestBackup(filePath) {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath).replace(/\.json$/i, "")}.`;
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".bak.json"))
      .map((name) => ({ path: path.join(dir, name), at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]?.path || "";
  } catch {
    return "";
  }
}

function statsDirForInstance(instance) {
  if (instance?.logsDir && fs.existsSync(instance.logsDir)) {
    const statsInLogs = path.join(instance.logsDir, "stats");
    if (fs.existsSync(statsInLogs)) return statsInLogs;
    return instance.logsDir;
  }
  const rootDir = autoClashRootDir(instance);
  return rootDir ? path.join(rootDir, "logs", "stats") : "";
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function newestSessionStatsFile(instance) {
  const statsDir = statsDirForInstance(instance);
  if (!statsDir || !fs.existsSync(statsDir)) return "";

  const candidates = fs.readdirSync(statsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^session-\d+.*\.json$/i.test(entry.name))
    .map((entry) => path.join(statsDir, entry.name))
    .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates[0]?.filePath || "";
}

function statsDbFile(instance) {
  const statsDir = statsDirForInstance(instance);
  const file = statsDir ? path.join(statsDir, "stats.db") : "";
  return file && fs.existsSync(file) ? file : "";
}

const SESSION_STATS_COLUMNS = [
  "session_key",
  "day_key",
  "timestamp",
  "runtime",
  "runtime_seconds",
  "total_attacks",
  "gold_gained",
  "elixir_gained",
  "dark_gained",
  "donations_completed",
  "bb_attacks",
  "bb_walls_upgraded",
  "stars_0",
  "stars_1",
  "stars_2",
  "stars_3",
  "walls_upgraded",
  "obstacles_removed",
  "upgrades_done",
  "research_done",
];

function sqliteVarint(buffer, offset) {
  let value = 0;
  for (let i = 0; i < 9; i += 1) {
    const byte = buffer[offset + i];
    if (i === 8) return { value: value * 256 + byte, offset: offset + 9 };
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, offset: offset + i + 1 };
  }
  return { value, offset: offset + 9 };
}

function signedNumber(value, bits) {
  const sign = 2 ** (bits - 1);
  const full = 2 ** bits;
  return value >= sign ? value - full : value;
}

function sqliteRecordValue(buffer, offset, serialType) {
  if (serialType === 0) return { value: null, offset };
  if (serialType === 1) return { value: buffer.readInt8(offset), offset: offset + 1 };
  if (serialType === 2) return { value: buffer.readInt16BE(offset), offset: offset + 2 };
  if (serialType === 3) return { value: signedNumber(buffer.readUIntBE(offset, 3), 24), offset: offset + 3 };
  if (serialType === 4) return { value: buffer.readInt32BE(offset), offset: offset + 4 };
  if (serialType === 5) return { value: signedNumber(buffer.readUIntBE(offset, 6), 48), offset: offset + 6 };
  if (serialType === 6) return { value: Number(buffer.readBigInt64BE(offset)), offset: offset + 8 };
  if (serialType === 7) return { value: buffer.readDoubleBE(offset), offset: offset + 8 };
  if (serialType === 8) return { value: 0, offset };
  if (serialType === 9) return { value: 1, offset };

  const length = Math.floor((serialType - 12) / 2);
  const bytes = buffer.subarray(offset, offset + length);
  return {
    value: serialType % 2 === 1 ? bytes.toString("utf8") : bytes,
    offset: offset + length,
  };
}

function sqliteParseRecord(buffer, offset) {
  const header = sqliteVarint(buffer, offset);
  const headerEnd = offset + header.value;
  const serialTypes = [];
  let cursor = header.offset;
  while (cursor < headerEnd) {
    const serial = sqliteVarint(buffer, cursor);
    serialTypes.push(serial.value);
    cursor = serial.offset;
  }

  const values = [];
  cursor = headerEnd;
  for (const serialType of serialTypes) {
    const parsed = sqliteRecordValue(buffer, cursor, serialType);
    values.push(parsed.value);
    cursor = parsed.offset;
  }
  return values;
}

function sqliteReadTableRows(dbPath, tableName, columns) {
  const buffer = fs.readFileSync(dbPath);
  if (buffer.subarray(0, 16).toString("ascii") !== "SQLite format 3\u0000") {
    throw new Error(`Invalid SQLite database: ${dbPath}`);
  }

  const pageSizeValue = buffer.readUInt16BE(16);
  const pageSize = pageSizeValue === 1 ? 65536 : pageSizeValue;
  const readPageRows = (pageNo, visited = new Set()) => {
    if (!pageNo || visited.has(pageNo)) return [];
    visited.add(pageNo);

    const pageOffset = (pageNo - 1) * pageSize;
    const headerOffset = pageOffset + (pageNo === 1 ? 100 : 0);
    const pageType = buffer[headerOffset];
    const cellCount = buffer.readUInt16BE(headerOffset + 3);
    const rows = [];

    if (pageType === 0x0d) {
      for (let i = 0; i < cellCount; i += 1) {
        const cellOffset = pageOffset + buffer.readUInt16BE(headerOffset + 8 + i * 2);
        const payload = sqliteVarint(buffer, cellOffset);
        const rowid = sqliteVarint(buffer, payload.offset);
        rows.push({ rowid: rowid.value, values: sqliteParseRecord(buffer, rowid.offset) });
      }
      return rows;
    }

    if (pageType === 0x05) {
      for (let i = 0; i < cellCount; i += 1) {
        const cellOffset = pageOffset + buffer.readUInt16BE(headerOffset + 12 + i * 2);
        rows.push(...readPageRows(buffer.readUInt32BE(cellOffset), visited));
      }
      rows.push(...readPageRows(buffer.readUInt32BE(headerOffset + 8), visited));
      return rows;
    }

    throw new Error(`Unsupported SQLite page type ${pageType} in ${dbPath}`);
  };

  const masterRows = readPageRows(1).map((row) => {
    const [type, name, tblName, rootpage, sql] = row.values;
    return { type, name, tblName, rootpage, sql };
  });
  const table = masterRows.find((row) => row.type === "table" && row.name === tableName);
  if (!table?.rootpage) throw new Error(`SQLite table not found: ${tableName}`);

  return readPageRows(Number(table.rootpage)).map((row) => {
    const record = {};
    columns.forEach((column, index) => {
      record[column] = row.values[index] ?? null;
    });
    return record;
  });
}

function readSessionStatsRowsFromDb(instance) {
  const dbPath = statsDbFile(instance);
  return dbPath ? sqliteReadTableRows(dbPath, "session_stats", SESSION_STATS_COLUMNS) : [];
}

function latestSessionStats(instance) {
  const dbPath = statsDbFile(instance);
  if (dbPath) {
    const stats = readSessionStatsRowsFromDb(instance).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))[0];
    if (stats) return { stats, source: "stats.db" };
  }

  const file = newestSessionStatsFile(instance);
  if (!file) return null;
  return { stats: readJsonFile(file), source: path.basename(file) };
}

function dailyStatsFromDb(instance) {
  const dbPath = statsDbFile(instance);
  if (!dbPath) return null;

  const rows = readSessionStatsRowsFromDb(instance);
  const dates = [...new Set(rows.map((row) => row.day_key).filter(Boolean))].sort();
  const date = dates[dates.length - 1];
  if (!date) return null;

  const stats = { day_key: date };
  for (const column of SESSION_STATS_COLUMNS) {
    if (["session_key", "day_key", "timestamp", "runtime"].includes(column)) continue;
    stats[column] = rows
      .filter((row) => row.day_key === date)
      .reduce((sum, row) => sum + Number(row[column] || 0), 0);
  }
  // How many sessions went into this total. With one session in the day the
  // daily figures are the session figures, and the UI should say so rather
  // than look like the toggle is broken.
  const sessions = rows.filter((row) => row.day_key === date).length;
  return { date, stats, sessions, source: "stats.db" };
}

function allTimeStatsFromDb(instance) {
  const dbPath = statsDbFile(instance);
  if (!dbPath) return null;

  const rows = readSessionStatsRowsFromDb(instance);
  if (!rows.length) return null;

  const dates = [...new Set(rows.map((row) => row.day_key).filter(Boolean))].sort();
  const stats = {};
  for (const column of SESSION_STATS_COLUMNS) {
    if (["session_key", "day_key", "timestamp", "runtime"].includes(column)) continue;
    stats[column] = rows.reduce((sum, row) => sum + Number(row[column] || 0), 0);
  }
  const sessions = rows.length;
  const days = dates.length || 1;
  const firstDate = dates[0] || "";
  const lastDate = dates[dates.length - 1] || "";
  return { firstDate, lastDate, dates, stats, sessions, days, source: "stats.db" };
}

function allTimeStatsFallback(instance) {
  const fromDb = allTimeStatsFromDb(instance);
  if (fromDb) return fromDb;

  const statsDir = statsDirForInstance(instance);
  if (!statsDir || !fs.existsSync(statsDir)) return null;

  const dailyFile = path.join(statsDir, "daily_totals.json");
  if (fs.existsSync(dailyFile)) {
    try {
      const daily = readJsonFile(dailyFile);
      const dates = Object.keys(daily).sort();
      if (dates.length) {
        const stats = {};
        for (const date of dates) {
          const entry = daily[date] || {};
          for (const [k, v] of Object.entries(entry)) {
            if (typeof v === "number") stats[k] = (stats[k] || 0) + v;
          }
        }
        return {
          firstDate: dates[0],
          lastDate: dates[dates.length - 1],
          dates,
          stats,
          sessions: dates.length,
          days: dates.length,
          source: "daily_totals.json",
        };
      }
    } catch {}
  }

  const sessionFiles = fs.readdirSync(statsDir).filter((f) => f.startsWith("session_") && f.endsWith(".json"));
  if (sessionFiles.length) {
    const stats = {};
    for (const f of sessionFiles) {
      try {
        const data = readJsonFile(path.join(statsDir, f));
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === "number") stats[k] = (stats[k] || 0) + v;
        }
      } catch {}
    }
    return {
      firstDate: "",
      lastDate: "",
      dates: [],
      stats,
      sessions: sessionFiles.length,
      days: 1,
      source: "session JSON files",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// History for the charts. stats.db already stores one row per session, so daily
// totals and per-session rates are just aggregation over what is there.
// ---------------------------------------------------------------------------

const HISTORY_METRICS = ["gold_gained", "elixir_gained", "dark_gained", "total_attacks", "donations_completed", "runtime_seconds"];

function statsHistory(instance, days = 14, sessions = 24) {
  const rows = readSessionStatsRowsFromDb(instance);
  if (!rows.length) return { days: [], sessions: [] };

  const byDay = new Map();
  for (const row of rows) {
    const key = row.day_key;
    if (!key) continue;
    if (!byDay.has(key)) byDay.set(key, Object.fromEntries(HISTORY_METRICS.map((metric) => [metric, 0])));
    const bucket = byDay.get(key);
    for (const metric of HISTORY_METRICS) bucket[metric] += Number(row[metric] || 0);
  }

  const dayList = [...byDay.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .slice(-days)
    .map(([date, values]) => ({ date, ...values }));

  const sessionList = rows
    .slice()
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    .slice(-sessions)
    .map((row) => {
      const runtime = Number(row.runtime_seconds || 0);
      const hours = runtime / 3600;
      return {
        at: Number(row.timestamp || 0),
        runtime_seconds: runtime,
        total_attacks: Number(row.total_attacks || 0),
        // Rates are the point of this chart; skip very short sessions so a
        // 2-minute run does not spike the line.
        goldPerHour: hours >= 0.1 ? Math.round(Number(row.gold_gained || 0) / hours) : null,
        elixirPerHour: hours >= 0.1 ? Math.round(Number(row.elixir_gained || 0) / hours) : null,
        darkPerHour: hours >= 0.1 ? Math.round(Number(row.dark_gained || 0) / hours) : null,
        attacksPerHour: hours >= 0.1 ? Number((Number(row.total_attacks || 0) / hours).toFixed(1)) : null,
      };
    });

  return { days: dayList, sessions: sessionList };
}

// ---------------------------------------------------------------------------
// Daily summary: one card per day covering every window, plus the incidents
// that happened in that window.
// ---------------------------------------------------------------------------

function dayKeyFor(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function buildDailySummary(control, dayKey = dayKeyFor()) {
  const windows = control.instances.map((instance) => {
    const history = statsHistory(instance, 400);
    const day = history.days.find((entry) => entry.date === dayKey);
    return {
      id: instance.id,
      label: instance.label,
      found: Boolean(day),
      gold: day?.gold_gained || 0,
      elixir: day?.elixir_gained || 0,
      dark: day?.dark_gained || 0,
      attacks: day?.total_attacks || 0,
      donations: day?.donations_completed || 0,
      runtimeSeconds: day?.runtime_seconds || 0,
    };
  });

  const start = new Date(`${dayKey}T00:00:00`).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  const incidents = readIncidents(500).filter((entry) => entry.at >= start && entry.at < end);

  return {
    dayKey,
    windows,
    totals: {
      gold: windows.reduce((sum, w) => sum + w.gold, 0),
      elixir: windows.reduce((sum, w) => sum + w.elixir, 0),
      dark: windows.reduce((sum, w) => sum + w.dark, 0),
      attacks: windows.reduce((sum, w) => sum + w.attacks, 0),
      runtimeSeconds: windows.reduce((sum, w) => sum + w.runtimeSeconds, 0),
    },
    incidents: {
      total: incidents.length,
      errors: incidents.filter((entry) => entry.severity === "error").length,
      warnings: incidents.filter((entry) => entry.severity === "warn").length,
      list: incidents.slice(0, 20),
    },
  };
}

function dailySummaryEmbed(summary) {
  const windowLines = summary.windows
    .map((w) =>
      w.found
        ? `**${w.label}** — ${formatDuration(w.runtimeSeconds)} · ${fullNumber(w.attacks)} attacks\n` +
          `Gold ${compactNumber(w.gold)} · Elixir ${compactNumber(w.elixir)} · Dark ${compactNumber(w.dark)}`
        : `**${w.label}** — no sessions recorded`
    )
    .join("\n\n");

  const health = summary.incidents.errors
    ? `🔴 ${summary.incidents.errors} error(s), ${summary.incidents.warnings} recovery/warning(s)`
    : summary.incidents.warnings
      ? `🟡 ${summary.incidents.warnings} recovery/warning(s), no errors`
      : "🟢 No problems recorded";

  return {
    title: `📊 Daily summary — ${summary.dayKey}`,
    description:
      `Total runtime **${formatDuration(summary.totals.runtimeSeconds)}** · **${fullNumber(summary.totals.attacks)}** attacks\n` +
      `Gold **${compactNumber(summary.totals.gold)}** · Elixir **${compactNumber(summary.totals.elixir)}** · Dark **${compactNumber(summary.totals.dark)}**`,
    color: summary.incidents.errors ? 0xe0453f : summary.incidents.warnings ? 0xd9a222 : 0x2fa855,
    fields: [
      { name: "Windows", value: windowLines || "None configured.", inline: false },
      { name: "Health", value: health, inline: false },
    ],
    footer: { text: "AutoClash Monitor" },
    timestamp: new Date().toISOString(),
  };
}

function compactNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(number);
}

function fullNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("en-US").format(number);
}

function formatDuration(seconds, fallback = "") {
  if (fallback) return String(fallback);
  const total = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":");
}

function statLine(label, value, formatter = fullNumber) {
  return `${label}: **${formatter(value)}**`;
}

function embedValue(label, value, formatter = fullNumber) {
  return `**${formatter(value)}**\n${label}`;
}

// Discord renders these as live, locale-aware times in each viewer's client.
function discordRelativeTime(ms) {
  return `<t:${Math.floor(Number(ms || Date.now()) / 1000)}:R>`;
}

// Small text bar, so star distribution reads at a glance instead of as 4 numbers.
function statBar(value, total, width = 10) {
  const filled = total > 0 ? Math.round((Number(value || 0) / total) * width) : 0;
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function starsValue(stats) {
  const counts = [stats.stars_0, stats.stars_1, stats.stars_2, stats.stars_3].map((value) => Number(value || 0));
  const total = counts.reduce((sum, value) => sum + value, 0);
  const labels = ["0★", "1★", "2★", "3★"];
  return counts
    .map((value, index) => {
      const percent = total > 0 ? Math.round((value / total) * 100) : 0;
      return `\`${labels[index]} ${statBar(value, total)}\` **${fullNumber(value)}** (${percent}%)`;
    })
    .join("\n");
}

// Resources per hour, which is the number that actually tells you if a run is
// going well. Returns "" when runtime is too short to be meaningful.
function perHour(value, runtimeSeconds) {
  const seconds = Number(runtimeSeconds || 0);
  const amount = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds < 300 || !amount) return "";
  return `\n${compactNumber(Math.round(amount / (seconds / 3600)))}/h`;
}

function sessionStatsEmbed(instance) {
  const result = latestSessionStats(instance);
  if (!result) {
    throw new Error(`No session stats were found for ${instance.label}. Expected stats.db or session JSON under: ${statsDirForInstance(instance) || "unknown stats folder"}`);
  }

  const { stats, source } = result;
  const runtime = Number(stats.runtime_seconds || 0);
  const attacks = Number(stats.total_attacks || 0);
  const attackRate = runtime >= 300 && attacks ? ` · **${(attacks / (runtime / 3600)).toFixed(1)}**/h` : "";
  return {
    title: `⚔️ ${instance.label} — Session`,
    description: `Runtime **${formatDuration(stats.runtime_seconds, stats.runtime)}** · **${fullNumber(attacks)}** attacks${attackRate}`,
    color: 5763719,
    fields: [
      { name: "Gold", value: embedValue("gained", stats.gold_gained, compactNumber) + perHour(stats.gold_gained, runtime), inline: true },
      { name: "Elixir", value: embedValue("gained", stats.elixir_gained, compactNumber) + perHour(stats.elixir_gained, runtime), inline: true },
      { name: "Dark", value: embedValue("gained", stats.dark_gained, compactNumber) + perHour(stats.dark_gained, runtime), inline: true },
      { name: "Donations", value: embedValue("completed", stats.donations_completed), inline: true },
      { name: "Walls", value: embedValue("upgraded", stats.walls_upgraded), inline: true },
      { name: "Progress", value: `Obstacles: **${fullNumber(stats.obstacles_removed)}**\nUpgrades: **${fullNumber(stats.upgrades_done)}**\nResearch: **${fullNumber(stats.research_done)}**`, inline: true },
      { name: "Attack results", value: starsValue(stats), inline: false },
      // Discord has no columns, so a full-width field acts as the divider
      // between the two bases.
      { name: "​", value: "🔨 **Builder Base**", inline: false },
      { name: "Attacks", value: `**${fullNumber(stats.bb_attacks)}**`, inline: true },
      { name: "Walls", value: `**${fullNumber(stats.bb_walls_upgraded)}** upgraded`, inline: true },
    ],
    footer: { text: `Main base above · Source: ${source}` },
    timestamp: new Date().toISOString(),
  };
}

function dailyStatsEmbed(instance) {
  let result = dailyStatsFromDb(instance);
  if (!result) {
    const statsDir = statsDirForInstance(instance);
    const file = statsDir ? path.join(statsDir, "daily_totals.json") : "";
    if (!file || !fs.existsSync(file)) {
      throw new Error(`No daily stats were found for ${instance.label}. Expected stats.db or daily_totals.json under: ${statsDir || "unknown stats folder"}`);
    }

    const daily = readJsonFile(file);
    const dates = Object.keys(daily).sort();
    const date = dates[dates.length - 1];
    result = { date, stats: daily[date] || {}, source: "daily_totals.json" };
  }

  const { date, stats, source } = result;
  const runtime = Number(stats.runtime_seconds || 0);
  const attacks = Number(stats.total_attacks || 0);
  const attackRate = runtime >= 300 && attacks ? ` · **${(attacks / (runtime / 3600)).toFixed(1)}**/h` : "";
  return {
    title: `📅 ${instance.label} — ${date || "latest"}`,
    description: `Runtime **${formatDuration(stats.runtime_seconds)}** · **${fullNumber(attacks)}** attacks${attackRate}`,
    color: 3447003,
    fields: [
      { name: "Gold", value: embedValue("gained", stats.gold_gained, compactNumber) + perHour(stats.gold_gained, runtime), inline: true },
      { name: "Elixir", value: embedValue("gained", stats.elixir_gained, compactNumber) + perHour(stats.elixir_gained, runtime), inline: true },
      { name: "Dark", value: embedValue("gained", stats.dark_gained, compactNumber) + perHour(stats.dark_gained, runtime), inline: true },
      { name: "Donations", value: embedValue("completed", stats.donations_completed), inline: true },
      { name: "Progress", value: `Walls: **${fullNumber(stats.walls_upgraded)}**\nObstacles: **${fullNumber(stats.obstacles_removed)}**\nUpgrades: **${fullNumber(stats.upgrades_done)}**\nResearch: **${fullNumber(stats.research_done)}**`, inline: true },
      { name: "​", value: "🔨 **Builder Base**", inline: false },
      { name: "Attacks", value: `**${fullNumber(stats.bb_attacks)}**`, inline: true },
      { name: "Walls", value: `**${fullNumber(stats.bb_walls_upgraded)}** upgraded`, inline: true },
    ],
    footer: { text: `Main base above · Source: ${source}` },
  };
}

function allTimeStatsEmbed(instance) {
  let result = allTimeStatsFallback(instance);
  if (!result) {
    throw new Error(`No all-time stats were found for ${instance.label}. Expected stats.db or session JSON under: ${statsDirForInstance(instance) || "unknown stats folder"}`);
  }

  const { stats, sessions, days, source } = result;
  const runtime = Number(stats.runtime_seconds || 0);
  const attacks = Number(stats.total_attacks || 0);
  const attackRate = runtime >= 300 && attacks ? ` · **${(attacks / (runtime / 3600)).toFixed(1)}**/h` : "";
  const daySummary = days > 1 ? ` (${days} days)` : "";

  return {
    title: `🏆 ${instance.label} — All-Time Totals`,
    description: `Runtime **${formatDuration(stats.runtime_seconds)}** across **${fullNumber(sessions)}** sessions${daySummary} · **${fullNumber(attacks)}** attacks${attackRate}`,
    color: 15844367,
    fields: [
      { name: "Gold", value: embedValue("gained", stats.gold_gained, compactNumber) + perHour(stats.gold_gained, runtime), inline: true },
      { name: "Elixir", value: embedValue("gained", stats.elixir_gained, compactNumber) + perHour(stats.elixir_gained, runtime), inline: true },
      { name: "Dark", value: embedValue("gained", stats.dark_gained, compactNumber) + perHour(stats.dark_gained, runtime), inline: true },
      { name: "Donations", value: embedValue("completed", stats.donations_completed), inline: true },
      { name: "Walls", value: embedValue("upgraded", stats.walls_upgraded), inline: true },
      { name: "Progress", value: `Obstacles: **${fullNumber(stats.obstacles_removed)}**\nUpgrades: **${fullNumber(stats.upgrades_done)}**\nResearch: **${fullNumber(stats.research_done)}**`, inline: true },
      { name: "Attack results", value: starsValue(stats), inline: false },
      { name: "​", value: "🔨 **Builder Base**", inline: false },
      { name: "Attacks", value: `**${fullNumber(stats.bb_attacks)}**`, inline: true },
      { name: "Walls", value: `**${fullNumber(stats.bb_walls_upgraded)}** upgraded`, inline: true },
    ],
    footer: { text: `All-time totals · Source: ${source}` },
  };
}
async function editInteractionEmbed(token, interaction, embed) {
  await discordRequest(token, `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "", embeds: [embed] }),
  });
}

function safeFileName(value) {
  return String(value || "capture").replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "capture";
}

async function adbScreencapBytes(control, instance) {
  if (!adbReady(control, "screen capture")) throw new Error("ADB is not configured. Set the adb.exe path in Settings.");
  if (!instance.device) {
    throw new Error(`${instance.label} does not have an ADB device configured`);
  }

  await execFileText(control.adbPath, ["connect", instance.device], { cwd: process.cwd() }).catch(() => "");
  return new Promise((resolve, reject) => {
    execFile(control.adbPath, ["-s", instance.device, "exec-out", "screencap", "-p"], {
      cwd: process.cwd(),
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function captureAdbScreen(control, instance, options = {}) {
  const dir = options.dir || path.join(process.cwd(), "control-screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const prefix = options.prefix || `${instance.id}-screen`;
  const file = path.join(dir, `${safeFileName(prefix)}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  fs.writeFileSync(file, await adbScreencapBytes(control, instance));
  return file;
}

// Live view frame: a downscaled JPEG, roughly 40x smaller than the raw PNG, so
// the phone can pull one every couple of seconds over Tailscale.
async function captureLiveFrame(control, instance, options = {}) {
  const maxWidth = Number(options.maxWidth || process.env.LIVE_VIEW_WIDTH || 720);
  const quality = Number(options.quality || process.env.LIVE_VIEW_QUALITY || 70);
  const dir = path.join(process.cwd(), "control-screenshots");
  fs.mkdirSync(dir, { recursive: true });

  const stamp = `${safeFileName(instance.id)}-live-${process.pid}-${Date.now()}`;
  const pngPath = path.join(dir, `${stamp}.png`);
  const jpgPath = path.join(dir, `${stamp}.jpg`);
  const scriptPath = resolveScriptPath("resize-image.ps1");

  fs.writeFileSync(pngPath, await adbScreencapBytes(control, instance));
  try {
    await execFileText("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-In", pngPath,
      "-Out", jpgPath,
      "-MaxWidth", String(maxWidth),
      "-Quality", String(quality),
    ], { cwd: path.dirname(scriptPath), timeout: 20000 });
    return fs.readFileSync(jpgPath);
  } finally {
    for (const file of [pngPath, jpgPath]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanupScreenshots sweeps anything left behind */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Frozen-screen detection. AutoClash can keep its process alive while the game
// is visually stuck, so "process running" is not proof of progress. Compare an
// average hash of consecutive frames: a near-identical screen plus no new log
// lines means frozen.
// ---------------------------------------------------------------------------

const stuckWatch = new Map(); // instance id -> { hash, matches, lastLogActivity, alertedAt }

async function frameHash(control, instance) {
  const dir = path.join(process.cwd(), "control-screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeFileName(instance.id)}-hash-${process.pid}-${Date.now()}.png`);
  const scriptPath = resolveScriptPath("image-hash.ps1");
  fs.writeFileSync(file, await adbScreencapBytes(control, instance));
  try {
    const output = await execFileText("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-In",
      file,
    ], { cwd: path.dirname(scriptPath), timeout: 25000 });
    return output.match(/HASH=([0-9a-f]{16})/i)?.[1] || null;
  } finally {
    deleteFileQuietly(file);
  }
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let nibble = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (nibble) {
      distance += nibble & 1;
      nibble >>= 1;
    }
  }
  return distance;
}

async function checkStuckScreen(log, config) {
  if (!parseBooleanEnv("STUCK_CHECK_ENABLED", true)) return;
  if (!adbReady(config.control, "the frozen-screen check")) return;

  const intervalMs = Math.max(60, Number(process.env.STUCK_CHECK_INTERVAL_SECONDS || 180)) * 1000;
  const now = Date.now();
  if (now - (log.lastStuckCheckAt || 0) < intervalMs) return;
  log.lastStuckCheckAt = now;

  const instance = findControlInstanceForLog(log, config);
  if (!automaticControlEnabled(instance) || !instance?.device) return;

  // During a humanized break the bot closes Clash on purpose, so a motionless
  // screen is expected. Checking here would report every break as frozen.
  if (isOnBreak(log) || log.pausedReason === "sleeping" || log.pausedReason === "completed") {
    stuckWatch.delete(instance.id);
    return;
  }

  // A log that is still producing lines is making progress by definition.
  const quietMs = now - log.lastActivity;
  if (quietMs < intervalMs) {
    stuckWatch.delete(instance.id);
    return;
  }

  let hash;
  try {
    hash = await frameHash(config.control, instance);
  } catch (error) {
    // Same story as the connection-lost check: a stopped emulator fails this
    // every time, so say it once and stand down.
    noteVisualFailure(log, error);
    return;
  }
  log.visualBackoffUntil = 0;
  log.lastVisualFailure = "";
  if (!hash) return;

  const tolerance = Number(process.env.STUCK_HASH_TOLERANCE || 4);
  const needed = Math.max(2, Number(process.env.STUCK_CHECK_STRIKES || 3));
  const watch = stuckWatch.get(instance.id) || { hash: null, matches: 0, alertedAt: 0 };

  if (watch.hash && hammingDistance(watch.hash, hash) <= tolerance) {
    watch.matches += 1;
  } else {
    watch.matches = 0;
  }
  watch.hash = hash;

  if (watch.matches >= needed && now - watch.alertedAt > 30 * 60 * 1000) {
    watch.alertedAt = now;
    watch.matches = 0;
    const minutes = Math.round((needed * intervalMs) / 60000);
    // log.name and instance.label are often the same string; do not say it twice.
    const where = log.name === instance.label ? `\`${instance.label}\`` : `\`${instance.label}\` (${log.name})`;
    await sendLogEvent(
      log,
      config,
      `${where} looks frozen: the screen has not changed for about ${minutes} minutes and no new log lines have arrived. Check the photo — the game may have closed.`,
      { kind: "stuck", severity: "error", instance, capture: true }
    );
  }

  stuckWatch.set(instance.id, watch);
}

async function adbScreenSize(control, instance) {
  const output = await runAdb(control, instance, ["shell", "wm", "size"]);
  const match = output.match(/Physical size:\s*(\d+)x(\d+)/i) || output.match(/Override size:\s*(\d+)x(\d+)/i);
  if (!match) {
    throw new Error(`Could not read screen size for ${instance.label}: ${output.trim()}`);
  }

  return { width: Number(match[1]), height: Number(match[2]) };
}

// Tap using screen ratios, so the browser can send a click position without
// knowing the emulator's resolution.
async function adbTap(control, instance, xRatio, yRatio) {
  const clamp = (value) => Math.min(1, Math.max(0, Number(value)));
  const x = clamp(xRatio);
  const y = clamp(yRatio);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Tap position must be two numbers between 0 and 1.");

  const size = await adbScreenSize(control, instance);
  await adbTapRatio(control, instance, size, x, y);
  return `Tapped ${Math.round(size.width * x)},${Math.round(size.height * y)} on ${instance.label}.`;
}

async function adbTapRatio(control, instance, size, xRatio, yRatio) {
  const x = Math.round(size.width * xRatio);
  const y = Math.round(size.height * yRatio);
  await runAdb(control, instance, ["shell", "input", "tap", String(x), String(y)]);
}

async function captureFullScreen() {
  const dir = SCREENSHOT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `full-screen-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  const scriptPath = resolveScriptPath("capture-fullscreen.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-OutputPath",
    file,
  ];
  await execFileText("powershell", args, { cwd: path.dirname(scriptPath) });
  return file;
}

async function respondInteraction(token, interaction, content) {
  await discordRequest(token, `/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: 4, data: { content, flags: 64 } }),
  });
}

async function deferInteraction(token, interaction) {
  await discordRequest(token, `/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: 5, data: { flags: 64 } }),
  });
}

async function editInteraction(token, interaction, content) {
  await discordRequest(token, `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

async function followupFile(token, interaction, content, filePath, options = {}) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content, flags: 64 }));
  requireReadableFile(filePath, "Discord upload file");
  const bytes = fs.readFileSync(filePath);
  form.append("file", new Blob([bytes], { type: "image/png" }), path.basename(filePath));
  try {
    await withTimeout(discordRequest(token, `/webhooks/${interaction.application_id}/${interaction.token}`, {
      method: "POST",
      body: form,
    }), 30000, "Discord file upload");
  } finally {
    if (options.deleteAfterSend) deleteFileQuietly(filePath);
  }
}

function interactionUserId(interaction) {
  return interaction.member?.user?.id || interaction.user?.id || "default";
}

function selectedControlInstance(control, interaction) {
  const selectedId = selectedAutoControlInstances.get(interactionUserId(interaction));
  return resolveControlInstance(control, selectedId) || control.instances[0] || null;
}

function requiredSelectedControlInstance(control, interaction) {
  const selectedId = selectedAutoControlInstances.get(interactionUserId(interaction));
  return selectedId ? resolveControlInstance(control, selectedId) : null;
}

function resolveControlInstance(control, value) {
  const selected = String(value || "").trim();
  if (!selected) return null;

  const exact = control.instances.find((item) => item.id === selected);
  if (exact) return exact;

  const selectedKey = normalizeKey(selected);
  const fuzzy = control.instances.find((item) => {
    const keys = [
      item.id,
      item.label,
      item.device,
      path.basename(resolveAutoClashExePath(item) || item.exePath || ""),
    ].map(normalizeKey).filter(Boolean);
    return keys.some((key) => key === selectedKey || key.includes(selectedKey) || selectedKey.includes(key));
  });
  if (fuzzy) return fuzzy;

  const activeInstances = control.instances.filter((item) => item.active);
  if (activeInstances.length === 1) return activeInstances[0];
  if (control.instances.length === 1) return control.instances[0];

  return null;
}

async function handleControlInteraction(control, interaction) {
  const id = interaction.data?.custom_id || "";
  if (!id.startsWith("autoclash:")) return;

  if (id === "autoclash:select") {
    const selectedId = interaction.data?.values?.[0] || "";
    const instance = resolveControlInstance(control, selectedId);
    if (!instance) {
      const knownIds = control.instances.map((item) => item.id).join(", ") || "none";
      await respondInteraction(control.token, interaction, `Unknown AutoClash window: ${selectedId || "empty"}. Known: ${knownIds}.`);
      return;
    }

    selectedAutoControlInstances.set(interactionUserId(interaction), instance.id);
    await respondInteraction(control.token, interaction, `Selected: ${instance.label}`);
    return;
  }

  let [, instanceId, action] = id.split(":");
  if (!action) {
    action = instanceId;
    instanceId = control.instances[0]?.id || "main";
  }

  if (action === "label") {
    await respondInteraction(control.token, interaction, "This button only labels the row.");
    return;
  }

  await deferInteraction(control.token, interaction);

  const instance =
    instanceId === "selected"
      ? requiredSelectedControlInstance(control, interaction)
      : resolveControlInstance(control, instanceId);
  try {
    if (instanceId === "selected" && !instance && action !== "fullscreen") {
      await editInteraction(control.token, interaction, "Choose an AutoClash window from the dropdown first.");
      return;
    }

    if (["start", "pause", "stop", "show", "hide"].includes(action)) {
      if (instanceId === "global") {
        const outputs = [];
        const targetInstances = control.instances.some((item) => item.active)
          ? control.instances.filter((item) => item.active)
          : control.instances;

        for (const item of targetInstances) {
          try {
            const output = await executeExeAction(control, action, item);
            outputs.push(`${item.label}: ${output.trim()}`);
          } catch (error) {
            const details = [error.message, error.stderr, error.stdout].filter(Boolean).join("\n").trim().split(/\r?\n/)[0];
            outputs.push(`${item.label}: failed - ${details}`);
          }
        }
        await editInteraction(control.token, interaction, `Done: \`${action}\`\n${outputs.join("\n")}`);
        return;
      }

      if (!instance) throw new Error(`Unknown instance: ${instanceId}`);
      const output = await executeExeAction(control, action, instance);
      await editInteraction(control.token, interaction, `Done: \`${instance.label} ${action}\`\n${output.trim()}`);
      return;
    }

    if (action === "openexe") {
      if (!instance) throw new Error(`Unknown instance: ${instanceId}`);
      const exePath = openAutoClashExe(instance);
      const activationOutput = await activateAutoClashLaunchWindow();
      const cleanOutput = activationOutput.trim() || "AutoClash opened.";
      await editInteraction(control.token, interaction, `${instance.label}: ${cleanOutput}\n\`${exePath}\``);
      return;
    }

    if (action === "closeexe") {
      if (!instance) throw new Error(`Unknown instance: ${instanceId}`);
      const result = await closeAutoClashExe(instance);
      const cleanOutput = result.output.trim() || "AutoClash exe closed.";
      await editInteraction(control.token, interaction, `${instance.label}: ${cleanOutput}\n\`${result.exePath}\``);
      return;
    }

    if (action === "openldplayer") {
      if (!instance) throw new Error(`Unknown instance: ${instanceId}`);
      const output = await openLdPlayer(control, instance);
      await editInteraction(control.token, interaction, `${instance.label}: LDPlayer open command sent.\n${output.trim()}`);
      return;
    }

    if (action === "closeldplayer") {
      if (!instance) throw new Error(`Unknown instance: ${instanceId}`);
      const output = await closeLdPlayer(control, instance);
      await editInteraction(control.token, interaction, `${instance.label}: LDPlayer close command sent.\n${output.trim()}`);
      return;
    }

    if (action === "stats") {
      if (!instance) throw new Error(`Unknown instance: ${instanceId}`);
      console.log(`[control] stats requested for ${instance.label}`);
      const file = await captureStats(control, instance);
      console.log(`[control] stats captured for ${instance.label}: ${file}`);
      await editInteraction(control.token, interaction, `${instance.label} stats captured.`);
      await followupFile(control.token, interaction, `**${instance.label} stats**`, file, { deleteAfterSend: true });
      console.log(`[control] stats sent for ${instance.label}`);
      return;
    }

    if (action === "sessionstats") {
      if (!instance) throw new Error(`Unknown instance: ${instanceId}`);
      await editInteractionEmbed(control.token, interaction, sessionStatsEmbed(instance));
      return;
    }

    if (action === "dailystats") {
      if (!instance) throw new Error(`Unknown instance: ${instanceId}`);
      await editInteractionEmbed(control.token, interaction, dailyStatsEmbed(instance));
      return;
    }

    if (action === "alltimestats") {
      if (!instance) throw new Error(`Unknown instance: ${instanceId}`);
      await editInteractionEmbed(control.token, interaction, allTimeStatsEmbed(instance));
      return;
    }

    if (action === "screen") {
      if (!instance) throw new Error(`Unknown instance: ${instanceId}`);
      const file = await captureAdbScreen(control, instance);
      await editInteraction(control.token, interaction, `${instance.label} screen captured.`);
      await followupFile(control.token, interaction, `**${instance.label} screen**`, file, { deleteAfterSend: true });
      return;
    }

    if (action === "fullscreen") {
      const file = await captureFullScreen();
      await editInteraction(control.token, interaction, "Full screen captured.");
      await followupFile(control.token, interaction, "**Full screen**", file, { deleteAfterSend: true });
      return;
    }

    await editInteraction(control.token, interaction, `Unknown action: ${action}`);
  } catch (error) {
    const details = [error.message, error.stderr, error.stdout]
      .filter(Boolean)
      .join("\n")
      .trim()
      .slice(0, 1800);
    await editInteraction(control.token, interaction, `Error running \`${action}\`:\n\`\`\`text\n${details}\n\`\`\``);
  }
}

async function handleLogLinesInteraction(control, interaction) {
  const id = interaction.data?.custom_id || "";
  if (!id.startsWith("loglines:")) return false;

  const [, key] = id.split(":");
  const log = restartLogsByKey.get(key);
  if (!log) {
    await respondInteraction(control.token, interaction, "This log is no longer active.");
    return true;
  }

  await control.send(log.channelId, `**${log.name} last 10 lines**\n\`\`\`text\n${recentLogLinesText(log, 10)}\n\`\`\``);
  await respondInteraction(control.token, interaction, `Sent last 10 lines for ${log.name}.`);
  return true;
}

// Every control button (start/stop, close exe, full-desktop screenshot, ...)
// runs on the host PC. Without this check, anyone who can see the channel —
// not just the owner — can press them.
function isAuthorizedInteractionUser(control, interaction) {
  if (!control.ownerIds.length) return true;
  return control.ownerIds.includes(interactionUserId(interaction));
}

async function handleGatewayInteraction(control, interaction) {
  if (!isAuthorizedInteractionUser(control, interaction)) {
    await respondInteraction(control.token, interaction, "You are not authorized to control this panel.").catch(() => {});
    return;
  }
  if (await handleLogLinesInteraction(control, interaction)) return;
  await handleControlInteraction(control, interaction);
}

async function startControlGateway(control) {
  const gateway = await discordRequest(control.token, "/gateway/bot");
  const ws = new WebSocketClient(`${gateway.url}/?v=10&encoding=json`);
  discordRuntime.gateway = ws;
  let sequence = null;
  let heartbeatTimer = null;
  let panelSent = false;

  ws.onmessage = async (event) => {
    const packet = JSON.parse(event.data);
    if (packet.s !== null && packet.s !== undefined) sequence = packet.s;

    if (packet.op === 10) {
      heartbeatTimer = setInterval(() => {
        ws.send(JSON.stringify({ op: 1, d: sequence }));
      }, packet.d.heartbeat_interval);

      ws.send(JSON.stringify({
        op: 2,
        d: {
          token: control.token,
          intents: 0,
          properties: {
            os: "windows",
            browser: "discord-log-monitor",
            device: "discord-log-monitor",
          },
        },
      }));
      return;
    }

    if (packet.op === 0 && packet.t === "READY") {
      console.log("AutoClash control gateway connected.");
      if (control.sendPanelOnStart && !panelSent) {
        panelSent = true;
        await renamePanelChannel(control);
        await sendDiscordPayload(control.token, control.channelId, controlPanelPayload(control));
        console.log(`AutoClash control panel sent to channel ${control.channelId}.`);
      }
      return;
    }

    if (packet.op === 0 && packet.t === "INTERACTION_CREATE") {
      handleGatewayInteraction(control, packet.d).catch((error) => console.error("[control]", error.message));
    }
  };

  ws.onclose = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (discordRuntime.gateway === ws) discordRuntime.gateway = null;
    // A stop from the Discord tab is deliberate, so do not reconnect.
    if (!discordRuntime.enabled) {
      console.log("AutoClash control gateway stopped.");
      return;
    }
    console.error("AutoClash control gateway closed. Reconnecting in 5s...");
    setTimeout(() => {
      if (discordRuntime.enabled) startControlGateway(control).catch((error) => console.error("[control]", error.message));
    }, 5000);
  };

  ws.onerror = (error) => {
    console.error("AutoClash control gateway error:", error.message || error);
  };
}

function printStartupBanner() {
  console.log(`
  __  ______  ____  
  \\ \\/ / __ \\/ __ \\ 
   \\  / / / / /_/ / 
   / / /_/ / _, _/  
  /_/\\____/_/ |_|   
  ─── XOR WebMonitor v2.0 ───
  Self-Hosted Control Panel & Stats Monitor
  `);
  console.log("Type 'help' in this terminal at any time for available commands.\n");
}

async function handlePasswordResetCli(newPasswordArg) {
  loadEnv();
  const readline = require("readline");
  let newPassword = String(newPasswordArg || "").trim();

  if (!newPassword || newPassword.startsWith("-")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    newPassword = await new Promise((resolve) => {
      rl.question("\nEnter new web panel password (min 8 characters): ", (ans) => {
        rl.close();
        resolve(String(ans || "").trim());
      });
    });
  }

  if (newPassword.length < 8) {
    console.error("\n[error] Password must be at least 8 characters long.");
    process.exit(1);
  }

  const { makePasswordHash } = require("./web-server");
  const hash = makePasswordHash(newPassword);
  writeEnvFile({ WEB_PASSWORD_HASH: hash });
  console.log("\n[success] Web panel password has been reset successfully!");
  console.log("          Saved to .env as WEB_PASSWORD_HASH.");
  process.exit(0);
}

function startConsoleInterface(logs, control, config) {
  if (!process.stdin.isTTY) return;
  const readline = require("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "xor> ",
  });

  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  function safeLog(writer, args) {
    if (process.stdout.isTTY) {
      try {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
      } catch {}
    }
    writer.apply(console, args);
    if (process.stdout.isTTY) {
      rl.prompt(true);
    }
  }

  console.log = (...args) => safeLog(origLog, args);
  console.error = (...args) => safeLog(origError, args);
  console.warn = (...args) => safeLog(origWarn, args);

  rl.prompt(true);

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "help":
      case "?":
        console.log("\n=======================================================");
        console.log("             XOR WebMonitor Console Commands           ");
        console.log("=======================================================");
        console.log("  help                  : Show this command menu");
        console.log("  reset-password [pass] : Reset the web panel admin password");
        console.log("  status                : Display status for all instances");
        console.log("  stats                 : Display latest session stats");
        console.log("  instances             : List active windows and ADB ports");
        console.log("  restart               : Restart the monitor server");
        console.log("  clear / cls           : Clear terminal screen");
        console.log("  exit / quit           : Stop and exit monitor");
        console.log("=======================================================\n");
        break;

      case "reset-password":
      case "passwd":
      case "password": {
        let newPass = args.join(" ").trim();
        if (!newPass) {
          rl.question("Enter new password (min 8 chars): ", (ans) => {
            const pass = String(ans || "").trim();
            if (pass.length < 8) {
              console.log("[error] Password must be at least 8 characters.");
            } else {
              const { makePasswordHash } = require("./web-server");
              const hash = makePasswordHash(pass);
              writeEnvFile({ WEB_PASSWORD_HASH: hash });
              console.log("[success] Password reset successfully in .env!");
            }
            rl.prompt();
          });
          return;
        } else if (newPass.length < 8) {
          console.log("[error] Password must be at least 8 characters.");
        } else {
          const { makePasswordHash } = require("./web-server");
          const hash = makePasswordHash(newPass);
          writeEnvFile({ WEB_PASSWORD_HASH: hash });
          console.log("[success] Password reset successfully in .env!");
        }
        break;
      }

      case "status":
        console.log("\n--- Instances Status ---");
        if (!logs.length) {
          console.log("No logs/instances configured yet.");
        } else {
          for (const log of logs) {
            const inst = findControlInstanceForLog(log, config);
            const run = inst ? instanceRunStateCached(inst) : null;
            let accInfo = "";
            if (run?.account) {
              accInfo = ` | Account: ${run.account}${run.thLevel ? ` (${run.thLevel})` : ""}`;
              if (run.multiVillage?.enabled && run.running && run.multiVillage.remainingText) {
                accInfo += ` [⏳ ${run.multiVillage.remainingText}${run.multiVillage.nextAccount ? ` → Next: ${run.multiVillage.nextAccount}` : ""}]`;
              }
            }
            console.log(`[${log.name}] Status: ${log.status}${accInfo} | Last Activity: ${ago(log.lastActivity)}`);
          }
        }
        console.log("------------------------\n");
        break;

      case "stats":
        console.log("\n--- Latest Session Stats ---");
        if (!control.instances.length) {
          console.log("No instances configured.");
        } else {
          for (const inst of control.instances) {
            try {
              const res = latestSessionStats(inst);
              if (res?.stats) {
                const s = res.stats;
                console.log(`[${inst.label}] Attacks: ${s.total_attacks || 0} | Gold: ${compactNumber(s.gold_gained)} | Elixir: ${compactNumber(s.elixir_gained)} | Dark: ${compactNumber(s.dark_gained)} | Runtime: ${s.runtime || formatDuration(s.runtime_seconds)}`);
              } else {
                console.log(`[${inst.label}] No stats found yet.`);
              }
            } catch (err) {
              console.log(`[${inst.label}] Stats error: ${err.message}`);
            }
          }
        }
        console.log("----------------------------\n");
        break;

      case "instances":
        console.log("\n--- AutoClash Instances ---");
        for (const inst of control.instances) {
          const run = instanceRunStateCached(inst);
          let accInfo = run.account ? ` | Account: ${run.account}${run.thLevel ? ` (${run.thLevel})` : ""}` : "";
          if (run.multiVillage?.enabled && run.running && run.multiVillage.remainingText) {
            accInfo += ` | Rotation: ${run.multiVillage.remainingText} (Next: ${run.multiVillage.nextAccount || "N/A"})`;
          }
          console.log(`- ID: ${inst.id} | Label: ${inst.label} | Device: ${inst.device || "none"} | AutoStart: ${inst.active ? "ON" : "OFF"}${accInfo}`);
        }
        console.log("---------------------------\n");
        break;

      case "clear":
      case "cls":
        console.clear();
        printStartupBanner();
        break;

      case "restart":
        console.log("[xor] Restarting monitor...");
        rl.close();
        process.exit(0);
        break;

      case "exit":
      case "quit":
        console.log("[xor] Stopping XOR WebMonitor...");
        rl.close();
        process.exit(0);
        break;

      default:
        console.log(`Unknown command: "${cmd}". Type "help" for a list of commands.`);
        break;
    }

    rl.prompt();
  });
}

async function main() {
  loadEnv();
  printStartupBanner();

  // Discord is optional and can be started or stopped later from the web panel.
  // "configured" means a token and channel exist; "enabled" means it is running.
  const token = String(process.env.DISCORD_TOKEN || "").trim();
  const fallbackChannelId = String(process.env.DISCORD_CHANNEL_ID || "").trim();
  discordRuntime.configured = Boolean(token && fallbackChannelId);
  discordRuntime.token = token;
  discordRuntime.channelId = fallbackChannelId;
  discordRuntime.enabled = discordRuntime.configured && parseBooleanEnv("DISCORD_ENABLED", true);

  if (!discordRuntime.configured) {
    console.log("Discord is not configured (no token or channel). Running web-only.");
  } else if (!discordRuntime.enabled) {
    console.log("Discord is configured but stopped. Start it from the Discord tab.");
  }
  // A fresh install has no .env at all. The web server still has to start so
  // the setup wizard is reachable — throwing here would leave a new user with a
  // console error and no way in.
  const rawLogFiles = String(process.env.LOG_FILES || "").trim();
  const logs = rawLogFiles ? parseLogFiles(rawLogFiles) : [];
  const state = loadState();
  const control = autoControlConfig(token, fallbackChannelId);
  const configured = logs.length > 0 && control.instances.length > 0;

  if (!configured) {
    console.log("Not configured yet — open the web panel and run setup.");
  }

  for (const log of logs) {
    log.channelId = optionalChannelId(envKeyForLog(log.name, "CHANNEL_ID")) || fallbackChannelId;
    log.channelBaseName =
      process.env[envKeyForLog(log.name, "CHANNEL_NAME")] || defaultChannelName(log.name);
    applySavedState(log, state);
    restartLogsByKey.set(restartKeyForLog(log), log);
  }

  const config = {
    checkIntervalSeconds: Number(process.env.CHECK_INTERVAL_SECONDS || 5),
    stalledAfterSeconds: Number(process.env.STALLED_AFTER_SECONDS || 120),
    maxLinesPerCheck: Number(process.env.MAX_LINES_PER_CHECK || 20),
    maxStoredLines: Number(process.env.MAX_STORED_LINES || 40),
    liveLogEnabled: parseBooleanEnv("LIVE_LOG_ENABLED", false),
    liveLogIntervalSeconds: Math.max(10, Number(process.env.LIVE_LOG_INTERVAL_SECONDS || 10)),
    liveLogMaxThreadMessages: Number.isFinite(Number(process.env.LIVE_LOG_MAX_THREAD_MESSAGES))
      ? Math.max(100, Number(process.env.LIVE_LOG_MAX_THREAD_MESSAGES))
      : 10000,
    visualCheckEnabled: parseBooleanEnv("COC_VISUAL_CHECK_ENABLED", true),
    visualCheckIntervalSeconds: Number.isFinite(Number(process.env.COC_VISUAL_CHECK_INTERVAL_SECONDS))
      ? Math.max(15, Number(process.env.COC_VISUAL_CHECK_INTERVAL_SECONDS))
      : 30,
    adbRecoveryStopDelaySeconds: Number.isFinite(Number(process.env.ADB_RECOVERY_STOP_DELAY_SECONDS))
      ? Math.max(0, Number(process.env.ADB_RECOVERY_STOP_DELAY_SECONDS))
      : 8,
    adbRecoveryStartDelaySeconds: Number.isFinite(Number(process.env.ADB_RECOVERY_START_DELAY_SECONDS))
      ? Math.max(0, Number(process.env.ADB_RECOVERY_START_DELAY_SECONDS))
      : 5,
    autoRestartMode: ["off", "auto"].includes(String(process.env.AUTO_RESTART_MODE || "").toLowerCase())
      ? String(process.env.AUTO_RESTART_MODE).toLowerCase()
      : "off",
    control,
    state,
    // Every Discord call routes through these wrappers and checks the runtime
    // flag at call time, so Start/Stop on the Discord tab takes effect
    // immediately. Inert calls return message-shaped objects so the callers
    // need no special case.
    send: (channelId, message, allowedMentions) =>
      discordRuntime.enabled ? sendDiscordMessage(discordRuntime.token, channelId, message, allowedMentions) : undefined,
    // When Discord is stopped the upload is skipped, but deleteAfterSend still
    // has to happen or recovery screenshots pile up on disk.
    sendFile: (channelId, content, filePath, options) => {
      if (discordRuntime.enabled) return sendDiscordFile(discordRuntime.token, channelId, content, filePath, options);
      if (options?.deleteAfterSend) deleteFileQuietly(filePath);
      return undefined;
    },
    createThread: (channelId, name) =>
      discordRuntime.enabled ? createDiscordThread(discordRuntime.token, channelId, name) : { id: null },
    sendPayload: (channelId, payload) =>
      discordRuntime.enabled ? sendDiscordPayload(discordRuntime.token, channelId, payload) : { id: null },
    editPayload: (channelId, messageId, payload) =>
      discordRuntime.enabled ? editDiscordPayload(discordRuntime.token, channelId, messageId, payload) : undefined,
    deleteMessage: (channelId, messageId) =>
      discordRuntime.enabled ? deleteDiscordMessage(discordRuntime.token, channelId, messageId) : undefined,
    pinMessage: (channelId, messageId) =>
      discordRuntime.enabled ? pinDiscordMessage(discordRuntime.token, channelId, messageId) : undefined,
    deleteChannel: (channelId) =>
      discordRuntime.enabled ? deleteDiscordChannel(discordRuntime.token, channelId) : undefined,
    renameChannel: (channelId, name) =>
      discordRuntime.enabled ? renameDiscordChannel(discordRuntime.token, channelId, name) : undefined,
  };

  // Wipes this bot's previous panels, status embeds and abandoned live threads
  // so a restart leaves one clean set of messages instead of stacking copies.
  // Only messages this bot authored are removed.
  async function cleanUpOwnChannels() {
    const botId = await discordSelfId(discordRuntime.token).catch(() => null);
    if (!botId) {
      console.error("[clean] Could not identify the bot user; skipping cleanup.");
      return;
    }

    // Live threads recorded in state that no longer belong to a current log.
    const currentThreads = new Set(logs.map((log) => log.liveThreadId).filter(Boolean));
    for (const [key, saved] of Object.entries(state)) {
      if (!saved?.liveThreadId || currentThreads.has(saved.liveThreadId)) continue;
      try {
        await deleteDiscordChannel(discordRuntime.token, saved.liveThreadId);
        console.log(`[clean] Removed abandoned live thread from ${key}.`);
      } catch (error) {
        if (!isUnknownDiscordChannelError(error)) {
          console.error(`[clean] Could not remove thread ${saved.liveThreadId}: ${error.message}`);
        }
      }
      delete state[key];
    }

    // Forget message ids we are about to delete, so nothing tries to edit them.
    for (const log of logs) {
      log.statusMessageId = null;
      log.statusPinnedMessageId = null;
      log.alertMessageId = null;
      log.liveThreadId = null;
      log.liveThreadMessageCount = 0;
      rememberLogState(log, state);
    }
    saveState(state);

    const channels = new Set([control.channelId, ...logs.map((log) => log.channelId)].filter(Boolean));
    for (const channelId of channels) {
      const removed = await purgeOwnMessages(discordRuntime.token, channelId, botId);
      if (removed) console.log(`[clean] Removed ${removed} old bot message(s) from channel ${channelId}.`);
    }
  }

  // Starting and stopping the Discord side, driven by the web panel's Discord tab.
  async function startDiscord({ sendPanel } = {}) {
    if (!discordRuntime.configured) throw new Error("Discord is not configured. Add DISCORD_TOKEN and DISCORD_CHANNEL_ID in Settings.");
    if (discordRuntime.enabled && discordRuntime.gateway) return "Discord is already running.";

    discordRuntime.enabled = true;
    discordRuntime.lastError = "";
    discordRuntime.startedAt = Date.now();

    try {
      if (parseBooleanEnv("DISCORD_CLEAN_ON_START", true)) {
        await cleanUpOwnChannels();
      }

      if (control.enabled && (sendPanel ?? control.sendPanelOnStart)) {
        await renamePanelChannel(control).catch((e) => console.error("[control]", `Rename panel channel note: ${e.message}`));
        await sendDiscordPayload(discordRuntime.token, control.channelId, controlPanelPayload(control));
      }
      const gatewayControl = { ...control, sendPanelOnStart: false };
      gatewayControl.send = (channelId, message, allowedMentions) =>
        sendDiscordMessage(discordRuntime.token, channelId, message, allowedMentions);
      await startControlGateway(gatewayControl);

      for (const log of logs) {
        await updateChannelName(log, config).catch(() => {});
        await upsertStatusEmbed(log, config).catch(() => {});
      }
      webEmit({ type: "discord", output: "Discord bot started." });
      return "Discord bot started.";
    } catch (error) {
      discordRuntime.enabled = false;
      discordRuntime.lastError = error.message;
      throw error;
    }
  }

  function stopDiscord() {
    if (!discordRuntime.enabled) return "Discord is already stopped.";
    discordRuntime.enabled = false;
    // Cleared before close so the onclose handler treats this as deliberate.
    const gateway = discordRuntime.gateway;
    discordRuntime.gateway = null;
    try {
      gateway?.close();
    } catch (error) {
      console.error("[control]", `Gateway close failed: ${error.message}`);
    }
    webEmit({ type: "discord", output: "Discord bot stopped." });
    return "Discord bot stopped.";
  }

  function discordStatus() {
    return {
      configured: discordRuntime.configured,
      running: discordRuntime.enabled,
      connected: Boolean(discordRuntime.gateway),
      startedAt: discordRuntime.startedAt,
      lastError: discordRuntime.lastError,
      channelId: discordRuntime.channelId,
      controlPanelEnabled: Boolean(control.enabled),
      logChannels: logs.map((log) => ({ name: log.name, channelId: log.channelId })),
    };
  }

  if (parseBooleanEnv("WEB_ENABLED", true)) {
    const web = startWebServer({
      logs,
      control,
      resolveInstance: (id) => resolveControlInstance(control, id),
      exeAction: (action, instance) => executeExeAction(control, action, instance),
      // Launching leaves AutoClash on its "Enter License Key" dialog, so the
      // activation click has to follow - same as the Discord button does.
      openExe: async (instance) => {
        const exePath = openAutoClashExe(instance);
        try {
          const output = (await activateAutoClashLaunchWindow()).trim();
          return `${output || "AutoClash opened."}\n${exePath}`;
        } catch (error) {
          return `AutoClash opened, but the Activate click failed: ${error.message}\n${exePath}`;
        }
      },

      // One-press remote launch: open, click Activate, wait for the window,
      // then Stop/Start with retries until the log actually moves. Opening and
      // pressing Start separately does not work remotely, because activation
      // polls for up to 20s and an immediate Start lands on the wrong window.
      //
      // Runs detached and reports through webEmit: the full sequence can take a
      // few minutes, far longer than an HTTP request should stay open.
      launch: (instance) => {
        const log = findLogForControlInstance(instance, logs, config);
        if (!log) throw new Error(`No log is mapped to ${instance.label}, so a launch cannot be confirmed.`);

        const progress = async (_channelId, message) => {
          webEmit({ type: "launch", instance: instance.label, output: String(message).replace(/`/g, "") });
        };

        startAutoClashInstanceAndWaitForLog(instance, log, config, progress)
          .then((result) => {
            webEmit({ type: "launch", instance: instance.label, output: `Launched and confirmed writing log lines after ${result.attempts} attempt(s).` });
            recordIncident(config, {
              kind: "launch",
              severity: "info",
              logName: log.name,
              instanceLabel: instance.label,
              message: `${instance.label} launched from the web panel and is writing log lines.`,
            });
          })
          .catch((error) => {
            webEmit({ type: "launch-failed", instance: instance.label, output: error.message });
            recordIncident(config, {
              kind: "launch-failed",
              severity: "error",
              logName: log.name,
              instanceLabel: instance.label,
              message: `${instance.label} failed to launch from the web panel: ${error.message}`,
              capture: instance,
            });
          });

        return `Launching ${instance.label}: opening, activating, then starting. Watch the log tab.`;
      },
      closeExe: async (instance) => (await closeAutoClashExe(instance)).output,
      openLd: (instance) => openLdPlayer(control, instance),
      closeLd: (instance) => closeLdPlayer(control, instance),
      screen: (instance) => captureAdbScreen(control, instance),
      liveFrame: (instance) => captureLiveFrame(control, instance),
      fullScreen: () => captureFullScreen(),
      discordStatus,
      startDiscord,
      stopDiscord,
      configured,
      detectAccess: (port) => detectAccess(port),
      detectInstances: () => detectInstances(),
      detectAdbDevices: (adbPath) => detectAdbDevices(adbPath || control.adbPath),
      applySetup: (payload) => {
        const result = applySetup(payload);
        const rawLogs = String(process.env.LOG_FILES || "").trim();
        const newLogs = rawLogs ? parseLogFiles(rawLogs) : [];
        logs.length = 0;
        logs.push(...newLogs);

        const token = process.env.DISCORD_TOKEN;
        const fallbackChannelId = String(process.env.DISCORD_CHANNEL_ID || "").trim();
        const newControl = autoControlConfig(token, fallbackChannelId);
        control.instances = newControl.instances;
        control.enabled = newControl.enabled;
        control.channelId = newControl.channelId;
        control.channelName = newControl.channelName;
        control.token = newControl.token;
        control.ownerIds = newControl.ownerIds;
        control.adbPath = newControl.adbPath;
        control.emulator = newControl.emulator;

        discordRuntime.token = token;
        discordRuntime.channelId = fallbackChannelId;
        discordRuntime.configured = Boolean(token && fallbackChannelId);
        discordRuntime.enabled = discordRuntime.configured && parseBooleanEnv("DISCORD_ENABLED", true);

        for (const log of logs) {
          log.channelId = optionalChannelId(envKeyForLog(log.name, "CHANNEL_ID")) || fallbackChannelId;
          log.channelBaseName =
            process.env[envKeyForLog(log.name, "CHANNEL_NAME")] || defaultChannelName(log.name);
          applySavedState(log, state);
          restartLogsByKey.set(restartKeyForLog(log), log);
        }

        startMonitoringLoop();
        if (discordRuntime.configured && discordRuntime.enabled) {
          startDiscord().catch((error) => console.error("[control]", `Discord startup failed: ${error.message}`));
        }
        webEmit({ type: "state-update" });
        return result;
      },
      testDiscord: (token, channelId) => testDiscord(token, channelId),
      readIncidents: (limit) => readIncidents(limit),
      incidentDir,
      runState: (instance) => instanceRunState(instance),
      runStateCached: (instance) => instanceRunStateCached(instance),
      accounts: (instance) => listAccounts(instance),
      runtimeStateKeys: () => [...RUNTIME_STATE_KEYS],
      configEnums: () => discoverEnums(control.instances),
      schemaDiff: (scope, keys) => diffSchema(scope, keys),
      readInstanceConfig: (instance) => readJsonQuietly(instanceConfigPath(instance)),
      readAccountConfig: (instance, account) => readJsonQuietly(accountConfigPath(instance, account)),
      // Writes refuse unless the instance is fully stopped; the check happens
      // here, server-side, never on the browser's word.
      writeInstanceConfig: async (instance, updates) => {
        const state = await instanceRunState(instance);
        if (state.running) throw new Error(`${instance.label} is still running (${state.processCount} process(es)). Close the exe first.`);
        return writeConfigFile(instanceConfigPath(instance), updates);
      },
      writeAccountConfig: async (instance, account, updates) => {
        const state = await instanceRunState(instance);
        if (state.running) throw new Error(`${instance.label} is still running (${state.processCount} process(es)). Close the exe first.`);
        const target = accountConfigPath(instance, account);
        if (!target) throw new Error(`Unknown account: ${account}`);
        return writeConfigFile(target, updates);
      },
      revertConfig: async (instance, account) => {
        const state = await instanceRunState(instance);
        if (state.running) throw new Error(`${instance.label} is still running. Close the exe first.`);
        const target = account ? accountConfigPath(instance, account) : instanceConfigPath(instance);
        if (!target) throw new Error(`Unknown account: ${account}`);
        const backup = newestBackup(target);
        if (!backup) throw new Error("No backup to restore.");
        fs.copyFileSync(backup, target);
        return { restored: path.basename(backup) };
      },
      history: (instance, days, sessions) => statsHistory(instance, days, sessions),
      dailySummary: (dayKey) => buildDailySummary(control, dayKey),
      screenSize: (instance) => adbScreenSize(control, instance),
      tap: (instance, xRatio, yRatio) => adbTap(control, instance, xRatio, yRatio),
      pushStatus: () => {
        const push = pushConfig();
        return { enabled: push.enabled, server: push.server, minSeverity: push.minSeverity, topicSet: Boolean(push.topic) };
      },
      testPush: () =>
        sendPush({
          kind: "test",
          severity: "error",
          instance: null,
          message: "Test notification from the AutoClash web monitor. If you can read this, phone alerts work.",
        }),
      sessionStats: (instance) => sessionStatsEmbed(instance),
      dailyStats: (instance) => dailyStatsEmbed(instance),
      allTimeStats: (instance) => allTimeStatsEmbed(instance),
      // Raw numbers so the web panel can lay out Main and Builder separately
      // instead of unpacking a Discord-shaped embed.
      sessionStatsRaw: (instance) => latestSessionStats(instance),
      dailyStatsRaw: (instance) => dailyStatsFromDb(instance),
      allTimeStatsRaw: (instance) => allTimeStatsFallback(instance),
      statusEmbed: (log) => buildStatusEmbed(log, config),
      recentLines: (log, count) => recentLogLinesText(log, count),
      logHealth: (log) => logHealthSummary(log),
      checkUpdate: (instance) => runAutoClashUpdateHandler(instance, config),
      updateFlags: () => Object.fromEntries(autoClashUpdateStatus),
      readConfig: () => readEnvFile(),
      saveConfig: (updates) => writeEnvFile(updates),
    });
    webEmit = web.emit;
  }

  cleanupScreenshots();
  setInterval(() => cleanupScreenshots(), 30 * 60 * 1000);

  // Daily summary: posted once, the first time the clock passes the configured
  // hour. state.lastDailySummary keeps it to one per day across restarts.
  const summaryHour = Math.min(23, Math.max(0, Number(process.env.DAILY_SUMMARY_HOUR ?? 9)));
  async function maybeSendDailySummary() {
    if (!parseBooleanEnv("DAILY_SUMMARY_ENABLED", true)) return;

    const now = new Date();
    if (now.getHours() < summaryHour) return;

    const today = dayKeyFor(now);
    if (state.lastDailySummary === today) return;

    // Summarise the day that just finished, not the one in progress.
    const yesterday = dayKeyFor(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    state.lastDailySummary = today;
    saveState(state);

    try {
      const summary = buildDailySummary(control, yesterday);
      const embed = dailySummaryEmbed(summary);
      webEmit({ type: "daily-summary", summary });
      // Returns nothing when Discord is off, and claiming "sent" in that case
      // is just untrue in the console.
      const posted = await config.sendPayload(control.channelId || logs[0]?.channelId, { embeds: [embed] });
      await sendPush({
        kind: "daily summary",
        severity: "info",
        instance: null,
        message: `${yesterday}: ${fullNumber(summary.totals.attacks)} attacks, ${compactNumber(summary.totals.gold)} gold, ${summary.incidents.errors} error(s).`,
      });
      console.log(
        posted
          ? `[summary] Daily summary for ${yesterday} sent.`
          : `[summary] Daily summary for ${yesterday} ready — Discord is off, it is on the panel only.`
      );
    } catch (error) {
      console.error(`[summary] Could not send daily summary: ${error.message}`);
    }
  }

  setTimeout(maybeSendDailySummary, 20000);
  setInterval(maybeSendDailySummary, 15 * 60 * 1000);

  if (discordRuntime.enabled) {
    // enabled is set again inside startDiscord; clear it so the guard there
    // does not treat this boot as "already running".
    discordRuntime.enabled = false;
    startDiscord().catch((error) => console.error("[control]", `Discord startup failed: ${error.message}`));
  }

  let monitoringStarted = false;
  function startMonitoringLoop() {
    if (monitoringStarted) return;
    if (logs.length === 0 || control.instances.length === 0) return;
    monitoringStarted = true;

    // Spread the expensive per-instance checks (update / visual / stuck)
    logs.forEach((log, index) => {
      const offset = index * Math.max(1000, Number(process.env.CHECK_STAGGER_MS || 7000));
      log.lastVisualCheckAt = Date.now() - config.visualCheckIntervalSeconds * 1000 + offset;
      log.lastStuckCheckAt = Date.now() + offset;
      log.lastAutoUpdateCheckAt = Date.now() - 30000 + offset;
    });

    logs.forEach(initializeLog);

    console.log("Bot connected. Watching:");
    logs.forEach((log) => console.log(`- ${log.name}: ${log.path} -> channel ${log.channelId}`));

    const checkConcurrency = Math.max(1, Number(process.env.CHECK_CONCURRENCY || 3));
    let checkInFlight = false;

    async function checkAllLogs() {
      if (checkInFlight) return;
      checkInFlight = true;

      try {
        const queue = [...logs];
        const workers = Array.from({ length: Math.min(checkConcurrency, queue.length) }, async () => {
          while (queue.length) {
            const log = queue.shift();
            try {
              await checkLog(log, config);
            } catch (error) {
              console.error(`[${log.name}]`, error.message);
            }
          }
        });
        await Promise.all(workers);
      } finally {
        checkInFlight = false;
      }
    }

    setInterval(checkAllLogs, config.checkIntervalSeconds * 1000);

    runAutoStartSequence(logs, config).catch((error) => {
      console.error("[autostart]", error.message);
    });

    if (config.liveLogEnabled) {
      console.log(`Live log thread mode enabled. Interval=${config.liveLogIntervalSeconds}s. Max thread messages=${config.liveLogMaxThreadMessages}.`);
      setInterval(async () => {
        for (const log of logs) {
          try {
            await flushLiveLog(log, config);
          } catch (error) {
            console.error(`[${log.name}] live log`, error.message);
          }
        }
      }, config.liveLogIntervalSeconds * 1000);
    }
  }

  if (configured) {
    startMonitoringLoop();
  } else {
    console.log("Monitoring is idle until setup completes.");
  }

  startConsoleInterface(logs, control, config);
}

const RESET_FLAG_INDEX = process.argv.findIndex((arg) => arg === "--reset-password" || arg === "-r");
if (RESET_FLAG_INDEX !== -1) {
  const argValue = process.argv[RESET_FLAG_INDEX + 1];
  handlePasswordResetCli(argValue);
} else {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
