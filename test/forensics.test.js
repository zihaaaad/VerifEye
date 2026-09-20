/**
 * VerifEye - Forensic Multi-Signal Automated Unit Test Suite
 * Validates metadata parsing, 2D FFT, noise residual, ELA, color, and ensemble calibration.
 */

import { analyzeMetadata } from '../forensics/metadata.js';
import { analyzeFrequencyDomain } from '../forensics/fft.js';
import { analyzeNoise } from '../forensics/noise.js';
import { analyzeCompression } from '../forensics/ela.js';
import { analyzeColor } from '../forensics/color.js';
import { runLocalForensicEnsemble } from '../forensics/ensemble.js';
import { analyzeCfa } from '../forensics/cfa.js';
import { analyzeJpegQuantization } from '../forensics/jpegQuant.js';
import { analyzeBenford, contributesToScore as benfordScores } from '../forensics/benford.js';
import { fuseSignals } from '../forensics/fusion.js';
import { CALIBRATION } from '../forensics/calibration.js';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
    totalTests++;
    if (condition) {
        passedTests++;
        console.log(`  ✓ PASS: ${message}`);
    } else {
        failedTests++;
        console.error(`  ✗ FAIL: ${message}`);
    }
}

function createSyntheticImageData(width, height, fillPattern = 'flat') {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            if (fillPattern === 'flat') {
                data[idx] = 128;
                data[idx + 1] = 128;
                data[idx + 2] = 128;
                data[idx + 3] = 255;
            } else if (fillPattern === 'noise') {
                const n = Math.floor(Math.random() * 256);
                data[idx] = n;
                data[idx + 1] = n;
                data[idx + 2] = n;
                data[idx + 3] = 255;
            } else if (fillPattern === 'checkerboard') {
                const isGrid = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0);
                const val = isGrid ? 220 : 40;
                data[idx] = val;
                data[idx + 1] = val;
                data[idx + 2] = val;
                data[idx + 3] = 255;
            } else if (fillPattern === 'chromatic') {
                data[idx] = Math.min(255, x * 2);
                data[idx + 1] = Math.min(255, y * 2);
                data[idx + 2] = Math.min(255, (x + y));
                data[idx + 3] = 255;
            }
        }
    }
    return { width, height, data };
}

/**
 * Simulates a demosaiced camera frame: green is measured on one diagonal parity and
 * bilinearly interpolated on the other, which is exactly the asymmetry analyzeCfa hunts.
 */
function createDemosaicedImageData(width, height) {
    const green = new Float64Array(width * height);
    for (let i = 0; i < width * height; i++) green[i] = 120 + (Math.random() - 0.5) * 80;

    const out = Float64Array.from(green);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            if (((x + y) & 1) === 1) {
                out[y * width + x] = (green[(y - 1) * width + x] + green[(y + 1) * width + x] +
                                      green[y * width + x - 1] + green[y * width + x + 1]) / 4;
            }
        }
    }

    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const o = i * 4;
        data[o] = data[o + 1] = data[o + 2] = out[i];
        data[o + 3] = 255;
    }
    return { width, height, data };
}

const IJG_LUMA = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
];
const ZIGZAG = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
];

/** Builds a minimal JPEG header carrying a chosen quantization table and SOF geometry. */
function buildJpegHeader(quality, custom, hSamp, vSamp) {
    const scale = quality < 50 ? Math.floor(5000 / quality) : (200 - 2 * quality);
    const raster = IJG_LUMA.map(v => {
        let e = Math.floor((v * scale + 50) / 100);
        if (custom) e += 17 + (v % 5) * 6;
        return Math.max(1, Math.min(255, e));
    });
    const zigzag = ZIGZAG.map(r => raster[r]);

    return new Uint8Array([
        0xFF, 0xD8,
        0xFF, 0xDB, 0x00, 0x43, 0x00, ...zigzag,
        0xFF, 0xC0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x01, 0x00, 0x03,
        0x01, (hSamp << 4) | vSamp, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
        0xFF, 0xD9
    ]).buffer;
}

function stringToArrayBuffer(str) {
    const encoder = new TextEncoder();
    return encoder.encode(str).buffer;
}

console.log('\n======================================================');
console.log('  VerifEye AI Image Forensics Test Suite');
console.log('======================================================\n');

// ----------------------------------------------------
// 1. Metadata Analyzer Tests
// ----------------------------------------------------
console.log('▶ Testing Layer 1: Metadata & Provenance Analyzer...');

// Test 1.1: Empty buffer
const emptyMeta = analyzeMetadata(new ArrayBuffer(0));
assert(!emptyMeta.detected && !emptyMeta.isAi, 'Empty buffer handles gracefully without throwing');

// Test 1.2: Stable Diffusion A1111 parameters
const sdBuffer = stringToArrayBuffer('Header... Steps: 25, Sampler: DPM++ 2M Karras, CFG scale: 7, Model: v1-5-pruned ...');
const sdMeta = analyzeMetadata(sdBuffer);
assert(sdMeta.isAi === true && sdMeta.generator.includes('Stable Diffusion'), 'Detects Stable Diffusion WebUI metadata');

// Test 1.3: ComfyUI workflow
const comfyBuffer = stringToArrayBuffer('{"nodes": [], "class_type": "KSampler", "class_type": "CheckpointLoaderSimple"}');
const comfyMeta = analyzeMetadata(comfyBuffer);
assert(comfyMeta.isAi === true && comfyMeta.generator.includes('ComfyUI'), 'Detects ComfyUI workflow parameters');

// Test 1.4: Flux.1 Black Forest Labs
const fluxBuffer = stringToArrayBuffer('Header... Flux.1 Schnell generation prompt with flux_guidance 3.5 ...');
const fluxMeta = analyzeMetadata(fluxBuffer);
assert(fluxMeta.isAi === true && fluxMeta.generator.includes('Flux.1'), 'Detects Flux.1 Black Forest Labs provenance');

// Test 1.5: Midjourney v6
const mjBuffer = stringToArrayBuffer('Prompt: ultra detailed portrait --v 6.0 --ar 16:9 --stylize 250');
const mjMeta = analyzeMetadata(mjBuffer);
assert(mjMeta.isAi === true && mjMeta.generator.includes('Midjourney'), 'Detects Midjourney generation flags');

// Test 1.6: C2PA synthetic media manifest
const c2paBuffer = stringToArrayBuffer('c2pa.created with digitalSourceType: trainedAlgorithmicMedia');
const c2paMeta = analyzeMetadata(c2paBuffer);
assert(c2paMeta.isAi === true && c2paMeta.confidence === 1.0, 'Detects standard C2PA algorithmic media claim');

// Test 1.7: Authentic camera EXIF metadata
const cameraBuffer = stringToArrayBuffer('SONY ILCE-7RM4 ExposureTime: 1/250 FNumber: 2.8 ISO: 100 FocalLength: 50.0 mm');
const cameraMeta = analyzeMetadata(cameraBuffer);
assert(cameraMeta.isCamera === true && cameraMeta.isAi === false, 'Detects authentic Sony camera EXIF tags');

// ----------------------------------------------------
// 2. 2D FFT Frequency Analyzer Tests
// ----------------------------------------------------
console.log('\n▶ Testing Layer 2: 2D FFT Frequency Spectrum Analyzer...');

// Test 2.1: Small dimension guard
const smallImg = createSyntheticImageData(64, 64);
const smallFft = analyzeFrequencyDomain(smallImg);
assert(smallFft.score === 50 && smallFft.gridArtifacts === false, 'Small dimensions (<128px) return safe fallback');

// Test 2.2: Standard 128x128 flat image
const flatImg = createSyntheticImageData(128, 128, 'flat');
const flatFft = analyzeFrequencyDomain(flatImg);
assert(!isNaN(flatFft.slope) && !isNaN(flatFft.score), 'Slope and score are strictly non-NaN on flat image');

// Test 2.3: Periodic checkerboard pattern (simulating upsampling grid)
const gridImg = createSyntheticImageData(128, 128, 'checkerboard');
const gridFft = analyzeFrequencyDomain(gridImg);
assert(gridFft.score > 50, `Checkerboard pattern triggers elevated frequency score (${gridFft.score}%)`);

// Test 2.4: Multi-quadrant verification on 256x256 image
const largeImg = createSyntheticImageData(256, 256, 'noise');
const largeFft = analyzeFrequencyDomain(largeImg);
assert(typeof largeFft.score === 'number' && largeFft.score >= 0 && largeFft.score <= 100, '256x256 image executes multi-tile FFT decomposition');

// ----------------------------------------------------
// 3. Sensor Noise Residual (PRNU) Tests
// ----------------------------------------------------
console.log('\n▶ Testing Layer 3: Noise Residual & Kurtosis Analyzer...');

// Test 3.1: Small dimension guard
const tinyNoise = analyzeNoise(createSyntheticImageData(16, 16));
assert(tinyNoise.score === 50, 'Tiny dimensions (<32px) return safe default score');

// Test 3.2: Ultra-smooth flat image (simulating plastic diffusion oversmoothing)
const smoothNoise = analyzeNoise(flatImg);
assert(smoothNoise.syntheticSmoothness === true && smoothNoise.score >= 70, 'Detects 100% synthetic oversmoothing on flat surface');

// Test 3.3: Random sensor noise
const randomNoise = analyzeNoise(largeImg);
assert(typeof randomNoise.kurtosis === 'number' && !isNaN(randomNoise.kurtosis), 'Computes valid kurtosis metric on noise surface');

// ----------------------------------------------------
// 4. Error Level Analysis (ELA) Tests
// ----------------------------------------------------
console.log('\n▶ Testing Layer 4: ELA & Compression Grid Analyzer...');

// Test 4.1: Standard 128x128 image
const flatEla = analyzeCompression(flatImg);
assert(!isNaN(flatEla.blockingIndex) && !isNaN(flatEla.varianceSpread), 'Calculates valid Blocking Index and Variance Spread');

// ----------------------------------------------------
// 5. Color & Optical Chromatic Dispersion Tests
// ----------------------------------------------------
console.log('\n▶ Testing Layer 5: Color Space & Lens Dispersion Analyzer...');

// Test 5.1: Chromatic gradient image
const chromaticImg = createSyntheticImageData(128, 128, 'chromatic');
const chromaticRes = analyzeColor(chromaticImg);
assert(!isNaN(chromaticRes.corrRG) && !isNaN(chromaticRes.satEntropy), 'Computes Pearson correlation and saturation entropy');

// ----------------------------------------------------
// 6. Calibrated Multi-Signal Ensemble Tests
// ----------------------------------------------------
console.log('\n▶ Testing Multi-Signal Ensemble Orchestration...');

// Test 6.1: Immediate AI Confirmation on AI Metadata
const ensembleAi = runLocalForensicEnsemble(sdBuffer, flatImg);
assert(ensembleAi.verdict === 'AI_CONFIRMED' && ensembleAi.probability >= 95, 'Ensemble returns instant AI_CONFIRMED on metadata match');

// Test 6.2: Authentic Camera EXIF dampens AI score
const ensembleCamera = runLocalForensicEnsemble(cameraBuffer, flatImg);
assert(ensembleCamera.probability < ensembleAi.probability, 'Authentic camera metadata reduces probability score');

// Test 6.3: Sensitivity Profiles
const strictResult = runLocalForensicEnsemble(new ArrayBuffer(10), flatImg, { sensitivity: 'strict' });
const relaxedResult = runLocalForensicEnsemble(new ArrayBuffer(10), flatImg, { sensitivity: 'relaxed' });
assert(strictResult.probability >= relaxedResult.probability, 'Strict sensitivity yields higher or equal AI probability than relaxed');

// Test 6.4: Selective Signal Disabling
const noFftResult = runLocalForensicEnsemble(new ArrayBuffer(10), flatImg, {
    signals: { metadata: true, fft: false, noise: true, ela: true, color: true }
});
assert(!noFftResult.signals.fft, 'Honors disabled signals in ensemble options');

// ----------------------------------------------------
// 7. CFA / Demosaicing Lattice Analyzer
// ----------------------------------------------------
console.log('\n▶ Testing Layer 6: CFA Demosaicing Lattice Analyzer...');

const demosaiced = analyzeCfa(createDemosaicedImageData(128, 128), { wasResampled: false });
assert(demosaiced.informative === true && demosaiced.parityRatio > 1.9,
    `Detects a Bayer interpolation lattice (parity ratio ${demosaiced.parityRatio})`);
assert(demosaiced.score < 50, 'Lattice presence pushes the score toward "real"');

const fullRes = analyzeCfa(createSyntheticImageData(128, 128, 'noise'), { wasResampled: false });
assert(fullRes.informative === false && fullRes.score === 50,
    'Full-resolution synthetic content yields a neutral, non-informative CFA reading');

const resampled = analyzeCfa(createDemosaicedImageData(128, 128), { wasResampled: true });
assert(resampled.informative === false,
    'Declares itself uninformative on resampled input rather than reporting a resize');

// The one-sided contract: absence of a lattice must never argue FOR AI.
assert(fullRes.score <= 50 && resampled.score <= 50,
    'CFA never scores above neutral, so a missing lattice cannot be used as AI evidence');

// ----------------------------------------------------
// 8. JPEG Quantization Table Fingerprint
// ----------------------------------------------------
console.log('\n▶ Testing Layer 7: JPEG Encoder Fingerprint...');

const libraryJpeg = analyzeJpegQuantization(buildJpegHeader(95, false, 1, 1));
assert(libraryJpeg.isJpeg && libraryJpeg.estimatedQuality === 95 && libraryJpeg.tableDeviation === 0,
    'Recovers the exact IJG quality from a standard quantization table');
assert(libraryJpeg.encoderClass === 'library' && libraryJpeg.subsampling === '4:4:4',
    'Classifies a standard-table encode as a library encoder and reads its subsampling');

const cameraJpeg = analyzeJpegQuantization(buildJpegHeader(90, true, 2, 2));
assert(cameraJpeg.encoderClass === 'custom' && cameraJpeg.tableDeviation > 4,
    `Flags a non-standard table as camera/Adobe class (RMS ${cameraJpeg.tableDeviation})`);
assert(cameraJpeg.score < libraryJpeg.score,
    'A custom table scores more "real" than a standard library table');

assert(analyzeJpegQuantization(new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer).isJpeg === false,
    'Non-JPEG input is reported as such without throwing');
assert(libraryJpeg.quantTable.length === 64,
    'Exposes the 64-entry luminance table for downstream coefficient work');

// ----------------------------------------------------
// 9. Benford Diagnostic Contract
// ----------------------------------------------------
console.log('\n▶ Testing Diagnostic Signal Isolation...');

assert(benfordScores === false, 'Benford analyzer declares itself non-scoring');
const benford = analyzeBenford(createSyntheticImageData(256, 256, 'noise'));
assert(benford.score === 50 && benford.contributesToScore === false,
    'Benford returns a neutral score and never votes on the verdict');

// The guard that keeps an uncalibrated signal out of the fusion arithmetic.
const withBenford = fuseSignals({ fft: { score: 60 }, benford: { score: 99, contributesToScore: false } });
const withoutBenford = fuseSignals({ fft: { score: 60 } });
assert(withBenford.probability === withoutBenford.probability,
    'Fusion ignores a non-scoring signal even when its score is extreme');

// ----------------------------------------------------
// 10. Log-Odds Fusion
// ----------------------------------------------------
console.log('\n▶ Testing Log-Odds Fusion Layer...');

const single = fuseSignals({ fft: { score: 70 } });
const double = fuseSignals({ fft: { score: 70 }, noise: { score: 70 } });
assert(double.probability > single.probability,
    `Independent agreeing signals accumulate (${single.probability}% -> ${double.probability}%)`);

const neutral = fuseSignals({ fft: { score: 50 }, noise: { score: 50 } });
assert(neutral.probability === 50, 'All-neutral evidence leaves the verdict at 50%');

const agree = fuseSignals({ fft: { score: 85 }, noise: { score: 82 }, ela: { score: 80 } });
const conflict = fuseSignals({ fft: { score: 90 }, noise: { score: 15 }, ela: { score: 85 } });
assert(conflict.agreement < agree.agreement,
    `Disagreement is reported as lower agreement (${conflict.agreement} < ${agree.agreement})`);
assert((conflict.band[1] - conflict.band[0]) > (agree.band[1] - agree.band[0]),
    'Conflicting evidence widens the uncertainty band');

const skipped = fuseSignals({ fft: { score: 60 }, cfa: { score: 50, informative: false } });
const counted = fuseSignals({ fft: { score: 60 } });
assert(skipped.probability === counted.probability,
    'An uninformative signal is skipped rather than diluting the others toward 50%');

const cfaReal = fuseSignals({ fft: { score: 60 }, cfa: { score: 8, informative: true } });
const cfaHigh = fuseSignals({ fft: { score: 60 }, cfa: { score: 95, informative: true } });
assert(cfaReal.probability < counted.probability, 'CFA evidence for a camera lowers the verdict');
assert(cfaHigh.probability === counted.probability,
    'CFA is clamped one-sided: a high CFA score cannot raise the verdict');

assert(fuseSignals({ fft: { score: 60 } }, { sensitivity: 'strict' }).probability >
       fuseSignals({ fft: { score: 60 } }, { sensitivity: 'relaxed' }).probability,
    'Sensitivity shifts the operating point through the prior');

// ----------------------------------------------------
// 11. Honest Reporting Contract
// ----------------------------------------------------
console.log('\n▶ Testing Honest Reporting Contract...');

assert(CALIBRATION.calibrated === false,
    'Ships uncalibrated, so no verdict claims a fit that was never performed');

const reported = runLocalForensicEnsemble(new ArrayBuffer(10), flatImg);
assert(reported.calibrated === false, 'Ensemble propagates the uncalibrated flag to callers');
assert(Array.isArray(reported.band) && reported.band.length === 2,
    'Every verdict carries an uncertainty band, not just a point estimate');
assert(reported.band[0] <= reported.probability && reported.probability <= reported.band[1],
    'The reported probability lies inside its own band');
assert(typeof reported.timings.total === 'number' && reported.timings.total >= 0,
    'Ensemble reports real measured timings');
assert(Array.isArray(reported.contributions),
    'Ensemble exposes per-signal contributions so a verdict can be argued with');

// The provenance short-circuit is a different code path and must stay distinguishable.
assert(ensembleAi.verdict === 'AI_CONFIRMED' && ensembleAi.calibrated === true,
    'A self-declared generator is marked calibrated: it needs no statistical fit');

console.log('\n======================================================');
console.log(`  Test Results: ${passedTests} passed, ${failedTests} failed (${totalTests} total)`);
console.log('======================================================\n');

if (failedTests > 0) {
    process.exit(1);
}
