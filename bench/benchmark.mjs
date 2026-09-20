/**
 * VerifEye - Forensic Engine Benchmark
 *
 * Measures how long each analyzer actually takes, because the README and the landing
 * page previously asserted "< 18ms" and nothing in the repository measured anything.
 *
 *   npm run bench          print the table
 *   npm run bench:write    print it and update bench/RESULTS.md
 *
 * WHAT THIS DOES AND DOES NOT MEASURE
 *
 * It measures engine time: the arithmetic from decoded RGBA to a fused verdict, on
 * synthetic inputs of known size, in Node on whatever machine runs it. That is the
 * part of the pipeline the project controls.
 *
 * It does NOT measure network fetch, image decode, or Chrome's scheduling of the
 * service worker, all of which dominate real hover latency and none of which are
 * constant. A figure from here is a floor, not an end-to-end promise, and the
 * generated table says so wherever it is quoted.
 *
 * It measures nothing at all about ACCURACY. Accuracy needs labelled images; see
 * bench/calibrate.mjs.
 */

import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { runLocalForensicEnsemble } from '../forensics/ensemble.js';
import { analyzeFrequencyDomain } from '../forensics/fft.js';
import { analyzeNoise } from '../forensics/noise.js';
import { analyzeCompression } from '../forensics/ela.js';
import { analyzeColor } from '../forensics/color.js';
import { analyzeCfa } from '../forensics/cfa.js';
import { analyzeBenford } from '../forensics/benford.js';
import { analyzeMetadata } from '../forensics/metadata.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const WARMUP = 5;
const RUNS = 25;

/**
 * Deterministic 1/f fractional Brownian surface.
 *
 * Natural scenes have roughly 1/f amplitude spectra and heavy-tailed coefficient
 * marginals. Summed random octaves reproduce both; a sum of sines reproduces
 * neither, and would make every analyzer look faster and better behaved than it is
 * on real input. Seeded so runs are comparable.
 */
function syntheticImage(width, height, { beta = 1.0, grain = 10, seed = 7 } = {}) {
    let state = seed >>> 0;
    const rnd = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };

    const field = new Float64Array(width * height);
    let amplitude = 1.0;
    let totalAmplitude = 0;

    for (let octave = 0; octave < 8; octave++) {
        const n = 2 << octave;
        const lattice = new Float64Array((n + 1) * (n + 1));
        for (let i = 0; i < lattice.length; i++) lattice[i] = rnd() * 2 - 1;

        for (let y = 0; y < height; y++) {
            const gy = (y / height) * n;
            const y0 = Math.floor(gy), fy = gy - y0;
            const wy = fy * fy * (3 - 2 * fy);

            for (let x = 0; x < width; x++) {
                const gx = (x / width) * n;
                const x0 = Math.floor(gx), fx = gx - x0;
                const wx = fx * fx * (3 - 2 * fx);

                const a = lattice[y0 * (n + 1) + x0];
                const b = lattice[y0 * (n + 1) + x0 + 1];
                const c = lattice[(y0 + 1) * (n + 1) + x0];
                const d = lattice[(y0 + 1) * (n + 1) + x0 + 1];

                field[y * width + x] += amplitude *
                    ((a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy);
            }
        }
        totalAmplitude += amplitude;
        amplitude /= Math.pow(2, beta);
    }

    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const v = 128 + (field[i] / totalAmplitude) * 70 + (rnd() - 0.5) * grain;
        const o = i * 4;
        data[o] = data[o + 1] = data[o + 2] = v;
        data[o + 3] = 255;
    }

    return { width, height, data };
}

function measure(label, fn) {
    for (let i = 0; i < WARMUP; i++) fn();

    const samples = [];
    for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        fn();
        samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);

    return {
        label,
        // Median and p95, not mean: a GC pause in one run should not be reported as
        // the typical cost, and the tail is what a user actually notices.
        median: samples[Math.floor(samples.length / 2)],
        p95: samples[Math.floor(samples.length * 0.95)],
        min: samples[0]
    };
}

const fmt = ms => ms < 1 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`;

console.log('\nVerifEye forensic engine benchmark');
console.log(`Node ${process.version} · ${process.platform}/${process.arch} · median of ${RUNS} runs after ${WARMUP} warmup\n`);

const sizes = [
    { label: '256x256', width: 256, height: 256 },
    { label: '384x384 (hover default)', width: 384, height: 384 },
    { label: '768x768 (deep scan)', width: 768, height: 768 }
];

const perSignalRows = [];
const ensembleRows = [];

// Metadata parses bytes, not pixels, so it is timed against a realistic buffer instead.
//
// Two buffers, and the distinction matters: a buffer carrying a generator signature
// makes the ensemble short-circuit on provenance and skip every statistical analyzer.
// Timing the full ensemble against one of those produced a "full ensemble" figure
// faster than any single signal in it -- a measurement of the early return, not of
// the engine. The ensemble is therefore timed on a CLEAN buffer, and the
// short-circuit is timed separately and labelled as the special case it is.
const cleanBuffer = new TextEncoder().encode('x'.repeat(4096)).buffer;
const aiTaggedBuffer = new TextEncoder().encode(
    'x'.repeat(2048) + 'Steps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7' + 'y'.repeat(2048)
).buffer;

for (const size of sizes) {
    const image = syntheticImage(size.width, size.height);

    const results = [
        measure('fft', () => analyzeFrequencyDomain(image)),
        measure('noise', () => analyzeNoise(image)),
        measure('ela (blocking-index fallback)', () => analyzeCompression(image)),
        measure('color', () => analyzeColor(image)),
        measure('cfa', () => analyzeCfa(image, { wasResampled: false })),
        measure('benford (diagnostic)', () => analyzeBenford(image))
    ];

    console.log(`── ${size.label} ${'─'.repeat(Math.max(0, 44 - size.label.length))}`);
    for (const r of results) {
        console.log(`   ${r.label.padEnd(32)} ${fmt(r.median).padStart(9)}   p95 ${fmt(r.p95).padStart(9)}`);
        perSignalRows.push({ size: size.label, ...r });
    }

    const ensemble = measure('full ensemble', () => runLocalForensicEnsemble(
        cleanBuffer, image, { sensitivity: 'balanced', wasResampled: false, nativeData: image }
    ));

    // Sanity guard: if this ever trips, the ensemble took the provenance early return
    // and the number above is measuring the wrong thing.
    const probe = runLocalForensicEnsemble(cleanBuffer, image, { wasResampled: false, nativeData: image });
    if (probe.verdict === 'AI_CONFIRMED') {
        throw new Error('Benchmark invalid: clean buffer triggered the provenance short-circuit');
    }
    if (!probe.signals.fft || !probe.signals.noise) {
        throw new Error('Benchmark invalid: statistical signals did not run');
    }
    console.log(`   ${'FULL ENSEMBLE'.padEnd(32)} ${fmt(ensemble.median).padStart(9)}   p95 ${fmt(ensemble.p95).padStart(9)}\n`);
    ensembleRows.push({ size: size.label, ...ensemble });
}

const meta = measure('metadata (4 KB buffer)', () => analyzeMetadata(aiTaggedBuffer));
// Image built once, outside the timed closure: generating a 384x384 fractal surface
// costs milliseconds and would otherwise be counted as ensemble time.
const shortCircuitImage = syntheticImage(384, 384);
const shortCircuit = measure('provenance short-circuit', () => runLocalForensicEnsemble(
    aiTaggedBuffer, shortCircuitImage, { wasResampled: false }
));

console.log(`── provenance ${'─'.repeat(32)}`);
console.log(`   ${meta.label.padEnd(32)} ${fmt(meta.median).padStart(9)}   p95 ${fmt(meta.p95).padStart(9)}`);
console.log(`   ${shortCircuit.label.padEnd(32)} ${fmt(shortCircuit.median).padStart(9)}   p95 ${fmt(shortCircuit.p95).padStart(9)}`);
console.log('   (the short-circuit skips all statistical analyzers by design)\n');

const hover = ensembleRows.find(r => r.size.startsWith('384'));
console.log(`Headline: full ensemble at the 384x384 hover default runs in ${fmt(hover.median)} (p95 ${fmt(hover.p95)}).`);
console.log('This is engine time only. Network fetch and image decode are excluded and\n' +
            'typically dominate end-to-end hover latency.\n');

if (process.argv.includes('--write')) {
    const lines = [
        '# Benchmark Results',
        '',
        '<!-- Generated by `npm run bench:write`. Do not edit by hand. -->',
        '',
        `Measured on Node ${process.version}, ${process.platform}/${process.arch}, `
            + `median of ${RUNS} runs after ${WARMUP} warmup iterations.`,
        '',
        '**Scope.** These figures are engine time: decoded RGBA in, fused verdict out.',
        'They exclude network fetch, image decode and browser scheduling, which usually',
        'dominate what a user experiences on hover. Treat them as a floor, not as an',
        'end-to-end latency promise. They say nothing about accuracy — that requires a',
        'labelled corpus, see `bench/calibrate.mjs`.',
        '',
        '## Full ensemble',
        '',
        '| Input size | Median | p95 |',
        '| --- | --- | --- |',
        ...ensembleRows.map(r => `| ${r.size} | ${fmt(r.median)} | ${fmt(r.p95)} |`),
        '',
        '## Per signal',
        '',
        '| Input size | Signal | Median | p95 |',
        '| --- | --- | --- | --- |',
        ...perSignalRows.map(r => `| ${r.size} | ${r.label} | ${fmt(r.median)} | ${fmt(r.p95)} |`),
        `| n/a | ${meta.label} | ${fmt(meta.median)} | ${fmt(meta.p95)} |`,
        `| 384x384 | ${shortCircuit.label} | ${fmt(shortCircuit.median)} | ${fmt(shortCircuit.p95)} |`,
        '',
        '## Notes',
        '',
        '- Inputs are seeded 1/f fractional-Brownian surfaces, which reproduce the',
        '  amplitude spectrum and heavy-tailed coefficient statistics of natural scenes.',
        '  Smoother synthetic inputs would make every analyzer look faster than it is.',
        '- ELA is timed in its blocking-index fallback mode. True ELA additionally needs a',
        '  JPEG re-encode round trip, which requires a browser canvas and is not available',
        '  under Node.',
        '- The Benford analyzer is timed for completeness but does not contribute to any',
        '  verdict; see the header of `forensics/benford.js`.',
        '- The provenance short-circuit is a separate row because it is a different code',
        '  path: when a file names its own generator the ensemble returns immediately and',
        '  runs no statistical analyzer at all. Folding it into the ensemble row would',
        '  report an early return as though it were the cost of a full analysis.',
        ''
    ];

    const target = join(root, 'bench', 'RESULTS.md');
    await writeFile(target, lines.join('\n'));
    console.log(`Wrote ${target}`);
}
