/**
 * options.js - Settings logic for YouTube AI Focus
 *
 * The extension operates securely via the Vercel backend proxy (/api/filter).
 * Strictly zero hardcoded secrets are stored.
 */

document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const toggleVisibilityBtn = document.getElementById('toggleVisibilityBtn');
  const saveBtn = document.getElementById('saveBtn');
  const testBtn = document.getElementById('testBtn');
  const clearBtn = document.getElementById('clearBtn');
  const clearCacheBtn = document.getElementById('clearCacheBtn');
  const cacheCountSpan = document.getElementById('cacheCount');
  const statusBadge = document.getElementById('statusBadge');
  const statusBadgeText = document.getElementById('statusBadgeText');
  const feedbackBanner = document.getElementById('feedbackBanner');

  // Load saved preferences (Zero secrets - checks for backend configuration or optional custom settings)
  chrome.storage.local.get(['backendUrl', 'openaiApiKey', 'apiKey', 'videoCategories'], (data) => {
    const savedUrl = data?.backendUrl || '';
    const key = data?.openaiApiKey || data?.apiKey || '';

    if (apiKeyInput) {
      apiKeyInput.value = savedUrl || key || '';
    }

    // Since Vercel proxy handles authentication securely with process.env.OPENAI_API_KEY,
    // the backend is active by default.
    updateBadge(true, savedUrl ? 'Custom Backend' : 'Vercel Proxy Active');
    updateCacheCount(data?.videoCategories);
  });

  // Toggle input visibility
  if (toggleVisibilityBtn && apiKeyInput) {
    toggleVisibilityBtn.addEventListener('click', () => {
      if (apiKeyInput.type === 'password') {
        apiKeyInput.type = 'text';
        toggleVisibilityBtn.textContent = '🔒';
      } else {
        apiKeyInput.type = 'password';
        toggleVisibilityBtn.textContent = '👁️';
      }
    });
  }

  // Save Settings
  if (saveBtn && apiKeyInput) {
    saveBtn.addEventListener('click', () => {
      const val = apiKeyInput.value.trim();

      if (val.startsWith('http://') || val.startsWith('https://') || val.startsWith('/')) {
        let normalized = val;
        if (!normalized.endsWith('/api/filter')) {
          normalized = normalized.replace(/\/+$/, '') + '/api/filter';
        }
        chrome.storage.local.set({ backendUrl: normalized }, () => {
          updateBadge(true, 'Backend Set');
          showFeedback('Backend URL saved successfully: ' + normalized, 'success');
        });
      } else if (val) {
        chrome.storage.local.set({ openaiApiKey: val, apiKey: val }, () => {
          updateBadge(true, 'Key Saved');
          showFeedback('Configuration saved successfully!', 'success');
        });
      } else {
        chrome.storage.local.remove(['backendUrl', 'openaiApiKey', 'apiKey'], () => {
          updateBadge(true, 'Default Vercel Proxy');
          showFeedback('Reverted to default Vercel proxy (/api/filter).', 'success');
        });
      }
    });
  }

  // Clear
  if (clearBtn && apiKeyInput) {
    clearBtn.addEventListener('click', () => {
      if (!confirm('Are you sure you want to reset settings?')) {
        return;
      }

      apiKeyInput.value = '';
      chrome.storage.local.remove(['backendUrl', 'openaiApiKey', 'apiKey', 'anthropicApiKey', 'geminiApiKey'], () => {
        updateBadge(true, 'Default Vercel Proxy');
        showFeedback('Settings cleared. Using secure Vercel backend proxy (/api/filter).', 'success');
      });
    });
  }

  // Clear Cache
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', () => {
      chrome.storage.local.remove(['videoCategories'], () => {
        updateCacheCount({});
        showFeedback('Local video categorization cache cleared.', 'success');
      });
    });
  }

  // Test Backend Connection
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      showFeedback('Testing Vercel backend proxy (/api/filter)...', 'loading');

      try {
        const stored = await chrome.storage.local.get(['backendUrl']);
        let endpoint = stored.backendUrl || 'https://youtube-ai-focus.vercel.app/api/filter';
        if (!endpoint.endsWith('/api/filter')) {
          endpoint = endpoint.replace(/\/+$/, '') + '/api/filter';
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            title: 'Learn Python Full Course',
            channel: 'freeCodeCamp.org',
            timestamp: '1 year ago',
            duration: '4:00:00',
            url: 'https://www.youtube.com/watch?v=sample'
          })
        });

        const result = await response.json();

        if (!response.ok) {
          const errorMsg = result.error || response.statusText || 'Unknown error occurred.';
          showFeedback(`Backend Error (${response.status}): ${errorMsg}`, 'error');
          return;
        }

        showFeedback(`Success! Connected to backend. Action returned: "${result.action}"`, 'success');
      } catch (err) {
        showFeedback(`Connection note: ${err.message}. (Ensure backend server is running)`, 'info');
      }
    });
  }

  function updateBadge(isActive, text) {
    if (statusBadge && statusBadgeText) {
      if (isActive) {
        statusBadge.className = 'status-badge active';
        statusBadgeText.textContent = text || 'Active Proxy';
      } else {
        statusBadge.className = 'status-badge missing';
        statusBadgeText.textContent = text || 'Not Configured';
      }
    }
  }

  function updateCacheCount(cacheObj) {
    if (cacheCountSpan) {
      const count = cacheObj ? Object.keys(cacheObj).length : 0;
      cacheCountSpan.textContent = count.toLocaleString();
    }
  }

  function showFeedback(text, type) {
    if (feedbackBanner) {
      feedbackBanner.className = `feedback-banner ${type}`;
      feedbackBanner.textContent = text;
    }
  }
});
