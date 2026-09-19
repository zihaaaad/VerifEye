# VerifEye

**Image forensics that runs in your browser.** Hover any image on any page and VerifEye
reads the physical traces a camera leaves and a neural decoder does not — sensor noise,
the Bayer demosaicing lattice, Fourier harmonics, compression history, provenance
metadata — then fuses them into a verdict with the uncertainty it actually carries.

No uploads. No API keys required. No network calls in the default mode. Zero runtime
dependencies.

```
┌─ Verdict ────────────────────────────────────┐
│  Likely Real          18%                    │
│  Plausible range 9–31% · agreement 87%       │
│                                              │
│  cfa        ████████▌              −1.10     │
│  noise           ██▌               −0.34     │
│  fft              ▌                +0.08     │
│  jpegQuant      ███                −0.40     │
└──────────────────────────────────────────────┘
```

---

## What it actually measures

Eight analyzers, each reading a different physical or statistical trace. Seven vote;
one is measured and displayed but deliberately excluded from the verdict.

| Signal | What it reads | Weight |
| --- | --- | --- |
| **Metadata** | PNG `tEXt`/`iTXt` chunks, JPEG APP segments, XMP, EXIF, C2PA manifests. Finds A1111 parameters, ComfyUI graphs, Midjourney flags, and camera bodies. | Decisive |
| **2D FFT** | Radix-2 Fourier transform over Hann-windowed luminance tiles. Hunts the periodic harmonics that transposed convolutions and PixelShuffle upsampling leave behind, and fits the radial power-law slope against the 1/f² natural-image law. | 1.00 |
| **CFA lattice** | Bayer demosaicing traces. A single-sensor camera measures green on one diagonal parity and *interpolates* the other, so a bilinear residual nearly vanishes on half the pixels. Neural decoders emit every channel at every pixel and leave both parities identical. | 1.10 |
| **Noise residual** | Laplacian high-pass residual, kurtosis against the Gaussian 3.0, and patch-wise detection of the oversmoothing diffusion models produce on skin and sky. | 0.90 |
| **Error Level Analysis** | Re-encodes at a known quality and differences the result. Regions carrying a different compression history — a splice, an inpainted patch, a regenerated face — stand out as error-level outliers. | 0.60 |
| **Color & optics** | Inter-channel Pearson correlation, saturation entropy, and radial chromatic dispersion at peripheral high-contrast edges, which physical glass produces and a decoder does not. | 0.50 |
| **Encoder fingerprint** | Parses JPEG DQT tables and matches them against the IJG Annex K reference at every quality. Cameras and Adobe ship custom tables; Pillow and libjpeg ship the standard one scaled. | 0.40 |
| **DCT first-digit law** | Generalized Benford divergence over block-DCT coefficients. **Diagnostic only — see below.** | — |

### The CFA signal is one-sided, on purpose

A demosaicing lattice proves an optical sensor. Its *absence* proves nothing: any
resize, crop to an odd offset, or re-encode erases it too. So CFA may push a verdict
toward "real" and is structurally forbidden from pushing it toward "AI". The fusion
layer clamps it, and a test asserts the clamp holds.

### Why one signal doesn't vote

`forensics/benford.js` measures correctly and is excluded from scoring anyway.

Tested against 1/f fractional-Brownian references — the closest stand-in for natural
image statistics available without a labelled corpus — its divergence tracked grain
amplitude and JPEG quality far more strongly than it tracked whether content was
synthetic. The ordering even inverted between quality settings: at q=85 an oversmoothed
surface fitted the law *better* than a natural one. Fusing a statistic that behaves
like that would add noise to the verdict while looking authoritative.

It stays visible in the UI, labelled as diagnostic. If `npm run calibrate` ever shows
real separation on a labelled corpus, flip `contributesToScore` and give it a weight.

---

## How the verdict is computed

Signals are combined in **log-odds**, not averaged:

```
logit(P) = prior + Σ weightᵢ × evidenceᵢ        evidenceᵢ ∈ [−1, +1]
P        = sigmoid(logit)
```

Averaging percentages is the wrong operation for combining evidence. Two independent
signals each saying "70% AI" should move the verdict further than either alone — their
mean is still 70, their log-odds sum is not. In practice one signal at 70 yields 60%;
two yield 68%.

Every verdict carries three numbers beyond the headline probability:

- **Band** — a plausible range, widened by signal disagreement and by evidence that
  could not be gathered. A bare percentage hides both.
- **Agreement** — how much the contributing signals concur.
- **Coverage** — how much of the total available evidence weight was actually usable.

### On calibration — read this before trusting a number

**The shipped weights are hand-set priors, not coefficients fitted to labelled data.**
Every verdict reports `calibrated: false`, and the UI says so.

Read the probabilities as a **ranking**, not as calibrated likelihoods. A 72% is more
suspicious than a 44%; it is not "72% likely to be AI".

To fix that properly:

```bash
# 1. Collect signal vectors from labelled images, in the browser
npx serve .          # then open bench/calibrate.html
                     # drop in real photos and known-AI images, export corpus.json

# 2. Fit logistic weights and report held-out AUC
npm run calibrate -- bench/corpus.json
npm run sync
```

The fitter **refuses to write weights that fail to beat chance on a held-out split**.
A fit that only works on its own training data would flip `calibrated` to true and
invite everyone downstream to trust a number that has not earned it.

---

## Resolution matters

Lattice evidence only survives at native resolution. Rescaling resamples every pixel,
erasing the Bayer lattice and shifting the JPEG block grid off its phase — an analyzer
reading those from a scaled buffer measures the *resize*, not the image.

So `forensics/decode.js` produces two views of every image: a bounded working buffer
for speed, and an **8-pixel-aligned centre crop at true sensor resolution** for the
analyzers that need it. Signals that depend on the lattice mark themselves
uninformative when that crop is unavailable rather than reporting a reading they
cannot support.

---

## Performance

Measured, not asserted. Run `npm run bench`; results land in
[`bench/RESULTS.md`](bench/RESULTS.md).

| Input | Full ensemble (median) |
| --- | --- |
| 256×256 | ~6 ms |
| 384×384 *(hover default)* | ~8 ms |
| 768×768 *(deep scan)* | ~20 ms |

**Scope:** engine time only — decoded RGBA in, fused verdict out. It excludes network
fetch, image decode and browser scheduling, which usually dominate what you actually
experience on hover. Treat it as a floor, not an end-to-end promise. It says nothing
about accuracy; that needs the calibration corpus above.

---

## Install

```bash
git clone https://github.com/zihaaaad/VerifEye.git
cd VerifEye
```

1. Open `chrome://extensions` in Chrome, Brave, Edge or Arc.
2. Enable **Developer mode** (upper-right toggle).
3. Click **Load unpacked** and select the project folder (`VerifEye`).
4. Click the toolbar icon to switch detection on, then hover any image.

**Press `V` while hovering** to run a deep scan: higher working resolution plus true
recompression ELA, and a rendered FFT spectrum in the tooltip.

---

## Engine modes

| Mode | Behaviour |
| --- | --- |
| **Local** *(default)* | Fully offline. Zero network calls. |
| **Hybrid** | Local signals first; Gemini consulted only when provenance has not already settled it. Blends 40% local / 60% cloud. |
| **Cloud** | Gemini multimodal evaluation, with local signals still reported alongside. |

Hybrid and Cloud need a Gemini API key, set in the options page. Local mode never
transmits anything.

---

## Development

```bash
npm test           # 49 assertions, plus the docs-mirror drift check
npm run bench      # latency measurements
npm run sync       # mirror forensics/ into docs/forensics/
```

GitHub Pages serves the site from `docs/`, and a page there cannot import from a parent
directory, so the engine genuinely exists twice on disk. `tools/sync-forensics.mjs` is
the single writer of that mirror, and `npm test` fails if it has drifted — a stale
mirror would otherwise ship a demo that behaves differently from the extension.

```
forensics/          the engine — pure functions, no DOM, no dependencies
  ensemble.js         orchestration and the provenance short-circuit
  fusion.js           log-odds combination
  calibration.js      fitted weights, or an honest "not calibrated"
  decode.js           working buffer + native-resolution crop
background.js       MV3 service worker: fetch, decode, cache, dispatch
content.js          hover detection and the tooltip
docs/               GitHub Pages site + the interactive studio (Web Worker)
bench/              benchmark harness, corpus collector, calibration fitter
```

---

## Limits

Stated plainly, because a forensics tool that oversells itself is worse than none:

- **Not calibrated out of the box.** Probabilities rank; they are not likelihoods.
- **Recompression erases evidence.** An image that has been through a social CDN has
  usually lost its CFA lattice and its original quantization table. Expect the band to
  widen and coverage to drop — that is the tool telling you it has less to go on.
- **Screenshots of real photographs** look synthetic to several signals, because they
  genuinely are re-rendered pixels.
- **No signal here is adversarially robust.** Anything that knows about these
  measurements can defeat them — add plausible grain, re-encode with a camera table,
  resample to kill the lattice.
- **A "Likely AI" verdict is evidence, not proof.** Use it to decide what deserves a
  closer look, never as the sole basis for a claim about a person.

---

## License

MIT — see [LICENSE](LICENSE).
