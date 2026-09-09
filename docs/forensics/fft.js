/**
 * VerifEye - 2D Fast Fourier Transform (FFT) & Spectral Frequency Analyzer
 * Detects generative periodic grid artifacts, checkerboard patterns,
 * and unnatural high-frequency power spectrum distributions left by
 * Diffusion / GAN / VAE upsampling layers.
 */

export function analyzeFrequencyDomain(imageData) {
    const { width, height, data } = imageData;
    const N = 128; // Standard power-of-2 tile size for optimal speed & resolution

    if (width < N || height < N) {
        return {
            score: 50,
            confidence: 0,
            gridArtifacts: false,
            details: ['Image tile too small for frequency decomposition']
        };
    }

    // Sample central tile
    const startX = Math.floor((width - N) / 2);
    const startY = Math.floor((height - N) / 2);

    // Extract Luminance & apply 2D Hann Window
    const real = new Float32Array(N * N);
    const imag = new Float32Array(N * N);

    for (let y = 0; y < N; y++) {
        const wy = 0.5 * (1 - Math.cos((2 * Math.PI * y) / (N - 1)));
        for (let x = 0; x < N; x++) {
            const wx = 0.5 * (1 - Math.cos((2 * Math.PI * x) / (N - 1)));
            const windowWeight = wx * wy;

            const pixelIdx = ((startY + y) * width + (startX + x)) * 4;
            const r = data[pixelIdx];
            const g = data[pixelIdx + 1];
            const b = data[pixelIdx + 2];
            // Standard perceptual luminance
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;

            real[y * N + x] = (lum - 128.0) * windowWeight;
            imag[y * N + x] = 0;
        }
    }

    // 2D FFT: 1D FFT on rows, then 1D FFT on columns
    fft2d(real, imag, N);

    // Compute shifted power spectrum magnitude
    const magnitude = new Float32Array(N * N);
    const halfN = N / 2;

    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            // Shift zero-frequency to center (halfN, halfN)
            const sx = (x + halfN) % N;
            const sy = (y + halfN) % N;
            const idx = y * N + x;
            const shiftedIdx = sy * N + sx;

            const re = real[idx];
            const im = imag[idx];
            magnitude[shiftedIdx] = Math.log(1 + Math.sqrt(re * re + im * im));
        }
    }

    // Radial Profile & High-Frequency Peak Analysis
    const maxRadius = Math.floor(halfN);
    const radialSum = new Float64Array(maxRadius);
    const radialCount = new Int32Array(maxRadius);

    let highFreqPeaks = 0;
    let totalHighFreqEnergy = 0;
    let totalMidFreqEnergy = 0;

    const midRadiusStart = Math.floor(maxRadius * 0.25);
    const highRadiusStart = Math.floor(maxRadius * 0.55);

    for (let y = 0; y < N; y++) {
        const dy = y - halfN;
        for (let x = 0; x < N; x++) {
            const dx = x - halfN;
            const r = Math.round(Math.sqrt(dx * dx + dy * dy));

            if (r > 0 && r < maxRadius) {
                const val = magnitude[y * N + x];
                radialSum[r] += val;
                radialCount[r]++;

                if (r >= midRadiusStart && r < highRadiusStart) {
                    totalMidFreqEnergy += val;
                } else if (r >= highRadiusStart) {
                    totalHighFreqEnergy += val;
                }

                // Detect isolated frequency peak spikes across mid and high frequency bands
                if (r >= midRadiusStart && isSpectralPeak(magnitude, x, y, N, val)) {
                    highFreqPeaks++;
                }
            }
        }
    }

    // Compute radial averages
    const radialAvg = new Float32Array(maxRadius);
    for (let r = 1; r < maxRadius; r++) {
        radialAvg[r] = radialCount[r] > 0 ? radialSum[r] / radialCount[r] : 0;
    }

    // Measure deviation from 1/f natural image power law slope
    let logSumX = 0, logSumY = 0, logSumXY = 0, logSumXX = 0;
    let samplePoints = 0;
    for (let r = 3; r < maxRadius - 2; r++) {
        if (radialAvg[r] > 0) {
            const logR = Math.log(r);
            const logP = Math.log(radialAvg[r]);
            logSumX += logR;
            logSumY += logP;
            logSumXY += logR * logP;
            logSumXX += logR * logR;
            samplePoints++;
        }
    }

    let slope = -2.0; // Expected natural power law slope ~ -1.5 to -2.5
    if (samplePoints > 5) {
        slope = (samplePoints * logSumXY - logSumX * logSumY) / (samplePoints * logSumXX - logSumX * logSumX);
    }

    // Ratio of High-Frequency to Mid-Frequency energy
    const hfToMfRatio = totalMidFreqEnergy > 0 ? (totalHighFreqEnergy / totalMidFreqEnergy) : 1.0;

    // Evaluate generative spectral anomaly score (0 to 100)
    let spectralScore = 20; // Default natural baseline
    const details = [];

    // 1. Check for periodic grid upsampling peaks
    if (highFreqPeaks >= 6) {
        spectralScore += 45;
        details.push(`High-frequency grid peaks (${highFreqPeaks} harmonic spikes detected)`);
    } else if (highFreqPeaks >= 3) {
        spectralScore += 25;
        details.push(`Minor spectral grid resonance (${highFreqPeaks} harmonic spikes)`);
    }

    // 2. Power law slope anomaly (AI models often have flatter decay or abrupt high-freq roll-off)
    if (slope > -1.1) {
        spectralScore += 25;
        details.push(`Unnatural flat spectral decay (slope: ${slope.toFixed(2)}, expected ~ -2.0)`);
    } else if (slope < -3.2) {
        spectralScore += 20;
        details.push(`Abrupt high-frequency attenuation from neural decoder`);
    }

    // 3. High-to-Mid frequency energy ratio
    if (hfToMfRatio > 1.4) {
        spectralScore += 20;
        details.push(`Elevated high-frequency energy ratio (${hfToMfRatio.toFixed(2)})`);
    }

    spectralScore = Math.min(98, Math.max(5, Math.round(spectralScore)));

    return {
        score: spectralScore,
        gridArtifacts: highFreqPeaks >= 4,
        peakCount: highFreqPeaks,
        slope: slope,
        hfToMfRatio: hfToMfRatio,
        details: details
    };
}

/**
 * Checks if a spectral point is a statistically significant peak above its 5x5 neighborhood
 */
function isSpectralPeak(mag, cx, cy, N, centerVal) {
    if (cx < 2 || cx >= N - 2 || cy < 2 || cy >= N - 2) return false;

    let sum = 0;
    let count = 0;

    for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            if (dx === 0 && dy === 0) continue;
            sum += mag[(cy + dy) * N + (cx + dx)];
            count++;
        }
    }

    const neighborAvg = sum / count;
    return centerVal > neighborAvg * 1.55 && centerVal > 4.5;
}

/**
 * Radix-2 2D FFT
 */
function fft2d(real, imag, N) {
    // 1D FFT along rows
    const rowReal = new Float32Array(N);
    const rowImag = new Float32Array(N);

    for (let y = 0; y < N; y++) {
        const offset = y * N;
        for (let x = 0; x < N; x++) {
            rowReal[x] = real[offset + x];
            rowImag[x] = imag[offset + x];
        }
        fft1d(rowReal, rowImag, N);
        for (let x = 0; x < N; x++) {
            real[offset + x] = rowReal[x];
            imag[offset + x] = rowImag[x];
        }
    }

    // 1D FFT along columns
    const colReal = new Float32Array(N);
    const colImag = new Float32Array(N);

    for (let x = 0; x < N; x++) {
        for (let y = 0; y < N; y++) {
            colReal[y] = real[y * N + x];
            colImag[y] = imag[y * N + x];
        }
        fft1d(colReal, colImag, N);
        for (let y = 0; y < N; y++) {
            real[y * N + x] = colReal[y];
            imag[y * N + x] = colImag[y];
        }
    }
}

/**
 * Cooley-Tukey Radix-2 1D FFT
 */
function fft1d(real, imag, n) {
    // Bit reversal
    let j = 0;
    for (let i = 0; i < n - 1; i++) {
        if (i < j) {
            const tr = real[i]; real[i] = real[j]; real[j] = tr;
            const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
        }
        let k = n >> 1;
        while (k <= j) {
            j -= k;
            k >>= 1;
        }
        j += k;
    }

    // Cooley-Tukey computation
    for (let len = 2; len <= n; len <<= 1) {
        const halfLen = len >> 1;
        const angle = (-2 * Math.PI) / len;
        const wStepR = Math.cos(angle);
        const wStepI = Math.sin(angle);

        for (let i = 0; i < n; i += len) {
            let wr = 1.0;
            let wi = 0.0;
            for (let k = 0; k < halfLen; k++) {
                const uR = real[i + k];
                const uI = imag[i + k];
                const vR = real[i + k + halfLen] * wr - imag[i + k + halfLen] * wi;
                const vI = real[i + k + halfLen] * wi + imag[i + k + halfLen] * wr;

                real[i + k] = uR + vR;
                imag[i + k] = uI + vI;
                real[i + k + halfLen] = uR - vR;
                imag[i + k + halfLen] = uI - vI;

                const nextWr = wr * wStepR - wi * wStepI;
                wi = wr * wStepI + wi * wStepR;
                wr = nextWr;
            }
        }
    }
}
