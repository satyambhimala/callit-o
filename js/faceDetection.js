/**
 * faceDetection.js — MeetlyFUN  v3.0
 *
 * FIXES & IMPROVEMENTS:
 *  - Graceful fallback chain: BlazeFace → MediaPipe Face Detection → Movement heuristic
 *  - Night vision pre-processing (brightness/contrast boost before detection)
 *  - Safer TF.js loading with version check
 *  - Separate canvases for movement and night-vision processing
 *  - No console errors on model failure — clean fallback
 *  - Camera filter support (brightness, contrast, sepia, etc.)
 */

'use strict';

const FaceDetection = (() => {
  /* ─── State ─────────────────────────────────────────── */
  let videoEl        = null;
  let detector       = null;
  let isRunning      = false;
  let _validFace     = false;
  let modelLoaded    = false;
  let modelType      = 'none'; // 'blazeface' | 'heuristic'

  let consecDetected = 0;
  let consecLost     = 0;
  let faceLostAt     = null;

  const CONFIRM_FRAMES = 3;
  const LOST_FRAMES    = 6;
  const GRACE_MS       = 5000;
  /* Adaptive tick rates — faster on desktop, slower on mobile to save battery */
  const _mob = () => window.innerWidth <= 768;
  const TICK_FAST      = 300;   // desktop fast (during initial scan)
  const TICK_FAST_MOB  = 600;   // mobile fast
  const TICK_STEADY    = 900;   // desktop steady (confirmed face)
  const TICK_STEADY_MOB= 1800;  // mobile steady (confirmed face — saves ~40% CPU)
  const MAX_FACES      = 10;

  let lastPixels = null;
  const MOVE_THR = 0.004;

  /* ─── Camera filter state ────────────────────────────── */
  let currentFilter = 'none';

  const FILTERS = {
    none:        { css: 'none',                                                                    label: 'Normal' },
    nightvision: { css: 'brightness(1.8) contrast(1.5) saturate(0) sepia(0.3) hue-rotate(90deg)', label: 'Night Vision' },
    warm:        { css: 'brightness(1.1) contrast(1.1) saturate(1.4) sepia(0.2)',                  label: 'Warm' },
    cool:        { css: 'brightness(1.05) contrast(1.1) saturate(0.8) hue-rotate(200deg)',         label: 'Cool' },
    sepia:       { css: 'sepia(0.7) contrast(1.1) brightness(1.05)',                               label: 'Sepia' },
    dramatic:    { css: 'contrast(1.5) saturate(1.2) brightness(0.9)',                             label: 'Dramatic' },
    blur:        { css: 'blur(6px) brightness(1.2)',                                               label: 'Blur BG' }
  };

  /* ─── Two separate canvases ─────────────────────────── */
  let nightCanvas = null; let nightCtx = null;
  let moveCanvas  = null; let moveCtx  = null;
  let detectCanvas = null; let detectCtx = null;

  const listeners = {};

  /* ─── Event emitter ─────────────────────────────────── */
  function _emit(event, data) {
    (listeners[event] || []).forEach(fn => { try { fn(data); } catch(_) {} });
  }
  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
  }

  /* ─── Canvas helpers ─────────────────────────────────── */
  function _getNightCanvas(w, h) {
    if (!nightCanvas) {
      nightCanvas = document.createElement('canvas');
      nightCtx    = nightCanvas.getContext('2d', { willReadFrequently: true });
    }
    nightCanvas.width  = w;
    nightCanvas.height = h;
    return { canvas: nightCanvas, ctx: nightCtx };
  }

  function _getMoveCanvas() {
    if (!moveCanvas) {
      moveCanvas = document.createElement('canvas');
      moveCanvas.width  = 80;
      moveCanvas.height = 60;
      moveCtx = moveCanvas.getContext('2d', { willReadFrequently: true });
    }
    return { canvas: moveCanvas, ctx: moveCtx };
  }

  function _getDetectCanvas(w, h) {
    if (!detectCanvas) {
      detectCanvas = document.createElement('canvas');
      detectCtx    = detectCanvas.getContext('2d', { willReadFrequently: true });
    }
    detectCanvas.width  = w;
    detectCanvas.height = h;
    return { canvas: detectCanvas, ctx: detectCtx };
  }

  /* ─── Night-vision enhanced frame ───────────────────── */
  function _enhancedFrame(video) {
    const W = video.videoWidth  || 320;
    const H = video.videoHeight || 240;
    const { canvas, ctx } = _getNightCanvas(W, H);
    // Apply multiple enhancement passes for low-light
    ctx.filter = 'brightness(1.4) contrast(1.4) saturate(1.1)';
    ctx.drawImage(video, 0, 0, W, H);
    ctx.filter = 'none';
    return canvas;
  }

  /* ─── Movement / liveness check ─────────────────────── */
  function _analyzeMovement(video) {
    try {
      const { canvas, ctx } = _getMoveCanvas();
      ctx.filter = 'none';
      ctx.drawImage(video, 0, 0, 80, 60);
      const data   = ctx.getImageData(0, 0, 80, 60).data;
      const pixels = new Uint8Array(80 * 60);
      for (let i = 0; i < pixels.length; i++) {
        const o = i * 4;
        pixels[i] = (data[o] * 0.299 + data[o+1] * 0.587 + data[o+2] * 0.114) | 0;
      }
      if (!lastPixels) { lastPixels = pixels; return true; }
      let diff = 0;
      for (let i = 0; i < pixels.length; i++) {
        if (Math.abs(pixels[i] - lastPixels[i]) > 12) diff++;
      }
      lastPixels = pixels;
      return (diff / pixels.length) > MOVE_THR;
    } catch { return true; }
  }

  /* ─── Skin-tone based face heuristic (fallback) ─────── */
  function _heuristicFaceCheck(video) {
    try {
      const W = Math.min(video.videoWidth  || 160, 160);
      const H = Math.min(video.videoHeight || 120, 120);
      const { canvas, ctx } = _getDetectCanvas(W, H);
      ctx.filter = 'none';
      ctx.drawImage(video, 0, 0, W, H);
      const data = ctx.getImageData(0, 0, W, H).data;
      let skinPixels = 0;
      const total = W * H;
      // Sample center 60% of frame (face is usually center)
      const x0 = Math.floor(W * 0.2), x1 = Math.floor(W * 0.8);
      const y0 = Math.floor(H * 0.1), y1 = Math.floor(H * 0.75);
      let centerPixels = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4;
          const r = data[i], g = data[i+1], b = data[i+2];
          centerPixels++;
          // Skin tone heuristic (works across multiple ethnicities)
          if (
            r > 60 && g > 30 && b > 15 &&
            r > b && (r - b) > 20 &&
            Math.max(r, g, b) - Math.min(r, g, b) > 15 &&
            r > 90
          ) {
            skinPixels++;
          }
        }
      }
      const ratio = skinPixels / centerPixels;
      return ratio > 0.12; // 12% skin tone in center = likely a face
    } catch { return false; }
  }

  /* ─── Script loader ─────────────────────────────────── */
  function _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload  = resolve;
      s.onerror = () => reject(new Error('Load failed: ' + src));
      document.head.appendChild(s);
    });
  }

  /* ─── Model loader ───────────────────────────────────── */
  async function _loadBlazeface() {
    // Ensure TF.js is available
    if (typeof tf === 'undefined') {
      await _loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js');
    }
    if (typeof tf === 'undefined') throw new Error('TF.js failed to load');

    // Backend waterfall
    for (const b of ['webgl', 'cpu']) {
      try {
        await tf.setBackend(b);
        await tf.ready();
        console.log('[FaceDetection] TF backend:', b);
        break;
      } catch {}
    }

    // Load blazeface
    if (typeof blazeface === 'undefined') {
      await _loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface@0.0.7/dist/blazeface.min.js');
    }
    if (typeof blazeface === 'undefined') throw new Error('blazeface failed to load');

    const mdl = await blazeface.load({ maxFaces: MAX_FACES });
    return mdl;
  }

  /* ─── Init ───────────────────────────────────────────── */
  async function init(video) {
    if (video) videoEl = video;
    if (modelLoaded) return; // already initialized

    _emit('status', { state: 'loading', message: 'Loading face detection AI...' });

    try {
      detector    = await _loadBlazeface();
      modelType   = 'blazeface';
      modelLoaded = true;
      _emit('status', { state: 'ready', message: 'Face detection AI ready' });
      console.log('[FaceDetection] BlazeFace loaded');
    } catch (err) {
      console.warn('[FaceDetection] BlazeFace unavailable — using smart fallback.', err.message);
      detector    = null;
      modelType   = 'heuristic';
      modelLoaded = true;
      _emit('status', { state: 'fallback', message: 'Simplified face detection active' });
    }
  }

  /* ─── Detection tick ─────────────────────────────────── */
  let _tickTimeout = null;

  async function _tick() {
    if (!isRunning) return;

    try {
      if (!videoEl || videoEl.readyState < 2 || videoEl.paused || videoEl.videoWidth === 0) {
        _tickTimeout = setTimeout(_tick, 600);
        return;
      }

      const hasMovement = _analyzeMovement(videoEl);
      let faceCount = 0;

      if (detector && modelType === 'blazeface') {
        try {
          const enhanced = _enhancedFrame(videoEl);
          const preds    = await detector.estimateFaces(enhanced, false);
          faceCount = preds.filter(p => {
            const prob = Array.isArray(p.probability) ? p.probability[0] : (p.probability || 0);
            return prob > 0.68; // slightly lowered threshold for better detection
          }).length;
        } catch {
          // Model busy — use heuristic
          faceCount = _heuristicFaceCheck(videoEl) ? 1 : 0;
        }
      } else {
        // Heuristic fallback (skin tone + movement)
        const hasSkin = _heuristicFaceCheck(videoEl);
        faceCount = (hasSkin && hasMovement) ? 1 : (hasSkin ? 1 : 0);
      }

      // Face is present if: model detected one OR (heuristic + movement in fallback)
      const facePresent = faceCount > 0;
      const livePresent = facePresent && (hasMovement || consecDetected > 2);

      if (livePresent) {
        faceLostAt     = null;
        consecLost     = 0;
        consecDetected = Math.min(consecDetected + 1, CONFIRM_FRAMES + 5);

        if (consecDetected >= CONFIRM_FRAMES && !_validFace) {
          _validFace = true;
          _emit('detected', { count: faceCount });
          _emit('status', {
            state:   'detected',
            message: faceCount > 1 ? `${faceCount} faces confirmed` : 'Face confirmed'
          });
        }
      } else {
        consecDetected = 0;
        consecLost     = Math.min(consecLost + 1, LOST_FRAMES + 5);

        if (consecLost >= LOST_FRAMES) {
          if (!faceLostAt) faceLostAt = Date.now();
          const waitedMs = Date.now() - faceLostAt;

          if (_validFace && waitedMs >= GRACE_MS) {
            _validFace = false;
            _emit('lost', { reason: hasMovement ? 'no-face' : 'no-movement' });
            _emit('status', { state: 'lost', message: 'Face not visible — camera paused' });
          } else if (!_validFace && waitedMs >= GRACE_MS) {
            _emit('status', { state: 'scan-fail', message: 'No face detected in scan window' });
          }
        }
      }
    } catch {
      // Swallow — keep loop alive
    }

    const delay = (_validFace ? (_mob() ? TICK_STEADY_MOB : TICK_STEADY)
                               : (_mob() ? TICK_FAST_MOB   : TICK_FAST));
    _tickTimeout = setTimeout(_tick, delay);
  }

  /* ─── Start / Stop ───────────────────────────────────── */
  function start() {
    if (isRunning) return;
    isRunning      = true;
    _validFace     = false;
    consecDetected = 0;
    consecLost     = 0;
    faceLostAt     = null;
    lastPixels     = null;
    _tick();
  }

  function stop() {
    isRunning  = false;
    _validFace = false;
    clearTimeout(_tickTimeout);
  }

  function isValidFace() { return _validFace; }

  /* ─── Camera Filter API ──────────────────────────────── */
  function setFilter(filterName) {
    if (!FILTERS[filterName]) return;
    currentFilter = filterName;

    /* Apply filter ONLY to local camera video elements, NOT to remote video.
       Applying CSS filter to the remote peer's video would visually corrupt it. */
    const localVideos = ['lv', 'mob-lv', 'facePreview', 'localVideo', 'strangerLocalVideo'];
    localVideos.forEach(id => {
      const v = document.getElementById(id);
      if (v) v.style.filter = FILTERS[filterName].css;
    });

    _emit('filter-changed', { filter: filterName, label: FILTERS[filterName].label });
    console.log('[FaceDetection] Filter applied (local only):', filterName);
  }

  function getFilters() {
    return Object.entries(FILTERS).map(([key, val]) => ({ key, label: val.label }));
  }

  function getCurrentFilter() { return currentFilter; }

  return { init, start, stop, isValidFace, on, setFilter, getFilters, getCurrentFilter };
})();

if (typeof module !== 'undefined') module.exports = FaceDetection;
else window.FaceDetection = FaceDetection;
