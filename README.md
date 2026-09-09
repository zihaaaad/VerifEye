# VerifEye: AI Image Detector

VerifEye is a real-time, local-first Chrome extension that detects AI-generated images (Stable Diffusion, Midjourney, DALL-E, Flux, Imagen) on hover using open-source forensic algorithms, with optional cloud API verification.

![VerifEye Demo](https://i.ibb.co.com/8LY5zcWK/3.png)

---

## Key Highlights in v2.0

* **Zero API Required (Works 100% Offline):** Runs open-source forensic algorithms directly inside the browser. No API keys, subscriptions, or external network calls required.
* **Instant Hover Analysis (<20ms):** Powered by an in-browser 2D Fast Fourier Transform (FFT) and Laplacian noise residual analyzer.
* **Multi-Engine Flexibility:**
  1. **Local Offline Engine (Default):** Free, private, and fully offline.
  2. **Hybrid Engine:** Instant local scan backed by optional Google Gemini multimodal verification.
  3. **Cloud API Mode:** Direct Gemini vision analysis.
* **Explainable Forensic Indicators:** Provides transparent technical explanations for why an image was flagged (e.g., *"Generative frequency grid detected"*, *"Synthetic diffusion smoothing"*, *"Stable Diffusion metadata confirmed"*).
* **Viewport-Aware Glassmorphism UI:** Non-intrusive tooltip with calibrated indicator levels (Likely Real, Uncertain, Likely AI).

---

## Forensic Algorithm Architecture

VerifEye uses a multi-signal forensic ensemble that inspects both binary provenance metadata and mathematical pixel-level properties:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Hovered Image                                 │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
    ┌────────────────────────────────┼────────────────────────────────┐
    ▼                                ▼                                ▼
┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────────────┐
│  Layer 1: Metadata    │  │  Layer 2: Frequency   │  │   Layer 3: Noise &    │
│  & C2PA Provenance    │  │  2D FFT Grid Spectrum │  │   Texture Residual    │
├───────────────────────┤  ├───────────────────────┤  ├───────────────────────┤
│ • PNG tEXt/iTXt scan  │  │ • 2D Radix-2 FFT      │  │ • 3x3 Laplacian filter│
│ • EXIF / XMP headers  │  │ • Periodic grid peaks │  │ • Kurtosis & PRNU     │
│ • Stable Diffusion /  │  │ • Radial power decay  │  │ • Synthetic smoothing │
│   ComfyUI / Midjourney│  │   (1/f^a slope)       │  │   detection           │
└───────────┬───────────┘  └───────────┬───────────┘  └───────────┬───────────┘
            │                          │                          │
            └──────────────────────────┼──────────────────────────┘
                                       ▼
                       ┌───────────────────────────────┐
                       │  Calibrated Multi-Signal      │
                       │  Ensemble Aggregator (0-100%) │
                       └───────────────┬───────────────┘
                                       │
                      ┌────────────────┴────────────────┐
                      ▼                                 ▼
         [Local Engine: Instant]             [Optional Cloud API]
```

### 1. 2D Fast Fourier Transform (FFT) & Spectral Grid Decomposition
Generative neural networks (Transposed Convolutions, PixelShuffle, VAE decoders) leave periodic checkerboard artifacts in the frequency domain. VerifEye computes a 2D FFT on luminance patches with a 2D Hann window, measuring:
- Isolated high-frequency spectral harmonic spikes (>3 sigma above neighborhood median).
- Deviations from the natural image power law distribution (P(f) ~ 1/f^2).

### 2. Sensor Noise Residual & Laplacian Variance (PRNU)
Real physical camera sensors produce Poisson-Gaussian noise (Photo-Response Non-Uniformity). In contrast, iterative diffusion schedulers create unnatural texture oversmoothing. VerifEye calculates:
- Residual kurtosis anomaly (detecting non-Gaussian synthetic grain).
- Patch-based spatial variance ratios across flat regions (skin, sky, backgrounds).

### 3. Binary Metadata & C2PA Provenance Parser
Inspects raw image binary headers (PNG chunks, EXIF `UserComment`, JPEG `APP1`/`APP2`, XMP packets, WebP `RIFF` chunks) for:
- Automatic1111 / ComfyUI / Fooocus parameters and generation prompts.
- Midjourney job IDs and version flags (`--v 6`, `--ar`).
- DALL-E / OpenAI XMP generator tags.
- C2PA Content Credentials manifests (`digitalSourceType: trainedAlgorithmicMedia`).

### 4. Error Level Analysis (ELA) & Compression Consistency
Evaluates 8x8 block discrete cosine transform (DCT) quantization boundaries and variance spread to detect synthetic inpainting, face swaps, and non-camera compression profiles.

### 5. Optical Chromatic Aberration & Color Space Analysis
Physical camera lenses exhibit radial chromatic dispersion (wavelength shift at peripheral edges). VerifEye verifies optical edge dispersion and measures RGB inter-channel correlation.

---

## Installation & Usage

1. **Clone or Download:** Clone this repository or download the ZIP file and extract it.
2. **Open Chrome Extensions:** Navigate to `chrome://extensions` in Google Chrome.
3. **Enable Developer Mode:** Turn on the **Developer mode** toggle in the top-right corner.
4. **Load Unpacked:** Click **Load unpacked** and select the project folder (`VerifEye-AI-Image-Detector`).
5. **Operation:**
   - Click the VerifEye icon in your toolbar to turn it ON (badge displays 'ON').
   - Hover over any image on any website (static or dynamic, like X, Facebook, Instagram, Reddit).
   - An instant forensic tooltip will appear with the detection score and reasons.

---

## Configuration & Forensics Test Lab

Right-click the extension icon and choose **Options** (or navigate to `settings/settings.html`):
- **Engine Selection:** Choose between **Local Offline Engine** (default), **Hybrid**, or **Cloud**.
- **Signal Toggles:** Enable or disable individual forensic detectors (FFT, Noise, ELA, Metadata, Color).
- **Interactive Test Lab:** Drag-and-drop local image files or paste image URLs to test them in real time with detailed signal metrics.
- **Optional API Key:** Add a Google Gemini API key if you wish to enable Hybrid or Cloud multimodal verification.

---

## Privacy & Security

- **Local Mode Privacy:** In the default Local Engine mode, no image data or telemetry leaves your browser. All computations occur client-side using JavaScript and `OffscreenCanvas`.
- **API Key Security:** Any optional API key entered is stored strictly in Chrome Sync Storage (`chrome.storage.sync`) and is transmitted only to official provider endpoints.

---

## License

MIT License. See [LICENSE](LICENSE) for details.