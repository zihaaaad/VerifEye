/**
 * VerifEye - Error Level Analysis (ELA) & Compression Consistency Analyzer
 *
 * Runs in one of two modes:
 *
 *  - TRUE ELA, when the caller passes `options.residual` from recompress.js. The
 *    image has been re-encoded at a known quality and differenced, so localized
 *    regions carrying a different compression history (a splice, an inpainted patch,
 *    a regenerated face) stand out as error-level outliers. This is what ELA means.
 *
 *  - BLOCKING-INDEX FALLBACK, when no residual is available (Node tests, tainted
 *    canvas, platforms without an encoder). This measures 8x8 boundary discontinuity
 *    against interior discontinuity. It is a proxy for compression history, not ELA,
 *    and `mode` in the returned object says which one produced the numbers.
 */

export function analyzeCompression(imageData, options = {}) {
    const { width, height, data } = imageData;

    if (width < 64 || height < 64) {
        return {
            score: 50,
            blockingIndex: 1.0,
            varianceSpread: 0,
            inconsistencyDetected: false,
            details: ['Image dimensions too small for compression grid evaluation']
        };
    }

    const blockSize = 8;
    const blocksX = Math.floor(width / blockSize);
    const blocksY = Math.floor(height / blockSize);

    // Analyze 8x8 block boundary discontinuities (JPEG grid artifact detector)
    let horizontalBoundaryDiff = 0;
    let verticalBoundaryDiff = 0;
    let internalDiff = 0;
    let countH = 0, countV = 0, countInt = 0;

    for (let y = 1; y < height - 1; y++) {
        const isBlockBoundaryY = (y % blockSize === 0);
        const row = y * width;
        const rowNext = (y + 1) * width;

        for (let x = 1; x < width - 1; x++) {
            const isBlockBoundaryX = (x % blockSize === 0);
            const idx = (row + x) * 4;
            const idxRight = (row + x + 1) * 4;
            const idxDown = (rowNext + x) * 4;

            // Luminance
            const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
            const lumRight = 0.299 * data[idxRight] + 0.587 * data[idxRight + 1] + 0.114 * data[idxRight + 2];
            const lumDown = 0.299 * data[idxDown] + 0.587 * data[idxDown + 1] + 0.114 * data[idxDown + 2];

            const diffH = Math.abs(lum - lumRight);
            const diffV = Math.abs(lum - lumDown);

            if (isBlockBoundaryX) {
                horizontalBoundaryDiff += diffH;
                countH++;
            } else {
                internalDiff += diffH;
                countInt++;
            }

            if (isBlockBoundaryY) {
                verticalBoundaryDiff += diffV;
                countV++;
            }
        }
    }

    const avgH = countH > 0 ? horizontalBoundaryDiff / countH : 0;
    const avgV = countV > 0 ? verticalBoundaryDiff / countV : 0;
    const avgInt = countInt > 0 ? internalDiff / countInt : 0;

    // Blocking Artifact Index (BAI)
    const boundaryAvg = (avgH + avgV) / 2;
    const blockingIndex = avgInt > 0 ? (boundaryAvg / avgInt) : 1.0;

    // Variance distribution across blocks to check for synthetic inpainting or local anomaly
    const blockVariances = new Float32Array(blocksX * blocksY);
    let blockIdx = 0;

    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            let bSum = 0, bSumSq = 0;

            for (let dy = 0; dy < blockSize; dy++) {
                const y = by * blockSize + dy;
                const row = y * width;
                for (let dx = 0; dx < blockSize; dx++) {
                    const x = bx * blockSize + dx;
                    const pIdx = (row + x) * 4;
                    const lum = 0.299 * data[pIdx] + 0.587 * data[pIdx + 1] + 0.114 * data[pIdx + 2];
                    bSum += lum;
                    bSumSq += lum * lum;
                }
            }

            const bMean = bSum / (blockSize * blockSize);
            const bVar = (bSumSq / (blockSize * blockSize)) - (bMean * bMean);
            blockVariances[blockIdx++] = bVar;
        }
    }

    // Measure variance of block variances (high variance of variance indicates localized synthetic generation / inpainting)
    let vSum = 0, vSumSq = 0;
    for (let i = 0; i < blockVariances.length; i++) {
        vSum += blockVariances[i];
        vSumSq += blockVariances[i] * blockVariances[i];
    }
    const meanVar = vSum / (blockVariances.length || 1);
    const varOfVar = (vSumSq / (blockVariances.length || 1)) - (meanVar * meanVar);
    const varianceSpread = Math.sqrt(Math.max(0, varOfVar));

    let elaScore = 25;
    const details = [];
    let inconsistencyDetected = false;
    let mode = 'blocking_index';
    let ela = null;

    // True ELA supersedes the heuristic whenever the caller could supply a residual.
    if (options.residual && options.residual.length === width * height) {
        mode = 'true_ela';
        ela = measureResidual(options.residual, width, height);

        if (ela.outlierBlockRatio > 0.045) {
            elaScore += 32;
            inconsistencyDetected = true;
            details.push(`Error-level outliers across ${(ela.outlierBlockRatio * 100).toFixed(1)}% of blocks (localized recompression history)`);
        } else if (ela.outlierBlockRatio > 0.02) {
            elaScore += 14;
            details.push(`Minor error-level inconsistency (${(ela.outlierBlockRatio * 100).toFixed(1)}% of blocks)`);
        }

        // In a camera photograph the recompression error concentrates on edges, because
        // that is where the quantizer discards the most, so an error floor that ignores
        // local detail is suggestive. It is REPORTED BUT NOT SCORED: unlike the outlier
        // ratio above -- which is self-calibrating, since MAD sets the threshold from the
        // image's own block distribution -- any cutoff on this correlation would be a
        // guess until a labelled corpus fixes one. `npm run calibrate` is where that
        // number should come from.
        if (ela.edgeCorrelation < 0.12 && ela.meanResidual > 0.8) {
            details.push(`Error level weakly coupled to image detail (edge correlation ${ela.edgeCorrelation.toFixed(2)}, diagnostic)`);
        }
    }

    // Unnatural single-pass non-standard JPEG/lossless synthesis or abnormal blocking index
    if (mode === 'blocking_index') {
        if (blockingIndex < 0.92) {
            // A generative decoder writes pixels directly, with no camera-side quantizer
            // to leave a boundary discontinuity at the 8x8 grid.
            elaScore += 30;
            details.push(`Absence of natural camera compression grid (Blocking Index: ${blockingIndex.toFixed(2)})`);
        }

        if (varianceSpread > 1800) {
            elaScore += 25;
            inconsistencyDetected = true;
            details.push(`Localized compression variance anomaly (possible inpainting/composite)`);
        }
    }

    elaScore = Math.min(95, Math.max(10, Math.round(elaScore)));

    return {
        score: elaScore,
        mode: mode,
        blockingIndex: Number(blockingIndex.toFixed(2)),
        varianceSpread: Number(varianceSpread.toFixed(1)),
        inconsistencyDetected: inconsistencyDetected,
        meanResidual: ela ? ela.meanResidual : null,
        outlierBlockRatio: ela ? ela.outlierBlockRatio : null,
        edgeCorrelation: ela ? ela.edgeCorrelation : null,
        details: details
    };
}

/**
 * Summarize a recompression residual into the three figures that matter:
 * how large the error is, how much of it is localized into outlier blocks, and
 * whether it tracks image detail the way an optical capture does.
 */
function measureResidual(residual, width, height) {
    const blockSize = 8;
    const blocksX = Math.floor(width / blockSize);
    const blocksY = Math.floor(height / blockSize);

    const blockResidual = new Float64Array(blocksX * blocksY);
    const blockEdge = new Float64Array(blocksX * blocksY);
    let total = 0;

    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            let rSum = 0;
            let eSum = 0;

            for (let dy = 0; dy < blockSize; dy++) {
                const y = by * blockSize + dy;
                const row = y * width;
                for (let dx = 0; dx < blockSize; dx++) {
                    const x = bx * blockSize + dx;
                    const v = residual[row + x];
                    rSum += v;

                    // Local gradient magnitude stands in for "how much detail is here".
                    if (x + 1 < width && y + 1 < height) {
                        eSum += Math.abs(residual[row + x + 1] - v) + Math.abs(residual[row + width + x] - v);
                    }
                }
            }

            const n = blockSize * blockSize;
            const idx = by * blocksX + bx;
            blockResidual[idx] = rSum / n;
            blockEdge[idx] = eSum / n;
            total += rSum;
        }
    }

    const meanResidual = total / (width * height);

    // Median and MAD rather than mean and sigma: the outliers we are hunting would
    // otherwise inflate the very threshold meant to catch them.
    const sorted = Float64Array.from(blockResidual).sort();
    const median = sorted.length ? sorted[sorted.length >> 1] : 0;

    const deviations = Float64Array.from(blockResidual, v => Math.abs(v - median)).sort();
    const mad = deviations.length ? deviations[deviations.length >> 1] : 0;

    const threshold = median + 3 * (mad > 1e-6 ? mad : 0.5);
    let outliers = 0;
    for (let i = 0; i < blockResidual.length; i++) {
        if (blockResidual[i] > threshold) outliers++;
    }

    // Pearson correlation between per-block error and per-block detail.
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    const n = blockResidual.length;
    for (let i = 0; i < n; i++) {
        const a = blockResidual[i];
        const b = blockEdge[i];
        sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
    }
    const cov = sxy / n - (sx / n) * (sy / n);
    const sdA = Math.sqrt(Math.max(1e-9, sxx / n - (sx / n) ** 2));
    const sdB = Math.sqrt(Math.max(1e-9, syy / n - (sy / n) ** 2));
    const edgeCorrelation = cov / (sdA * sdB);

    return {
        meanResidual: Number(meanResidual.toFixed(3)),
        outlierBlockRatio: Number((n > 0 ? outliers / n : 0).toFixed(4)),
        edgeCorrelation: Number(edgeCorrelation.toFixed(3))
    };
}
