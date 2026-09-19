/**
 * VerifEye - Color Filter Array (CFA) / Demosaicing Trace Analyzer
 * Detects the interpolation lattice left behind by a single-sensor camera.
 *
 * A physical camera records ONE color per photosite through a Bayer mosaic and
 * reconstructs the missing two by interpolation. Interpolated samples are, by
 * construction, near-exact linear combinations of their neighbours, so a bilinear
 * high-pass residual nearly vanishes on them while remaining large on the sampled
 * ones. The green channel is sampled on one diagonal parity class of the 2x2 cell,
 * so a genuine demosaiced frame shows a large variance asymmetry between the two
 * parities. Neural decoders emit all three channels at every pixel simultaneously
 * and leave both parities statistically identical.
 *
 * Asymmetry is evidence FOR a camera. The absence of asymmetry is NOT evidence for
 * AI: any resample, crop to non-even offset, or re-encode erases the lattice too.
 * This module therefore reports a one-sided signal and says so.
 *
 * Reference: Popescu & Farid, "Exposing Digital Forgeries in Color Filter Array
 * Interpolated Images", IEEE Trans. Signal Processing 53(10), 2005.
 */

export function analyzeCfa(imageData, options = {}) {
    const empty = {
        score: 50,
        informative: false,
        parityRatio: 1.0,
        varEven: 0,
        varOdd: 0,
        cameraEvidence: 0,
        details: []
    };

    if (!imageData) return { ...empty, details: ['No native-resolution sample available for CFA analysis'] };

    const { width, height, data } = imageData;
    if (width < 64 || height < 64) {
        return { ...empty, details: ['Sample too small to resolve a demosaicing lattice'] };
    }

    // The lattice only survives at native sensor resolution. A caller that hands us a
    // downscaled buffer gets an explicit "not informative" rather than a bogus reading.
    if (options.wasResampled) {
        return { ...empty, details: ['Image was resampled; CFA lattice is unrecoverable'] };
    }

    // Bilinear prediction residual on the green channel.
    // r(x,y) = G(x,y) - mean(4-neighbourhood)
    let sumEven = 0, sumSqEven = 0, nEven = 0;
    let sumOdd = 0, sumSqOdd = 0, nOdd = 0;

    for (let y = 1; y < height - 1; y++) {
        const row = y * width;
        const rowUp = (y - 1) * width;
        const rowDown = (y + 1) * width;

        for (let x = 1; x < width - 1; x++) {
            const g = data[(row + x) * 4 + 1];
            const predicted = (
                data[(rowUp + x) * 4 + 1] +
                data[(rowDown + x) * 4 + 1] +
                data[(row + x - 1) * 4 + 1] +
                data[(row + x + 1) * 4 + 1]
            ) * 0.25;

            const r = g - predicted;

            if (((x + y) & 1) === 0) {
                sumEven += r; sumSqEven += r * r; nEven++;
            } else {
                sumOdd += r; sumSqOdd += r * r; nOdd++;
            }
        }
    }

    if (nEven < 256 || nOdd < 256) {
        return { ...empty, details: ['Insufficient pixels for parity variance estimate'] };
    }

    const meanEven = sumEven / nEven;
    const meanOdd = sumOdd / nOdd;
    const varEven = Math.max(0, (sumSqEven / nEven) - meanEven * meanEven);
    const varOdd = Math.max(0, (sumSqOdd / nOdd) - meanOdd * meanOdd);

    const hi = Math.max(varEven, varOdd);
    const lo = Math.min(varEven, varOdd);

    // A flat synthetic surface has near-zero residual on both parities; the ratio is
    // then numerically unstable and carries no information either way.
    if (hi < 0.25) {
        return {
            ...empty,
            varEven: Number(varEven.toFixed(4)),
            varOdd: Number(varOdd.toFixed(4)),
            details: ['Residual energy too low to test the demosaicing lattice']
        };
    }

    const parityRatio = lo > 1e-6 ? (hi / lo) : 999;
    const details = [];

    // cameraEvidence is a one-sided score in [0,1]: how strongly the lattice argues
    // for a physical sensor. Zero means "no information", never "argues for AI".
    let cameraEvidence = 0;

    if (parityRatio >= 1.9) {
        cameraEvidence = 1.0;
        details.push(`Bayer demosaicing lattice intact (parity variance ratio ${parityRatio.toFixed(2)}:1)`);
    } else if (parityRatio >= 1.35) {
        cameraEvidence = 0.6;
        details.push(`Partial CFA interpolation trace (parity variance ratio ${parityRatio.toFixed(2)}:1)`);
    } else if (parityRatio >= 1.12) {
        cameraEvidence = 0.25;
    }

    // Map to the 0-100 convention the other analyzers use, where higher means more
    // AI-like. With no lattice we sit at the neutral 50 and contribute nothing.
    const score = Math.round(50 - cameraEvidence * 42);

    return {
        score: score,
        informative: cameraEvidence > 0,
        parityRatio: Number(parityRatio.toFixed(3)),
        varEven: Number(varEven.toFixed(4)),
        varOdd: Number(varOdd.toFixed(4)),
        cameraEvidence: Number(cameraEvidence.toFixed(2)),
        details: details
    };
}
