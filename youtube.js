/**
 * youtube.js - Injected script for YouTube AI Focus
 *
 * Flow:
 * 1. Injects full-screen overlay asking user to choose 'Productive' or 'Non-Productive'.
 * 2. Checks chrome.storage.local for the saved OpenAI API key.
 * 3. Once mode is chosen, initializes MutationObserver to detect all video titles.
 * 4. Applies visual bypass blur via .ai-focus-blurred class to excluded videos.
 * 5. Checks local cache (memory + chrome.storage.local).
 * 6. Sends unseen video titles to background.js for classification.
 * 7. Listens for background.js response, updates cache, and toggles .ai-focus-blurred to reveal matching videos.
 */

(function () {
  'use strict';

  // Strict Domain Isolation: Only execute on YouTube
  if (typeof window !== 'undefined' && window.location) {
    if (!window.location.hostname.includes('youtube.com')) {
      return;
    }
  }

  // Prevent multiple injections
  if (window.__yt_ai_focus_initialized__) {
    console.log('[YouTube AI Focus] Script already initialized on this page.');
    return;
  }
  window.__yt_ai_focus_initialized__ = true;

  console.log('[YouTube AI Focus] === youtube.js initializing on:', window.location.href, '===');

  let selectedMode = 'productive'; // 'productive' | 'non-productive'
  let youtubeFilterEnabled = true;
  let hasApiKey = true;
  const localCache = new Map(); // videoId -> 'productive' | 'non-productive'
  const pendingRequests = new Set(); // videoIds already sent to background
  const containerElementMap = new Map(); // videoId -> Set of HTMLElements
  let isScanningScheduled = false;

  // Inject critical CSS immediately into document <head> for smooth transitions and visual bypass
  const styleEl = document.createElement('style');
  styleEl.id = 'yt-ai-focus-styles';
  styleEl.textContent = `
    .ai-focus-transition { transition: filter 0.4s ease-in-out, opacity 0.4s ease-in-out !important; }
    .ai-focus-blurred { filter: blur(15px) !important; opacity: 0.4 !important; pointer-events: none !important; }

    /* Full-Screen Selection Modal */
    #yt-ai-focus-overlay {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(10, 10, 15, 0.94);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      animation: ytAiFadeIn 0.3s ease-out;
    }

    .yt-ai-modal-card {
      background: #181824;
      border: 1px solid #2e2e42;
      border-radius: 20px;
      padding: 36px 40px;
      max-width: 540px;
      width: 90%;
      text-align: center;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7), 0 0 1px rgba(255, 255, 255, 0.15);
      color: #f8fafc;
    }

    .yt-ai-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: linear-gradient(135deg, rgba(217, 119, 6, 0.2), rgba(234, 88, 12, 0.2));
      border: 1px solid rgba(245, 158, 11, 0.35);
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      color: #fbbf24;
      margin-bottom: 16px;
    }

    .yt-ai-modal-title {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
      color: #ffffff;
    }

    .yt-ai-modal-subtitle {
      font-size: 14px;
      color: #94a3b8;
      margin-bottom: 24px;
      line-height: 1.5;
    }

    .yt-ai-warning-banner {
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.35);
      color: #fbbf24;
      padding: 10px 16px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      text-align: left;
    }

    .yt-ai-warning-banner a {
      color: #ffffff;
      text-decoration: underline;
      cursor: pointer;
      margin-left: 8px;
      font-weight: 600;
    }

    .yt-ai-options-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 24px;
    }

    .yt-ai-choice-btn {
      background: #202030;
      border: 2px solid #33334d;
      border-radius: 14px;
      padding: 22px 16px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      color: #f1f5f9;
    }

    .yt-ai-choice-btn:hover {
      transform: translateY(-3px);
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.4);
    }

    .yt-ai-choice-btn.productive:hover {
      border-color: #10b981;
      background: rgba(16, 185, 129, 0.12);
    }

    .yt-ai-choice-btn.non-productive:hover {
      border-color: #a855f7;
      background: rgba(168, 85, 247, 0.12);
    }

    .yt-ai-btn-icon {
      font-size: 32px;
      line-height: 1;
    }

    .yt-ai-btn-title {
      font-size: 16px;
      font-weight: 700;
    }

    .yt-ai-btn-desc {
      font-size: 12px;
      color: #94a3b8;
      line-height: 1.4;
    }

    .yt-ai-modal-footer {
      font-size: 12px;
      color: #64748b;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-top: 1px solid #28283c;
      padding-top: 16px;
    }

    .yt-ai-settings-link {
      color: #fbbf24;
      text-decoration: none;
      cursor: pointer;
    }

    .yt-ai-settings-link:hover {
      text-decoration: underline;
    }

    /* Floating Switcher Pill */
    #yt-ai-floating-pill {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      background: rgba(24, 24, 36, 0.92);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid #3b3b54;
      border-radius: 30px;
      padding: 8px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      font-weight: 600;
      color: #f1f5f9;
      transition: all 0.2s ease;
      user-select: none;
    }

    #yt-ai-floating-pill:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.6);
      border-color: #f59e0b;
    }

    .yt-ai-pill-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .yt-ai-pill-dot.productive {
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
    }

    .yt-ai-pill-dot.non-productive {
      background: #a855f7;
      box-shadow: 0 0 8px #a855f7;
    }

    .yt-ai-switch-tag {
      font-size: 11px;
      color: #94a3b8;
      background: #2a2a3e;
      padding: 2px 6px;
      border-radius: 10px;
      margin-left: 2px;
    }

    /* Toast Notification */
    #yt-ai-toast {
      position: fixed;
      top: 24px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: #b91c1c;
      color: #fff;
      padding: 12px 22px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6);
      display: none;
      cursor: pointer;
      animation: ytAiSlideDown 0.3s ease;
    }

    @keyframes ytAiFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes ytAiSlideDown {
      from { opacity: 0; transform: translate(-50%, -10px); }
      to { opacity: 1; transform: translate(-50%, 0); }
    }
  `;
  // Inject global CSS style tag into the document <head>
  if (document.head) {
    document.head.appendChild(styleEl);
  } else {
    (document.documentElement || document).appendChild(styleEl);
  }

  // Initialize: Load cached categories, API key status, and session mode
  init();

  async function init() {
    console.log('[YouTube AI Focus] Step 1: Loading storage preferences and video cache...');
    let stored = {};
    try {
      stored = await chrome.storage.local.get([
        'youtubeFilterEnabled',
        'activeMode',
        'youtubeMode',
        'openaiApiKey',
        'apiKey',
        'anthropicApiKey',
        'videoCategories'
      ]);
    } catch (err) {
      console.warn('[YouTube AI Focus] Error reading chrome.storage.local:', err);
      stored = {};
    }

    if (stored.youtubeFilterEnabled !== undefined) {
      youtubeFilterEnabled = Boolean(stored.youtubeFilterEnabled);
    }
    if (stored.activeMode || stored.youtubeMode) {
      selectedMode = stored.activeMode || stored.youtubeMode;
    }

    hasApiKey = Boolean(stored.openaiApiKey || stored.apiKey || stored.anthropicApiKey || true);
    console.log('[YouTube AI Focus] API key configured in storage:', hasApiKey);

    if (stored.videoCategories) {
      for (const [id, category] of Object.entries(stored.videoCategories)) {
        localCache.set(id, category);
      }
    }
    console.log('[YouTube AI Focus] Loaded cached classifications count:', localCache.size);

    // Listen for storage changes if user updates key in options tab
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
          if (changes.youtubeFilterEnabled !== undefined) {
            youtubeFilterEnabled = changes.youtubeFilterEnabled.newValue !== false;
            if (!youtubeFilterEnabled) {
              disableFilter();
            } else {
              reapplyFilterToAllElements();
              scheduleScan();
            }
          }
          if (changes.activeMode !== undefined || changes.youtubeMode !== undefined) {
            const newMode = changes.activeMode?.newValue || changes.youtubeMode?.newValue;
            if (newMode) {
              selectedMode = newMode;
              if (youtubeFilterEnabled) {
                reapplyFilterToAllElements();
              }
            }
          }
          if (changes.videoCategories) {
            if (changes.videoCategories.newValue && Object.keys(changes.videoCategories.newValue).length > 0) {
              console.log('[YouTube AI Focus] Cache updated from background storage.');
              for (const [id, category] of Object.entries(changes.videoCategories.newValue)) {
                localCache.set(id, category);
              }
            } else {
              console.log('[YouTube AI Focus] Video categories cache cleared.');
              localCache.clear();
              pendingRequests.clear();
            }
            if (selectedMode) {
              reapplyFilterToAllElements();
              scheduleScan();
            }
          }
          if (changes.activeGoal) {
            console.log('[YouTube AI Focus] Active focus goal updated:', changes.activeGoal.newValue);
            localCache.clear();
            pendingRequests.clear();
            if (selectedMode) {
              reapplyFilterToAllElements();
              scheduleScan();
            }
          }
        }
      });
    } catch (_) {}

    // Step 2: Check session focus mode
    const sessionMode = sessionStorage.getItem('yt_ai_focus_mode');
    if (sessionMode === 'productive' || sessionMode === 'non-productive') {
      console.log('[YouTube AI Focus] Found existing session mode in sessionStorage:', sessionMode);
      setFocusMode(sessionMode);
    } else {
      console.log('[YouTube AI Focus] No focus mode selected for this session. Showing selection overlay...');
      showFocusOverlay();
    }

    // Step 3: Listen for categorization results broadcast from background.js
    try {
      chrome.runtime.onMessage.addListener(handleBackgroundMessage);
    } catch (_) {}

    // Listen for YouTube single-page navigation events
    window.addEventListener('yt-navigate-finish', () => {
      console.log('[YouTube AI Focus] yt-navigate-finish event detected. Re-evaluating page videos...');
      if (selectedMode) {
        scheduleScan();
      }
    });
  }

  /**
   * Shows the full-screen focus mode selection overlay
   */
  function showFocusOverlay() {
    if (document.getElementById('yt-ai-focus-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'yt-ai-focus-overlay';

    overlay.innerHTML = `
      <div class="yt-ai-modal-card">
        <div class="yt-ai-badge">⚡ AI-Powered Focus</div>
        <h1 class="yt-ai-modal-title">Select YouTube Session Focus</h1>
        <p class="yt-ai-modal-subtitle">
          Videos will be instantly filtered using our secure backend proxy to match your current objective.
        </p>

        <div class="yt-ai-options-grid">
          <button type="button" class="yt-ai-choice-btn productive" id="ytAiBtnProductive">
            <span class="yt-ai-btn-icon">🎯</span>
            <span class="yt-ai-btn-title">Productive</span>
            <span class="yt-ai-btn-desc">Tutorials, Coding, Science, Documentaries & Study</span>
          </button>

          <button type="button" class="yt-ai-choice-btn non-productive" id="ytAiBtnNonProductive">
            <span class="yt-ai-btn-icon">🍿</span>
            <span class="yt-ai-btn-title">Non-Productive</span>
            <span class="yt-ai-btn-desc">Entertainment, Gaming, Comedy, Music & Chill</span>
          </button>
        </div>

        <div class="yt-ai-modal-footer">
          <span>YouTube AI Focus &bull; Secure Backend</span>
          <a class="yt-ai-settings-link" id="ytAiOpenOptionsLink">⚙️ Settings</a>
        </div>
      </div>
    `;

    function attachOverlay() {
      const parent = document.body || document.documentElement;
      if (!parent) {
        setTimeout(attachOverlay, 50);
        return;
      }
      parent.appendChild(overlay);
      console.log('[YouTube AI Focus] Focus selection overlay appended to DOM.');
    }
    attachOverlay();

    // Bind event handlers
    const btnProd = document.getElementById('ytAiBtnProductive');
    if (btnProd) {
      btnProd.addEventListener('click', () => {
        console.log('[YouTube AI Focus] User clicked Productive mode button.');
        setFocusMode('productive');
        overlay.remove();
      });
    }

    const btnNonProd = document.getElementById('ytAiBtnNonProductive');
    if (btnNonProd) {
      btnNonProd.addEventListener('click', () => {
        console.log('[YouTube AI Focus] User clicked Non-Productive mode button.');
        setFocusMode('non-productive');
        overlay.remove();
      });
    }

    const optLink = document.getElementById('ytAiOpenOptionsLink');
    if (optLink) {
      optLink.addEventListener('click', () => {
        try {
          chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
        } catch (_) {}
      });
    }

    const warningLink = document.getElementById('ytAiWarningSetKeyLink');
    if (warningLink) {
      warningLink.addEventListener('click', () => {
        try {
          chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
        } catch (_) {}
      });
    }
  }

  /**
   * Sets the active focus mode, saves to sessionStorage, updates pill, and triggers scanning
   */
  function setFocusMode(mode) {
    selectedMode = mode;
    console.log('[YouTube AI Focus] === Focus Mode Active:', selectedMode, '===');
    try {
      sessionStorage.setItem('yt_ai_focus_mode', mode);
      chrome.runtime.sendMessage({ type: 'SET_FOCUS_MODE', mode: mode }, () => {
        const _ = chrome.runtime.lastError;
      });
    } catch (_) {}

    renderFloatingPill();
    startMutationObserver();

    // Re-evaluate any video elements currently on the page
    reapplyFilterToAllElements();

    // Scan immediately and schedule follow-ups as YouTube loads dynamic rows
    scanAndProcessVideos();
    setTimeout(scanAndProcessVideos, 500);
    setTimeout(scanAndProcessVideos, 1500);
  }

  /**
   * Displays or updates the discreet floating pill in the bottom corner
   */
  function renderFloatingPill() {
    let pill = document.getElementById('yt-ai-floating-pill');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'yt-ai-floating-pill';
      pill.title = 'Click to switch focus mode';
      pill.addEventListener('click', () => {
        const nextMode = selectedMode === 'productive' ? 'non-productive' : 'productive';
        console.log('[YouTube AI Focus] Switching mode via pill to:', nextMode);
        setFocusMode(nextMode);
      });
      const parent = document.body || document.documentElement;
      if (parent) parent.appendChild(pill);
    }

    const modeLabel = selectedMode === 'productive' ? 'Productive' : 'Non-Productive';
    const dotClass = selectedMode === 'productive' ? 'productive' : 'non-productive';

    pill.innerHTML = `
      <span class="yt-ai-pill-dot ${dotClass}"></span>
      <span>Focus: ${modeLabel}</span>
      <span class="yt-ai-switch-tag">Switch ⇄</span>
    `;
  }

  /**
   * Starts MutationObserver to watch for video elements added dynamically by YouTube
   */
  let observer = null;
  function startMutationObserver() {
    if (observer) return;

    function attachObserver() {
      const target = document.body || document.documentElement;
      if (!target) {
        setTimeout(attachObserver, 100);
        return;
      }

      observer = new MutationObserver(() => {
        if (!selectedMode) return;
        scheduleScan();
      });

      observer.observe(target, {
        childList: true,
        subtree: true
      });
      console.log('[YouTube AI Focus] MutationObserver started watching DOM mutations on:', target.tagName);
    }

    attachObserver();
  }

  /**
   * Debounced scanning using requestAnimationFrame to maintain smooth 60fps scrolling
   */
  function scheduleScan() {
    if (isScanningScheduled) return;
    isScanningScheduled = true;

    requestAnimationFrame(() => {
      isScanningScheduled = false;
      scanAndProcessVideos();
    });
  }

  /**
   * Modern YouTube DOM video container selectors
   */
  const VIDEO_CONTAINER_SELECTORS = [
    'ytd-rich-item-renderer',       // Modern YouTube home grid videos
    'ytd-video-renderer',           // Search results & subscription feed
    'ytd-compact-video-renderer',   // Watch page sidebar recommendations
    'ytd-grid-video-renderer',      // Channel page video grid
    'ytd-reel-item-renderer',       // Shorts carousel items
    'ytd-rich-grid-media'           // Nested grid media
  ].join(', ');

  /**
   * Scans all YouTube video container elements in the DOM
   */
  function scanAndProcessVideos() {
    console.log('[YouTube AI Focus] Step 2: Querying DOM for YouTube videos using selectors:', VIDEO_CONTAINER_SELECTORS);
    const containers = document.querySelectorAll(VIDEO_CONTAINER_SELECTORS);
    console.log('[YouTube AI Focus] Found', containers.length, 'video container elements in DOM.');

    const unseenVideos = [];
    let cachedCount = 0;
    let pendingTitleCount = 0;
    let noIdCount = 0;

    containers.forEach((container) => {
      // Permanently add the ai-focus-transition class to the #dismissible element
      const dismissible = container.querySelector('#dismissible') || container;
      if (dismissible && dismissible.classList) {
        dismissible.classList.add('ai-focus-transition');
      }

      const videoInfo = extractVideoInfo(container);

      // If YouTube has not stamped the link/title yet, default to visible
      if (!videoInfo || !videoInfo.id) {
        noIdCount++;
        if (!container.dataset.aiFocusId) {
          setDismissibleBlurState(container, false);
        }
        return;
      }

      const { id: videoId, title } = videoInfo;

      // Track element for this video ID
      container.dataset.aiFocusId = videoId;
      if (!containerElementMap.has(videoId)) {
        containerElementMap.set(videoId, new Set());
      }
      containerElementMap.get(videoId).add(container);

      // Check if this video has already been categorized
      if (localCache.has(videoId)) {
        cachedCount++;
        const category = localCache.get(videoId);
        applyVisibility(container, category);
      } else {
        // Video has not been categorized yet: default to keeping visible while awaiting classification
        setDismissibleBlurState(container, false);

        // If title is available and we haven't dispatched request yet, queue for background
        if (title && !pendingRequests.has(videoId)) {
          pendingRequests.add(videoId);
          unseenVideos.push({
            id: videoId,
            title: title,
            channel: videoInfo.channel || 'Unknown',
            duration: videoInfo.duration || 'Unknown'
          });
        } else if (!title) {
          pendingTitleCount++;
        }
      }
    });

    console.log(
      `[YouTube AI Focus] Scan summary: ${containers.length} containers total (${cachedCount} already cached, ${unseenVideos.length} newly queued for background, ${pendingTitleCount} pending title rendering, ${noIdCount} unstamped).`
    );

    // Send newly discovered unseen titles to background service worker
    if (unseenVideos.length > 0) {
      console.log(
        '[YouTube AI Focus] Step 3: Right before sending payload to background.js with',
        unseenVideos.length,
        'unseen videos. Mode:',
        selectedMode,
        'Payload sample:',
        unseenVideos.slice(0, 3)
      );

      try {
        chrome.runtime.sendMessage(
          {
            type: 'CATEGORIZE_VIDEOS',
            platform: 'youtube',
            videos: unseenVideos,
            mode: selectedMode
          },
          function (response) {
            const lastErr = chrome.runtime.lastError;
            if (lastErr) {
              console.warn('[YouTube AI Focus] Message to background.js encountered lastError:', lastErr.message);
              return;
            }
            console.log('[YouTube AI Focus] background.js response acknowledgement:', response);
          }
        );
      } catch (err) {
        console.error('[YouTube AI Focus] Exception sending message to background.js:', err);
      }
    }
  }

  /**
   * Extracts video ID and Title from a YouTube video container
   * Specifically targets modern YouTube DOM structures
   */
  function extractVideoInfo(container) {
    if (!container) return null;

    // 1. Locate video anchor tag containing watch?v= or /shorts/
    let id = null;
    let url = '';

    const links = container.querySelectorAll(
      'a#video-title-link, a#thumbnail, a#video-title, a[href*="watch?v="], a[href*="/shorts/"]'
    );

    for (const link of links) {
      const href = link.getAttribute('href') || link.href || '';
      if (href) {
        try {
          url = new URL(href, window.location.origin).href;
        } catch (_) {
          url = href;
        }
      }
      const vMatch = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (vMatch) {
        id = vMatch[1];
        break;
      }
      const shortsMatch = href.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) {
        id = shortsMatch[1];
        break;
      }
    }

    if (!id && !url) return null;

    // 2. Locate title text
    let title = '';

    // Primary target: #video-title (used on standard modern YouTube videos)
    const titleEl = container.querySelector(
      '#video-title, #video-title-link, yt-formatted-string#video-title, span#video-title, a#video-title'
    );

    if (titleEl) {
      title =
        titleEl.getAttribute('title') ||
        titleEl.textContent ||
        titleEl.getAttribute('aria-label') ||
        '';
    }

    // Secondary fallback: thumbnail aria-label
    if (!title) {
      const thumb = container.querySelector('a#thumbnail, ytd-thumbnail a');
      if (thumb) {
        title = thumb.getAttribute('title') || thumb.getAttribute('aria-label') || '';
      }
    }

    // Tertiary fallback: heading or title-style elements
    if (!title) {
      const h3 = container.querySelector('h3, .title-style');
      if (h3) {
        title = h3.getAttribute('title') || h3.textContent || '';
      }
    }

    title = title.replace(/\s+/g, ' ').trim();

    // 3. Locate Channel Name
    let channel = '';
    const channelEl = container.querySelector(
      'ytd-channel-name #text, #channel-name #text, a.yt-simple-endpoint[href*="/@"], #channel-name a, ytd-channel-name a, #byline a, #byline-container #text'
    );
    if (channelEl) {
      channel = (
        channelEl.getAttribute('title') ||
        channelEl.textContent ||
        channelEl.getAttribute('aria-label') ||
        ''
      ).replace(/\s+/g, ' ').trim();
    }

    // 4. Locate Video Duration / Length
    let duration = '';
    const timeEl = container.querySelector(
      'ytd-thumbnail-overlay-time-status-renderer span#text, ytd-thumbnail-overlay-time-status-renderer #text, .badge-shape-wiz__text, span.ytd-thumbnail-overlay-time-status-renderer, #time-status span'
    );
    if (timeEl) {
      duration = timeEl.textContent.replace(/\s+/g, ' ').trim();
    }

    // Fallback: check if Shorts video
    if (!duration) {
      if (
        container.querySelector('[overlay-style="SHORTS"]') ||
        container.querySelector('a[href*="/shorts/"]')
      ) {
        duration = 'Short (<1m)';
      }
    }

    // 5. Locate Timestamp
    let timestamp = '';
    const metaSpans = container.querySelectorAll(
      '#metadata-line span.inline-metadata-item, ytd-video-meta-block #metadata-line span, #metadata-line span, .yt-lockup-metadata-view-model__metadata span'
    );
    for (const span of metaSpans) {
      const text = (span.textContent || '').replace(/\s+/g, ' ').trim();
      if (/ago|streamed|premiered|yesterday|hour|day|week|month|year|minute/i.test(text)) {
        timestamp = text;
        break;
      }
    }
    if (!timestamp && metaSpans.length > 1) {
      timestamp = (metaSpans[1].textContent || '').replace(/\s+/g, ' ').trim();
    }

    // 6. Broad card text
    const allText = (container.innerText || container.textContent || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);

    return { id: id || '', title, channel, timestamp, duration, url, allText };
  }

  /**
   * Applies or clears the visual bypass blur effect strictly on the child #dismissible element
   * using a class-based toggle system (.ai-focus-blurred).
   * Smooth transition is handled via .ai-focus-transition class.
   */
  function setDismissibleBlurState(container, shouldBlur) {
    if (!container) return;

    // Target the inner #dismissible element specifically
    const dismissible = container.querySelector('#dismissible') || container;
    if (!dismissible || !dismissible.classList) return;

    // Permanently ensure transition class is present
    dismissible.classList.add('ai-focus-transition');

    if (shouldBlur) {
      dismissible.classList.add('ai-focus-blurred');
    } else {
      dismissible.classList.remove('ai-focus-blurred');
    }
  }

  /**
   * Applies focus styling: in Productive Mode, blurs non-productive content;
   * in Non-Productive Mode, keeps ALL videos visible (nothing blurred).
   */
  function applyVisibility(container, category) {
    if (!container || !container.classList) return;
    try {
      // Requirement 3: When switched to "Non-Productive Mode", NOTHING should be blurred
      if (!youtubeFilterEnabled || selectedMode === 'non-productive') {
        setDismissibleBlurState(container, false);
        return;
      }
      // In Productive mode: blur non-productive distractions, keep productive content visible
      setDismissibleBlurState(container, category === 'non-productive');
    } catch (_) {}
  }

  function disableFilter() {
    console.log('[YouTube AI Focus] Disabling filter. Displaying YouTube normally.');
    const all = document.querySelectorAll('.ai-focus-blurred, [data-ai-blurred]');
    all.forEach(el => el.classList.remove('ai-focus-blurred'));
  }

  /**
   * Re-evaluates all known elements when mode is switched
   */
  function reapplyFilterToAllElements() {
    console.log('[YouTube AI Focus] Re-applying blur filter to all known elements in DOM for mode:', selectedMode);
    for (const [videoId, elements] of containerElementMap.entries()) {
      const category = localCache.get(videoId);
      if (elements && typeof elements.forEach === 'function') {
        elements.forEach((el) => {
          if (el && el.isConnected) {
            applyVisibility(el, category);
          }
        });
      }
    }
  }

  /**
   * Applies a category map to both memory and matching DOM elements
   */
  function applyCategorizedMapping(categories) {
    if (!categories || typeof categories !== 'object') return;

    for (const [videoId, category] of Object.entries(categories)) {
      if (!videoId || typeof videoId !== 'string') continue;
      localCache.set(videoId, category);

      // 1. Update elements in memory map
      const elements = containerElementMap.get(videoId);
      if (elements && typeof elements.forEach === 'function') {
        elements.forEach((el) => {
          if (el && el.isConnected) {
            applyVisibility(el, category);
          }
        });
      }

      // 2. Safely query matching elements in DOM
      try {
        const safeSelector = `[data-ai-focus-id="${CSS.escape(videoId)}"]`;
        const domElements = document.querySelectorAll(safeSelector);
        if (domElements && typeof domElements.forEach === 'function') {
          domElements.forEach((el) => {
            applyVisibility(el, category);
          });
        }
      } catch (_) {}
    }
  }

  /**
   * Handles incoming categorization messages from background.js
   */
  function handleBackgroundMessage(message) {
    if (!message || typeof message !== 'object') return;

    try {
      if (message.type === 'TOGGLE_YOUTUBE_FILTER') {
        youtubeFilterEnabled = message.enabled !== false;
        if (!youtubeFilterEnabled) {
          disableFilter();
        } else {
          reapplyFilterToAllElements();
          scheduleScan();
        }
      } else if (message.type === 'SET_YOUTUBE_MODE') {
        selectedMode = message.mode;
        if (youtubeFilterEnabled) {
          reapplyFilterToAllElements();
        }
      } else if (message.type === 'VIDEOS_CATEGORIZED' && message.categories) {
        console.log(
          '[YouTube AI Focus] Received VIDEOS_CATEGORIZED message from background.js with',
          Object.keys(message.categories).length,
          'categories.'
        );
        applyCategorizedMapping(message.categories);
      } else if (message.type === 'AI_FOCUS_ERROR') {
        console.warn('[YouTube AI Focus] Backend reported error:', message.message);
      }
    } catch (_) {}
  }

  /**
   * Shows a clickable notification toast that opens extension settings
   */
  function showToast(text) {
    let toast = document.getElementById('yt-ai-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'yt-ai-toast';
      toast.title = 'Click to open settings';
      toast.addEventListener('click', () => {
        try {
          chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
        } catch (_) {}
      });
      const parent = document.body || document.documentElement;
      if (parent) parent.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.display = 'block';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 6000);
  }
})();
