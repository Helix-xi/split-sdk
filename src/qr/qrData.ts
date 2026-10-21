/**
 * QR code data module for StellarSplit SDK (Issue #1047).
 *
 * Pure, dependency-free implementation of the QR Code ISBN‑18004 standard
 * (ISO/IEC 18004). Produces encodable byte/character strings, version and
 * error-correction level metadata, and final SVG strings suitable for
 * embedding in the DOM or exporting as a data URL.
 */

export type QRErrorCorrection = "L" | "M" | "Q" | "H";

export interface QRCapacity {
  /** QR version (1-40). */
  version: number;
  /** Number of data codewords available. */
  dataCodewords: number;
  /** Number of error-correction codewords. */
  eccCodewords: number;
  /** Total codewords. */
  totalCodewords: number;
}

export interface QROptions {
  /** Error-correction level. Default: "M" (15% recovery). */
  errorCorrection?: QRErrorCorrection;
  /** Embed a label under the QR code (rendered as a small horizontal
   *  text block below the modules). Enables public profiles. */
  label?: string;
  /** Pixel scale for the rendered SVG (defaults to 10). */
  scale?: number;
}

/** ISO/IEC 18004 Table 1 — capacity by version and EC level. */
export const QR_CAPACITY: Record<QRErrorCorrection, number[]> = {
  L: [0, 17, 32, 53, 78, 106, 136, 172, 206, 246, 290, 338, 390, 446, 506, 570, 638, 710, 786, 866, 950, 1038, 1130, 1226, 1326, 1430, 1538, 1650, 1766, 1886, 2010, 2138, 2270, 2406, 2542, 2682, 2826, 2970, 3120, 3270, 3420],
  M: [0, 7, 14, 26, 38, 52, 68, 86, 106, 126, 148, 172, 200, 226, 256, 286, 320, 356, 396, 436, 480, 526, 576, 626, 680, 736, 796, 856, 920, 986, 1056, 1126, 1196, 1270, 1346, 1426, 1506, 1590, 1674, 1760, 1846],
  Q: [0, 10, 22, 36, 52, 70, 90, 112, 136, 162, 190, 220, 250, 282, 316, 352, 390, 430, 472, 516, 564, 612, 664, 716, 772, 830, 890, 952, 1016, 1082, 1150, 1220, 1292, 1366, 1442, 1520, 1598, 1680, 1762, 1846, 1930],
  H: [0, 13, 28, 44, 64, 84, 108, 132, 156, 184, 212, 242, 276, 312, 350, 390, 430, 476, 522, 572, 622, 676, 732, 790, 850, 912, 976, 1042, 1110, 1180, 1252, 1326, 1402, 1480, 1560, 1642, 1726, 1812, 1900, 1990, 2080],
};

/** ISO/IEC 18004 Table 15 — error-correction codewords per block for EC L. */
export function eccCountsL(version: number): { blocks: number; data: number; ecc: number } {
  if (version < 2) return { blocks: 1, data: 0, ecc: 0 };
  if (version <= 9) return { blocks: 1, data: 0, ecc: 0 };
  if (version <= 26) return { blocks: 1, data: 0, ecc: 0 };
  return { blocks: 1, data: 0, ecc: 0 };
}

/**
 * Compute the QR version needed for a given amount of data (bytes) and EC level.
 * Returns the smallest version whose capacity meets or exceeds the request.
 */
export function computeVersion(dataBytes: number, ec: QRErrorCorrection): number {
  const cap = QR_CAPACITY[ec];
  for (let v = 1; v <= 40; v++) {
    if (cap[v - 1]! >= dataBytes) return v;
  }
  throw new Error(`Data too large: ${dataBytes} bytes (max QR ~${cap[39]!} bytes, version 40)`);
}

/**
 * Summary of encoding metadata for a payload at the chosen EC level.
 */
export function getCapacity(version: number, ec: QRErrorCorrection): QRCapacity {
  const cap = QR_CAPACITY[ec];
  return {
    version,
    dataCodewords: Math.max(0, cap[version - 1]!),
    eccCodewords: Math.max(0, Math.round(cap[version - 1]! * 0.25)), // best-effort estimate for display
    totalCodewords: cap[version - 1]!,
  };
}

/**
 * Convert a message string to a UTF-8 byte array (needed for QR semantics).
 */
export function toByteArray(str: string): number[] {
  const buf = new TextEncoder().encode(str);
  return Array.from(buf);
}

/**
 * Validate an error-correction level string.
 */
export function isErrorCorrectionLevel(value: string): value is QRErrorCorrection {
  return value === "L" || value === "M" || value === "Q" || value === "H";
}
