/**
 * VerifEye Settings & Live Forensics Lab Controller
 */

document.addEventListener('DOMContentLoaded', async () => {
    // UI Elements
    const optLocal = document.getElementById('optLocal');
    const optHybrid = document.getElementById('optHybrid');
    const optCloud = document.getElementById('optCloud');
    const radioModes = document.getElementsByName('engineMode');

    const sensitivitySelect = document.getElementById('sensitivity');
    const saveEngineBtn = document.getElementById('saveEngineBtn');

    const sigMetadata = document.getElementById('sigMetadata');
    const sigFft = document.getElementById('sigFft');
    const sigNoise = document.getElementById('sigNoise');
    const sigEla = document.getElementById('sigEla');
    const sigColor = document.getElementById('sigColor');
    const sigCfa = document.getElementById('sigCfa');
    const sigJpegQuant = document.getElementById('sigJpegQuant');
    const saveSignalsBtn = document.getElementById('saveSignalsBtn');

    const apiKeyInput = document.getElementById('apiKey');
    const geminiModelSelect = document.getElementById('geminiModel');
    const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
    const testApiKeyBtn = document.getElementById('testApiKeyBtn');
    const clearApiKeyBtn = document.getElementById('clearApiKeyBtn');

    const statusMsg = document.getElementById('statusMsg');

    // Domain Exclusion Elements
    const domainList = document.getElementById('domainList');
    const newDomainInput = document.getElementById('newDomainInput');
    const addDomainBtn = document.getElementById('addDomainBtn');

    // Stats Elements
    const statTotal = document.getElementById('statTotal');
    const statAi = document.getElementById('statAi');
    const statReal = document.getElementById('statReal');
    const statUncertain = document.getElementById('statUncertain');
    const resetStatsBtn = document.getElementById('resetStatsBtn');

    // Test Lab Elements
    const testImageUrlInput = document.getElementById('testImageUrl');
    const testUrlBtn = document.getElementById('testUrlBtn');
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const testResultBox = document.getElementById('testResultBox');
    const resClassification = document.getElementById('resClassification');
    const resProbability = document.getElementById('resProbability');
    const resBar = document.getElementById('resBar');
    const resEngine = document.getElementById('resEngine');
    const resReasons = document.getElementById('resReasons');

    const telFft = document.getElementById('telFft');
    const telNoise = document.getElementById('telNoise');
    const telEla = document.getElementById('telEla');
    const telColor = document.getElementById('telColor');
    const telCfa = document.getElementById('telCfa');
    const telQuant = document.getElementById('telQuant');
    const resBand = document.getElementById('resBand');
    const labSpectrumCaption = document.getElementById('labSpectrumCaption');

    const labFftCanvas = document.getElementById('labFftCanvas');
    const labFftCtx = labFftCanvas ? labFftCanvas.getContext('2d') : null;

    // 1. Load initial settings
    const settings = await chrome.storage.sync.get([
        'engineMode',
        'sensitivity',
        'signals',
        'apiKey',
        'geminiModel',
        'excludedDomains'
    ]);

    const currentMode = settings.engineMode || 'local';
    for (const radio of radioModes) {
        if (radio.value === currentMode) {
            radio.checked = true;
            updateRadioSelectionVisual(currentMode);
        }
        radio.addEventListener('change', () => {
            updateRadioSelectionVisual(radio.value);
        });
    }

    if (settings.sensitivity) sensitivitySelect.value = settings.sensitivity;
    if (settings.geminiModel) geminiModelSelect.value = settings.geminiModel;
    if (settings.apiKey) apiKeyInput.value = settings.apiKey;

    const signals = settings.signals || {
        metadata: true, fft: true, noise: true, ela: true,
        color: true, cfa: true, jpegQuant: true, benford: true
    };
    sigMetadata.checked = signals.metadata !== false;
    sigFft.checked = signals.fft !== false;
    sigNoise.checked = signals.noise !== false;
    sigEla.checked = signals.ela !== false;
    sigColor.checked = signals.color !== false;
    if (sigCfa) sigCfa.checked = signals.cfa !== false;
    if (sigJpegQuant) sigJpegQuant.checked = signals.jpegQuant !== false;

    let excludedDomains = settings.excludedDomains || [];
    renderDomainList();

    // 2. Load Stats
    loadStats();

    function updateRadioSelectionVisual(mode) {
        optLocal.classList.toggle('selected', mode === 'local');
        optHybrid.classList.toggle('selected', mode === 'hybrid');
        optCloud.classList.toggle('selected', mode === 'cloud');
    }

    let statusTimer = null;
    function showStatus(text, color = 'var(--green)') {
        statusMsg.textContent = text;
        statusMsg.style.color = color;
        // Rapid consecutive saves would otherwise queue overlapping clears, so the
        // message could vanish while a later one was still current.
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => { statusMsg.textContent = ''; }, 2200);
    }

    function loadStats() {
        chrome.runtime.sendMessage({ action: 'getStats' }, (response) => {
            if (response && response.success && response.stats) {
                statTotal.textContent = response.stats.totalScanned || 0;
                statAi.textContent = response.stats.aiDetected || 0;
                statReal.textContent = response.stats.realVerified || 0;
                statUncertain.textContent = response.stats.uncertain || 0;
            }
        });
    }

    // --- Autosave -------------------------------------------------------------
    //
    // A toggle that needs a Save button afterwards is a toggle that lies: it shows the
    // new state while the extension is still running the old one. Preferences here are
    // single values with no validation step, so they commit on change and report it.
    //
    // The API key is deliberately NOT autosaved; see its handler below.

    async function persistEngine() {
        let selectedMode = 'local';
        for (const radio of radioModes) {
            if (radio.checked) selectedMode = radio.value;
        }

        await chrome.storage.sync.set({
            engineMode: selectedMode,
            sensitivity: sensitivitySelect.value
        });

        showStatus('Saved');
    }

    async function persistSignals() {
        const sigObj = {
            metadata: sigMetadata.checked,
            fft: sigFft.checked,
            noise: sigNoise.checked,
            ela: sigEla.checked,
            color: sigColor.checked,
            cfa: sigCfa ? sigCfa.checked : true,
            jpegQuant: sigJpegQuant ? sigJpegQuant.checked : true,
            // Diagnostic signal: measured and displayed, never fused into the verdict.
            benford: true
        };

        await chrome.storage.sync.set({ signals: sigObj });
        showStatus('Saved');
    }

    for (const radio of radioModes) {
        radio.addEventListener('change', persistEngine);
    }
    sensitivitySelect.addEventListener('change', persistEngine);

    for (const box of [sigMetadata, sigFft, sigNoise, sigEla, sigColor, sigCfa, sigJpegQuant]) {
        if (box) box.addEventListener('change', persistSignals);
    }

    // The explicit buttons are gone from the markup; keep the wiring conditional so an
    // older cached page still works rather than throwing on a null.
    if (saveEngineBtn) saveEngineBtn.addEventListener('click', persistEngine);
    if (saveSignalsBtn) saveSignalsBtn.addEventListener('click', persistSignals);

    // Save API Key
    saveApiKeyBtn.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim();
        const geminiModel = geminiModelSelect.value;

        await chrome.storage.sync.set({
            apiKey: apiKey,
            geminiModel: geminiModel
        });

        showStatus('API credentials saved!');
    });

    // Test API Connection
    testApiKeyBtn.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim();
        const geminiModel = geminiModelSelect.value;

        if (!apiKey) {
            showStatus('Please enter an API key to test.', 'var(--amber)');
            return;
        }

        showStatus('Testing API connection...', 'var(--accent)');
        chrome.runtime.sendMessage({ action: 'testApiKey', apiKey: apiKey, model: geminiModel }, (response) => {
            if (response && response.success) {
                showStatus('Gemini API connection verified successfully!', 'var(--green)');
            } else {
                showStatus(`API Test Failed: ${response?.error || 'Unknown error'}`, 'var(--red)');
            }
        });
    });

    // Clear API Key
    clearApiKeyBtn.addEventListener('click', async () => {
        apiKeyInput.value = '';
        await chrome.storage.sync.set({ apiKey: '' });
        showStatus('API key removed. Reverted to Local Engine.', 'var(--accent)');
    });

    // Excluded Domains Management
    function renderDomainList() {
        domainList.innerHTML = '';
        if (excludedDomains.length === 0) {
            domainList.innerHTML = '<span style="font-size: 12px; color: var(--text-muted);">No domains excluded (detects on all websites).</span>';
            return;
        }

        excludedDomains.forEach((domain, idx) => {
            const tag = document.createElement('span');
            tag.className = 'domain-tag';
            tag.innerHTML = `<span>${escapeHtml(domain)}</span> <span class="domain-remove" data-idx="${idx}">&times;</span>`;
            domainList.appendChild(tag);
        });

        domainList.querySelectorAll('.domain-remove').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const idx = parseInt(e.target.dataset.idx, 10);
                excludedDomains.splice(idx, 1);
                await chrome.storage.sync.set({ excludedDomains });
                renderDomainList();
                showStatus('Domain removed from exclusions.');
            });
        });
    }

    addDomainBtn.addEventListener('click', async () => {
        const domain = newDomainInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (!domain) return;
        if (!excludedDomains.includes(domain)) {
            excludedDomains.push(domain);
            await chrome.storage.sync.set({ excludedDomains });
            newDomainInput.value = '';
            renderDomainList();
            showStatus(`Excluded domain added: ${domain}`);
        }
    });

    // Reset Statistics
    resetStatsBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to reset all scan statistics?')) {
            chrome.runtime.sendMessage({ action: 'resetStats' }, () => {
                loadStats();
                showStatus('Scan statistics reset to zero.');
            });
        }
    });

    // --- Live Forensics Test Lab ---
    testUrlBtn.addEventListener('click', () => {
        const url = testImageUrlInput.value.trim();
        if (!url) {
            alert('Please enter an image URL to test.');
            return;
        }
        runTestAnalysis(url);
    });

    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--accent)';
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.style.borderColor = 'var(--border-strong)';
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--border-strong)';
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleLocalFile(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            handleLocalFile(e.target.files[0]);
        }
    });

    function handleLocalFile(file) {
        const reader = new FileReader();
        reader.onload = (event) => {
            runTestAnalysis(event.target.result);
        };
        reader.readAsDataURL(file);
    }

    function runTestAnalysis(imageUrl) {
        testResultBox.style.display = 'block';
        resClassification.textContent = 'Analyzing image...';
        resClassification.style.color = 'var(--text-faint)';
        resProbability.textContent = '...';
        resBar.style.width = '0%';
        resBar.style.background = 'var(--accent)';
        resEngine.textContent = 'Running multi-signal algorithms...';
        resReasons.innerHTML = '<li>Decomposing 2D Fourier spectrum & noise residuals...</li>';

        telFft.textContent = '...';
        telNoise.textContent = '...';
        telEla.textContent = '...';
        telColor.textContent = '...';
        if (telCfa) telCfa.textContent = '...';
        if (telQuant) telQuant.textContent = '...';
        if (resBand) resBand.textContent = '';

        chrome.runtime.sendMessage({ action: 'analyzeImage', imageUrl: imageUrl, deepScan: true }, (response) => {
            if (chrome.runtime.lastError || !response || !response.success) {
                resClassification.textContent = 'Analysis Failed';
                resClassification.style.color = 'var(--red)';
                resProbability.textContent = 'Error';
                resReasons.innerHTML = `<li>${response?.error || chrome.runtime.lastError?.message || 'Could not process image.'}</li>`;
                return;
            }

            const res = response.result;
            const prob = res.probability !== undefined ? res.probability : 50;
            const classification = res.classification || (prob >= 70 ? 'Likely AI' : prob >= 35 ? 'Uncertain' : 'Likely Real');

            resClassification.textContent = classification;
            resProbability.textContent = `${prob}%`;
            resBar.style.width = `${prob}%`;

            if (prob >= 70) {
                resClassification.style.color = 'var(--red)';
                resBar.style.background = 'var(--red)';
            } else if (prob >= 35) {
                resClassification.style.color = 'var(--amber)';
                resBar.style.background = 'var(--amber)';
            } else {
                resClassification.style.color = 'var(--green)';
                resBar.style.background = 'var(--green)';
            }

            // Signal Telemetry Meters
            const fftScore = res.signals?.fft?.score ?? (prob >= 60 ? 75 : 25);
            const noiseScore = res.signals?.noise?.score ?? (prob >= 60 ? 70 : 25);
            const elaScore = res.signals?.ela?.score ?? 25;
            const colorScore = res.signals?.color?.score ?? 25;

            telFft.textContent = `${fftScore}% (${res.signals?.fft?.peakCount || 0} peaks)`;
            telFft.style.color = fftScore >= 60 ? 'var(--red)' : 'var(--green)';

            telNoise.textContent = `${noiseScore}% (K: ${(res.signals?.noise?.kurtosis || 3.0).toFixed(1)})`;
            telNoise.style.color = noiseScore >= 60 ? 'var(--red)' : 'var(--green)';

            const ela = res.signals?.ela;
            telEla.textContent = ela?.mode === 'true_ela'
                ? `${elaScore}% (${((ela.outlierBlockRatio || 0) * 100).toFixed(1)}% outliers, true ELA)`
                : `${elaScore}% (BAI: ${(ela?.blockingIndex || 1.0).toFixed(2)}, heuristic)`;

            telColor.textContent = `${colorScore}% (${res.signals?.color?.hasLensAberration ? 'Optic artifact' : 'Clean'})`;

            const cfa = res.signals?.cfa;
            if (telCfa) {
                telCfa.textContent = cfa?.informative ? `Camera lattice ${cfa.parityRatio}:1` : 'No lattice';
                telCfa.style.color = cfa?.informative ? 'var(--green)' : 'var(--text-muted)';
            }

            const quant = res.signals?.jpegQuant;
            if (telQuant) {
                telQuant.textContent = !quant?.isJpeg
                    ? 'Not JPEG'
                    : `${quant.encoderClass}, q~${quant.estimatedQuality}`;
                telQuant.style.color = quant?.encoderClass === 'custom' ? 'var(--green)'
                    : quant?.encoderClass === 'library' ? 'var(--red)' : 'var(--text-muted)';
            }

            // The band is the honest half of the verdict: it widens when signals
            // disagree or when evidence could not be gathered at all.
            if (resBand) {
                if (res.verdict === 'AI_CONFIRMED') {
                    resBand.textContent = 'Generator declared in file metadata - no statistical inference required.';
                } else if (Array.isArray(res.band)) {
                    const bits = [`Plausible range ${res.band[0]}-${res.band[1]}%`];
                    if (res.agreement != null) bits.push(`agreement ${Math.round(res.agreement * 100)}%`);
                    if (res.coverage != null) bits.push(`coverage ${Math.round(res.coverage * 100)}%`);
                    if (res.calibrated === false) bits.push('uncalibrated weights');
                    resBand.textContent = bits.join(' | ');
                }
            }

            let engineName = 'Local Open-Source Forensic Engine';
            if (res.engine === 'cloud_gemini' || res.engineMode === 'cloud') {
                engineName = 'Google Gemini Vision Model';
            } else if (res.engine === 'hybrid' || res.engineMode === 'hybrid') {
                engineName = 'Hybrid (Local Forensics + Cloud Gemini)';
            } else if (res.engine === 'local_metadata') {
                engineName = 'Local Exact Metadata & Provenance Signature';
            }

            resEngine.textContent = `Engine: ${engineName}`;

            const reasons = res.reasons || [];
            if (reasons.length > 0) {
                resReasons.innerHTML = reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('');
            } else {
                resReasons.innerHTML = '<li>No significant generative artifacts detected.</li>';
            }

            // Render 2D FFT Magnitude Spectrum Canvas
            renderLabFft(res);

            // Update stats
            loadStats();
        });
    }

    /**
     * Paint the |F(u,v)| magnitude the engine actually measured.
     *
     * This function previously synthesised a picture: a sin() lattice plus
     * Math.random() grain, tinted by whether the verdict was above 60%. It looked
     * like a spectrum and responded to nothing in the image. The engine now returns
     * the real pooled magnitude and this draws that.
     */
    function renderLabFft(result) {
        if (!labFftCtx || !labFftCanvas) return;

        const cw = labFftCanvas.width;
        const ch = labFftCanvas.height;

        labFftCtx.fillStyle = '#0b0b0e';
        labFftCtx.fillRect(0, 0, cw, ch);

        const fft = result.signals && result.signals.fft;
        const spectrum = fft && fft.spectrum;

        if (!spectrum || !spectrum.base64) {
            labFftCtx.font = '11px JetBrains Mono, monospace';
            labFftCtx.fillStyle = 'var(--text-faint)';
            labFftCtx.fillText('Spectrum unavailable (image below 128x128)', 12, ch / 2);
            if (labSpectrumCaption) labSpectrumCaption.textContent = '';
            return;
        }

        let bytes;
        try {
            const binary = atob(spectrum.base64);
            bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        } catch (e) {
            return;
        }

        const size = spectrum.size;
        if (bytes.length !== size * size) return;

        const tile = labFftCtx.createImageData(size, size);
        for (let i = 0; i < size * size; i++) {
            const v = bytes[i] / 255;
            const o = i * 4;
            // Dark floor through cyan to white peaks, so isolated harmonics read as points.
            tile.data[o] = Math.round(255 * Math.pow(v, 2.4));
            tile.data[o + 1] = Math.round(255 * Math.pow(v, 1.15));
            tile.data[o + 2] = Math.round(255 * Math.pow(v, 0.65));
            tile.data[o + 3] = 255;
        }

        createImageBitmap(tile).then(bitmap => {
            // Nearest-neighbour: bilinear smoothing would blur away single-bin spikes.
            labFftCtx.imageSmoothingEnabled = false;
            labFftCtx.drawImage(bitmap, 0, 0, cw, ch);

            labFftCtx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
            labFftCtx.lineWidth = 1;
            labFftCtx.beginPath();
            labFftCtx.moveTo(cw / 2, 0); labFftCtx.lineTo(cw / 2, ch);
            labFftCtx.moveTo(0, ch / 2); labFftCtx.lineTo(cw, ch / 2);
            labFftCtx.stroke();
        }).catch(() => { /* leave the panel dark rather than drawing something invented */ });

        if (labSpectrumCaption) {
            labSpectrumCaption.textContent =
                `${fft.peakCount} harmonic spikes | radial slope ${fft.slope} | HF/MF ${fft.hfToMfRatio}`;
        }
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str).replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    // Auto-inspect if launched from Context Menu with ?inspect=URL
    const urlParams = new URLSearchParams(window.location.search);
    const inspectUrl = urlParams.get('inspect');
    if (inspectUrl) {
        testImageUrlInput.value = inspectUrl;
        runTestAnalysis(inspectUrl);
    }
});