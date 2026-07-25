/*
 * app.js — camera plumbing, detection loop, tracking, and overlay UI.
 */
(() => {
  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  const octx = overlay.getContext('2d');
  const startScreen = document.getElementById('start-screen');
  const cameraScreen = document.getElementById('camera-screen');
  const startBtn = document.getElementById('start-btn');
  const statusPill = document.getElementById('status-pill');
  const scorecard = document.getElementById('scorecard');
  const bestScoreEl = document.getElementById('best-score');
  const fpsEl = document.getElementById('fps');
  const errorBanner = document.getElementById('error-banner');

  const barEls = {
    fieldspot: document.getElementById('bar-fieldspot'),
    dullness: document.getElementById('bar-dullness'),
    roundness: document.getElementById('bar-roundness'),
    stripes: document.getElementById('bar-stripes'),
    webbing: document.getElementById('bar-webbing'),
    size: document.getElementById('bar-size'),
  };

  // offscreen canvas for downscaled processing
  const proc = document.createElement('canvas');
  const pctx = proc.getContext('2d', { willReadFrequently: true });

  const DETECT_INTERVAL_MS = 120;
  let lastDetect = 0;
  let tracks = [];      // smoothed detections carried across frames
  let nextTrackId = 1;
  let frameTimes = [];

  // ---------------------------------------------------------------- camera
  async function startCamera() {
    startBtn.disabled = true;
    startBtn.textContent = 'Opening camera…';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      startScreen.hidden = true;
      cameraScreen.hidden = false;
      resize();
      requestAnimationFrame(loop);
    } catch (err) {
      startBtn.disabled = false;
      startBtn.textContent = 'Open Camera';
      alert(
        'Could not open the camera: ' + err.message +
        '\n\nMake sure you granted camera permission and that the page is served over HTTPS.'
      );
    }
  }

  function resize() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    overlay.width = vw;
    overlay.height = vh;
    proc.width = Vision.PROC_WIDTH;
    proc.height = Math.round(Vision.PROC_WIDTH * vh / vw);
  }

  // ------------------------------------------------------------- tracking
  function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a.w * a.h + b.w * b.h - inter);
  }

  // Exponential smoothing keeps boxes/scores steady while the hand wobbles.
  function updateTracks(detections) {
    const ALPHA = 0.35;
    const matched = new Set();

    for (const track of tracks) {
      let best = null, bestIou = 0.3; // min overlap to count as same melon
      for (const det of detections) {
        if (matched.has(det)) continue;
        const v = iou(track, det);
        if (v > bestIou) { bestIou = v; best = det; }
      }
      if (best) {
        matched.add(best);
        track.x += ALPHA * (best.x - track.x);
        track.y += ALPHA * (best.y - track.y);
        track.w += ALPHA * (best.w - track.w);
        track.h += ALPHA * (best.h - track.h);
        track.score += ALPHA * (best.score - track.score);
        for (const k in best.features) {
          track.features[k] += ALPHA * (best.features[k] - track.features[k]);
        }
        track.misses = 0;
        track.age++;
      } else {
        track.misses++;
      }
    }

    for (const det of detections) {
      if (!matched.has(det)) {
        tracks.push({ ...det, features: { ...det.features }, id: nextTrackId++, misses: 0, age: 1 });
      }
    }

    // drop tracks not seen for ~0.6 s
    tracks = tracks.filter(t => t.misses < 5);
  }

  // -------------------------------------------------------------- drawing
  function draw() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const sx = overlay.width / proc.width;
    const sy = overlay.height / proc.height;

    // only trust tracks that have been seen a few frames
    const stable = tracks.filter(t => t.age >= 3);
    if (stable.length === 0) {
      statusPill.textContent = 'Looking for watermelons…';
      statusPill.classList.remove('found');
      scorecard.hidden = true;
      return;
    }

    const best = stable.reduce((a, b) => (b.score > a.score ? b : a));

    for (const t of stable) {
      const x = t.x * sx, y = t.y * sy, w = t.w * sx, h = t.h * sy;
      const isBest = t === best;
      const score = Math.round(t.score);

      octx.lineWidth = isBest ? 6 : 3;
      octx.strokeStyle = isBest ? '#22e06c' : 'rgba(255,255,255,0.75)';
      octx.setLineDash(isBest ? [] : [12, 8]);
      roundRect(octx, x, y, w, h, 14);
      octx.stroke();
      octx.setLineDash([]);

      // label chip
      const label = isBest ? `🏆 PICK ME · ${score}` : `${score}`;
      octx.font = `${isBest ? 'bold 30px' : '24px'} -apple-system, system-ui, sans-serif`;
      const tw = octx.measureText(label).width;
      const pad = 10;
      const ly = Math.max(y - 44, 4);
      octx.fillStyle = isBest ? '#22e06c' : 'rgba(0,0,0,0.6)';
      roundRect(octx, x, ly, tw + pad * 2, 40, 10);
      octx.fill();
      octx.fillStyle = isBest ? '#06230f' : '#ffffff';
      octx.fillText(label, x + pad, ly + 29);
    }

    statusPill.textContent = stable.length === 1
      ? '1 watermelon in view'
      : `${stable.length} watermelons — green box wins`;
    statusPill.classList.add('found');

    // breakdown card for the winner
    scorecard.hidden = false;
    bestScoreEl.textContent = `${Math.round(best.score)} / 100`;
    for (const k in barEls) {
      barEls[k].style.width = `${Math.round(best.features[k] * 100)}%`;
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ----------------------------------------------------------------- loop
  function loop(ts) {
    if (video.videoWidth && overlay.width !== video.videoWidth) resize();

    if (video.videoWidth && ts - lastDetect >= DETECT_INTERVAL_MS) {
      lastDetect = ts;
      try {
        pctx.drawImage(video, 0, 0, proc.width, proc.height);
        const detections = Vision.detect(pctx, proc.width, proc.height);
        updateTracks(detections);
        draw();
      } catch (err) {
        errorBanner.hidden = false;
        errorBanner.textContent = 'Detection error: ' + err.message;
      }

      frameTimes.push(ts);
      frameTimes = frameTimes.filter(t => ts - t < 2000);
      fpsEl.textContent = `${(frameTimes.length / 2).toFixed(0)} scans/s`;
    }
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- boot
  startBtn.addEventListener('click', startCamera);
  window.addEventListener('resize', resize);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
