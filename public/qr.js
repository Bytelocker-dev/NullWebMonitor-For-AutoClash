/* A very small QR encoder — enough for one URL, and nothing more.
 *
 * This project ships with one npm dependency and the intent is to keep it that
 * way, so rather than pull in a QR library this covers only the case actually
 * needed: byte mode, error correction level L, versions 1 to 4. That is up to
 * 78 characters, which fits any http://host:port a panel is reachable at,
 * MagicDNS names included.
 *
 * Deliberately left out: alphanumeric and numeric modes (a URL gains little),
 * versions above 4 (would need multi-block interleaving), and mask selection
 * by penalty score (mask 0 is a valid mask; every decoder handles all eight).
 */

// Total codewords, error correction codewords, and side length per version.
// Level L only, and every one of these versions is a single block, which is
// what lets the whole interleaving step be skipped.
const QR_VERSIONS = [
  { version: 1, size: 21, total: 26, ecc: 7, align: 0 },
  { version: 2, size: 25, total: 44, ecc: 10, align: 18 },
  { version: 3, size: 29, total: 70, ecc: 15, align: 22 },
  { version: 4, size: 33, total: 100, ecc: 20, align: 26 },
];

// GF(256) with the QR primitive polynomial, as log/antilog tables so the
// Reed-Solomon step is table lookups rather than bit twiddling.
const QR_EXP = new Uint8Array(512);
const QR_LOG = new Uint8Array(256);
(function buildGaloisTables() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    QR_EXP[i] = x;
    QR_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) QR_EXP[i] = QR_EXP[i - 255];
})();

function qrMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return QR_EXP[QR_LOG[a] + QR_LOG[b]];
}

// The generator polynomial for `degree` error correction codewords:
// (x - a^0)(x - a^1)...(x - a^(degree-1))
function qrGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= qrMultiply(poly[j], QR_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function qrErrorCorrection(data, eccLength) {
  const generator = qrGenerator(eccLength);
  const remainder = new Array(eccLength).fill(0);

  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let i = 0; i < eccLength; i += 1) {
        remainder[i] ^= qrMultiply(generator[i + 1], factor);
      }
    }
  }
  return remainder;
}

// Mode indicator (0100) plus an 8-bit length, so two codewords of overhead.
function qrPickVersion(byteLength) {
  const needed = byteLength + 2;
  return QR_VERSIONS.find((v) => v.total - v.ecc >= needed) || null;
}

function qrEncodeData(bytes, spec) {
  const capacity = spec.total - spec.ecc;
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);        // byte mode
  push(bytes.length, 8);  // versions 1-9 use an 8-bit count in byte mode
  for (const byte of bytes) push(byte, 8);

  // Terminator, then pad to a whole codeword.
  for (let i = 0; i < 4 && bits.length < capacity * 8; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }

  // The spec's pad bytes, alternating, until the block is full.
  const pad = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < capacity) {
    codewords.push(pad[padIndex % 2]);
    padIndex += 1;
  }

  return codewords.concat(qrErrorCorrection(codewords, spec.ecc));
}

// Everything that is structure rather than payload: finders, separators,
// timing, alignment, the dark module, and the space reserved for format bits.
function qrLayoutFunctionModules(spec) {
  const size = spec.size;
  const modules = Array.from({ length: size }, () => new Array(size).fill(0));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setModule = (row, col, value) => {
    modules[row][col] = value ? 1 : 0;
    reserved[row][col] = true;
  };

  const placeFinder = (top, left) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const row = top + r;
        const col = left + c;
        if (row < 0 || row >= size || col < 0 || col >= size) continue;
        const onRing = (r === 0 || r === 6) && c >= 0 && c <= 6;
        const onSide = (c === 0 || c === 6) && r >= 0 && r <= 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setModule(row, col, onRing || onSide || inCore);
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    setModule(6, i, i % 2 === 0);
    setModule(i, 6, i % 2 === 0);
  }

  // Versions 2 to 4 carry exactly one alignment pattern, clear of the finders.
  if (spec.align) {
    const centre = spec.align;
    for (let r = -2; r <= 2; r += 1) {
      for (let c = -2; c <= 2; c += 1) {
        const edge = Math.max(Math.abs(r), Math.abs(c));
        setModule(centre + r, centre + c, edge !== 1);
      }
    }
  }

  setModule(size - 8, 8, true); // the always-dark module

  // Reserve the format information area; the bits go in after masking.
  for (let i = 0; i < 9; i += 1) {
    if (!reserved[8][i]) setModule(8, i, false);
    if (!reserved[i][8]) setModule(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    if (!reserved[8][size - 1 - i]) setModule(8, size - 1 - i, false);
    if (!reserved[size - 1 - i][8]) setModule(size - 1 - i, 8, false);
  }

  return { modules, reserved };
}

// Walks the zig-zag the spec defines: two-module columns from the right,
// alternating upward and downward, skipping the vertical timing column.
function qrDataPositions(spec, reserved) {
  const size = spec.size;
  const positions = [];
  let upward = true;

  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1; // column 6 is timing, never data
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (!reserved[row][col]) positions.push([row, col]);
      }
    }
    upward = !upward;
  }
  return positions;
}

function qrFormatBits(mask) {
  // Five data bits: error correction level L is 01, then the mask number.
  const data = (0b01 << 3) | mask;
  let value = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if ((value >> (i + 10)) & 1) value ^= 0b10100110111 << i;
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

function qrPlaceFormat(modules, spec, mask) {
  const size = spec.size;
  const bits = qrFormatBits(mask);
  const bitAt = (i) => (bits >> i) & 1;

  for (let i = 0; i <= 5; i += 1) modules[8][i] = bitAt(i);
  modules[8][7] = bitAt(6);
  modules[8][8] = bitAt(7);
  modules[7][8] = bitAt(8);
  for (let i = 9; i <= 14; i += 1) modules[14 - i][8] = bitAt(i);

  for (let i = 0; i <= 7; i += 1) modules[size - 1 - i][8] = bitAt(i);
  for (let i = 8; i <= 14; i += 1) modules[8][size - 15 + i] = bitAt(i);
}

/* Returns a square array of 0/1 rows, without a quiet zone — the caller adds
 * the margin, since how much white space to leave is a rendering decision.
 * Returns null when the text does not fit in version 4, rather than throwing:
 * a missing QR code is not worth taking a page down for. */
function qrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  const spec = qrPickVersion(bytes.length);
  if (!spec) return null;

  const codewords = qrEncodeData(bytes, spec);
  const { modules, reserved } = qrLayoutFunctionModules(spec);
  const positions = qrDataPositions(spec, reserved);

  positions.forEach(([row, col], index) => {
    const byte = codewords[index >> 3];
    const bit = byte === undefined ? 0 : (byte >> (7 - (index & 7))) & 1;
    // Mask 0: invert every module where row + column is even.
    modules[row][col] = bit ^ ((row + col) % 2 === 0 ? 1 : 0);
  });

  qrPlaceFormat(modules, spec, 0);
  return modules;
}

/* An SVG string, which scales to any size and needs no canvas. */
function qrSvg(text, options = {}) {
  const modules = qrMatrix(text);
  if (!modules) return "";

  const quiet = options.quiet ?? 4;
  const size = modules.length + quiet * 2;
  const dark = options.dark || "#0b1220";
  const light = options.light || "#ffffff";

  let path = "";
  modules.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    });
  });

  return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR code linking to ${String(text).replace(/[<>&"]/g, "")}" style="width:100%;height:auto;display:block;image-rendering:pixelated">`
    + `<rect width="${size}" height="${size}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/></svg>`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { qrMatrix, qrSvg, qrEncodeData, qrPickVersion, QR_VERSIONS, QR_EXP, QR_LOG, qrMultiply };
}
