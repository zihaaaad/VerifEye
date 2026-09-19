/**
 * VerifEye Background Service Worker (Manifest V3 Module)
 * Orchestrates Local Forensic Multi-Signal Ensemble, Context Menus, Stats Tracking,
 * and Optional Gemini Cloud API.
 */

import { runLocalForensicEnsemble } from './forensics/ensemble.js';
import { computeRecompressionResidual, isRecompressionSupported } from './forensics/recompress.js';
import { decodeImage } from './forensics/decode.js';
import { analyzeImageWithGemini, testGeminiApiKey } from './api/gemini.js';

// Results are shared across every tab, unlike the content script's per-tab cache.
// Hovering the same avatar on ten open pages should cost one decode, not ten.
const analysisCache = new Map();
const MAX_CACHE_ENTRIES = 160;

function cacheKey(imageUrl, settings, deepScan) {
    return [
        imageUrl,
        settings.engineMode,
        settings.sensitivity,
        deepScan ? 'deep' : 'fast',
        Object.entries(settings.signals).filter(([, on]) => on).map(([k]) => k).sort().join(',')
    ].join('|');
}

function cacheGet(key) {
    if (!analysisCache.has(key)) return null;
    // Re-insert so Map insertion order doubles as LRU ordering.
    const value = analysisCache.get(key);
    analysisCache.delete(key);
    analysisCache.set(key, value);
    return value;
}

function cacheSet(key, value) {
    analysisCache.set(key, value);
    if (analysisCache.size > MAX_CACHE_ENTRIES) {
        analysisCache.delete(analysisCache.keys().next().value);
    }
}

// A settings change invalidates every cached verdict, since the verdict depends on them.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.sensitivity || changes.signals || changes.engineMode)) {
        analysisCache.clear();
    }
});

// --- State Management ---
async function updateIcon(isEnabled) {
    try {
        const iconPath = isEnabled ? "assets/icon48.png" : "assets/icon48-disabled.png";
        chrome.action.setIcon({ path: iconPath });
        const badgeText = isEnabled ? 'ON' : '';
        await chrome.action.setBadgeText({ text: badgeText });
        await chrome.action.setBadgeBackgroundColor({ color: isEnabled ? '#22c55e' : '#64748b' });
    } catch (e) {
        console.warn("Icon update failed:", e);
    }
}

// Any writer of `isEnabled` (popup switch, settings page, or another synced device)
// drives the icon through this single listener. Keeping it here means callers only
// ever have to write storage -- they never have to also remember to message us.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.isEnabled) {
        updateIcon(changes.isEnabled.newValue);
    }
});

// Stats helper
async function recordAnalysisStat(classification) {
    try {
        const { stats } = await chrome.storage.local.get('stats');
        const current = stats || { totalScanned: 0, aiDetected: 0, realVerified: 0, uncertain: 0 };
        current.totalScanned = (current.totalScanned || 0) + 1;

        if (classification === 'Likely AI') {
            current.aiDetected = (current.aiDetected || 0) + 1;
        } else if (classification === 'Likely Real') {
            current.realVerified = (current.realVerified || 0) + 1;
        } else {
            current.uncertain = (current.uncertain || 0) + 1;
        }

        await chrome.storage.local.set({ stats: current });
    } catch (e) {
        // Non-critical telemetry error
    }
}

chrome.runtime.onInstalled.addListener(async (details) => {
    const existing = await chrome.storage.sync.get(['isEnabled', 'engineMode', 'sensitivity', 'signals', 'excludedDomains']);
    
    // Set smart defaults
    const defaults = {
        isEnabled: existing.isEnabled !== undefined ? existing.isEnabled : true,
        engineMode: existing.engineMode || 'local', // 'local' (offline default), 'hybrid', 'cloud'
        sensitivity: existing.sensitivity || 'balanced',
        excludedDomains: existing.excludedDomains || [],
        // Spread over the stored value so an existing install picks up signals added
        // in a later version instead of silently running without them.
        signals: {
            metadata: true,
            fft: true,
            noise: true,
            ela: true,
            color: true,
            cfa: true,
            jpegQuant: true,
            benford: true,
            ...(existing.signals || {})
        }
    };
    
    await chrome.storage.sync.set(defaults);
    updateIcon(defaults.isEnabled);

    // Initialize local stats if missing
    const { stats } = await chrome.storage.local.get('stats');
    if (!stats) {
        await chrome.storage.local.set({
            stats: { totalScanned: 0, aiDetected: 0, realVerified: 0, uncertain: 0 }
        });
    }

    // Create Context Menus
    try {
        chrome.contextMenus.removeAll(() => {
            chrome.contextMenus.create({
                id: "verifeye_analyze_image",
                title: "Inspect image in VerifEye Lab",
                contexts: ["image"]
            });
            chrome.contextMenus.create({
                id: "verifeye_open_lab",
                title: "Open VerifEye Forensics Lab",
                contexts: ["action"]
            });
        });
    } catch (e) {
        console.warn("Context menu initialization failed:", e);
    }

    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
});

// Context menu click listener
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "verifeye_analyze_image" && info.srcUrl) {
        // Open options page with image URL parameter
        const optionsUrl = chrome.runtime.getURL(`settings/settings.html?inspect=${encodeURIComponent(info.srcUrl)}`);
        chrome.tabs.create({ url: optionsUrl });
    } else if (info.menuItemId === "verifeye_open_lab") {
        chrome.runtime.openOptionsPage();
    }
});

// --- Port Communication (Content Script) ---
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "verifeye_port") {
        port.onMessage.addListener(async (request) => {
            if (request.action === 'analyzeImage') {
                try {
                    const result = await processImageAnalysis(request.imageUrl, { deepScan: request.deepScan });
                    // Record stats
                    recordAnalysisStat(result.classification);

                    try {
                        port.postMessage({
                            action: 'showResult',
                            imageUrl: request.imageUrl,
                            deepScan: !!request.deepScan,
                            result: result
                        });
                    } catch (portErr) {
                        // Port closed by tab navigation/closing
                    }
                } catch (error) {
                    try {
                        port.postMessage({
                            action: 'showError',
                            imageUrl: request.imageUrl,
                            error: error.message || "Analysis failed"
                        });
                    } catch (portErr) {
                        // Port closed
                    }
                }
            }
        });
    }
});

// --- One-Off Message Listener (Popup, Settings Page & Quick Calls) ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'analyzeImage') {
        processImageAnalysis(request.imageUrl, { deepScan: request.deepScan })
            .then(result => {
                recordAnalysisStat(result.classification);
                sendResponse({ success: true, result: result });
            })
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Keep channel open for async response
    }

    if (request.action === 'toggleEnabled') {
        chrome.storage.sync.get('isEnabled').then(async ({ isEnabled }) => {
            const newState = isEnabled !== undefined ? !isEnabled : false;
            await chrome.storage.sync.set({ isEnabled: newState });
            sendResponse({ success: true, isEnabled: newState });
        });
        return true;
    }

    if (request.action === 'setEnabled') {
        chrome.storage.sync.set({ isEnabled: !!request.value }).then(() => {
            sendResponse({ success: true, isEnabled: !!request.value });
        });
        return true;
    }

    if (request.action === 'getStats') {
        chrome.storage.local.get('stats').then(({ stats }) => {
            sendResponse({ success: true, stats: stats || { totalScanned: 0, aiDetected: 0, realVerified: 0, uncertain: 0 } });
        });
        return true;
    }

    if (request.action === 'resetStats') {
        const resetObj = { totalScanned: 0, aiDetected: 0, realVerified: 0, uncertain: 0 };
        chrome.storage.local.set({ stats: resetObj }).then(() => {
            sendResponse({ success: true, stats: resetObj });
        });
        return true;
    }

    if (request.action === 'testApiKey') {
        testGeminiApiKey(request.apiKey, request.model)
            .then(() => sendResponse({ success: true }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }
});

/**
 * Main Image Processing & Forensic Detection Pipeline
 */
async function processImageAnalysis(imageUrl, runOptions = {}) {
    if (!imageUrl) throw new Error("No image URL provided");
    const deepScan = !!runOptions.deepScan;

    // Load user settings
    const settings = await chrome.storage.sync.get([
        'engineMode',
        'apiKey',
        'geminiModel',
        'sensitivity',
        'signals'
    ]);

    const engineMode = settings.engineMode || 'local';
    const apiKey = settings.apiKey || '';
    const geminiModel = settings.geminiModel || 'gemini-1.5-flash';
    const sensitivity = settings.sensitivity || 'balanced';
    const signals = settings.signals || {
        metadata: true, fft: true, noise: true, ela: true,
        color: true, cfa: true, jpegQuant: true, benford: true
    };

    const key = cacheKey(imageUrl, { engineMode, sensitivity, signals }, deepScan);
    const cached = cacheGet(key);
    if (cached) return { ...cached, cached: true };

    // 1. Fetch Image as ArrayBuffer
    const { arrayBuffer, mimeType } = await fetchImageBuffer(imageUrl);

    // 2. Decode to a working buffer plus a native-resolution crop. The crop is what
    //    lattice-sensitive analyzers read; downscaling destroys the evidence they need.
    const decoded = await decodeImage(arrayBuffer, { deepScan });

    // 3. True ELA needs a re-encode round trip costing a few ms, so it is reserved for
    //    explicit deep scans. Hover scans fall back to the blocking-index heuristic.
    let residual = null;
    if (deepScan && isRecompressionSupported()) {
        const recompressed = await computeRecompressionResidual(decoded.imageData, { quality: 0.90 });
        residual = recompressed ? recompressed.residual : null;
    }

    // 4. Local-First Forensic Ensemble (Runs 100% Offline)
    const localResult = runLocalForensicEnsemble(arrayBuffer, decoded.imageData, {
        sensitivity,
        signals,
        nativeData: decoded.nativeData,
        wasResampled: decoded.wasResampled,
        // The spectrum picture is only worth its payload on an explicit deep scan.
        includeSpectrum: deepScan,
        residual
    });

    // Port messages are JSON-serialized, and a Uint8Array would arrive as an object
    // with 4096 numeric keys. Base64 keeps it to ~5.5 KB of string.
    if (localResult.signals?.fft?.spectrum?.data) {
        const spectrum = localResult.signals.fft.spectrum;
        localResult.signals.fft.spectrum = {
            size: spectrum.size,
            base64: bytesToBase64(spectrum.data)
        };
    }
    localResult.deepScan = deepScan;
    localResult.sourceDimensions = decoded.sourceDimensions;

    // If Mode is Local (or no API key provided), return local forensic result immediately
    if (engineMode === 'local' || !apiKey) {
        const out = { ...localResult, engineMode: 'local' };
        cacheSet(key, out);
        return out;
    }

    // 4. Cloud Mode: Gemini API Only
    if (engineMode === 'cloud' && apiKey) {
        const base64Data = arrayBufferToBase64(arrayBuffer);
        const cloudResult = await analyzeImageWithGemini(apiKey, base64Data, mimeType, geminiModel);
        
        let classification = 'Likely Real';
        if (cloudResult.probability >= 70) classification = 'Likely AI';
        else if (cloudResult.probability >= 35) classification = 'Uncertain';

        return {
            probability: cloudResult.probability,
            classification: classification,
            confidence: Number((Math.abs(cloudResult.probability - 50) / 50).toFixed(2)),
            reasons: cloudResult.reasons,
            signals: localResult.signals,
            engine: 'cloud_gemini',
            engineMode: 'cloud'
        };
    }

    // 5. Hybrid Mode: Local Fast Forensic + Cloud Gemini Verification
    if (engineMode === 'hybrid' && apiKey) {
        // If metadata already 100% confirms AI, return without spending API tokens
        if (localResult.verdict === 'AI_CONFIRMED') {
            return {
                ...localResult,
                engineMode: 'hybrid_local_confirmed'
            };
        }

        try {
            const base64Data = arrayBufferToBase64(arrayBuffer);
            const cloudResult = await analyzeImageWithGemini(apiKey, base64Data, mimeType, geminiModel);

            // Blend scores: 40% local algorithmic + 60% cloud vision model
            const blendedProbability = Math.round(localResult.probability * 0.4 + cloudResult.probability * 0.6);
            let classification = 'Likely Real';
            if (blendedProbability >= 70) classification = 'Likely AI';
            else if (blendedProbability >= 35) classification = 'Uncertain';

            const combinedReasons = [...new Set([...(cloudResult.reasons || []), ...(localResult.reasons || [])])].slice(0, 4);

            return {
                probability: blendedProbability,
                classification: classification,
                confidence: Number((Math.abs(blendedProbability - 50) / 50).toFixed(2)),
                reasons: combinedReasons,
                signals: localResult.signals,
                engine: 'hybrid',
                engineMode: 'hybrid'
            };
        } catch (apiError) {
            console.warn("Cloud API fallback to local:", apiError.message);
            return {
                ...localResult,
                reasons: [...localResult.reasons, `(Cloud API unavailable: ${apiError.message})`],
                engineMode: 'local_fallback'
            };
        }
    }

    return localResult;
}

/**
 * Fetch image buffer handling both HTTP/HTTPS and base64 Data URLs
 */
async function fetchImageBuffer(url) {
    if (url.startsWith('data:')) {
        const parts = url.split(',');
        const mimeMatch = parts[0].match(/:(.*?);/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
        const binaryStr = atob(parts[1]);
        const len = binaryStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
        }
        return { arrayBuffer: bytes.buffer, mimeType: mimeType };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000); // 9s timeout

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
        throw new Error(`Failed to load image (${response.status})`);
    }

    const mimeType = response.headers.get('Content-Type') || 'image/jpeg';
    const arrayBuffer = await response.arrayBuffer();

    return { arrayBuffer, mimeType };
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
    return btoa(binary);
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    const chunkSize = 8192;

    for (let i = 0; i < len; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
        binary += String.fromCharCode.apply(null, chunk);
    }

    return btoa(binary);
}