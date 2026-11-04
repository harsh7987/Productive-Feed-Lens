/**
 * linkedin.js - Content script for LinkedIn AI Focus
 *
 * Strict Architecture:
 * 1. Strict 3-Tier Logic:
 *    - 'Non-Productive': ALWAYS blurred.
 *    - 'Neutral': Blurred if UI toggle is OFF (!showNeutralPosts); visible if toggle is ON.
 *    - 'Productive': NEVER blurred.
 * 2. Infinite Scroll:
 *    - Wrapped in a 3000ms setInterval starting after initial 4000ms React hydration timeout.
 *    - Searches for child action anchors ('Like', 'Comment', 'Repost') and traverses up to the parent container.
 *    - Marks processed containers with data-ai-scanned="true" to continuously process new posts on scroll.
 * 3. Actual Post Text Extraction:
 *    - Targets actual post content elements (e.g. '.update-components-text', '.feed-shared-update-v2__commentary').
 *    - Completely filters out literal fallback UI noise like "Feed post".
 * 4. Hover to Peek:
 *    - Applies element.style.filter = 'blur(15px)' directly to blurred containers.
 *    - Attaches mouseenter listener to drop blur to 'blur(0px)', mouseleave to restore 'blur(15px)'.
 * 5. No DOM Injection:
 *    - Absolutely zero structural DOM changes. Zero <style> tags, zero UI icons, zero images.
 *    - Modifies strictly the inline style property of existing LinkedIn containers.
 * 6. Network Request Architecture:
 *    - Uses chrome.runtime.sendMessage to background.js service worker (same as YouTube).
 *    - Zero direct fetch() calls to bypass MV3 content-script CORS and frame CSP blocks.
 *    - Fallback error handling so feed never breaks or freezes on network timeout.
 */

(function () {
  'use strict';

  // Strict Domain Isolation: Ensure LinkedIn-specific logic ONLY executes on linkedin.com
  if (typeof window !== 'undefined' && window.location) {
    if (!window.location.hostname.includes('linkedin.com')) {
      return;
    }
  }

  const SCAN_INTERVAL_MS = 3000;
  const REQUEST_TIMEOUT_MS = 6000;
  let executionStarted = false;
  let isScanning = false;
  let showNeutralPosts = true;

  const localCache = new Map(); // postId -> { category: string, reason: string }
  const pendingRequests = new Set(); // postIds dispatched to background
  const postElementMap = new Map(); // postId -> Set of matched post HTMLElements

  /**
   * Execution Timing:
   * Waits for the window 'load' event, then delays execution by a strict 4000ms
   * to guarantee React hydration has completely settled before touching the DOM.
   */
  function scheduleDelayedStart() {
    function onWindowLoaded() {
      setTimeout(startLinkedInFocus, 4000);
    }

    if (typeof document !== 'undefined') {
      if (document.readyState === 'complete') {
        onWindowLoaded();
      } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('load', onWindowLoaded, { once: true });
      }
    }
  }

  // Absolutely NO DOM manipulation before this delayed initialization completes
  scheduleDelayedStart();

  /**
   * Normalizes category labels into 'Productive', 'Neutral', or 'Non-Productive'
   */
  function normalizeCategory(label) {
    if (!label) return 'Non-Productive';
    if (typeof label === 'object' && label !== null) {
      label = label.category || label.label || '';
    }
    const str = String(label).toLowerCase().trim();
    if (str.includes('non') || str === 'blur') return 'Non-Productive';
    if (str.includes('neut')) return 'Neutral';
    if (str.includes('prod') || str === 'keep') return 'Productive';
    return 'Non-Productive';
  }

  /**
   * Strict 3-Tier Logic:
   * - 'Non-Productive': ALWAYS blur
   * - 'Neutral': Blur if UI toggle is OFF (!showNeutralPosts); do NOT blur if toggle is ON
   * - 'Productive': NEVER blur
   */
  function shouldBlur(label) {
    const norm = normalizeCategory(label);
    if (norm === 'Non-Productive') {
      return true;
    }
    if (norm === 'Neutral') {
      return !showNeutralPosts;
    }
    return false;
  }

  /**
   * Hover to Peek & Inline Blur:
   * - Applies element.style.filter = 'blur(15px)' directly
   * - Attaches mouseenter listener to drop blur to 'blur(0px)'
   * - Attaches mouseleave listener to restore 'blur(15px)'
   * - No structural DOM injection, no <style> tags, no custom icons
   */
  function applyPostVisibility(post, label) {
    const elementNode = typeof Node !== 'undefined' ? Node.ELEMENT_NODE : 1;
    if (!post || post.nodeType !== elementNode) return;

    try {
      const blur = shouldBlur(label);

      // Attach mouseenter and mouseleave listeners once per parent container
      if (!post.dataset.aiHoverAttached && typeof post.addEventListener === 'function') {
        post.dataset.aiHoverAttached = 'true';
        post.style.transition = 'filter 0.3s ease-in-out, opacity 0.3s ease-in-out';

        post.addEventListener('mouseenter', () => {
          post.dataset.isHovered = 'true';
          if (post.dataset.aiBlurred === 'true') {
            post.style.filter = 'blur(0px)';
            post.style.opacity = '1';
          }
        });

        post.addEventListener('mouseleave', () => {
          post.dataset.isHovered = 'false';
          if (post.dataset.aiBlurred === 'true') {
            post.style.filter = 'blur(15px)';
            post.style.opacity = '0.4';
          }
        });
      }

      if (blur) {
        post.dataset.aiBlurred = 'true';
        post.style.cursor = 'pointer';

        // Strictly check hover state before applying blur
        if (post.dataset.isHovered !== 'true') {
          post.style.filter = 'blur(15px)';
          post.style.opacity = '0.4';
        }
      } else {
        post.dataset.aiBlurred = 'false';
        post.style.filter = 'none';
        post.style.opacity = '1';
        post.style.cursor = 'default';
      }
    } catch (_) {}
  }

  /**
   * Anchor Traversal: Searches DOM for interactive elements targeting child elements (likes/comments/reposts)
   */
  function findActionAnchors() {
    if (typeof document === 'undefined') return [];
    const anchors = [];
    const candidates = document.querySelectorAll('button, [role="button"], span, a');
    const elementNode = typeof Node !== 'undefined' ? Node.ELEMENT_NODE : 1;

    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!el || el.nodeType !== elementNode) continue;

      const text = (el.innerText || el.textContent || '').trim();
      const aria = el.getAttribute ? (el.getAttribute('aria-label') || '').trim() : '';

      const isLike = text === 'Like' || text.includes('Like') || aria === 'Like' || aria.includes('Like');
      const isComment = text === 'Comment' || text.includes('Comment') || aria === 'Comment' || aria.includes('Comment');
      const isRepost = text === 'Repost' || text.includes('Repost') || aria === 'Repost' || aria.includes('Repost');

      if (isLike || isComment || isRepost) {
        anchors.push(el);
      }
    }

    return anchors;
  }

  /**
   * Find Parent: Traverses up the DOM tree from anchor to locate the outermost post container.
   */
  function findPostContainer(anchor) {
    const elementNode = typeof Node !== 'undefined' ? Node.ELEMENT_NODE : 1;
    if (!anchor || anchor.nodeType !== elementNode) return null;

    // 1. Traverse up using standard post container selectors
    let container = anchor.closest ? anchor.closest(
      '.feed-shared-update-v2, .occludable-update, .artdeco-card, [data-urn^="urn:li:activity:"], [data-view-name*="feed-full-update"]'
    ) : null;

    // If an inner container was matched, climb to outer wrapper if present
    if (container) {
      const outerWrapper = container.parentElement?.closest ? container.parentElement.closest(
        '.feed-shared-update-v2, .occludable-update, .artdeco-card, [data-urn^="urn:li:activity:"], [data-view-name*="feed-full-update"]'
      ) : null;
      if (outerWrapper) {
        container = outerWrapper;
      }
      return container;
    }

    // 2. Fallback: climb up parent hierarchy looking for card boundaries or data-urn
    let current = anchor.parentElement;
    for (let depth = 0; depth < 8; depth++) {
      if (!current || (typeof document !== 'undefined' && (current === document.body || current === document.documentElement))) break;

      if (
        (current.getAttribute && current.getAttribute('data-urn')) ||
        (current.classList && current.classList.contains('artdeco-card')) ||
        (current.classList && current.classList.contains('occludable-update')) ||
        (current.classList && current.classList.contains('feed-shared-update-v2'))
      ) {
        return current;
      }
      current = current.parentElement;
    }

    // 3. Fallback: fixed parent climb (5 levels)
    let fallback = anchor;
    for (let d = 0; d < 5; d++) {
      if (fallback.parentElement && (typeof document !== 'undefined' ? fallback.parentElement !== document.body : true)) {
        fallback = fallback.parentElement;
      }
    }
    return fallback !== anchor ? fallback : null;
  }

  /**
   * Extracts post ID directly from data-urn or deterministic innerText hash.
   * Never inspects image src or child anchor tags.
   */
  function extractPostId(post, textContent) {
    if (!post) return null;

    try {
      const urn =
        (post.getAttribute && post.getAttribute('data-urn')) ||
        post.querySelector?.('[data-urn]')?.getAttribute?.('data-urn') ||
        (post.getAttribute && post.getAttribute('data-id')) ||
        post.querySelector?.('[data-id]')?.getAttribute?.('data-id') ||
        '';

      if (urn) {
        const match = urn.match(/urn:li:(?:activity|ugcPost|share):([0-9]+)/);
        if (match && match[1]) return match[1];
        return urn;
      }

      const text = textContent || (post.innerText || post.textContent || '').trim();
      if (text && text.length > 20) {
        return 'li_' + simpleHash(text.slice(0, 100));
      }
    } catch (_) {}

    return null;
  }

  /**
   * Extracts the actual post content from the LinkedIn container.
   * Successfully grabs post text from elements like '.update-components-text'
   * or '.feed-shared-update-v2__commentary', preventing the literal fallback string "Feed post"
   * from being sent to Vercel.
   *
   * @param {HTMLElement} post - The parent LinkedIn post container
   * @returns {string} The actual post body text
   */
  function extractPostText(post) {
    if (!post) return '';

    // High priority LinkedIn post text selectors
    const contentSelectors = [
      '.update-components-text',
      '.feed-shared-update-v2__commentary',
      '.feed-shared-inline-show-more-text',
      '.feed-shared-text-view',
      '.feed-shared-text',
      '.update-components-update-v2__commentary',
      'div[data-ad-preview="message"]',
      'span.break-words'
    ];

    for (const selector of contentSelectors) {
      try {
        const el = post.querySelector ? post.querySelector(selector) : null;
        if (el) {
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          // Ensure it's not the literal fallback "Feed post" or empty
          if (text && text.length > 5 && !/^feed post$/i.test(text)) {
            return text;
          }
        }
      } catch (_) {}
    }

    // Fallback: extract from container innerText, filtering out UI noise like "Feed post"
    try {
      const rawText = (post.innerText || post.textContent || '').trim();
      const cleaned = rawText
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => {
          if (!s) return false;
          if (/^feed post$/i.test(s)) return false;
          if (/^(like|comment|repost|send|share)$/i.test(s)) return false;
          return true;
        })
        .join(' ');

      if (cleaned && cleaned.length > 5 && !/^feed post$/i.test(cleaned)) {
        return cleaned;
      }
    } catch (_) {}

    return '';
  }

  /**
   * Extracts the author name from the LinkedIn container.
   *
   * @param {HTMLElement} post
   * @returns {string}
   */
  function extractPostAuthor(post) {
    if (!post) return 'LinkedIn Member';

    const authorSelectors = [
      '.update-components-actor__name span[aria-hidden="true"]',
      '.update-components-actor__name',
      '.feed-shared-actor__name span[aria-hidden="true"]',
      '.feed-shared-actor__name',
      '.update-components-actor__title span[aria-hidden="true"]',
      '.update-components-actor__title',
      '.feed-shared-actor__title'
    ];

    for (const selector of authorSelectors) {
      try {
        const el = post.querySelector ? post.querySelector(selector) : null;
        if (el) {
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (text && text.length > 1 && text.length < 100 && !/^feed post$/i.test(text)) {
            return text;
          }
        }
      } catch (_) {}
    }

    return 'LinkedIn Member';
  }

  /**
   * Sends LinkedIn post metadata to the background.js service worker via message passing.
   * Running fetch in the service worker bypasses MV3 content-script CORS and frame CSP
   * ("Domains, protocols and ports must match") blocks.
   * Completely removes any direct fetch() calls from linkedin.js.
   *
   * @param {Object} data - LinkedIn post metadata
   * @returns {Promise<Object>} Backend response { action, category, reason }
   */
  async function requestFilterBackend(data) {
    // Must ONLY use chrome.runtime.sendMessage to ask background.js to make the Vercel request
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
      return new Promise((resolve) => {
        let responded = false;
        const timer = setTimeout(() => {
          if (!responded) {
            responded = true;
            resolve({ action: 'keep', category: 'Productive' });
          }
        }, REQUEST_TIMEOUT_MS);

        try {
          chrome.runtime.sendMessage(
            {
              type: 'FILTER_LINKEDIN_POST',
              platform: 'linkedin',
              post: data,
              data: data
            },
            (response) => {
              if (responded) return;
              responded = true;
              if (typeof clearTimeout === 'function') {
                clearTimeout(timer);
              }

              const lastErr = chrome.runtime.lastError;
              if (lastErr) {
                resolve({ action: 'keep', category: 'Productive' });
                return;
              }

              if (!response || !response.success || !response.data) {
                resolve({ action: 'keep', category: 'Productive' });
                return;
              }

              resolve(response.data);
            }
          );
        } catch (_) {
          if (!responded) {
            responded = true;
            if (typeof clearTimeout === 'function') {
              clearTimeout(timer);
            }
            resolve({ action: 'keep', category: 'Productive' });
          }
        }
      });
    }

    return { action: 'keep', category: 'Productive' };
  }

  /**
   * Processes an individual LinkedIn post via service worker message passing.
   */
  async function processLinkedInPost(post, postId, textContent) {
    const author = extractPostAuthor(post);

    // Build rich metadata payload with actual post text
    const actualText = (textContent || extractPostText(post) || '').replace(/^feed post\s*/i, '').trim();

    // Guard against sending empty or literal fallback string "Feed post"
    if (!actualText || actualText.length < 5 || /^feed post$/i.test(actualText)) {
      pendingRequests.delete(postId);
      return;
    }

    const data = {
      platform: 'linkedin',
      id: postId,
      author: author,
      content: actualText.slice(0, 1000),
      postContent: actualText.slice(0, 1000),
      body: actualText.slice(0, 1000)
    };

    try {
      const filterDecision = await requestFilterBackend(data);
      pendingRequests.delete(postId);

      let category = normalizeCategory(
        filterDecision?.category || (filterDecision?.action === 'blur' ? 'Non-Productive' : 'Productive')
      );
      let reason = filterDecision?.reason || '';

      localCache.set(postId, { category, reason });

      // Persist to chrome.storage.local
      try {
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          const stored = await chrome.storage.local.get(['linkedinCategories']);
          const currentCats = stored.linkedinCategories || {};
          currentCats[postId] = { category, reason };
          await chrome.storage.local.set({ linkedinCategories: currentCats });
        }
      } catch (_) {}

      // Apply visibility to all elements associated with this postId
      const elements = postElementMap.get(postId);
      if (elements && typeof elements.forEach === 'function') {
        elements.forEach((el) => {
          if (el && el.isConnected !== false) {
            applyPostVisibility(el, category);
          }
        });
      } else {
        applyPostVisibility(post, category);
      }
    } catch (_) {
      pendingRequests.delete(postId);
      applyPostVisibility(post, 'Productive');
    }
  }

  /**
   * Main Feed Scanner:
   * - Discovers post containers via targeting child action anchors (likes/comments/reposts) & Parent Finding.
   * - Deduplicates via data-ai-scanned="true" attribute.
   * - Continually processes new posts as the user scrolls on infinite scroll (3000ms interval).
   */
  function scanLinkedInFeed() {
    if (typeof chrome !== 'undefined' && !chrome.runtime?.id) {
      if (typeof window !== 'undefined' && window.__linkedin_interval__) {
        clearInterval(window.__linkedin_interval__);
        window.__linkedin_interval__ = null;
      }
      return;
    }

    if (isScanning) return;
    isScanning = true;

    try {
      // 1. Anchor Traversal: Find interactive child elements with 'Like', 'Comment', or 'Repost'
      const anchors = findActionAnchors();

      // 2. Find Parent: Locate outermost post container for each matched anchor
      const postContainers = [];
      const seenThisRun = new Set();
      const elementNode = typeof Node !== 'undefined' ? Node.ELEMENT_NODE : 1;

      for (let i = 0; i < anchors.length; i++) {
        const anchor = anchors[i];
        const container = findPostContainer(anchor);
        if (!container || !container.classList) continue;

        if (!seenThisRun.has(container)) {
          seenThisRun.add(container);
          postContainers.push(container);
        }
      }

      if (postContainers.length === 0) return;

      for (let i = 0; i < postContainers.length; i++) {
        const post = postContainers[i];
        if (!post || post.nodeType !== elementNode) continue;

        // Grab actual post text from specific content selectors or cleaned container text
        const actualText = extractPostText(post);
        if (!actualText || actualText.length <= 15 || /^feed post$/i.test(actualText)) {
          // If content is not yet hydrated in DOM or is literal fallback "Feed post", wait for next scan
          continue;
        }

        const postId = extractPostId(post, actualText);
        if (!postId) continue;

        // In-memory mapping of postId -> HTMLElement
        if (!postElementMap.has(postId)) {
          postElementMap.set(postId, new Set());
        }
        postElementMap.get(postId).add(post);

        // If previously categorized, re-apply visibility immediately
        if (localCache.has(postId)) {
          const cached = localCache.get(postId);
          applyPostVisibility(post, cached.category || cached);
          continue;
        }

        // Deduplication: Check if already scanned
        const isScanned = post.getAttribute && post.getAttribute('data-ai-scanned') === 'true';
        if (isScanned) {
          continue;
        }

        // Mark processed container with data-ai-scanned="true" to prevent redundant re-evaluations
        if (typeof post.setAttribute === 'function') {
          post.setAttribute('data-ai-scanned', 'true');
        }

        if (!pendingRequests.has(postId)) {
          pendingRequests.add(postId);
          processLinkedInPost(post, postId, actualText);
        }
      }
    } catch (_) {
    } finally {
      isScanning = false;
    }
  }

  /**
   * Re-evaluates visibility on all known DOM elements when settings change (e.g. Neutral toggle).
   */
  function reapplyFilterToAllElements() {
    try {
      for (const [postId, elements] of postElementMap.entries()) {
        const cached = localCache.get(postId);
        const category = typeof cached === 'object' && cached !== null ? cached.category : cached;
        if (elements && typeof elements.forEach === 'function') {
          elements.forEach((post) => {
            if (post && post.isConnected !== false) {
              applyPostVisibility(post, category);
            }
          });
        }
      }
    } catch (_) {}
  }

  /**
   * Fast deterministic hash for fallback IDs
   */
  function simpleHash(str) {
    if (!str || typeof str !== 'string') return '0';
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Delayed start execution: runs strictly inside this function after the 4000ms post-load timer
   */
  async function startLinkedInFocus() {
    if (executionStarted) return;
    executionStarted = true;

    // Clean up any interval from earlier extension reload
    if (typeof window !== 'undefined' && window.__linkedin_interval__) {
      clearInterval(window.__linkedin_interval__);
      window.__linkedin_interval__ = null;
    }

    if (typeof chrome !== 'undefined' && !chrome.runtime?.id) {
      return;
    }

    // 1. Load cached classifications and settings from storage
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const stored = await chrome.storage.local.get(['linkedinCategories', 'linkedinShowNeutral']);
        if (stored.linkedinShowNeutral !== undefined) {
          showNeutralPosts = Boolean(stored.linkedinShowNeutral);
        }
        if (stored.linkedinCategories && typeof stored.linkedinCategories === 'object') {
          for (const [id, val] of Object.entries(stored.linkedinCategories)) {
            if (typeof val === 'object' && val !== null) {
              localCache.set(id, {
                category: normalizeCategory(val.category || val.label),
                reason: val.reason || ''
              });
            } else {
              localCache.set(id, {
                category: normalizeCategory(val),
                reason: ''
              });
            }
          }
        }
      }
    } catch (_) {}

    // 2. Listen for storage changes from popup or background (e.g. Neutral toggle changes)
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (!chrome.runtime?.id) return;
          if (area === 'local') {
            let shouldReapply = false;
            if (changes.linkedinShowNeutral) {
              showNeutralPosts = changes.linkedinShowNeutral.newValue !== false;
              shouldReapply = true;
            }
            if (changes.linkedinCategories) {
              if (changes.linkedinCategories.newValue && Object.keys(changes.linkedinCategories.newValue).length > 0) {
                for (const [id, val] of Object.entries(changes.linkedinCategories.newValue)) {
                  if (typeof val === 'object' && val !== null) {
                    localCache.set(id, {
                      category: normalizeCategory(val.category || val.label),
                      reason: val.reason || ''
                    });
                  } else {
                    localCache.set(id, {
                      category: normalizeCategory(val),
                      reason: ''
                    });
                  }
                }
              } else {
                localCache.clear();
                pendingRequests.clear();
              }
              shouldReapply = true;
            }
            if (shouldReapply) {
              reapplyFilterToAllElements();
            }
          }
        });
      }
    } catch (_) {}

    // 3. Initial scan & Continuous Infinite Scroll: setInterval firing every 3000ms
    scanLinkedInFeed();
    if (typeof window !== 'undefined' && typeof setInterval === 'function') {
      const intervalId = setInterval(scanLinkedInFeed, SCAN_INTERVAL_MS);
      window.__linkedin_interval__ = intervalId;
    }
  }

  // Export helpers for unit testing environments
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      findActionAnchors,
      findPostContainer,
      extractPostId,
      extractPostText,
      extractPostAuthor,
      applyPostVisibility,
      shouldBlur,
      normalizeCategory,
      requestFilterBackend,
      processLinkedInPost,
      scanLinkedInFeed,
      reapplyFilterToAllElements,
      startLinkedInFocus
    };
  }
})();
