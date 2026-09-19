/**
 * VerifEye - JPEG Quantization Table Fingerprint Analyzer
 * Identifies the encoder that last wrote the file from its DQT tables.
 *
 * Camera firmware (Canon, Nikon, Sony) and Adobe products ship hand-tuned
 * quantization tables that do not match the IJG Annex K reference at any quality
 * setting. Pillow, libjpeg, GIMP and virtually every Python image pipeline emit the
 * Annex K table scaled by the standard IJG quality formula, so the table matches a
 * single integer quality with essentially zero residual. Since nearly all generative
 * output is written out through Pillow, an exact Annex K match is weak evidence of a
 * software pipeline and a custom table is weak evidence of a camera.
 *
 * "Weak" is deliberate: CDNs re-encode camera photographs with libjpeg all the time,
 * which erases a custom table. This analyzer is a tie-breaker, never a verdict.
 */

// ITU-T T.81 Annex K.1 / K.2 reference tables, in raster order.
const IJG_LUMA = [
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99
];

// Zigzag position -> raster index, as DQT payloads are stored in zigzag order.
const ZIGZAG = [
    0, 1, 8, 16, 9, 2, 3, 10,
    17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63
];

export function analyzeJpegQuantization(arrayBuffer) {
    const result = {
        score: 50,
        informative: false,
        isJpeg: false,
        estimatedQuality: null,
        tableDeviation: null,
        isStandardTable: false,
        subsampling: null,
        progressive: false,
        encoderClass: 'unknown',
        // Exposed so benford.js can divide DCT coefficients back down to the integers
        // the encoder actually stored, which is the domain its law was fitted in.
        quantTable: null,
        details: []
    };

    if (!arrayBuffer || arrayBuffer.byteLength < 4) return result;

    const bytes = new Uint8Array(arrayBuffer);
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return result; // not a JPEG
    result.isJpeg = true;

    const parsed = parseJpegSegments(bytes);
    if (!parsed.lumaTable) {
        result.details.push('JPEG carries no readable luminance quantization table');
        return result;
    }

    result.progressive = parsed.progressive;
    result.subsampling = parsed.subsampling;
    result.quantTable = Array.from(parsed.lumaTable);

    const match = matchIjgQuality(parsed.lumaTable);
    result.estimatedQuality = match.quality;
    result.tableDeviation = Number(match.rms.toFixed(3));

    // An exact Annex K match lands within rounding noise of a single integer quality.
    result.isStandardTable = match.rms < 0.75;

    if (result.isStandardTable) {
        result.encoderClass = 'library';
        result.informative = true;
        result.score = 58;
        result.details.push(`Standard IJG quantization table at quality ~${match.quality} (libjpeg/Pillow-class encoder)`);

        // Pillow's default save path for generative output clusters at high quality
        // with no chroma subsampling, which a camera essentially never produces.
        if (match.quality >= 90 && parsed.subsampling === '4:4:4') {
            result.score = 64;
            result.details.push('High-quality 4:4:4 library encode, typical of a script-written export');
        }
    } else if (match.rms > 4.0) {
        result.encoderClass = 'custom';
        result.informative = true;
        result.score = 36;
        result.details.push(`Non-standard quantization table (RMS ${match.rms.toFixed(1)} from IJG), consistent with camera or Adobe firmware`);
    } else {
        result.encoderClass = 'ambiguous';
        result.score = 50;
    }

    return result;
}

/**
 * Walk the JPEG marker chain collecting the first luminance DQT and the SOF geometry.
 */
function parseJpegSegments(bytes) {
    const out = { lumaTable: null, progressive: false, subsampling: null };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;

    while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xFF) { offset++; continue; }

        const marker = bytes[offset + 1];
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
            offset += 2;
            continue;
        }
        if (marker === 0xD9 || marker === 0xDA) break; // EOI, or entropy data begins

        if (offset + 4 > bytes.length) break;
        const length = view.getUint16(offset + 2);
        if (length < 2 || offset + 2 + length > bytes.length) break;

        const segStart = offset + 4;
        const segEnd = offset + 2 + length;

        if (marker === 0xDB) { // DQT, may pack several tables per segment
            let p = segStart;
            while (p < segEnd) {
                const precision = bytes[p] >> 4;   // 0 = 8-bit, 1 = 16-bit
                const tableId = bytes[p] & 0x0F;
                p++;

                const entryBytes = precision === 0 ? 1 : 2;
                if (p + 64 * entryBytes > segEnd) break;

                const raster = new Uint16Array(64);
                for (let i = 0; i < 64; i++) {
                    raster[ZIGZAG[i]] = precision === 0
                        ? bytes[p + i]
                        : view.getUint16(p + i * 2);
                }
                p += 64 * entryBytes;

                if (tableId === 0 && !out.lumaTable) out.lumaTable = raster;
            }
        } else if (marker === 0xC2) {
            out.progressive = true;
            readSof(bytes, segStart, segEnd, out);
        } else if (marker === 0xC0 || marker === 0xC1) {
            readSof(bytes, segStart, segEnd, out);
        }

        offset = segEnd;
    }

    return out;
}

function readSof(bytes, segStart, segEnd, out) {
    // precision(1) height(2) width(2) numComponents(1) then 3 bytes per component
    const compOffset = segStart + 5;
    if (compOffset >= segEnd) return;

    const numComponents = bytes[compOffset];
    if (numComponents < 3) return;

    const base = compOffset + 1;
    if (base + 3 > segEnd) return;

    // Sampling factors of the luminance component determine the subsampling scheme.
    const hSamp = bytes[base + 1] >> 4;
    const vSamp = bytes[base + 1] & 0x0F;

    if (hSamp === 1 && vSamp === 1) out.subsampling = '4:4:4';
    else if (hSamp === 2 && vSamp === 1) out.subsampling = '4:2:2';
    else if (hSamp === 2 && vSamp === 2) out.subsampling = '4:2:0';
    else out.subsampling = `${hSamp}x${vSamp}`;
}

/**
 * Find the IJG quality setting whose scaled Annex K table best explains the observed
 * one, and report the RMS residual of that best fit.
 */
function matchIjgQuality(table) {
    let bestQuality = 50;
    let bestRms = Infinity;

    for (let q = 1; q <= 100; q++) {
        const scale = q < 50 ? Math.floor(5000 / q) : (200 - 2 * q);

        let sumSq = 0;
        for (let i = 0; i < 64; i++) {
            let expected = Math.floor((IJG_LUMA[i] * scale + 50) / 100);
            if (expected < 1) expected = 1;
            if (expected > 255) expected = 255;

            const diff = table[i] - expected;
            sumSq += diff * diff;
        }

        const rms = Math.sqrt(sumSq / 64);
        if (rms < bestRms) {
            bestRms = rms;
            bestQuality = q;
        }
    }

    return { quality: bestQuality, rms: bestRms };
}
