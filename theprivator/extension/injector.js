/**
 * Injector - Injects protection scripts into MAIN world
 * Uses bundled_protector.js to avoid CSP issues with inline scripts.
 */

(async function() {
  try {
    // 1. Load Config
    const configUrl = chrome.runtime.getURL('config.json');
    const response = await fetch(configUrl);
    const config = await response.json();
    
    // 2. Pass config to the page context via dataset (safe and CSP-compliant)
    // The bundled script will read this and then clear it
    document.documentElement.dataset.privatorConfig = JSON.stringify(config);
    
    // 3. Inject the bundled protector script
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('bundled_protector.js');
    script.onload = function() {
        this.remove(); // Clean up script tag after execution
    };
    (document.head || document.documentElement).prepend(script);
    
    // console.log('[thePrivator] Protection injected');

  } catch (e) {
    console.error('[thePrivator] Injection failed:', e);
  }
})();
