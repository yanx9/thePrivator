/**
 * thePrivator Bundled Protection
 * Combines all protection modules into a single file to avoid CSP issues with inline scripts.
 * Reads config from document.documentElement.dataset.privatorConfig
 */

(function() {
    'use strict';

    // 1. Initialize Config
    let config = {};
    try {
        const configStr = document.documentElement.dataset.privatorConfig;
        if (configStr) {
            config = JSON.parse(configStr);
            // Clean up the attribute to hide it (though page scripts might have seen it already)
            delete document.documentElement.dataset.privatorConfig;
            
            // Define global config for compatibility (read-only)
            Object.defineProperty(window, '__PRIVATOR_CONFIG__', {
                value: config,
                writable: false,
                configurable: false
            });
        }
    } catch(e) {
        console.warn('[thePrivator] Failed to parse config from dataset:', e);
    }

    // Common Helper: Seeded Random
    function seededRandom(s) {
        const x = Math.sin(s) * 10000;
        return x - Math.floor(x);
    }

    // Common Helper: Function Masking
    function maskFunction(newFunc, originalFunc) {
        Object.defineProperty(newFunc, 'toString', {
            value: function() {
                return originalFunc.toString();
            },
            writable: true,
            configurable: true
        });
        Object.defineProperty(newFunc.toString, 'toString', {
            value: function() {
                return originalFunc.toString.toString();
            },
            writable: true,
            configurable: true
        });
        return newFunc;
    }

    // ==========================================
    // MODULE: Navigator Protection
    // ==========================================
    (function() {
        // console.log('[thePrivator] Navigator protection initializing...');
        
        function overrideNavigatorProperty(prop, value) {
            if (value === undefined || value === null) return;
            
            try {
                // Check if property exists on navigator prototype
                const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, prop);
                
                if (descriptor && descriptor.get) {
                    // If it's a getter on the prototype, override it
                    const originalGet = descriptor.get;
                    Object.defineProperty(Navigator.prototype, prop, {
                        get: maskFunction(function() {
                            return value;
                        }, originalGet),
                        configurable: true,
                        enumerable: true
                    });
                } else {
                    // Fallback: define on instance
                    Object.defineProperty(navigator, prop, {
                        get: function() { return value; },
                        configurable: true,
                        enumerable: true
                    });
                }
            } catch (e) {
                console.warn(`[thePrivator] Failed to override navigator.${prop}:`, e);
            }
        }

        if (config.platform) overrideNavigatorProperty('platform', config.platform);
        if (config.hardware_concurrency) overrideNavigatorProperty('hardwareConcurrency', config.hardware_concurrency);
        if (config.device_memory) overrideNavigatorProperty('deviceMemory', config.device_memory);
    })();

    // ==========================================
    // MODULE: Canvas Protection
    // ==========================================
    (function() {
        if (!config.canvas_enabled) return;
        const seed = config.canvas_noise_seed || 42;
        console.log('[thePrivator] Canvas protection enabled');

        function addNoise(imageData, seedBase) {
            if (!imageData || !imageData.data) return imageData;
            const data = imageData.data;
            const len = data.length;
            for (let i = 0; i < len; i += 4) {
                const pixelSeed = seedBase + i;
                const noise = Math.floor(seededRandom(pixelSeed) * 5) - 2;
                data[i] = Math.max(0, Math.min(255, data[i] + noise));
                data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
                data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
            }
            return imageData;
        }

        function getNoisyDataURL(canvas, type, encoderOptions) {
            try {
                const width = canvas.width;
                const height = canvas.height;
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = width;
                tempCanvas.height = height;
                const ctx = tempCanvas.getContext('2d');
                if (ctx) {
                    ctx.drawImage(canvas, 0, 0);
                    const imageData = ctx.getImageData(0, 0, width, height);
                    addNoise(imageData, seed);
                    ctx.putImageData(imageData, 0, 0);
                    return tempCanvas.toDataURL(type, encoderOptions);
                }
            } catch (e) { }
            return HTMLCanvasElement.prototype.toDataURL.call(canvas, type, encoderOptions);
        }

        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = maskFunction(function(type, encoderOptions) {
            return getNoisyDataURL(this, type, encoderOptions);
        }, originalToDataURL);

        const originalToBlob = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = maskFunction(function(callback, type, quality) {
            try {
                const dataURL = getNoisyDataURL(this, type, quality);
                fetch(dataURL)
                    .then(res => res.blob())
                    .then(blob => { if (callback) callback(blob); })
                    .catch(() => { originalToBlob.call(this, callback, type, quality); });
            } catch (e) { return originalToBlob.call(this, callback, type, quality); }
        }, originalToBlob);

        const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = maskFunction(function(...args) {
            const imageData = originalGetImageData.apply(this, args);
            return addNoise(imageData, seed);
        }, originalGetImageData);

        const originalMeasureText = CanvasRenderingContext2D.prototype.measureText;
        CanvasRenderingContext2D.prototype.measureText = maskFunction(function(text) {
            const metrics = originalMeasureText.call(this, text);
            if (metrics && metrics.width) {
                const noise = seededRandom(seed + text.length) * 0.1 - 0.05;
                const originalWidth = metrics.width;
                return new Proxy(metrics, {
                    get(target, prop) {
                        if (prop === 'width') return originalWidth + noise;
                        return target[prop];
                    }
                });
            }
            return metrics;
        }, originalMeasureText);
    })();

    // ==========================================
    // MODULE: WebGL Protection
    // ==========================================
    (function() {
        if (!config.webgl_enabled) return;
        const seed = config.webgl_noise_seed || 42;
        const vendorString = config.webgl_vendor;
        const rendererString = config.webgl_renderer;
        console.log('[thePrivator] WebGL protection enabled');

        function addWebGLNoise(pixels, seedBase) {
            if (!pixels || !pixels.length) return pixels;
            const len = pixels.length;
            for (let i = 0; i < len; i += 4) {
                const pixelSeed = seedBase + i;
                const noise = Math.floor(seededRandom(pixelSeed) * 5) - 2;
                pixels[i] = Math.max(0, Math.min(255, pixels[i] + noise));
                pixels[i + 1] = Math.max(0, Math.min(255, pixels[i + 1] + noise));
                pixels[i + 2] = Math.max(0, Math.min(255, pixels[i + 2] + noise));
            }
            return pixels;
        }

        function getParameterOverride(originalFn, context) {
            const masked = function(parameter) {
                try {
                    if ((parameter === 0x9245 || parameter === 0x1F00) && vendorString) return vendorString;
                    if ((parameter === 0x9246 || parameter === 0x1F01) && rendererString) return rendererString;
                } catch (e) { }
                
                const result = originalFn.call(context || this, parameter);
                
                try {
                    if (!vendorString && (parameter === 0x9245 || parameter === 0x1F00) && typeof result === 'string') {
                        return result + ' (' + Math.floor(seededRandom(seed + 1) * 1000) + ')';
                    }
                    if (!rendererString && (parameter === 0x9246 || parameter === 0x1F01) && typeof result === 'string') {
                        return result + ' (' + Math.floor(seededRandom(seed) * 1000) + ')';
                    }
                } catch (e) { }
                return result;
            };
            return maskFunction(masked, originalFn);
        }

        if (typeof WebGLRenderingContext !== 'undefined') {
            WebGLRenderingContext.prototype.getParameter = getParameterOverride(WebGLRenderingContext.prototype.getParameter);
            const originalReadPixels = WebGLRenderingContext.prototype.readPixels;
            WebGLRenderingContext.prototype.readPixels = maskFunction(function(...args) {
                const res = originalReadPixels.apply(this, args);
                if (args[6] && args[6].length) addWebGLNoise(args[6], seed);
                return res;
            }, originalReadPixels);
        }

        if (typeof WebGL2RenderingContext !== 'undefined') {
            WebGL2RenderingContext.prototype.getParameter = getParameterOverride(WebGL2RenderingContext.prototype.getParameter);
            const originalReadPixels2 = WebGL2RenderingContext.prototype.readPixels;
            WebGL2RenderingContext.prototype.readPixels = maskFunction(function(...args) {
                const res = originalReadPixels2.apply(this, args);
                if (args[6] && args[6].length) addWebGLNoise(args[6], seed);
                return res;
            }, originalReadPixels2);
        }

        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = maskFunction(function(type, ...args) {
            if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
                args[0] = (typeof args[0] === 'object') ? args[0] : {};
                args[0].preserveDrawingBuffer = true;
            }
            const context = originalGetContext.call(this, type, ...args);
            if (context && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
                if (context.getParameter !== WebGLRenderingContext.prototype.getParameter &&
                    context.getParameter !== WebGL2RenderingContext.prototype.getParameter &&
                    !context._privatorHooked) {
                    
                    context.getParameter = getParameterOverride(context.getParameter, context);
                    const originalInstReadPixels = context.readPixels;
                    context.readPixels = maskFunction(function(...args) {
                        const res = originalInstReadPixels.apply(this, args);
                        if (args[6] && args[6].length) addWebGLNoise(args[6], seed);
                        return res;
                    }, originalInstReadPixels);
                    context._privatorHooked = true;
                }
            }
            return context;
        }, originalGetContext);
    })();

    // ==========================================
    // MODULE: Audio Protection
    // ==========================================
    (function() {
        if (!config.audio_enabled) return;
        const seed = config.audio_noise_seed || 42;
        console.log('[thePrivator] Audio protection enabled');

        const audioContexts = [
            window.AudioContext, window.webkitAudioContext,
            window.OfflineAudioContext, window.webkitOfflineAudioContext
        ].filter(Boolean);

        audioContexts.forEach(function(AudioContextConstructor) {
            const originalCreateOscillator = AudioContextConstructor.prototype.createOscillator;
            AudioContextConstructor.prototype.createOscillator = maskFunction(function(...args) {
                const oscillator = originalCreateOscillator.apply(this, args);
                oscillator.frequency.value += seededRandom(seed) * 0.01;
                return oscillator;
            }, originalCreateOscillator);
            
            const originalCreateDynamicsCompressor = AudioContextConstructor.prototype.createDynamicsCompressor;
            AudioContextConstructor.prototype.createDynamicsCompressor = maskFunction(function(...args) {
                const compressor = originalCreateDynamicsCompressor.apply(this, args);
                compressor.threshold.value += seededRandom(seed + 1) * 0.1;
                return compressor;
            }, originalCreateDynamicsCompressor);
        });
        
        if (typeof AnalyserNode !== 'undefined') {
            const originalGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
            AnalyserNode.prototype.getFloatFrequencyData = maskFunction(function(array) {
                originalGetFloatFrequencyData.call(this, array);
                const noise = seededRandom(seed) * 0.1;
                for (let i = 0; i < array.length; i++) array[i] += seededRandom(seed + i) * noise;
                return array;
            }, originalGetFloatFrequencyData);

            const originalGetByteFrequencyData = AnalyserNode.prototype.getByteFrequencyData;
            AnalyserNode.prototype.getByteFrequencyData = maskFunction(function(array) {
                originalGetByteFrequencyData.call(this, array);
                for (let i = 0; i < array.length; i++) {
                    const noise = Math.floor(seededRandom(seed + i) * 3) - 1;
                    array[i] = Math.max(0, Math.min(255, array[i] + noise));
                }
                return array;
            }, originalGetByteFrequencyData);
        }
    })();

})();
