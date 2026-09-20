/**
 * VerifEye - Calibrated Log-Odds Signal Fusion
 *
 * Replaces the weighted arithmetic mean the ensemble used to take over raw signal
 * scores. Averaging percentages is the wrong operation for combining evidence: two
 * independent signals each saying "70% AI" should move the verdict further than
 * either alone, but their mean is still 70. Accumulating log-odds does move it, and
 * it lets a one-sided signal (CFA can argue for a camera but never against one)
 * contribute in only the direction it is entitled to.
 *
 *   logit(P) = prior + SUM_i weight_i * evidence_i
 *   P        = sigmoid(logit)
 *
 * where evidence_i is in [-1, +1], negative meaning "argues real".
 *
 * ON THE WEIGHTS: by default they are hand-set priors reflecting how much each signal
 * is believed to be worth, NOT coefficients fitted to labelled data. The honest
 * consequence is that the absolute probability should be read as a ranking rather
 * than as a calibrated likelihood, and `calibrated` in the returned object is false
 * so callers can say so in the UI.
 *
 * Running `npm run calibrate` against a labelled corpus replaces them with a logistic
 * fit and flips that flag. See forensics/calibration.js.
 */

import { CALIBRATION } from './calibration.js';

export const DEFAULT_WEIGHTS = {
    fft: 1.00,        // periodic upsampling artifacts: the strongest standalone cue
    noise: 0.90,      // PRNU / residual kurtosis
    cfa: 1.10,        // demosaicing lattice: rare, but near-decisive when present
    ela: 0.60,        // localized recompression inconsistency
    color: 0.50,      // channel correlation and optical dispersion
    jpegQuant: 0.40   // encoder fingerprint: a tie-breaker, easily erased by any CDN
};

// Signals that may only ever push toward "real". CFA asymmetry proves an optical
// sensor; its absence proves nothing, because resampling erases the lattice too.
const ONE_SIDED_REAL = new Set(['cfa']);

const SENSITIVITY_PRIOR = {
    strict: 0.55,    // shifts the operating point toward flagging
    balanced: 0.0,
    relaxed: -0.55
};

/**
 * @param {Object} signals  keyed by signal name, each {score:0-100, informative?:boolean}
 * @param {Object} options  {sensitivity, weights, prior}
 */
export function fuseSignals(signals, options = {}) {
    // Precedence: explicit per-call weights, then a fitted calibration, then priors.
    const fitted = CALIBRATION.calibrated && CALIBRATION.weights ? CALIBRATION.weights : null;
    const weights = { ...DEFAULT_WEIGHTS, ...(fitted || {}), ...(options.weights || {}) };
    const sensitivity = options.sensitivity || 'balanced';

    // A 0.5 prior states no opinion before evidence. Anything else would be a claim
    // about how much of the open web is synthetic, which we have not measured.
    const prior = (options.prior ?? (fitted ? CALIBRATION.prior : 0)) + (SENSITIVITY_PRIOR[sensitivity] ?? 0);

    let logit = prior;
    let totalWeight = 0;
    let informativeWeight = 0;

    const contributions = [];
    const evidenceValues = [];

    for (const [name, weight] of Object.entries(weights)) {
        totalWeight += weight;

        const signal = signals[name];
        if (!signal || typeof signal.score !== 'number') continue;

        // A signal that declares itself uninformative is skipped outright rather than
        // being folded in at its neutral score, which would dilute the others.
        if (signal.informative === false) continue;
        if (signal.contributesToScore === false) continue;

        let evidence = (signal.score - 50) / 50;   // 0..100 -> -1..+1
        evidence = Math.max(-1, Math.min(1, evidence));

        if (ONE_SIDED_REAL.has(name) && evidence > 0) evidence = 0;

        const contribution = weight * evidence;
        logit += contribution;

        informativeWeight += weight;
        evidenceValues.push({ evidence, weight });
        contributions.push({
            signal: name,
            score: signal.score,
            evidence: Number(evidence.toFixed(3)),
            weight: weight,
            logOdds: Number(contribution.toFixed(3))
        });
    }

    const probability = sigmoid(logit);

    // Uncertainty has two sources: signals that could not be evaluated at all, and
    // disagreement among the ones that could. This is a dispersion band, deliberately
    // NOT called a confidence interval -- it has no coverage guarantee, because the
    // weights are unfitted.
    const coverage = totalWeight > 0 ? informativeWeight / totalWeight : 0;

    let dispersion = 0;
    if (evidenceValues.length > 1) {
        const wSum = evidenceValues.reduce((a, v) => a + v.weight, 0);
        const mean = evidenceValues.reduce((a, v) => a + v.weight * v.evidence, 0) / wSum;
        dispersion = Math.sqrt(
            evidenceValues.reduce((a, v) => a + v.weight * (v.evidence - mean) ** 2, 0) / wSum
        );
    }

    const spread = dispersion * 0.9 + (1 - coverage) * 1.2;
    const low = sigmoid(logit - spread);
    const high = sigmoid(logit + spread);

    contributions.sort((a, b) => Math.abs(b.logOdds) - Math.abs(a.logOdds));

    return {
        probability: Math.round(probability * 100),
        logOdds: Number(logit.toFixed(3)),
        band: [Math.round(low * 100), Math.round(high * 100)],
        coverage: Number(coverage.toFixed(2)),
        agreement: Number((1 - Math.min(1, dispersion)).toFixed(2)),
        calibrated: !!fitted,
        calibrationMeta: fitted ? CALIBRATION.meta : null,
        contributions: contributions
    };
}

function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
}
