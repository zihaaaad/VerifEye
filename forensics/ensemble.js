/**
 * VerifEye - Multi-Signal Forensic Ensemble Engine
 * Fuses Metadata Provenance, 2D FFT Frequency Analysis, Sensor Noise Residual,
 * Error Level Analysis, and Optical Color Dispersion into a calibrated detection score.
 */

import { analyzeMetadata } from './metadata.js';
import { analyzeFrequencyDomain } from './fft.js';
import { analyzeNoise } from './noise.js';
import { analyzeCompression } from './ela.js';
import { analyzeColor } from './color.js';

export function runLocalForensicEnsemble(arrayBuffer, imageData, options = {}) {
    const sensitivity = options.sensitivity || 'balanced'; // 'balanced', 'strict', 'relaxed'
    const enabledSignals = options.signals || {
        metadata: true,
        fft: true,
        noise: true,
        ela: true,
        color: true
    };

    const reasons = [];
    const signalResults = {};

    // 1. Layer 1: Metadata & Provenance (Instant exact check)
    let metadataResult = null;
    if (enabledSignals.metadata && arrayBuffer) {
        metadataResult = analyzeMetadata(arrayBuffer);
        signalResults.metadata = metadataResult;

        if (metadataResult.detected && metadataResult.isAi) {
            reasons.push(...metadataResult.details);
            return {
                probability: Math.round(metadataResult.confidence * 100),
                classification: 'Likely AI',
                verdict: 'AI_CONFIRMED',
                confidence: metadataResult.confidence,
                reasons: reasons,
                generator: metadataResult.generator,
                signals: signalResults,
                engine: 'local_metadata'
            };
        }
    }

    // 2. Layer 2: Algorithmic Forensic Analyzers
    let fftResult = { score: 25, details: [] };
    let noiseResult = { score: 25, details: [] };
    let elaResult = { score: 25, details: [] };
    let colorResult = { score: 25, details: [] };

    let totalWeight = 0;
    let weightedScoreSum = 0;

    if (enabledSignals.fft && imageData) {
        fftResult = analyzeFrequencyDomain(imageData);
        signalResults.fft = fftResult;
        const weight = 0.35;
        weightedScoreSum += fftResult.score * weight;
        totalWeight += weight;
        if (fftResult.details && fftResult.details.length > 0) {
            reasons.push(...fftResult.details);
        }
    }

    if (enabledSignals.noise && imageData) {
        noiseResult = analyzeNoise(imageData);
        signalResults.noise = noiseResult;
        const weight = 0.25;
        weightedScoreSum += noiseResult.score * weight;
        totalWeight += weight;
        if (noiseResult.details && noiseResult.details.length > 0) {
            reasons.push(...noiseResult.details);
        }
    }

    if (enabledSignals.ela && imageData) {
        elaResult = analyzeCompression(imageData);
        signalResults.ela = elaResult;
        const weight = 0.20;
        weightedScoreSum += elaResult.score * weight;
        totalWeight += weight;
        if (elaResult.details && elaResult.details.length > 0) {
            reasons.push(...elaResult.details);
        }
    }

    if (enabledSignals.color && imageData) {
        colorResult = analyzeColor(imageData);
        signalResults.color = colorResult;
        const weight = 0.20;
        weightedScoreSum += colorResult.score * weight;
        totalWeight += weight;
        if (colorResult.details && colorResult.details.length > 0) {
            reasons.push(...colorResult.details);
        }
    }

    let baseScore = totalWeight > 0 ? (weightedScoreSum / totalWeight) : 25;

    // Authentic camera metadata / optics dampening
    if (metadataResult && metadataResult.isCamera) {
        baseScore = Math.max(5, baseScore - 25);
        reasons.unshift(...metadataResult.details);
    }

    // Sensitivity Calibration
    if (sensitivity === 'strict') { // Flags AI more aggressively
        baseScore = Math.min(99, baseScore * 1.15 + 5);
    } else if (sensitivity === 'relaxed') { // Requires stronger evidence
        baseScore = Math.max(1, (baseScore - 5) * 0.85);
    }

    const finalProbability = Math.min(99, Math.max(1, Math.round(baseScore)));

    let classification = 'Likely Real';
    if (finalProbability >= 70) {
        classification = 'Likely AI';
    } else if (finalProbability >= 35) {
        classification = 'Uncertain';
    }

    if (reasons.length === 0) {
        if (classification === 'Likely Real') {
            reasons.push('Natural sensor noise and consistent frequency spectrum');
        } else {
            reasons.push('Inconclusive synthetic artifact signals');
        }
    }

    return {
        probability: finalProbability,
        classification: classification,
        confidence: Math.abs(finalProbability - 50) / 50,
        reasons: reasons.slice(0, 4), // Top 4 reasons for concise display
        signals: signalResults,
        engine: 'local_forensics'
    };
}
