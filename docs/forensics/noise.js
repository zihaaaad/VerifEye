/**
 * VerifEye - Noise Residual & Spatial Gradient Analyzer
 * Evaluates sensor Photo-Response Non-Uniformity (PRNU), Laplacian high-pass variance,
 * and unnatural diffusion texture smoothing / synthetic grain distribution.
 */

export function analyzeNoise(imageData) {
    const { width, height, data } = imageData;

    if (width < 32 || height < 32) {
        return {
            score: 50,
            syntheticSmoothness: false,
            kurtosis: 3.0,
            smoothRatio: 0,
            variance: 0,
            details: ['Image dimensions too small for noise residual evaluation']
        };
    }

    // Convert to grayscale luminance
    const lum = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        lum[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    }

    // Apply 3x3 Laplacian High-Pass filter to isolate noise residual
    const residual = new Float32Array(width * height);
    let residualSum = 0;
    let residualSumSq = 0;
    let count = 0;

    for (let y = 1; y < height - 1; y++) {
        const row = y * width;
        const rowUp = (y - 1) * width;
        const rowDown = (y + 1) * width;

        for (let x = 1; x < width - 1; x++) {
            const center = lum[row + x];
            const laplacian = 4 * center - (lum[rowUp + x] + lum[rowDown + x] + lum[row + x - 1] + lum[row + x + 1]);
            residual[row + x] = laplacian;

            residualSum += laplacian;
            residualSumSq += laplacian * laplacian;
            count++;
        }
    }

    if (count === 0) return { score: 50, syntheticSmoothness: false, kurtosis: 3.0, smoothRatio: 0, variance: 0, details: [] };

    const mean = residualSum / count;
    const variance = (residualSumSq / count) - (mean * mean);

    // Calculate Kurtosis (Gaussian noise = 3.0; Diffusion / Generative images diverge strongly)
    let sumFourth = 0;
    for (let y = 1; y < height - 1; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
            const diff = residual[row + x] - mean;
            sumFourth += diff * diff * diff * diff;
        }
    }
    const denom = count * variance * variance;
    const kurtosis = denom > 1e-6 ? (sumFourth / denom) : 0;

    // Patch-based local noise variance analysis (detects localized synthetic smoothing in skin/sky)
    const patchSize = 16;
    const patchesX = Math.floor(width / patchSize);
    const patchesY = Math.floor(height / patchSize);
    let flatRegionCount = 0;
    let ultraSmoothCount = 0;
    let totalPatches = 0;

    for (let py = 0; py < patchesY; py++) {
        for (let px = 0; px < patchesX; px++) {
            let pSum = 0, pSumSq = 0, pCount = 0;

            for (let dy = 0; dy < patchSize; dy++) {
                const y = py * patchSize + dy;
                if (y >= height - 1 || y === 0) continue;
                const row = y * width;

                for (let dx = 0; dx < patchSize; dx++) {
                    const x = px * patchSize + dx;
                    if (x >= width - 1 || x === 0) continue;

                    const rVal = residual[row + x];
                    pSum += rVal;
                    pSumSq += rVal * rVal;
                    pCount++;
                }
            }

            if (pCount > 0) {
                const pMean = pSum / pCount;
                const pVar = (pSumSq / pCount) - (pMean * pMean);
                totalPatches++;

                // Low variance patch indicates unnatural synthetic smoothing (plastic skin, clean diffusion gradients)
                if (pVar < 1.2) {
                    ultraSmoothCount++;
                }
                if (pVar < 5.0) {
                    flatRegionCount++;
                }
            }
        }
    }

    const smoothRatio = totalPatches > 0 ? (ultraSmoothCount / totalPatches) : 0;
    const details = [];
    let noiseScore = 25; // Default natural baseline

    // 1. Evaluate Kurtosis anomaly (Diffusion models show extreme leptokurtic or platykurtic residuals)
    if (kurtosis > 8.0) {
        noiseScore += 35;
        details.push(`Synthetic noise distribution (Kurtosis: ${kurtosis.toFixed(1)}, non-Gaussian)`);
    } else if (kurtosis < 1.8 || variance < 0.05) {
        noiseScore += 25;
        details.push(`Artificially uniform / quantized noise residual (Kurtosis: ${kurtosis.toFixed(1)})`);
    }

    // 2. Evaluate Plastic / Diffusion Oversmoothing
    if (smoothRatio > 0.40) {
        noiseScore += 35;
        details.push(`Synthetic diffusion smoothing (${Math.round(smoothRatio * 100)}% ultra-smooth patches)`);
    } else if (smoothRatio > 0.20) {
        noiseScore += 18;
        details.push(`Moderate surface smoothing typical of AI generation`);
    }

    // Natural camera sensor noise grain sanity check
    if (kurtosis >= 2.4 && kurtosis <= 4.2 && smoothRatio < 0.12 && variance > 12) {
        noiseScore = Math.max(8, noiseScore - 20);
        details.push('Natural camera sensor noise grain detected');
    }

    noiseScore = Math.min(98, Math.max(5, Math.round(noiseScore)));

    return {
        score: noiseScore,
        syntheticSmoothness: smoothRatio > 0.25,
        kurtosis: Number(kurtosis.toFixed(2)),
        smoothRatio: Number(smoothRatio.toFixed(3)),
        variance: Number(variance.toFixed(2)),
        details: details
    };
}
