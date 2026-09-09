/**
 * VerifEye GitHub Pages - Live Interactive Forensics Simulator & Visualizer
 */

document.addEventListener('DOMContentLoaded', () => {
    // Elements
    const demoCards = document.querySelectorAll('.demo-card');
    const fourierCanvas = document.getElementById('fourierCanvas');
    const fCtx = fourierCanvas ? fourierCanvas.getContext('2d') : null;

    const valFft = document.getElementById('valFft');
    const valNoise = document.getElementById('valNoise');
    const valMeta = document.getElementById('valMeta');
    const valEla = document.getElementById('valEla');
    const valColor = document.getElementById('valColor');
    const valOverall = document.getElementById('valOverall');
    const badgeVerdict = document.getElementById('badgeVerdict');
    const inspectorTitle = document.getElementById('inspectorTitle');

    // Preset Data
    const presets = {
        dslr: {
            title: "Authentic DSLR Photo (Canon EOS R5)",
            verdict: "Likely Real (8%)",
            verdictClass: "badge-green",
            fft: "22% (Natural 1/f² power decay)",
            noise: "14% (Poisson-Gaussian sensor grain)",
            meta: "Verified Camera EXIF (Canon R5, f/2.8)",
            ela: "18% (Uniform compression surface)",
            color: "10% (Optical chromatic dispersion)",
            overall: "8%",
            isAi: false,
            gridPeaks: 0
        },
        sdxl: {
            title: "Stable Diffusion XL (WebUI)",
            verdict: "Likely AI (98%)",
            verdictClass: "badge-cyan",
            fft: "92% (18 high-frequency grid spikes)",
            noise: "88% (Unnatural texture oversmoothing)",
            meta: "Confirmed Parameters (Steps: 30, DPM++)",
            ela: "74% (Synthetic single-pass surface)",
            color: "82% (Hyper-correlated RGB channels)",
            overall: "98%",
            isAi: true,
            gridPeaks: 18
        },
        midjourney: {
            title: "Midjourney v6 Render",
            verdict: "Likely AI (94%)",
            verdictClass: "badge-cyan",
            fft: "86% (Radial spectral decay anomaly)",
            noise: "94% (Non-Gaussian residual kurtosis: 9.2)",
            meta: "Midjourney parameters detected",
            ela: "68% (Unnatural blocking index)",
            color: "89% (Compressed saturation gamut)",
            overall: "94%",
            isAi: true,
            gridPeaks: 12
        }
    };

    // Initialize with DSLR
    loadPreset('sdxl');

    demoCards.forEach(card => {
        card.addEventListener('click', () => {
            demoCards.forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            const presetKey = card.dataset.preset;
            if (presets[presetKey]) {
                loadPreset(presetKey);
            }
        });
    });

    function loadPreset(key) {
        const data = presets[key];
        if (!data) return;

        inspectorTitle.textContent = data.title;
        badgeVerdict.textContent = data.verdict;
        badgeVerdict.className = `badge ${data.isAi ? 'badge-cyan' : 'badge-green'}`;

        valFft.textContent = data.fft;
        valNoise.textContent = data.noise;
        valMeta.textContent = data.meta;
        valEla.textContent = data.ela;
        valColor.textContent = data.color;
        valOverall.textContent = data.overall;

        drawFourierSpectrum(data.isAi, data.gridPeaks);
    }

    /**
     * Draw Simulated 2D Fourier Spectrum
     */
    function drawFourierSpectrum(isAi, peaks) {
        if (!fCtx || !fourierCanvas) return;
        const w = fourierCanvas.width;
        const h = fourierCanvas.height;
        const cx = w / 2;
        const cy = h / 2;

        fCtx.fillStyle = '#05070c';
        fCtx.fillRect(0, 0, w, h);

        const imgData = fCtx.createImageData(w, h);
        const buf = imgData.data;

        for (let y = 0; y < h; y++) {
            const dy = y - cy;
            for (let x = 0; x < w; x++) {
                const dx = x - cx;
                const dist = Math.sqrt(dx * dx + dy * dy);

                // Natural 1/r^2 radial decay
                let intensity = Math.max(0, 255 / (1 + dist * 0.12));

                if (isAi) {
                    // Periodic checkerboard spikes
                    const gridVal = Math.sin(dx * 0.35) * Math.sin(dy * 0.35);
                    if (gridVal > 0.85 && dist > 20) {
                        intensity += 140;
                    }
                }

                // Add subtle natural noise
                intensity += (Math.random() - 0.5) * 15;
                intensity = Math.min(255, Math.max(0, intensity));

                const idx = (y * w + x) * 4;
                if (isAi) {
                    // Cyan / Violet false color for AI artifacts
                    buf[idx] = intensity * 0.4;
                    buf[idx + 1] = intensity * 0.85;
                    buf[idx + 2] = intensity;
                } else {
                    // Golden / Emerald false color for natural spectra
                    buf[idx] = intensity * 0.3;
                    buf[idx + 1] = intensity * 0.9;
                    buf[idx + 2] = intensity * 0.4;
                }
                buf[idx + 3] = 255;
            }
        }

        fCtx.putImageData(imgData, 0, 0);

        // Draw crosshairs & annotations
        fCtx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        fCtx.lineWidth = 1;
        fCtx.beginPath();
        fCtx.moveTo(cx, 0); fCtx.lineTo(cx, h);
        fCtx.moveTo(0, cy); fCtx.lineTo(w, cy);
        fCtx.stroke();

        fCtx.font = '10px JetBrains Mono, monospace';
        fCtx.fillStyle = isAi ? '#38bdf8' : '#10b981';
        fCtx.fillText(isAi ? 'Harmonic Grid Resonance Detected' : 'Standard 1/f² Natural Spectrum', 10, h - 12);
    }
});
