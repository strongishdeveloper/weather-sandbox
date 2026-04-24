// =============================================================================
// globe.jsx — Three.js scene graph for the 3D Weather Sandbox
// =============================================================================
// Builds and owns: renderer, scene, camera, OrbitControls, all meshes (Earth,
// atmosphere shell, cloud shell, sun, moon, stars, wind arrows, probe pin).
// Exposes a frame-update API the React layer drives each animation frame.
// =============================================================================

const EARTH_RADIUS = 1.0;
const ATMOS_RADIUS = 1.025;
const CLOUD_RADIUS = 1.012;
const MOON_RADIUS  = 0.27;
const SUN_RADIUS   = 0.5;

// Deterministic PRNG for star positions (matches the sr() trick from animations.jsx)
const __sr = (s) => { const x = Math.sin(s + 1) * 10000; return x - Math.floor(x); };

// =============================================================================
// Shaders
// =============================================================================
const EARTH_VERT = `
  uniform sampler2D uSurfaceTex;   // R: landMask  G: surfT  B: tide  A: rain
  uniform float uMoonStrength;
  uniform vec3  uMoonDir;          // unit, in earth-local frame
  varying vec2  vUv;
  varying vec3  vNormal;
  varying vec3  vWorldPos;
  varying float vIsLand;
  varying float vSurfT;
  varying float vTide;
  varying float vRain;

  void main() {
    vec4 s = texture2D(uSurfaceTex, uv);
    vIsLand = s.r;
    vSurfT  = s.g;
    vTide   = (s.b - 0.5) * 2.0;
    vRain   = s.a;
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);

    // Tidal vertex displacement on ocean only.
    float disp = 0.0;
    if (vIsLand < 0.5) {
      // Recompute spherical normal from position so we can dot with moon dir.
      vec3 sph = normalize(position);
      float cosA = dot(sph, uMoonDir);
      // (3 cos²A − 1)/2 · strength : two bulges
      disp = ((3.0 * cosA * cosA - 1.0) * 0.5) * uMoonStrength * 0.06;
    }
    vec3 displaced = position + normal * disp;
    vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
    vWorldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const EARTH_FRAG = `
  precision highp float;
  uniform sampler2D uSurfaceTex;
  uniform sampler2D uTempTex;       // R: airT normalized
  uniform vec3  uSunDir;            // world-space (we'll pass via earth-local)
  uniform vec3  uLandWarm;
  uniform vec3  uLandCool;
  uniform vec3  uOceanWarm;
  uniform vec3  uOceanCool;
  uniform float uShowTemp;          // 0 / 1
  uniform float uShowTides;         // 0 / 1
  uniform float uTempAlpha;
  uniform float uBlueprint;         // 0 / 1
  uniform float uNightTone;         // 0..1 ambient floor
  varying vec2  vUv;
  varying vec3  vNormal;
  varying float vIsLand;
  varying float vSurfT;
  varying float vTide;
  varying float vRain;

  vec3 tempColor(float t01) {
    // Cold blue → warm red, matching v1 palette intent
    vec3 cold = vec3(0.10, 0.45, 0.95);
    vec3 mid  = vec3(0.95, 0.95, 0.55);
    vec3 hot  = vec3(0.95, 0.30, 0.20);
    return t01 < 0.5
      ? mix(cold, mid, t01 * 2.0)
      : mix(mid, hot, (t01 - 0.5) * 2.0);
  }

  void main() {
    // Lambert-style day lighting using cell normal (already normalized).
    vec3 N = normalize(vNormal);
    float lambert = max(dot(N, uSunDir), 0.0);
    float terminator = smoothstep(-0.10, 0.25, dot(N, uSunDir));

    vec3 base;
    if (uBlueprint > 0.5) {
      // Flat schematic: land = warm blue, ocean = dark blue, gridlines on UV
      vec3 land  = vec3(0.10, 0.30, 0.55);
      vec3 ocean = vec3(0.04, 0.10, 0.22);
      base = mix(ocean, land, vIsLand);
      // Lat/lon grid lines
      vec2 g = abs(fract(vUv * vec2(36.0, 18.0)) - 0.5);
      float line = step(0.46, max(g.x, g.y));
      base = mix(base, vec3(0.55, 0.85, 1.0), line * 0.18);
    } else {
      // Surface T to a 0..1 warmness scale.
      float warm = clamp(vSurfT, 0.0, 1.0);
      vec3 land  = mix(uLandCool,  uLandWarm,  warm);
      vec3 ocean = mix(uOceanCool, uOceanWarm, warm);
      base = mix(ocean, land, vIsLand);
      // Specular highlight on water near the sun direction.
      if (vIsLand < 0.5) {
        float spec = pow(max(0.0, lambert), 16.0) * 0.45;
        base += vec3(spec);
      }
      // Tide brightening on ocean if layer enabled
      if (uShowTides > 0.5 && vIsLand < 0.5) {
        base += vec3(0.45, 0.65, 0.85) * vTide * 1.6;
      }
    }

    // Day/night blend
    vec3 lit = base * (uNightTone + (1.0 - uNightTone) * terminator);

    // Optional temperature heatmap overlay (sampled from tempTex)
    if (uShowTemp > 0.5 && uBlueprint < 0.5) {
      float t01 = texture2D(uTempTex, vUv).r;
      lit = mix(lit, tempColor(t01), uTempAlpha);
    }

    // Rain darkens the surface a touch
    lit *= 1.0 - clamp(vRain * 0.6, 0.0, 0.35);

    gl_FragColor = vec4(lit, 1.0);
  }
`;

// Atmosphere rim shader (Fresnel)
const ATMOS_VERT = `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const ATMOS_FRAG = `
  precision mediump float;
  uniform vec3 uColor;
  uniform float uIntensity;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float fres = pow(1.0 - max(dot(vN, vV), 0.0), 2.5);
    gl_FragColor = vec4(uColor, fres * uIntensity);
  }
`;

// Cloud shell — uses cloud DataTexture as alpha
const CLOUD_VERT = `
  varying vec2 vUv;
  varying vec3 vN;
  void main() {
    vUv = uv;
    vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const CLOUD_FRAG = `
  precision mediump float;
  uniform sampler2D uCloudTex;
  uniform vec3 uSunDir;
  uniform float uBlueprint;
  uniform float uCloudBlob;
  varying vec2 vUv;
  varying vec3 vN;
  void main() {
    float c = texture2D(uCloudTex, vUv).r;
    // Soft expand for "painterly" or tighten for "scientific". Texture is
    // already normalised in JS (sim.cloud * 60 → 0..1); a small extra gain
    // here lets light wisps still register.
    float a = clamp(c * 1.4 * uCloudBlob, 0.0, 0.92);
    if (a < 0.02) discard;
    float light = clamp(dot(vN, uSunDir) * 0.6 + 0.55, 0.35, 1.0);
    vec3 col = uBlueprint > 0.5
      ? vec3(0.55, 0.80, 1.0)
      : vec3(1.0) * light;
    gl_FragColor = vec4(col, a);
  }
`;

// =============================================================================
// Build the scene
// =============================================================================
function createGlobeScene(canvas) {
  if (typeof THREE === 'undefined') {
    throw new Error('THREE is not loaded');
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x05080f, 1);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 1000);
  camera.position.set(0, 0.6, 3.2);

  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.3;
  controls.maxDistance = 60;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = Math.PI - 0.15;
  controls.enablePan = false;

  // ── Earth ────────────────────────────────────────────────────────────────
  const surfaceTex = new THREE.DataTexture(
    new Uint8Array(LON * LAT * 4), LON, LAT, THREE.RGBAFormat
  );
  surfaceTex.minFilter = THREE.LinearFilter;
  surfaceTex.magFilter = THREE.LinearFilter;
  surfaceTex.wrapS = THREE.RepeatWrapping;
  surfaceTex.needsUpdate = true;

  const tempTex = new THREE.DataTexture(
    new Uint8Array(LON * LAT * 4), LON, LAT, THREE.RGBAFormat
  );
  tempTex.minFilter = THREE.LinearFilter;
  tempTex.magFilter = THREE.LinearFilter;
  tempTex.wrapS = THREE.RepeatWrapping;
  tempTex.needsUpdate = true;

  const cloudTex = new THREE.DataTexture(
    new Uint8Array(LON * LAT * 4), LON, LAT, THREE.RGBAFormat
  );
  cloudTex.minFilter = THREE.LinearFilter;
  cloudTex.magFilter = THREE.LinearFilter;
  cloudTex.wrapS = THREE.RepeatWrapping;
  cloudTex.needsUpdate = true;

  const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 96, 64);
  const earthMat = new THREE.ShaderMaterial({
    vertexShader: EARTH_VERT,
    fragmentShader: EARTH_FRAG,
    uniforms: {
      uSurfaceTex: { value: surfaceTex },
      uTempTex:    { value: tempTex },
      uSunDir:     { value: new THREE.Vector3(0, 0, 1) },
      uMoonDir:    { value: new THREE.Vector3(1, 0, 0) },
      uMoonStrength:{ value: 1.0 },
      uLandWarm:   { value: new THREE.Color(0xaa9550) },
      uLandCool:   { value: new THREE.Color(0x3a5a30) },
      uOceanWarm:  { value: new THREE.Color(0x1a5d8f) },
      uOceanCool:  { value: new THREE.Color(0x051a30) },
      uShowTemp:   { value: 1.0 },
      uShowTides:  { value: 1.0 },
      uTempAlpha:  { value: 0.22 },
      uBlueprint:  { value: 0.0 },
      uNightTone:  { value: 0.18 },
    },
  });
  const earth = new THREE.Mesh(earthGeo, earthMat);
  scene.add(earth);

  // ── Cloud shell ─────────────────────────────────────────────────────────
  const cloudGeo = new THREE.SphereGeometry(CLOUD_RADIUS, 96, 64);
  const cloudMat = new THREE.ShaderMaterial({
    vertexShader: CLOUD_VERT,
    fragmentShader: CLOUD_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uCloudTex:  { value: cloudTex },
      uSunDir:    { value: earthMat.uniforms.uSunDir.value },
      uBlueprint: { value: 0.0 },
      uCloudBlob: { value: 0.9 },
    },
  });
  const clouds = new THREE.Mesh(cloudGeo, cloudMat);
  scene.add(clouds);

  // ── Atmosphere rim ──────────────────────────────────────────────────────
  const atmosGeo = new THREE.SphereGeometry(ATMOS_RADIUS, 64, 48);
  const atmosMat = new THREE.ShaderMaterial({
    vertexShader: ATMOS_VERT,
    fragmentShader: ATMOS_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0x6aa8ff) },
      uIntensity: { value: 1.0 },
    },
  });
  const atmosphere = new THREE.Mesh(atmosGeo, atmosMat);
  scene.add(atmosphere);

  // ── Sun (directional light + visible disc) ──────────────────────────────
  const sunLight = new THREE.DirectionalLight(0xfff2cc, 0.0); // shading is in shader
  sunLight.position.set(5, 0, 0);
  scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.0));

  const sunGeo = new THREE.SphereGeometry(SUN_RADIUS, 24, 16);
  const sunMat = new THREE.MeshBasicMaterial({ color: 0xfff2cc });
  const sun = new THREE.Mesh(sunGeo, sunMat);
  scene.add(sun);

  // Sun glow sprite
  const sunGlowCanvas = document.createElement('canvas');
  sunGlowCanvas.width = 256; sunGlowCanvas.height = 256;
  {
    const g = sunGlowCanvas.getContext('2d');
    const grd = g.createRadialGradient(128, 128, 4, 128, 128, 128);
    grd.addColorStop(0,   'rgba(255,235,180,0.95)');
    grd.addColorStop(0.3, 'rgba(255,200,100,0.45)');
    grd.addColorStop(1,   'rgba(255,160,60,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  }
  const sunGlowTex = new THREE.CanvasTexture(sunGlowCanvas);
  const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sunGlowTex, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, color: 0xffffff,
  }));
  sunGlow.scale.set(SUN_RADIUS * 4, SUN_RADIUS * 4, 1);
  scene.add(sunGlow);

  // ── Moon ─────────────────────────────────────────────────────────────────
  const moonGeo = new THREE.SphereGeometry(MOON_RADIUS, 32, 24);
  const moonMat = new THREE.MeshStandardMaterial({
    color: 0xc8cdd6, roughness: 0.9, metalness: 0.0,
    emissive: 0x222831, emissiveIntensity: 0.4,
  });
  const moon = new THREE.Mesh(moonGeo, moonMat);
  scene.add(moon);
  // Moon orbit ring (visible at large scales)
  const orbitMat = new THREE.LineBasicMaterial({ color: 0x3a5070, transparent: true, opacity: 0.35 });
  const orbitGeo = new THREE.BufferGeometry();
  {
    const pts = [];
    for (let a = 0; a <= 96; a++) {
      const t = a / 96 * Math.PI * 2;
      pts.push(Math.cos(t), 0, Math.sin(t));
    }
    orbitGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  }
  const moonOrbit = new THREE.LineLoop(orbitGeo, orbitMat);
  scene.add(moonOrbit);

  // ── Starfield ────────────────────────────────────────────────────────────
  const STAR_COUNT = 1500;
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const u = __sr(i * 2.3);
    const v = __sr(i * 4.7);
    const theta = u * Math.PI * 2;
    const phi = Math.acos(2 * v - 1);
    const r = 80 + __sr(i * 7.1) * 20;
    starPos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    starPos[i * 3 + 1] = r * Math.cos(phi);
    starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const starsGeo = new THREE.BufferGeometry();
  starsGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starsGeo, new THREE.PointsMaterial({
    color: 0xffffff, size: 0.18, sizeAttenuation: true, transparent: true, opacity: 0.85,
  }));
  scene.add(stars);

  // ── Wind arrows (LineSegments) ──────────────────────────────────────────
  // One short tangent line per displayed cell. We sub-sample the grid.
  const STRIDE = 4;
  const arrowCols = Math.floor(LON / STRIDE);
  const arrowRows = Math.floor(LAT / STRIDE);
  const arrowCount = arrowCols * arrowRows;
  const arrowVerts = new Float32Array(arrowCount * 2 * 3);
  const arrowGeo = new THREE.BufferGeometry();
  arrowGeo.setAttribute('position', new THREE.Float32BufferAttribute(arrowVerts, 3));
  const arrowMat = new THREE.LineBasicMaterial({
    color: 0xc8e0ff, transparent: true, opacity: 0.55,
  });
  const windArrows = new THREE.LineSegments(arrowGeo, arrowMat);
  scene.add(windArrows);

  // ── Probe pin ────────────────────────────────────────────────────────────
  const pinGeo = new THREE.ConeGeometry(0.025, 0.10, 12);
  const pinMat = new THREE.MeshBasicMaterial({ color: 0xffd089 });
  const probePin = new THREE.Mesh(pinGeo, pinMat);
  probePin.visible = false;
  scene.add(probePin);

  // =============================================================================
  // Per-frame update API
  // =============================================================================
  // Update the surfaceTex / tempTex / cloudTex from sim arrays.
  function uploadSimTextures(sim) {
    const sd = surfaceTex.image.data;
    const td = tempTex.image.data;
    const cd = cloudTex.image.data;
    for (let k = 0; k < N_CELLS; k++) {
      // surface: R land, G surfT 0..1 (-30..40), B tide centred 0.5, A rain
      sd[k * 4]     = sim.isLand[k] ? 255 : 0;
      sd[k * 4 + 1] = clamp((sim.surfT[k] + 30) / 70, 0, 1) * 255 | 0;
      sd[k * 4 + 2] = clamp(0.5 + sim.tide[k] * 12, 0, 1) * 255 | 0;
      sd[k * 4 + 3] = clamp(sim.rain[k] * 4, 0, 1) * 255 | 0;
      // air temperature
      td[k * 4]     = clamp((sim.T[k] + 30) / 60, 0, 1) * 255 | 0;
      td[k * 4 + 1] = td[k * 4]; td[k * 4 + 2] = td[k * 4]; td[k * 4 + 3] = 255;
      // cloud — store as 0..1 thickness (upload multiplier kept modest so the
      // shader has headroom to do the soft-blob expansion).
      const c = clamp(sim.cloud[k] * 60, 0, 1);
      cd[k * 4]     = c * 255 | 0;
      cd[k * 4 + 1] = cd[k * 4]; cd[k * 4 + 2] = cd[k * 4]; cd[k * 4 + 3] = 255;
    }
    surfaceTex.needsUpdate = true;
    tempTex.needsUpdate = true;
    cloudTex.needsUpdate = true;
  }

  // Update wind arrow geometry. Arrows are short tangent line segments on
  // the sphere surface.
  function updateWindArrows(sim, showWind, vstyle) {
    arrowMat.opacity = vstyle.arrowAlpha;
    windArrows.visible = showWind;
    if (!showWind) return;
    const pos = arrowGeo.attributes.position.array;
    let p = 0;
    const len = 0.12;
    for (let jj = 0; jj < arrowRows; jj++) {
      const j = jj * STRIDE + (STRIDE >> 1);
      const lat = latOf(j);
      const cl = Math.cos(lat), sl = Math.sin(lat);
      for (let ii = 0; ii < arrowCols; ii++) {
        const i = ii * STRIDE + (STRIDE >> 1);
        const lon = lonOf(i);
        const k = idx(i, j);
        const u = sim.u[k], v = sim.v[k];
        const mag = Math.sqrt(u * u + v * v);
        // Cell centre on sphere surface (slight outward offset)
        const r = EARTH_RADIUS * 1.005;
        const cx = r * cl * Math.sin(lon);
        const cy = r * sl;
        const cz = r * cl * Math.cos(lon);
        // East tangent: derivative wrt lon
        const ex = cl * Math.cos(lon);
        const ey = 0;
        const ez = -cl * Math.sin(lon);
        // North tangent: derivative wrt lat
        const nx = -sl * Math.sin(lon);
        const ny =  cl;
        const nz = -sl * Math.cos(lon);
        const scale = mag < 0.05 ? 0 : len * Math.min(1, mag * 0.4);
        const dx = (u * ex + v * nx) * scale;
        const dy = (u * ey + v * ny) * scale;
        const dz = (u * ez + v * nz) * scale;
        pos[p++] = cx;          pos[p++] = cy;          pos[p++] = cz;
        pos[p++] = cx + dx;     pos[p++] = cy + dy;     pos[p++] = cz + dz;
      }
    }
    arrowGeo.attributes.position.needsUpdate = true;
  }

  // Build a rotation that takes earth-local (lat, lon) → world space.
  // We rotate the Earth around Y for the diurnal cycle, around Z for axial tilt.
  const earthGroup = new THREE.Group();
  // Re-parent earth + clouds + atmosphere + arrows + probe pin into the group
  scene.remove(earth); scene.remove(clouds); scene.remove(atmosphere);
  scene.remove(windArrows); scene.remove(probePin);
  earthGroup.add(earth); earthGroup.add(clouds); earthGroup.add(atmosphere);
  earthGroup.add(windArrows); earthGroup.add(probePin);
  scene.add(earthGroup);

  // Convert (lat, lon) on the unit sphere to a world point at a given radius.
  const _v = new THREE.Vector3();
  function latLonToWorld(lat, lon, radius) {
    const cl = Math.cos(lat), sl = Math.sin(lat);
    _v.set(cl * Math.sin(lon), sl, cl * Math.cos(lon)).multiplyScalar(radius);
    return _v.clone().applyMatrix4(earthGroup.matrixWorld);
  }

  // Raycast a screen point onto the Earth sphere; return {lat, lon} or null.
  const _ray = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _inv = new THREE.Matrix4();
  function pickGlobe(ndcX, ndcY) {
    _ndc.set(ndcX, ndcY);
    _ray.setFromCamera(_ndc, camera);
    const hits = _ray.intersectObject(earth, false);
    if (!hits.length) return null;
    // Convert hit point to earth-local
    _inv.copy(earthGroup.matrixWorld).invert();
    const local = hits[0].point.clone().applyMatrix4(_inv).normalize();
    const lat = Math.asin(clamp(local.y, -1, 1));
    const lon = Math.atan2(local.x, local.z);
    return { lat, lon };
  }

  // Resize handler
  function setSize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // Apply scale slider 1..10 (log-mapped). 1× close orbit, 10× system view.
  function applyScale(scaleSlider, params) {
    const s = clamp(scaleSlider, 1, 10);
    const t = (s - 1) / 9; // 0..1
    // Log mapping for distance: 2 → 50
    const dist = Math.pow(2 + t * 48, 1.0);
    controls.minDistance = 1.3;
    controls.maxDistance = Math.max(60, dist * 2);
    // Smoothly nudge camera toward new framing distance only if slider was changed
    // (we expose a helper instead so app can call jump on user interaction).
    return dist;
  }

  function jumpScale(scaleSlider) {
    const t = clamp((scaleSlider - 1) / 9, 0, 1);
    const dist = 2.0 + t * 38.0;
    // Move camera along its current direction.
    const dir = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(dir, dist);
    controls.update();
  }

  // Position sun + moon for this frame given sim/parameters.
  // simTime in hours, dayLength in hours, axialTilt in degrees,
  // moonDistance multiplier, scaleSlider 1..10.
  function placeBodies(sim, params, scaleSlider) {
    const dayLen = 24 / params.rotationSpeed;
    const tod = ((sim.simTime % dayLen) / dayLen) * 24;
    const sunHourAngle = (tod / 24) * 2 * Math.PI - Math.PI;
    const tilt = params.axialTilt * Math.PI / 180;

    // Earth axial tilt rotates around Z
    earthGroup.rotation.set(0, 0, tilt);
    // The grid we use in the Earth shader assumes lon is measured from a
    // moving meridian — we don't spin the mesh; instead, the sun moves around
    // the sphere through uSunDir (in earth-local frame) so the day/night
    // terminator sweeps without de-syncing the texture.
    // Sun direction in earth-local frame (axes match the cell-normal frame
    // used in atmosphere.js). We then transform into the earth's local
    // (post-tilt) frame using the inverse tilt rotation so the shader's
    // dot(N, sunDir) matches the physics.
    const sunLocal = new THREE.Vector3(
      -Math.cos(0) * Math.sin(sunHourAngle),
       0,
       Math.cos(0) * Math.cos(sunHourAngle)
    );
    // Sun rises higher/lower with tilt — rotate around Z by -tilt so that
    // the lighting still tilts with the season.
    sunLocal.applyAxisAngle(new THREE.Vector3(0, 0, 1), -tilt);
    earthMat.uniforms.uSunDir.value.copy(sunLocal);

    // World sun position: take local back to world via earthGroup matrix (pre-tilt).
    // For the visible sun we use a fixed ecliptic-plane orbit.
    const sUnit = new THREE.Vector3(
      -Math.sin(sunHourAngle), 0, Math.cos(sunHourAngle)
    );
    const scaleT = clamp((scaleSlider - 1) / 9, 0, 1);
    // Sun visible distance: starts off-screen behind, expands to far on system view
    const sunDist = lerp(8.0, 60.0, scaleT);
    const sunSize = lerp(0.5, 6.0, scaleT);
    sun.scale.setScalar(sunSize / SUN_RADIUS);
    sunGlow.scale.setScalar(sunSize * 4);
    sun.position.copy(sUnit).multiplyScalar(sunDist);
    sunGlow.position.copy(sun.position);
    sunLight.position.copy(sUnit).multiplyScalar(10);

    // Moon position: opposite hour-angle, slow orbital advance (matches physics)
    const moonHour = sunHourAngle + Math.PI + sim.simTime * 0.02;
    const mDist = lerp(2.5, 8.0, scaleT) * params.moonDistance;
    const mUnit = new THREE.Vector3(-Math.sin(moonHour), 0, Math.cos(moonHour));
    moon.position.copy(mUnit).multiplyScalar(mDist);
    moon.scale.setScalar(lerp(1.0, 0.75 + params.moonMass * 0.25, 0.5));
    // Moon dir in earth-local frame (without tilt — moon orbit ≈ ecliptic plane)
    const moonLocal = mUnit.clone();
    earthMat.uniforms.uMoonDir.value.copy(moonLocal);
    earthMat.uniforms.uMoonStrength.value = params.moonMass / Math.pow(params.moonDistance, 3);
    moonOrbit.scale.setScalar(mDist);
    // Hide orbit when very close (visual noise)
    moonOrbit.material.opacity = lerp(0.0, 0.45, scaleT);

    // Stars only meaningful on close framing; fade slightly with scale
    stars.material.opacity = lerp(0.85, 0.55, scaleT);

    return { sunHourAngle, sunDir: sUnit, moonDir: mUnit, tod };
  }

  function applyClimatePalette(climate, vstyle) {
    // Sky / atmosphere colour
    const sky = climate.skyDay;
    atmosMat.uniforms.uColor.value.setRGB(sky[0]/255, sky[1]/255, sky[2]/255);
    // Land colours per surfaceHue
    const palettes = {
      grass: { warm: 0xaa9550, cool: 0x3a5a30 },
      sand:  { warm: 0xe6c486, cool: 0xb49560 },
      ice:   { warm: 0xeaf2fb, cool: 0xb8c8e0 },
      rust:  { warm: 0xc8704a, cool: 0x8a3c28 },
    };
    const p = palettes[climate.surfaceHue] || palettes.grass;
    earthMat.uniforms.uLandWarm.value.set(p.warm);
    earthMat.uniforms.uLandCool.value.set(p.cool);
    // Ocean palette (brighter for venus)
    if (climate.surfaceHue === 'rust') {
      earthMat.uniforms.uOceanWarm.value.set(0xa04020);
      earthMat.uniforms.uOceanCool.value.set(0x501808);
    } else if (climate.surfaceHue === 'ice') {
      earthMat.uniforms.uOceanWarm.value.set(0x6090b8);
      earthMat.uniforms.uOceanCool.value.set(0x18365a);
    } else {
      earthMat.uniforms.uOceanWarm.value.set(0x1a5d8f);
      earthMat.uniforms.uOceanCool.value.set(0x051a30);
    }
    // Visual style flags
    earthMat.uniforms.uBlueprint.value = vstyle.blueprint ? 1.0 : 0.0;
    earthMat.uniforms.uTempAlpha.value = vstyle.tempAlpha;
    cloudMat.uniforms.uBlueprint.value = vstyle.blueprint ? 1.0 : 0.0;
    cloudMat.uniforms.uCloudBlob.value = vstyle.cloudBlob;
    atmosMat.uniforms.uIntensity.value = vstyle.blueprint ? 0.4 : 1.0;
  }

  function setLayers(showLayers) {
    earthMat.uniforms.uShowTemp.value  = showLayers.temperature ? 1.0 : 0.0;
    earthMat.uniforms.uShowTides.value = showLayers.tides       ? 1.0 : 0.0;
    clouds.visible = showLayers.clouds;
  }

  function setProbe(probe) {
    if (!probe) { probePin.visible = false; return; }
    const cl = Math.cos(probe.lat), sl = Math.sin(probe.lat);
    const r = EARTH_RADIUS + 0.05;
    probePin.position.set(cl * Math.sin(probe.lon) * r, sl * r, cl * Math.cos(probe.lon) * r);
    // Point cone outward
    probePin.lookAt(probePin.position.clone().multiplyScalar(2));
    probePin.rotateX(Math.PI / 2);
    probePin.visible = true;
  }

  function render() {
    controls.update();
    renderer.render(scene, camera);
  }

  function dispose() {
    renderer.dispose();
    earthGeo.dispose(); earthMat.dispose();
    cloudGeo.dispose(); cloudMat.dispose();
    atmosGeo.dispose(); atmosMat.dispose();
    moonGeo.dispose();  moonMat.dispose();
    sunGeo.dispose();   sunMat.dispose();
    starsGeo.dispose(); stars.material.dispose();
    arrowGeo.dispose(); arrowMat.dispose();
    pinGeo.dispose();   pinMat.dispose();
    surfaceTex.dispose(); tempTex.dispose(); cloudTex.dispose();
    sunGlowTex.dispose();
  }

  return {
    renderer, scene, camera, controls,
    earth, earthGroup, moon, sun, clouds, atmosphere,
    setSize, render, dispose,
    uploadSimTextures, updateWindArrows,
    placeBodies, applyClimatePalette, setLayers, setProbe,
    pickGlobe, jumpScale, applyScale,
  };
}

Object.assign(window, { createGlobeScene });
