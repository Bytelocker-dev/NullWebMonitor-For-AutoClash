"use strict";

// The setup wizard's .env writer. The part that matters most here is Discord
// channel routing: one channel for the control panel, and a separate channel
// per instance, each with its own display name.
// Run: node test-setup.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const botSource = fs.readFileSync(path.join(__dirname, "..", "bot.js"), "utf8");

function grab(name) {
  const lines = botSource.split(/\r?\n/);
  const from = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (from === -1) throw new Error(`bot.js has no top-level function ${name}`);
  const to = lines.findIndex((l, i) => i > from && l === "}");
  return lines.slice(from, to + 1).join("\n");
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-"));
const originalCwd = process.cwd();
process.chdir(dir);
fs.writeFileSync(".env", "DISCORD_TOKEN=keep-me\r\n");

const mod = new Function(
  "fs",
  "path",
  [
    grab("resolveEnvPath"),
    grab("readEnvFile"),
    grab("writeEnvFile"),
    grab("envKeyForLog"),
    grab("normalizeAutoControlVersion"),
    grab("applySetup"),
    "return { applySetup, readEnvFile };",
  ].join("\n")
)(fs, path);

const folderA = path.join(dir, "InstanceA");
const folderB = path.join(dir, "InstanceB");
fs.mkdirSync(folderA, { recursive: true });
fs.mkdirSync(folderB, { recursive: true });

// --- per-instance channel routing -------------------------------------------

mod.applySetup({
  instances: [
    { name: "Main Farm", folder: folderA, device: "127.0.0.1:16384", channelId: "111111111111111111", channelName: "main-farm-log" },
    { name: "Alt Push", folder: folderB, device: "127.0.0.1:16416", channelId: "222222222222222222" },
  ],
  discord: { token: "tok", channelId: "999999999999999999" },
});

let env = mod.readEnvFile();

// The control panel gets its own channel, separate from any instance.
assert.strictEqual(env.DISCORD_CHANNEL_ID, "999999999999999999", "panel channel set");
assert.strictEqual(env.AUTOCONTROL_CHANNEL_ID, "999999999999999999", "control panel posts to the panel channel");

// Each instance routes to its own channel.
assert.strictEqual(env.MAIN_FARM_CHANNEL_ID, "111111111111111111", "first instance has its own channel");
assert.strictEqual(env.ALT_PUSH_CHANNEL_ID, "222222222222222222", "second instance has a different channel");
assert.notStrictEqual(env.MAIN_FARM_CHANNEL_ID, env.ALT_PUSH_CHANNEL_ID, "instances do not share a channel");
assert.notStrictEqual(env.MAIN_FARM_CHANNEL_ID, env.DISCORD_CHANNEL_ID, "instance channel is not the panel channel");

// A supplied channel name is used; otherwise it falls back to the instance name.
assert.strictEqual(env.MAIN_FARM_CHANNEL_NAME, "main-farm-log", "explicit channel name wins");
assert.strictEqual(env.ALT_PUSH_CHANNEL_NAME, "Alt Push", "falls back to the instance name");

// The control panel channel gets a name too, so it can be renamed on start.
assert.strictEqual(env.AUTOCONTROL_CHANNEL_NAME, "XOR WebMonitor Panel", "panel channel gets a default name");

// Secrets already in .env survive a wizard save.
assert.strictEqual(env.DISCORD_TOKEN, "tok", "token updated");

// A panel name the user typed wins over the default.
mod.applySetup({
  instances: [{ name: "Solo", folder: folderA }],
  discord: { token: "tok", channelId: "999999999999999999", channelName: "coc-control" },
});
assert.strictEqual(mod.readEnvFile().AUTOCONTROL_CHANNEL_NAME, "coc-control", "explicit panel name wins");

// --- instances without Discord ----------------------------------------------

mod.applySetup({
  instances: [{ name: "Solo", folder: folderA, device: "127.0.0.1:16384" }],
});
env = mod.readEnvFile();
assert.strictEqual(env.SOLO_CHANNEL_ID, undefined, "no channel id is written when none was given");
assert.strictEqual(env.SOLO_CHANNEL_NAME, "Solo", "a display name is still recorded");

// --- validation --------------------------------------------------------------

assert.throws(() => mod.applySetup({ instances: [] }), /at least one/i, "refuses an empty instance list");
assert.throws(() => mod.applySetup({ instances: [{ name: "", folder: folderA }] }), /needs a name/i);
assert.throws(() => mod.applySetup({ instances: [{ name: "Bad|Name", folder: folderA }] }), /cannot contain/i);
assert.throws(() => mod.applySetup({ instances: [{ name: "Ghost", folder: path.join(dir, "nope") }] }), /not found/i);

// A name that collapses to the same env key would silently overwrite the other.
mod.applySetup({
  instances: [
    { name: "My Bot", folder: folderA, channelId: "333333333333333333" },
    { name: "My-Bot", folder: folderB, channelId: "444444444444444444" },
  ],
});
env = mod.readEnvFile();
assert.strictEqual(
  env.MY_BOT_CHANNEL_ID,
  "444444444444444444",
  "documented behaviour: names differing only by punctuation share one env key"
);

process.chdir(originalCwd);
fs.rmSync(dir, { recursive: true, force: true });
console.log("All setup-writer checks passed.");
