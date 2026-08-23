"use strict";

// The QR encoder is hand-rolled to avoid a dependency, so it has to earn trust
// on its own. Two checks do most of the work:
//   - every finished codeword block is a valid Reed-Solomon codeword, which is
//     true only if the error correction maths is right (all syndromes zero)
//   - the finished matrix is read back through the placement and masking rules
//     and must yield the original text again
// Run: node test-qr.js

const assert = require("assert");
const path = require("path");

const qr = require(path.join(__dirname, "public", "qr.js"));
const { qrMatrix, qrSvg, qrEncodeData, qrPickVersion, QR_EXP, QR_LOG, qrMultiply } = qr;

const SAMPLES = [
  "http://nullwebmonitor.example:8477",
  "http://127.0.0.1:8477",
  "http://desktop-longer-name.tail1a2b3c.ts.net:8477",
  "a",
  "https://example.com/" + "x".repeat(50),
];

// --- Reed-Solomon: syndromes of a valid codeword are all zero ---------------

function syndromes(codeword, eccLength) {
  const out = [];
  for (let i = 0; i < eccLength; i += 1) {
    let value = 0;
    for (const byte of codeword) value = qrMultiply(value, QR_EXP[i]) ^ byte;
    out.push(value);
  }
  return out;
}

for (const text of SAMPLES) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const spec = qrPickVersion(bytes.length);
  assert.ok(spec, `a version exists for ${bytes.length} bytes`);

  const codewords = qrEncodeData(bytes, spec);
  assert.strictEqual(codewords.length, spec.total, `version ${spec.version} fills every codeword`);

  const bad = syndromes(codewords, spec.ecc).filter((s) => s !== 0);
  assert.strictEqual(bad.length, 0, `error correction is valid for "${text.slice(0, 24)}"`);
}

// A deliberately wrong codeword must fail the same check, or the check above
// proves nothing.
{
  const bytes = Array.from(new TextEncoder().encode("http://127.0.0.1:8477"));
  const spec = qrPickVersion(bytes.length);
  const codewords = qrEncodeData(bytes, spec);
  codewords[3] ^= 0x5a;
  const bad = syndromes(codewords, spec.ecc).filter((s) => s !== 0);
  assert.ok(bad.length > 0, "a corrupted codeword is detected, so the check has teeth");
}

// --- read the matrix back ----------------------------------------------------

// Rebuild the function-module map the same way the encoder does, so the reader
// knows which cells carry data.
function readBack(modules) {
  const size = modules.length;
  const spec = qr.QR_VERSIONS.find((v) => v.size === size);
  assert.ok(spec, `matrix size ${size} matches a known version`);

  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserve = (row, col) => {
    if (row >= 0 && row < size && col >= 0 && col < size) reserved[row][col] = true;
  };

  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) reserve(top + r, left + c);
  }
  for (let i = 0; i < size; i += 1) { reserve(6, i); reserve(i, 6); }
  if (spec.align) {
    for (let r = -2; r <= 2; r += 1) for (let c = -2; c <= 2; c += 1) reserve(spec.align + r, spec.align + c);
  }
  reserve(size - 8, 8);
  for (let i = 0; i < 9; i += 1) { reserve(8, i); reserve(i, 8); }
  for (let i = 0; i < 8; i += 1) { reserve(8, size - 1 - i); reserve(size - 1 - i, 8); }

  const bits = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        bits.push(modules[row][col] ^ ((row + col) % 2 === 0 ? 1 : 0));
      }
    }
    upward = !upward;
  }

  const bytes = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    bytes.push(byte);
  }

  const mode = bytes[0] >> 4;
  assert.strictEqual(mode, 0b0100, "byte mode survives the round trip");
  const length = ((bytes[0] & 0x0f) << 4) | (bytes[1] >> 4);

  const payload = [];
  for (let i = 0; i < length; i += 1) {
    payload.push(((bytes[1 + i] & 0x0f) << 4) | (bytes[2 + i] >> 4));
  }
  return new TextDecoder().decode(Uint8Array.from(payload));
}

for (const text of SAMPLES) {
  const modules = qrMatrix(text);
  assert.ok(modules, `"${text.slice(0, 24)}" produces a matrix`);
  assert.strictEqual(readBack(modules), text, `"${text.slice(0, 24)}" reads back unchanged`);
}

// --- structure ---------------------------------------------------------------

{
  const modules = qrMatrix("http://127.0.0.1:8477");
  const size = modules.length;

  // Three finder patterns: dark ring, light ring, dark 3x3 core.
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.strictEqual(modules[top][left], 1, "finder corner is dark");
    assert.strictEqual(modules[top + 1][left + 1], 0, "finder has a light ring");
    assert.strictEqual(modules[top + 3][left + 3], 1, "finder has a dark core");
  }

  // Timing patterns alternate.
  for (let i = 8; i < size - 8; i += 1) {
    assert.strictEqual(modules[6][i], i % 2 === 0 ? 1 : 0, `horizontal timing at ${i}`);
    assert.strictEqual(modules[i][6], i % 2 === 0 ? 1 : 0, `vertical timing at ${i}`);
  }

  assert.strictEqual(modules[size - 8][8], 1, "the dark module is set");
}

// --- limits and rendering ----------------------------------------------------

assert.strictEqual(qrMatrix("x".repeat(79)), null, "past version 4 it declines rather than throwing");
assert.ok(qrMatrix("x".repeat(78)), "78 bytes still fits");

const svg = qrSvg("http://nullwebmonitor.example:8477");
assert.ok(svg.startsWith("<svg"), "an SVG is produced");
assert.ok(svg.includes("viewBox"), "the SVG scales");
assert.ok(!svg.includes("<script"), "no script sneaks into the SVG");
assert.strictEqual(qrSvg("x".repeat(200)), "", "too long renders nothing rather than something broken");

console.log("All QR checks passed.");
