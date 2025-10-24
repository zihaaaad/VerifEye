document.addEventListener('DOMContentLoaded', () => {
    const saveButton = document.getElementById('saveBtn');
    const apiKeyInput = document.getElementById('apiKey');
    const statusDiv = document.getElementById('status');

    chrome.storage.sync.get(['apiKey'], (result) => {
        if (result.apiKey) {
            apiKeyInput.value = result.apiKey;
        }
    });

    saveButton.addEventListener('click', () => {
        const apiKey = apiKeyInput.value.trim();
        chrome.storage.sync.set({ apiKey: apiKey }, () => {
            statusDiv.textContent = 'API Key saved successfully!';
            statusDiv.style.color = 'green';
            setTimeout(() => { statusDiv.textContent = ''; }, 3000);
        });
    });
});