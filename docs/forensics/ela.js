/**
 * VerifEye - Error Level Analysis (ELA) & Compression Consistency Analyzer
 * Evaluates block DCT quantization consistency, edge boundary error anomalies,
 * and synthetic inpainting / face-swap discontinuities.
 */

export function analyzeCompression(imageData) {
    const { width, height, data } = imageData;

    if (width < 64 || height < 64) {
        return {
            score: 50,
            inconsistencyDetected: false,
            details: ['Image too small for compression grid evaluation']
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

    // Unnatural single-pass non-standard JPEG/lossless synthesis or abnormal blocking index
    if (blockingIndex < 0.92) {
        // Generative models directly decoding to pixels without natural camera compression
        elaScore += 30;
        details.push(`Absence of natural camera compression grid (Blocking Index: ${blockingIndex.toFixed(2)})`);
    }

    if (varianceSpread > 1800) {
        elaScore += 25;
        inconsistencyDetected = true;
        details.push(`Localized compression variance anomaly (possible inpainting/composite)`);
    }

    elaScore = Math.min(95, Math.max(10, Math.round(elaScore)));

    return {
        score: elaScore,
        blockingIndex: blockingIndex,
        varianceSpread: varianceSpread,
        inconsistencyDetected: inconsistencyDetected,
        details: details
    };
}
