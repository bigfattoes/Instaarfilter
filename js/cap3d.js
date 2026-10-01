import * as THREE from '../vendor/three/three.module.js';

// A 3D version of Acti's cap, rendered with three.js on a transparent canvas that app.js
// draws on top of the camera image.
//
// Units: the cap is modelled in "face widths" (1 = distance between the two cheek landmarks),
// with the origin halfway between the cheeks, x to the right, y up and z out of the face.

// Measured on real faces: the forehead's surface is about 0.5 face widths in front of the cheek line
// and the top of the face mesh (landmark 10) is about 0.53 above it.
const TUNE = {
  capAbove: 0.03, // crown's rim sits this far above the top of the forehead (landmark 10)
  capZ: -0.13,    // crown centre, behind the cheek line (roughly the centre of the head)
  tilt: 0.04,     // radians; a little lower at the front than the back
  crown: { x: 0.6, y: 0.5, z: 0.72 },
  brimLength: 0.5,
  head: { y: -0.6, z: -0.04, rx: 0.52, ry: 0.86, rz: 0.64 }, // invisible head, in cap space
};

const COLORS = {
  white: '#f7f3f7',
  blue: '#5b52e8',
  purple: '#6a3fe0',
  button: '#5a2fd6',
  seam: 'rgba(40, 20, 90, 0.16)',
};

export async function createCap3D({ width, height, logo, resolution = 0.5 }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  } catch (err) {
    console.warn('3D cap unavailable, using the flat cap', err);
    return null;
  }
  renderer.setPixelRatio(1);
  renderer.setSize(Math.round(width * resolution), Math.round(height * resolution), false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, -10000, 10000);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b5fa8, 1.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(0.35, 1, 0.9);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffe2c4, 0.5);
  fill.position.set(-0.8, 0.2, 0.6);
  scene.add(fill);

  const template = buildCap(logo, renderer.capabilities.getMaxAnisotropy());
  const caps = [];
  const basis = new THREE.Matrix4();
  const r = new THREE.Vector3();
  const u = new THREE.Vector3();
  const f = new THREE.Vector3();

  // Compile the shaders now, in the background where the browser allows it,
  // so the first frame with a face doesn't freeze.
  const warm = template.clone();
  scene.add(warm);
  try {
    await renderer.compileAsync(scene, camera);
  } catch {
    renderer.compile(scene, camera);
  }
  scene.remove(warm);
  renderer.render(scene, camera); // leaves the canvas cleared and transparent

  function render(heads) {
    while (caps.length < heads.length) {
      const cap = template.clone();
      cap.matrixAutoUpdate = false;
      scene.add(cap);
      caps.push(cap);
    }
    caps.forEach((cap, i) => {
      const h = heads[i];
      cap.visible = !!h;
      if (!h) return;
      r.fromArray(h.r);
      u.fromArray(h.u);
      f.crossVectors(r, u);
      basis.makeBasis(r, u, f).scale(new THREE.Vector3(h.s, h.s, h.s)).setPosition(h.o[0], h.o[1], h.o[2]);
      cap.matrix.copy(basis);
      cap.getObjectByName('cap').position.y = h.top + TUNE.capAbove;
      cap.matrixWorldNeedsUpdate = true;
    });
    renderer.render(scene, camera);
    return renderer.domElement;
  }

  return { render, canvas: renderer.domElement };
}

function buildCap(logo, anisotropy) {
  const root = new THREE.Group();
  const cap = new THREE.Group();
  cap.name = 'cap';
  cap.position.set(0, 0.6, TUNE.capZ);
  cap.rotation.x = TUNE.tilt;
  root.add(cap);

  const { x: cx, y: cy, z: cz } = TUNE.crown;

  // Invisible head: hides the parts of the cap that are behind the wearer's head.
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 24),
    new THREE.MeshBasicMaterial({ colorWrite: false }),
  );
  head.scale.set(TUNE.head.rx, TUNE.head.ry, TUNE.head.rz);
  head.position.set(0, TUNE.head.y, TUNE.head.z);
  head.renderOrder = -1;
  cap.add(head);

  // Crown: the top half of an ellipsoid, painted with panels and the logo.
  const crownTex = new THREE.CanvasTexture(paintCrown(logo));
  crownTex.colorSpace = THREE.SRGBColorSpace;
  crownTex.anisotropy = anisotropy;
  const crown = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 48, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: crownTex, roughness: 0.88, metalness: 0, side: THREE.DoubleSide }),
  );
  crown.scale.set(cx, cy, cz);
  cap.add(crown);

  // Button on top
  const button = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 24, 16),
    new THREE.MeshStandardMaterial({ color: COLORS.button, roughness: 0.7 }),
  );
  button.scale.y = 0.6;
  button.position.y = cy - 0.005;
  cap.add(button);

  // Band around the rim
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.022, 10, 96),
    new THREE.MeshStandardMaterial({ color: COLORS.purple, roughness: 0.8 }),
  );
  band.rotation.x = Math.PI / 2;
  band.scale.set(cx, cz, 1);
  band.position.y = 0.01;
  cap.add(band);

  // Brim: a crescent that follows the front of the crown, curved down at the sides.
  const brim = new THREE.Mesh(
    brimGeometry(cx, cz, TUNE.brimLength),
    new THREE.MeshStandardMaterial({ color: COLORS.purple, roughness: 0.75, side: THREE.DoubleSide }),
  );
  cap.add(brim);

  return root;
}

function brimGeometry(cx, cz, length) {
  const shape = new THREE.Shape();
  const ox = cx * 1.04;
  const oz = cz + length;
  const steps = 64;
  const t0 = -0.08;
  const t1 = Math.PI + 0.08;
  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    const p = [ox * Math.cos(t), oz * Math.sin(t)];
    if (i === 0) shape.moveTo(...p); else shape.lineTo(...p);
  }
  for (let i = steps; i >= 0; i--) {
    const t = t0 + ((t1 - t0) * i) / steps;
    shape.lineTo(cx * 0.8 * Math.cos(t), cz * 0.8 * Math.sin(t)); // tucked inside the crown
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.025, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 3, curveSegments: 48,
  });
  geo.rotateX(Math.PI / 2); // shape's y → forward (z), extrusion → downwards
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const nx = x / ox;
    // How far this point sticks out past the crown (0 at the crown, 1 at the brim's edge)
    const out = Math.hypot(x / cx, z / cz);
    const reach = Math.max(0, Math.min(1, (out - 1) / ((oz / cz) - 1)));
    const y = pos.getY(i) + 0.012 - 0.16 * nx * nx * reach - 0.03 * reach;
    pos.setY(i, y);
  }
  geo.computeVertexNormals();
  return geo;
}

// Texture for SphereGeometry UVs: u runs around the cap (front, +z, is at u = 0.25),
// v runs from the top (canvas top) down to the rim (canvas bottom).
function paintCrown(logo) {
  const w = 2048;
  const h = 1024;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');

  g.fillStyle = COLORS.blue;
  g.fillRect(0, 0, w, h);

  // White front panels (±62° either side of the front)
  const front = 0.25 * w;
  const half = (62 / 360) * w;
  g.fillStyle = COLORS.white;
  g.fillRect(front - half, 0, half * 2, h);

  // Subtle fabric texture
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.05)';
    g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }

  // Panel seams every 60°, one down the centre front
  g.strokeStyle = COLORS.seam;
  g.lineWidth = 5;
  for (let k = 0; k < 6; k++) {
    const x = (front + (k * w) / 6) % w;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }

  // Logo on the front. Size it in cap units and convert to texture pixels at its latitude.
  const { x: cx, y: cy, z: cz } = TUNE.crown;
  const theta = 0.6 * (Math.PI / 2); // how far down from the top the logo's centre sits
  const logoW = 0.42; // face widths
  const logoH = logoW * (logo.height / logo.width);
  const ring = 2 * Math.PI * ((cx + cz) / 2) * Math.sin(theta);
  const meridian = (Math.PI / 2) * Math.sqrt((cy * cy + cz * cz) / 2);
  const pw = (logoW / ring) * w;
  const ph = (logoH / meridian) * h;
  const py = (theta / (Math.PI / 2)) * h;
  g.drawImage(logo, front - pw / 2, py - ph / 2, pw, ph);

  // Darken the very top a touch so the crown reads as rounded
  const shade = g.createLinearGradient(0, 0, 0, h);
  shade.addColorStop(0, 'rgba(40,20,90,0.10)');
  shade.addColorStop(0.3, 'rgba(40,20,90,0)');
  g.fillStyle = shade;
  g.fillRect(0, 0, w, h);
  return c;
}
