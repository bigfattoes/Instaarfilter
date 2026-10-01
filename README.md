# Become Acti: ActivateMe™ Fest AR filter

A free web AR filter for **ActivateMe™ Fest**. People open a link, and their phone camera shows them:

- 🧢 **Acti's cap in 3D**, tracked onto every face in the shot (up to 3, so whole families can join in). It turns, tilts and nods with the head. Add `?cap=2d` to the link for the original flat cap.
- 🧡 **Acti's orange nose** (can be turned off)
- 🎲 **Spin!**: a "What should I try?" randomizer above each head that lands on an activity (football, dance, VR, e-gaming…) with confetti
- A branded frame with the logo, **@activatemefest**, the dates (**16–17 Jan 2027**), the venue (**Dubai Silicon Oasis**), and Acti waving

**Tap** the shutter for a photo and **hold** it for a video of up to 15 seconds. **Share** opens the phone's share sheet, so people can post straight to their Instagram story and tag @activatemefest.

It runs entirely in the browser (Google MediaPipe face tracking). There's no app to install, nothing is uploaded, and it costs nothing to host.

> **Why not a "real" Instagram filter?** Meta shut down Spark AR in January 2025, and Instagram no longer accepts third-party AR effects. A web filter linked from the bio and stories is the free way to do this now.

## Put it online (free)

The site is plain static files, so any static host works. Pick one:

### Option A: GitHub Pages
GitHub Pages is free for **public** repos (private repos need a paid GitHub plan).
1. Merge this branch into `main`.
2. Repo **Settings → General → Danger zone → Change visibility → Public** (everything here is public-facing anyway).
3. **Settings → Pages → Build and deployment → Deploy from a branch →** `main` / `(root)` → **Save**.
4. After about a minute it's live at `https://bigfattoes.github.io/Instaarfilter/`.

### Option B: Cloudflare Pages or Netlify (keeps the repo private)
1. Sign up free at pages.cloudflare.com (or netlify.com) and **Import from GitHub**, then pick this repo.
2. Build command: *none*. Output directory: `/` (root).
3. You get a free `*.pages.dev` / `*.netlify.app` link. You can also attach a custom domain such as `filter.activatemefest.com`.

## Getting people to use it
- Put the link in **@activatemefest's bio** and use a **link sticker** in stories.
- Print a **QR code** of the link on event signage, wristbands, and the photo spot.
- Ask people to tag **@activatemefest** so you can repost the best ones.

**Inside Instagram's in-app browser** the camera sometimes won't open. The page detects this and tells people to tap **⋯ → Open in browser**.

## Try it locally
The camera needs `https` or `localhost`:
```bash
python3 -m http.server 8000
# open http://localhost:8000 on this computer
```
To test on a phone, deploy it, or use a tunnel such as `npx localtunnel --port 8000`.

## Customising
Everything lives in `js/app.js`:

| What | Where |
|---|---|
| Spinner activities | `ACTIVITIES` list near the top |
| Brand colours | `COLORS` (and `:root` in `css/style.css`) |
| Dates, venue, Instagram handle | `EVENT` near the top |
| 3D cap shape, colours, position | `TUNE` and `COLORS` in `js/cap3d.js` |
| Flat (2D) cap size / position | `CAP.scale` and `drawCap()` |
| Max video length | `MAX_RECORD_MS` |

Assets are in `assets/`: `cap.png` (cut from the Acti artwork), `acti.webp`, `logo.png`, icons, and `og.jpg` (the link preview image).

## Files
```
index.html            page + UI
css/style.css         styles
js/app.js             camera, face tracking, drawing, capture, sharing
js/cap3d.js           the 3D cap (three.js)
assets/               Acti, cap, logo, icons
vendor/mediapipe/     MediaPipe face tracking (self-hosted)
vendor/three/         three.js 3D library (self-hosted, MIT)
models/               face landmark model
```
