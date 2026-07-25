# 🍉 Melon Scout

A phone app that tells you which watermelon to pick at the supermarket.
Point your camera at the bin: every watermelon in view gets a bounding box,
and the best one gets a big green **🏆 PICK ME** box plus a live score
breakdown.

It's a progressive web app (PWA) — no app store needed. Open the URL on
your phone, tap **Open Camera**, and optionally "Add to Home Screen" to
install it. All computer vision runs on-device in the browser; no video
ever leaves your phone, and it works offline once loaded.

## How it decides

The vision pipeline runs ~8 times per second on a downscaled camera frame:

1. **HSV color segmentation** — masks watermelon-rind pixels (dark green
   rind + pale green-yellow stripes).
2. **Morphological open** — removes speckle noise.
3. **Connected components** — groups rind pixels into candidate blobs and
   fits bounding boxes.
4. **Blob filtering** — rejects blobs that are too small, too elongated, or
   too hollow to be a melon.
5. **Feature scoring** — each melon gets 0–100 from the classic
   pick-a-melon heuristics:

   | Feature | Weight | What it measures |
   |---|---|---|
   | Field spot | 30 | Creamy-yellow belly patch = ripened on the ground |
   | Dull skin | 20 | Matte rind is ripe; shiny is underripe (specular-highlight penalty) |
   | Roundness | 15 | Rounder melons tend to be sweeter |
   | Stripes | 15 | Brightness bimodality inside the rind ≈ stripe contrast |
   | Webbing | 10 | Brown sugar-scarring = well-pollinated, sweeter |
   | Size | 10 | Bigger blob in frame scores slightly higher |

6. **Tracking** — detections are matched frame-to-frame by IoU and
   exponentially smoothed, so boxes and scores stay steady in a wobbling
   hand.

The winner is drawn with a solid green box; the bottom card shows its
per-feature breakdown as live bars.

## Running it

Camera access requires a **secure context** (HTTPS, or `localhost`).

**Easiest: GitHub Pages.** Enable Pages for this repo (serve from this
branch, root), then open
`https://<user>.github.io/<repo>/` on your phone.

**Local dev on your phone:**

```bash
python3 -m http.server 8000
```

Then either open `http://localhost:8000` in a desktop browser (webcam), or
tunnel it to your phone with something that gives you HTTPS, e.g.
`npx ngrok http 8000`.

## Files

- `index.html` — start screen + camera view + score card
- `vision.js` — the CV pipeline: segmentation, blob detection, feature
  extraction, scoring (all tunables at the top)
- `app.js` — camera plumbing, detection loop, IoU tracking, overlay drawing
- `style.css`, `icon.svg`, `manifest.webmanifest`, `sw.js` — UI and PWA
  install/offline support

## Honest limitations

This is heuristic computer vision, not a trained neural network — there is
no public "watermelon quality" model to lean on. It does well on a bin of
striped melons in decent lighting; it can be fooled by other green produce,
green packaging, or heavy color-cast lighting. The one attribute that
matters most in real life — the hollow "thump" sound — needs a microphone
feature, which would be a fun v2. Tune the thresholds at the top of
`vision.js` if your supermarket's lighting misbehaves.
