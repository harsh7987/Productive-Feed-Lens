/**
 * background.js - Service Worker for YouTube AI Focus (OpenAI)
 *
 * Responsibilities:
 * 1. Receives video titles and IDs from content.js.
 * 2. Batches requests for 500ms to minimize API calls and avoid rate-limiting.
 * 3. Sends batched titles to OpenAI Chat Completions API (gpt-4.1-mini) in native JSON mode.
 * 4. Strictly includes Content-Type and Authorization Bearer headers.
 * 5. Places strict productivity filter system instruction in messages array.
 * 6. Enforces response_format: { type: 'json_object' } for pure JSON output.
 * 7. Directly reads data.choices[0].message.content before JSON.parse().
 * 8. Caches results in chrome.storage.local and broadcasts to content scripts to un-hide matching videos.
 */

const BATCH_INTERVAL_MS = 500;
const DEFAULT_BACKEND_ENDPOINT = 'https://youtube-ai-focus.vercel.app/api/filter';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MODEL_ID = 'gpt-4o-mini';

const videoQueue = new Map(); // videoId -> { id, title, channel, duration }
let batchTimer = null;
let currentSessionMode = 'productive';

// Clean up legacy keys from storage - extension holds zero secrets
try {
  chrome.storage.local.remove(['distractionCount', 'distractionCountDate']);
  chrome.storage.local.get(['backendUrl'], (data) => {
    if (data?.backendUrl && !data.backendUrl.endsWith('/api/filter')) {
      chrome.storage.local.remove(['backendUrl']);
    }
  });
} catch (_) {}

// Listen for messages from content scripts (YouTube & LinkedIn) or options page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  // 1. Single item filtering proxy (MV3 service-worker bypass for content-script CORS/CSP for YouTube & LinkedIn)
  if (
    message.type === 'FILTER_VIDEO' ||
    message.type === 'CLASSIFY_VIDEO' ||
    message.type === 'FILTER_POST' ||
    message.type === 'FILTER_LINKEDIN_POST' ||
    (message.platform === 'linkedin' && (message.post || message.data))
  ) {
    const payloadData = message.video || message.post || message.data || message.metadata;
    handleFilterVideoMessage(payloadData, sendResponse);
    return true; // Keep port open for async response
  }

  // 2. Platform Router: Route logic based on request.platform
  if (message.platform === 'linkedin') {
    handleLinkedInRequest(message, sender, sendResponse);
    return true; // Keep message port open for asynchronous response
  }

  // 3. YouTube platform batch handling
  if (message.type === 'CATEGORIZE_VIDEOS') {
    if (message.mode) {
      currentSessionMode = message.mode;
      try {
        chrome.storage.local.set({ activeMode: message.mode });
      } catch (_) {}
    }
    handleIncomingVideos(message.videos);
    sendResponse({ status: 'queued', count: message.videos?.length });
    return false;
  } else if (message && (message.type === 'SET_FOCUS_MODE' || message.type === 'SET_YOUTUBE_MODE')) {
    if (message.mode) {
      currentSessionMode = message.mode;
      try {
        chrome.storage.local.set({ activeMode: message.mode, youtubeMode: message.mode });
      } catch (_) {}
    }
    sendResponse({ status: 'ok', mode: currentSessionMode });
    return false;
  } else if (message && message.type === 'TOGGLE_YOUTUBE_FILTER') {
    if (message.enabled !== undefined) {
      try {
        chrome.storage.local.set({ youtubeFilterEnabled: Boolean(message.enabled) });
      } catch (_) {}
    }
    sendResponse({ status: 'ok', enabled: message.enabled });
    return false;
  } else if (message && message.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ status: 'ok' });
    return false;
  }
  return true;
});

/**
 * Proxies a video filter request to the Vercel backend from the service worker.
 * Running in background.js bypasses MV3 content-script CORS and CSP blocks.
 *
 * @param {Object} videoData - Video metadata object
 * @param {Function} sendResponse - Message reply callback
 */
async function handleFilterVideoMessage(itemData, sendResponse) {
  const isLinkedIn = itemData?.platform === 'linkedin' || Boolean(itemData?.author || itemData?.postContent);

  // Ensure fetch URL is EXACTLY "https://youtube-ai-focus.vercel.app/api/filter"
  const endpoint = 'https://youtube-ai-focus.vercel.app/api/filter';

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(itemData)
    });

    if (!response.ok) {
      throw new Error(`Vercel backend returned HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    sendResponse({ success: true, data: data });
  } catch (error) {
    // Return clean fallback so content script feed does not break
    sendResponse({
      success: false,
      error: error.message,
      data: { action: 'keep', category: isLinkedIn ? 'Productive' : 'productive' }
    });
  }
}

/**
 * Adds incoming videos to the batch queue and starts 500ms debounce timer
 */
function handleIncomingVideos(videos) {
  if (!Array.isArray(videos) || videos.length === 0) return;

  for (const item of videos) {
    if (item && item.id && item.title && !videoQueue.has(item.id)) {
      videoQueue.set(item.id, {
        id: String(item.id).trim(),
        title: String(item.title).trim(),
        channel: (typeof item.channel === 'string' && item.channel.trim()) ? item.channel.trim() : 'Unknown',
        duration: (typeof item.duration === 'string' && item.duration.trim()) ? item.duration.trim() : 'Unknown'
      });
    }
  }

  // Start 500ms batch timer if not already running
  if (!batchTimer && videoQueue.size > 0) {
    batchTimer = setTimeout(processBatch, BATCH_INTERVAL_MS);
  }
}

/**
 * Processes queued videos in a batch and calls OpenAI API
 */
async function processBatch() {
  batchTimer = null;

  if (videoQueue.size === 0) return;

  // Snapshot queue and clear it for subsequent incoming videos
  const batchItems = Array.from(videoQueue.values());
  videoQueue.clear();

  // 1. Retrieve stored API key and existing cache
  let stored = {};
  try {
    stored = await chrome.storage.local.get([
      'openaiApiKey',
      'apiKey',
      'videoCategories'
    ]);
  } catch (_) {
    stored = {};
  }

  let apiKey = '';
  if (typeof stored.openaiApiKey === 'string' && stored.openaiApiKey.trim().startsWith('sk-')) {
    apiKey = stored.openaiApiKey.trim();
  } else if (typeof stored.apiKey === 'string' && stored.apiKey.trim().startsWith('sk-proj-')) {
    apiKey = stored.apiKey.trim();
  }
  // 1. Before sending a scraped batch of videos to OpenAI, check chrome.storage.local for previously classified videoIds
  const cachedCategories = (stored.videoCategories && typeof stored.videoCategories === 'object') ? stored.videoCategories : {};

  // 2. Immediately apply the cached labels (Productive/Non-Productive) to any known videos and filter them out of the API request payload
  const unseenVideos = [];
  const cachedResults = {};

  for (const item of batchItems) {
    if (cachedCategories[item.id]) {
      cachedResults[item.id] = cachedCategories[item.id];
    } else {
      unseenVideos.push(item);
    }
  }

  // Immediately apply the cached labels to known videos
  if (Object.keys(cachedResults).length > 0) {
    notifyTabs({
      type: 'VIDEOS_CATEGORIZED',
      categories: cachedResults
    });
  }

  // 3. Only send the truly unseen videos to the OpenAI API
  if (unseenVideos.length === 0) {
    return;
  }

  try {
    const newCategories = await callOpenAIAPI(apiKey, unseenVideos);

    // 4. Once OpenAI returns the new classifications, save those new videoIds and their labels back to chrome.storage.local so they are remembered for future sessions
    const updatedCache = { ...cachedCategories, ...newCategories };
    try {
      await chrome.storage.local.set({ videoCategories: updatedCache });
    } catch (_) {}

    // 5. Ensure the final response sent back to content.js seamlessly merges both the cached results and the new API results
    const finalCategories = { ...cachedResults, ...newCategories };

    notifyTabs({
      type: 'VIDEOS_CATEGORIZED',
      categories: finalCategories
    });
  } catch (error) {
    // Fail-safe: default to visible (productive) so videos are never blurred on error
    const fallbackMap = {};
    for (const item of unseenVideos) {
      fallbackMap[item.id] = 'productive';
    }

    const mergedFallback = { ...cachedResults, ...fallbackMap };

    notifyTabs({
      type: 'VIDEOS_CATEGORIZED',
      categories: mergedFallback,
      error: error?.message || 'API classification error'
    });
  }
}

/**
 * Calls OpenAI Chat Completions API with native JSON mode
 * @param {string} apiKey
 * @param {Array<{id: string, title: string, channel?: string, duration?: string}>} videos
 * @returns {Promise<Record<string, 'productive' | 'non-productive'>>}
 */
async function callOpenAIAPI(apiKey, videos) {
  const validVideos = videos.filter(
    (v) => v && typeof v.id === 'string' && v.id.trim() && typeof v.title === 'string' && v.title.trim()
  );
  if (validVideos.length === 0) return {};

  const batch = validVideos.map((v) => ({
    id: String(v.id || '').trim(),
    title: String(v.title || '').trim(),
    channel: (typeof v.channel === 'string' && v.channel.trim()) ? v.channel.trim() : 'Unknown',
    duration: (typeof v.duration === 'string' && v.duration.trim()) ? v.duration.trim() : 'Unknown'
  }));

  // Check local storage for an active goal before making the OpenAI API call
  let activeGoal = '';
  try {
    const storageData = await chrome.storage.local.get(['activeGoal', 'goal', 'focusGoal']);
    if (typeof storageData.activeGoal === 'string' && storageData.activeGoal.trim()) {
      activeGoal = storageData.activeGoal.trim();
    } else if (typeof storageData.goal === 'string' && storageData.goal.trim()) {
      activeGoal = storageData.goal.trim();
    } else if (typeof storageData.focusGoal === 'string' && storageData.focusGoal.trim()) {
      activeGoal = storageData.focusGoal.trim();
    }
  } catch (_) {}

  const STANDARD_SYSTEM_PROMPT =
    'You are a strict productivity filter. Categorize as PRODUCTIVE: coding, software development, science, educational lectures. Categorize as NON-PRODUCTIVE: stand-up comedy, music videos, gaming, podcasts, vlogs, and movies. Rely heavily on the channel name and title to filter out long non-productive content like gaming streams or podcasts. Use video duration as a secondary context clue, specifically using short durations (under 2 minutes) to aggressively filter out memes and low-attention-span clips. You must output ONLY a raw JSON object mapping each Video ID to either "productive" or "non-productive".';

  let systemPrompt = STANDARD_SYSTEM_PROMPT;
  if (activeGoal) {
    systemPrompt = `The user's strict current focus is: ${activeGoal}. Flag any video not directly relevant to this specific topic as non-productive. You must output ONLY a raw JSON object mapping each Video ID to either "productive" or "non-productive".`;
  }

  if (!apiKey) {
    // Ensure fetch URL is EXACTLY "https://youtube-ai-focus.vercel.app/api/filter"
    const endpoint = 'https://youtube-ai-focus.vercel.app/api/filter';

    const resultMap = {};
    for (const v of batch) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: v.id,
            title: v.title,
            channel: v.channel,
            duration: v.duration,
            activeGoal: activeGoal
          })
        });
        if (res.ok) {
          const d = await res.json();
          resultMap[v.id] = (d.action === 'blur' || d.category === 'non-productive') ? 'non-productive' : 'productive';
        } else {
          resultMap[v.id] = 'productive';
        }
      } catch (_) {
        resultMap[v.id] = 'productive';
      }
    }
    return resultMap;
  }

  const authHeader = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;

  const response = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader
    },
    body: JSON.stringify({
      model: MODEL_ID,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: JSON.stringify(batch)
        }
      ],
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let messageText = `OpenAI API error (${response.status}): ${errorBody}`;
    try {
      const parsed = JSON.parse(errorBody);
      if (parsed.error?.message) {
        messageText = `OpenAI API error (${response.status}): ${parsed.error.message}`;
      }
    } catch (_) {}

    const apiError = new Error(messageText);
    apiError.status = response.status;
    apiError.responseBody = errorBody;
    throw apiError;
  }

  const data = await response.json();
  const rawText = data.choices[0].message.content;

  return parseClassificationResponse(rawText, validVideos);
}

/**
 * Parses OpenAI's native JSON mode response into category mapping
 * No regex stripping required since OpenAI guarantees pure JSON
 */
function parseClassificationResponse(text, videos) {
  if (!text || typeof text !== 'string') {
    throw new Error('Empty response from OpenAI');
  }

  // Parse pure JSON directly without regex stripping
  const parsed = JSON.parse(text);

  const result = {};

  if (parsed && typeof parsed === 'object') {
    for (const v of videos) {
      if (parsed[v.id] !== undefined) {
        const val = String(parsed[v.id]).toLowerCase().trim();
        result[v.id] = val.includes('non') ? 'non-productive' : 'productive';
      }
    }

    // Fuzzy key match fallback in case of casing or formatting variations
    for (const v of videos) {
      if (!result[v.id]) {
        for (const [key, val] of Object.entries(parsed)) {
          if (key.includes(v.id) || v.id.includes(key)) {
            const strVal = String(val).toLowerCase().trim();
            result[v.id] = strVal.includes('non') ? 'non-productive' : 'productive';
            break;
          }
        }
      }
    }
  }

  // If no classifications could be parsed at all, throw an error
  const parsedCount = Object.keys(result).length;
  if (parsedCount === 0) {
    throw new Error('No valid video classifications found in OpenAI response: ' + text);
  }

  // Any remaining unclassified video in this batch gets session mode fallback
  for (const v of videos) {
    if (!result[v.id]) {
      result[v.id] = currentSessionMode;
    }
  }

  return result;
}

/**
 * Broadcasts a message to all active YouTube tabs cleanly
 */
function notifyTabs(payload) {
  try {
    chrome.tabs.query({ url: '*://*.youtube.com/*' }, function (tabs) {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
      for (const tab of tabs) {
        if (tab && typeof tab.id === 'number') {
          try {
            chrome.tabs.sendMessage(tab.id, payload, function () {
              // Accessing lastError suppresses "Receiving end does not exist" console logs
              const _ = chrome.runtime.lastError;
            });
          } catch (_) {}
        }
      }
    });
  } catch (_) {}
}

/**
 * ============================================================================
 * LinkedIn Router & Processing Logic
 * ============================================================================
 */

/**
 * Handles incoming LinkedIn categorization requests
 */
async function handleLinkedInRequest(message, sender, sendResponse) {
  if (message.type !== 'CATEGORIZE_POSTS' && !message.posts) {
    sendResponse({ status: 'ignored' });
    return;
  }

  const posts = Array.isArray(message.posts) ? message.posts : [];
  if (posts.length === 0) {
    sendResponse({ status: 'empty', categories: {} });
    return;
  }

  // 1. Retrieve stored API key, LinkedIn persistent cache, and blocked categories
  let stored = {};
  try {
    stored = await chrome.storage.local.get([
      'openaiApiKey',
      'apiKey',
      'linkedinCategories',
      'linkedinBlockedCategories'
    ]);
  } catch (_) {
    stored = {};
  }

  let apiKey = '';
  if (typeof stored.openaiApiKey === 'string' && stored.openaiApiKey.trim().startsWith('sk-')) {
    apiKey = stored.openaiApiKey.trim();
  } else if (typeof stored.apiKey === 'string' && stored.apiKey.trim().startsWith('sk-proj-')) {
    apiKey = stored.apiKey.trim();
  }

  // 2. Separate local cache for LinkedIn IDs so they don't collide with YouTube video IDs
  const cachedCategories =
    stored.linkedinCategories && typeof stored.linkedinCategories === 'object'
      ? stored.linkedinCategories
      : {};

  function normalizeCategoryString(label) {
    if (!label) return 'Non-Productive';
    const str = String(label).toLowerCase().trim();
    if (str.includes('non') || str === 'blur') return 'Non-Productive';
    if (str.includes('neut')) return 'Neutral';
    if (str.includes('prod') || str === 'keep') return 'Productive';
    return 'Non-Productive';
  }

  function normalizeLinkedInCategory(entry) {
    if (!entry) return { category: 'Non-Productive', reason: 'Unclassified' };
    if (typeof entry === 'object' && entry !== null) {
      const category = normalizeCategoryString(entry.category || entry.label);
      const reason = entry.reason || (category === 'Productive' ? 'Career opportunity or technical project' : category === 'Neutral' ? 'Industry news' : 'Distracting fluff or personal update');
      return { category, reason };
    }
    const category = normalizeCategoryString(entry);
    const reason = category === 'Productive' ? 'Career opportunity or technical project' : category === 'Neutral' ? 'Industry news' : 'Distracting fluff or personal update';
    return { category, reason };
  }

  const cachedResults = {};
  const unseenPosts = [];

  for (const post of posts) {
    if (post && post.id) {
      if (cachedCategories[post.id]) {
        cachedResults[post.id] = normalizeLinkedInCategory(cachedCategories[post.id]);
      } else {
        unseenPosts.push({
          id: String(post.id).trim(),
          authorHeadline: String(post.authorHeadline || '').trim(),
          body: String(post.body || '').trim().slice(0, 250)
        });
      }
    }
  }

  // If all posts were already cached, return immediately
  if (unseenPosts.length === 0) {
    sendResponse({
      status: 'cached',
      platform: 'linkedin',
      categories: cachedResults
    });
    return;
  }

  // 3. Batch unseen posts (chunk size up to 25 for prompt safety)
  const postsToEvaluate = unseenPosts.slice(0, 25);

  // 4. Three-Category AI Prompt: 'Productive', 'Neutral', or 'Non-Productive' with reasoning
  const systemPrompt = `You are a strict professional productivity filter for LinkedIn.
Analyze each post's author headline and truncated body text.
Categorize each post ID into EXACTLY one of three categories: "Productive", "Neutral", or "Non-Productive", and provide a concise 1-sentence reasoning.

Categories:
- "Productive": Posts strictly about hiring, open jobs, career opportunities, technical projects, engineering work, open source releases, educational tutorials, or showcasing concrete professional skills.
- "Neutral": General industry news, company milestones, business announcements, product launch press releases, or professional discussion without actionable technical content.
- "Non-Productive": Personal updates, selfies, emotional stories, humblebragging, hustle culture, motivational fluff, toxic positivity, memes, political opinions, engagement bait ("agree?", "thoughts?"), or irrelevant social media chatter.

You must output ONLY a raw JSON dictionary mapping each Post ID to an object with "category" ("Productive", "Neutral", or "Non-Productive") and "reason" (a brief 1-sentence explanation).
Example:
{
  "post_123": {
    "category": "Non-Productive",
    "reason": "Personal motivational story and selfie without professional or technical substance."
  }
}`;

  // 5. Call OpenAI API and return strict JSON dictionary
  try {
    const newCategories = await callOpenAILinkedInAPI(apiKey, postsToEvaluate, systemPrompt);

    // Save new classifications back to separate chrome.storage.local cache
    const updatedCache = { ...cachedCategories, ...newCategories };
    try {
      await chrome.storage.local.set({ linkedinCategories: updatedCache });
    } catch (_) {}

    // Seamlessly merge cached results and new API results for final response
    const finalCategories = { ...cachedResults, ...newCategories };
    sendResponse({
      status: 'success',
      platform: 'linkedin',
      categories: finalCategories
    });
  } catch (error) {
    // Fallback: default to 'Productive' on error so feed isn't broken
    const fallbackCategories = {};
    for (const post of postsToEvaluate) {
      fallbackCategories[post.id] = {
        category: 'Productive',
        reason: 'Default visible fallback due to API processing error'
      };
    }

    const mergedFallback = { ...cachedResults, ...fallbackCategories };
    sendResponse({
      status: 'error',
      platform: 'linkedin',
      categories: mergedFallback,
      error: error?.message || 'OpenAI API error'
    });
  }
}

/**
 * Calls OpenAI API for LinkedIn posts with native JSON mode
 */
async function callOpenAILinkedInAPI(apiKey, posts, systemPrompt) {
  if (!apiKey) {
    const endpoint = 'https://youtube-ai-focus.vercel.app/api/filter';
    const map = {};

    for (const p of posts) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: 'linkedin',
            id: p.id,
            author: p.authorHeadline || 'LinkedIn Member',
            content: p.body || ''
          })
        });
        if (res.ok) {
          const d = await res.json();
          map[p.id] = {
            category: d.category || (d.action === 'blur' ? 'Non-Productive' : 'Productive'),
            reason: d.reason || ''
          };
        } else {
          map[p.id] = { category: 'Productive', reason: 'Default keep fallback' };
        }
      } catch (_) {
        map[p.id] = { category: 'Productive', reason: 'Network fallback' };
      }
    }
    return map;
  }

  const authHeader = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;

  const response = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader
    },
    body: JSON.stringify({
      model: MODEL_ID,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: JSON.stringify(posts)
        }
      ],
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let msg = `OpenAI API error (${response.status}): ${errorBody}`;
    try {
      const parsedErr = JSON.parse(errorBody);
      if (parsedErr.error?.message) {
        msg = `OpenAI API error (${response.status}): ${parsedErr.error.message}`;
      }
    } catch (_) {}
    throw new Error(msg);
  }

  const data = await response.json();
  const rawText = data.choices[0].message.content;
  const parsed = JSON.parse(rawText);

  const result = {};
  for (const post of posts) {
    let label = 'Non-Productive';
    let reason = 'Personal updates, fluff, or non-technical chatter';
    let rawVal = parsed[post.id];
    if (rawVal === undefined) {
      // Fuzzy key fallback
      for (const [key, val] of Object.entries(parsed)) {
        if (key.includes(post.id) || post.id.includes(key)) {
          rawVal = val;
          break;
        }
      }
    }

    if (rawVal !== undefined) {
      let catString = '';
      if (typeof rawVal === 'object' && rawVal !== null) {
        catString = String(rawVal.category || rawVal.label || '').toLowerCase().trim();
        if (rawVal.reason) reason = String(rawVal.reason).trim();
      } else {
        catString = String(rawVal).toLowerCase().trim();
      }

      if (catString.includes('non') || catString.includes('blur')) {
        label = 'Non-Productive';
        if (!rawVal.reason) reason = 'Personal updates, fluff, or non-technical chatter';
      } else if (catString.includes('prod') || catString.includes('keep')) {
        label = 'Productive';
        if (!rawVal.reason) reason = 'Career opportunity, technical skill, or engineering project';
      } else if (catString.includes('neut')) {
        label = 'Neutral';
        if (!rawVal.reason) reason = 'General industry news or company milestone';
      }
    }
    result[post.id] = { category: label, reason };
  }

  return result;
}

/**
 * Broadcasts a message to all active LinkedIn tabs cleanly
 */
function notifyLinkedInTabs(payload) {
  try {
    chrome.tabs.query({ url: '*://*.linkedin.com/*' }, function (tabs) {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
      for (const tab of tabs) {
        if (tab && typeof tab.id === 'number') {
          try {
            chrome.tabs.sendMessage(tab.id, payload, function () {
              const _ = chrome.runtime.lastError;
            });
          } catch (_) {}
        }
      }
    });
  } catch (_) {}
}
