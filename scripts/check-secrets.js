"use strict";

// Refuses to let personal data reach a public commit.
//
// Scans the whole working tree for credential-shaped strings and for anything
// listed in scripts/secret-denylist.txt (gitignored — put your own account
// names, tokens and IPs there). Exits non-zero on any hit.
//
// Run: npm run check-secrets

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "control-screenshots", "incidents"]);
const SKIP_FILES = new Set(["check-secrets.js", "secret-denylist.txt"]);

// Shapes that are secrets regardless of who owns them.
const PATTERNS = [
  { name: "Discord bot token", re: /\b[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/ },
  { name: "scrypt password hash", re: /scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}/ },
  // A specific tailnet address identifies a machine. The CGNAT range constant
  // 100.64.0.0/10 is public documentation and appears in the firewall command,
  // so it is not a leak.
  {
    name: "Tailscale 100.x address",
    re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
    allow: [/\b100\.64\.0\.0\/10\b/],
  },
  { name: "Discord snowflake in .env-style assignment", re: /^[A-Z_]*CHANNEL_ID\s*=\s*\d{17,20}\s*$/m },
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (!SKIP_FILES.has(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function loadDenylist() {
  const file = path.join(__dirname, "secret-denylist.txt");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

const denylist = loadDenylist();
const files = walk(ROOT);
const findings = [];

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue; // binary or unreadable
  }
  const rel = path.relative(ROOT, file);

  for (const { name, re, allow } of PATTERNS) {
    // Strip documented constants before testing, so a public range literal in
    // the README does not read as somebody's address.
    let probe = text;
    for (const ok of allow || []) probe = probe.replace(new RegExp(ok.source, "g"), "");
    if (re.test(probe)) findings.push(`${rel}: ${name}`);
  }
  for (const term of denylist) {
    if (text.toLowerCase().includes(term.toLowerCase())) findings.push(`${rel}: denylisted term "${term}"`);
  }
}

// A committed .env is the most common way secrets escape.
for (const leaky of [".env", "bot-state.json", "web-sessions.json"]) {
  if (fs.existsSync(path.join(ROOT, leaky))) {
    findings.push(`${leaky}: present in the tree — make sure .gitignore covers it and it is not staged`);
  }
}

console.log(`Scanned ${files.length} files, ${denylist.length} denylist term(s).`);
if (findings.length) {
  console.error(`\n${findings.length} problem(s):`);
  findings.forEach((f) => console.error("  " + f));
  console.error("\nRefusing to pass. Remove these before publishing.");
  process.exit(1);
}
console.log("Clean — no credential patterns or denylisted terms found.");
