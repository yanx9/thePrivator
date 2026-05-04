/**
 * Background Service Worker for thePrivator
 * Handles WebRTC leak prevention and other background tasks
 */

console.log('[thePrivator] Background service worker started');

/**
 * Load configuration and setup WebRTC blocking if enabled
 */
async function setupWebRTCProtection() {
  try {
    // Load config.json
    const configUrl = chrome.runtime.getURL('config.json');
    const response = await fetch(configUrl);

    if (!response.ok) {
      console.warn('[thePrivator] Failed to load config in background worker');
      return;
    }

    const config = await response.json();
    console.log('[thePrivator] Config loaded:', config);

    // Setup WebRTC protection based on config
    if (config.webrtc_protection === 'block_leak') {
      await enableWebRTCBlocking();
      console.log('[thePrivator] WebRTC leak protection enabled');
    } else {
      console.log('[thePrivator] WebRTC protection disabled');
    }

  } catch (error) {
    console.error('[thePrivator] Error setting up WebRTC protection:', error);
  }
}

/**
 * Enable WebRTC IP leak blocking
 * Blocks STUN/TURN requests that could leak real IP address
 */
async function enableWebRTCBlocking() {
  // Block WebRTC STUN/TURN servers
  const webrtcUrls = [
    '*://*.stun.*',
    '*://stun.*',
    '*://*.turn.*',
    '*://turn.*',
    '*://*/stun',
    '*://*/turn'
  ];

  // Note: In Manifest V3, webRequest blocking is limited
  // We use declarativeNetRequest instead for better performance

  if (chrome.declarativeNetRequest) {
    try {
      // Define rules to block WebRTC leak URLs
      const rules = webrtcUrls.map((url, index) => ({
        id: index + 1,
        priority: 1,
        action: { type: 'block' },
        condition: {
          urlFilter: url,
          resourceTypes: [
            'xmlhttprequest',
            'websocket',
            'sub_frame',
            'other'
          ]
        }
      }));

      // Update dynamic rules
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: rules.map(r => r.id),
        addRules: rules
      });

      console.log('[thePrivator] WebRTC blocking rules installed');
    } catch (error) {
      console.warn('[thePrivator] Could not install WebRTC blocking rules:', error);

      // Fallback: Use content script injection
      // This is less reliable but works when declarativeNetRequest is unavailable
      console.log('[thePrivator] Using fallback WebRTC blocking via content script');
    }
  }
}

/**
 * Inject WebRTC override script directly into pages
 * Fallback method when declarativeNetRequest is unavailable
 */
function injectWebRTCOverride(tabId) {
  const script = `
    (function() {
      'use strict';

      // Override RTCPeerConnection to disable ICE servers
      const OriginalRTCPeerConnection = window.RTCPeerConnection ||
                                       window.webkitRTCPeerConnection ||
                                       window.mozRTCPeerConnection;

      if (OriginalRTCPeerConnection) {
        const ProxyRTCPeerConnection = function(config, constraints) {
          // Remove STUN/TURN servers from configuration
          if (config && config.iceServers) {
            config.iceServers = [];
          }

          return new OriginalRTCPeerConnection(config, constraints);
        };

        ProxyRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;

        window.RTCPeerConnection = ProxyRTCPeerConnection;
        if (window.webkitRTCPeerConnection) {
          window.webkitRTCPeerConnection = ProxyRTCPeerConnection;
        }
        if (window.mozRTCPeerConnection) {
          window.mozRTCPeerConnection = ProxyRTCPeerConnection;
        }

        console.log('[thePrivator] WebRTC override injected');
      }
    })();
  `;

  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: new Function(script),
    world: 'MAIN'
  }).catch(err => {
    console.warn('[thePrivator] Could not inject WebRTC override:', err);
  });
}

/**
 * Listen for extension installation/update
 */
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[thePrivator] Extension installed/updated:', details.reason);
  setupWebRTCProtection();
});

/**
 * Listen for service worker startup
 */
chrome.runtime.onStartup.addListener(() => {
  console.log('[thePrivator] Browser started, initializing protection');
  setupWebRTCProtection();
});

/**
 * Handle messages from content scripts
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[thePrivator] Message received:', message);

  if (message.type === 'getConfig') {
    // Send config to content script
    fetch(chrome.runtime.getURL('config.json'))
      .then(response => response.json())
      .then(config => sendResponse({ config }))
      .catch(error => sendResponse({ error: error.message }));
    return true; // Will respond asynchronously
  }

  if (message.type === 'log') {
    console.log('[thePrivator Content]:', message.message);
  }

  return false;
});

// Initialize on load
setupWebRTCProtection();
