# VerifEye: AI Image Detector 🛡️

**VerifEye is a powerful Chrome extension that helps users distinguish between authentic and AI-generated images in real-time, promoting a safer and more transparent browsing experience.**

![VerifEye Demo](https://i.ibb.co.com/8LY5zcWK/3.png)  <!-- **Action:** Replace this with a link to a GIF of your extension in action! -->

---

### 💡 The Problem

In the modern digital landscape, it's becoming increasingly difficult to tell real photos apart from photorealistic AI-generated images. This contributes to the spread of misinformation and erodes public trust online. VerifEye was built to address this critical challenge by providing an instant, accessible first line of defense.

### ✨ Solution: Real-Time Verification on Hover

VerifEye is a smart, non-intrusive tool designed for everyone.
*   **Activate with a Click:** Simply click the extension icon in your toolbar to turn it on. The icon will light up, and an "ON" badge will appear.
*   **Hover to Analyze:** As you browse any website, just hover your mouse over an image. VerifEye's AI engine will instantly begin to analyze it.
*   **Get Instant Results:** A clean, color-coded tooltip appears, showing the probability that the image was created by AI.

This seamless workflow empowers users to question what they see without interrupting their browsing.

### 🚀 Key Features

*   **On/Off Toggle:** You are in complete control. Activate the detector only when you need it.
*   **Real-Time Hover Analysis:** No clicks, no uploads. Just hover for instant insight.
*   **Universal Compatibility:** Works on static websites and modern, dynamic sites like Facebook, Instagram, and X (formerly Twitter), thanks to an advanced `MutationObserver` implementation.
*   **Multi-Element Detection:** Analyzes not only standard `<img>` tags but also images used as `background-image` in other elements.
*   **Clear, Color-Coded Results:** Instantly understand the analysis with a simple UI:
    *   **Green:** Likely Real
    *   **Yellow:** Uncertain
    *   **Red:** Likely AI
*   **Secure & Private:** Your personal Gemini API key is stored securely in your browser's sync storage and is never exposed on the web.

### 🛠️ Technology Stack

*   **Core Language:** JavaScript (ES6+)
*   **Platform:** Google Chrome Extension (Manifest V3)
*   **AI Engine:** Google Gemini API
*   **Specific Model:** `gemini-flash-latest` (for fast, multimodal analysis)
*   **Browser APIs:**
    *   Chrome Storage API (`chrome.storage`)
    *   Chrome Action API (`chrome.action`)
    *   Chrome Runtime API (Long-lived Port Connections)
    *   `MutationObserver` Web API
*   **Frontend:** HTML5, CSS3

---

### ⚙️ How to Install and Use (For Judges & Testers)

1.  **Download:** Click the green `<> Code` button on this GitHub page and select **Download ZIP**. Unzip the downloaded folder.
2.  **Open Chrome Extensions:** Open your Chrome browser and navigate to `chrome://extensions`.
3.  **Enable Developer Mode:** In the top-right corner of the extensions page, turn on the "Developer mode" toggle.
4.  **Load the Extension:** Click the **Load unpacked** button and select the unzipped project folder (`VerifEye-AI-Image-Detector-main`).
5.  **Set API Key:** The VerifEye icon will appear in your toolbar.
    *   **Right-click** the icon and select **"Options"**.
    *   The settings page will open. Enter your own **Google Gemini API key** and click "Save Key". You can get a free key from Google AI Studio.
6.  **Activate and Browse:**
    *   Click the VerifEye icon to turn it **ON**.
    *   Start browsing! Hover over any image to see the analysis.

### 🏆 Competition

This project was built for the google-chrome-built-in-ai-challenge-2025