/**
 * VerifEye Studio - Forensic Engine Controller
 *
 * Drives the interactive studio. Every number and every pixel of the spectrum on
 * this page comes from the same modules the extension ships; nothing here is staged
 * or approximated for presentation.
 *
 * The analysis itself runs in worker.js so the page stays responsive while a 2D FFT
 * and a JPEG round trip are in flight.
 */

const SAMPLES = {
    // Photographs, labelled as photographs. An earlier version of this page presented
    // these same stock images as "Stable Diffusion XL" and "Midjourney v6" output,
    // which meant the demo's headline claim was a caption rather than a measurement.
    // The engine reports what it finds on whatever you give it; for a real test of
    // synthetic detection, drop in an image you generated yourself.
    portrait: {
        label: 'Portrait (DSLR)',
        note: 'Shallow depth of field, visible sensor grain',
        url: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=900&auto=format&fit=crop&q=80'
    },
    landscape: {
        label: 'Landscape (DSLR)',
        note: 'High-detail natural texture across the frame',
        url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=900&auto=format&fit=crop&q=80'
    },
    macro: {
        label: 'Macro / Studio',
        note: 'Controlled lighting, smooth backgrounds',
        url: 'https://images.unsplash.com/photo-1634017839464-5c339ebe3cb4?w=900&auto=format&fit=crop&q=80'
    },
    render: {
        label: 'Synthetic Render',
        note: 'Computer-generated, no optical capture path',
        url: 'https://images.unsplash.com/photo-1620641788421-7a1c342ea42e?w=900&auto=format&fit=crop&q=80'
    }
};

const SIGNAL_ROWS = [
    { key: 'fft', el: 'readingFft', format: s => `${s.score}% · ${s.peakCount} harmonic spikes · slope ${s.slope}` },
    { key: 'noise', el: 'readingNoise', format: s => `${s.score}% · kurtosis ${s.kurtosis} · ${Math.round(s.smoothRatio * 100)}% smooth` },
    { key: 'metadata', el: 'readingMeta', format: s => s.detected ? s.generator : (s.isCamera ? 'Authentic camera EXIF' : 'Clean / stripped') },
    { key: 'ela', el: 'readingEla', format: s => s.mode === 'true_ela'
        ? `${s.score}% · ${(s.outlierBlockRatio * 100).toFixed(1)}% outlier blocks (true ELA)`
        : `${s.score}% · blocking index ${s.blockingIndex} (heuristic)` },
    { key: 'color', el: 'readingColor', format: s => `${s.score}% · r(R,G) ${s.corrRG} · ${s.hasLensAberration ? 'optical dispersion' : 'no fringing'}` },
    { key: 'cfa', el: 'readingCfa', format: s => s.informative
        ? `Camera lattice ${s.parityRatio}:1`
        : 'No lattice recoverable' },
    { key: 'jpegQuant', el: 'readingQuant', format: s => !s.isJpeg
        ? 'Not a JPEG'
        : `${s.encoderClass} encoder · q~${s.estimatedQuality} · ${s.subsampling || 'n/a'}` },
    { key: 'benford', el: 'readingBenford', format: s => s.informative
        ? `TV ${s.divergence} (diagnostic)`
        : 'Not measurable' }
];

document.addEventListener('DOMContentLoaded', () => {
    const stageImage = document.getElementById('stageImage');
    const imageStage = document.getElementById('imageStage');
    const dropOverlay = document.getElementById('dropOverlay');
    const fileInput = document.getElementById('fileInput');
    const sampleBtns = document.querySelectorAll('.sample-btn');

    const verdictScore = document.getElementById('verdictScore');
    const verdictTag = document.getElementById('verdictTag');
    const verdictBand = document.getElementById('verdictBand');
    const verdictMeta = document.getElementById('verdictMeta');
    const contributionList = document.getElementById('contributionList');

    const fftCanvas = document.getElementById('fftCanvas');
    const fftCtx = fftCanvas ? fftCanvas.getContext('2d') : null;
    const spectrumCaption = document.getElementById('spectrumCaption');

    // --- Worker plumbing -------------------------------------------------------
    let worker = null;
    let requestId = 0;
    let activeRequest = 0;

    try {
        worker = new Worker('worker.js', { type: 'module' });
        worker.onmessage = (event) => {
            const { id, ok, result, spectrum, error } = event.data;
            // A slow analysis for an image the user has already navigated away from
            // must not overwrite the verdict for the one they are looking at now.
            if (id !== activeRequest) return;

            if (ok) renderResult(result, spectrum);
            else renderError(error);
        };
        worker.onerror = () => renderError('Analysis worker failed to start');
    } catch (e) {
        worker = null;
    }

    function analyze(arrayBuffer) {
        if (!worker) {
            renderError('This browser does not support module workers');
            return;
        }
        activeRequest = ++requestId;
        setBusy();
        // The buffer is transferred, so each analysis needs its own copy.
        const copy = arrayBuffer.slice(0);
        worker.postMessage({ id: activeRequest, arrayBuffer: copy, sensitivity: 'balanced' }, [copy]);
    }

    // --- Sources ---------------------------------------------------------------
    sampleBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.sample;
            if (key === 'custom') { fileInput.click(); return; }

            sampleBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            loadSample(key);
        });
    });

    async function loadSample(key) {
        const sample = SAMPLES[key];
        if (!sample) return;

        setBusy();
        stageImage.crossOrigin = 'anonymous';
        stageImage.src = sample.url;

        try {
            // One fetch for both the bytes and the analysis: the engine reads the
            // encoded file, not a re-encode of what the <img> element decoded, so
            // metadata and quantization tables survive intact.
            const response = await fetch(sample.url, { mode: 'cors' });
            if (!response.ok) throw new Error(`Sample unavailable (${response.status})`);
            analyze(await response.arrayBuffer());
        } catch (e) {
            renderError('Could not fetch the sample image. Drop a local file instead.');
        }
    }

    function processFile(file) {
        sampleBtns.forEach(b => b.classList.remove('active'));
        document.querySelector('[data-sample="custom"]')?.classList.add('active');

        stageImage.crossOrigin = null;
        stageImage.src = URL.createObjectURL(file);

        const reader = new FileReader();
        reader.onload = (e) => analyze(e.target.result);
        reader.onerror = () => renderError('Could not read that file');
        reader.readAsArrayBuffer(file);
    }

    fileInput.addEventListener('change', (e) => {
        if (e.target.files?.[0]) processFile(e.target.files[0]);
    });

    let dragDepth = 0;
    imageStage.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragDepth++;
        dropOverlay.style.display = 'flex';
    });
    imageStage.addEventListener('dragover', (e) => e.preventDefault());
    imageStage.addEventListener('dragleave', () => {
        // dragleave fires for every child crossed, so count depth instead of
        // hiding the overlay the moment the pointer enters a nested element.
        if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.style.display = 'none'; }
    });
    imageStage.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        dropOverlay.style.display = 'none';
        if (e.dataTransfer.files?.[0]) processFile(e.dataTransfer.files[0]);
    });

    // --- Rendering -------------------------------------------------------------
    function setBusy() {
        imageStage.classList.add('is-scanning');
        verdictScore.textContent = '··%';
        verdictScore.style.color = '';
        verdictTag.className = 'pill';
        verdictTag.textContent = 'Analyzing';
        if (verdictBand) verdictBand.textContent = 'Running eight signals locally…';
        SIGNAL_ROWS.forEach(row => {
            const el = document.getElementById(row.el);
            if (el) { el.textContent = '··'; el.style.color = ''; }
        });
    }

    function renderError(message) {
        imageStage.classList.remove('is-scanning');
        verdictScore.textContent = '--%';
        verdictScore.style.color = '';
        verdictTag.className = 'pill tone-warn';
        verdictTag.textContent = 'Unavailable';
        if (verdictBand) verdictBand.textContent = message;
    }

    function renderResult(result, spectrum) {
        imageStage.classList.remove('is-scanning');

        const probability = result.probability;
        verdictScore.textContent = `${probability}%`;

        let tone;
        if (probability >= 70) { tone = 'bad'; verdictTag.textContent = 'Likely AI'; }
        else if (probability >= 35) { tone = 'warn'; verdictTag.textContent = 'Uncertain'; }
        else { tone = 'good'; verdictTag.textContent = 'Likely Real'; }

        verdictScore.style.color = `var(--${tone})`;
        verdictTag.className = `pill tone-${tone}`;

        // The band is the honest part of the verdict: it widens when signals disagree
        // or when evidence was unavailable, which a bare percentage hides completely.
        if (verdictBand) {
            const [low, high] = result.band || [probability, probability];
            verdictBand.textContent = result.verdict === 'AI_CONFIRMED'
                ? `Generator declared in file metadata — no statistical inference needed`
                : `Plausible range ${low}–${high}% · signal agreement ${Math.round((result.agreement ?? 0) * 100)}% · evidence coverage ${Math.round((result.coverage ?? 0) * 100)}%`;
        }

        if (verdictMeta) {
            const dims = result.sourceDimensions;
            const parts = [];
            if (dims) parts.push(`${dims.width}×${dims.height} source`);
            if (result.nativeCropAvailable) parts.push('native crop analyzed');
            if (result.timings?.total != null) parts.push(`${result.timings.total.toFixed(1)} ms engine`);
            if (result.wallClockMs != null) parts.push(`${result.wallClockMs.toFixed(1)} ms end-to-end`);
            if (result.calibrated === false) parts.push('uncalibrated weights');
            verdictMeta.textContent = parts.join(' · ');
        }

        SIGNAL_ROWS.forEach(row => {
            const el = document.getElementById(row.el);
            if (!el) return;

            const signal = result.signals?.[row.key];
            if (!signal) { el.textContent = 'Not run'; el.style.color = 'var(--text-faint)'; return; }

            try { el.textContent = row.format(signal); }
            catch { el.textContent = '--'; }

            if (row.key === 'benford') {
                el.style.color = '';
            } else if (typeof signal.score === 'number' && signal.informative !== false) {
                el.style.color = signal.score >= 70 ? 'var(--bad)'
                    : signal.score <= 35 ? 'var(--good)'
                    : 'var(--warn)';
            } else {
                el.style.color = 'var(--text-faint)';
            }
        });

        renderContributions(result.contributions || []);
        renderSpectrum(spectrum, result.signals?.fft);
    }

    /**
     * Show which signals actually moved the verdict, in log-odds. This is the part a
     * reader needs in order to disagree with the engine on specific grounds.
     */
    function renderContributions(contributions) {
        if (!contributionList) return;
        contributionList.innerHTML = '';

        if (!contributions.length) {
            contributionList.innerHTML = '<li class="contrib-empty">No statistical signals contributed.</li>';
            return;
        }

        const peak = Math.max(...contributions.map(c => Math.abs(c.logOdds)), 0.001);

        for (const c of contributions.slice(0, 6)) {
            const magnitude = Math.abs(c.logOdds) / peak;
            const towardAi = c.logOdds > 0;

            const li = document.createElement('li');
            li.className = 'contrib-row';
            li.innerHTML = `
                <span class="contrib-name">${escapeHtml(c.signal)}</span>
                <span class="contrib-track">
                    <span class="contrib-fill ${towardAi ? 'toward-ai' : 'toward-real'}"
                          style="width:${Math.max(3, magnitude * 50)}%"></span>
                </span>
                <span class="contrib-value ${towardAi ? 'toward-ai' : 'toward-real'}">
                    ${c.logOdds > 0 ? '+' : ''}${c.logOdds.toFixed(2)}
                </span>`;
            contributionList.appendChild(li);
        }
    }

    /**
     * Paint the measured |F(u,v)| magnitude.
     *
     * The previous implementation of this function drew a procedural sin() lattice
     * seeded with Math.random() and tinted by a boolean, under a heading that called
     * it a Fourier transform. What follows is the array the FFT actually produced.
     */
    function renderSpectrum(spectrum, fftSignal) {
        if (!fftCtx || !fftCanvas) return;

        const width = fftCanvas.width;
        const height = fftCanvas.height;

        fftCtx.fillStyle = '#0b0b0e';
        fftCtx.fillRect(0, 0, width, height);

        if (!spectrum) {
            fftCtx.font = '11px ui-monospace, monospace';
            fftCtx.fillStyle = '#7c7a74';
            fftCtx.fillText('Spectrum unavailable (image below 128×128)', 12, height / 2);
            if (spectrumCaption) spectrumCaption.textContent = 'No spectrum';
            return;
        }

        const size = spectrum.size;
        const tile = fftCtx.createImageData(size, size);

        for (let i = 0; i < size * size; i++) {
            const v = spectrum.data[i] / 255;

            // Perceptually ordered ramp: dark blue floor through cyan to white peaks,
            // so isolated harmonics read as bright points rather than colour changes.
            const o = i * 4;
            tile.data[o] = Math.round(255 * Math.pow(v, 2.4));
            tile.data[o + 1] = Math.round(255 * Math.pow(v, 1.15));
            tile.data[o + 2] = Math.round(255 * Math.pow(v, 0.65));
            tile.data[o + 3] = 255;
        }

        // Nearest-neighbour upscale: a 64x64 spectrum smoothed by the default bilinear
        // filter would blur out the single-bin spikes the whole panel exists to show.
        createImageBitmap(tile).then(bitmap => {
            fftCtx.imageSmoothingEnabled = false;
            const side = Math.min(width, height);
            fftCtx.drawImage(bitmap, (width - side) / 2, (height - side) / 2, side, side);

            fftCtx.strokeStyle = 'rgba(255,255,255,0.10)';
            fftCtx.lineWidth = 1;
            fftCtx.beginPath();
            fftCtx.moveTo(width / 2, 0); fftCtx.lineTo(width / 2, height);
            fftCtx.moveTo(0, height / 2); fftCtx.lineTo(width, height / 2);
            fftCtx.stroke();
        }).catch(() => { /* canvas unavailable; the panel simply stays dark */ });

        if (spectrumCaption && fftSignal) {
            spectrumCaption.textContent =
                `${fftSignal.peakCount} harmonic spikes · slope ${fftSignal.slope} · HF/MF ${fftSignal.hfToMfRatio}`;
        }
    }

    function escapeHtml(str) {
        return String(str ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    loadSample('portrait');
});
