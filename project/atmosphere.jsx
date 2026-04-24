// =============================================================================
// atmosphere.jsx — sphere-based weather physics (lat / lon grid)
// =============================================================================
// Ported from the v1 flat cross-section. Each cell now lives at a (lat, lon)
// on a sphere. Vertical structure is collapsed: cloud/humidity/temperature
// are column-integrated, convection is implicit. This keeps the simulation
// affordable in a browser while still letting wind, evaporation, condensation,
// rain, Coriolis, axial tilt, day/night and tides emerge.
// =============================================================================

// ── Tweakable defaults (3 expressive controls — same as v1) ────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "climate": "earth",
  "visualStyle": "scientific",
  "chaos": 0.3
}/*EDITMODE-END*/;

// Climate presets reshape solar, humidity, moon, continents AND palette
const CLIMATES = {
  earth:      { label: "Earth",       solar: 1.0, humidity: 1.0, moon: 1.0,  tilt: 23,
                landPattern: "earth",  surfaceHue: "grass",
                skyDay:  [ 90,140,200], skyDayBot: [180,210,240],
                skyNight:[ 5,  8, 22],  skyNightBot:[10, 15, 38] },
  desert:     { label: "Desert",      solar: 1.6, humidity: 0.15, moon: 0.8, tilt: 8,
                landPattern: "big",    surfaceHue: "sand",
                skyDay:  [220,180,140], skyDayBot: [240,220,180],
                skyNight:[ 30, 18, 25], skyNightBot:[ 50, 25, 20] },
  iceage:     { label: "Ice Age",     solar: 0.55, humidity: 0.5, moon: 1.0, tilt: 30,
                landPattern: "earth",  surfaceHue: "ice",
                skyDay:  [150,180,210], skyDayBot: [220,235,250],
                skyNight:[ 10, 20, 40], skyNightBot:[ 25, 40, 70] },
  waterworld: { label: "Water World", solar: 1.1, humidity: 1.8, moon: 1.4,  tilt: 5,
                landPattern: "tiny",   surfaceHue: "grass",
                skyDay:  [ 80,160,200], skyDayBot: [160,220,240],
                skyNight:[  8, 18, 35], skyNightBot:[ 15, 30, 55] },
  venus:      { label: "Venus-like",  solar: 2.0, humidity: 2.0, moon: 0.0,  tilt: 0,
                landPattern: "big",    surfaceHue: "rust",
                skyDay:  [200,120, 60], skyDayBot: [240,170, 90],
                skyNight:[ 80, 30, 20], skyNightBot:[120, 55, 30] },
};

// Visual styles drive shader uniforms
const VISUAL_STYLES = {
  scientific: { label: "Scientific", cloudBlob: 0.9,  arrowAlpha: 0.55, tempAlpha: 0.22, blueprint: false },
  painterly:  { label: "Painterly",  cloudBlob: 1.5,  arrowAlpha: 0.35, tempAlpha: 0.32, blueprint: false },
  blueprint:  { label: "Blueprint",  cloudBlob: 0.7,  arrowAlpha: 0.85, tempAlpha: 0.12, blueprint: true  },
};

// ── Grid resolution ─────────────────────────────────────────────────────────
const LON = 96;
const LAT = 48;
const N_CELLS = LON * LAT;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const idx = (i, j) => j * LON + i;

// Latitude in radians for a row index. Row 0 = north pole, LAT-1 = south pole.
const latOf = (j) => Math.PI / 2 - (j + 0.5) / LAT * Math.PI;
// Longitude in radians for a column index, [-π, π).
const lonOf = (i) => (i + 0.5) / LON * 2 * Math.PI - Math.PI;

// Saturation humidity grows with T (Clausius-Clapeyron, simplified). T in °C.
function qSat(T) {
  return 0.0038 * Math.exp(0.062 * T);
}

// Deterministic value-noise PRNG (kept stable across reseeds)
function snoise(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
function valueNoise(x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const a = snoise(x0, y0), b = snoise(x0 + 1, y0);
  const c = snoise(x0, y0 + 1), d = snoise(x0 + 1, y0 + 1);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}
function fbm(x, y) {
  let s = 0, amp = 0.55, fr = 1;
  for (let o = 0; o < 4; o++) { s += valueNoise(x * fr, y * fr) * amp; fr *= 2.0; amp *= 0.55; }
  return s;
}

// =============================================================================
// Simulation state
// =============================================================================
function makeSim() {
  return {
    T: new Float32Array(N_CELLS),       // air temperature °C (column-integrated)
    q: new Float32Array(N_CELLS),       // humidity (water vapor mass fraction)
    cloud: new Float32Array(N_CELLS),   // cloud water (condensed)
    u: new Float32Array(N_CELLS),       // zonal wind  (east+)
    v: new Float32Array(N_CELLS),       // meridional wind (north+)
    rain: new Float32Array(N_CELLS),    // rain rate per cell
    surfT: new Float32Array(N_CELLS),   // surface temperature
    isLand: new Uint8Array(N_CELLS),    // 1 land, 0 ocean
    tide: new Float32Array(N_CELLS),    // tide displacement scalar
    simTime: 0,                         // simulated hours
    totalRain: 0,
  };
}

// Set up continents on the sphere using fbm noise + climate-specific bias.
function initLandMask(sim, climateKey = "earth") {
  const pattern = (CLIMATES[climateKey] || CLIMATES.earth).landPattern;
  // Each pattern targets a different total land fraction.
  let bias;
  if (pattern === "earth")      bias = 0.52;
  else if (pattern === "big")   bias = 0.35;
  else if (pattern === "tiny")  bias = 0.85;
  else                          bias = 0.5;
  for (let j = 0; j < LAT; j++) {
    const lat = latOf(j);
    // Small extra weight toward higher land at mid-latitudes for "earth".
    const latBias = pattern === "earth" ? 0.10 * Math.cos(lat * 1.5) : 0;
    for (let i = 0; i < LON; i++) {
      const lon = lonOf(i);
      // Sample noise in 3D-ish via two views to avoid seam artefacts at lon=±π.
      const nx = Math.cos(lon) * 2 + 4, nz = Math.sin(lon) * 2 + 4;
      const ny = Math.sin(lat) * 2 + 4;
      const n = fbm(nx + ny * 0.3, nz + ny * 0.7);
      const k = idx(i, j);
      sim.isLand[k] = (n + latBias) > bias ? 1 : 0;
      // Polar ice caps for "earth" / ice-age — force land near poles
      if ((pattern === "earth" || climateKey === "iceage") && Math.abs(lat) > 1.25) {
        sim.isLand[k] = 1;
      }
      sim.surfT[k] = sim.isLand[k] ? 12 : 14;
    }
  }
}

function initAtmosphere(sim) {
  for (let j = 0; j < LAT; j++) {
    const lat = latOf(j);
    // Equator warm, poles cold
    const baseT = 30 * Math.cos(lat) - 15;
    for (let i = 0; i < LON; i++) {
      const k = idx(i, j);
      sim.T[k] = baseT + (Math.random() - 0.5) * 2;
      sim.q[k] = 0.010 * Math.cos(lat) * Math.cos(lat) + 0.001;
      sim.cloud[k] = 0;
      sim.u[k] = 0;
      sim.v[k] = 0;
    }
  }
}

// =============================================================================
// Physics step
// =============================================================================
function stepSim(sim, params, dtHours) {
  const {
    solarIntensity, axialTilt, rotationSpeed,
    moonMass, moonDistance, humidity,
    timeOfDay, dayLengthHrs, chaos,
  } = params;

  sim.simTime += dtHours;

  // ── Sun direction in equatorial-rotating frame ────────────────────────────
  // Hour angle: 0 at noon-meridian (lon=0), advances with simTime.
  const dayFrac = (timeOfDay / dayLengthHrs);
  const sunHourAngle = dayFrac * 2 * Math.PI - Math.PI;
  const tiltRad = axialTilt * Math.PI / 180;
  // Precompute sun unit vector in (x=east, y=north, z=up at lon=0) frame.
  // We'll dot with each cell's outward normal computed in same frame.
  const sunDirX = -Math.cos(tiltRad) * Math.sin(sunHourAngle);
  const sunDirY =  Math.sin(tiltRad);
  const sunDirZ =  Math.cos(tiltRad) * Math.cos(sunHourAngle);

  // ── Solar heating + surface temperature evolution ─────────────────────────
  for (let j = 0; j < LAT; j++) {
    const lat = latOf(j);
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < LON; i++) {
      const lon = lonOf(i);
      // Outward normal of cell on the sphere (matches sunDir frame).
      const nx = cl * Math.sin(lon);
      const ny = sl;
      const nz = cl * Math.cos(lon);
      const cosZen = Math.max(0, nx * sunDirX + ny * sunDirY + nz * sunDirZ);
      const k = idx(i, j);
      // Cloud albedo dampens heating slightly
      const cloudShade = 1 - clamp(sim.cloud[k] * 80, 0, 0.6);
      const solar = cosZen * solarIntensity * 4.5 * cloudShade;
      if (sim.isLand[k]) {
        sim.surfT[k] += solar * dtHours * 2.2;
        // Faster radiative cooling on the sphere — without v1's vertical
        // mixing column, land cells need a stronger pull back to equilibrium
        // or equatorial belts run away after a few simulated days.
        sim.surfT[k] += (5 - sim.surfT[k]) * 0.06 * dtHours;
      } else {
        sim.surfT[k] += solar * dtHours * 0.35;
        sim.surfT[k] += (14 - sim.surfT[k]) * 0.025 * dtHours;
      }
      // ── Surface ↔ air heat & moisture exchange ─────────────────────────
      sim.T[k] += (sim.surfT[k] - sim.T[k]) * 0.18 * dtHours;
      const evapBase = sim.isLand[k] ? 0.00008 : 0.00040;
      const evap = evapBase * Math.max(0, sim.surfT[k]) * humidity;
      const sat = qSat(sim.T[k]);
      if (sim.q[k] < sat) sim.q[k] += evap * dtHours;
    }
  }

  // ── Pressure-driven horizontal wind (geostrophic-ish) ─────────────────────
  // Pressure proxy ≡ −T  (warm = low pressure). Wind ∝ −∇p flipped by Coriolis.
  // Earth's rotation rate Ω in rad/sim-hour. Default day = 24h → Ω = 2π/24.
  const omega = (2 * Math.PI) / dayLengthHrs;
  for (let j = 0; j < LAT; j++) {
    const lat = latOf(j);
    const cosL = Math.max(0.05, Math.cos(lat));
    const f = 2 * omega * Math.sin(lat); // Coriolis parameter
    for (let i = 0; i < LON; i++) {
      const k  = idx(i, j);
      const kL = idx((i - 1 + LON) % LON, j);
      const kR = idx((i + 1) % LON, j);
      const kN = idx(i, Math.max(0, j - 1));
      const kS = idx(i, Math.min(LAT - 1, j + 1));
      // Negative gradient of pressure proxy −T  ⇒ ∇(−T) = (−dT/dx, −dT/dy)
      // dT/dx scaled by 1/cos(lat) for spherical longitudinal spacing.
      const dTdx = (sim.T[kR] - sim.T[kL]) / (2 * cosL);
      const dTdy = (sim.T[kS] - sim.T[kN]) / 2;
      // Pressure-gradient force: warmer → low-p → wind toward warmth.
      const pgfU =  dTdx * 0.25;   // toward warmer east
      const pgfV = -dTdy * 0.25;   // northward if warmer north
      // Coriolis deflects existing wind: du += f*v, dv -= f*u  (NH: right)
      const cu =  f * sim.v[k] * 0.6;
      const cv = -f * sim.u[k] * 0.6;
      const targetU = pgfU + cu;
      const targetV = pgfV + cv;
      sim.u[k] += (targetU - sim.u[k]) * 0.12;
      sim.v[k] += (targetV - sim.v[k]) * 0.12;
      // Friction near land
      if (sim.isLand[k]) { sim.u[k] *= 0.92; sim.v[k] *= 0.92; }
    }
  }

  // ── Chaos: turbulent perturbations ────────────────────────────────────────
  if (chaos > 0) {
    const amp = chaos * 1.8;
    for (let k = 0; k < N_CELLS; k++) {
      sim.u[k] += (Math.random() - 0.5) * amp;
      sim.v[k] += (Math.random() - 0.5) * amp * 0.6;
      if (Math.random() < 0.0008 * chaos) sim.q[k] += 0.003 * chaos;
    }
  }

  // ── Semi-Lagrangian advection on the sphere ───────────────────────────────
  const Tn = new Float32Array(N_CELLS);
  const qn = new Float32Array(N_CELLS);
  const cn = new Float32Array(N_CELLS);
  const advScale = 0.30;
  for (let j = 0; j < LAT; j++) {
    const cosL = Math.max(0.05, Math.cos(latOf(j)));
    for (let i = 0; i < LON; i++) {
      const k = idx(i, j);
      // Advect backwards: source point. u is east m/s-ish; convert to columns.
      const srcI = i - sim.u[k] * advScale / cosL;
      const srcJ = j - sim.v[k] * advScale;
      // Wrap longitude, clamp latitude.
      let si = srcI % LON; if (si < 0) si += LON;
      const sj = clamp(srcJ, 0, LAT - 1.001);
      const i0 = Math.floor(si), j0 = Math.floor(sj);
      const fi = si - i0, fj = sj - j0;
      const i1 = (i0 + 1) % LON;
      const sample = (arr) => {
        const a = arr[idx(i0, j0)];
        const b = arr[idx(i1, j0)];
        const c = arr[idx(i0, j0 + 1)];
        const d = arr[idx(i1, j0 + 1)];
        return lerp(lerp(a, b, fi), lerp(c, d, fi), fj);
      };
      Tn[k] = sample(sim.T);
      qn[k] = sample(sim.q);
      cn[k] = sample(sim.cloud);
    }
  }
  sim.T.set(Tn); sim.q.set(qn); sim.cloud.set(cn);

  // ── Condensation / rain ───────────────────────────────────────────────────
  for (let k = 0; k < N_CELLS; k++) sim.rain[k] *= 0.85;
  for (let k = 0; k < N_CELLS; k++) {
    const sat = qSat(sim.T[k]);
    if (sim.q[k] > sat) {
      const cond = (sim.q[k] - sat) * 0.6;
      sim.q[k] -= cond;
      sim.cloud[k] += cond;
      sim.T[k] += cond * 8; // latent heat release (tuned down from v1's 15
                            //   because there is no vertical column to absorb it)
    } else {
      // Cloud evaporates back if air can hold more
      const room = sat - sim.q[k];
      const evap = Math.min(sim.cloud[k], room * 0.3);
      sim.cloud[k] -= evap;
      sim.q[k] += evap;
    }
    if (sim.cloud[k] > 0.0035) {
      const fall = (sim.cloud[k] - 0.0035) * 0.5;
      sim.cloud[k] -= fall;
      sim.rain[k] += fall * 100;
      sim.totalRain += fall * 100;
      if (sim.isLand[k]) sim.surfT[k] -= fall * 25;
    }
  }

  // ── Lateral diffusion (smoothing) ─────────────────────────────────────────
  const diff = 0.04;
  const Ts = new Float32Array(N_CELLS);
  for (let j = 0; j < LAT; j++) {
    for (let i = 0; i < LON; i++) {
      const k  = idx(i, j);
      const kL = idx((i - 1 + LON) % LON, j);
      const kR = idx((i + 1) % LON, j);
      Ts[k] = sim.T[k] * (1 - 2 * diff) + sim.T[kL] * diff + sim.T[kR] * diff;
    }
  }
  sim.T.set(Ts);

  // ── Tides ─────────────────────────────────────────────────────────────────
  // Moon position lags sun: opposite hour-angle, plus slow orbital advance.
  const moonHour = sunHourAngle + Math.PI + sim.simTime * 0.02;
  const mDirX = -Math.cos(0) * Math.sin(moonHour);
  const mDirY =  0;
  const mDirZ =  Math.cos(0) * Math.cos(moonHour);
  const moonForce = moonMass / Math.pow(moonDistance, 3);
  for (let j = 0; j < LAT; j++) {
    const lat = latOf(j);
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < LON; i++) {
      const k = idx(i, j);
      if (sim.isLand[k]) { sim.tide[k] = 0; continue; }
      const lon = lonOf(i);
      const nx = cl * Math.sin(lon);
      const ny = sl;
      const nz = cl * Math.cos(lon);
      const cosA = nx * mDirX + ny * mDirY + nz * mDirZ;
      // Tidal potential ∝ (3 cos²θ − 1) / 2 → bulge under moon and antipode.
      sim.tide[k] = ((3 * cosA * cosA - 1) * 0.5) * moonForce * 0.045;
    }
  }
}

// Compute scalar global stats for HUD / info panel.
function computeStats(sim) {
  let tSum = 0, cSum = 0, cN = 0, rSum = 0;
  let tMin = Infinity, tMax = -Infinity;
  for (let k = 0; k < N_CELLS; k++) {
    tSum += sim.surfT[k];
    if (sim.surfT[k] < tMin) tMin = sim.surfT[k];
    if (sim.surfT[k] > tMax) tMax = sim.surfT[k];
    if (sim.cloud[k] > 0.0005) cN++;
    cSum += sim.cloud[k];
    rSum += sim.rain[k];
  }
  let tideMin = Infinity, tideMax = -Infinity;
  for (let k = 0; k < N_CELLS; k++) {
    if (!sim.isLand[k]) {
      if (sim.tide[k] < tideMin) tideMin = sim.tide[k];
      if (sim.tide[k] > tideMax) tideMax = sim.tide[k];
    }
  }
  if (!isFinite(tideMin)) { tideMin = 0; tideMax = 0; }
  return {
    avgT: tSum / N_CELLS,
    minT: tMin, maxT: tMax,
    cloudCover: (cN / N_CELLS) * 100,
    rainRate: rSum,
    tideRange: tideMax - tideMin,
  };
}

// Sample a probed cell.
function probeCell(sim, lat, lon) {
  const j = clamp(Math.floor((Math.PI / 2 - lat) / Math.PI * LAT), 0, LAT - 1);
  let i = Math.floor((lon + Math.PI) / (2 * Math.PI) * LON);
  i = ((i % LON) + LON) % LON;
  const k = idx(i, j);
  return {
    i, j, k,
    isLand: !!sim.isLand[k],
    T: sim.T[k],
    surfT: sim.surfT[k],
    q: sim.q[k],
    cloud: sim.cloud[k],
    rain: sim.rain[k],
    u: sim.u[k],
    v: sim.v[k],
    tide: sim.tide[k],
    lat, lon,
  };
}

Object.assign(window, {
  TWEAK_DEFAULTS, CLIMATES, VISUAL_STYLES,
  LON, LAT, N_CELLS, idx, latOf, lonOf,
  clamp, lerp, smoothstep, qSat,
  makeSim, initLandMask, initAtmosphere, stepSim,
  computeStats, probeCell,
});
