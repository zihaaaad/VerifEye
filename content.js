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

// 250ms fired while the pointer was still travelling across a page, so crossing a
// gallery lit up a dozen indicators in sequence. 420ms is past the point where a
// pause reads as intent rather than transit.
const HOVER_DELAY_MS = 420;

// Images the reader has dismissed with Escape. Keyed by URL so the indicator stays
// gone for that image while they keep reading.
const dismissed = new Set();

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

    if (dismissed.has(url)) return;

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
    }, HOVER_DELAY_MS);
}

function handleMouseOut(event) {
    // If moving to another child inside same element, don't immediately remove
    if (event.relatedTarget && currentTargetElement && currentTargetElement.contains(event.relatedTarget)) {
        return;
    }

    // Moving onto the indicator itself must not dismiss it, or the chip could never
    // be hovered to expand.
    if (event.relatedTarget && currentTooltip && currentTooltip.contains(event.relatedTarget)) {
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
    if (!isExtensionEnabled || !currentTargetUrl || !currentTooltip) return;

    // Escape dismisses the indicator for this image and keeps it dismissed, so a
    // reader who does not want it can make it go away rather than avoid the image.
    if (event.key === 'Escape') {
        dismissed.add(currentTargetUrl);
        removeTooltip();
        return;
    }

    if (event.key === 'v' || event.key === 'V') {
        event.preventDefault();
        requestDeepScan();
    }
});

function showTooltip(element) {
    removeTooltip();

    const tooltip = document.createElement('div');
    tooltip.id = 'verifeye-tooltip';
    tooltip.className = 'verifeye-state-busy';
    tooltip.innerHTML = `
        <span class="verifeye-chip">
            <span class="verifeye-dot"></span>
            <span class="verifeye-chip-score">&middot;&middot;</span>
        </span>
        <div class="verifeye-detail"></div>
    `;

    // Hovering the chip is the primary way to ask for detail. Expansion is sticky
    // for as long as the pointer stays on the indicator or the image.
    tooltip.addEventListener('mouseenter', () => {
        tooltip.classList.add('is-expanded');
        if (currentTargetElement) positionTooltip(currentTargetElement);
    });

    document.body.appendChild(tooltip);
    currentTooltip = tooltip;
    positionTooltip(element);

    requestAnimationFrame(() => tooltip.classList.add('verifeye-visible'));
}

function toneFor(probability) {
    if (probability >= 70) return 'ai';
    if (probability >= 35) return 'uncertain';
    return 'real';
}

function updateTooltip(result) {
    if (!currentTooltip) return;

    const prob = result.probability !== undefined ? result.probability : 50;
    const classification = result.classification ||
        (prob >= 70 ? 'Likely AI' : prob >= 35 ? 'Uncertain' : 'Likely Real');

    const tone = toneFor(prob);

    let engineTag = 'Local';
    if (result.engine === 'cloud_gemini' || result.engineMode === 'cloud') engineTag = 'Gemini';
    else if (result.engine === 'hybrid' || result.engineMode === 'hybrid') engineTag = 'Hybrid';
    else if (result.engine === 'local_metadata') engineTag = 'Provenance';
    if (result.deepScan) engineTag += ' · deep';

    // Auto-expansion is reserved for findings that justify interrupting: a verdict
    // in AI territory, or a file that names its own generator. An ordinary
    // photograph gets a chip and nothing more.
    const worthInterrupting = tone === 'ai' || result.verdict === 'AI_CONFIRMED';
    const wasExpanded = currentTooltip.classList.contains('is-expanded');

    currentTooltip.className = [
        'verifeye-visible',
        `verifeye-state-${tone}`,
        (worthInterrupting || wasExpanded || result.deepScan) ? 'is-expanded' : ''
    ].filter(Boolean).join(' ');

    const chipScore = currentTooltip.querySelector('.verifeye-chip-score');
    if (chipScore) chipScore.textContent = `${prob}%`;

    const band = Array.isArray(result.band) ? result.band : [prob, prob];
    const low = Math.max(0, Math.min(100, band[0]));
    const high = Math.max(low, Math.min(100, band[1]));

    let bandText = '';
    if (result.verdict === 'AI_CONFIRMED') {
        bandText = 'Generator named in the file metadata';
    } else if (high - low >= 2) {
        bandText = `Range ${low}\u2013${high}% · agreement ${Math.round((result.agreement ?? 0) * 100)}%`;
    }

    const reasons = (result.reasons || []).slice(0, 2)
        .map(r => `<li>${escapeHtml(r)}</li>`).join('');

    const detail = currentTooltip.querySelector('.verifeye-detail');
    if (detail) {
        detail.innerHTML = `
            <div class="verifeye-headline">
                <span class="verifeye-verdict">${escapeHtml(classification)}</span>
                <span class="verifeye-engine-tag">${escapeHtml(engineTag)}</span>
            </div>
            <div class="verifeye-bar-track">
                <span class="verifeye-bar-band" style="left:${low}%; width:${Math.max(1, high - low)}%"></span>
                <span class="verifeye-bar-point" style="left:${prob}%"></span>
            </div>
            ${bandText ? `<p class="verifeye-band-text">${escapeHtml(bandText)}</p>` : ''}
            ${reasons ? `<ul class="verifeye-reasons">${reasons}</ul>` : ''}
            <div class="verifeye-spectrum-slot"></div>
            <div class="verifeye-hint">${result.deepScan
                ? 'Deep scan complete · <kbd>Esc</kbd> to dismiss'
                : '<kbd>V</kbd> deep scan · <kbd>Esc</kbd> dismiss'}</div>
        `;
    }

    renderTooltipSpectrum(result);

    if (currentTargetElement) positionTooltip(currentTargetElement);
}

/**
 * Paint the measured FFT magnitude into the panel. Deep scans only: the spectrum is
 * real data from the engine, so there is nothing to draw until the scan that
 * computes it has run.
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

    currentTooltip.className = 'verifeye-visible is-expanded';

    const chipScore = currentTooltip.querySelector('.verifeye-chip-score');
    if (chipScore) chipScore.textContent = '--';

    const detail = currentTooltip.querySelector('.verifeye-detail');
    if (detail) {
        detail.innerHTML = `<p class="verifeye-notice">${escapeHtml(errorText || 'Analysis unavailable')}</p>`;
    }

    if (currentTargetElement) positionTooltip(currentTargetElement);
}

function removeTooltip() {
    if (currentTooltip) {
        currentTooltip.remove();
        currentTooltip = null;
    }
}

/**
 * Place the indicator so it never covers the thing it is describing.
 *
 * The old implementation anchored to `rect.top + 10, rect.left + 10`, which put a
 * 320px card squarely over the top-left of the image — the corner most likely to
 * hold a face or a subject. This anchors to the image's bottom-right and prefers
 * the empty page outside the image, falling inside only when the image is large
 * enough that there is nowhere else to go.
 */
function positionTooltip(element) {
    if (!currentTooltip || !element) return;

    const rect = element.getBoundingClientRect();
    const size = currentTooltip.getBoundingClientRect();

    const width = size.width || 120;
    const height = size.height || 26;
    const gap = 8;
    const margin = 8;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    // Horizontal: right-align to the image, then clamp into the viewport. Flag the
    // right alignment so the panel can grow leftward from the chip.
    let left = rect.right - width;
    const alignRight = left > rect.left;
    currentTooltip.classList.toggle('align-right', alignRight);

    left = Math.max(margin, Math.min(left, viewportW - width - margin));

    // Vertical: below the image if it fits, otherwise above, otherwise tucked
    // against the inside bottom edge.
    let top;
    if (rect.bottom + gap + height <= viewportH - margin) {
        top = rect.bottom + gap;
    } else if (rect.top - gap - height >= margin) {
        top = rect.top - gap - height;
    } else {
        top = Math.max(margin, rect.bottom - height - gap);
    }

    top = Math.max(margin, Math.min(top, viewportH - height - margin));

    currentTooltip.style.top = `${Math.round(top)}px`;
    currentTooltip.style.left = `${Math.round(left)}px`;
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