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
  grab("resolveEnvPath"),
  grab("parseAutoControlInstances"),
  grab("normalizeAutoControlVersion"),
  grab("parseBooleanValue"),
  grab("statsDirForInstance"),
  grab("autoClashRootDir"),
  grab("applySetup"),
  grab("readEnvFile"),
  grab("writeEnvFile"),
  grab("envKeyForLog"),
  "exports.resolveEnvPath = resolveEnvPath;",
  "exports.parseAutoControlInstances = parseAutoControlInstances;",
  "exports.statsDirForInstance = statsDirForInstance;",
  "exports.applySetup = applySetup;",
  "exports.readEnvFile = readEnvFile;",
  "exports.writeEnvFile = writeEnvFile;",
].join("\n"))(mod, fs, path);

const envFile = path.join(__dirname, ".env");
const originalEnv = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : null;

try {
  // Test 1: Parsing instances with custom logsDir (7-pipe format)
  const rawWithLogs = "Main|Main Farm|C:\\AutoClash|127.0.0.1:16384|2.0.9|true|C:\\AutoClash\\logs_instance1;Alt|Alt Farm|C:\\AutoClash|127.0.0.1:16416|2.0.9|true|C:\\AutoClash\\logs_instance2";
  const parsed = mod.parseAutoControlInstances(rawWithLogs);

  assert.strictEqual(parsed.length, 2, "Parsed 2 instances");
  assert.strictEqual(parsed[0].logsDir, "C:\\AutoClash\\logs_instance1", "Instance 1 logsDir parsed");
  assert.strictEqual(parsed[1].logsDir, "C:\\AutoClash\\logs_instance2", "Instance 2 logsDir parsed");
  assert.strictEqual(parsed[0].exePath, "C:\\AutoClash", "Instance 1 exePath parsed");
  assert.strictEqual(parsed[1].exePath, "C:\\AutoClash", "Instance 2 exePath parsed");

  // Test 2: Multi-instance applySetup with same folder and duplicate names
  const tempDir = fs.mkdtempSync(path.join(path.dirname(__filename), "temp-same-folder-"));
  const logs1 = path.join(tempDir, "logs_1");
  const logs2 = path.join(tempDir, "logs_2");
  fs.mkdirSync(logs1, { recursive: true });
  fs.mkdirSync(logs2, { recursive: true });

  mod.applySetup({
    instances: [
      { name: "Account", folder: tempDir, device: "127.0.0.1:16384", logsDir: logs1 },
      { name: "Account", folder: tempDir, device: "127.0.0.1:16416", logsDir: logs2 },
    ],
  });

  const env = mod.readEnvFile();
  const instancesFromEnv = mod.parseAutoControlInstances(env.AUTOCONTROL_INSTANCES);

  assert.strictEqual(instancesFromEnv.length, 2, "2 instances saved to .env");
  assert.strictEqual(instancesFromEnv[0].id, "Account", "First instance ID");
  assert.strictEqual(instancesFromEnv[1].id, "Account_2", "Second instance ID disambiguated");
  assert.strictEqual(instancesFromEnv[0].logsDir, logs1, "First instance custom logs dir saved");
  assert.strictEqual(instancesFromEnv[1].logsDir, logs2, "Second instance custom logs dir saved");

  // Test 3: statsDirForInstance resolution
  assert.strictEqual(mod.statsDirForInstance(instancesFromEnv[0]), logs1, "Resolves to instance 1 custom logs dir");
  assert.strictEqual(mod.statsDirForInstance(instancesFromEnv[1]), logs2, "Resolves to instance 2 custom logs dir");

  // Cleanup temp dir
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log("All same-folder & multi-instance checks passed.");
} finally {
  if (originalEnv !== null) {
    fs.writeFileSync(envFile, originalEnv, "utf8");
  } else if (fs.existsSync(envFile)) {
    fs.unlinkSync(envFile);
  }
}
