/**
 * api/filter.js - Vercel Serverless Function Proxy for YouTube & LinkedIn AI Focus
 *
 * Securely proxies YouTube video and LinkedIn post metadata classification requests to OpenAI.
 * Uses strictly process.env.OPENAI_API_KEY (the extension never holds secrets).
 * Returns a clean JSON object: { action: "blur" | "keep", category: "...", reason: "..." }
 */

module.exports = async function handler(req, res) {
  // 1. Enable standard CORS headers for browser extension & web requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With, Accept, Origin'
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST requests for classification
  if (req.method !== 'POST') {
    res.status(405).json({
      error: 'Method Not Allowed. Please send a POST request with video or post metadata.',
      action: 'keep',
      category: 'productive'
    });
    return;
  }

  // 2. Securely read OpenAI API key strictly from environment variables
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    console.error('[Vercel Backend /api/filter] Error: OPENAI_API_KEY environment variable is not configured.');
    res.status(500).json({
      error: 'Server configuration error: OPENAI_API_KEY is not set.',
      action: 'keep', // Safe fallback so client feed does not freeze
      category: 'productive'
    });
    return;
  }

  // 3. Parse incoming JSON payload
  let payload = req.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (parseErr) {
      res.status(400).json({
        error: 'Invalid JSON payload received in request body.',
        action: 'keep',
        category: 'productive'
      });
      return;
    }
  }

  payload = payload || {};

  // Support single item or wrapped item (post, video, data)
  const itemData = payload.post || payload.video || payload.data || payload;

  const platform = String(
    itemData.platform ||
    payload.platform ||
    (itemData.url && itemData.url.includes('linkedin.com') ? 'linkedin' : '') ||
    (itemData.author || itemData.authorHeadline || itemData.postContent ? 'linkedin' : '') ||
    'youtube'
  ).toLowerCase().trim();

  const isLinkedIn = platform === 'linkedin';

  // LinkedIn-specific metadata
  const author = (itemData.author || itemData.authorName || itemData.authorHeadline || itemData.channel || '').trim();
  let content = (itemData.content || itemData.postContent || itemData.body || itemData.text || itemData.description || itemData.title || itemData.allText || '').trim();
  if (/^feed post$/i.test(content)) {
    content = '';
  }
  const postId = (itemData.id || itemData.postId || '').trim();

  // YouTube-specific metadata
  const title = (itemData.title || '').trim();
  const channel = (itemData.channel || itemData.channelName || itemData.author || '').trim();
  const timestamp = (itemData.timestamp || itemData.uploadDate || '').trim();
  const duration = (itemData.duration || itemData.videoLength || itemData.length || '').trim();
  const url = (itemData.url || itemData.link || '').trim();
  const allText = (itemData.allText || itemData.rawText || itemData.description || content || '').trim();
  const activeGoal = (payload.activeGoal || itemData.activeGoal || '').trim();

  // 4. Construct AI System & User prompts based on platform
  let systemPrompt = '';
  let userContext = {};

  if (isLinkedIn) {
    systemPrompt =
      'You are a strict professional productivity filter for LinkedIn.\n' +
      'Analyze the provided LinkedIn post author and post content.\n' +
      'Classify whether the post is Productive, Neutral, or Non-Productive, and determine whether action should be "keep" or "blur".\n\n' +
      'CATEGORIES & RULES:\n' +
      '- "Productive" (action: "keep"): Posts strictly about hiring, open jobs, career opportunities, technical projects, engineering work, software development, science, mathematics, open source releases, academic tutorials, programming, or concrete professional skills.\n' +
      '- "Neutral" (action: "keep"): General industry news, company milestones, corporate announcements, business updates, tech releases, or professional discussion without actionable technical skills.\n' +
      '- "Non-Productive" (action: "blur"): Personal updates, selfies, emotional life stories, humblebragging, hustle culture, motivational fluff, toxic positivity, memes, political rants, engagement bait ("agree?", "thoughts?"), or irrelevant social media chatter.\n\n' +
      'You must respond with ONLY a raw JSON object formatted as:\n' +
      '{\n' +
      '  "action": "blur" | "keep",\n' +
      '  "category": "Productive" | "Neutral" | "Non-Productive",\n' +
      '  "reason": "Brief 1-sentence explanation"\n' +
      '}';

    if (activeGoal) {
      systemPrompt += `\n\nSTRICT FOCUS GOAL: The user is currently focusing exclusively on: "${activeGoal}". Classify any post not directly relevant to this specific topic as category: "Non-Productive", action: "blur". Otherwise category: "Productive", action: "keep".`;
    }

    userContext = {
      platform: 'linkedin',
      author: author || 'LinkedIn Member',
      content: content ? content.slice(0, 1500) : 'No post content provided',
      postContent: content ? content.slice(0, 1500) : 'No post content provided',
      url: url || ''
    };
  } else {
    // YouTube prompt
    systemPrompt =
      'You are a YouTube productivity filter assistant. ' +
      'Classify whether the given YouTube video should be kept or blurred based on whether it is productive or distracting.\n\n' +
      'RULES:\n' +
      '- "keep": Productive content such as programming, software engineering, science, mathematics, academic lectures, tutorials, professional skills, documentaries, or deep work guides.\n' +
      '- "blur": Distracting content such as clickbait, comedy sketches, gaming streams, gossip, vlogs, memes, music videos, reaction videos, or low-attention-span clips.\n\n' +
      'Analyze the provided title, channel name, upload timestamp, video length/duration, URL, and contextual text.\n' +
      'You must respond with ONLY a raw JSON object formatted as:\n' +
      '{\n' +
      '  "action": "blur" | "keep",\n' +
      '  "category": "productive" | "non-productive",\n' +
      '  "reason": "Brief 1-sentence explanation"\n' +
      '}';

    if (activeGoal) {
      systemPrompt += `\n\nSTRICT FOCUS GOAL: The user is currently focusing exclusively on: "${activeGoal}". Classify any video not directly relevant to this specific topic as action: "blur". Otherwise action: "keep".`;
    }

    userContext = {
      platform: 'youtube',
      title: title || 'Unknown Title',
      channel: channel || 'Unknown Channel',
      timestamp: timestamp || 'Unknown Timestamp',
      duration: duration || 'Unknown Duration',
      url: url || '',
      contextText: allText ? allText.slice(0, 400) : ''
    };
  }

  // 5. Call OpenAI API securely
  try {
    const userMessageContent = isLinkedIn
      ? `Evaluate this LinkedIn post:\nAuthor: ${author || 'LinkedIn Member'}\nPost Content:\n${content ? content.slice(0, 2000) : 'No post content provided'}\n${url ? `URL: ${url}\n` : ''}\nContext: ${JSON.stringify(userContext)}`
      : JSON.stringify(userContext);

    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessageContent }
        ],
        response_format: { type: 'json_object' }
      })
    });

    if (!openaiResponse.ok) {
      const errText = await openaiResponse.text();
      console.error('[Vercel Backend /api/filter] OpenAI API error status:', openaiResponse.status, errText);
      res.status(502).json({
        error: `OpenAI upstream error (${openaiResponse.status})`,
        action: 'keep', // Fail-open fallback so UI never freezes
        category: isLinkedIn ? 'Productive' : 'productive',
        platform: isLinkedIn ? 'linkedin' : 'youtube'
      });
      return;
    }

    const openaiData = await openaiResponse.json();
    const rawContent = openaiData.choices?.[0]?.message?.content || '{}';

    let parsedResult = {};
    try {
      parsedResult = JSON.parse(rawContent);
    } catch (jsonErr) {
      console.warn('[Vercel Backend /api/filter] Failed to parse OpenAI JSON output:', rawContent);
    }

    // Handle LinkedIn classification response
    if (isLinkedIn) {
      let category = 'Non-Productive';
      const catLower = String(parsedResult.category || '').toLowerCase();
      if (catLower.includes('non') || catLower.includes('blur') || parsedResult.action === 'blur') {
        category = 'Non-Productive';
      } else if (catLower.includes('neut')) {
        category = 'Neutral';
      } else if (catLower.includes('prod') || parsedResult.action === 'keep') {
        category = 'Productive';
      }

      let action = 'keep';
      if (category === 'Non-Productive' || parsedResult.action === 'blur') {
        action = 'blur';
      } else {
        action = 'keep';
      }

      res.status(200).json({
        platform: 'linkedin',
        action: action,
        category: category,
        reason: parsedResult.reason || '',
        id: postId
      });
      return;
    }

    // Handle YouTube classification response
    let action = 'keep';
    if (parsedResult.action === 'blur' || parsedResult.action === 'keep') {
      action = parsedResult.action;
    } else if (
      parsedResult.category === 'non-productive' ||
      parsedResult.productive === false ||
      parsedResult.blur === true
    ) {
      action = 'blur';
    }

    // 6. Send clean JSON object back to the extension
    res.status(200).json({
      platform: 'youtube',
      action: action,
      reason: parsedResult.reason || '',
      category: action === 'blur' ? 'non-productive' : 'productive'
    });
  } catch (error) {
    console.error('[Vercel Backend /api/filter] Exception during classification:', error);
    res.status(500).json({
      error: error.message || 'Internal server error',
      action: 'keep', // Fail-open fallback so UI never freezes
      category: isLinkedIn ? 'Productive' : 'productive',
      platform: isLinkedIn ? 'linkedin' : 'youtube'
    });
  }
};

module.exports.default = module.exports;
