/**
 * VerifEye - Multi-Signal Forensic Ensemble Engine
 *
 * Orchestrates every analyzer and hands their outputs to the log-odds fusion layer.
 *
 * Signal inventory, and what each one is worth:
 *   metadata    provenance strings, C2PA, EXIF     -- decisive when present (hard override)
 *   fft         periodic upsampling harmonics      -- strongest statistical cue
 *   noise       PRNU residual kurtosis, smoothing  -- strong
 *   cfa         Bayer demosaicing lattice          -- near-decisive FOR a camera, one-sided
 *   ela         recompression error level          -- localizes splices and inpainting
 *   color       channel correlation, dispersion    -- moderate
 *   jpegQuant   encoder quantization fingerprint   -- weak tie-breaker
 *   benford     DCT first-digit divergence         -- DIAGNOSTIC ONLY, never scored
 *
 * Resolution matters and the caller controls it. `imageData` may be downscaled for
 * speed, but CFA and quantization-grid evidence only survive at native resolution, so
 * analyzers that depend on the sampling lattice read `options.nativeData` -- an
 * 8-pixel-aligned native crop -- and mark themselves uninformative when it is absent
 * rather than reporting a reading taken from resampled pixels.
 */

import { analyzeMetadata } from './metadata.js';
import { analyzeFrequencyDomain } from './fft.js';
import { analyzeNoise } from './noise.js';
import { analyzeCompression } from './ela.js';
import { analyzeColor } from './color.js';
import { analyzeCfa } from './cfa.js';
import { analyzeJpegQuantization } from './jpegQuant.js';
import { analyzeBenford } from './benford.js';
import { fuseSignals } from './fusion.js';

const ALL_SIGNALS = {
    metadata: true,
    fft: true,
    noise: true,
    ela: true,
    color: true,
    cfa: true,
    jpegQuant: true,
    benford: true
};

export function runLocalForensicEnsemble(arrayBuffer, imageData, options = {}) {
    const started = now();

    const sensitivity = options.sensitivity || 'balanced';
    const enabled = { ...ALL_SIGNALS, ...(options.signals || {}) };
    const nativeData = options.nativeData || null;
    const wasResampled = options.wasResampled !== false && !nativeData;

    const reasons = [];
    const signals = {};
    const timings = {};

    // --- Layer 1: provenance. An explicit generator tag outranks every statistic. ---
    let metadataResult = null;
    if (enabled.metadata && arrayBuffer) {
        metadataResult = timed(timings, 'metadata', () => analyzeMetadata(arrayBuffer));
        signals.metadata = metadataResult;

        if (metadataResult.detected && metadataResult.isAi) {
            reasons.push(...metadataResult.details);
            return {
                probability: Math.round(metadataResult.confidence * 100),
                classification: 'Likely AI',
                verdict: 'AI_CONFIRMED',
                confidence: metadataResult.confidence,
                band: [Math.round(metadataResult.confidence * 100), Math.round(metadataResult.confidence * 100)],
                agreement: 1,
                coverage: 1,
                calibrated: true,   // a generator that names itself needs no calibration
                reasons: reasons.slice(0, 4),
                generator: metadataResult.generator,
                signals: signals,
                contributions: [{ signal: 'metadata', score: 100, evidence: 1, weight: Infinity, logOdds: Infinity }],
                timings: finishTimings(timings, started),
                engine: 'local_metadata'
            };
        }
    }

    // --- Layer 2: statistical analyzers ---
    if (enabled.fft && imageData) {
        // includeSpectrum is threaded through rather than letting the UI call the
        // analyzer a second time for its picture: one FFT, both consumers.
        signals.fft = timed(timings, 'fft', () => analyzeFrequencyDomain(imageData, {
            includeSpectrum: !!options.includeSpectrum
        }));
    }

    if (enabled.noise && imageData) {
        signals.noise = timed(timings, 'noise', () => analyzeNoise(imageData));
    }

    if (enabled.ela && imageData) {
        // options.residual, when present, upgrades this from the blocking-index
        // heuristic to genuine recompression-difference ELA.
        signals.ela = timed(timings, 'ela', () => analyzeCompression(imageData, { residual: options.residual }));
    }

    if (enabled.color && imageData) {
        signals.color = timed(timings, 'color', () => analyzeColor(imageData));
    }

    // --- Layer 3: lattice-dependent analyzers, native resolution only ---
    if (enabled.cfa) {
        signals.cfa = timed(timings, 'cfa', () => analyzeCfa(nativeData || imageData, { wasResampled }));
    }

    if (enabled.jpegQuant && arrayBuffer) {
        signals.jpegQuant = timed(timings, 'jpegQuant', () => analyzeJpegQuantization(arrayBuffer));
    }

    if (enabled.benford) {
        // Reported in the lab UI, excluded from fusion by its own contributesToScore flag.
        signals.benford = timed(timings, 'benford', () => analyzeBenford(nativeData || imageData, {
            quantTable: signals.jpegQuant?.quantTable
        }));
    }

    for (const result of Object.values(signals)) {
        if (result?.details?.length) reasons.push(...result.details);
    }

    // --- Layer 4: log-odds fusion ---
    const fused = fuseSignals(signals, { sensitivity });

    // Authentic camera provenance is evidence the fusion layer never saw, since
    // metadata only short-circuits in the AI direction above.
    let probability = fused.probability;
    let band = fused.band;
    if (metadataResult && metadataResult.isCamera) {
        probability = Math.max(2, probability - 22);
        band = [Math.max(1, band[0] - 22), Math.max(3, band[1] - 22)];
        reasons.unshift(...metadataResult.details);
    }

    probability = Math.min(99, Math.max(1, probability));

    let classification = 'Likely Real';
    if (probability >= 70) classification = 'Likely AI';
    else if (probability >= 35) classification = 'Uncertain';

    const uniqueReasons = [...new Set(reasons)].filter(Boolean);
    if (uniqueReasons.length === 0) {
        uniqueReasons.push(classification === 'Likely Real'
            ? 'Natural sensor noise and consistent frequency spectrum'
            : 'No decisive synthetic artifact signals');
    }

    return {
        probability: probability,
        classification: classification,
        // Confidence now reflects how much of the evidence was actually available and
        // how well it agreed, rather than just how far the score sits from 50.
        confidence: Number((fused.coverage * fused.agreement).toFixed(2)),
        band: band,
        coverage: fused.coverage,
        agreement: fused.agreement,
        logOdds: fused.logOdds,
        calibrated: fused.calibrated,
        reasons: uniqueReasons.slice(0, 4),
        signals: signals,
        contributions: fused.contributions,
        timings: finishTimings(timings, started),
        engine: 'local_forensics'
    };
}

function now() {
    return (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
}

function timed(store, name, fn) {
    const t0 = now();
    const out = fn();
    store[name] = Number((now() - t0).toFixed(3));
    return out;
}

function finishTimings(store, started) {
    return { ...store, total: Number((now() - started).toFixed(3)) };
}
