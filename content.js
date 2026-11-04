/**
 * content.js - YouTube AI Focus Content Script
 *
 * Responsibilities:
 * 1. Strict Domain Isolation: Only executes on youtube.com; prevents LinkedIn hover-peek or logic.
 * 2. Service Worker Message Passing: Delegates backend requests to background.js service worker
 *    to bypass MV3 content-script CORS and frame CSP ("Domains, protocols and ports must match") blocks.
 * 3. On-Screen Floating UI Toggle Sync: Injects the floating Productive/Non-Productive pill ONLY when
 *    the master "Enable YouTube Filter" toggle is ON in Chrome storage. Completely removes it when OFF.
 * 4. Master Switch Control: If master toggle is OFF, removes floating UI, pauses all DOM scraping/fetching,
 *    and un-blurs all videos so YouTube displays completely normally.
 * 5. Robust Classification: Awaits backend classification and applies blur according to session mode.
 * 6. Fallback Error Handling: Employs timeouts & clear logging so YouTube feed never freezes on error.
 */

(function () {
  'use strict';

  // Strict Domain Isolation: Ensure YouTube scraper ONLY executes on youtube.com
  if (typeof window !== 'undefined' && window.location) {
    if (!window.location.hostname.includes('youtube.com')) {
      return;
    }
  }

  // Prevent multiple injections in same tab
  if (typeof window !== 'undefined' && window.__yt_ai_focus_content_initialized__) {
    return;
  }
  if (typeof window !== 'undefined') {
    window.__yt_ai_focus_content_initialized__ = true;
  }

  // Configuration & State
  const REQUEST_TIMEOUT_MS = 6000; // 6-second timeout before fail-open fallback
  const videoCategoryCache = new Map(); // videoId / url -> 'productive' | 'non-productive'
  const videoCache = new Map(); // cacheKey -> 'blur' | 'keep' for backward compatibility
  let youtubeFilterEnabled = true;
  let currentMode = 'productive'; // 'productive' | 'non-productive'
  let activeGoal = '';
  let isScanningScheduled = false;

  // Modern YouTube video card container selectors
  const VIDEO_CONTAINER_SELECTORS = [
    'ytd-rich-item-renderer',       // Home page video grid cards
    'ytd-video-renderer',           // Search results & subscription feed
    'ytd-compact-video-renderer',   // Watch page sidebar recommendations
    'ytd-grid-video-renderer',      // Channel page video grid
    'ytd-reel-item-renderer',       // Shorts carousel items
    'ytd-rich-grid-media',          // Modern nested media
    'yt-lockup-view-model'          // WebComponent lockup model
  ].join(', ');

  /**
   * Injects core blur styles and floating toggle styles into document <head>.
   * NOTE: Hover-peek is strictly omitted from YouTube so blurred videos remain blurred.
   */
  function injectStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('yt-ai-focus-styles')) return;

    const styleEl = document.createElement('style');
    styleEl.id = 'yt-ai-focus-styles';
    styleEl.textContent = `
      .ai-focus-transition {
        transition: filter 0.4s ease-in-out, opacity 0.4s ease-in-out !important;
      }
      .ai-focus-blurred {
        filter: blur(15px) !important;
        opacity: 0.4 !important;
        pointer-events: none !important;
        user-select: none !important;
        cursor: default !important;
        transition: filter 0.4s ease-in-out, opacity 0.4s ease-in-out !important;
      }

      /* Floating Switcher Pill */
      #yt-ai-floating-pill {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        background: rgba(24, 24, 36, 0.94);
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
    `;

    const parent = document.head || document.documentElement;
    if (parent) {
      parent.appendChild(styleEl);
    }
  }

  /**
   * Displays or updates the on-screen floating UI toggle in the bottom corner.
   * ONLY renders if master switch (youtubeFilterEnabled) is ON in Chrome storage.
   */
  function renderFloatingPill() {
    if (!youtubeFilterEnabled) {
      removeFloatingPill();
      return;
    }

    let pill = document.getElementById('yt-ai-floating-pill');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'yt-ai-floating-pill';
      pill.title = 'Click to switch focus mode';
      pill.addEventListener('click', () => {
        const nextMode = currentMode === 'productive' ? 'non-productive' : 'productive';
        currentMode = nextMode;
        try {
          chrome.storage?.local?.set?.({ activeMode: nextMode, youtubeMode: nextMode });
        } catch (_) {}
        renderFloatingPill();
        reapplyFilterToAllElements();
      });

      const parent = document.body || document.documentElement;
      if (parent) {
        parent.appendChild(pill);
      } else {
        setTimeout(renderFloatingPill, 50);
        return;
      }
    }

    const modeLabel = currentMode === 'productive' ? 'Productive' : 'Non-Productive';
    const dotClass = currentMode === 'productive' ? 'productive' : 'non-productive';

    pill.innerHTML = `
      <span class="yt-ai-pill-dot ${dotClass}"></span>
      <span>Focus: ${modeLabel}</span>
      <span class="yt-ai-switch-tag">Switch ⇄</span>
    `;
  }

  /**
   * Completely removes the on-screen floating UI toggle when master switch is OFF
   */
  function removeFloatingPill() {
    const pill = document.getElementById('yt-ai-floating-pill');
    if (pill) {
      pill.remove();
    }
  }

  /**
   * Determines whether a video category should be blurred based on master switch and active mode.
   *
   * @param {string} category - 'productive' | 'non-productive'
   * @returns {boolean} True if video card should be blurred; false to keep visible
   */
  function shouldBlurCategory(category) {
    // If master filter is OFF, nothing is blurred
    if (!youtubeFilterEnabled) return false;

    // Requirement 3: When switched to "Non-Productive Mode", NOTHING should be blurred!
    if (currentMode === 'non-productive') {
      return false;
    }

    // In Productive Mode, blur non-productive distractions, keep productive content visible
    // If category is unknown, pending, or on error: returns false (keep visible)
    return category === 'non-productive';
  }

  /**
   * Disables all blur on YouTube and restores standard feed display
   */
  function disableYouTubeFilter() {
    if (typeof document === 'undefined') return;

    const blurredElements = document.querySelectorAll('.ai-focus-blurred, [data-ai-blurred]');
    blurredElements.forEach((el) => {
      el.classList.remove('ai-focus-blurred');
      el.removeAttribute('data-ai-blurred');
    });
  }

  /**
   * Reapplies visibility filter to all video card elements currently on the page
   */
  function reapplyFilterToAllElements() {
    if (typeof document === 'undefined') return;

    // Requirement 3: When switched to "Non-Productive Mode" or if master switch is OFF, NOTHING should be blurred!
    if (!youtubeFilterEnabled || currentMode === 'non-productive') {
      disableYouTubeFilter();
      return;
    }

    const containers = document.querySelectorAll(VIDEO_CONTAINER_SELECTORS);
    containers.forEach((container) => {
      const metadata = extractVideoMetadata(container);
      const cacheKey = metadata?.id || metadata?.url || metadata?.title;

      if (cacheKey && videoCategoryCache.has(cacheKey)) {
        const category = videoCategoryCache.get(cacheKey);
        const shouldBlur = shouldBlurCategory(category);
        executeBlurLogic(container, shouldBlur);
      } else {
        // Uncategorized or pending: default to visible (keep unblurred)
        executeBlurLogic(container, false);
      }
    });
  }

  /**
   * Dynamic Metadata Extraction
   * Broadly extracts all available text data from a YouTube video card element:
   * - title
   * - channel name
   * - timestamp (upload date / relative time)
   * - duration (video length)
   * - URL (and video ID)
   * - broad text context (description, view count, badges, raw card text)
   *
   * @param {HTMLElement} card - The YouTube video container element
   * @returns {Object|null} Rich metadata JSON object
   */
  function extractVideoMetadata(card) {
    if (!card) return null;

    // 1. URL and Video ID Extraction
    let url = '';
    let id = '';

    const linkSelectors = [
      'a#video-title-link',
      'a#thumbnail',
      'a#video-title',
      'a.yt-lockup-metadata-view-model__title',
      'a[href*="/watch?v="]',
      'a[href*="/shorts/"]',
      'a[href^="/watch"]'
    ];

    for (const selector of linkSelectors) {
      const el = card.querySelector(selector);
      if (el) {
        const href = el.getAttribute('href') || el.href || '';
        if (href) {
          try {
            const baseOrigin = typeof window !== 'undefined' && window.location ? window.location.origin : 'https://www.youtube.com';
            url = new URL(href, baseOrigin).href;
          } catch (_) {
            url = href;
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
      }
    }

    // 2. Title Extraction
    let title = '';
    const titleSelectors = [
      '#video-title',
      'a#video-title-link',
      'yt-formatted-string#video-title',
      'span#video-title',
      'h3 a',
      '.yt-lockup-metadata-view-model__title',
      'h3.ytd-rich-grid-media a',
      'a#thumbnail'
    ];

    for (const selector of titleSelectors) {
      const el = card.querySelector(selector);
      if (el) {
        title = el.getAttribute('title') ||
                el.textContent ||
                el.getAttribute('aria-label') ||
                '';
        title = title.replace(/\s+/g, ' ').trim();
        if (title) break;
      }
    }

    // 3. Channel Name Extraction
    let channel = '';
    const channelSelectors = [
      'ytd-channel-name #text',
      '#channel-name #text',
      'a.yt-simple-endpoint[href*="/@"]',
      '#channel-name a',
      'ytd-channel-name a',
      '#byline a',
      '#byline-container #text',
      '.yt-lockup-byline-view-model',
      'yt-formatted-string[has-link-only_] a',
      '[itemprop="author"] [itemprop="name"]'
    ];

    for (const selector of channelSelectors) {
      const el = card.querySelector(selector);
      if (el) {
        channel = el.getAttribute('title') ||
                  el.textContent ||
                  el.getAttribute('aria-label') ||
                  '';
        channel = channel.replace(/\s+/g, ' ').trim();
        if (channel) break;
      }
    }

    // 4. Timestamp Extraction (Relative Upload Time / Date)
    let timestamp = '';
    const metaSpans = card.querySelectorAll(
      '#metadata-line span.inline-metadata-item, ytd-video-meta-block #metadata-line span, #metadata-line span, .yt-lockup-metadata-view-model__metadata span, #time-status span, #metadata span'
    );

    for (const span of metaSpans) {
      const text = (span.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      // Identify timestamp patterns
      if (/ago|streamed|premiered|yesterday|hour|day|week|month|year|minute/i.test(text)) {
        timestamp = text;
        break;
      }
    }

    if (!timestamp && metaSpans.length > 1) {
      timestamp = (metaSpans[1].textContent || '').replace(/\s+/g, ' ').trim();
    }

    // 5. Video Length / Duration Extraction
    let duration = '';
    const durationSelectors = [
      'ytd-thumbnail-overlay-time-status-renderer span#text',
      'ytd-thumbnail-overlay-time-status-renderer #text',
      '.badge-shape-wiz__text',
      'span.ytd-thumbnail-overlay-time-status-renderer',
      '#time-status span',
      'badge-shape .badge-shape-wiz__text',
      'span.badge-shape-wiz__text',
      '#overlays #text'
    ];

    for (const selector of durationSelectors) {
      const el = card.querySelector(selector);
      if (el) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text && (/\d+:\d+/.test(text) || /short/i.test(text))) {
          duration = text;
          break;
        }
      }
    }

    // Check for YouTube Shorts indicator
    if (!duration) {
      if (
        card.querySelector('[overlay-style="SHORTS"]') ||
        card.querySelector('a[href*="/shorts/"]') ||
        (card.tagName && card.tagName.toLowerCase().includes('reel'))
      ) {
        duration = 'Short (<1m)';
      }
    }

    // 6. Broad Context Extraction (all available text, description, views)
    let viewCount = '';
    for (const span of metaSpans) {
      const text = (span.textContent || '').replace(/\s+/g, ' ').trim();
      if (/view|watching/i.test(text)) {
        viewCount = text;
        break;
      }
    }

    const descEl = card.querySelector(
      '#description-text, yt-formatted-string.ytd-video-renderer#description-text, .metadata-snippet-container'
    );
    const description = descEl ? (descEl.textContent || '').replace(/\s+/g, ' ').trim() : '';

    // Broadly gather all visible text data from card container to provide AI with maximum context
    const rawCardText = (card.innerText || card.textContent || '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(' | ')
      .slice(0, 600);

    return {
      id: id || '',
      url: url || '',
      title: title || '',
      channel: channel || 'Unknown Channel',
      timestamp: timestamp || 'Unknown Timestamp',
      duration: duration || 'Unknown Duration',
      viewCount: viewCount,
      description: description,
      allText: rawCardText,
      activeGoal: activeGoal || ''
    };
  }

  /**
   * Executes UI blur logic on a video card element.
   * Completely excludes hover-peek on YouTube so blurred videos remain blurred.
   *
   * @param {HTMLElement} container - The YouTube video container
   * @param {boolean} shouldBlur - True to apply blur; false to reveal
   */
  function executeBlurLogic(container, shouldBlur) {
    if (!container) return;

    // Apply blur to child #dismissible for smooth layout rendering, or container fallback
    const target = container.querySelector('#dismissible') || container;
    if (!target || !target.classList) return;

    target.classList.add('ai-focus-transition');

    if (shouldBlur) {
      target.classList.add('ai-focus-blurred');
      target.setAttribute('data-ai-blurred', 'true');
    } else {
      target.classList.remove('ai-focus-blurred');
      target.removeAttribute('data-ai-blurred');
    }
  }

  /**
   * Sends video metadata to the background.js service worker via message passing.
   * Running fetch in the service worker avoids MV3 content-script CORS and frame CSP
   * ("Domains, protocols and ports must match") blocks.
   *
   * @param {Object} metadata - Rich video metadata
   * @returns {Promise<Object>} Backend response { action, category, reason }
   */
  /**
   * Sends video metadata to the background.js service worker via message passing.
   * content.js must ONLY use chrome.runtime.sendMessage to ask background.js to make the Vercel request.
   * Absolutely NO fetch() calls in content.js to avoid MV3 content-script CORS and frame CSP blocks.
   *
   * @param {Object} metadata - Rich video metadata
   * @returns {Promise<Object>} Backend response { action, category, reason }
   */
  async function requestFilterBackend(metadata) {
    // Must ONLY use chrome.runtime.sendMessage to ask background.js to make the Vercel request
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
      return new Promise((resolve) => {
        let responded = false;
        const timer = setTimeout(() => {
          if (!responded) {
            responded = true;
            resolve({ action: 'keep', category: 'productive' });
          }
        }, REQUEST_TIMEOUT_MS);

        try {
          chrome.runtime.sendMessage({
            type: 'FILTER_VIDEO',
            video: metadata
          }, (response) => {
            if (responded) return;
            responded = true;
            if (typeof clearTimeout === 'function') {
              clearTimeout(timer);
            }

            const lastErr = chrome.runtime.lastError;
            if (lastErr) {
              // Requirement 4: On network or communication failure, default to keeping videos visible
              resolve({ action: 'keep', category: 'productive' });
              return;
            }

            if (response && response.success && response.data) {
              resolve(response.data);
            } else if (response && response.data) {
              resolve(response.data);
            } else {
              resolve({ action: 'keep', category: 'productive' });
            }
          });
        } catch (err) {
          if (!responded) {
            responded = true;
            if (typeof clearTimeout === 'function') {
              clearTimeout(timer);
            }
            resolve({ action: 'keep', category: 'productive' });
          }
        }
      });
    }

    // Default to keeping video visible if chrome.runtime is unavailable
    return { action: 'keep', category: 'productive' };
  }

  /**
   * The Handoff:
   * Awaits backend classification via service worker and executes UI blur logic.
   * If master switch is OFF or mode is Non-Productive, skips scraping/blurring entirely.
   *
   * @param {HTMLElement} container - Video card element
   */
  async function processVideoCard(container) {
    if (!container) return;

    // Requirement 3: If master filter is turned OFF or Non-Productive mode is active, NOTHING is blurred!
    if (!youtubeFilterEnabled || currentMode === 'non-productive') {
      executeBlurLogic(container, false);
      return;
    }

    // Skip if already in flight or already completed
    if (container.dataset.aiFiltering === 'true' || container.dataset.aiFiltered === 'true') {
      return;
    }

    // Dynamic Metadata Extraction
    const metadata = extractVideoMetadata(container);
    if (!metadata || (!metadata.title && !metadata.url)) {
      return;
    }

    const cacheKey = metadata.id || metadata.url || metadata.title;

    // Check local category cache
    if (videoCategoryCache.has(cacheKey)) {
      const category = videoCategoryCache.get(cacheKey);
      const shouldBlur = shouldBlurCategory(category);
      executeBlurLogic(container, shouldBlur);
      container.dataset.aiFiltered = 'true';
      return;
    }

    // Mark as in-flight (do NOT blur while in-flight: default to visible)
    container.dataset.aiFiltering = 'true';

    try {
      // Correctly await the backend response via service worker message passing
      const result = await requestFilterBackend(metadata);

      // Core classification logic: parse category
      let category = result?.category;
      if (!category) {
        category = result?.action === 'blur' ? 'non-productive' : 'productive';
      }

      // Store in caches
      videoCategoryCache.set(cacheKey, category);
      videoCache.set(cacheKey, result?.action || (category === 'non-productive' ? 'blur' : 'keep'));

      // If master filter was turned OFF or switched to Non-Productive mode while request was in-flight, ensure unblurred!
      if (!youtubeFilterEnabled || currentMode === 'non-productive') {
        executeBlurLogic(container, false);
        return;
      }

      // Execute UI blur logic based on classification and active focus mode
      const shouldBlur = shouldBlurCategory(category);
      executeBlurLogic(container, shouldBlur);
    } catch (error) {
      // Requirement 4: On error, default to keeping videos visible (do not blur everything)
      executeBlurLogic(container, false);
    } finally {
      container.dataset.aiFiltering = 'false';
      container.dataset.aiFiltered = 'true';
    }
  }

  /**
   * Scans all video cards currently present in the YouTube DOM.
   * Pauses completely if master switch is OFF or if in Non-Productive mode.
   */
  function scanFeed() {
    if (typeof document === 'undefined') return;

    // If master filter is OFF or in Non-Productive mode: nothing should be blurred!
    if (!youtubeFilterEnabled) {
      removeFloatingPill();
      disableYouTubeFilter();
      return;
    }

    if (currentMode === 'non-productive') {
      disableYouTubeFilter();
      return;
    }

    const containers = document.querySelectorAll(VIDEO_CONTAINER_SELECTORS);
    for (const container of containers) {
      if (container.dataset.aiFiltered !== 'true' && container.dataset.aiFiltering !== 'true') {
        processVideoCard(container);
      }
    }
  }

  /**
   * Debounced scanning using requestAnimationFrame to maintain smooth scrolling performance.
   * Pauses completely if master switch is OFF or if in Non-Productive mode.
   */
  function scheduleScan() {
    if (!youtubeFilterEnabled || currentMode === 'non-productive') {
      if (typeof document !== 'undefined') {
        disableYouTubeFilter();
      }
      return; // Paused!
    }

    if (isScanningScheduled) return;
    isScanningScheduled = true;

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        isScanningScheduled = false;
        scanFeed();
      });
    } else {
      setTimeout(() => {
        isScanningScheduled = false;
        scanFeed();
      }, 100);
    }
  }

  /**
   * Initializes the content script
   */
  function init() {
    injectStyles();

    // Load active settings from storage
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
        chrome.storage.local.get([
          'youtubeFilterEnabled',
          'activeMode',
          'youtubeMode',
          'activeGoal',
          'videoCategories'
        ], (data) => {
          if (data?.youtubeFilterEnabled !== undefined) {
            youtubeFilterEnabled = Boolean(data.youtubeFilterEnabled);
          } else {
            youtubeFilterEnabled = true;
          }

          if (data?.activeMode || data?.youtubeMode) {
            currentMode = (data.activeMode || data.youtubeMode) === 'non-productive' ? 'non-productive' : 'productive';
          }
          if (data?.activeGoal) {
            activeGoal = data.activeGoal;
          }
          if (data?.videoCategories && typeof data.videoCategories === 'object') {
            for (const [id, category] of Object.entries(data.videoCategories)) {
              videoCategoryCache.set(id, category);
              videoCache.set(id, category === 'productive' ? 'keep' : 'blur');
            }
          }

          // On-Screen UI & Scraping Sync based on Master Switch & Active Mode
          if (!youtubeFilterEnabled) {
            removeFloatingPill();
            disableYouTubeFilter();
          } else if (currentMode === 'non-productive') {
            renderFloatingPill();
            disableYouTubeFilter();
          } else {
            renderFloatingPill();
            scheduleScan();
          }
        });

        // Listen for storage changes
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local') {
            if (changes.youtubeFilterEnabled !== undefined) {
              youtubeFilterEnabled = changes.youtubeFilterEnabled.newValue !== false;
              if (!youtubeFilterEnabled) {
                removeFloatingPill();
                disableYouTubeFilter();
              } else {
                renderFloatingPill();
                reapplyFilterToAllElements();
                if (currentMode === 'productive') scheduleScan();
              }
            }
            if (changes.activeMode !== undefined || changes.youtubeMode !== undefined) {
              const newMode = (changes.activeMode?.newValue || changes.youtubeMode?.newValue);
              if (newMode) {
                currentMode = newMode === 'non-productive' ? 'non-productive' : 'productive';
                if (youtubeFilterEnabled) {
                  renderFloatingPill();
                  reapplyFilterToAllElements();
                  if (currentMode === 'productive') scheduleScan();
                }
              }
            }
            if (changes.activeGoal) {
              activeGoal = changes.activeGoal.newValue || '';
              videoCategoryCache.clear();
              videoCache.clear();
              if (typeof document !== 'undefined') {
                const containers = document.querySelectorAll(VIDEO_CONTAINER_SELECTORS);
                containers.forEach((c) => {
                  delete c.dataset.aiFiltered;
                  delete c.dataset.aiFiltering;
                });
              }
              if (youtubeFilterEnabled && currentMode === 'productive') {
                scheduleScan();
              }
            }
          }
        });

        // Listen for runtime messages directly from popup
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
          if (message.type === 'TOGGLE_YOUTUBE_FILTER') {
            youtubeFilterEnabled = message.enabled !== false;
            if (!youtubeFilterEnabled) {
              removeFloatingPill();
              disableYouTubeFilter();
            } else {
              renderFloatingPill();
              reapplyFilterToAllElements();
              if (currentMode === 'productive') scheduleScan();
            }
            sendResponse({ status: 'ok', enabled: youtubeFilterEnabled });
          } else if (message.type === 'SET_YOUTUBE_MODE') {
            currentMode = message.mode === 'non-productive' ? 'non-productive' : 'productive';
            if (youtubeFilterEnabled) {
              renderFloatingPill();
              reapplyFilterToAllElements();
              if (currentMode === 'productive') scheduleScan();
            }
            sendResponse({ status: 'ok', mode: currentMode });
          } else if (message.type === 'VIDEOS_CATEGORIZED' && message.categories) {
            for (const [id, cat] of Object.entries(message.categories)) {
              videoCategoryCache.set(id, cat);
            }
            if (youtubeFilterEnabled && currentMode === 'productive') {
              reapplyFilterToAllElements();
            }
          }
        });
      }
    } catch (_) {}

    // Initialize MutationObserver for YouTube infinite scrolling (pauses when master toggle is OFF or in non-productive mode)
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      const observer = new MutationObserver(() => {
        if (!youtubeFilterEnabled || currentMode === 'non-productive') return; // Paused!
        scheduleScan();
      });

      const observeTarget = document.body || document.documentElement;
      if (observeTarget) {
        observer.observe(observeTarget, {
          childList: true,
          subtree: true
        });
      } else {
        window.addEventListener('DOMContentLoaded', () => {
          observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
          });
        });
      }
    }

    // YouTube SPA navigation listener
    if (typeof window !== 'undefined') {
      window.addEventListener('yt-navigate-finish', () => {
        if (!youtubeFilterEnabled || currentMode === 'non-productive') return; // Paused!
        scheduleScan();
      });
    }

    // Initial scans if enabled and in productive mode
    if (youtubeFilterEnabled && currentMode === 'productive') {
      scheduleScan();
      setTimeout(scheduleScan, 500);
      setTimeout(scheduleScan, 1500);
    } else {
      disableYouTubeFilter();
    }
  }

  // Start execution if in browser
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // Export functions for testability in Node / automated testing suites
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      extractVideoMetadata,
      processVideoCard,
      executeBlurLogic,
      requestFilterBackend,
      renderFloatingPill,
      removeFloatingPill,
      shouldBlurCategory,
      disableYouTubeFilter,
      reapplyFilterToAllElements,
      videoCategoryCache,
      videoCache,
      REQUEST_TIMEOUT_MS
    };
  }
})();
