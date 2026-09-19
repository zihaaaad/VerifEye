/**
 * VerifEye Content Script
 * Captures image hover events, communicates with background forensic engine,
 * and renders a viewport-aware real-time detection tooltip with deep element resolution.
 */

let isExtensionEnabled = true;
let excludedDomains = [];
let currentTooltip = null;
let hoverTimeout = null;
let currentTargetElement = null;
let currentTargetUrl = null;
let port = null;

// Lightweight in-memory LRU cache for instant (0ms) re-hover results
const resultCache = new Map();
const MAX_CACHE_SIZE = 80;

function connectPort() {
    try {
        port = chrome.runtime.connect({ name: "verifeye_port" });
        port.onMessage.addListener(handleBackgroundMessage);
        port.onDisconnect.addListener(() => {
            port = null;
        });
    } catch (e) {
        port = null;
    }
}

function handleBackgroundMessage(response) {
    if (!currentTargetUrl || (response.imageUrl !== currentTargetUrl)) return;

    if (response.action === 'showResult') {
        const result = response.result;
        // A deep scan result supersedes the fast one for the same image.
        resultCache.set(cacheKeyFor(response.imageUrl, response.deepScan), result);
        if (resultCache.size > MAX_CACHE_SIZE) {
            const firstKey = resultCache.keys().next().value;
            resultCache.delete(firstKey);
        }
        updateTooltip(result);
    } else if (response.action === 'showError') {
        updateTooltipError(response.error);
    }
}

connectPort();

// Initialize enabled state and domain exclusions
chrome.storage.sync.get(['isEnabled', 'excludedDomains'], (data) => {
    isExtensionEnabled = data.isEnabled !== undefined ? data.isEnabled : true;
    excludedDomains = data.excludedDomains || [];
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
        if (changes.isEnabled !== undefined) {
            isExtensionEnabled = changes.isEnabled.newValue;
            if (!isExtensionEnabled) removeTooltip();
        }
        if (changes.excludedDomains !== undefined) {
            excludedDomains = changes.excludedDomains.newValue || [];
        }
    }
});

function isCurrentDomainExcluded() {
    const hostname = window.location.hostname.toLowerCase();
    return excludedDomains.some(domain => {
        const d = domain.trim().toLowerCase();
        return d && (hostname === d || hostname.endsWith('.' + d));
    });
}

function getElementBgImage(element) {
    if (!element) return null;
    const style = window.getComputedStyle(element);
    const bgImage = style.backgroundImage;
    if (bgImage && bgImage !== 'none') {
        const urlMatch = bgImage.match(/url\(['"]?(.+?)['"]?\)/);
        return urlMatch ? urlMatch[1] : null;
    }
    return null;
}

/**
 * Deep search to find the actual image URL from a hovered element or its wrappers
 */
function resolveImageFromElement(element) {
    if (!element || element.nodeType !== 1) return null;

    // 1. Direct <img> tag
    if (element.tagName === 'IMG') {
        const src = element.currentSrc || element.src;
        if (isValidImageSrc(src)) {
            const rect = element.getBoundingClientRect();
            if (rect.width >= 64 && rect.height >= 64) {
                return { element, url: src };
            }
        }
    }

    // 2. Direct <picture> or <figure> containing <img>
    if (element.tagName === 'PICTURE' || element.tagName === 'FIGURE') {
        const img = element.querySelector('img');
        if (img) {
            const src = img.currentSrc || img.src;
            if (isValidImageSrc(src)) {
                const rect = element.getBoundingClientRect();
                if (rect.width >= 64 && rect.height >= 64) {
                    return { element, url: src };
                }
            }
        }
    }

    // 3. CSS Background image on the element itself
    const bgUrl = getElementBgImage(element);
    if (bgUrl && isValidImageSrc(bgUrl)) {
        const rect = element.getBoundingClientRect();
        if (rect.width >= 64 && rect.height >= 64) {
            return { element, url: bgUrl };
        }
    }

    // 4. Overlays / wrappers on social media (X, Instagram, Reddit, Facebook, Pinterest)
    // Search children first
    const childImg = element.querySelector('img');
    if (childImg) {
        const src = childImg.currentSrc || childImg.src;
        if (isValidImageSrc(src)) {
            const rect = childImg.getBoundingClientRect();
            if (rect.width >= 64 && rect.height >= 64) {
                return { element: childImg, url: src };
            }
        }
    }

    // Search closest media container
    const container = element.closest('a, article, figure, [role="link"], [data-testid="tweetPhoto"], [role="img"]');
    if (container && container !== element) {
        const containerImg = container.querySelector('img');
        if (containerImg) {
            const src = containerImg.currentSrc || containerImg.src;
            if (isValidImageSrc(src)) {
                const rect = containerImg.getBoundingClientRect();
                if (rect.width >= 64 && rect.height >= 64) {
                    return { element: containerImg, url: src };
                }
            }
        }
        const containerBg = getElementBgImage(container);
        if (containerBg && isValidImageSrc(containerBg)) {
            const rect = container.getBoundingClientRect();
            if (rect.width >= 64 && rect.height >= 64) {
                return { element: container, url: containerBg };
            }
        }
    }

    return null;
}

function isValidImageSrc(src) {
    if (!src || typeof src !== 'string') return false;
    if (src.startsWith('data:image/svg+xml')) return false; // Ignore SVG icons
    return src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:image/');
}

function handleMouseOver(event) {
    if (!isExtensionEnabled || isCurrentDomainExcluded()) return;

    const resolved = resolveImageFromElement(event.target);
    if (!resolved) return;

    const { element, url } = resolved;
    if (currentTargetUrl === url && currentTooltip) return;

    currentTargetElement = element;
    currentTargetUrl = url;

    clearTimeout(hoverTimeout);
    hoverTimeout = setTimeout(() => {
        if (!currentTargetUrl || currentTargetUrl !== url) return;

        // Check cache first for instant display, preferring a deep result if one exists
        const deepHit = resultCache.get(cacheKeyFor(url, true));
        const fastHit = resultCache.get(cacheKeyFor(url, false));
        if (deepHit || fastHit) {
            showTooltip(element);
            updateTooltip(deepHit || fastHit);
            return;
        }

        showTooltip(element);
        sendAnalysisRequest(url);
    }, 250);
}

function handleMouseOut(event) {
    // If moving to another child inside same element, don't immediately remove
    if (event.relatedTarget && currentTargetElement && currentTargetElement.contains(event.relatedTarget)) {
        return;
    }

    clearTimeout(hoverTimeout);
    removeTooltip();
    currentTargetElement = null;
    currentTargetUrl = null;
}

function cacheKeyFor(imageUrl, deepScan) {
    return deepScan ? `deep:${imageUrl}` : imageUrl;
}

function sendAnalysisRequest(imageUrl, options = {}) {
    const deepScan = !!options.deepScan;
    if (!port) connectPort();

    if (port) {
        try {
            port.postMessage({ action: 'analyzeImage', imageUrl: imageUrl, deepScan });
            return;
        } catch (e) {
            connectPort();
        }
    }

    // Fallback to one-off runtime message
    chrome.runtime.sendMessage({ action: 'analyzeImage', imageUrl: imageUrl, deepScan }, (response) => {
        if (chrome.runtime.lastError) {
            updateTooltipError("Background engine unavailable");
            return;
        }
        if (response && response.success && currentTargetUrl === imageUrl) {
            resultCache.set(cacheKeyFor(imageUrl, deepScan), response.result);
            updateTooltip(response.result);
        } else if (response && !response.success && currentTargetUrl === imageUrl) {
            updateTooltipError(response.error);
        }
    });
}

/**
 * Deep scan: re-runs the hovered image at higher resolution and with true ELA, which
 * costs a JPEG round trip and so is never done speculatively on hover.
 */
function requestDeepScan() {
    if (!currentTargetUrl || !currentTooltip) return;

    const cached = resultCache.get(cacheKeyFor(currentTargetUrl, true));
    if (cached) { updateTooltip(cached); return; }

    const hint = currentTooltip.querySelector('.verifeye-hint');
    if (hint) hint.textContent = 'Deep scanning...';

    sendAnalysisRequest(currentTargetUrl, { deepScan: true });
}

document.addEventListener('keydown', (event) => {
    // Never steal the key from a field the user is typing into.
    const target = event.target;
    const typing = target && (target.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key !== 'v' && event.key !== 'V') return;
    if (!isExtensionEnabled || !currentTargetUrl || !currentTooltip) return;

    event.preventDefault();
    requestDeepScan();
});

function showTooltip(element) {
    removeTooltip();

    const tooltip = document.createElement('div');
    tooltip.id = 'verifeye-tooltip';
    tooltip.innerHTML = `
        <div class="verifeye-loading">
            <div class="verifeye-spinner"></div>
            <span>Analyzing image...</span>
        </div>
    `;

    document.body.appendChild(tooltip);
    currentTooltip = tooltip;
    positionTooltip(element);

    requestAnimationFrame(() => {
        tooltip.classList.add('verifeye-visible');
    });
}

function updateTooltip(result) {
    if (!currentTooltip) return;

    const prob = result.probability !== undefined ? result.probability : 50;
    const classification = result.classification || (prob >= 70 ? 'Likely AI' : prob >= 35 ? 'Uncertain' : 'Likely Real');

    let colorClass = 'verifeye-low';
    if (prob >= 70) colorClass = 'verifeye-high';
    else if (prob >= 35) colorClass = 'verifeye-medium';

    let engineTag = 'Local';
    if (result.engine === 'cloud_gemini' || result.engineMode === 'cloud') engineTag = 'Gemini';
    else if (result.engine === 'hybrid' || result.engineMode === 'hybrid') engineTag = 'Hybrid';
    else if (result.engine === 'local_metadata') engineTag = 'Provenance';
    if (result.deepScan) engineTag += ' · Deep';

    const reasonsList = (result.reasons || []).slice(0, 2)
        .map(r => `<li>${escapeHtml(r)}</li>`).join('');

    // The band is what makes the number honest: it widens when the signals disagree
    // or when evidence was missing, both of which a bare percentage conceals.
    let bandHtml = '';
    if (Array.isArray(result.band) && result.verdict !== 'AI_CONFIRMED') {
        const [low, high] = result.band;
        if (high - low >= 2) {
            bandHtml = `<div class="verifeye-band">range ${low}&ndash;${high}% · agreement ${Math.round((result.agreement ?? 0) * 100)}%</div>`;
        }
    }

    const hintText = result.deepScan
        ? 'Deep scan complete'
        : 'Press V for deep scan';

    currentTooltip.className = `verifeye-visible ${colorClass}`;
    currentTooltip.innerHTML = `
        <div class="verifeye-header">
            <span class="verifeye-badge">${escapeHtml(classification)} <b>${prob}%</b></span>
            <span class="verifeye-engine-tag">${escapeHtml(engineTag)}</span>
        </div>
        <div class="verifeye-bar-container">
            <div class="verifeye-bar" style="width: ${prob}%;"></div>
        </div>
        ${bandHtml}
        ${reasonsList ? `<ul class="verifeye-reasons">${reasonsList}</ul>` : ''}
        <div class="verifeye-spectrum-slot"></div>
        <div class="verifeye-hint">${escapeHtml(hintText)}</div>
    `;

    renderTooltipSpectrum(result);

    if (currentTargetElement) positionTooltip(currentTargetElement);
}

/**
 * Paint the measured FFT magnitude into the tooltip. Deep scans only: the spectrum
 * is real data from the engine, not an illustration, so there is nothing to show
 * until the scan that computes it has run.
 */
function renderTooltipSpectrum(result) {
    const slot = currentTooltip && currentTooltip.querySelector('.verifeye-spectrum-slot');
    const spectrum = result.signals && result.signals.fft && result.signals.fft.spectrum;
    if (!slot || !spectrum || !spectrum.base64) return;

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

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.className = 'verifeye-spectrum';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
        const v = bytes[i] / 255;
        const o = i * 4;
        img.data[o] = Math.round(255 * Math.pow(v, 2.4));
        img.data[o + 1] = Math.round(255 * Math.pow(v, 1.15));
        img.data[o + 2] = Math.round(255 * Math.pow(v, 0.65));
        img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    slot.appendChild(canvas);

    const fft = result.signals.fft;
    const caption = document.createElement('div');
    caption.className = 'verifeye-spectrum-caption';
    caption.textContent = `${fft.peakCount} harmonics · slope ${fft.slope}`;
    slot.appendChild(caption);
}

function updateTooltipError(errorText) {
    if (!currentTooltip) return;
    currentTooltip.className = 'verifeye-visible verifeye-error';
    currentTooltip.innerHTML = `
        <div class="verifeye-header">
            <span class="verifeye-badge">Notice</span>
        </div>
        <div style="font-size: 11px; color: #cbd5e1;">${escapeHtml(errorText || 'Analysis unavailable')}</div>
    `;
}

function removeTooltip() {
    if (currentTooltip) {
        currentTooltip.remove();
        currentTooltip = null;
    }
}

/**
 * Viewport-Aware Positioning: keeps tooltip within viewport bounds
 */
function positionTooltip(element) {
    if (!currentTooltip || !element) return;

    const rect = element.getBoundingClientRect();
    const tooltipRect = currentTooltip.getBoundingClientRect();

    const padding = 10;
    let top = rect.top + 10;
    let left = rect.left + 10;

    // Viewport boundary clamping
    const maxTop = window.innerHeight - (tooltipRect.height || 80) - padding;
    const maxLeft = window.innerWidth - (tooltipRect.width || 240) - padding;

    top = Math.max(padding, Math.min(top, maxTop));
    left = Math.max(padding, Math.min(left, maxLeft));

    currentTooltip.style.top = `${top}px`;
    currentTooltip.style.left = `${left}px`;
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

// Reposition on scroll
window.addEventListener('scroll', () => {
    if (currentTooltip && currentTargetElement) {
        positionTooltip(currentTargetElement);
    }
}, { passive: true });

// Two delegated listeners on document cover the entire page, including nodes added
// later by infinite scroll -- mouseover/mouseout both bubble. An earlier version also
// attached a pair of handlers to every node a MutationObserver saw, which on a feed
// accumulated thousands of redundant listeners that were never removed.
document.addEventListener('mouseover', handleMouseOver, { passive: true });
document.addEventListener('mouseout', handleMouseOut, { passive: true });