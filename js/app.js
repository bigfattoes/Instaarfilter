import { FaceLandmarker, FilesetResolver } from '../vendor/mediapipe/vision_bundle.mjs';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const W = 1080;
const H = 1920;
const MAX_FACES = 3;
const MAX_RECORD_MS = 15000;
const HOLD_TO_RECORD_MS = 300;
const SAFE_TOP = 190; // Instagram story progress bar + profile row
const FOOTER_TOP = 1440; // top of the @activatemefest tab
const BADGE_HEIGHT = 3.15; // badge height (pill + tag) in units of its font size

const COLORS = {
  purple: '#4a01e0',
  violet: '#5b4fe0',
  magenta: '#b01ab8',
  pink: '#f83840',
  orange: '#fc8700',
  ink: '#1b0b46',
};
const CONFETTI_COLORS = [COLORS.purple, COLORS.violet, COLORS.pink, COLORS.orange, '#ffffff', '#ffd23f'];

// Where the cap image meets the forehead: x = centre of the logo, y = bottom of the brim (fractions of cap.png).
const CAP = { anchorX: 0.54, anchorY: 0.63, scale: 1.5, aspect: 332 / 539 };

// What the spinner can land on: the activities at the festival.
const ACTIVITIES = [
  ['⚽', 'FOOTBALL'],
  ['🏀', 'BASKETBALL'],
  ['🏏', 'CRICKET'],
  ['🎾', 'TENNIS'],
  ['🏊', 'SWIMMING'],
  ['🤸', 'GYMNASTICS'],
  ['🥊', 'BOXING'],
  ['⛸️', 'SKATING'],
  ['🚴', 'CYCLING'],
  ['🎮', 'VR & ESPORTS'],
  ['♟️', 'CHESS'],
  ['🎨', 'CREATIVITY'],
];

// Shown in the footer of every photo and video
const EVENT = {
  dates: '16–17 JAN 2027',
  venue: 'DUBAI SILICON OASIS',
  handle: '@activatemefest',
};

const FONT = '"Baloo 2", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

// FaceMesh landmark indices
const LM = { leftCheek: 234, rightCheek: 454, foreheadTop: 10, forehead: 151, chin: 152, noseTip: 4 };

// The 3D cap is the default; add ?cap=2d to the link to use the flat cap instead.
const USE_3D_CAP = new URLSearchParams(location.search).get('cap') !== '2d';

// ---------------------------------------------------------------------------
// Elements & state
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const baseCtx = canvas.getContext('2d');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
// The drawing functions draw onto `ctx`; draw() points it at the right layer.
let ctx = baseCtx;
// All layers merged, only for photos and videos.
const output = document.createElement('canvas');
output.width = W;
output.height = H;
const outCtx = output.getContext('2d');

const ui = {
  intro: $('intro'), loading: $('loading'), loadingText: $('loadingText'),
  error: $('error'), errorText: $('errorText'), controls: $('controls'),
  preview: $('preview'), previewMedia: $('previewMedia'), hint: $('hint'),
  shutter: $('shutter'), spinBtn: $('spinBtn'), noseBtn: $('noseBtn'), flipBtn: $('flipBtn'),
};

const images = {};
let landmarker = null;
let modelPromise = null;
let stream = null;
let facing = 'user';
let running = false;
let paused = false;
let lastVideoTime = -1;
let lastFaceSeen = 0;
let showNose = true;
let cap3d = null;
let cap3dVisible = false;

const slots = []; // smoothed face poses, sorted left → right on screen
const confetti = [];
const spin = { state: 'idle', start: 0, duration: 2600, plans: [], landedAt: 0 };

const rec = { recorder: null, chunks: [], startedAt: 0, holdTimer: null, mime: '' };
let currentCapture = null;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function loadImage(name, src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { images[name] = img; resolve(img); };
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

let assetsPromise = null;
function loadAssets() {
  if (!assetsPromise) {
    assetsPromise = Promise.all([
      loadImage('cap', 'assets/cap.png'),
      loadImage('acti', 'assets/acti.webp'),
      loadImage('logo', 'assets/logo.png'),
    ]).catch((err) => { assetsPromise = null; throw err; });
  }
  return assetsPromise;
}

// The 3D cap (three.js, ~2 MB) loads only after face tracking is ready, so it never slows tracking down.
// Until it's ready the flat cap is shown.
let cap3dLoading = false;
async function setup3DCap() {
  if (!USE_3D_CAP || cap3d || cap3dLoading) return;
  cap3dLoading = true;
  try {
    const [{ createCap3D }] = await Promise.all([import('./cap3d.js'), loadAssets()]);
    // Let the camera and tracking settle before building the 3D cap.
    await new Promise((r) => setTimeout(r, 300));
    const created = await createCap3D({ width: W, height: H, logo: images.logo });
    if (created) {
      created.canvas.setAttribute('aria-hidden', 'true');
      $('layers').insertBefore(created.canvas, overlay);
      cap3d = created;
    }
  } catch (err) {
    console.warn('3D cap failed to load, keeping the flat cap', err);
  }
}

async function loadFonts() {
  if (!document.fonts) return;
  const wait = Promise.all([
    document.fonts.load(`800 60px ${FONT}`),
    document.fonts.load(`700 60px ${FONT}`),
    document.fonts.load(`600 60px ${FONT}`),
  ]);
  // Never let a slow font network hold up the camera.
  await Promise.race([wait, new Promise((r) => setTimeout(r, 2500))]).catch(() => {});
}

async function createLandmarker(delegate) {
  const wasm = await FilesetResolver.forVisionTasks(new URL('../vendor/mediapipe/wasm', import.meta.url).href);
  return FaceLandmarker.createFromOptions(wasm, {
    baseOptions: {
      modelAssetPath: new URL('../models/face_landmarker.task', import.meta.url).href,
      delegate,
    },
    runningMode: 'VIDEO',
    numFaces: MAX_FACES,
  });
}

function loadModel() {
  if (!modelPromise) {
    modelPromise = createLandmarker('GPU')
      .catch(() => createLandmarker('CPU'))
      .then((lm) => { landmarker = lm; return lm; })
      .catch((err) => { modelPromise = null; throw err; });
  }
  return modelPromise;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

async function startCamera() {
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = stream;
  await video.play();
  lastVideoTime = -1;
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function updateFlipButton() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    ui.flipBtn.hidden = devices.filter((d) => d.kind === 'videoinput').length < 2;
  } catch {
    ui.flipBtn.hidden = true;
  }
}

function cameraErrorMessage(err) {
  if (!window.isSecureContext) return 'The camera only works over a secure (https) link.';
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow the camera for this site in your browser settings, then tap Try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return "We couldn't find a camera on this device.";
    case 'NotReadableError':
      return 'Your camera is being used by another app. Close it and tap Try again.';
    default:
      return "Something went wrong starting the camera. If you opened this inside Instagram, tap ⋯ and choose “Open in browser”.";
  }
}

// ---------------------------------------------------------------------------
// Face tracking → smoothed poses
// ---------------------------------------------------------------------------

function videoToCanvas() {
  const vw = video.videoWidth || W;
  const vh = video.videoHeight || H;
  const scale = Math.max(W / vw, H / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return { dw, dh, ox: (W - dw) / 2, oy: (H - dh) / 2, mirror: facing === 'user' };
}

function poseFromLandmarks(lm, map) {
  const P = (i) => {
    let x = map.ox + lm[i].x * map.dw;
    if (map.mirror) x = W - x;
    return { x, y: map.oy + lm[i].y * map.dh };
  };
  let a = P(LM.leftCheek);
  let b = P(LM.rightCheek);
  if (a.x > b.x) [a, b] = [b, a];
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const faceW = Math.hypot(b.x - a.x, b.y - a.y);
  const top = P(LM.foreheadTop);
  const chin = P(LM.chin);
  const faceH = Math.hypot(chin.x - top.x, chin.y - top.y);
  const size = Math.max(faceW, faceH * 0.82); // stays steady when the head turns
  const forehead = P(LM.forehead);
  const nose = P(LM.noseTip);
  return {
    x: forehead.x, y: forehead.y, angle, size,
    noseX: nose.x, noseY: nose.y, chinX: chin.x, chinY: chin.y,
    head: headFrame(lm, map),
  };
}

// 3D head position and orientation for the 3D cap, in three.js coordinates
// (origin at the canvas centre, y up, z towards the camera, units = canvas pixels).
function headFrame(lm, map) {
  const Q = (i) => {
    let x = map.ox + lm[i].x * map.dw;
    if (map.mirror) x = W - x;
    return [x - W / 2, H / 2 - (map.oy + lm[i].y * map.dh), -lm[i].z * map.dw];
  };
  const a = Q(LM.leftCheek);
  const b = Q(LM.rightCheek);
  let r = sub(b, a);
  if (r[0] < 0) r = scale(r, -1);
  const s = len(r);
  r = scale(r, 1 / s);
  const u = orthonormal(sub(Q(LM.foreheadTop), Q(LM.chin)), r);
  const o = scale(add(a, b), 0.5);
  // Height of the top of the forehead above the cheek line, in face widths
  const top = dot(sub(Q(LM.foreheadTop), o), u) / s;
  return { o, r, u, s, top };
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
// v made perpendicular to the unit vector r, then normalised
function orthonormal(v, r) {
  const p = sub(v, scale(r, dot(v, r)));
  return scale(p, 1 / len(p));
}

function updateFaces(faceLandmarks, now) {
  const map = videoToCanvas();
  const poses = faceLandmarks.map((lm) => poseFromLandmarks(lm, map)).sort((p, q) => p.x - q.x);
  if (poses.length) lastFaceSeen = now;

  poses.forEach((pose, i) => {
    const s = slots[i];
    if (!s || now - s.seen > 400) {
      slots[i] = { ...pose, seen: now };
      return;
    }
    const k = 0.55;
    for (const key of ['x', 'y', 'noseX', 'noseY', 'chinX', 'chinY']) s[key] += (pose[key] - s[key]) * k;
    s.size += (pose.size - s.size) * 0.4;
    s.angle += (pose.angle - s.angle) * 0.5;
    const h = s.head;
    h.o = lerp3(h.o, pose.head.o, 0.55);
    h.s += (pose.head.s - h.s) * 0.4;
    h.top += (pose.head.top - h.top) * 0.3;
    const r = lerp3(h.r, pose.head.r, 0.5);
    h.r = scale(r, 1 / len(r));
    h.u = orthonormal(lerp3(h.u, pose.head.u, 0.5), h.r);
    s.seen = now;
  });
}

function visibleSlots(now) {
  // A short grace period stops the cap flickering when tracking drops a frame.
  return slots.filter((s) => s && now - s.seen < 180);
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

function startSpin(now) {
  if (spin.state === 'spinning') return;
  const n = ACTIVITIES.length;
  const picks = shuffle([...Array(n).keys()]).slice(0, MAX_FACES);
  spin.plans = picks.map((final, i) => {
    const offset = Math.floor(Math.random() * n);
    const base = 22 + i * 4;
    const steps = base + (((final - offset - base) % n) + n) % n;
    return { final, offset, steps, lastStep: -1, bump: 0 };
  });
  spin.state = 'spinning';
  spin.start = now;
  ui.spinBtn.disabled = true;
}

function updateSpin(now) {
  if (spin.state !== 'spinning') return;
  const t = Math.min(1, (now - spin.start) / spin.duration);
  const eased = 1 - Math.pow(1 - t, 3);
  for (const p of spin.plans) {
    const step = Math.floor(eased * p.steps);
    if (step !== p.lastStep) { p.lastStep = step; p.bump = now; }
  }
  if (t >= 1) {
    spin.state = 'landed';
    spin.landedAt = now;
    ui.spinBtn.disabled = false;
    if (navigator.vibrate) navigator.vibrate(12);
    spin.burstPending = true;
  }
}

function currentActivity(i) {
  const p = spin.plans[i];
  if (!p) return null;
  const idx = spin.state === 'landed' ? p.final : (p.offset + Math.max(0, p.lastStep)) % ACTIVITIES.length;
  return ACTIVITIES[idx];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function brandGradient(c, x0, y0, x1, y1) {
  const g = c.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, COLORS.purple);
  g.addColorStop(0.45, COLORS.magenta);
  g.addColorStop(0.7, COLORS.pink);
  g.addColorStop(1, COLORS.orange);
  return g;
}

function drawBackground() {
  if (video.readyState >= 2 && video.videoWidth) {
    const m = videoToCanvas();
    ctx.save();
    if (m.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, m.ox, m.oy, m.dw, m.dh);
    ctx.restore();
  } else {
    const g = ctx.createRadialGradient(W / 2, H * 0.3, 50, W / 2, H * 0.3, H);
    g.addColorStop(0, '#2a0d6e');
    g.addColorStop(1, '#0d0620');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawCap(s) {
  const cap = images.cap;
  const cw = s.size * CAP.scale;
  const ch = cw * CAP.aspect;
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.angle);
  ctx.translate(0, -s.size * 0.09);
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = s.size * 0.06;
  ctx.shadowOffsetY = s.size * 0.025;
  ctx.drawImage(cap, -cw * CAP.anchorX, -ch * CAP.anchorY, cw, ch);
  ctx.restore();
}

function drawNose(s) {
  const w = s.size * 0.17;
  const h = s.size * 0.12;
  ctx.save();
  ctx.translate(s.noseX, s.noseY);
  ctx.rotate(s.angle);
  // Rounded downward triangle, like Acti's nose
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h * 0.35);
  ctx.quadraticCurveTo(-w / 2, -h / 2, -w * 0.3, -h / 2);
  ctx.lineTo(w * 0.3, -h / 2);
  ctx.quadraticCurveTo(w / 2, -h / 2, w / 2, -h * 0.35);
  ctx.quadraticCurveTo(w * 0.2, h * 0.45, 0, h / 2);
  ctx.quadraticCurveTo(-w * 0.2, h * 0.45, -w / 2, -h * 0.35);
  ctx.closePath();
  const g = ctx.createRadialGradient(-w * 0.1, -h * 0.25, 1, 0, 0, w * 0.7);
  g.addColorStop(0, '#ffb070');
  g.addColorStop(0.55, '#ff7a26');
  g.addColorStop(1, '#e8550c');
  ctx.fillStyle = g;
  ctx.shadowColor = 'rgba(120,40,0,0.35)';
  ctx.shadowBlur = w * 0.15;
  ctx.shadowOffsetY = h * 0.08;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.ellipse(-w * 0.14, -h * 0.26, w * 0.12, h * 0.08, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// The "what will you activate?" badge. (x, y) is the bottom centre of the badge.
function drawBadge(x, y, angle, unit, activity, plan, now) {
  const [emoji, label] = activity;
  const fs = unit;
  const landed = spin.state === 'landed';
  let scale = 1;
  if (landed) scale = 0.6 + 0.4 * easeOutBack(Math.min(1, (now - spin.landedAt) / 420));
  else if (plan) scale = 1 + 0.06 * Math.max(0, 1 - (now - plan.bump) / 90);

  ctx.font = `800 ${fs}px ${FONT}`;
  const labelW = ctx.measureText(label).width;
  const emojiSize = fs * 1.15;
  const padX = fs * 0.55;
  const gap = fs * 0.3;
  const bw = padX * 2 + emojiSize + gap + labelW;
  const bh = fs * 1.7;
  const top = -bh;
  const totalH = fs * BADGE_HEIGHT;

  // Keep the whole badge on screen and clear of Instagram's top bar.
  const half = (Math.max(bw, ctx.measureText('WHAT SHOULD I TRY?').width * 0.6) / 2) * scale;
  x = Math.min(W - 40 - half, Math.max(40 + half, x));
  y = Math.max(SAFE_TOP + totalH * scale, y);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);

  // Main pill: gradient outline, white fill
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = fs * 0.4;
  ctx.shadowOffsetY = fs * 0.12;
  roundRect(ctx, -bw / 2, top, bw, bh, bh / 2);
  ctx.fillStyle = brandGradient(ctx, -bw / 2, 0, bw / 2, 0);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  const inset = fs * 0.12;
  roundRect(ctx, -bw / 2 + inset, top + inset, bw - inset * 2, bh - inset * 2, bh / 2 - inset);
  ctx.fillStyle = '#fff';
  ctx.fill();

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const cy = top + bh / 2;
  let cx = -bw / 2 + padX;
  ctx.font = `${emojiSize}px ${EMOJI_FONT}`;
  ctx.fillText(emoji, cx, cy + fs * 0.04);
  cx += emojiSize + gap;
  ctx.font = `800 ${fs}px ${FONT}`;
  ctx.fillStyle = COLORS.ink;
  ctx.fillText(label, cx, cy + fs * 0.1);

  // Tag above the pill
  const tag = landed ? 'I SHOULD TRY…' : 'WHAT SHOULD I TRY?';
  const tfs = fs * 0.55;
  ctx.font = `800 ${tfs}px ${FONT}`;
  const tw = ctx.measureText(tag).width + tfs * 1.4;
  const th = tfs * 1.6;
  const ty = top - th * 0.55;
  roundRect(ctx, -tw / 2, ty - th / 2, tw, th, th / 2);
  ctx.fillStyle = landed ? COLORS.orange : COLORS.purple;
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(tag, 0, ty + tfs * 0.08);

  ctx.restore();
  return { x, y: y - bh / 2 };
}

function drawBadges(faces, now) {
  if (spin.state === 'idle') return;
  const burstAt = [];
  if (faces.length === 0) {
    const a = currentActivity(0);
    if (a) burstAt.push(drawBadge(W / 2, 520, 0, 64, a, spin.plans[0], now));
  } else {
    faces.forEach((s, i) => {
      const a = currentActivity(i);
      if (!a) return;
      const unit = Math.max(30, Math.min(78, s.size * 0.13));
      const capH = s.size * CAP.scale * CAP.aspect;
      const lift = s.size * 0.09 + capH * CAP.anchorY + s.size * 0.12;
      let x = s.x + Math.sin(s.angle) * lift;
      let y = s.y - Math.cos(s.angle) * lift;
      let angle = s.angle;
      // No room above the cap (face near the top of the frame)? Put the badge under the chin instead.
      if (y - unit * BADGE_HEIGHT < SAFE_TOP) {
        const drop = s.size * 0.12 + unit * BADGE_HEIGHT;
        x = s.chinX - Math.sin(s.angle) * drop;
        y = s.chinY + Math.cos(s.angle) * drop;
      }
      // Face fills the screen? Pin the badge to the top, upright.
      if (y > FOOTER_TOP - 20) {
        x = W / 2 + (i - (faces.length - 1) / 2) * 340;
        y = SAFE_TOP + unit * BADGE_HEIGHT;
        angle = 0;
      }
      burstAt.push(drawBadge(x, y, angle, unit, a, spin.plans[i], now));
    });
  }
  if (spin.burstPending) {
    spin.burstPending = false;
    burstAt.forEach((p) => burst(p.x, p.y));
  }
}

function burst(x, y) {
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 8 + Math.random() * 16;
    confetti.push({
      x, y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - 10,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      w: 10 + Math.random() * 14,
      h: 6 + Math.random() * 8,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      life: 1,
    });
  }
}

function drawConfetti() {
  for (let i = confetti.length - 1; i >= 0; i--) {
    const p = confetti[i];
    p.vy += 0.7;
    p.vx *= 0.985;
    p.x += p.vx;
    p.y += p.vy;
    p.r += p.vr;
    p.life -= 0.012;
    if (p.life <= 0 || p.y > H + 40) { confetti.splice(i, 1); continue; }
    ctx.save();
    ctx.globalAlpha = Math.min(1, p.life * 2);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.r);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
}

function fitFont(text, weight, maxSize, maxWidth) {
  let size = maxSize;
  ctx.font = `${weight} ${size}px ${FONT}`;
  const w = ctx.measureText(text).width;
  if (w > maxWidth) size = Math.floor(size * (maxWidth / w));
  return size;
}

function drawFrame(now) {
  // Gradient border
  const bw = 16;
  ctx.save();
  ctx.lineWidth = bw;
  ctx.strokeStyle = brandGradient(ctx, 0, 0, W, H);
  ctx.strokeRect(bw / 2, bw / 2, W - bw, H - bw);

  // Bottom banner, kept above the area Instagram covers with the reply bar
  const bx = 44;
  const bh = 250;
  const by = H - 150 - bh;
  const bwid = W - bx * 2;
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 10;
  roundRect(ctx, bx, by, bwid, bh, 52);
  ctx.fillStyle = brandGradient(ctx, bx, by, bx + bwid, by + bh);
  ctx.fill();

  // Instagram handle on a tab above the banner
  ctx.font = `800 40px ${FONT}`;
  const hw = ctx.measureText(EVENT.handle).width + 56;
  const hh = 64;
  roundRect(ctx, bx + 24, by - hh + 18, hw, hh, hh / 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = COLORS.purple;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(EVENT.handle, bx + 24 + 28, by - hh / 2 + 18 + 3);

  // Logo in a white circle
  const r = 72;
  const lcx = bx + 30 + r;
  const lcy = by + bh / 2;
  ctx.beginPath();
  ctx.arc(lcx, lcy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  const logo = images.logo;
  const lw = r * 1.35;
  const lh = lw * (logo.height / logo.width);
  ctx.drawImage(logo, lcx - lw / 2, lcy - lh / 2 + 4, lw, lh);

  // Acti stands on the right of the banner and gently bobs
  const acti = images.acti;
  const ah = 520;
  const aw = ah * (acti.width / acti.height);
  const bob = Math.sin(now / 420) * 8;
  const ax = bx + bwid - aw + 46;
  const ay = by + bh + 60 - ah + bob;

  // Name, date and venue between the logo and Acti
  const tx = lcx + r + 28;
  const maxW = ax + aw * 0.04 - tx;
  const lines = [
    { text: 'ACTIVATEME™ FEST', weight: 800, size: fitFont('ACTIVATEME™ FEST', 800, 60, maxW) },
    { text: `📅 ${EVENT.dates}`, weight: 700, size: fitFont(`📅 ${EVENT.dates}`, 700, 42, maxW) },
    { text: `📍 ${EVENT.venue}`, weight: 700, size: fitFont(`📍 ${EVENT.venue}`, 700, 42, maxW) },
  ];
  lines[2].size = Math.min(lines[1].size, lines[2].size);
  lines[1].size = lines[2].size;
  const gap = 10;
  const blockH = lines.reduce((t, l) => t + l.size, 0) + gap * (lines.length - 1);
  let ty = by + (bh - blockH) / 2 + 4;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (const l of lines) {
    ctx.font = `${l.weight} ${l.size}px ${FONT}`;
    ctx.fillText(l.text, tx, ty);
    ty += l.size + gap;
  }

  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  ctx.drawImage(acti, ax, ay, aw, ah);
  ctx.restore();
}

function draw(now) {
  const faces = visibleSlots(now);

  // Bottom layer: camera, nose (and the flat cap until the 3D one is ready)
  ctx = baseCtx;
  drawBackground();
  if (showNose) faces.forEach(drawNose);
  if (cap3d) {
    // Middle layer: the 3D cap draws straight onto its own canvas. Skip it while nobody's in shot.
    if (faces.length || cap3dVisible) cap3d.render(faces.map((s) => s.head));
    cap3dVisible = faces.length > 0;
  } else {
    faces.forEach(drawCap);
  }

  // Top layer: spinner badge, confetti and the branded frame
  ctx = overlayCtx;
  ctx.clearRect(0, 0, W, H);
  updateSpin(now);
  drawBadges(faces, now);
  drawConfetti();
  drawFrame(now);
  ctx = baseCtx;

  if (rec.recorder) composite();
}

function composite() {
  outCtx.drawImage(canvas, 0, 0);
  if (cap3d) outCtx.drawImage(cap3d.canvas, 0, 0, W, H);
  outCtx.drawImage(overlay, 0, 0);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function loop(now) {
  requestAnimationFrame(loop);
  if (paused) return;
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      const result = landmarker.detectForVideo(video, now);
      updateFaces(result.faceLandmarks || [], now);
    } catch (err) {
      console.warn('Face tracking error', err);
    }
  }
  draw(now);
  updateHint(now);
}

let hintState = '';
function updateHint(now) {
  let text = rec.mime ? 'Tap for photo · hold for video' : 'Tap to take a photo';
  if (rec.recorder) text = 'Recording… let go to stop';
  else if (!landmarker) text = 'Loading face tracking…';
  else if (now - lastFaceSeen > 1200) text = "Can't see you. Move into the frame 👀";
  if (text !== hintState) { hintState = text; ui.hint.textContent = text; }
}

// ---------------------------------------------------------------------------
// Capture: photo, video, share
// ---------------------------------------------------------------------------

function pickMime() {
  if (!window.MediaRecorder || !output.captureStream) return '';
  const options = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function takePhoto() {
  composite();
  output.toBlob((blob) => blob && showPreview(blob, 'image'), 'image/jpeg', 0.92);
}

function startRecording() {
  if (!rec.mime) return takePhoto();
  composite();
  const recorder = new MediaRecorder(output.captureStream(30), { mimeType: rec.mime, videoBitsPerSecond: 6_000_000 });
  rec.chunks = [];
  recorder.ondataavailable = (e) => e.data && e.data.size && rec.chunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(rec.chunks, { type: rec.mime.split(';')[0] });
    rec.recorder = null;
    ui.shutter.classList.remove('recording');
    ui.shutter.style.setProperty('--p', 0);
    if (blob.size) showPreview(blob, 'video');
  };
  recorder.start(250);
  rec.recorder = recorder;
  rec.startedAt = performance.now();
  ui.shutter.classList.add('recording');
  tickRecording();
}

function tickRecording() {
  if (!rec.recorder) return;
  const p = (performance.now() - rec.startedAt) / MAX_RECORD_MS;
  ui.shutter.style.setProperty('--p', Math.min(1, p));
  if (p >= 1) return stopRecording();
  requestAnimationFrame(tickRecording);
}

function stopRecording() {
  if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
}

function showPreview(blob, kind) {
  const ext = kind === 'image' ? 'jpg' : (blob.type.includes('mp4') ? 'mp4' : 'webm');
  const file = new File([blob], `activateme-fest-acti-${Date.now()}.${ext}`, { type: blob.type });
  const url = URL.createObjectURL(blob);
  if (currentCapture) URL.revokeObjectURL(currentCapture.url);
  currentCapture = { file, url };

  ui.previewMedia.textContent = '';
  let el;
  if (kind === 'image') {
    el = document.createElement('img');
    el.alt = 'Your ActivateMe Fest photo';
  } else {
    el = document.createElement('video');
    Object.assign(el, { autoplay: true, loop: true, muted: true, playsInline: true, controls: false });
  }
  el.src = url;
  ui.previewMedia.appendChild(el);
  paused = true;
  ui.preview.hidden = false;
}

function closePreview() {
  ui.preview.hidden = true;
  ui.previewMedia.textContent = '';
  paused = false;
}

function download(file, url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function share() {
  if (!currentCapture) return;
  const { file, url } = currentCapture;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'ActivateMe™ Fest', text: 'Tag @activatemefest 🧡' });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  download(file, url);
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

// Size the canvas to the largest 9:16 box that fits above the controls.
function fitCanvas() {
  const vp = $('viewport');
  const cs = getComputedStyle(vp);
  const availW = vp.clientWidth - 12;
  const availH = vp.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 4;
  const w = Math.max(0, Math.min(availW, (availH * 9) / 16));
  const layers = $('layers');
  layers.style.width = `${w}px`;
  layers.style.height = `${(w * 16) / 9}px`;
}
window.addEventListener('resize', fitCanvas);
window.addEventListener('orientationchange', () => setTimeout(fitCanvas, 300));
fitCanvas();

function show(section) {
  for (const el of [ui.intro, ui.loading, ui.error]) el.hidden = el !== section;
}

async function start() {
  show(ui.loading);
  ui.loadingText.textContent = "Getting Acti's cap ready…";
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('no camera api'), { name: 'NotSupported' });
    await Promise.all([loadAssets(), loadFonts(), startCamera()]);
  } catch (err) {
    console.error(err);
    ui.errorText.textContent = err && err.name ? cameraErrorMessage(err) : "We couldn't load the filter. Check your connection and try again.";
    show(ui.error);
    return;
  }
  show(null);
  ui.controls.hidden = false;
  fitCanvas();
  updateFlipButton();
  if (!running) { running = true; requestAnimationFrame(loop); }
  loadModel().then(setup3DCap).catch((err) => {
    console.error(err);
    ui.errorText.textContent = "Face tracking couldn't start on this device. Try updating your browser.";
    show(ui.error);
  });
}

$('startBtn').addEventListener('click', start);
$('retryBtn').addEventListener('click', start);

ui.spinBtn.addEventListener('click', () => startSpin(performance.now()));

ui.noseBtn.addEventListener('click', () => {
  showNose = !showNose;
  ui.noseBtn.setAttribute('aria-pressed', String(showNose));
});

ui.flipBtn.addEventListener('click', async () => {
  facing = facing === 'user' ? 'environment' : 'user';
  slots.length = 0;
  try {
    await startCamera();
  } catch (err) {
    facing = facing === 'user' ? 'environment' : 'user';
    await startCamera().catch(() => {});
  }
});

ui.shutter.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  ui.shutter.setPointerCapture(e.pointerId);
  clearTimeout(rec.holdTimer);
  rec.holdTimer = setTimeout(() => { rec.holdTimer = null; startRecording(); }, HOLD_TO_RECORD_MS);
});
const release = () => {
  if (rec.holdTimer) {
    clearTimeout(rec.holdTimer);
    rec.holdTimer = null;
    takePhoto();
  } else {
    stopRecording();
  }
};
ui.shutter.addEventListener('pointerup', release);
ui.shutter.addEventListener('pointercancel', release);
ui.shutter.addEventListener('contextmenu', (e) => e.preventDefault());

$('retakeBtn').addEventListener('click', closePreview);
$('shareBtn').addEventListener('click', share);
$('saveBtn').addEventListener('click', () => currentCapture && download(currentCapture.file, currentCapture.url));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopRecording();
});

// In-app browsers (Instagram, Facebook) sometimes block the camera
if (/Instagram|FBAN|FBAV|FB_IAB/i.test(navigator.userAgent)) $('inAppWarn').hidden = false;

rec.mime = pickMime();
// Start downloading face tracking straight away so it's ready by the time the camera is,
// then fetch the 3D cap in the background.
loadModel().then(setup3DCap).catch(() => {});
