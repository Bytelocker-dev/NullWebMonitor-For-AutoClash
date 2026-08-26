"use strict";

// AutoClash config writing. This is the most invasive thing the monitor does —
// it writes into a live bot's install folder — so the merge, atomicity, backup
// and revert behaviour are pinned here.
//
// Everything runs against a temp directory. The real installs are never touched.
// Run: node test-config.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const botSource = fs.readFileSync(path.join(__dirname, "..", "bot.js"), "utf8");

function grab(name) {
  const lines = botSource.split(/\r?\n/);
  const from = lines.findIndex((line) => line.startsWith(`function ${name}(`) || line.startsWith(`async function ${name}(`));
  if (from === -1) throw new Error(`bot.js has no top-level function ${name}`);
  const to = lines.findIndex((line, index) => index > from && line === "}");
  if (to === -1) throw new Error(`could not find the end of ${name}`);
  return lines.slice(from, to + 1).join("\n");
}

const mod = new Function(
  "fs",
  "path",
  "sleep",
  "deleteFileQuietly",
  "console",
  [
    grab("readJsonQuietly"),
    grab("waitForFileToSettle"),
    grab("backupConfig"),
    grab("writeConfigFile"),
    grab("newestBackup"),
    grab("listAccounts"),
    "return { readJsonQuietly, backupConfig, writeConfigFile, newestBackup, listAccounts, waitForFileToSettle };",
  ].join("\n")
)(
  fs,
  path,
  // Real settling would add 3s per write; the logic is exercised separately.
  () => Promise.resolve(),
  (p) => { try { fs.unlinkSync(p); } catch {} },
  console
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
const configPath = path.join(dir, "config.json");

// A config shaped like the real one: every value type AutoClash uses.
const ORIGINAL = {
  ACTIVE_HOURS_ENABLED: false,
  ACTIVE_HOURS_START: "08:00",
  BUILDER_MAX_ATTACKS: 5,
  BUILDER_TARGET_STARS: "Full Battle",
  BB_UPGRADE_SLOTS: [1, 2, 3, 4, 5, 6],
  CG_CHALLENGE_NAME_OVERRIDES: { cg_darkgrab: "Dark Grab" },
  CC_LOOT_CYCLE_START: 1787342151.4983246,
  UNKNOWN_TO_THE_UI: "must survive",
};

function reset() {
  fs.readdirSync(dir).forEach((name) => fs.unlinkSync(path.join(dir, name)));
  fs.writeFileSync(configPath, `${JSON.stringify(ORIGINAL, null, 2)}\n`, "utf8");
}

(async () => {
  // --- merge preserves everything it was not told to change --------------------
  reset();
  let result = await mod.writeConfigFile(configPath, { BUILDER_MAX_ATTACKS: 9 });
  let after = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.strictEqual(result.changed, 1, "one change reported");
  assert.strictEqual(after.BUILDER_MAX_ATTACKS, 9, "value updated");
  assert.strictEqual(after.UNKNOWN_TO_THE_UI, "must survive", "keys the UI never sent are preserved");
  assert.strictEqual(Object.keys(after).length, Object.keys(ORIGINAL).length, "no keys added or dropped");

  // --- all value types round-trip ---------------------------------------------
  reset();
  await mod.writeConfigFile(configPath, {
    ACTIVE_HOURS_ENABLED: true,
    ACTIVE_HOURS_START: "09:30",
    BUILDER_MAX_ATTACKS: 12,
    BB_UPGRADE_SLOTS: [9, 8],
    CG_CHALLENGE_NAME_OVERRIDES: { cg_darkgrab: "Renamed" },
  });
  after = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.strictEqual(after.ACTIVE_HOURS_ENABLED, true, "boolean");
  assert.strictEqual(after.ACTIVE_HOURS_START, "09:30", "string");
  assert.strictEqual(after.BUILDER_MAX_ATTACKS, 12, "number");
  assert.deepStrictEqual(after.BB_UPGRADE_SLOTS, [9, 8], "array");
  assert.deepStrictEqual(after.CG_CHALLENGE_NAME_OVERRIDES, { cg_darkgrab: "Renamed" }, "object");
  assert.strictEqual(after.CC_LOOT_CYCLE_START, ORIGINAL.CC_LOOT_CYCLE_START, "float precision kept");

  // --- unknown keys are refused, file untouched --------------------------------
  reset();
  const before = fs.readFileSync(configPath, "utf8");
  await assert.rejects(
    () => mod.writeConfigFile(configPath, { NOT_A_REAL_SETTING: 1 }),
    /Unknown setting/,
    "a key not present in the file is refused"
  );
  assert.strictEqual(fs.readFileSync(configPath, "utf8"), before, "file untouched after a refused write");

  // --- a no-op write does not create a backup ----------------------------------
  reset();
  result = await mod.writeConfigFile(configPath, { BUILDER_MAX_ATTACKS: ORIGINAL.BUILDER_MAX_ATTACKS });
  assert.strictEqual(result.changed, 0, "identical value is not a change");
  assert.strictEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".bak.json")).length, 0, "no backup for a no-op");

  // --- backup + revert ---------------------------------------------------------
  reset();
  const pristine = fs.readFileSync(configPath, "utf8");
  result = await mod.writeConfigFile(configPath, { BUILDER_MAX_ATTACKS: 99 });
  assert.ok(result.backup, "a backup filename is reported");
  const backups = fs.readdirSync(dir).filter((n) => n.endsWith(".bak.json"));
  assert.strictEqual(backups.length, 1, "exactly one backup written");
  assert.strictEqual(fs.readFileSync(path.join(dir, backups[0]), "utf8"), pristine, "backup is the pre-write file byte-for-byte");

  const newest = mod.newestBackup(configPath);
  fs.copyFileSync(newest, configPath);
  assert.strictEqual(fs.readFileSync(configPath, "utf8"), pristine, "revert restores the original exactly");

  // --- no temp file is left behind ---------------------------------------------
  assert.ok(!fs.existsSync(`${configPath}.tmp`), "temp file cleaned up by the rename");

  // --- backups are capped -------------------------------------------------------
  reset();
  for (let i = 1; i <= 14; i++) {
    await mod.writeConfigFile(configPath, { BUILDER_MAX_ATTACKS: i });
    // Backup names are timestamped to the millisecond; keep them distinct.
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  const kept = fs.readdirSync(dir).filter((n) => n.endsWith(".bak.json"));
  assert.ok(kept.length <= 11, `backups pruned, got ${kept.length}`);

  // --- accounts listing ---------------------------------------------------------
  const profiles = path.join(dir, "profiles");
  fs.mkdirSync(path.join(profiles, "accountone"), { recursive: true });
  fs.mkdirSync(path.join(profiles, "accounttwo"), { recursive: true });
  fs.mkdirSync(path.join(profiles, "__global__"), { recursive: true });
  fs.writeFileSync(path.join(profiles, "active_profiles.json"), JSON.stringify({ profiles: { accountone: true, accounttwo: false } }));
  fs.writeFileSync(path.join(profiles, "order.txt"), "accounttwo\naccountone\n");

  const listAccounts = new Function(
    "fs",
    "path",
    "readJsonQuietly",
    `function profilesDirForInstance() { return ${JSON.stringify(profiles)}; }\n${grab("listAccounts")}\nreturn listAccounts;`
  )(fs, path, mod.readJsonQuietly);

  const accounts = listAccounts({});
  assert.deepStrictEqual(accounts.map((a) => a.name), ["accounttwo", "accountone"], "order.txt drives the order");
  assert.strictEqual(accounts.find((a) => a.name === "accountone").enabled, true, "enabled flag read");
  assert.strictEqual(accounts.find((a) => a.name === "accounttwo").enabled, false, "disabled flag read");
  assert.ok(!accounts.some((a) => a.name === "__global__"), "__global__ is never offered as an account");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("All config checks passed.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
