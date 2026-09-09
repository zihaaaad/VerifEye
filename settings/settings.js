/**
 * VerifEye Settings & Live Test Lab Controller
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
    const saveSignalsBtn = document.getElementById('saveSignalsBtn');

    const apiKeyInput = document.getElementById('apiKey');
    const geminiModelSelect = document.getElementById('geminiModel');
    const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
    const clearApiKeyBtn = document.getElementById('clearApiKeyBtn');

    const statusMsg = document.getElementById('statusMsg');

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

    // Load initial settings
    const settings = await chrome.storage.sync.get([
        'engineMode',
        'sensitivity',
        'signals',
        'apiKey',
        'geminiModel'
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

    const signals = settings.signals || { metadata: true, fft: true, noise: true, ela: true, color: true };
    sigMetadata.checked = signals.metadata !== false;
    sigFft.checked = signals.fft !== false;
    sigNoise.checked = signals.noise !== false;
    sigEla.checked = signals.ela !== false;
    sigColor.checked = signals.color !== false;

    function updateRadioSelectionVisual(mode) {
        optLocal.classList.toggle('selected', mode === 'local');
        optHybrid.classList.toggle('selected', mode === 'hybrid');
        optCloud.classList.toggle('selected', mode === 'cloud');
    }

    function showStatus(text, color = '#22c55e') {
        statusMsg.textContent = text;
        statusMsg.style.color = color;
        setTimeout(() => { statusMsg.textContent = ''; }, 3500);
    }

    // Save Engine Mode & Sensitivity
    saveEngineBtn.addEventListener('click', async () => {
        let selectedMode = 'local';
        for (const radio of radioModes) {
            if (radio.checked) selectedMode = radio.value;
        }

        await chrome.storage.sync.set({
            engineMode: selectedMode,
            sensitivity: sensitivitySelect.value
        });

        showStatus('Engine settings saved successfully!');
    });

    // Save Signals
    saveSignalsBtn.addEventListener('click', async () => {
        const sigObj = {
            metadata: sigMetadata.checked,
            fft: sigFft.checked,
            noise: sigNoise.checked,
            ela: sigEla.checked,
            color: sigColor.checked
        };

        await chrome.storage.sync.set({ signals: sigObj });
        showStatus('Forensic signals updated!');
    });

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

    // Clear API Key
    clearApiKeyBtn.addEventListener('click', async () => {
        apiKeyInput.value = '';
        await chrome.storage.sync.set({ apiKey: '' });
        showStatus('API key removed. Reverted to Local Engine.', '#38bdf8');
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
        dropZone.style.borderColor = '#38bdf8';
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.style.borderColor = '#334155';
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#334155';
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
        resClassification.style.color = '#94a3b8';
        resProbability.textContent = '...';
        resBar.style.width = '0%';
        resBar.style.background = '#38bdf8';
        resEngine.textContent = 'Running multi-signal algorithms...';
        resReasons.innerHTML = '<li>Decomposing 2D Fourier spectrum & noise residuals...</li>';

        chrome.runtime.sendMessage({ action: 'analyzeImage', imageUrl: imageUrl }, (response) => {
            if (chrome.runtime.lastError || !response || !response.success) {
                resClassification.textContent = 'Analysis Failed';
                resClassification.style.color = '#ef4444';
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
                resClassification.style.color = '#ef4444';
                resBar.style.background = '#ef4444';
            } else if (prob >= 35) {
                resClassification.style.color = '#f59e0b';
                resBar.style.background = '#f59e0b';
            } else {
                resClassification.style.color = '#22c55e';
                resBar.style.background = '#22c55e';
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
                resReasons.innerHTML = reasons.map(r => `<li>${r}</li>`).join('');
            } else {
                resReasons.innerHTML = '<li>No significant generative artifacts detected.</li>';
            }
        });
    }
});