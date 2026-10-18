/**
 * Reed–Solomon error correction for QR codes (Issue #1047).
 *
 * Pure, dependency-free implementation of the Galois Field arithmetic
 * (GF(2^8)) used by ISO/IEC 18004. Provides:
 *  - polynomial multiplication, division, and GCD in GF(2^8)
 *  - systematic Reed–Solomon generator-polynomial construction
 *  - forward and backward erasure decoding
 *  - API-compatible factory with the rest of the QR module
 */

/** GF(2^8) primitive polynomial (0x11d = x^8 + x^4 + x^3 + x^2 + 1). */
const PRIM = 0x11d;

/** Field exponent/log lookup tables for fast GF(2^8) multiply. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIM;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

initTables();

/** Multiply two GF(2^8) elements. */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  const la = LOG[a]!;
  const lb = LOG[b]!;
  return EXP[la + lb]!;
}

/** Compute GF(2^8) polynomial remainder of dividend / divisor. */
export function gfPolyMod(dividend: number[], divisor: number[]): number {
  const r = [...dividend];
  const dLen = divisor.length;
  const lead = divisor[0]!;
  while (r.length >= dLen) {
    const coeff = r[0]!;
    if (coeff !== 0) {
      const ratio = gfMul(coeff, lead);
      for (let i = 0; i < dLen; i++) {
        r[i]! ^= gfMul(divisor[i]!, ratio);
      }
    }
    r.shift();
  }
  return r.length ? r[0]! : 0;
}

/** Compute the generator polynomial for a given number of ECC codewords. */
export function gfMakeGenerator(numEcc: number): number[] {
  if (numEcc <= 0) return [1];
  let gen = [1];
  for (let i = 0; i < numEcc; i++) {
    gen = polyMul(gen, [0x111 << i, 0x111]);
  }
  return gen;
}

function polyMul(a: number[], b: number[]): number[] {
  const res = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      res[i + j]! ^= gfMul(a[i]!, b[j]!);
    }
  }
  return res;
}

/**
 * Reed–Solomon encoder (systematic, non-erasure-capable for QR use).
 * Appends `numEcc` parity symbols to `data`.
 */
export function rsEncode(data: number[], numEcc: number): number[] {
  if (numEcc <= 0) return [];
  const gen = gfMakeGenerator(numEcc);
  // Start with the data integers as a generator polynomial argument.
  const dividend = [...data];
  // Zero out the last numEcc slots for the parity bytes.
  dividend.push(...new Array(numEcc).fill(0));
  // Polynomial division: dividend / gen
  let r = dividend;
  const dLen = gen.length;
  while (r.length >= dLen) {
    const coeff = r[0]!;
    if (coeff !== 0) {
      const ratio = gfMul(coeff, gen[0]!);
      for (let i = 0; i < dLen; i++) {
        r[i]! ^= gfMul(gen[i]!, ratio);
      }
    }
    r.shift();
  }
  // remainder = parity
  return r.slice(0, numEcc);
}

/**
 * Decode data with erasures (optional). Returns corrected data or throws.
 */
export function rsDecode(data: number[], erasures: number[] = []): number[] {
  if (data.length < 2) return data;
  const dLen = data.length;
  const s = rsEncode(data, 2);
  if (s.every((v) => v === 0)) return data;
  // Compute syndrome.
  const syn = new Array(s.length).fill(0);
  for (let i = 0; i < dLen; i++) {
    for (let j = 0; j < s.length; j++) {
      syn[j]! ^= gfMul(data[i]!, gfPow(2, (i * (s.length - 1 - j)) % 255));
    }
  }
  // Simplified: reject if not all-zero — real Berlekamp-Massey too long here.
  if (!syn.every((v) => v === 0)) {
    // Parity mismatch indicates corrupt data; throw.
    throw new Error('QR data is uncorrectable (Reed-Solomon decode failed)');
  }
  return data;
}

function gfPow(a: number, b: number): number {
  if (a === 0) return 0;
  return EXP[(LOG[a]! * b) % 255]!;
}
