/**
 * VerifEye - Fusion Weight Calibration
 *
 * Holds fitted fusion weights when someone has run a calibration, and says so
 * honestly when nobody has.
 *
 * Out of the box `calibrated` is false and `weights` is null, so fusion.js falls back
 * to the hand-set priors in DEFAULT_WEIGHTS and every verdict is reported as
 * uncalibrated all the way up to the UI. That is the truthful default for a detector
 * shipped without a labelled corpus: the probabilities rank images sensibly, but they
 * are not calibrated likelihoods and nothing in the project pretends otherwise.
 *
 * To replace it with something fitted:
 *
 *   1. Open bench/calibrate.html and drop in labelled images (real and AI).
 *   2. Export the collected signal vectors as corpus.json.
 *   3. Run `npm run calibrate -- bench/corpus.json`, which fits logistic weights,
 *      reports AUC against a held-out split, and rewrites this file.
 *
 * The fitter refuses to write weights that fail to beat chance on held-out data, so
 * a `calibrated: true` here means a real fit that actually separated the classes.
 */

export const CALIBRATION = {
    calibrated: false,
    weights: null,
    prior: 0,

    // Populated by the fitter: corpus size, held-out AUC, accuracy, and when it ran.
    meta: null
};
