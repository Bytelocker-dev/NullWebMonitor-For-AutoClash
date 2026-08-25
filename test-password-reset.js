const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { makePasswordHash, verifyPassword } = require("./web-server");

const botSrc = fs.readFileSync(path.join(__dirname, "bot.js"), "utf8");
function grab(name) {
  const match = botSrc.match(new RegExp(`function ${name}\\b[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`Function not found: ${name}`);
  return match[0];
}

const mod = {};
new Function("exports", "fs", "path", [
  grab("resolveEnvPath"),
  grab("readEnvFile"),
  grab("writeEnvFile"),
  "exports.resolveEnvPath = resolveEnvPath;",
  "exports.readEnvFile = readEnvFile;",
  "exports.writeEnvFile = writeEnvFile;",
].join("\n"))(mod, fs, path);

const envFile = path.join(__dirname, ".env");
const originalEnv = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : null;

try {
  // Test 1: Password hashing and verification with complex/special characters
  const testPasswords = [
    "SimplePass1234",
    'Pass"With"Quotes#123',
    "Pass=With=Equals#And#Hashes!",
    "P@ssw0rd$#%^&*()_+~`|}{[]:;?><,./-=",
    "Pass with spaces and emoji ⚔️ 🛡️ 🚀",
    "MotDePasseTrêsSécurisé12345",
  ];

  for (const pwd of testPasswords) {
    const hash = makePasswordHash(pwd);
    assert.ok(hash.startsWith("scrypt$"), `Hash prefix valid for: ${pwd}`);
    assert.strictEqual(verifyPassword(pwd, hash), true, `Verification passed for: ${pwd}`);
    assert.strictEqual(verifyPassword(pwd + "_wrong", hash), false, `Wrong password rejected for: ${pwd}`);
  }

  // Test 2: Writing and reading .env with special characters
  const complexValues = {
    TEST_HASH_QUOTES: 'scrypt:test"quotes"and#hashes',
    TEST_COMPLEX_KEY: 'value with # comment sign and = equals and "quotes"',
    TEST_UNICODE: "XOR-WebMonitor-⚔️-2026",
  };

  mod.writeEnvFile(complexValues);
  const readBack = mod.readEnvFile();

  for (const [key, val] of Object.entries(complexValues)) {
    assert.strictEqual(readBack[key], val, `Env read/write match for key: ${key}`);
  }

  console.log("All password reset & character encoding checks passed.");
} finally {
  if (originalEnv !== null) {
    fs.writeFileSync(envFile, originalEnv, "utf8");
  } else if (fs.existsSync(envFile)) {
    fs.unlinkSync(envFile);
  }
}
