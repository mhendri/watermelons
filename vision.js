/*
 * vision.js — watermelon detection + quality scoring.
 *
 * Pipeline (runs on a downscaled frame, ~40k px, every ~120 ms):
 *   1. HSV color segmentation  -> binary mask of watermelon-rind pixels
 *   2. Morphological open      -> drop speckle noise
 *   3. Connected components    -> candidate blobs with bounding boxes
 *   4. Blob filtering          -> area / aspect / fill-ratio gates
 *   5. Feature extraction      -> field spot, dullness, roundness,
 *                                 stripe contrast, webbing, size
 *   6. Weighted score 0–100 per melon
 */

const Vision = (() => {

  // ---- tunables -----------------------------------------------------------
  const PROC_WIDTH = 200;          // downscale width for processing
  const MIN_BLOB_FRAC = 0.008;     // blob must cover ≥0.8% of frame
  const MAX_BLOB_FRAC = 0.90;
  const MIN_FILL = 0.35;           // blob px / bbox px (melons are convex)
  const MAX_ASPECT = 2.6;          // long side / short side

  const WEIGHTS = {
    fieldspot: 30,
    dullness: 20,
    roundness: 15,
    stripes: 15,
    webbing: 10,
    size: 10,
  };

  // ---- helpers ------------------------------------------------------------

  // rgb (0-255) -> h (0-360), s (0-1), v (0-1)
  function rgb2hsv(r, g, b, out) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
    }
    out.h = h;
    out.s = max === 0 ? 0 : d / max;
    out.v = max / 255;
  }

  const clamp01 = x => Math.max(0, Math.min(1, x));

  // Watermelon rind: dark green through pale green-yellow stripe.
  function isRind(h, s, v) {
    // dark green rind
    if (h >= 70 && h <= 170 && s >= 0.25 && v >= 0.06 && v <= 0.85) return true;
    // pale/yellow-green light stripe
    if (h >= 45 && h <= 90 && s >= 0.15 && v >= 0.35) return true;
    // very dark, slightly green pixels (deep rind in shadow)
    if (h >= 60 && h <= 180 && s >= 0.15 && v >= 0.04 && v < 0.25) return true;
    return false;
  }

  // Creamy/yellow field spot (ground patch on a ripe melon).
  function isFieldSpot(h, s, v) {
    return h >= 35 && h <= 70 && s >= 0.12 && s <= 0.65 && v >= 0.5;
  }

  // Brown sugar webbing / pollination scars.
  function isWebbing(h, s, v) {
    return h >= 15 && h <= 45 && s >= 0.2 && s <= 0.7 && v >= 0.25 && v <= 0.68;
  }

  // Specular highlight (shiny = underripe).
  function isSpecular(s, v) {
    return v >= 0.92 && s <= 0.22;
  }

  // ---- morphological open (3x3) on a Uint8 mask ---------------------------
  function morphOpen(mask, w, h) {
    const eroded = new Uint8Array(mask.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (mask[i] &&
            mask[i - 1] && mask[i + 1] &&
            mask[i - w] && mask[i + w]) {
          eroded[i] = 1;
        }
      }
    }
    const dilated = new Uint8Array(mask.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (eroded[i] || eroded[i - 1] || eroded[i + 1] ||
            eroded[i - w] || eroded[i + w]) {
          dilated[i] = 1;
        }
      }
    }
    return dilated;
  }

  // ---- connected components via iterative flood fill ----------------------
  function findBlobs(mask, w, h) {
    const labels = new Int32Array(mask.length); // 0 = unlabeled
    const blobs = [];
    const stack = new Int32Array(mask.length);
    let nextLabel = 1;

    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || labels[start]) continue;

      let sp = 0;
      stack[sp++] = start;
      labels[start] = nextLabel;

      let area = 0;
      let minX = w, maxX = 0, minY = h, maxY = 0;
      let sumX = 0, sumY = 0;
      const pixels = [];

      while (sp > 0) {
        const idx = stack[--sp];
        const x = idx % w, y = (idx / w) | 0;
        area++;
        sumX += x; sumY += y;
        pixels.push(idx);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        // 4-connectivity
        if (x > 0     && mask[idx - 1] && !labels[idx - 1]) { labels[idx - 1] = nextLabel; stack[sp++] = idx - 1; }
        if (x < w - 1 && mask[idx + 1] && !labels[idx + 1]) { labels[idx + 1] = nextLabel; stack[sp++] = idx + 1; }
        if (y > 0     && mask[idx - w] && !labels[idx - w]) { labels[idx - w] = nextLabel; stack[sp++] = idx - w; }
        if (y < h - 1 && mask[idx + w] && !labels[idx + w]) { labels[idx + w] = nextLabel; stack[sp++] = idx + w; }
      }

      blobs.push({
        label: nextLabel++,
        area,
        x: minX, y: minY,
        w: maxX - minX + 1,
        h: maxY - minY + 1,
        cx: sumX / area,
        cy: sumY / area,
        pixels,
      });
    }
    return blobs;
  }

  // ---- feature extraction + scoring ---------------------------------------
  function scoreBlob(blob, hsv, procW, procH) {
    const bboxArea = blob.w * blob.h;
    const frameArea = procW * procH;

    // Field spot, webbing, and specular pixels are — by definition — NOT
    // rind-colored, so they fall outside the green mask. Scan the full
    // bounding box for them instead of just the blob's mask pixels.
    let fieldSpotPx = 0, webbingPx = 0, specularPx = 0;
    for (let y = blob.y; y < blob.y + blob.h; y++) {
      for (let x = blob.x; x < blob.x + blob.w; x++) {
        const j = (y * procW + x) * 3;
        const h = hsv[j] * 1.5, s = hsv[j + 1] / 255, v = hsv[j + 2] / 255;
        if (isFieldSpot(h, s, v)) fieldSpotPx++;
        else if (isWebbing(h, s, v)) webbingPx++;
        if (isSpecular(s, v)) specularPx++;
      }
    }

    // Brightness statistics over the rind itself (stripe contrast).
    let sumV = 0, sumV2 = 0;
    for (const idx of blob.pixels) {
      const v = hsv[idx * 3 + 2] / 255;
      sumV += v;
      sumV2 += v * v;
    }

    const n = blob.pixels.length;
    const meanV = sumV / n;
    const stdV = Math.sqrt(Math.max(0, sumV2 / n - meanV * meanV));

    // --- individual features, each 0..1 ---
    const features = {
      // yellow belly patch: saturates once ~14% of bbox is field-spot colored
      fieldspot: clamp01((fieldSpotPx / bboxArea) / 0.14),
      // matte skin: penalize specular highlights (saturates at 6% shiny px)
      dullness: clamp01(1 - (specularPx / bboxArea) / 0.06),
      // aspect ratio near 1 and convex fill
      roundness: clamp01((Math.min(blob.w, blob.h) / Math.max(blob.w, blob.h)) *
                         clamp01((blob.area / bboxArea) / 0.785)),
      // brightness bimodality inside the rind ≈ stripe contrast
      stripes: clamp01(stdV / 0.16),
      // sugar webbing: saturates at 5% of bbox px
      webbing: clamp01((webbingPx / bboxArea) / 0.05),
      // relative size in frame: saturates at 12% of frame
      size: clamp01((blob.area / frameArea) / 0.12),
    };

    let score = 0;
    for (const k in WEIGHTS) score += WEIGHTS[k] * features[k];

    return { score: Math.round(score), features };
  }

  // ---- main entry ---------------------------------------------------------
  // ctx: 2d context already containing the downscaled frame.
  // Returns array of detections in *processing* coordinates.
  function detect(ctx, procW, procH) {
    const img = ctx.getImageData(0, 0, procW, procH);
    const data = img.data;
    const nPx = procW * procH;

    const mask = new Uint8Array(nPx);
    // hsv stored compactly: h/1.5 (0-240), s*255, v*255
    const hsv = new Uint8ClampedArray(nPx * 3);
    const tmp = { h: 0, s: 0, v: 0 };

    for (let i = 0; i < nPx; i++) {
      const p = i * 4;
      rgb2hsv(data[p], data[p + 1], data[p + 2], tmp);
      const j = i * 3;
      hsv[j] = tmp.h / 1.5;
      hsv[j + 1] = tmp.s * 255;
      hsv[j + 2] = tmp.v * 255;
      if (isRind(tmp.h, tmp.s, tmp.v)) mask[i] = 1;
    }

    const cleaned = morphOpen(mask, procW, procH);
    const blobs = findBlobs(cleaned, procW, procH);

    const detections = [];
    for (const blob of blobs) {
      const frac = blob.area / nPx;
      if (frac < MIN_BLOB_FRAC || frac > MAX_BLOB_FRAC) continue;
      const aspect = Math.max(blob.w, blob.h) / Math.min(blob.w, blob.h);
      if (aspect > MAX_ASPECT) continue;
      if (blob.area / (blob.w * blob.h) < MIN_FILL) continue;

      const { score, features } = scoreBlob(blob, hsv, procW, procH);
      detections.push({
        x: blob.x, y: blob.y, w: blob.w, h: blob.h,
        cx: blob.cx, cy: blob.cy,
        score, features,
      });
    }

    // biggest melons first so tracking prefers stable large blobs
    detections.sort((a, b) => b.score - a.score);
    return detections;
  }

  return { detect, PROC_WIDTH, WEIGHTS };
})();
