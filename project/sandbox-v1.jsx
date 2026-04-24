// =============================================================================
// WEATHER SANDBOX — interactive physics simulation
// =============================================================================
// Model (simplified but physically-motivated):
//   • Earth is a cross-section: sky (grid cells) above, land/ocean surface, Moon in orbit.
//   • Sun follows a day/night arc; heats surface based on angle of incidence.
//   • Land heats/cools fast (low heat capacity); ocean heats/cools slowly.
//   • Each air cell tracks: temperature T, humidity q, pressure p.
//   • Warm air → lower pressure → horizontal flow from high to low pressure (wind).
//   • Warm air also rises (buoyancy) → vertical convection.
//   • Rising humid air cools → condenses into cloud → rains out when saturated.
//   • Moon's gravity lifts the ocean surface in a bulge that tracks its position (tides).
//   • Earth's rotation is shown as the sun/moon moving across the sky.
// =============================================================================

const { useState, useEffect, useRef, useCallback, useMemo } = React;

// =============================================================================
// Tweakable defaults — 3 expressive controls that reshape the whole feel
// =============================================================================
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "climate": "earth",
  "visualStyle": "scientific",
  "chaos": 0.3
}/*EDITMODE-END*/;

// Climate presets reshape solar, humidity, moon, continents AND palette
const CLIMATES = {
  earth:      { label: "Earth",       solar: 1.0, humidity: 1.0, moon: 1.0,  tilt: 10,
                landPattern: "two",    surfaceHue: "grass",
                skyDay:  [ 90,140,200], skyDayBot: [180,210,240],
                skyNight:[ 5,  8, 22],  skyNightBot:[10, 15, 38] },
  desert:     { label: "Desert",      solar: 1.6, humidity: 0.15, moon: 0.8, tilt: 8,
                landPattern: "big",    surfaceHue: "sand",
                skyDay:  [220,180,140], skyDayBot: [240,220,180],
                skyNight:[ 30, 18, 25], skyNightBot:[ 50, 25, 20] },
  iceage:     { label: "Ice Age",     solar: 0.55, humidity: 0.5, moon: 1.0, tilt: 30,
                landPattern: "two",    surfaceHue: "ice",
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

// Visual styles reshape rendering treatment
const VISUAL_STYLES = {
  scientific: { label: "Scientific", cloudBlob: 0.9,  arrowAlpha: 0.55, tempAlpha: 0.22, grain: 0 },
  painterly:  { label: "Painterly",  cloudBlob: 1.5,  arrowAlpha: 0.35, tempAlpha: 0.32, grain: 0.12 },
  blueprint:  { label: "Blueprint",  cloudBlob: 0.7,  arrowAlpha: 0.85, tempAlpha: 0.12, grain: 0, blueprint: true },
};

// ── Canvas dimensions (logical / design) ────────────────────────────────────
const CW = 1920;        // canvas width
const CH = 1080;         // canvas height
const SKY_TOP = 45;
const SURFACE_Y = 840;  // where land/sea surface sits
const SKY_BOTTOM = SURFACE_Y;

// ── Grid for atmosphere physics ─────────────────────────────────────────────
const COLS = 96;
const ROWS = 44;
const CELL_W = CW / COLS;
const CELL_H = (SKY_BOTTOM - SKY_TOP) / ROWS;

// ── Utility ─────────────────────────────────────────────────────────────────
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const idx = (i, j) => j * COLS + i;

// Saturation humidity falls with temperature (Clausius-Clapeyron, simplified)
// T in °C. Returns kg/kg-ish scaled arbitrary units.
function qSat(T) {
  // Exponential growth with T. At 30°C ≈ 0.030, at 0°C ≈ 0.004, at -20 ≈ 0.001
  return 0.0038 * Math.exp(0.062 * T);
}

// =============================================================================
// Simulation state (mutable, lives outside React for perf)
// =============================================================================
function makeSim() {
  const n = COLS * ROWS;
  return {
    T: new Float32Array(n),       // temperature °C
    q: new Float32Array(n),       // humidity (water vapor mass fraction-ish)
    cloud: new Float32Array(n),   // cloud water (condensed)
    u: new Float32Array(n),       // horizontal wind (east+)
    v: new Float32Array(n),       // vertical wind (down+ in screen; we'll invert for buoyancy)
    rain: new Float32Array(COLS), // rain rate falling to ground, per column
    // Surface
    // 0..COLS-1 — land temperature per column; land/ocean mask
    landT: new Float32Array(COLS),
    oceanT: new Float32Array(COLS),
    // isLand[i] = 1 if land column, 0 if ocean
    isLand: new Uint8Array(COLS),
    // Tide bulge: height offset per column (pixels)
    tide: new Float32Array(COLS),
    // Cumulative totals for HUD
    totalRain: 0,
    simTime: 0, // in simulated hours
  };
}

// Set up continents: two land masses, ocean between and around.
function initLandMask(sim, climateKey = "earth") {
  const pattern = (CLIMATES[climateKey] || CLIMATES.earth).landPattern;
  // Fractional positions so this works at any COLS resolution
  for (let i = 0; i < COLS; i++) {
    const f = i / COLS;
    let land = false;
    if (pattern === "two") {
      land = (f >= 0.12 && f <= 0.34) || (f >= 0.62 && f <= 0.84);
    } else if (pattern === "big") {
      land = (f >= 0.12 && f <= 0.80);
    } else if (pattern === "tiny") {
      land = (f >= 0.46 && f <= 0.56);
    }
    sim.isLand[i] = land ? 1 : 0;
    sim.landT[i] = 15;
    sim.oceanT[i] = 16;
  }
}

function initAtmosphere(sim) {
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const k = idx(i, j);
      // Temperature decreases with altitude (lapse rate). j=0 top, j=ROWS-1 bottom.
      const altFrac = 1 - j / (ROWS - 1); // 0 at bottom, 1 at top
      sim.T[k] = 16 - altFrac * 55;        // 16°C at surface, -39°C at top
      sim.q[k] = 0.008 * (1 - altFrac);    // more moisture near surface
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
    solarIntensity,      // 0..2 multiplier
    axialTilt,           // degrees -> changes effective angle
    rotationSpeed,       // hours per day (24 default; lower = faster)
    moonMass,            // 0..2 multiplier
    moonDistance,        // 0.5..2 multiplier
    humidity,            // 0..2 multiplier for evaporation
    timeOfDay,           // current hour 0..24 (driven by simTime)
    dayLengthHrs,        // duration of a day
  } = params;

  sim.simTime += dtHours;

  // ── Solar heating ──────────────────────────────────────────────────────────
  // Sun angle: peak at noon (timeOfDay = 12), below horizon at 0 & 24.
  const hourAngle = (timeOfDay / dayLengthHrs) * 2 * Math.PI - Math.PI;
  // sun altitude: positive = above horizon. Use cos + tilt tweak.
  const sunAlt = Math.cos(hourAngle) * Math.cos(axialTilt * Math.PI / 180);
  const sunAbove = Math.max(0, sunAlt);

  for (let i = 0; i < COLS; i++) {
    // Incident solar per column roughly uniform (flat earth slice)
    const solar = sunAbove * solarIntensity * 4.5; // °C/hr potential
    if (sim.isLand[i]) {
      // Land heats fast, cools fast
      sim.landT[i] += solar * dtHours * 2.2;
      // Radiative cooling toward -5 at night / equilibrium
      sim.landT[i] += (5 - sim.landT[i]) * 0.02 * dtHours;
    } else {
      // Ocean: high heat capacity
      sim.oceanT[i] += solar * dtHours * 0.35;
      sim.oceanT[i] += (14 - sim.oceanT[i]) * 0.008 * dtHours;
    }
  }

  // ── Surface → lowest-level atmosphere heat + moisture exchange ─────────────
  const jBot = ROWS - 1;
  for (let i = 0; i < COLS; i++) {
    const surfT = sim.isLand[i] ? sim.landT[i] : sim.oceanT[i];
    const k = idx(i, jBot);
    // Turbulent heat transfer
    sim.T[k] += (surfT - sim.T[k]) * 0.18 * dtHours;
    // Evaporation — ocean evaporates a lot, land a little (if wet)
    const evapBase = sim.isLand[i] ? 0.00008 : 0.00040;
    const evap = evapBase * Math.max(0, surfT) * humidity;
    // moisture added if unsaturated
    const satQ = qSat(sim.T[k]);
    if (sim.q[k] < satQ) sim.q[k] += evap * dtHours;
  }

  // ── Buoyancy: warm air rises, cool air sinks ───────────────────────────────
  // Compute vertical velocity target from temperature anomaly vs row mean.
  const rowMeanT = new Float32Array(ROWS);
  for (let j = 0; j < ROWS; j++) {
    let s = 0;
    for (let i = 0; i < COLS; i++) s += sim.T[idx(i, j)];
    rowMeanT[j] = s / COLS;
  }
  for (let j = 1; j < ROWS - 1; j++) {
    for (let i = 0; i < COLS; i++) {
      const k = idx(i, j);
      const anom = sim.T[k] - rowMeanT[j];
      // positive anomaly → upward (negative v in screen since +v = down)
      const targetV = -anom * 0.6;
      sim.v[k] += (targetV - sim.v[k]) * 0.15;
    }
  }

  // ── Horizontal pressure-driven wind ────────────────────────────────────────
  // Pressure proxy = -T (warm = low pressure). Wind flows from high to low = from cold to warm.
  // Also drive wind along surface from ocean to warmer land (sea breeze) & vice versa.
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const k = idx(i, j);
      const kL = idx((i - 1 + COLS) % COLS, j);
      const kR = idx((i + 1) % COLS, j);
      const dT = sim.T[kR] - sim.T[kL]; // positive = warmer to right → wind blows right→left? actually air flows to warmth
      // Warmer → lower pressure → wind blows toward warmer side. Right warmer = wind to right (positive u).
      const targetU = dT * 0.25;
      sim.u[k] += (targetU - sim.u[k]) * 0.12;
      // Friction near surface
      if (j === ROWS - 1) sim.u[k] *= 0.88;
    }
  }

  // ── Chaos: turbulent perturbations ─────────────────────────────────────────
  const chaos = params.chaos || 0;
  if (chaos > 0) {
    const amp = chaos * 2.5;
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const k = idx(i, j);
        sim.u[k] += (Math.random() - 0.5) * amp;
        sim.v[k] += (Math.random() - 0.5) * amp * 0.6;
        // Random moisture puffs (storm seeds)
        if (Math.random() < 0.0008 * chaos) {
          sim.q[k] += 0.003 * chaos;
        }
      }
    }
  }

  // ── Advection (semi-Lagrangian) ────────────────────────────────────────────
  const Tnew = new Float32Array(sim.T.length);
  const qNew = new Float32Array(sim.q.length);
  const cloudNew = new Float32Array(sim.cloud.length);
  const advScale = 0.35;
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const k = idx(i, j);
      const srcI = i - sim.u[k] * advScale;
      const srcJ = j - sim.v[k] * advScale;
      const si = clamp(srcI, 0, COLS - 1.001);
      const sj = clamp(srcJ, 0, ROWS - 1.001);
      const i0 = Math.floor(si), j0 = Math.floor(sj);
      const fi = si - i0, fj = sj - j0;
      const sample = (arr) => {
        const a = arr[idx(i0, j0)];
        const b = arr[idx(i0 + 1, j0)];
        const c = arr[idx(i0, j0 + 1)];
        const d = arr[idx(i0 + 1, j0 + 1)];
        return lerp(lerp(a, b, fi), lerp(c, d, fi), fj);
      };
      Tnew[k] = sample(sim.T);
      qNew[k] = sample(sim.q);
      cloudNew[k] = sample(sim.cloud);
    }
  }
  sim.T.set(Tnew); sim.q.set(qNew); sim.cloud.set(cloudNew);

  // ── Adiabatic cooling during ascent + condensation ────────────────────────
  // Reset rain accumulation per step
  for (let i = 0; i < COLS; i++) sim.rain[i] *= 0.88;
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const k = idx(i, j);
      // Adiabatic: rising air cools
      sim.T[k] -= sim.v[k] * -0.3 * dtHours * 3; // rising v<0 → cools
      // Check saturation
      const satQ = qSat(sim.T[k]);
      if (sim.q[k] > satQ) {
        const cond = (sim.q[k] - satQ) * 0.6;
        sim.q[k] -= cond;
        sim.cloud[k] += cond;
        // Latent heat release — warms rising parcel (feedback)
        sim.T[k] += cond * 15;
      } else {
        // Cloud evaporates back
        const satDeficit = satQ - sim.q[k];
        const evap = Math.min(sim.cloud[k], satDeficit * 0.3);
        sim.cloud[k] -= evap;
        sim.q[k] += evap;
      }
      // Rain out if cloud water exceeds threshold
      if (sim.cloud[k] > 0.0035) {
        const fall = (sim.cloud[k] - 0.0035) * 0.5;
        sim.cloud[k] -= fall;
        sim.rain[i] += fall * 100;
        sim.totalRain += fall * 100;
        // Cool ground slightly
        if (sim.isLand[i]) sim.landT[i] -= fall * 30;
      }
    }
  }

  // ── Lateral diffusion (smoothing) ──────────────────────────────────────────
  const diff = 0.05;
  const Tsm = new Float32Array(sim.T.length);
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const k = idx(i, j);
      const kL = idx((i - 1 + COLS) % COLS, j);
      const kR = idx((i + 1) % COLS, j);
      Tsm[k] = sim.T[k] * (1 - 2 * diff) + sim.T[kL] * diff + sim.T[kR] * diff;
    }
  }
  sim.T.set(Tsm);

  // ── Moon & Tides ───────────────────────────────────────────────────────────
  // Moon position across the sky: orbit period ~ 27 days but we sped-up dramatically.
  // Show moon cycling opposite to sun roughly.
  // tidal force ∝ mass / distance^3
  const moonForce = moonMass / Math.pow(moonDistance, 3);
  // Moon screen x: separate angle that lags sun by 12h
  // (we'll compute this in the draw; here just apply tide shape)
  const moonHourAngle = ((timeOfDay + 12) / dayLengthHrs) * 2 * Math.PI - Math.PI;
  const moonXFrac = 0.5 + 0.5 * Math.sin(moonHourAngle); // 0..1 across canvas
  const moonScreenCol = moonXFrac * COLS;
  for (let i = 0; i < COLS; i++) {
    if (sim.isLand[i]) { sim.tide[i] = 0; continue; }
    // Two bulges: one toward moon, one on opposite side
    const d1 = Math.min(Math.abs(i - moonScreenCol), COLS - Math.abs(i - moonScreenCol));
    const d2 = Math.min(Math.abs(i - ((moonScreenCol + COLS / 2) % COLS)), COLS - Math.abs(i - ((moonScreenCol + COLS / 2) % COLS)));
    const bulge = Math.exp(-Math.pow(d1 / 6, 2)) + Math.exp(-Math.pow(d2 / 6, 2));
    sim.tide[i] = bulge * 18 * moonForce;
  }
}

// =============================================================================
// Drawing
// =============================================================================
function drawSim(ctx, sim, params, showLayers, sunInfo, moonInfo, tweaks) {
  ctx.clearRect(0, 0, CW, CH);

  const climate = CLIMATES[tweaks?.climate] || CLIMATES.earth;
  const vstyle = VISUAL_STYLES[tweaks?.visualStyle] || VISUAL_STYLES.scientific;
  const isBlueprint = !!vstyle.blueprint;

  // ── Sky gradient (based on sun altitude) ───────────────────────────────────
  const sunAlt = sunInfo.alt; // -1..1
  const dayF = smoothstep(-0.1, 0.25, sunAlt);    // 0 night, 1 day
  const duskF = smoothstep(-0.3, 0.05, sunAlt) - smoothstep(0.05, 0.35, sunAlt);

  const sky = ctx.createLinearGradient(0, SKY_TOP, 0, SKY_BOTTOM);
  let topR, topG, topB, botR, botG, botB;
  if (isBlueprint) {
    // Flat blueprint cyan
    topR = 8; topG = 32; topB = 64;
    botR = 18; botG = 58; botB = 110;
  } else {
    topR = lerp(climate.skyNight[0], climate.skyDay[0], dayF) + duskF * 80;
    topG = lerp(climate.skyNight[1], climate.skyDay[1], dayF) + duskF * 40;
    topB = lerp(climate.skyNight[2], climate.skyDay[2], dayF) + duskF * 10;
    botR = lerp(climate.skyNightBot[0], climate.skyDayBot[0], dayF) + duskF * 100;
    botG = lerp(climate.skyNightBot[1], climate.skyDayBot[1], dayF) + duskF * 60;
    botB = lerp(climate.skyNightBot[2], climate.skyDayBot[2], dayF) + duskF * 40;
  }
  sky.addColorStop(0, `rgb(${topR|0},${topG|0},${topB|0})`);
  sky.addColorStop(1, `rgb(${botR|0},${botG|0},${botB|0})`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, CW, SURFACE_Y);

  // Blueprint grid
  if (isBlueprint) {
    ctx.strokeStyle = 'rgba(180,220,255,0.10)';
    ctx.lineWidth = 1;
    for (let x = 0; x < CW; x += 60) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CH); ctx.stroke();
    }
    for (let y = 0; y < CH; y += 60) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CW, y); ctx.stroke();
    }
  }

  // Stars at night
  if (dayF < 0.6) {
    const alpha = (1 - dayF) * 0.9;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    for (let k = 0; k < 120; k++) {
      const x = (Math.sin(k * 12.91) * 10000) % CW;
      const y = (Math.sin(k * 47.13) * 10000) % (SURFACE_Y * 0.7);
      ctx.fillRect(Math.abs(x), Math.abs(y), 1.4, 1.4);
    }
  }

  // ── Sun ────────────────────────────────────────────────────────────────────
  if (sunInfo.alt > -0.15) {
    const sx = sunInfo.x, sy = sunInfo.y;
    const sr = 60;
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr * 3);
    glow.addColorStop(0, 'rgba(255,230,140,0.75)');
    glow.addColorStop(0.3, 'rgba(255,190,90,0.35)');
    glow.addColorStop(1, 'rgba(255,150,50,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(sx - sr * 3, sy - sr * 3, sr * 6, sr * 6);
    ctx.fillStyle = '#fff5d0';
    ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2); ctx.fill();
  }

  // ── Moon ───────────────────────────────────────────────────────────────────
  const mx = moonInfo.x, my = moonInfo.y;
  const mr = lerp(14, 34, clamp((2 - params.moonDistance) / 1.5, 0, 1));
  if (moonInfo.alt > -0.3) {
    const mglow = ctx.createRadialGradient(mx, my, 0, mx, my, mr * 2.2);
    mglow.addColorStop(0, 'rgba(230,240,255,0.4)');
    mglow.addColorStop(1, 'rgba(230,240,255,0)');
    ctx.fillStyle = mglow;
    ctx.fillRect(mx - mr * 2.5, my - mr * 2.5, mr * 5, mr * 5);
  }
  // Draw moon always (even below horizon? only if above)
  if (moonInfo.alt > -0.05) {
    ctx.fillStyle = '#e8eef8';
    ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();
    // craters
    ctx.fillStyle = 'rgba(150,160,180,0.5)';
    ctx.beginPath(); ctx.arc(mx - mr*0.3, my - mr*0.2, mr*0.18, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(mx + mr*0.25, my + mr*0.1, mr*0.12, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(mx + mr*0.05, my + mr*0.35, mr*0.09, 0, Math.PI * 2); ctx.fill();
  }

  // ── Temperature layer ──────────────────────────────────────────────────────
  if (showLayers.temperature) {
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const T = sim.T[idx(i, j)];
        const t01 = clamp((T + 30) / 60, 0, 1);
        // Cold blue → warm red
        const r = t01 > 0.5 ? 220 * (t01 - 0.5) * 2 : 60 * (0.5 - t01) * 2;
        const g = t01 > 0.5 ? 120 * (1 - Math.abs(t01 - 0.7) * 2) : 120 * t01 * 2;
        const b = t01 > 0.5 ? 60 * (1 - (t01 - 0.5) * 2) : 220 * (0.5 - t01) * 2 + 60;
        ctx.fillStyle = `rgba(${r|0},${g|0},${b|0},${vstyle.tempAlpha})`;
        ctx.fillRect(i * CELL_W, SKY_TOP + j * CELL_H, CELL_W + 1, CELL_H + 1);
      }
    }
  }

  // ── Clouds ─────────────────────────────────────────────────────────────────
  if (showLayers.clouds) {
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const c = sim.cloud[idx(i, j)];
        if (c > 0.0003) {
          const alpha = clamp(c * 180, 0, 0.92);
          const gray = 255 - clamp(c * 4000, 0, 80);
          ctx.fillStyle = `rgba(${gray|0},${gray|0},${gray|0},${alpha})`;
          // Soft blob
          const cx = i * CELL_W + CELL_W / 2;
          const cy = SKY_TOP + j * CELL_H + CELL_H / 2;
          ctx.beginPath();
          ctx.arc(cx, cy, CELL_W * vstyle.cloudBlob, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // ── Wind arrows ────────────────────────────────────────────────────────────
  if (showLayers.wind) {
    const aa = vstyle.arrowAlpha;
    ctx.strokeStyle = `rgba(200,230,255,${aa})`;
    ctx.lineWidth = 1.2;
    for (let j = 0; j < ROWS; j += 3) {
      for (let i = 0; i < COLS; i += 3) {
        const k = idx(i, j);
        const u = sim.u[k], v = sim.v[k];
        const mag = Math.sqrt(u*u + v*v);
        if (mag < 0.3) continue;
        const cx = i * CELL_W + CELL_W / 2;
        const cy = SKY_TOP + j * CELL_H + CELL_H / 2;
        const scale = 6;
        const ex = cx + u * scale;
        const ey = cy + v * scale;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        // arrowhead
        const ang = Math.atan2(ey - cy, ex - cx);
        const hs = 3;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(ang - 0.4) * hs, ey - Math.sin(ang - 0.4) * hs);
        ctx.lineTo(ex - Math.cos(ang + 0.4) * hs, ey - Math.sin(ang + 0.4) * hs);
        ctx.closePath();
        ctx.fillStyle = `rgba(200,230,255,${vstyle.arrowAlpha})`;
        ctx.fill();
      }
    }
  }

  // ── Rain ───────────────────────────────────────────────────────────────────
  if (showLayers.clouds) {
    ctx.strokeStyle = 'rgba(160,210,255,0.55)';
    ctx.lineWidth = 1.1;
    for (let i = 0; i < COLS; i++) {
      const r = sim.rain[i];
      if (r < 0.02) continue;
      const nDrops = Math.min(24, r * 20);
      for (let d = 0; d < nDrops; d++) {
        const x = i * CELL_W + Math.random() * CELL_W;
        const y = SKY_TOP + Math.random() * (SURFACE_Y - SKY_TOP);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 2, y + 7);
        ctx.stroke();
      }
    }
  }

  // ── Ocean & Tides ──────────────────────────────────────────────────────────
  // Draw ocean water (with tide bulge raising the surface in ocean columns)
  ctx.fillStyle = '#0a2540';
  for (let i = 0; i < COLS; i++) {
    if (!sim.isLand[i]) {
      const x = i * CELL_W;
      const h = sim.tide[i];
      // Ocean body
      const grad = ctx.createLinearGradient(0, SURFACE_Y - h, 0, CH);
      grad.addColorStop(0, '#1a5d8f');
      grad.addColorStop(1, '#051a30');
      ctx.fillStyle = grad;
      ctx.fillRect(x, SURFACE_Y - h, CELL_W + 1, CH - (SURFACE_Y - h));
      // Highlight on the water surface
      ctx.fillStyle = 'rgba(180,220,255,0.4)';
      ctx.fillRect(x, SURFACE_Y - h - 1, CELL_W + 1, 1.5);
    }
  }

  // ── Land ───────────────────────────────────────────────────────────────────
  for (let i = 0; i < COLS; i++) {
    if (sim.isLand[i]) {
      const x = i * CELL_W;
      // Color land by temperature
      const T = sim.landT[i];
      const warm = clamp((T + 10) / 50, 0, 1);
      let r, g, b;
      if (isBlueprint) {
        r = 25; g = 70; b = 130;
      } else if (climate.surfaceHue === "sand") {
        r = lerp(180, 230, warm); g = lerp(150, 180, warm); b = lerp(90, 110, warm);
      } else if (climate.surfaceHue === "ice") {
        r = lerp(180, 230, warm); g = lerp(200, 235, warm); b = lerp(220, 245, warm);
      } else if (climate.surfaceHue === "rust") {
        r = lerp(140, 200, warm); g = lerp(60, 110, warm); b = lerp(40, 60, warm);
      } else {
        // grass (default)
        r = lerp(60, 170, warm);
        g = lerp(80, 120, warm);
        b = lerp(50, 70, 1 - warm);
      }
      ctx.fillStyle = `rgb(${r|0},${g|0},${b|0})`;
      ctx.fillRect(x, SURFACE_Y, CELL_W + 1, CH - SURFACE_Y);
      // Darker below
      const grad = ctx.createLinearGradient(0, SURFACE_Y, 0, CH);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.7)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, SURFACE_Y, CELL_W + 1, CH - SURFACE_Y);
    }
  }

  // Tide reference line (where sea level would be without moon)
  if (showLayers.tides) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, SURFACE_Y);
    ctx.lineTo(CW, SURFACE_Y);
    ctx.stroke();
    ctx.setLineDash([]);
    // Tide arrow from moon to bulge
    const bulgeI = Math.round(((moonInfo.x / CW) * COLS));
    let bx = 0, bh = 0;
    for (let di = -4; di <= 4; di++) {
      const ci = clamp(bulgeI + di, 0, COLS - 1);
      if (sim.tide[ci] > bh) { bh = sim.tide[ci]; bx = ci * CELL_W + CELL_W/2; }
    }
    if (bh > 3) {
      ctx.strokeStyle = 'rgba(180,220,255,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(moonInfo.x, moonInfo.y + 10);
      ctx.lineTo(bx, SURFACE_Y - bh - 4);
      ctx.stroke();
    }
  }

  // ── Pressure isobars ───────────────────────────────────────────────────────
  if (showLayers.pressure) {
    // Draw a few horizontal-ish contours based on T anomaly near surface.
    // For simplicity: show "H" and "L" markers where column-average T is extreme.
    const avg = [];
    for (let i = 0; i < COLS; i++) {
      let s = 0;
      for (let j = ROWS - 6; j < ROWS; j++) s += sim.T[idx(i, j)];
      avg.push(s / 6);
    }
    const mean = avg.reduce((a,b)=>a+b,0) / COLS;
    ctx.font = '700 18px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    for (let i = 2; i < COLS - 2; i += 4) {
      const a = avg[i];
      const x = i * CELL_W + CELL_W/2;
      const y = SKY_TOP + 60;
      if (a > mean + 3) {
        ctx.fillStyle = 'rgba(255,160,140,0.85)';
        ctx.fillText('L', x, y);
      } else if (a < mean - 3) {
        ctx.fillStyle = 'rgba(140,180,255,0.85)';
        ctx.fillText('H', x, y);
      }
    }
  }
}

// =============================================================================
// React UI
// =============================================================================
function App() {
  const canvasRef = useRef(null);
  const simRef = useRef(null);
  const rafRef = useRef(0);
  const lastTRef = useRef(0);
  const hudRef = useRef({ fps: 0, frames: 0, lastFps: 0 });

  const [params, setParams] = useState({
    solarIntensity: 1.0,
    axialTilt: 0,
    rotationSpeed: 1.0,
    moonMass: 1.0,
    moonDistance: 1.0,
    humidity: 1.0,
    timeScale: 20,
  });
  const DEFAULT_PARAMS = {
    solarIntensity: 1.0, axialTilt: 0, rotationSpeed: 1.0,
    moonMass: 1.0, moonDistance: 1.0, humidity: 1.0, timeScale: 20,
  };
  const DEFAULT_LAYERS = {
    temperature: true, wind: true, clouds: true, tides: true, pressure: false,
  };
  const paramsRef = useRef(params);
  useEffect(() => { paramsRef.current = params; }, [params]);

  const [showLayers, setShowLayers] = useState({
    temperature: true,
    wind: true,
    clouds: true,
    tides: true,
    pressure: false,
  });
  const showLayersRef = useRef(showLayers);
  useEffect(() => { showLayersRef.current = showLayers; }, [showLayers]);

  const [running, setRunning] = useState(true);
  const runningRef = useRef(running);
  useEffect(() => { runningRef.current = running; }, [running]);

  const [hud, setHud] = useState({ simHours: 0, day: 1, timeOfDay: 12, avgT: 15, totalRain: 0, cloudCover: 0 });
  const [lesson, setLesson] = useState(0); // 0..5 lesson index; -1 = sandbox

  // ── Tweaks: 3 expressive controls that reshape the whole feel ──────────────
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const tweaksRef = useRef(tweaks);
  useEffect(() => { tweaksRef.current = tweaks; }, [tweaks]);

  // When climate changes, apply its signature params + re-seed continents
  const prevClimateRef = useRef(tweaks.climate);
  useEffect(() => {
    if (prevClimateRef.current !== tweaks.climate) {
      prevClimateRef.current = tweaks.climate;
      const c = CLIMATES[tweaks.climate] || CLIMATES.earth;
      setParams(p => ({ ...p,
        solarIntensity: c.solar,
        humidity: c.humidity,
        moonMass: c.moon,
        axialTilt: c.tilt,
      }));
      const sim = makeSim();
      initLandMask(sim, tweaks.climate);
      initAtmosphere(sim);
      simRef.current = sim;
    }
  }, [tweaks.climate]);

  // Initialize sim
  useEffect(() => {
    const sim = makeSim();
    initLandMask(sim, tweaks.climate);
    initAtmosphere(sim);
    simRef.current = sim;
  }, []);

  const resetSim = useCallback(() => {
    const sim = makeSim();
    initLandMask(sim, tweaksRef.current.climate);
    initAtmosphere(sim);
    simRef.current = sim;
  }, []);

  const resetDefaults = useCallback(() => {
    setParams(DEFAULT_PARAMS);
    setShowLayers(DEFAULT_LAYERS);
    setTweak('climate', TWEAK_DEFAULTS.climate);
    setTweak('visualStyle', TWEAK_DEFAULTS.visualStyle);
    setTweak('chaos', TWEAK_DEFAULTS.chaos);
    // Re-seed the world too
    const sim = makeSim();
    initLandMask(sim, TWEAK_DEFAULTS.climate);
    initAtmosphere(sim);
    simRef.current = sim;
  }, []);

  // Apply lesson presets
  const applyLesson = useCallback((i) => {
    setLesson(i);
    if (i === -1) return; // sandbox
    const presets = [
      // 0: Heating & day/night
      { solarIntensity: 1.2, axialTilt: 0, rotationSpeed: 1, moonMass: 0, moonDistance: 1, humidity: 0.4, timeScale: 40,
        layers: { temperature: true, wind: false, clouds: false, tides: false, pressure: false } },
      // 1: Wind from pressure differences
      { solarIntensity: 1.3, axialTilt: 0, rotationSpeed: 1, moonMass: 0, moonDistance: 1, humidity: 0.3, timeScale: 30,
        layers: { temperature: true, wind: true, clouds: false, tides: false, pressure: true } },
      // 2: Evaporation → clouds → rain
      { solarIntensity: 1.5, axialTilt: 0, rotationSpeed: 1, moonMass: 0, moonDistance: 1, humidity: 1.8, timeScale: 30,
        layers: { temperature: false, wind: true, clouds: true, tides: false, pressure: false } },
      // 3: Seasons (axial tilt)
      { solarIntensity: 1.2, axialTilt: 23, rotationSpeed: 1, moonMass: 0, moonDistance: 1, humidity: 1.0, timeScale: 40,
        layers: { temperature: true, wind: true, clouds: true, tides: false, pressure: false } },
      // 4: Moon & tides
      { solarIntensity: 1.0, axialTilt: 0, rotationSpeed: 1, moonMass: 1.5, moonDistance: 0.9, humidity: 0.8, timeScale: 25,
        layers: { temperature: false, wind: false, clouds: true, tides: true, pressure: false } },
      // 5: Full sandbox / stormy
      { solarIntensity: 1.8, axialTilt: 10, rotationSpeed: 1.2, moonMass: 1.2, moonDistance: 1, humidity: 1.8, timeScale: 30,
        layers: { temperature: true, wind: true, clouds: true, tides: true, pressure: true } },
    ];
    const p = presets[i];
    setParams(pp => ({ ...pp, ...p, layers: undefined }));
    setShowLayers(p.layers);
    resetSim();
  }, [resetSim]);

  // Main animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    // HiDPI: set backing store to DPR, keep logical CW×CH coordinates
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = CW * dpr;
    canvas.height = CH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let last = performance.now();
    let acc = 0;

    const loop = (now) => {
      rafRef.current = requestAnimationFrame(loop);
      const dtReal = Math.min(0.05, (now - last) / 1000);
      last = now;

      const sim = simRef.current;
      if (!sim) return;
      const p = paramsRef.current;

      if (runningRef.current) {
        // Fixed sub-stepping for stability
        const simHoursThisFrame = dtReal * p.timeScale;
        const nSub = Math.max(1, Math.min(8, Math.ceil(simHoursThisFrame / 0.4)));
        const dtH = simHoursThisFrame / nSub;
        const dayLen = 24 / p.rotationSpeed;
        for (let s = 0; s < nSub; s++) {
          const tod = ((sim.simTime % dayLen) / dayLen) * 24;
          stepSim(sim, {
            ...p,
            chaos: tweaksRef.current.chaos || 0,
            timeOfDay: tod,
            dayLengthHrs: 24,
          }, dtH * p.rotationSpeed); // scale dt so day=24 regardless of rotationSpeed
        }
      }

      // Compute sun & moon position for drawing
      const dayLen = 24 / p.rotationSpeed;
      const tod = ((sim.simTime % dayLen) / dayLen) * 24;
      const hourAngle = (tod / 24) * 2 * Math.PI - Math.PI;
      const sunAlt = Math.cos(hourAngle) * Math.cos(p.axialTilt * Math.PI / 180);
      const sunX = CW * (0.5 + 0.48 * Math.sin(hourAngle));
      const sunY = SKY_TOP + 40 + (1 - Math.max(0, sunAlt)) * 260;

      const moonAngle = hourAngle + Math.PI; // opposite side
      const moonAlt = Math.cos(moonAngle);
      const moonX = CW * (0.5 + 0.48 * Math.sin(moonAngle));
      const moonY = SKY_TOP + 60 + (1 - Math.max(0, moonAlt)) * 240;

      drawSim(ctx, sim, p, showLayersRef.current,
        { alt: sunAlt, x: sunX, y: sunY },
        { alt: moonAlt, x: moonX, y: moonY },
        tweaksRef.current);

      // HUD update (throttled)
      hudRef.current.frames++;
      if (now - hudRef.current.lastFps > 400) {
        hudRef.current.lastFps = now;
        let tSum = 0, cSum = 0, cN = 0;
        for (let i = 0; i < COLS; i++) {
          tSum += sim.isLand[i] ? sim.landT[i] : sim.oceanT[i];
        }
        for (let k = 0; k < sim.cloud.length; k++) {
          if (sim.cloud[k] > 0.0005) cN++;
          cSum += sim.cloud[k];
        }
        setHud({
          simHours: sim.simTime,
          day: Math.floor(sim.simTime / 24) + 1,
          timeOfDay: tod,
          avgT: tSum / COLS,
          totalRain: sim.totalRain,
          cloudCover: (cN / sim.cloud.length) * 100,
        });
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // Responsive scale: fit 1280×720 within viewport
  const wrapperRef = useRef(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const onResize = () => {
      const el = wrapperRef.current;
      if (!el) return;
      // reserve 360px for sidebar
      const availW = window.innerWidth - 360 - 48;
      const availH = window.innerHeight - 48;
      const s = Math.min(availW / CW, availH / CH, 1);
      setScale(s);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const update = (k, v) => setParams(p => ({ ...p, [k]: v }));
  const toggle = (k) => setShowLayers(s => ({ ...s, [k]: !s[k] }));

  return (
    <div style={styles.root}>
      <div style={styles.stageCol}>
        <div ref={wrapperRef} style={styles.stageWrap}>
          <div style={{
            width: CW * scale, height: CH * scale,
            position: 'relative', borderRadius: 14, overflow: 'hidden',
            boxShadow: '0 30px 80px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.06)',
          }}>
          <div style={{
            width: CW, height: CH, transform: `scale(${scale})`, transformOrigin: 'top left',
            position: 'absolute', left: 0, top: 0,
          }}>
            <canvas ref={canvasRef} style={{ display: 'block', width: CW, height: CH }} />
            {/* Overlay legend */}
            <Overlay hud={hud} params={params} />
            {lesson !== -1 && <LessonCard idx={lesson} onClose={() => setLesson(-1)} onNext={() => applyLesson(Math.min(5, lesson + 1))} onPrev={() => applyLesson(Math.max(0, lesson - 1))} />}
          </div>
          </div>
        </div>
      </div>

      <Sidebar
        params={params}
        update={update}
        showLayers={showLayers}
        toggle={toggle}
        running={running}
        setRunning={setRunning}
        resetSim={resetSim}
        resetDefaults={resetDefaults}
        lesson={lesson}
        applyLesson={applyLesson}
        hud={hud}
      />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Climate preset" />
        <TweakSelect
          label="World"
          value={tweaks.climate}
          options={[
            { value: 'earth', label: 'Earth' },
            { value: 'desert', label: 'Desert' },
            { value: 'iceage', label: 'Ice Age' },
            { value: 'waterworld', label: 'Water World' },
            { value: 'venus', label: 'Venus-like' },
          ]}
          onChange={(v) => setTweak('climate', v)}
        />

        <TweakSection label="Visual style" />
        <TweakRadio
          label="Look"
          value={tweaks.visualStyle}
          options={[
            { value: 'scientific', label: 'Scientific' },
            { value: 'painterly', label: 'Painterly' },
            { value: 'blueprint', label: 'Blueprint' },
          ]}
          onChange={(v) => setTweak('visualStyle', v)}
        />

        <TweakSection label="Atmosphere feel" />
        <TweakSlider
          label="Chaos"
          value={tweaks.chaos}
          min={0} max={1} step={0.01}
          onChange={(v) => setTweak('chaos', v)}
        />
      </TweaksPanel>
    </div>
  );
}

// =============================================================================
// HUD Overlay — floating readout on top-left of canvas
// =============================================================================
function Overlay({ hud, params }) {
  const hh = Math.floor(hud.timeOfDay);
  const mm = Math.floor((hud.timeOfDay - hh) * 60);
  const tod = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  return (
    <div style={{
      position: 'absolute', left: 20, top: 20,
      background: 'rgba(10,14,24,0.7)', backdropFilter: 'blur(8px)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 10, padding: '14px 16px',
      fontFamily: "'JetBrains Mono', monospace",
      color: '#d8e4f0', fontSize: 13, lineHeight: 1.7,
      minWidth: 200,
    }}>
      <div style={{ fontSize: 11, letterSpacing: '0.15em', color: '#7a94b0', marginBottom: 6 }}>SIMULATION</div>
      <div><span style={{ color: '#7a94b0' }}>DAY</span>    <b style={{ color: '#fff' }}>{hud.day}</b> &nbsp; <span style={{ color: '#7a94b0' }}>TIME</span>  <b style={{ color: '#fff' }}>{tod}</b></div>
      <div><span style={{ color: '#7a94b0' }}>AVG T</span>  <b style={{ color: '#ffd089' }}>{hud.avgT.toFixed(1)}°C</b></div>
      <div><span style={{ color: '#7a94b0' }}>CLOUDS</span> <b style={{ color: '#bcd' }}>{hud.cloudCover.toFixed(0)}%</b></div>
      <div><span style={{ color: '#7a94b0' }}>RAIN</span>   <b style={{ color: '#8ecbff' }}>{hud.totalRain.toFixed(1)}</b></div>
      <div style={{ marginTop: 6, fontSize: 10, color: '#556d88', letterSpacing: '0.08em' }}>
        {params.timeScale}× · {params.rotationSpeed.toFixed(1)}× spin
      </div>
    </div>
  );
}

// =============================================================================
// Lesson Card
// =============================================================================
const LESSONS = [
  {
    title: "01 · Sun heats the Earth",
    body: "Watch the ground warm during the day and cool at night. Land (green) heats up and cools down much faster than ocean (blue). Try raising ",
    bodyBold: "solar intensity",
    rest: " and see how the daily temperature swing changes.",
    try: ["Drag SOLAR INTENSITY up to 2.0 — desert by day.", "Drag TIME SCALE up to watch many days pass.", "Cold blue = colder cells, warm red = hotter."],
  },
  {
    title: "02 · Pressure makes wind",
    body: "Warm air expands and has ",
    bodyBold: "lower pressure",
    rest: ". Cool air is dense and has higher pressure. Wind is simply air flowing from H to L. Notice the sea-breeze: midday the land heats, air rises, and cooler ocean air rushes in.",
    try: ["Turn on PRESSURE layer — watch H and L markers.", "Watch arrows blow from H → L.", "At night the flow reverses (land breeze)."],
  },
  {
    title: "03 · Water becomes clouds & rain",
    body: "The sun evaporates ocean water. That water vapor ",
    bodyBold: "rises with warm air",
    rest: ", then cools with altitude. Cold air can't hold as much water — so it condenses into cloud droplets. When droplets merge enough, they fall as rain.",
    try: ["Crank HUMIDITY to 2.0 to see storms form.", "Watch where clouds form: over warm updrafts.", "Rain cools the ground beneath it."],
  },
  {
    title: "04 · Axial tilt = seasons",
    body: "Earth is tilted about 23°. That tilt changes the ",
    bodyBold: "angle of sunlight",
    rest: ", not the distance. Steeper angles = less heating per square meter. This is why summer is hot and winter is cold, and why the equator is always warm.",
    try: ["Slide AXIAL TILT from 0° to 30°.", "A higher tilt at this latitude dims the sun.", "Try tilt at 0° — perpetual spring."],
  },
  {
    title: "05 · The Moon pulls the oceans",
    body: "The Moon's gravity is weaker on the far side of Earth than the near side. That ",
    bodyBold: "difference",
    rest: " stretches the oceans into two bulges — one facing the Moon, one opposite. As Earth rotates through those bulges, coastlines see two high tides a day.",
    try: ["Move MOON DISTANCE closer (0.5) — huge tides.", "MOON MASS 0 = no tides at all.", "Notice: the bulge follows the Moon across the sky."],
  },
  {
    title: "06 · Put it all together",
    body: "All the systems interact. High sun + high humidity = thunderstorms. High tilt + slow rotation = extreme climates. High moon mass + close moon = dramatic tides reshaping coastlines daily. ",
    bodyBold: "Play!",
    rest: " Every variable is yours.",
    try: ["Freeze time with ⏸ and inspect.", "Reset to get a fresh atmosphere.", "Try a tidally-locked world: rotation 0.1×."],
  },
];

function LessonCard({ idx, onClose, onNext, onPrev }) {
  const L = LESSONS[idx];
  return (
    <div style={{
      position: 'absolute', right: 24, bottom: 24, width: 380,
      background: 'linear-gradient(180deg, rgba(15,22,36,0.96), rgba(8,12,22,0.96))',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 14, padding: '20px 22px',
      fontFamily: "'DM Sans', sans-serif",
      color: '#e4eaf4',
      boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: '0.2em', color: '#7a94b0' }}>LESSON</div>
        <button onClick={onClose} style={styles.iconBtn}>×</button>
      </div>
      <div style={{ fontSize: 21, fontWeight: 600, marginBottom: 10, lineHeight: 1.25 }}>{L.title}</div>
      <div style={{ fontSize: 14, lineHeight: 1.55, color: '#b8c5d6', marginBottom: 14 }}>
        {L.body}<b style={{ color: '#ffd089' }}>{L.bodyBold}</b>{L.rest}
      </div>
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12, marginBottom: 14 }}>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '0.2em', color: '#7a94b0', marginBottom: 8 }}>TRY THIS</div>
        {L.try.map((t, i) => (
          <div key={i} style={{ fontSize: 13, color: '#c8d4e4', marginBottom: 5, paddingLeft: 16, position: 'relative' }}>
            <span style={{ position: 'absolute', left: 0, color: '#4a6584' }}>→</span>{t}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={onPrev} disabled={idx === 0} style={{ ...styles.navBtn, opacity: idx === 0 ? 0.35 : 1 }}>← Prev</button>
        <div style={{ flex: 1, textAlign: 'center', fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#7a94b0' }}>
          {idx + 1} / {LESSONS.length}
        </div>
        <button onClick={onNext} disabled={idx === LESSONS.length - 1} style={{ ...styles.navBtn, opacity: idx === LESSONS.length - 1 ? 0.35 : 1 }}>Next →</button>
      </div>
    </div>
  );
}

// =============================================================================
// Sidebar
// =============================================================================
function Sidebar({ params, update, showLayers, toggle, running, setRunning, resetSim, resetDefaults, lesson, applyLesson, hud }) {
  return (
    <div style={styles.sidebar}>
      <div style={{ padding: '22px 22px 10px' }}>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '0.25em', color: '#7a94b0' }}>INTERACTIVE</div>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em', color: '#fff', marginTop: 4 }}>Weather Sandbox</div>
        <div style={{ fontSize: 12, color: '#7a94b0', marginTop: 6, lineHeight: 1.5 }}>
          A live physics simulation of Earth's atmosphere, hydrosphere, and the Moon.
        </div>
      </div>

      <div style={styles.divider} />

      {/* Lesson chips */}
      <div style={{ padding: '14px 22px' }}>
        <SectionLabel>LESSONS</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
          {LESSONS.map((L, i) => (
            <button key={i} onClick={() => applyLesson(i)}
              style={{ ...styles.lessonChip, ...(lesson === i ? styles.lessonChipActive : {}) }}>
              <span style={{ color: lesson === i ? '#ffd089' : '#7a94b0', fontFamily: "'JetBrains Mono', monospace" }}>{String(i+1).padStart(2,'0')}</span>
              <span style={{ marginLeft: 8 }}>{L.title.split('· ')[1]}</span>
            </button>
          ))}
          <button onClick={() => applyLesson(-1)}
            style={{ ...styles.lessonChip, gridColumn: 'span 2', ...(lesson === -1 ? styles.lessonChipActive : {}) }}>
            <span style={{ color: lesson === -1 ? '#ffd089' : '#7a94b0', fontFamily: "'JetBrains Mono', monospace" }}>∞</span>
            <span style={{ marginLeft: 8 }}>Free Sandbox</span>
          </button>
        </div>
      </div>

      <div style={styles.divider} />

      {/* Controls */}
      <div style={{ padding: '14px 22px' }}>
        <SectionLabel>PHYSICS VARIABLES</SectionLabel>
        <Slider label="Solar intensity" unit="×" value={params.solarIntensity} min={0} max={2} step={0.05}
          onChange={v => update('solarIntensity', v)} hint="Energy from the Sun" />
        <Slider label="Axial tilt" unit="°" value={params.axialTilt} min={0} max={45} step={1}
          onChange={v => update('axialTilt', v)} hint="Earth's tilt → seasons" />
        <Slider label="Rotation speed" unit="×" value={params.rotationSpeed} min={0.1} max={4} step={0.05}
          onChange={v => update('rotationSpeed', v)} hint="How fast Earth spins" />
        <Slider label="Humidity" unit="×" value={params.humidity} min={0} max={2} step={0.05}
          onChange={v => update('humidity', v)} hint="Evaporation rate" />
      </div>

      <div style={styles.divider} />

      <div style={{ padding: '14px 22px' }}>
        <SectionLabel>MOON</SectionLabel>
        <Slider label="Moon mass" unit="×" value={params.moonMass} min={0} max={3} step={0.05}
          onChange={v => update('moonMass', v)} hint="0 = no moon" />
        <Slider label="Moon distance" unit="×" value={params.moonDistance} min={0.5} max={2} step={0.05}
          onChange={v => update('moonDistance', v)} hint="Closer → huge tides" />
      </div>

      <div style={styles.divider} />

      <div style={{ padding: '14px 22px' }}>
        <SectionLabel>TIME</SectionLabel>
        <Slider label="Time scale" unit="× sim h/s" value={params.timeScale} min={0} max={120} step={1}
          onChange={v => update('timeScale', v)} hint="Simulated hours per real second" />
      </div>

      <div style={styles.divider} />

      <div style={{ padding: '14px 22px' }}>
        <SectionLabel>LAYERS</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
          <Toggle label="Temperature" active={showLayers.temperature} onClick={() => toggle('temperature')} color="#ff9170" />
          <Toggle label="Wind" active={showLayers.wind} onClick={() => toggle('wind')} color="#bcd" />
          <Toggle label="Clouds & Rain" active={showLayers.clouds} onClick={() => toggle('clouds')} color="#fff" />
          <Toggle label="Pressure H/L" active={showLayers.pressure} onClick={() => toggle('pressure')} color="#8cf" />
          <Toggle label="Tide lines" active={showLayers.tides} onClick={() => toggle('tides')} color="#9ff" />
        </div>
      </div>

      <div style={styles.divider} />

      <div style={{ padding: '14px 22px 22px' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button onClick={() => setRunning(r => !r)} style={styles.bigBtn}>
            {running ? '⏸  Pause' : '▶  Play'}
          </button>
          <button onClick={resetSim} style={{ ...styles.bigBtn, background: 'transparent', border: '1px solid rgba(255,255,255,0.14)', color: '#d8e4f0' }}>
            ↻  Reset sim
          </button>
        </div>
        <button onClick={resetDefaults} style={{ ...styles.bigBtn, width: '100%', background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: '#7a94b0', fontSize: 12, padding: '10px', fontWeight: 500 }}>
          Reset all to defaults
        </button>
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '0.25em', color: '#7a94b0', marginBottom: 4 }}>{children}</div>;
}

function Slider({ label, unit, value, min, max, step, onChange, hint }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 13, color: '#d8e4f0', fontWeight: 500 }}>{label}</span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#ffd089' }}>{Number(value).toFixed(step < 1 ? 2 : 0)}{unit}</span>
      </div>
      <div style={{ position: 'relative', height: 18 }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 8, height: 2, background: 'rgba(255,255,255,0.08)', borderRadius: 1 }} />
        <div style={{ position: 'absolute', left: 0, width: `${pct}%`, top: 8, height: 2, background: 'linear-gradient(90deg, #6aa8ff, #ffd089)', borderRadius: 1 }} />
        <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))}
          style={{ position: 'absolute', inset: 0, width: '100%', opacity: 0, cursor: 'pointer', margin: 0 }} />
        <div style={{ position: 'absolute', left: `calc(${pct}% - 6px)`, top: 3, width: 12, height: 12, borderRadius: '50%',
          background: '#fff', boxShadow: '0 0 0 3px rgba(106,168,255,0.25), 0 2px 6px rgba(0,0,0,0.4)', pointerEvents: 'none' }} />
      </div>
      {hint && <div style={{ fontSize: 11, color: '#556d88', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function Toggle({ label, active, onClick, color }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 10px', background: active ? 'rgba(255,208,137,0.08)' : 'rgba(255,255,255,0.02)',
      border: `1px solid ${active ? 'rgba(255,208,137,0.35)' : 'rgba(255,255,255,0.06)'}`,
      borderRadius: 8, color: '#d8e4f0', fontSize: 12, fontWeight: 500,
      cursor: 'pointer', textAlign: 'left', fontFamily: "'DM Sans', sans-serif",
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: active ? color : 'rgba(255,255,255,0.2)', flexShrink: 0 }} />
      {label}
    </button>
  );
}

// =============================================================================
// Styles
// =============================================================================
const styles = {
  root: {
    display: 'flex', width: '100vw', height: '100vh',
    background: 'radial-gradient(ellipse at 20% 0%, #0e1830 0%, #050810 50%)',
  },
  stageCol: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 24, minWidth: 0, overflow: 'hidden',
  },
  stageWrap: {
    position: 'relative',
  },
  sidebar: {
    width: 360, flexShrink: 0, height: '100vh', overflowY: 'auto',
    background: 'linear-gradient(180deg, rgba(10,14,24,0.9), rgba(5,8,16,0.9))',
    borderLeft: '1px solid rgba(255,255,255,0.06)',
    color: '#d8e4f0', fontFamily: "'DM Sans', sans-serif",
  },
  divider: { height: 1, background: 'rgba(255,255,255,0.05)', margin: '0 22px' },
  lessonChip: {
    display: 'flex', alignItems: 'center',
    padding: '9px 10px', background: 'rgba(255,255,255,0.02)',
    border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8,
    color: '#d8e4f0', fontSize: 12, fontWeight: 500, cursor: 'pointer',
    textAlign: 'left', fontFamily: "'DM Sans', sans-serif",
  },
  lessonChipActive: {
    background: 'rgba(255,208,137,0.08)',
    border: '1px solid rgba(255,208,137,0.35)',
  },
  iconBtn: {
    width: 26, height: 26, borderRadius: 6, border: 'none',
    background: 'rgba(255,255,255,0.06)', color: '#fff',
    fontSize: 20, lineHeight: 1, cursor: 'pointer',
  },
  navBtn: {
    padding: '7px 12px', background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: 7,
    color: '#fff', fontSize: 12, fontWeight: 500, cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
  },
  bigBtn: {
    flex: 1, padding: '12px', background: 'linear-gradient(180deg, #ffd089, #f0a050)',
    border: 'none', borderRadius: 10, color: '#2a1a08',
    fontSize: 14, fontWeight: 600, cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
  },
};

// =============================================================================
// Mount
// =============================================================================
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
