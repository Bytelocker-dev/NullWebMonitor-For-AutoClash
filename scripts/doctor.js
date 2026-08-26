"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const { execFile, execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");

function checkNode() {
  const version = process.version;
  const major = parseInt(version.slice(1).split(".")[0], 10);
  return {
    name: "Node.js Runtime",
    status: major >= 18 ? "ok" : "warn",
    detail: `Node ${version} (${process.platform} ${process.arch})`,
    help: major < 18 ? "Upgrade Node.js to version 18 or higher." : null,
  };
}

function checkPortAvailable(port = 8477, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (err) => {
      resolve({
        name: `Web Port Availability (${port})`,
        status: err.code === "EADDRINUSE" ? "warn" : "fail",
        detail: `Port ${port} is currently in use or unavailable (${err.code}).`,
        help: "If XOR WebMonitor is already running, this is normal. Otherwise change WEB_PORT in .env.",
      });
    });
    s.once("listening", () => {
      s.close(() => {
        resolve({
          name: `Web Port Availability (${port})`,
          status: "ok",
          detail: `Port ${port} is free on ${host}.`,
        });
      });
    });
    s.listen(port, host);
  });
}

function checkAdb() {
  // Candidate ADB paths
  const candidates = [
    process.env.ADB_PATH,
    "C:\\Program Files\\Netease\\MuMuPlayerGlobal-12.0\\shell\\adb.exe",
    "C:\\Program Files\\Microvirt\\MEmu\\adb.exe",
    "C:\\LDPlayer\\LDPlayer9\\adb.exe",
    "C:\\Program Files\\LDPlayer\\LDPlayer9\\adb.exe",
  ].filter(Boolean);

  let adbPath = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      adbPath = c;
      break;
    }
  }

  // Also check instance folders on desktop
  const desktop = path.join(process.env.USERPROFILE || "", "Desktop", "AutoClash");
  if (!adbPath && fs.existsSync(desktop)) {
    try {
      for (const dir of fs.readdirSync(desktop)) {
        const p = path.join(desktop, dir, "tools", "adb", "adb.exe");
        if (fs.existsSync(p)) {
          adbPath = p;
          break;
        }
      }
    } catch {}
  }

  if (!adbPath) {
    return Promise.resolve({
      name: "Android Debug Bridge (ADB)",
      status: "warn",
      detail: "No adb.exe found in default emulator directories or .env ADB_PATH.",
      help: "Set ADB_PATH in .env or configure it in Settings.",
      devices: [],
    });
  }

  return new Promise((resolve) => {
    execFile(adbPath, ["devices"], { timeout: 4000 }, (err, stdout) => {
      if (err) {
        return resolve({
          name: "Android Debug Bridge (ADB)",
          status: "warn",
          detail: `Found ${adbPath} but adb devices timed out or failed: ${err.message}`,
          help: "Ensure your emulator (MuMu / LDPlayer) is open.",
          devices: [],
        });
      }
      const lines = stdout.split(/\r?\n/).slice(1).map(l => l.trim()).filter(Boolean);
      const devices = lines.map(l => l.split(/\s+/)[0]).filter(Boolean);
      resolve({
        name: "Android Debug Bridge (ADB)",
        status: devices.length > 0 ? "ok" : "warn",
        detail: `Found ${adbPath} — ${devices.length} attached device(s): ${devices.join(", ") || "None"}`,
        help: devices.length === 0 ? "Launch LDPlayer / MuMu Player to connect your emulators." : null,
        devices,
      });
    });
  });
}

function checkEnv() {
  const envPath = path.join(root, ".env");
  const exists = fs.existsSync(envPath);
  if (!exists) {
    return {
      name: "Environment Configuration (.env)",
      status: "warn",
      detail: ".env file is missing (Setup Wizard will create it on first run).",
      help: "Visit http://localhost:8477 to complete the Setup Wizard.",
    };
  }
  const content = fs.readFileSync(envPath, "utf8");
  const hasHash = content.includes("WEB_PASSWORD_HASH");
  const hasPlain = content.includes("WEB_PASSWORD=");
  return {
    name: "Environment Configuration (.env)",
    status: "ok",
    detail: `.env present (${hasHash ? "Password hashed via scrypt" : hasPlain ? "Plaintext password (will auto-hash on boot)" : "Setup complete"})`,
  };
}

function checkTailscale() {
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-Command", "Get-NetIPAddress -InterfaceAlias '*Tailscale*' -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress"], { timeout: 3000 }, (err, stdout) => {
      const ip = stdout ? stdout.trim() : "";
      if (ip && ip.startsWith("100.")) {
        resolve({
          name: "Tailscale Mesh Network",
          status: "ok",
          detail: `Tailscale active on ${ip}`,
        });
      } else {
        resolve({
          name: "Tailscale Mesh Network",
          status: "info",
          detail: "Tailscale IP not detected. (Remote phone access will use LAN or Cloudflare).",
          help: "Install Tailscale if you want encrypted phone access away from home.",
        });
      }
    });
  });
}

async function runDoctor() {
  const results = [];
  results.push(checkNode());
  results.push(checkEnv());
  results.push(await checkPortAvailable(process.env.WEB_PORT || 8477));
  results.push(await checkAdb());
  results.push(await checkTailscale());
  return results;
}

if (require.main === module) {
  (async () => {
    console.log("\x1b[35m=== XOR WebMonitor System Doctor ===\x1b[0m\n");
    const results = await runDoctor();
    for (const r of results) {
      const color = r.status === "ok" ? "\x1b[32m[OK]  \x1b[0m" : r.status === "warn" ? "\x1b[33m[WARN]\x1b[0m" : "\x1b[36m[INFO]\x1b[0m";
      console.log(`${color} \x1b[1m${r.name}\x1b[0m`);
      console.log(`       ${r.detail}`);
      if (r.help) console.log(`       \x1b[90m→ ${r.help}\x1b[0m`);
      console.log();
    }
    console.log("\x1b[32mDiagnostic check complete.\x1b[0m");
  })();
}

module.exports = { runDoctor };
