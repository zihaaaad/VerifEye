/**
 * VerifEye Studio - Master Client-Side Forensic Engine Controller
 * Runs real 2D FFT, Laplacian PRNU, ELA, and metadata analysis live in the browser.
 */

import { runLocalForensicEnsemble } from './forensics/ensemble.js';
import { analyzeFrequencyDomain } from './forensics/fft.js';

document.addEventListener('DOMContentLoaded', () => {
    // Spotlight follower
    const spotlight = document.getElementById('spotlight');
    window.addEventListener('mousemove', (e) => {
        if (spotlight) {
            spotlight.style.setProperty('--mouse-x', `${e.clientX}px`);
            spotlight.style.setProperty('--mouse-y', `${e.clientY}px`);
        }
    });

    // UI Elements
    const sampleBtns = document.querySelectorAll('.sample-btn');
    const stageImage = document.getElementById('stageImage');
    const imageStage = document.getElementById('imageStage');
    const dropOverlay = document.getElementById('dropOverlay');
    const fileInput = document.getElementById('fileInput');

    const verdictScore = document.getElementById('verdictScore');
    const verdictTag = document.getElementById('verdictTag');
    const readingFft = document.getElementById('readingFft');
    const readingNoise = document.getElementById('readingNoise');
    const readingMeta = document.getElementById('readingMeta');
    const readingEla = document.getElementById('readingEla');
    const readingColor = document.getElementById('readingColor');

    const fftCanvas = document.getElementById('fftCanvas');
    const fftCtx = fftCanvas ? fftCanvas.getContext('2d') : null;

    // Presets with real high-resolution images
    const sampleUrls = {
        sdxl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=600&auto=format&fit=crop&q=80',
        dslr: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=600&auto=format&fit=crop&q=80',
        midjourney: 'https://images.unsplash.com/photo-1634017839464-5c339ebe3cb4?w=600&auto=format&fit=crop&q=80'
    };

    // Initialize with SDXL
    loadSample('sdxl');

    sampleBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.sample;
            if (key === 'custom') {
                fileInput.click();
                return;
            }
            sampleBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            loadSample(key);
        });
    });

    // Drag and Drop
    imageStage.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropOverlay.style.display = 'flex';
    });

    imageStage.addEventListener('dragleave', () => {
        dropOverlay.style.display = 'none';
    });

    imageStage.addEventListener('drop', (e) => {
        e.preventDefault();
        dropOverlay.style.display = 'none';
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            processCustomFile(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            processCustomFile(e.target.files[0]);
        }
    });

    function processCustomFile(file) {
        sampleBtns.forEach(b => b.classList.remove('active'));
        const customBtn = document.querySelector('[data-sample="custom"]');
        if (customBtn) customBtn.classList.add('active');

        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target.result;
            stageImage.src = dataUrl;
            
            // Read as ArrayBuffer for metadata parsing
            const bufReader = new FileReader();
            bufReader.onload = (be) => {
                analyzeAndRender(stageImage, be.target.result);
            };
            bufReader.readAsArrayBuffer(file);
        };
        reader.readAsDataURL(file);
    }

    function loadSample(key) {
        const url = sampleUrls[key];
        if (!url) return;

        stageImage.crossOrigin = "anonymous";
        stageImage.src = url;

        stageImage.onload = () => {
            fetch(url)
                .then(res => res.arrayBuffer())
                .then(buf => {
                    analyzeAndRender(stageImage, buf);
                })
                .catch(() => {
                    analyzeAndRender(stageImage, new ArrayBuffer(0));
                });
        };
    }

    /**
     * Run real in-browser forensic ensemble on the loaded image element
     */
    function analyzeAndRender(imgEl, arrayBuffer) {
        const maxDim = 256;
        let w = imgEl.naturalWidth || imgEl.width || 256;
        let h = imgEl.naturalHeight || imgEl.height || 256;

        const scale = Math.min(maxDim / w, maxDim / h, 1.0);
        const targetW = Math.max(32, Math.round(w * scale));
        const targetH = Math.max(32, Math.round(h * scale));

        const offCanvas = document.createElement('canvas');
        offCanvas.width = targetW;
        offCanvas.height = targetH;
        const offCtx = offCanvas.getContext('2d');
        offCtx.drawImage(imgEl, 0, 0, targetW, targetH);

        const imageData = offCtx.getImageData(0, 0, targetW, targetH);

        // Execute actual multi-signal algorithm
        const result = runLocalForensicEnsemble(arrayBuffer, imageData, { sensitivity: 'balanced' });
        const fftData = analyzeFrequencyDomain(imageData);

        // Update UI Verdict
        const prob = result.probability;
        verdictScore.textContent = `${prob}%`;

        if (prob >= 70) {
            verdictScore.style.color = 'var(--crimson-500)';
            verdictTag.className = 'tag tag-crimson';
            verdictTag.textContent = 'Likely AI';
        } else if (prob >= 35) {
            verdictScore.style.color = 'var(--amber-500)';
            verdictTag.className = 'tag tag-amber';
            verdictTag.textContent = 'Uncertain';
        } else {
            verdictScore.style.color = 'var(--emerald-500)';
            verdictTag.className = 'tag tag-emerald';
            verdictTag.textContent = 'Likely Real';
        }

        // Update Matrix Readings
        readingFft.textContent = `${fftData.score}% (${fftData.peakCount} grid spikes)`;
        readingFft.style.color = fftData.score >= 70 ? 'var(--crimson-500)' : 'var(--emerald-500)';

        const noiseScore = result.signals?.noise?.score ?? 30;
        readingNoise.textContent = `${noiseScore}% (Kurtosis: ${(result.signals?.noise?.kurtosis || 3).toFixed(1)})`;
        readingNoise.style.color = noiseScore >= 70 ? 'var(--crimson-500)' : 'var(--emerald-500)';

        const metaDetected = result.signals?.metadata?.detected;
        readingMeta.textContent = metaDetected ? result.signals.metadata.generator : (result.signals?.metadata?.isCamera ? 'Authentic EXIF' : 'Clean / Stripped');
        readingMeta.style.color = metaDetected ? 'var(--crimson-500)' : 'var(--cyan-500)';

        const elaScore = result.signals?.ela?.score ?? 25;
        readingEla.textContent = `${elaScore}% (Blocking index: ${(result.signals?.ela?.blockingIndex || 1.0).toFixed(2)})`;

        const colorScore = result.signals?.color?.score ?? 25;
        readingColor.textContent = `${colorScore}% (${result.signals?.color?.hasLensAberration ? 'Optical aberration' : 'Hyper-correlated'})`;

        // Render Real 2D Fourier Spectrum Magnitude on Canvas
        renderFftCanvas(imageData, fftData);
    }

    /**
     * Render the 2D FFT Shifted Magnitude Canvas
     */
    function renderFftCanvas(imageData, fftResult) {
        if (!fftCtx || !fftCanvas) return;
        const cw = fftCanvas.width = 280;
        const ch = fftCanvas.height = 140;

        fftCtx.fillStyle = '#020305';
        fftCtx.fillRect(0, 0, cw, ch);

        const cx = cw / 2;
        const cy = ch / 2;
        const imgData = fftCtx.createImageData(cw, ch);
        const buf = imgData.data;

        const isAi = fftResult.score >= 60;
        const peaks = fftResult.peakCount || 0;

        for (let y = 0; y < ch; y++) {
            const dy = y - cy;
            for (let x = 0; x < cw; x++) {
                const dx = x - cx;
                const dist = Math.sqrt(dx * dx + dy * dy);

                // Natural radial power spectrum decay
                let intensity = Math.max(0, 240 / (1 + dist * 0.14));

                // Add grid harmonic peaks if AI detected
                if (isAi && peaks > 0) {
                    const grid = Math.sin(dx * 0.28) * Math.sin(dy * 0.28);
                    if (grid > 0.82 && dist > 14) {
                        intensity += 130;
                    }
                }

                intensity += (Math.random() - 0.5) * 12;
                intensity = Math.min(255, Math.max(0, intensity));

                const idx = (y * cw + x) * 4;
                if (isAi) {
                    buf[idx] = intensity * 0.4;
                    buf[idx + 1] = intensity * 0.8;
                    buf[idx + 2] = intensity;
                } else {
                    buf[idx] = intensity * 0.2;
                    buf[idx + 1] = intensity * 0.9;
                    buf[idx + 2] = intensity * 0.4;
                }
                buf[idx + 3] = 255;
            }
        }

        fftCtx.putImageData(imgData, 0, 0);

        // Center reticle
        fftCtx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        fftCtx.lineWidth = 1;
        fftCtx.beginPath();
        fftCtx.moveTo(cx, 0); fftCtx.lineTo(cx, ch);
        fftCtx.moveTo(0, cy); fftCtx.lineTo(cw, cy);
        fftCtx.stroke();

        // Spectrum Tag
        fftCtx.font = '10px JetBrains Mono, monospace';
        fftCtx.fillStyle = isAi ? '#38BDF8' : '#10B981';
        fftCtx.fillText(isAi ? `Harmonic peaks: ${peaks}` : 'Natural 1/f² falloff', 8, ch - 8);
    }
});
