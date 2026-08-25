"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const botSource = fs.readFileSync(path.join(__dirname, "bot.js"), "utf8");

function grab(name) {
  const lines = botSource.split(/\r?\n/);
  const from = lines.findIndex((line) => line.startsWith(`function ${name}(`));
  if (from === -1) throw new Error(`bot.js has no top-level function ${name}`);
  const to = lines.findIndex((line, index) => index > from && line === "}");
  if (to === -1) throw new Error(`could not find the end of ${name}`);
  return lines.slice(from, to + 1).join("\n");
}

const helpers = new Function(
  "fs",
  "path",
  [
    'const SESSION_STATS_COLUMNS = ["session_key", "day_key", "timestamp", "runtime", "runtime_seconds", "total_attacks", "gold_gained", "elixir_gained", "dark_gained", "donations_completed", "bb_attacks", "bb_walls_upgraded", "stars_0", "stars_1", "stars_2", "stars_3", "walls_upgraded", "obstacles_removed", "upgrades_done", "research_done"];',
    grab("compactNumber"),
    grab("fullNumber"),
    grab("formatDuration"),
    grab("embedValue"),
    grab("statBar"),
    grab("starsValue"),
    grab("perHour"),
    grab("readJsonFile"),
    grab("resolveAutoClashExePath"),
    grab("autoClashRootDir"),
    grab("statsDbFile"),
    grab("statsDirForInstance"),
    grab("sqliteVarint"),
    grab("signedNumber"),
    grab("sqliteRecordValue"),
    grab("sqliteParseRecord"),
    grab("sqliteReadTableRows"),
    grab("readSessionStatsRowsFromDb"),
    grab("allTimeStatsFromDb"),
    grab("allTimeStatsFallback"),
    grab("allTimeStatsEmbed"),
    "return { allTimeStatsFromDb, allTimeStatsFallback, allTimeStatsEmbed };",
  ].join("\n")
)(fs, path);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alltime-test-"));
const statsDir = path.join(tempDir, "AutoClash", "logs", "stats");
fs.mkdirSync(statsDir, { recursive: true });
fs.writeFileSync(path.join(tempDir, "AutoClash", "AutoClash.exe"), "dummy");

const instance = {
  id: "main",
  label: "AutoClash Main",
  exePath: path.join(tempDir, "AutoClash", "AutoClash.exe"),
};

// 1. Test fallback with daily_totals.json
const dailyTotals = {
  "2026-08-20": {
    runtime_seconds: 7200,
    total_attacks: 20,
    gold_gained: 5000000,
    elixir_gained: 4000000,
    dark_gained: 25000,
    donations_completed: 10,
    walls_upgraded: 8,
    bb_attacks: 14,
    bb_walls_upgraded: 6,
  },
  "2026-08-21": {
    runtime_seconds: 10800,
    total_attacks: 30,
    gold_gained: 8000000,
    elixir_gained: 7000000,
    dark_gained: 40000,
    donations_completed: 15,
    walls_upgraded: 12,
    bb_attacks: 20,
    bb_walls_upgraded: 10,
  },
};
fs.writeFileSync(path.join(statsDir, "daily_totals.json"), JSON.stringify(dailyTotals, null, 2));

const allTimeFromDaily = helpers.allTimeStatsFallback(instance);
assert.ok(allTimeFromDaily, "allTimeStatsFallback returned data");
assert.strictEqual(allTimeFromDaily.sessions, 2, "2 days of sessions recorded");
assert.strictEqual(allTimeFromDaily.days, 2, "2 days total");
assert.strictEqual(allTimeFromDaily.firstDate, "2026-08-20", "first date matches");
assert.strictEqual(allTimeFromDaily.lastDate, "2026-08-21", "last date matches");
assert.strictEqual(allTimeFromDaily.stats.gold_gained, 13000000, "gold gained summed correctly");
assert.strictEqual(allTimeFromDaily.stats.elixir_gained, 11000000, "elixir gained summed correctly");
assert.strictEqual(allTimeFromDaily.stats.dark_gained, 65000, "dark gained summed correctly");
assert.strictEqual(allTimeFromDaily.stats.total_attacks, 50, "attacks summed correctly");
assert.strictEqual(allTimeFromDaily.stats.runtime_seconds, 18000, "runtime summed correctly (5h)");
assert.strictEqual(allTimeFromDaily.stats.bb_attacks, 34, "bb_attacks summed correctly");

// 2. Test allTimeStatsEmbed formatting
const embed = helpers.allTimeStatsEmbed(instance);
assert.ok(embed.title.includes("All-Time Totals"), "Embed has All-Time title");
assert.ok(embed.description.includes("50"), "Embed includes total attacks");
assert.ok(embed.description.includes("sessions"), "Embed includes session text");
assert.ok(embed.fields.some((f) => f.name === "Gold" && f.value.includes("13M")), "Embed has formatted 13M gold");
assert.ok(embed.fields.some((f) => f.name === "Elixir" && f.value.includes("11M")), "Embed has formatted 11M elixir");

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("All all-time stats tests passed.");
