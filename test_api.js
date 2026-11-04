// test_api.js - Standalone API test script (Zero secrets, strictly uses environment variables or Vercel proxy)
const apiKey = process.env.OPENAI_API_KEY || '';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MODEL_ID = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const SYSTEM_PROMPT =
  'You are a strict productivity filter. Categorize as PRODUCTIVE: coding, software development, science, educational lectures. Categorize as NON-PRODUCTIVE: stand-up comedy, music videos, gaming, podcasts, vlogs, and movies. Rely heavily on the channel name and title to filter out long non-productive content like gaming streams or podcasts. Use video duration as a secondary context clue, specifically using short durations (under 2 minutes) to aggressively filter out memes and low-attention-span clips. You must output ONLY a raw JSON object mapping each Video ID to either "productive" or "non-productive".';

const sampleVideos = [
  {
    id: "dQw4w9WgXcQ",
    title: "Rick Astley - Never Gonna Give You Up (Official Music Video)",
    channel: "Rick Astley",
    duration: "3:33",
    timestamp: "14 years ago",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  },
  {
    id: "abc123coding",
    title: "Learn Python Programming - Full Course for Beginners",
    channel: "freeCodeCamp.org",
    duration: "4:26:52",
    timestamp: "2 years ago",
    url: "https://www.youtube.com/watch?v=abc123coding"
  }
];

async function runTest() {
  console.log('--- YouTube AI Focus Backend Test ---');

  if (!apiKey) {
    console.log('[Notice] No OPENAI_API_KEY found in process.env.');
    console.log('The extension now operates with zero hardcoded secrets.');
    console.log('To test OpenAI directly, run: OPENAI_API_KEY=sk-... node test_api.js');
    console.log('Testing handler validation from api/filter.js...');

    try {
      const handler = require('./api/filter.js');
      console.log('Successfully loaded api/filter.js handler.');

      // Test handler error handling when OPENAI_API_KEY is unset
      let statusCode = 200;
      let responseBody = null;
      const mockReq = {
        method: 'POST',
        body: sampleVideos[0]
      };
      const mockRes = {
        setHeader: () => {},
        status: (code) => {
          statusCode = code;
          return mockRes;
        },
        json: (data) => {
          responseBody = data;
          return mockRes;
        },
        end: () => {}
      };

      await handler(mockReq, mockRes);
      console.log(`Handler executed safely without secrets: Status ${statusCode}, Action:`, responseBody?.action);
    } catch (err) {
      console.log('Handler test info:', err.message);
    }
    return;
  }

  console.log('Endpoint:', OPENAI_ENDPOINT);
  console.log('Model:', MODEL_ID);

  const requestHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  const requestBody = {
    model: MODEL_ID,
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: JSON.stringify(sampleVideos)
      }
    ],
    response_format: { type: 'json_object' }
  };

  try {
    const startTime = Date.now();
    const response = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestBody)
    });

    const elapsed = Date.now() - startTime;
    console.log(`HTTP Status: ${response.status} ${response.statusText} (${elapsed}ms)`);

    const data = await response.json();
    const rawText = data.choices[0].message.content;
    console.log('\nExtracted rawText:');
    console.log(rawText);

    const parsed = JSON.parse(rawText);
    console.log('\nParsed JSON:');
    console.log(parsed);
  } catch (err) {
    console.error('Test error:', err.message);
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  runTest();
}

module.exports = { runTest };
