const assert = require("assert");
const fs = require("fs");
const path = require("path");

const botSrc = fs.readFileSync(path.join(__dirname, "bot.js"), "utf8");
function grab(name) {
  const match = botSrc.match(new RegExp(`function ${name}\\b[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`Function not found: ${name}`);
  return match[0];
}

const mod = {};
new Function("exports", "fs", "path", [
  "const instanceAccountTracking = new Map();",
  grab("parseBooleanValue"),
  grab("readJsonQuietly"),
  grab("resolveAutoClashExePath"),
  grab("profilesDirForInstance"),
  grab("instanceConfigPath"),
  grab("accountConfigPath"),
  grab("listAccounts"),
  grab("autoClashRootDir"),
  grab("lineClockToDate"),
  grab("parseLogFileNameDate"),
  grab("scanLogTailForProfile"),
  grab("extractThLevel"),
  grab("resolveInstanceAccountDetails"),
  "exports.extractThLevel = extractThLevel;",
  "exports.resolveInstanceAccountDetails = resolveInstanceAccountDetails;",
].join("\n"))(mod, fs, path);

// Test 1: Town Hall extraction from various profile naming conventions & config
assert.strictEqual(mod.extractThLevel("TH18"), "TH18");
assert.strictEqual(mod.extractThLevel("th 17"), "TH17");
assert.strictEqual(mod.extractThLevel("Main-th18-farm"), "TH18");
assert.strictEqual(mod.extractThLevel("TownHall 16"), "TH16");
assert.strictEqual(mod.extractThLevel("TH-15_Account"), "TH15");
assert.strictEqual(mod.extractThLevel("MyVillage", { TOWNHALL_LEVEL: 14 }), "TH14");
assert.strictEqual(mod.extractThLevel("UnknownAccount"), "");

// Test 2: Multi-Village rotation resolution with mock profiles folder
const tempDir = fs.mkdtempSync(path.join(path.dirname(__filename), "temp-acct-"));
const profilesDir = path.join(tempDir, "profiles");
const acc1Dir = path.join(profilesDir, "TH18-Main");
const acc2Dir = path.join(profilesDir, "TH17-Alt");

fs.mkdirSync(acc1Dir, { recursive: true });
fs.mkdirSync(acc2Dir, { recursive: true });

// Write instance config with multi-village enabled (45 min switch)
fs.writeFileSync(path.join(profilesDir, "config.json"), JSON.stringify({
  MULTI_VILLAGE_ENABLED: true,
  VILLAGE_SWITCH_MINUTES: 45,
  VILLAGE_SWITCH_CONDITION: "Time",
  START_PROFILE: "TH18-Main",
}), "utf8");

// Write active profiles
fs.writeFileSync(path.join(profilesDir, "active_profiles.json"), JSON.stringify({
  profiles: {
    "TH18-Main": true,
    "TH17-Alt": true,
  },
}), "utf8");

// Write account configs
fs.writeFileSync(path.join(acc1Dir, "config.json"), JSON.stringify({ HOME_UPGRADE_ENABLED: true }), "utf8");
fs.writeFileSync(path.join(acc2Dir, "config.json"), JSON.stringify({ HOME_UPGRADE_ENABLED: false }), "utf8");

const mockInstance = { id: "test-inst", exePath: tempDir };

// Check stopped state (falls back to START_PROFILE)
const stoppedRes = mod.resolveInstanceAccountDetails(mockInstance, "", false);
assert.strictEqual(stoppedRes.account, "TH18-Main", "Start profile used when stopped");
assert.strictEqual(stoppedRes.thLevel, "TH18", "TH18 detected");
assert.strictEqual(stoppedRes.multiVillage.enabled, true, "Multi-village enabled");

// Check running state with active window account "TH18-Main"
const runningRes1 = mod.resolveInstanceAccountDetails(mockInstance, "TH18-Main", true);
assert.strictEqual(runningRes1.account, "TH18-Main", "Active account is TH18-Main");
assert.strictEqual(runningRes1.thLevel, "TH18", "TH18 parsed");
assert.strictEqual(runningRes1.multiVillage.nextAccount, "TH17-Alt", "Next account in rotation is TH17-Alt");
assert.ok(runningRes1.multiVillage.remainingMinutes <= 45 && runningRes1.multiVillage.remainingMinutes >= 44, "Remaining minutes calculated correctly");
assert.ok(runningRes1.multiVillage.remainingText.includes("left"), "Remaining text formatted");

// Check rotation switch to "TH17-Alt"
const runningRes2 = mod.resolveInstanceAccountDetails(mockInstance, "TH17-Alt", true);
assert.strictEqual(runningRes2.account, "TH17-Alt", "Switched to TH17-Alt");
assert.strictEqual(runningRes2.thLevel, "TH17", "TH17 parsed");
assert.strictEqual(runningRes2.multiVillage.nextAccount, "TH18-Main", "Next account in rotation cycles back to TH18-Main");

// Cleanup
fs.rmSync(tempDir, { recursive: true, force: true });

console.log("All account & multi-village rotation checks passed.");
