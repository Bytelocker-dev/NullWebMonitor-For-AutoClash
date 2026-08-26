"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
console.log("\x1b[36mSweeping XOR WebMonitor workspace artifacts...\x1b[0m\n");

let cleaned = 0;

function removeSafe(itemPath) {
  try {
    if (fs.existsSync(itemPath)) {
      const stat = fs.statSync(itemPath);
      if (stat.isDirectory()) {
        fs.rmSync(itemPath, { recursive: true, force: true });
        console.log(`  Purged dir:  ${path.relative(root, itemPath)}`);
      } else {
        fs.unlinkSync(itemPath);
        console.log(`  Purged file: ${path.relative(root, itemPath)}`);
      }
      cleaned += 1;
    }
  } catch (err) {
    console.warn(`  Could not remove ${itemPath}: ${err.message}`);
  }
}

// 1. Remove temp test folders
const entries = fs.readdirSync(root);
for (const name of entries) {
  if (name.startsWith("temp-") || name.startsWith("smoke-") || name.endsWith(".tmp")) {
    removeSafe(path.join(root, name));
  }
}

// 2. Remove test session & pid artifacts
const transientFiles = [
  path.join(root, "web-sessions.json"),
  path.join(root, "crash-log.txt"),
  path.join(root, "monitor.pid"),
  path.join(root, "bot-state.json"),
  path.join(root, "scripts", "migrate-tests.js"),
];

for (const file of transientFiles) {
  removeSafe(file);
}

// 3. Clean temporary screenshots older than 1 hour in control-screenshots/
const screenshotsDir = path.join(root, "control-screenshots");
if (fs.existsSync(screenshotsDir)) {
  const cutoff = Date.now() - 3600 * 1000;
  for (const img of fs.readdirSync(screenshotsDir)) {
    const full = path.join(screenshotsDir, img);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        cleaned += 1;
      }
    } catch {}
  }
}

console.log(`\n\x1b[32m✔ Workspace clean complete. Removed ${cleaned} item(s).\x1b[0m`);
