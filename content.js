/**
 * VerifEye Content Script
 * Captures image hover events, communicates with background forensic engine,
 * and renders a viewport-aware real-time detection tooltip.
 */

let isExtensionEnabled = true;
let currentTooltip = null;
let hoverTimeout = null;
let currentTargetElement = null;
let currentTargetUrl = null;
let port = null;

// Lightweight in-memory LRU cache for instant (0ms) re-hover results
const resultCache = new Map();
const MAX_CACHE_SIZE = 60;

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
        resultCache.set(response.imageUrl, result);
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

// Initialize enabled state
chrome.storage.sync.get('isEnabled', (data) => {
    isExtensionEnabled = data.isEnabled !== undefined ? data.isEnabled : true;
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.isEnabled !== undefined) {
        isExtensionEnabled = changes.isEnabled.newValue;
        if (!isExtensionEnabled) removeTooltip();
    }
});

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

function handleMouseOver(event) {
    if (!isExtensionEnabled) return;

    const element = event.target;
    let imageUrl = null;

    // 1. Standard <img> tag
    if (element.tagName === 'IMG' && element.src) {
        // Skip tiny icons/avatars/tracking pixels
        const rect = element.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 100) return;
        imageUrl = element.src;
    }
    // 2. CSS background-image
    else {
        const bgUrl = getElementBgImage(element);
        if (bgUrl) {
            const rect = element.getBoundingClientRect();
            if (rect.width < 100 || rect.height < 100) return;
            imageUrl = bgUrl;
        }
    }

    if (!imageUrl) return;

    currentTargetElement = element;
    currentTargetUrl = imageUrl;

    clearTimeout(hoverTimeout);
    hoverTimeout = setTimeout(() => {
        // Check cache first
        if (resultCache.has(imageUrl)) {
            showTooltip(element);
            updateTooltip(resultCache.get(imageUrl));
            return;
        }

        showTooltip(element);
        sendAnalysisRequest(imageUrl);
    }, 280);
}

function handleMouseOut() {
    clearTimeout(hoverTimeout);
    removeTooltip();
    currentTargetElement = null;
    currentTargetUrl = null;
}

function sendAnalysisRequest(imageUrl) {
    if (!port) connectPort();

    if (port) {
        try {
            port.postMessage({ action: 'analyzeImage', imageUrl: imageUrl });
            return;
        } catch (e) {
            connectPort();
        }
    }

    // Fallback to one-off runtime message
    chrome.runtime.sendMessage({ action: 'analyzeImage', imageUrl: imageUrl }, (response) => {
        if (chrome.runtime.lastError) {
            updateTooltipError("Background engine unavailable");
            return;
        }
        if (response && response.success && currentTargetUrl === imageUrl) {
            resultCache.set(imageUrl, response.result);
            updateTooltip(response.result);
        } else if (response && !response.success && currentTargetUrl === imageUrl) {
            updateTooltipError(response.error);
        }
    });
}

function showTooltip(element) {
    removeTooltip();

    const tooltip = document.createElement('div');
    tooltip.id = 'ai-detector-tooltip';
    tooltip.innerHTML = `
        <div class="verifeye-loading">
            <div class="verifeye-spinner"></div>
            <span>Analyzing image...</span>
        </div>
    `;

    document.body.appendChild(tooltip);
    currentTooltip = tooltip;
    positionTooltip(element);

    // Fade in animation
    requestAnimationFrame(() => {
        tooltip.classList.add('verifeye-visible');
    });
}

function updateTooltip(result) {
    if (!currentTooltip) return;

    const prob = result.probability !== undefined ? result.probability : 50;
    const classification = result.classification || (prob >= 70 ? 'Likely AI' : prob >= 35 ? 'Uncertain' : 'Likely Real');

    let colorClass = 'verifeye-low';
    if (prob >= 70) {
        colorClass = 'verifeye-high';
    } else if (prob >= 35) {
        colorClass = 'verifeye-medium';
    }

    let engineTag = 'Local';
    if (result.engine === 'cloud_gemini' || result.engineMode === 'cloud') {
        engineTag = 'Gemini';
    } else if (result.engine === 'hybrid' || result.engineMode === 'hybrid') {
        engineTag = 'Hybrid';
    }

    const reasonsList = (result.reasons || []).slice(0, 2).map(r => `<li>${escapeHtml(r)}</li>`).join('');

    currentTooltip.className = `verifeye-visible ${colorClass}`;
    currentTooltip.innerHTML = `
        <div class="verifeye-header">
            <span class="verifeye-badge">${classification} <b>${prob}%</b></span>
            <span class="verifeye-engine-tag">${engineTag}</span>
        </div>
        <div class="verifeye-bar-container">
            <div class="verifeye-bar" style="width: ${prob}%;"></div>
        </div>
        ${reasonsList ? `<ul class="verifeye-reasons">${reasonsList}</ul>` : ''}
    `;

    if (currentTargetElement) {
        positionTooltip(currentTargetElement);
    }
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

    const padding = 8;
    let top = rect.top + 10;
    let left = rect.left + 10;

    // Viewport boundary clamping
    const maxTop = window.innerHeight - (tooltipRect.height || 70) - padding;
    const maxLeft = window.innerWidth - (tooltipRect.width || 220) - padding;

    top = Math.max(padding, Math.min(top, maxTop));
    left = Math.max(padding, Math.min(left, maxLeft));

    currentTooltip.style.top = `${top}px`;
    currentTooltip.style.left = `${left}px`;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Global Event Listeners with MutationObserver for dynamic websites
const observer = new MutationObserver((mutationsList) => {
    for (const mutation of mutationsList) {
        if (mutation.type === 'childList') {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === 1) {
                    node.addEventListener('mouseover', handleMouseOver);
                    node.addEventListener('mouseout', handleMouseOut);
                }
            });
        }
    }
});

observer.observe(document.body, { childList: true, subtree: true });

document.addEventListener('mouseover', handleMouseOver);
document.addEventListener('mouseout', handleMouseOut);