let isExtensionEnabled = false;
let currentTooltip = null;
let hoverTimeout = null;
let currentElement = null;
let port;

function connect() {
    port = chrome.runtime.connect({ name: "verifeye_port" });
    port.onMessage.addListener(handleBackgroundMessage);
    port.onDisconnect.addListener(() => { port = null; });
}

function handleBackgroundMessage(response) {
    if (currentElement && (currentElement.src === response.imageUrl || getElementBgImage(currentElement) === response.imageUrl)) {
        if (response.action === 'showResult') {
            updateTooltip(response.result, "success");
        } else if (response.action === 'showError') {
            updateTooltip(response.error, "error");
        }
    }
}

connect();
chrome.storage.sync.get('isEnabled', (data) => {
    isExtensionEnabled = data.isEnabled || false;
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.isEnabled) {
        isExtensionEnabled = changes.isEnabled.newValue;
        if (!isExtensionEnabled) removeTooltip();
    }
});

function getElementBgImage(element) {
    if (!element) return null;
    const style = window.getComputedStyle(element);
    const bgImage = style.backgroundImage;
    if (bgImage && bgImage !== 'none') {
        // Extract URL from 'url("...")'
        const urlMatch = bgImage.match(/url\("?(.+?)"?\)/);
        return urlMatch ? urlMatch[1] : null;
    }
    return null;
}

function handleMouseOver(event) {
    if (!isExtensionEnabled) return;

    const element = event.target;
    let imageUrl = null;
    let isBg = false;

    // Case 1: Standard <img> tag
    if (element.tagName === 'IMG' && element.src) {
        if (element.naturalWidth < 150 || element.naturalHeight < 150) return;
        imageUrl = element.src;
    }
    // Case 2: <div> with background-image
    else {
        const bgUrl = getElementBgImage(element);
        if (bgUrl) {
            imageUrl = bgUrl;
            isBg = true;
        }
    }

    if (!imageUrl) return;

    currentElement = element;
    clearTimeout(hoverTimeout);
    hoverTimeout = setTimeout(() => {
        showTooltip(element, "Analyzing...");
        if (!port) connect();
        try {
            port.postMessage({ action: 'analyzeImage', imageUrl: imageUrl });
        } catch(e) {
            connect();
            port.postMessage({ action: 'analyzeImage', imageUrl: imageUrl });
        }
    }, 400);
}

function handleMouseOut() {
    clearTimeout(hoverTimeout);
    removeTooltip();
    currentElement = null;
}

function showTooltip(element, text) {
    removeTooltip();
    const tooltip = document.createElement('div');
    tooltip.id = 'ai-detector-tooltip';
    tooltip.innerHTML = `<div class="ai-detector-spinner"></div><span>${text}</span>`;
    document.body.appendChild(tooltip);
    currentTooltip = tooltip;
    positionTooltip(element);
}

function updateTooltip(data, status) {
    if (!currentTooltip) return;
    if (status === "error") {
        currentTooltip.className = 'verifeye-error';
        currentTooltip.innerHTML = `<span>Error</span>`;
        return;
    }
    const probability = parseInt(data, 10);
    if(isNaN(probability)) {
        currentTooltip.className = 'verifeye-error';
        currentTooltip.innerHTML = `<span>Invalid Response</span>`;
        return;
    }
    let label = 'Likely Real';
    let className = 'verifeye-low';
    if (probability > 75) { label = 'Likely AI'; className = 'verifeye-high'; }
    else if (probability > 30) { label = 'Uncertain'; className = 'verifeye-medium'; }
    currentTooltip.className = className;
    currentTooltip.innerHTML = `<span class="verifeye-result">${label}: <b>${probability}%</b></span>`;
}

function removeTooltip() {
    if (currentTooltip) {
        currentTooltip.remove();
        currentTooltip = null;
    }
}

function positionTooltip(element) {
    if (!currentTooltip) return;
    const rect = element.getBoundingClientRect();
    currentTooltip.style.position = 'fixed';
    currentTooltip.style.top = `${window.scrollY + rect.top + 5}px`;
    currentTooltip.style.left = `${window.scrollX + rect.left + 5}px`;
}

const observer = new MutationObserver((mutationsList) => {
    for (const mutation of mutationsList) {
        if (mutation.type === 'childList') {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === 1) { // Is an element node
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