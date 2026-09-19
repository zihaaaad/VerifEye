/**
 * VerifEye - DCT First-Digit (Generalized Benford) Analyzer  [DIAGNOSTIC ONLY]
 *
 * Computes the leading-significant-digit distribution of 8x8 block DCT-II AC
 * coefficients and its divergence from the generalized Benford law that Fu, Shi &
 * Su fitted to natural JPEG coefficients (SPIE Electronic Imaging, 2007).
 *
 * THIS SIGNAL DOES NOT VOTE ON THE VERDICT, and that is a measured decision rather
 * than an oversight. Against 1/f fractional-Brownian references (the closest stand-in
 * for natural-image statistics available without a labelled corpus) the divergence
 * tracked grain amplitude and JPEG quality far more strongly than it tracked whether
 * the content was synthetic, and the ordering inverted between quality settings: at
 * q=85 an oversmoothed surface fitted the law BETTER than a natural one. Fusing an
 * uncalibrated statistic that behaves like that would add noise to the verdict while
 * looking authoritative.
 *
 * It is retained because the measurement itself is correct and worth surfacing in the
 * lab UI, and because `npm run calibrate` can fit real thresholds from a labelled
 * corpus. If that fit ever shows separation, set `contributesToScore` and give the
 * signal a weight in fusion.js. Until then it is reported, not counted.
 *
 * Passing the source JPEG's quantization table via `options.quantTable` divides the
 * coefficients back down to the integers the encoder actually stored, which is the
 * domain the published law was fitted in. Without it the statistic is computed on
 * unquantized pixel DCT, which is a different distribution entirely.
 */

// Generalized Benford parameters fitted to natural JPEG DCT coefficients (Fu et al.)
const BENFORD_N = 1.456;
const BENFORD_Q = 1.47;
const BENFORD_S = 0.0372;

// Precomputed 8-point DCT-II basis: COS[x * 8 + u] = cos((2x+1) u pi / 16)
const COS = (() => {
    const t = new Float64Array(64);
    for (let x = 0; x < 8; x++) {
        for (let u = 0; u < 8; u++) {
            t[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
        }
    }
    return t;
})();

const INV_SQRT2 = 1 / Math.SQRT2;

// Model probabilities for digits 1..9, normalized so rounding drift cannot bias chi-square.
const EXPECTED = (() => {
    const p = new Float64Array(10);
    let total = 0;
    for (let d = 1; d <= 9; d++) {
        p[d] = BENFORD_N * Math.log10(1 + 1 / (BENFORD_S + Math.pow(d, BENFORD_Q)));
        total += p[d];
    }
    for (let d = 1; d <= 9; d++) p[d] /= total;
    return p;
})();

// Fusion reads this flag; flip it only once a corpus fit shows real separation.
export const contributesToScore = false;

export function analyzeBenford(imageData, options = {}) {
    const fallback = {
        score: 50,
        contributesToScore: false,
        informative: false,
        chiSquare: 0,
        divergence: 0,
        sampleCount: 0,
        digits: [],
        details: []
    };

    if (!imageData) return fallback;

    const { width, height, data } = imageData;
    if (width < 64 || height < 64) {
        return { ...fallback, details: ['Image too small for block-DCT digit statistics'] };
    }

    const blocksX = Math.floor(width / 8);
    const blocksY = Math.floor(height / 8);
    const totalBlocks = blocksX * blocksY;
    if (totalBlocks < 16) return { ...fallback, details: ['Too few 8x8 blocks for a digit histogram'] };

    // Cap the work on large inputs by striding across blocks rather than taking a
    // contiguous corner, so the sample stays representative of the whole frame.
    const maxBlocks = options.maxBlocks || 2048;
    const stride = Math.max(1, Math.ceil(totalBlocks / maxBlocks));
    const quantTable = options.quantTable && options.quantTable.length === 64 ? options.quantTable : null;

    const observed = new Float64Array(10);
    let sampleCount = 0;

    const block = new Float64Array(64);
    const temp = new Float64Array(64);

    for (let b = 0; b < totalBlocks; b += stride) {
        const bx = (b % blocksX) * 8;
        const by = Math.floor(b / blocksX) * 8;

        // Level-shifted luminance for this block
        for (let y = 0; y < 8; y++) {
            const row = (by + y) * width;
            for (let x = 0; x < 8; x++) {
                const idx = (row + bx + x) * 4;
                const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
                block[y * 8 + x] = lum - 128;
            }
        }

        dct8x8(block, temp);

        // AC coefficients only: the DC term carries block brightness, not texture.
        for (let i = 1; i < 64; i++) {
            // Dividing by the encoder's quantization step recovers the integer the
            // encoder actually stored, which is the domain the published law was fitted in.
            const coefficient = quantTable ? (temp[i] / quantTable[i]) : temp[i];
            const magnitude = Math.round(Math.abs(coefficient));
            if (magnitude < 1) continue;

            let d = magnitude;
            while (d >= 10) d = Math.floor(d / 10);

            observed[d]++;
            sampleCount++;
        }
    }

    if (sampleCount < 500) {
        return { ...fallback, sampleCount, details: ['Insufficient non-zero AC coefficients for a digit test'] };
    }

    // Chi-square against the generalized Benford model, reported per-sample so the
    // figure is comparable across images of very different sizes.
    let chiSquare = 0;
    const digits = [];
    for (let d = 1; d <= 9; d++) {
        const expectedCount = EXPECTED[d] * sampleCount;
        const diff = observed[d] - expectedCount;
        chiSquare += (diff * diff) / expectedCount;
        digits.push(Number((observed[d] / sampleCount).toFixed(4)));
    }

    const chiPerSample = chiSquare / sampleCount;

    // Total-variation distance between observed and model digit distributions.
    let divergence = 0;
    for (let d = 1; d <= 9; d++) {
        divergence += Math.abs(observed[d] / sampleCount - EXPECTED[d]);
    }
    divergence *= 0.5;

    // Reported, deliberately not scored. See the header note: no threshold here
    // survived contact with the reference set, so the score stays neutral at 50.
    const details = [`DCT first-digit divergence ${divergence.toFixed(3)} (diagnostic, not scored)`];

    return {
        score: 50,
        contributesToScore: false,
        informative: true,
        quantized: !!quantTable,
        chiSquare: Number(chiPerSample.toFixed(6)),
        divergence: Number(divergence.toFixed(4)),
        sampleCount: sampleCount,
        digits: digits,
        details: details
    };
}

/**
 * Separable 8x8 DCT-II. Reads `src`, writes coefficients into `dst`.
 */
function dct8x8(src, dst) {
    const rows = new Float64Array(64);

    // 1D DCT across each row
    for (let y = 0; y < 8; y++) {
        const off = y * 8;
        for (let u = 0; u < 8; u++) {
            let sum = 0;
            for (let x = 0; x < 8; x++) {
                sum += src[off + x] * COS[x * 8 + u];
            }
            rows[off + u] = sum * (u === 0 ? INV_SQRT2 : 1);
        }
    }

    // 1D DCT down each column
    for (let u = 0; u < 8; u++) {
        for (let v = 0; v < 8; v++) {
            let sum = 0;
            for (let y = 0; y < 8; y++) {
                sum += rows[y * 8 + u] * COS[y * 8 + v];
            }
            dst[v * 8 + u] = sum * (v === 0 ? INV_SQRT2 : 1) * 0.25;
        }
    }
}
