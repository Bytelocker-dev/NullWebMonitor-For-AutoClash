"use strict";

// A port clash must explain itself. The default is a raw EADDRINUSE stack
// trace, which is meaningless to someone who just double-clicked the launcher
// twice or already has something on 8477.
// Run: node test-port.js

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "port-"));
fs.writeFileSync(path.join(dir, ".env"), "WEB_PASSWORD_HASH=scrypt$aa$bb\r\n");
process.chdir(dir);
process.env.WEB_PASSWORD_HASH = "scrypt$aa$bb";
process.env.WEB_HOST = "127.0.0.1";

const { startWebServer } = require(path.join(__dirname, "web-server.js"));

const stub = new Proxy({}, {
  get: (_t, name) => {
    if (name === "logs") return [];
    if (name === "control") return { instances: [], autoUpdateEnabled: false };
    if (name === "configured") return true;
    return () => (name === "runtimeStateKeys" ? [] : undefined);
  },
});

const blocker = net.createServer();
const messages = [];
const realError = console.error;
console.error = (...args) => messages.push(args.join(" "));

let exitCode = null;
const realExit = process.exit;
process.exit = (code) => { exitCode = code; };

blocker.listen(0, "127.0.0.1", () => {
  process.env.WEB_PORT = String(blocker.address().port);
  startWebServer(stub);

  setTimeout(() => {
    console.error = realError;
    process.exit = realExit;

    const text = messages.join("\n");
    assert.ok(text.length, "something is reported when the port is taken");
    assert.ok(/already in use|in use/i.test(text), "says the port is in use:\n" + text);
    assert.ok(text.includes(String(blocker.address().port)), "names the port");
    assert.ok(/WEB_PORT/.test(text), "tells the user which setting to change");
    assert.ok(!/EADDRINUSE:\s*address already in use\s*\n\s*at /.test(text), "no raw stack trace");
    assert.strictEqual(exitCode, 1, "exits non-zero so the launcher does not silently loop");

    blocker.close();
    process.chdir(__dirname);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("All port-clash checks passed.");

    // startWebServer leaves a 5s state-refresh interval running. In production
    // the process exits on a bind failure; here process.exit was stubbed out,
    // so that timer would keep this test alive forever.
    realExit(0);
  }, 700);
});
