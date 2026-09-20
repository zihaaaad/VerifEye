/**
 * VerifEye Popup Controller
 */

document.addEventListener('DOMContentLoaded', async () => {
    // UI Elements
    const toggleExtension = document.getElementById('toggleExtension');
    const statusBanner = document.getElementById('statusBanner');
    const statusText = document.getElementById('statusText');
    const engineTabs = document.querySelectorAll('.engine-tab');

    const statTotal = document.getElementById('statTotal');
    const statAi = document.getElementById('statAi');
    const statReal = document.getElementById('statReal');

    const quickDrop = document.getElementById('quickDrop');
    const quickFileInput = document.getElementById('quickFileInput');
    const quickResult = document.getElementById('quickResult');
    const quickVerdict = document.getElementById('quickVerdict');
    const quickProb = document.getElementById('quickProb');
    const quickBar = document.getElementById('quickBar');
    const quickReason = document.getElementById('quickReason');

    const openSettingsBtn = document.getElementById('openSettingsBtn');

    // 1. Load initial settings
    const settings = await chrome.storage.sync.get(['isEnabled', 'engineMode']);
    const isEnabled = settings.isEnabled !== undefined ? settings.isEnabled : true;
    const engineMode = settings.engineMode || 'local';

    toggleExtension.checked = isEnabled;
    updateStatusVisual(isEnabled);

    engineTabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.mode === engineMode);
        tab.addEventListener('click', async () => {
            const mode = tab.dataset.mode;
            engineTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            await chrome.storage.sync.set({ engineMode: mode });
        });
    });

    // 2. Load Stats
    chrome.runtime.sendMessage({ action: 'getStats' }, (response) => {
        if (response && response.success && response.stats) {
            statTotal.textContent = response.stats.totalScanned || 0;
            statAi.textContent = response.stats.aiDetected || 0;
            statReal.textContent = response.stats.realVerified || 0;
        }
    });

    // 3. Extension Toggle Handler
    toggleExtension.addEventListener('change', async () => {
        const checked = toggleExtension.checked;
        // Background mirrors this into the icon/badge via storage.onChanged.
        // Do not also send 'toggleEnabled' here: that inverts the value we just wrote.
        await chrome.storage.sync.set({ isEnabled: checked });
        updateStatusVisual(checked);
    });

    function updateStatusVisual(active) {
        if (active) {
            statusBanner.className = 'status-banner banner-active';
            statusText.textContent = 'Hover Detection Active';
        } else {
            statusBanner.className = 'status-banner banner-disabled';
            statusText.textContent = 'Detection Paused';
        }
    }

    // 4. Quick Tester
    quickDrop.addEventListener('click', () => quickFileInput.click());

    quickDrop.addEventListener('dragover', (e) => {
        e.preventDefault();
        quickDrop.style.borderColor = 'var(--cyan)';
    });

    quickDrop.addEventListener('dragleave', () => {
        quickDrop.style.borderColor = 'var(--border)';
    });

    quickDrop.addEventListener('drop', (e) => {
        e.preventDefault();
        quickDrop.style.borderColor = 'var(--border)';
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleQuickFile(e.dataTransfer.files[0]);
        }
    });

    quickFileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            handleQuickFile(e.target.files[0]);
        }
    });

    function handleQuickFile(file) {
        const reader = new FileReader();
        reader.onload = (event) => {
            runQuickAnalysis(event.target.result);
        };
        reader.readAsDataURL(file);
    }

    function runQuickAnalysis(dataUrl) {
        quickResult.style.display = 'flex';
        quickVerdict.textContent = 'Analyzing...';
        quickVerdict.style.color = 'var(--cyan)';
        quickProb.textContent = '...';
        quickBar.style.width = '0%';
        quickBar.style.background = 'var(--cyan)';
        quickReason.textContent = 'Executing 2D FFT and noise residual scan...';

        chrome.runtime.sendMessage({ action: 'analyzeImage', imageUrl: dataUrl }, (response) => {
            if (chrome.runtime.lastError || !response || !response.success) {
                quickVerdict.textContent = 'Failed';
                quickVerdict.style.color = 'var(--red)';
                quickProb.textContent = 'ERR';
                quickReason.textContent = response?.error || chrome.runtime.lastError?.message || 'Processing error.';
                return;
            }

            const res = response.result;
            const prob = res.probability !== undefined ? res.probability : 50;
            const classification = res.classification || (prob >= 70 ? 'Likely AI' : prob >= 35 ? 'Uncertain' : 'Likely Real');

            quickVerdict.textContent = classification;
            quickProb.textContent = `${prob}%`;
            quickBar.style.width = `${prob}%`;

            if (prob >= 70) {
                quickVerdict.style.color = 'var(--red)';
                quickBar.style.background = 'var(--red)';
            } else if (prob >= 35) {
                quickVerdict.style.color = 'var(--amber)';
                quickBar.style.background = 'var(--amber)';
            } else {
                quickVerdict.style.color = 'var(--green)';
                quickBar.style.background = 'var(--green)';
            }

            const primaryReason = (res.reasons && res.reasons[0]) || 'Analysis complete.';
            quickReason.textContent = primaryReason;

            // Refresh stats numbers
            chrome.runtime.sendMessage({ action: 'getStats' }, (statsResp) => {
                if (statsResp && statsResp.success && statsResp.stats) {
                    statTotal.textContent = statsResp.stats.totalScanned || 0;
                    statAi.textContent = statsResp.stats.aiDetected || 0;
                    statReal.textContent = statsResp.stats.realVerified || 0;
                }
            });
        });
    }

    // 5. Open Full Options / Forensics Lab
    openSettingsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
});
