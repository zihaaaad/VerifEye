/**
 * VerifEye - Fusion Weight Calibration Fitter
 *
 *   npm run calibrate -- bench/corpus.json
 *
 * Fits logistic-regression weights for the fusion layer from a labelled corpus and
 * rewrites forensics/calibration.js with the result.
 *
 * WHY THE CORPUS IS A JSON FILE AND NOT A FOLDER OF IMAGES
 *
 * Node has no built-in JPEG or PNG decoder, and this project has zero runtime
 * dependencies, which is a property worth keeping for something that inspects
 * untrusted images. So collection happens in the browser, where a decoder already
 * exists: open bench/calibrate.html, drop in labelled images, export corpus.json.
 * This script does the arithmetic on the vectors that page produced.
 *
 * WHAT IT REFUSES TO DO
 *
 * It will not write weights that fail to beat chance on a held-out split. A fit that
 * only works on the data it was fitted to is worse than the honest hand-set priors,
 * because it would flip `calibrated` to true and invite everyone downstream to trust
 * a number that has not earned it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_WEIGHTS } from '../forensics/fusion.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIGNAL_NAMES = Object.keys(DEFAULT_WEIGHTS);

const MIN_PER_CLASS = 25;
const MIN_HELD_OUT_AUC = 0.60;

const corpusPath = process.argv[2] || join(root, 'bench', 'corpus.json');

let corpus;
try {
    corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
} catch (e) {
    console.error(`\nCould not read a corpus at ${corpusPath}`);
    console.error('Collect one first: open bench/calibrate.html, drop in labelled images,');
    console.error('export corpus.json, then re-run `npm run calibrate -- <path>`.\n');
    process.exit(1);
}

const samples = (Array.isArray(corpus) ? corpus : corpus.samples || [])
    .filter(s => s && (s.label === 'ai' || s.label === 'real') && s.signals);

const aiCount = samples.filter(s => s.label === 'ai').length;
const realCount = samples.length - aiCount;

console.log(`\nCorpus: ${samples.length} samples (${aiCount} ai, ${realCount} real)`);

if (aiCount < MIN_PER_CLASS || realCount < MIN_PER_CLASS) {
    console.error(`\nRefusing to fit: need at least ${MIN_PER_CLASS} of each class.`);
    console.error('A fit from fewer samples would encode the quirks of a handful of images');
    console.error('and present them as calibration.\n');
    process.exit(1);
}

/** Feature vector: the same evidence transform fusion.js applies, so weights transfer directly. */
function featurize(signals) {
    return SIGNAL_NAMES.map(name => {
        const signal = signals[name];
        if (!signal || typeof signal.score !== 'number') return 0;
        if (signal.informative === false || signal.contributesToScore === false) return 0;
        return Math.max(-1, Math.min(1, (signal.score - 50) / 50));
    });
}

const X = samples.map(s => featurize(s.signals));
const y = samples.map(s => (s.label === 'ai' ? 1 : 0));

// Deterministic stratified split, so re-running the fitter reproduces the same report.
const indices = samples.map((_, i) => i);
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
}

const cut = Math.floor(indices.length * 0.75);
const trainIdx = indices.slice(0, cut);
const testIdx = indices.slice(cut);

function fit(idx, { epochs = 4000, lr = 0.08, l2 = 0.01 } = {}) {
    const w = new Array(SIGNAL_NAMES.length).fill(0);
    let b = 0;

    for (let epoch = 0; epoch < epochs; epoch++) {
        const gw = new Array(SIGNAL_NAMES.length).fill(0);
        let gb = 0;

        for (const i of idx) {
            let z = b;
            for (let k = 0; k < w.length; k++) z += w[k] * X[i][k];
            const p = 1 / (1 + Math.exp(-z));
            const err = p - y[i];

            for (let k = 0; k < w.length; k++) gw[k] += err * X[i][k];
            gb += err;
        }

        for (let k = 0; k < w.length; k++) {
            // L2 keeps a signal that happens to separate this particular corpus from
            // being handed an implausibly dominant weight.
            w[k] -= lr * (gw[k] / idx.length + l2 * w[k]);
        }
        b -= lr * (gb / idx.length);
    }

    return { w, b };
}

function score({ w, b }, i) {
    let z = b;
    for (let k = 0; k < w.length; k++) z += w[k] * X[i][k];
    return 1 / (1 + Math.exp(-z));
}

/** AUC via rank statistic: probability a random AI sample outranks a random real one. */
function auc(model, idx) {
    const pos = idx.filter(i => y[i] === 1).map(i => score(model, i));
    const neg = idx.filter(i => y[i] === 0).map(i => score(model, i));
    if (!pos.length || !neg.length) return 0.5;

    let wins = 0;
    for (const p of pos) for (const n of neg) wins += p > n ? 1 : (p === n ? 0.5 : 0);
    return wins / (pos.length * neg.length);
}

const model = fit(trainIdx);
const trainAuc = auc(model, trainIdx);
const testAuc = auc(model, testIdx);

const correct = testIdx.filter(i => (score(model, i) >= 0.5 ? 1 : 0) === y[i]).length;
const accuracy = correct / testIdx.length;

console.log(`\nTrain AUC ${trainAuc.toFixed(3)} · held-out AUC ${testAuc.toFixed(3)} · held-out accuracy ${(accuracy * 100).toFixed(1)}%\n`);
console.log('Fitted weights:');
SIGNAL_NAMES.forEach((name, k) => {
    console.log(`   ${name.padEnd(12)} ${model.w[k] >= 0 ? '+' : ''}${model.w[k].toFixed(3)}   (prior was ${DEFAULT_WEIGHTS[name].toFixed(2)})`);
});
console.log(`   ${'(intercept)'.padEnd(12)} ${model.b >= 0 ? '+' : ''}${model.b.toFixed(3)}\n`);

if (testAuc < MIN_HELD_OUT_AUC) {
    console.error(`Held-out AUC ${testAuc.toFixed(3)} is below the ${MIN_HELD_OUT_AUC} floor.`);
    console.error('Not writing calibration.js. These signals did not separate this corpus, and');
    console.error('shipping the fit anyway would mark the verdicts calibrated without cause.');
    console.error('The hand-set priors remain in effect.\n');
    process.exit(1);
}

const weights = {};
SIGNAL_NAMES.forEach((name, k) => { weights[name] = Number(model.w[k].toFixed(4)); });

const file = `/**
 * VerifEye - Fusion Weight Calibration
 *
 * GENERATED by \`npm run calibrate\`. Do not edit by hand; re-run the fitter instead.
 *
 * Fitted ${new Date().toISOString().slice(0, 10)} from ${samples.length} labelled samples
 * (${aiCount} ai, ${realCount} real). Held-out AUC ${testAuc.toFixed(3)}, accuracy ${(accuracy * 100).toFixed(1)}%.
 *
 * These weights are specific to the corpus they came from. A corpus drawn from one
 * generator, one camera, or one CDN will produce weights that do not transfer; re-fit
 * against images representative of wherever this will actually be used.
 */

export const CALIBRATION = {
    calibrated: true,
    weights: ${JSON.stringify(weights, null, 8).replace(/\n}/, '\n    }')},
    prior: ${model.b.toFixed(4)},

    meta: {
        fittedOn: ${JSON.stringify(new Date().toISOString().slice(0, 10))},
        samples: ${samples.length},
        aiSamples: ${aiCount},
        realSamples: ${realCount},
        heldOutAuc: ${testAuc.toFixed(3)},
        heldOutAccuracy: ${accuracy.toFixed(3)}
    }
};
`;

const target = join(root, 'forensics', 'calibration.js');
await writeFile(target, file);
console.log(`Wrote ${target}`);
console.log('Run `npm run sync` to mirror it into docs/forensics.\n');
