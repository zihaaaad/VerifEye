/**
 * VerifEye Background Service Worker (Manifest V3 Module)
 * Orchestrates Local Forensic Multi-Signal Ensemble and Optional Gemini Cloud API.
 */

import { runLocalForensicEnsemble } from './forensics/ensemble.js';
import { analyzeImageWithGemini } from './api/gemini.js';

// --- State Management ---
async function updateIcon(isEnabled) {
    const iconPath = isEnabled ? "assets/icon48.png" : "assets/icon48-disabled.png";
    chrome.action.setIcon({ path: iconPath });
    const badgeText = isEnabled ? 'ON' : '';
    await chrome.action.setBadgeText({ text: badgeText });
    await chrome.action.setBadgeBackgroundColor({ color: isEnabled ? '#4CAF50' : '#757575' });
}

chrome.runtime.onInstalled.addListener(async (details) => {
    const existing = await chrome.storage.sync.get(['isEnabled', 'engineMode', 'sensitivity', 'signals']);
    
    // Set smart defaults
    const defaults = {
        isEnabled: existing.isEnabled !== undefined ? existing.isEnabled : true,
        engineMode: existing.engineMode || 'local', // 'local' (offline default), 'hybrid', 'cloud'
        sensitivity: existing.sensitivity || 'balanced',
        signals: existing.signals || {
            metadata: true,
            fft: true,
            noise: true,
            ela: true,
            color: true
        }
    };
    
    await chrome.storage.sync.set(defaults);
    updateIcon(defaults.isEnabled);

    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
});

chrome.action.onClicked.addListener(async () => {
    const { isEnabled } = await chrome.storage.sync.get('isEnabled');
    const newState = !isEnabled;
    await chrome.storage.sync.set({ isEnabled: newState });
    updateIcon(newState);
});

// --- Port Communication (Content Script) ---
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "verifeye_port") {
        port.onMessage.addListener(async (request) => {
            if (request.action === 'analyzeImage') {
                try {
                    const result = await processImageAnalysis(request.imageUrl);
                    port.postMessage({
                        action: 'showResult',
                        imageUrl: request.imageUrl,
                        result: result
                    });
                } catch (error) {
                    console.error("VerifEye Analysis Error:", error);
                    port.postMessage({
                        action: 'showError',
                        imageUrl: request.imageUrl,
                        error: error.message || "Analysis failed"
                    });
                }
            }
        });
    }
});

// --- One-Off Message Listener (Settings Page & Popups) ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'analyzeImage') {
        processImageAnalysis(request.imageUrl)
            .then(result => sendResponse({ success: true, result: result }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Keep channel open for async response
    }
});

/**
 * Main Image Processing & Detection Pipeline
 */
async function processImageAnalysis(imageUrl) {
    if (!imageUrl) throw new Error("No image URL provided");

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
    const signals = settings.signals || { metadata: true, fft: true, noise: true, ela: true, color: true };

    // 1. Fetch Image as ArrayBuffer
    const { arrayBuffer, mimeType } = await fetchImageBuffer(imageUrl);

    // 2. Decode Image to ImageData via OffscreenCanvas
    const imageData = await decodeImageToData(arrayBuffer);

    // 3. Local-First Forensic Ensemble (Runs 100% Offline)
    const localResult = runLocalForensicEnsemble(arrayBuffer, imageData, { sensitivity, signals });

    // If Mode is Local (or no API key provided), return local forensic result immediately
    if (engineMode === 'local' || !apiKey) {
        return {
            ...localResult,
            engineMode: 'local'
        };
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
            confidence: Math.abs(cloudResult.probability - 50) / 50,
            reasons: cloudResult.reasons,
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
                confidence: Math.abs(blendedProbability - 50) / 50,
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
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
        throw new Error(`Failed to load image (${response.status})`);
    }

    const mimeType = response.headers.get('Content-Type') || 'image/jpeg';
    const arrayBuffer = await response.arrayBuffer();

    return { arrayBuffer, mimeType };
}

/**
 * Decode binary image into ImageData using OffscreenCanvas
 */
async function decodeImageToData(arrayBuffer) {
    const blob = new Blob([arrayBuffer]);
    const bitmap = await createImageBitmap(blob);

    // Downscale large images to max 384x384 for instant (<15ms) processing
    const maxDimension = 384;
    let targetWidth = bitmap.width;
    let targetHeight = bitmap.height;

    if (targetWidth > maxDimension || targetHeight > maxDimension) {
        const scale = Math.min(maxDimension / targetWidth, maxDimension / targetHeight);
        targetWidth = Math.max(32, Math.round(targetWidth * scale));
        targetHeight = Math.max(32, Math.round(targetHeight * scale));
    }

    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    return ctx.getImageData(0, 0, targetWidth, targetHeight);
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