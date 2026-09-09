/**
 * VerifEye - Color Space & Optical Chromatic Aberration Analyzer
 * Evaluates optical lens dispersion (radial chromatic fringing),
 * RGB inter-channel correlation, and synthetic color gamut entropy.
 */

export function analyzeColor(imageData) {
    const { width, height, data } = imageData;

    if (width < 32 || height < 32) {
        return {
            score: 50,
            hasLensAberration: false,
            details: ['Image too small for chromatic analysis']
        };
    }

    const totalPixels = width * height;
    let sumR = 0, sumG = 0, sumB = 0;
    let sumRR = 0, sumGG = 0, sumBB = 0;
    let sumRG = 0, sumGB = 0;

    // Saturation histogram (16 bins)
    const satHistogram = new Int32Array(16);

    for (let i = 0; i < totalPixels; i++) {
        const idx = i * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        sumR += r; sumG += g; sumB += b;
        sumRR += r * r; sumGG += g * g; sumBB += b * b;
        sumRG += r * g; sumGB += g * b;

        // Calculate saturation: (max - min) / max
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max > 0 ? (max - min) / max : 0;
        const bin = Math.min(15, Math.floor(sat * 16));
        satHistogram[bin]++;
    }

    // Pearson correlation between color channels
    const meanR = sumR / totalPixels;
    const meanG = sumG / totalPixels;
    const meanB = sumB / totalPixels;

    const varR = (sumRR / totalPixels) - (meanR * meanR);
    const varG = (sumGG / totalPixels) - (meanG * meanG);
    const varB = (sumBB / totalPixels) - (meanB * meanB);

    const stdR = Math.sqrt(Math.max(1e-6, varR));
    const stdG = Math.sqrt(Math.max(1e-6, varG));
    const stdB = Math.sqrt(Math.max(1e-6, varB));

    const covRG = (sumRG / totalPixels) - (meanR * meanG);
    const covGB = (sumGB / totalPixels) - (meanG * meanB);

    const corrRG = covRG / (stdR * stdG + 1e-6);
    const corrGB = covGB / (stdG * stdB + 1e-6);

    // Saturation Entropy
    let satEntropy = 0;
    for (let b = 0; b < 16; b++) {
        if (satHistogram[b] > 0) {
            const p = satHistogram[b] / totalPixels;
            satEntropy -= p * Math.log2(p);
        }
    }

    // Radial Peripheral Edge Chromatic Aberration Test
    // Physical lenses cause slight R/B shift at high-contrast edges near corners
    const centerX = width / 2;
    const centerY = height / 2;
    const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);

    let edgeCount = 0;
    let chromaticMisalignmentSum = 0;

    // Sample edges in outer 35% radius
    for (let y = 2; y < height - 2; y += 2) {
        const dy = y - centerY;
        for (let x = 2; x < width - 2; x += 2) {
            const dx = x - centerX;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist > maxDist * 0.65) {
                const idx = (y * width + x) * 4;
                const idxRight = (y * width + (x + 1)) * 4;

                const gDiff = Math.abs(data[idx + 1] - data[idxRight + 1]);
                if (gDiff > 35) { // High contrast edge
                    const rDiff = Math.abs(data[idx] - data[idxRight]);
                    const bDiff = Math.abs(data[idx + 2] - data[idxRight + 2]);

                    // Lens chromatic dispersion causes R/B gradients to peak at slightly different positions
                    const dispersion = Math.abs(rDiff - bDiff);
                    chromaticMisalignmentSum += dispersion;
                    edgeCount++;
                }
            }
        }
    }

    const avgDispersion = edgeCount > 0 ? (chromaticMisalignmentSum / edgeCount) : 0;
    const hasLensAberration = avgDispersion > 12.0 && edgeCount > 15;

    let colorScore = 30;
    const details = [];

    // Evaluate anomalies
    if (corrRG > 0.985 && corrGB > 0.985) {
        colorScore += 25;
        details.push('Hyper-correlated color channels (typical of synthetic diffusion VAE)');
    }

    if (satEntropy < 2.0 && totalPixels > 10000) {
        colorScore += 20;
        details.push('Unnatural synthetic color gamut compression');
    }

    if (hasLensAberration) {
        colorScore = Math.max(10, colorScore - 30);
        details.push('Optical lens chromatic dispersion detected (authentic camera artifact)');
    }

    colorScore = Math.min(95, Math.max(5, Math.round(colorScore)));

    return {
        score: colorScore,
        hasLensAberration: hasLensAberration,
        avgDispersion: avgDispersion,
        corrRG: corrRG,
        satEntropy: satEntropy,
        details: details
    };
}
