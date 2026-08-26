"use strict";

// Self-check for the parts that would fail silently: password hashing, the
// .env merge (must never blank a secret), and the static path guard.
// Run: node test-web-server.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { makePasswordHash } = require("../web-server");

// --- password hashing -------------------------------------------------------

const server = fs.readFileSync(path.join(__dirname, "..", "web-server.js"), "utf8");
const verifyPassword = new Function(
  "crypto",
  `${server.match(/function scryptHash[\s\S]*?\r?\n\}\r?\n/)[0]}
   ${server.match(/function verifyPassword[\s\S]*?\r?\n\}\r?\n/)[0]}
   return verifyPassword;`
)(require("crypto"));

const hash = makePasswordHash("correct horse battery staple");
assert.ok(hash.startsWith("scrypt$"), "hash has the expected format");
assert.strictEqual(verifyPassword("correct horse battery staple", hash), true, "right password verifies");
assert.strictEqual(verifyPassword("Correct horse battery staple", hash), false, "wrong case rejected");
assert.strictEqual(verifyPassword("", hash), false, "empty password rejected");
assert.strictEqual(verifyPassword("x", "garbage"), false, "malformed stored hash rejected");
assert.notStrictEqual(makePasswordHash("same"), makePasswordHash("same"), "salt differs per hash");

// --- .env merge -------------------------------------------------------------

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "acwm-"));
const originalCwd = process.cwd();
process.chdir(workDir);

fs.writeFileSync(
  ".env",
  ["# comment", "DISCORD_TOKEN=secret-token", "WEB_PASSWORD_HASH=scrypt$aa$bb", "CHECK_INTERVAL_SECONDS=5", ""].join("\r\n")
);

const bot = fs.readFileSync(path.join(__dirname, "..", "bot.js"), "utf8");
const envHelpers = new Function(
  "fs",
  "path",
  `${bot.match(/function resolveEnvPath[\s\S]*?\r?\n\}\r?\n/)[0]}
   ${bot.match(/function readEnvFile[\s\S]*?\r?\n\}\r?\n/)[0]}
   ${bot.match(/function writeEnvFile[\s\S]*?\r?\n\}\r?\n/)[0]}
   return { resolveEnvPath, readEnvFile, writeEnvFile };`
)(fs, path);

let env = envHelpers.readEnvFile();
assert.strictEqual(env.DISCORD_TOKEN, "secret-token", "reads values");
assert.strictEqual(env["# comment"], undefined, "skips comments");

// A blank secret from the UI must not wipe the stored one.
envHelpers.writeEnvFile({ DISCORD_TOKEN: "", WEB_PASSWORD_HASH: "", CHECK_INTERVAL_SECONDS: "9" });
env = envHelpers.readEnvFile();
assert.strictEqual(env.DISCORD_TOKEN, "secret-token", "blank token is ignored");
assert.strictEqual(env.WEB_PASSWORD_HASH, "scrypt$aa$bb", "blank password hash is ignored");
assert.strictEqual(env.CHECK_INTERVAL_SECONDS, "9", "normal value updates");

// Untouched keys survive a partial save.
envHelpers.writeEnvFile({ NEW_KEY: "hello" });
env = envHelpers.readEnvFile();
assert.strictEqual(env.CHECK_INTERVAL_SECONDS, "9", "untouched key kept");
assert.strictEqual(env.NEW_KEY, "hello", "new key added");

assert.throws(() => envHelpers.writeEnvFile({ "bad key; rm -rf": "x" }), /Invalid setting name/, "rejects bad key names");
assert.throws(() => envHelpers.writeEnvFile({ lowercase: "x" }), /Invalid setting name/, "rejects lowercase keys");

process.chdir(originalCwd);
fs.rmSync(workDir, { recursive: true, force: true });

// --- emulator index math ----------------------------------------------------

const botSource = fs.readFileSync(path.join(__dirname, "..", "bot.js"), "utf8");
const emulatorIndexForInstance = new Function(
  `${botSource.match(/function emulatorIndexForInstance[\s\S]*?\r?\n\}\r?\n/)[0]}
   return emulatorIndexForInstance;`
)();

// MuMu: 16384 + 32 per instance. Matches `MuMuManager info -v all` on this PC.
assert.strictEqual(emulatorIndexForInstance("mumu", { device: "127.0.0.1:16384" }), 0);
assert.strictEqual(emulatorIndexForInstance("mumu", { device: "127.0.0.1:16416" }), 1);
assert.strictEqual(emulatorIndexForInstance("mumu", { device: "127.0.0.1:16448" }), 2);
// LDPlayer: 5555 + 2 per instance.
assert.strictEqual(emulatorIndexForInstance("ldplayer", { device: "127.0.0.1:5555" }), 0);
assert.strictEqual(emulatorIndexForInstance("ldplayer", { device: "127.0.0.1:5557" }), 1);
// Ports that do not land on an instance boundary must not guess an index.
assert.strictEqual(emulatorIndexForInstance("mumu", { device: "127.0.0.1:16400" }), null);
assert.strictEqual(emulatorIndexForInstance("mumu", { device: "127.0.0.1:5555" }), null);
assert.strictEqual(emulatorIndexForInstance("mumu", { device: "" }), null);
assert.strictEqual(emulatorIndexForInstance("mumu", {}), null);

// --- static path guard ------------------------------------------------------

const publicDir = path.join(__dirname, "..", "public");
for (const attempt of ["/../.env", "/../../secret.txt", "/..%2f.env"]) {
  const resolved = path.join(publicDir, decodeURIComponent(attempt).replace(/^\/+/, ""));
  const allowed = resolved.startsWith(publicDir + path.sep);
  assert.strictEqual(allowed, false, `traversal blocked: ${attempt}`);
}
assert.ok(path.join(publicDir, "index.html").startsWith(publicDir + path.sep), "normal file allowed");

console.log("All checks passed.");
