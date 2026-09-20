/**
 * VerifEye - 2D Fast Fourier Transform (FFT) & Spectral Frequency Analyzer
 * Detects generative periodic grid artifacts, checkerboard patterns,
 * and unnatural high-frequency power spectrum distributions left by
 * Diffusion / GAN / VAE upsampling layers.
 */

export function analyzeFrequencyDomain(imageData, options = {}) {
    const { width, height, data } = imageData;
    const includeSpectrum = !!options.includeSpectrum;
    const N = 128; // Standard power-of-2 tile size for optimal speed & resolution

    if (width < N || height < N) {
        return {
            score: 50,
            confidence: 0,
            gridArtifacts: false,
            peakCount: 0,
            slope: -2.0,
            hfToMfRatio: 1.0,
            spectrum: null,
            details: ['Image dimensions too small for 128x128 2D FFT decomposition']
        };
    }

    // Extract central tile for primary analysis
    const startX = Math.floor((width - N) / 2);
    const startY = Math.floor((height - N) / 2);

    const tileResult = computeTileFFT(data, width, startX, startY, N, includeSpectrum);

    // If image is large enough (>= 256x256), sample an additional quadrant to verify consistency
    let finalScore = tileResult.score;
    let finalPeaks = tileResult.peakCount;
    let finalSlope = tileResult.slope;
    let finalRatio = tileResult.hfToMfRatio;
    const details = [...tileResult.details];

    if (width >= 256 && height >= 256) {
        const qX = Math.floor(width * 0.2);
        const qY = Math.floor(height * 0.2);
        const qResult = computeTileFFT(data, width, qX, qY, N, false);

        // Merge results
        finalScore = Math.round(tileResult.score * 0.6 + qResult.score * 0.4);
        finalPeaks = Math.max(tileResult.peakCount, qResult.peakCount);
        finalSlope = (tileResult.slope + qResult.slope) / 2;
        finalRatio = (tileResult.hfToMfRatio + qResult.hfToMfRatio) / 2;

        if (qResult.gridArtifacts && !tileResult.gridArtifacts) {
            details.push(`Peripheral grid resonance (${qResult.peakCount} harmonic spikes)`);
        }
    }

    return {
        score: finalScore,
        gridArtifacts: finalPeaks >= 4,
        peakCount: finalPeaks,
        slope: Number(finalSlope.toFixed(3)),
        hfToMfRatio: Number(finalRatio.toFixed(3)),
        // The actual |F(u,v)| magnitude of the centre tile, DC-shifted and normalized.
        // Rendering this is the only honest way to show a spectrum to a user.
        spectrum: tileResult.spectrum,
        details: details
    };
}

/**
 * Compute 2D FFT on a single NxN tile from image data
 */
function computeTileFFT(data, fullWidth, startX, startY, N, includeSpectrum = false) {
    const real = new Float32Array(N * N);
    const imag = new Float32Array(N * N);

    // Extract Luminance & apply 2D Hann Window
    for (let y = 0; y < N; y++) {
        const wy = 0.5 * (1 - Math.cos((2 * Math.PI * y) / (N - 1)));
        for (let x = 0; x < N; x++) {
            const wx = 0.5 * (1 - Math.cos((2 * Math.PI * x) / (N - 1)));
            const windowWeight = wx * wy;

            const pixelIdx = ((startY + y) * fullWidth + (startX + x)) * 4;
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

    // Two representations of the same spectrum, because they are used for different
    // things and conflating them is a real bug:
    //
    //   magnitude - log(1+|F|), compressed for display and for peak detection, where
    //               only the ratio to the local neighbourhood matters.
    //   linearMag - raw |F|, used for the radial profile. The power-law fit already
    //               takes a logarithm, so feeding it the log-magnitude would be
    //               fitting log(log(|F|)) against log(r). That flattens every
    //               spectrum to a slope near -0.1 and made the "unnatural flat
    //               decay" rule fire on natural photographs and synthetic images
    //               alike.
    const magnitude = new Float32Array(N * N);
    const linearMag = new Float32Array(N * N);
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
            const abs = Math.sqrt(re * re + im * im);

            linearMag[shiftedIdx] = abs;
            magnitude[shiftedIdx] = Math.log(1 + abs);
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
                radialSum[r] += linearMag[y * N + x];
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

    // Measure deviation from 1/f natural image power law slope (P(f) ~ 1/f^alpha)
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
    const denom = samplePoints * logSumXX - logSumX * logSumX;
    if (samplePoints > 5 && Math.abs(denom) > 1e-7) {
        slope = (samplePoints * logSumXY - logSumX * logSumY) / denom;
    }

    // Ratio of High-Frequency to Mid-Frequency energy
    const hfToMfRatio = totalMidFreqEnergy > 0 ? (totalHighFreqEnergy / totalMidFreqEnergy) : 1.0;

    // Evaluate generative spectral anomaly score (0 to 100)
    let spectralScore = 20; // Default natural baseline
    const details = [];

    // 1. Check for periodic grid upsampling peaks
    if (highFreqPeaks >= 6) {
        spectralScore += 45;
        details.push(`Generative frequency grid detected (${highFreqPeaks} harmonic spikes)`);
    } else if (highFreqPeaks >= 3) {
        spectralScore += 25;
        details.push(`Minor spectral grid resonance (${highFreqPeaks} harmonic spikes)`);
    }

    // 2 & 3. Radial slope and high-to-mid energy ratio: MEASURED AND REPORTED, NOT SCORED.
    //
    // Both were absolute thresholds, and both failed against the reference set:
    //
    //   - The slope threshold (> -1.1) fired on natural 1/f surfaces AND on a 2x
    //     nearest-neighbour upsampled image, so it separated nothing. Its measured
    //     value also depends heavily on the sensor noise floor, which flattens the
    //     high-frequency end of any real photograph.
    //   - The HF/MF threshold (> 1.4) fired on 100% of references, natural and
    //     synthetic, measuring 2.4-3.0 throughout. Worse, it read LOWER on the
    //     upsampled synthetic than on natural content, so where it discriminated at
    //     all it pointed the wrong way.
    //
    // Together they were adding +45 to the highest-weighted signal in the engine for
    // essentially every image, which is what made the studio call a Sony photograph
    // "Likely AI" on page load.
    //
    // The peak count above stays, because it is a different kind of test: it compares
    // each bin against its own local neighbourhood rather than against a constant, so
    // it calibrates itself to the image. It is also the rule that directly detects the
    // artifact this analyzer exists for.
    //
    // These two stay in the returned object for display and for `npm run calibrate` to
    // fit thresholds against a real corpus.

    // 4. Abrupt high-frequency cliff. Kept because it is a qualitative shape, not a
    //    tuned cut: a decoder that discards the top octave outright is not something a
    //    lens and sensor produce. The bound is deliberately far outside the natural
    //    range measured on the references (-0.26 to -1.51).
    if (slope < -4.0) {
        spectralScore += 20;
        details.push(`Abrupt high-frequency attenuation (slope ${slope.toFixed(2)})`);
    }

    spectralScore = Math.min(98, Math.max(5, Math.round(spectralScore)));

    return {
        score: spectralScore,
        gridArtifacts: highFreqPeaks >= 4,
        peakCount: highFreqPeaks,
        slope: slope,
        hfToMfRatio: hfToMfRatio,
        spectrum: includeSpectrum ? packSpectrum(magnitude, N) : null,
        details: details
    };
}

/**
 * Downsample the shifted log-magnitude spectrum to a compact 64x64 byte map that is
 * cheap to hand across a message port and can be blitted straight to a canvas.
 *
 * Pools by MAXIMUM rather than by average: the whole point of looking at the spectrum
 * is to see isolated harmonic spikes, and averaging is exactly the operation that
 * would erase them.
 */
function packSpectrum(magnitude, N, outSize = 64) {
    const factor = Math.max(1, Math.floor(N / outSize));
    const pooled = new Float32Array(outSize * outSize);

    let min = Infinity;
    let max = -Infinity;

    for (let y = 0; y < outSize; y++) {
        for (let x = 0; x < outSize; x++) {
            let peak = 0;
            for (let dy = 0; dy < factor; dy++) {
                const sy = y * factor + dy;
                if (sy >= N) break;
                for (let dx = 0; dx < factor; dx++) {
                    const sx = x * factor + dx;
                    if (sx >= N) break;
                    const v = magnitude[sy * N + sx];
                    if (v > peak) peak = v;
                }
            }
            pooled[y * outSize + x] = peak;
            if (peak < min) min = peak;
            if (peak > max) max = peak;
        }
    }

    const range = max - min;
    const out = new Uint8Array(outSize * outSize);
    for (let i = 0; i < pooled.length; i++) {
        out[i] = range > 1e-6 ? Math.round(((pooled[i] - min) / range) * 255) : 0;
    }

    return { size: outSize, data: out, min: Number(min.toFixed(3)), max: Number(max.toFixed(3)) };
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

    // Cooley-Tukey butterfly computation
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
