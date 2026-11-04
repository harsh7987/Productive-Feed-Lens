/**
 * popup.js - Manages dynamic tab detection, Master Switch, and Focus Mode controls
 */

document.addEventListener('DOMContentLoaded', () => {
  // Header Elements
  const headerIcon = document.getElementById('headerIcon');
  const headerTitle = document.getElementById('headerTitle');
  const headerSubtitle = document.getElementById('headerSubtitle');

  // Platform Section Containers
  const youtubeSection = document.getElementById('youtubeSection');
  const linkedinSection = document.getElementById('linkedinSection');
  const unsupportedSection = document.getElementById('unsupportedSection');

  // YouTube Master Switch Elements
  const ytMasterToggle = document.getElementById('ytMasterToggle');
  const ytMasterCard = document.getElementById('ytMasterCard');
  const masterStatusText = document.getElementById('masterStatusText');
  const ytSubSettings = document.getElementById('ytSubSettings');

  // YouTube Mode Elements
  const btnModeProductive = document.getElementById('btnModeProductive');
  const btnModeNonProductive = document.getElementById('btnModeNonProductive');
  const modeIndicatorBadge = document.getElementById('modeIndicatorBadge');
  const modeDescriptionText = document.getElementById('modeDescriptionText');

  // YouTube Goal Elements
  const goalInput = document.getElementById('goalInput');
  const setGoalBtn = document.getElementById('setGoalBtn');
  const clearGoalBtn = document.getElementById('clearGoalBtn');
  const activeGoalDisplay = document.getElementById('activeGoalDisplay');
  const profileBadge = document.getElementById('profileBadge');

  // LinkedIn Elements
  const linkedinShowNeutral = document.getElementById('linkedinShowNeutral');

  // Shared Elements
  const statusMessage = document.getElementById('statusMessage');
  const openOptionsLink = document.getElementById('openOptionsLink');

  // Initialize
  detectActiveTabPlatform();
  loadYouTubeSettings();
  loadLinkedInSettings();

  /**
   * 1. Dynamic Platform Detection: Checks active tab URL to show only relevant settings
   */
  function detectActiveTabPlatform() {
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs && tabs[0];
          const url = (tab?.url || '').toLowerCase();

          if (url.includes('youtube.com')) {
            showYouTubeUI();
          } else if (url.includes('linkedin.com')) {
            showLinkedInUI();
          } else {
            showUnsupportedUI();
          }
        });
      } else {
        // Fallback for non-extension preview
        showYouTubeUI();
      }
    } catch (err) {
      console.warn('[AI Focus popup] Error querying active tab:', err);
      showYouTubeUI();
    }
  }

  function showYouTubeUI() {
    if (headerIcon) headerIcon.textContent = '▶️';
    if (headerTitle) headerTitle.textContent = 'YouTube AI Focus';
    if (headerSubtitle) headerSubtitle.textContent = 'Filter Controls & Goals';

    if (youtubeSection) youtubeSection.style.display = 'block';
    if (linkedinSection) linkedinSection.style.display = 'none';
    if (unsupportedSection) unsupportedSection.style.display = 'none';
  }

  function showLinkedInUI() {
    if (headerIcon) headerIcon.textContent = '💼';
    if (headerTitle) headerTitle.textContent = 'LinkedIn AI Focus';
    if (headerSubtitle) headerSubtitle.textContent = 'Professional Feed Filter';

    if (youtubeSection) youtubeSection.style.display = 'none';
    if (linkedinSection) linkedinSection.style.display = 'block';
    if (unsupportedSection) unsupportedSection.style.display = 'none';
  }

  function showUnsupportedUI() {
    if (headerIcon) headerIcon.textContent = '⚡';
    if (headerTitle) headerTitle.textContent = 'AI Focus Assistant';
    if (headerSubtitle) headerSubtitle.textContent = 'Active on YouTube & LinkedIn';

    if (youtubeSection) youtubeSection.style.display = 'none';
    if (linkedinSection) linkedinSection.style.display = 'none';
    if (unsupportedSection) unsupportedSection.style.display = 'block';
  }

  /**
   * 2. YouTube Master Switch & Mode Loading
   */
  async function loadYouTubeSettings() {
    try {
      const data = await chrome.storage.local.get([
        'youtubeFilterEnabled',
        'activeMode',
        'youtubeMode',
        'activeGoal'
      ]);

      // Master switch state (default: true)
      const isEnabled = data.youtubeFilterEnabled !== undefined ? Boolean(data.youtubeFilterEnabled) : true;
      setMasterSwitchUI(isEnabled);

      // Mode state (default: 'productive')
      const currentMode = data.activeMode || data.youtubeMode || 'productive';
      setModeUI(currentMode);

      // Goal state
      const activeGoal = typeof data?.activeGoal === 'string' ? data.activeGoal.trim() : '';
      setGoalUI(activeGoal);
    } catch (err) {
      console.warn('[AI Focus popup] Error loading YouTube settings:', err);
      setMasterSwitchUI(true);
      setModeUI('productive');
    }
  }

  function setMasterSwitchUI(isEnabled) {
    if (ytMasterToggle) ytMasterToggle.checked = isEnabled;

    if (ytMasterCard) {
      if (isEnabled) {
        ytMasterCard.classList.add('active');
      } else {
        ytMasterCard.classList.remove('active');
      }
    }

    if (masterStatusText) {
      masterStatusText.textContent = isEnabled
        ? 'AI classification & focus protection active'
        : 'Filter is disabled. YouTube displays normally.';
    }

    // Crucial requirement: If OFF, all other extension UI is hidden; if ON, secondary UI appears
    if (ytSubSettings) {
      ytSubSettings.style.display = isEnabled ? 'block' : 'none';
    }
  }

  // Master Switch Event Listener
  if (ytMasterToggle) {
    ytMasterToggle.addEventListener('change', async () => {
      const isEnabled = ytMasterToggle.checked;
      setMasterSwitchUI(isEnabled);

      try {
        await chrome.storage.local.set({ youtubeFilterEnabled: isEnabled });

        // Notify active tab immediately
        notifyActiveTab({
          type: 'TOGGLE_YOUTUBE_FILTER',
          enabled: isEnabled
        });

        showStatus(
          isEnabled
            ? 'YouTube Filter enabled 🎯'
            : 'YouTube Filter disabled. Videos will display normally.',
          isEnabled ? 'success' : 'info'
        );
      } catch (err) {
        showStatus('Failed to update filter switch: ' + err.message, 'error');
      }
    });
  }

  /**
   * Mode Toggle (Productive vs Non-Productive)
   */
  function setModeUI(mode) {
    const isProd = mode !== 'non-productive';

    if (btnModeProductive && btnModeNonProductive) {
      if (isProd) {
        btnModeProductive.classList.add('active', 'productive');
        btnModeNonProductive.classList.remove('active', 'non-productive');
      } else {
        btnModeNonProductive.classList.add('active', 'non-productive');
        btnModeProductive.classList.remove('active', 'productive');
      }
    }

    if (modeIndicatorBadge) {
      modeIndicatorBadge.className = isProd ? 'mode-indicator productive' : 'mode-indicator non-productive';
      modeIndicatorBadge.textContent = isProd ? 'Productive' : 'Non-Productive';
    }

    if (modeDescriptionText) {
      modeDescriptionText.textContent = isProd
        ? 'Keeping tutorials, coding & educational content. Entertainment blurred.'
        : 'Relaxed focus mode. All videos are visible and nothing is blurred.';
    }
  }

  async function handleModeChange(newMode) {
    setModeUI(newMode);

    try {
      await chrome.storage.local.set({
        activeMode: newMode,
        youtubeMode: newMode
      });

      // Notify active tab
      notifyActiveTab({
        type: 'SET_YOUTUBE_MODE',
        mode: newMode
      });

      showStatus(
        newMode === 'productive'
          ? 'Switched to Productive Mode 🎯'
          : 'Switched to Non-Productive Mode 🍿',
        'info'
      );
    } catch (err) {
      showStatus('Failed to change mode: ' + err.message, 'error');
    }
  }

  if (btnModeProductive) {
    btnModeProductive.addEventListener('click', () => handleModeChange('productive'));
  }
  if (btnModeNonProductive) {
    btnModeNonProductive.addEventListener('click', () => handleModeChange('non-productive'));
  }

  /**
   * Goal Management
   */
  function setGoalUI(activeGoal) {
    if (activeGoal) {
      if (profileBadge) {
        profileBadge.textContent = 'Custom Goal';
        profileBadge.className = 'profile-badge custom';
      }
      if (activeGoalDisplay) {
        activeGoalDisplay.textContent = `🎯 Strict Focus: ${activeGoal}`;
        activeGoalDisplay.className = 'active-goal-text';
      }
      if (goalInput) goalInput.value = activeGoal;
      if (clearGoalBtn) clearGoalBtn.disabled = false;
    } else {
      if (profileBadge) {
        profileBadge.textContent = 'Standard';
        profileBadge.className = 'profile-badge standard';
      }
      if (activeGoalDisplay) {
        activeGoalDisplay.textContent = 'Standard Productivity Rules (No custom goal)';
        activeGoalDisplay.className = 'active-goal-text empty';
      }
      if (clearGoalBtn) clearGoalBtn.disabled = true;
    }
  }

  async function handleSetGoal() {
    if (!goalInput) return;
    const rawGoal = goalInput.value.trim();

    if (!rawGoal) {
      showStatus('Please enter a focus goal before setting.', 'error');
      goalInput.focus();
      return;
    }

    try {
      await chrome.storage.local.set({
        activeGoal: rawGoal,
        videoCategories: {} // clear cache so new goal applies
      });

      setGoalUI(rawGoal);
      showStatus(`🎯 Focus goal set: "${rawGoal}"`, 'success');
    } catch (err) {
      showStatus('Failed to save focus goal: ' + err.message, 'error');
    }
  }

  async function handleClearGoal() {
    try {
      await chrome.storage.local.set({
        activeGoal: '',
        videoCategories: {}
      });
      await chrome.storage.local.remove(['activeGoal']);

      if (goalInput) goalInput.value = '';
      setGoalUI('');
      showStatus('Goal cleared. Reverted to standard rules.', 'info');
    } catch (err) {
      showStatus('Failed to clear focus goal: ' + err.message, 'error');
    }
  }

  if (setGoalBtn) setGoalBtn.addEventListener('click', handleSetGoal);
  if (clearGoalBtn) clearGoalBtn.addEventListener('click', handleClearGoal);
  if (goalInput) {
    goalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSetGoal();
      }
    });
  }

  /**
   * LinkedIn Settings Management
   */
  async function loadLinkedInSettings() {
    try {
      const data = await chrome.storage.local.get(['linkedinShowNeutral']);
      if (linkedinShowNeutral) {
        linkedinShowNeutral.checked = data.linkedinShowNeutral !== undefined ? Boolean(data.linkedinShowNeutral) : true;
      }
    } catch (err) {
      console.warn('[AI Focus popup] Error loading LinkedIn settings:', err);
    }
  }

  if (linkedinShowNeutral) {
    linkedinShowNeutral.addEventListener('change', async () => {
      try {
        await chrome.storage.local.set({ linkedinShowNeutral: linkedinShowNeutral.checked });
        showStatus(
          linkedinShowNeutral.checked
            ? 'LinkedIn: Neutral posts will be visible.'
            : 'LinkedIn: Neutral posts will be blurred.',
          'info'
        );
      } catch (err) {
        showStatus('Failed to save LinkedIn setting: ' + err.message, 'error');
      }
    });
  }

  /**
   * Helper: Send message to active tab
   */
  function notifyActiveTab(message) {
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs && tabs[0]?.id) {
            chrome.tabs.sendMessage(tabs[0].id, message, () => {
              const _ = chrome.runtime.lastError;
            });
          }
        });
      }
    } catch (_) {}
  }

  /**
   * Helper: Feedback banner
   */
  let statusTimeout = null;
  function showStatus(text, type) {
    if (!statusMessage) return;
    if (statusTimeout) clearTimeout(statusTimeout);

    statusMessage.textContent = text;
    statusMessage.className = `status-msg ${type}`;
    statusMessage.style.display = 'block';

    statusTimeout = setTimeout(() => {
      statusMessage.style.display = 'none';
      statusMessage.className = 'status-msg';
    }, 3500);
  }

  // Open settings options page
  if (openOptionsLink) {
    openOptionsLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (chrome.runtime && typeof chrome.runtime.openOptionsPage === 'function') {
        chrome.runtime.openOptionsPage();
      }
    });
  }
});
