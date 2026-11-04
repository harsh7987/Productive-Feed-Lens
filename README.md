# Productive-Feed-Lens

A Chrome Extension that uses OpenAI to dynamically classify and blur non-productive video and feed content in real-time, helping users maintain focus while browsing YouTube and LinkedIn.

## 🚀 Features
* **Real-Time AI Classification**: Evaluates video titles, channel names, and post context to determine if content is productive or distracting.
* **Smart DOM Manipulation**: Injects a custom UI toggle directly into YouTube and selectively blurs non-productive elements without breaking the native page layout.
* **Advanced Web Scraping**: Bypasses dynamic class name changes on LinkedIn by utilizing child-to-parent DOM traversal.
* **Secure Architecture**: Routes external API calls through a Vercel serverless backend to securely manage OpenAI API keys and bypass browser CORS restrictions.

## 🛠️ Tech Stack
* **Frontend**: JavaScript, Chrome Extension API (Manifest V3), HTML/CSS
* **Backend**: Vercel (Serverless Functions), Node.js
* **AI Engine**: OpenAI API (gpt-4o-mini)

## 🧠 Architectural Highlights
To comply with Manifest V3 policies, this extension utilizes a **Background Service Worker (`background.js`)** as a secure proxy. Content scripts scrape metadata from the DOM and use `chrome.runtime.sendMessage` to pass the payload to the background worker. The worker handles the asynchronous HTTP requests to the Vercel backend, returning the AI's classification decision for UI execution.
