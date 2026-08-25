const assert = require("assert");
const { parseChangelog } = require("./web-server");

const sampleMarkdown = `
# Changelog

All notable changes to **XOR WebMonitor** are documented in this file.

## [2.0.0] - 2026-08-25

### 🚀 Major Highlights
- Rebranded application from NullWebMonitor to **XOR WebMonitor**.
- Added terminal ASCII banner and interactive \`xor>\` command prompt.

### 🐛 Bug Fixes & Resilience
- **Password Hasher & Special Character Support**: Full support for quotes, #, =, and emojis.
- **Same-Name Folder Multi-Instance Support**: Isolated stats for shared folders.

## [1.9.0] - 2026-08-10

### Features
- Added Ntfy push notifications.
- Added live screenshot stream.
`;

const result = parseChangelog(sampleMarkdown);

assert.ok(Array.isArray(result.releases), "Releases array returned");
assert.strictEqual(result.releases.length, 2, "2 releases parsed");

// Check release 1
const rel1 = result.releases[0];
assert.strictEqual(rel1.version, "2.0.0", "Release 1 version");
assert.strictEqual(rel1.date, "2026-08-25", "Release 1 date");
assert.strictEqual(rel1.sections.length, 2, "Release 1 sections count");
assert.strictEqual(rel1.sections[0].title, "🚀 Major Highlights", "Section 1 title");
assert.strictEqual(rel1.sections[0].items.length, 2, "Section 1 items count");
assert.strictEqual(rel1.sections[1].title, "🐛 Bug Fixes & Resilience", "Section 2 title");
assert.strictEqual(rel1.sections[1].items.length, 2, "Section 2 items count");

// Check release 2
const rel2 = result.releases[1];
assert.strictEqual(rel2.version, "1.9.0", "Release 2 version");
assert.strictEqual(rel2.date, "2026-08-10", "Release 2 date");
assert.strictEqual(rel2.sections.length, 1, "Release 2 sections count");
assert.strictEqual(rel2.sections[0].title, "Features", "Section title");
assert.strictEqual(rel2.sections[0].items.length, 2, "Section items count");

console.log("All changelog parser checks passed.");
