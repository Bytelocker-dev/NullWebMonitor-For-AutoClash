"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const testDir = __dirname;
const testFiles = [
  "test-web-server.js",
  "test-break.js",
  "test-parser.js",
  "test-config.js",
  "test-config-map.js",
  "test-setup.js",
  "test-port.js",
  "test-sessions.js",
  "test-routes.js",
  "test-resilience.js",
  "test-qr.js",
  "test-watchdog.js",
  "test-password-reset.js",
  "test-same-folder.js",
  "test-changelog.js",
  "test-account-rotation.js",
  "test-alltime-stats.js",
];

console.log(`\x1b[36mRunning ${testFiles.length} XOR WebMonitor test suites...\x1b[0m\n`);

let failed = 0;
let passed = 0;
const startAll = Date.now();

for (const file of testFiles) {
  const filePath = path.join(testDir, file);
  if (!fs.existsSync(filePath)) {
    console.error(`\x1b[31mFAIL: Test file missing: ${file}\x1b[0m`);
    failed += 1;
    continue;
  }

  const start = Date.now();
  const res = spawnSync(process.execPath, [filePath], {
    cwd: path.resolve(testDir, ".."),
    stdio: "inherit",
  });

  const duration = Date.now() - start;
  if (res.status === 0) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`\x1b[31m✖ ${file} exited with code ${res.status} (${duration}ms)\x1b[0m\n`);
  }
}

const totalDuration = ((Date.now() - startAll) / 1000).toFixed(2);
console.log("\n------------------------------------------------------------");
if (failed === 0) {
  console.log(`\x1b[32m✔ All ${passed} test suites passed cleanly in ${totalDuration}s.\x1b[0m`);
  process.exit(0);
} else {
  console.error(`\x1b[31m✖ ${failed} test suite(s) failed (${passed} passed) in ${totalDuration}s.\x1b[0m`);
  process.exit(1);
}
