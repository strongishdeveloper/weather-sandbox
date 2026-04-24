// =============================================================================
// info-panel.jsx — Expanded multi-section info panel for Weather Sandbox v2
// =============================================================================
// Sections: Probe, Cross-section, Global stats, Sun/Moon, Lesson card.
// Collapsible + resizable so it doesn't fight the 3D view on small screens.
// =============================================================================

const LESSONS = [
  {
    title: "01 · Sun heats the Earth",
    body: "Watch the ground warm under the sub-solar point and cool on the night side. Land warms and cools much faster than ocean. Try raising ",
    bodyBold: "solar intensity",
    rest: " and watch the equator-pole gradient deepen.",
    try: ["Drag SOLAR INTENSITY up to 2.0 — desert by day.", "Pump TIME SCALE to watch many days pass.", "Cold blue cells lag warm red cells."],
    preset: { solarIntensity: 1.2, axialTilt: 0, rotationSpeed: 1, moonMass: 0, moonDistance: 1, humidity: 0.4, timeScale: 40,
              layers: { temperature: true, wind: false, clouds: false, tides: false, pressure: false } },
  },
  {
    title: "02 · Pressure makes wind",
    body: "Warm air expands and has ",
    bodyBold: "lower pressure",
    rest: ". Cool air is dense and high pressure. Wind flows H → L, then Coriolis curves it: trade winds, westerlies, polar easterlies.",
    try: ["Toggle PRESSURE — H/L markers appear.", "Watch arrows curve right in the north.", "Crank rotation to amplify Coriolis."],
    preset: { solarIntensity: 1.3, axialTilt: 0, rotationSpeed: 1, moonMass: 0, moonDistance: 1, humidity: 0.3, timeScale: 30,
              layers: { temperature: true, wind: true, clouds: false, tides: false, pressure: true } },
  },
  {
    title: "03 · Water becomes clouds & rain",
    body: "The sun evaporates ocean water. That vapor ",
    bodyBold: "rises with warm air",
    rest: " and cools. Cold air can't hold as much water — it condenses into cloud, then rains out, releasing latent heat that fuels storms.",
    try: ["Crank HUMIDITY to 2.0 to spawn storms.", "Clouds form over warm convergence zones.", "Rain cools the surface beneath it."],
    preset: { solarIntensity: 1.5, axialTilt: 0, rotationSpeed: 1, moonMass: 0, moonDistance: 1, humidity: 1.8, timeScale: 30,
              layers: { temperature: false, wind: true, clouds: true, tides: false, pressure: false } },
  },
  {
    title: "04 · Axial tilt = seasons",
    body: "Earth is tilted about 23°. That tilt changes the ",
    bodyBold: "angle of sunlight",
    rest: " across the seasons. Steeper angles = less heating per square meter. Try tilting to 30°.",
    try: ["Slide AXIAL TILT from 0° to 30°.", "Notice one pole baking, the other freezing.", "Equator stays warm year-round."],
    preset: { solarIntensity: 1.2, axialTilt: 23, rotationSpeed: 1, moonMass: 0, moonDistance: 1, humidity: 1.0, timeScale: 40,
              layers: { temperature: true, wind: true, clouds: true, tides: false, pressure: false } },
  },
  {
    title: "05 · The Moon pulls the oceans",
    body: "The Moon's gravity is weaker on the far side of Earth than the near side. That ",
    bodyBold: "difference",
    rest: " stretches the oceans into two bulges — one toward the Moon, one opposite. Coastlines see two high tides per day.",
    try: ["Drop MOON DISTANCE to 0.5 for huge tides.", "Set MOON MASS to 0 — bulges vanish.", "Toggle TIDES to see the displacement field."],
    preset: { solarIntensity: 1.0, axialTilt: 0, rotationSpeed: 1, moonMass: 1.5, moonDistance: 0.9, humidity: 0.8, timeScale: 25,
              layers: { temperature: false, wind: false, clouds: true, tides: true, pressure: false } },
  },
  {
    title: "06 · Put it all together",
    body: "Everything is coupled. High sun + high humidity = thunderstorms. High tilt + slow rotation = extreme climates. Close moon = tide-driven coasts. ",
    bodyBold: "Play.",
    rest: " Every variable, every layer, every climate — yours.",
    try: ["Pause and rotate the globe to inspect.", "Click anywhere to probe a cell.", "Try Climate → Venus-like for chaos."],
    preset: { solarIntensity: 1.8, axialTilt: 10, rotationSpeed: 1.2, moonMass: 1.2, moonDistance: 1, humidity: 1.8, timeScale: 30,
              layers: { temperature: true, wind: true, clouds: true, tides: true, pressure: true } },
  },
];

// =============================================================================
// Mini cross-section canvas — visualises a latitude slice through the probe
// =============================================================================
function CrossSection({ sim, probe, width = 320, height = 96 }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = width * dpr; cv.height = height * dpr;
    cv.style.width = width + 'px'; cv.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!sim || !probe) {
      ctx.fillStyle = 'rgba(120,140,170,0.45)';
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Click globe to probe a latitude slice', width / 2, height / 2);
      return;
    }
    const j = probe.j;
    // Sky region (top ~70%) shows surface T; surface row at bottom shows land/ocean.
    const surfaceY = height * 0.78;
    // Background gradient (sky)
    const bg = ctx.createLinearGradient(0, 0, 0, surfaceY);
    bg.addColorStop(0, '#0a1428');
    bg.addColorStop(1, '#1d3050');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, surfaceY);
    // Plot air T as a coloured band
    for (let i = 0; i < LON; i++) {
      const k = idx(i, j);
      const t01 = clamp((sim.T[k] + 30) / 60, 0, 1);
      const r = t01 > 0.5 ? 220 * (t01 - 0.5) * 2 : 60 * (0.5 - t01) * 2;
      const g = t01 > 0.5 ? 120 * (1 - Math.abs(t01 - 0.7) * 2) : 120 * t01 * 2;
      const b = t01 > 0.5 ? 60 * (1 - (t01 - 0.5) * 2) : 220 * (0.5 - t01) * 2 + 60;
      ctx.fillStyle = `rgba(${r|0},${g|0},${b|0},0.55)`;
      ctx.fillRect((i / LON) * width, 0, width / LON + 1, surfaceY);
    }
    // Cloud strip (above surface)
    for (let i = 0; i < LON; i++) {
      const k = idx(i, j);
      const c = sim.cloud[k];
      if (c < 0.0003) continue;
      const a = clamp(c * 180, 0, 0.85);
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      const cx = (i / LON) * width + width / LON / 2;
      ctx.beginPath();
      ctx.arc(cx, surfaceY * 0.45, width / LON * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
    // Surface (land/ocean) row
    for (let i = 0; i < LON; i++) {
      const k = idx(i, j);
      ctx.fillStyle = sim.isLand[k] ? '#3a5a30' : '#0a2540';
      ctx.fillRect((i / LON) * width, surfaceY, width / LON + 1, height - surfaceY);
    }
    // Probe marker
    const px = ((probe.i + 0.5) / LON) * width;
    ctx.strokeStyle = '#ffd089';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0); ctx.lineTo(px, height);
    ctx.stroke();
  }, [sim, probe, width, height]);

  return <canvas ref={ref} style={{ display: 'block', borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)' }} />;
}

// =============================================================================
// InfoPanel — multi-section, collapsible, resizable
// =============================================================================
function InfoPanel({
  sim, probe, stats, sun, moon, params, lesson, onLesson, onClose, hud,
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [width, setWidth] = React.useState(() => Math.max(320, Math.min(440, window.innerWidth * 0.28)));
  const dragRef = React.useRef(null);

  // Resize handle
  const onResizeStart = (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = width;
    const onMove = (ev) => {
      const dx = startX - ev.clientX;
      setWidth(Math.max(280, Math.min(window.innerWidth * 0.55, startW + dx)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (collapsed) {
    return (
      <button onClick={() => setCollapsed(false)} style={ipStyles.expandBtn} aria-label="Expand info panel">
        ◀ Info
      </button>
    );
  }

  const fmt = (n, d = 1) => (n == null || !isFinite(n) ? '—' : Number(n).toFixed(d));
  const fmtLat = (rad) => `${Math.abs(rad * 180 / Math.PI).toFixed(1)}°${rad >= 0 ? 'N' : 'S'}`;
  const fmtLon = (rad) => `${Math.abs(rad * 180 / Math.PI).toFixed(1)}°${rad >= 0 ? 'E' : 'W'}`;
  const windDir = (u, v) => {
    if (Math.abs(u) + Math.abs(v) < 0.05) return '—';
    const ang = Math.atan2(v, u) * 180 / Math.PI; // 0 = east, 90 = north
    const dirs = ['E','NE','N','NW','W','SW','S','SE'];
    const i = Math.round(((ang + 360) % 360) / 45) % 8;
    return dirs[i];
  };
  const windMag = (u, v) => Math.sqrt(u * u + v * v);

  // Sun declination ≈ axial tilt * sin(2π * dayOfYear/365). Without a true day-of-year
  // we use simTime as a proxy: one "year" = 64 sim-days.
  const yearFrac = ((sim?.simTime || 0) / (24 * 64));
  const sunDecl = (params.axialTilt) * Math.sin(yearFrac * 2 * Math.PI);
  const moonPhase = (((sim?.simTime || 0) / (24 * 27.3)) % 1);
  const moonPhaseLabel =
    moonPhase < 0.05 || moonPhase > 0.95 ? 'New' :
    moonPhase < 0.20 ? 'Waxing crescent' :
    moonPhase < 0.30 ? 'First quarter' :
    moonPhase < 0.45 ? 'Waxing gibbous' :
    moonPhase < 0.55 ? 'Full' :
    moonPhase < 0.70 ? 'Waning gibbous' :
    moonPhase < 0.80 ? 'Last quarter' : 'Waning crescent';

  // Solar zenith angle at probe:
  let zen = '—';
  if (probe && sun?.sunDir) {
    const cl = Math.cos(probe.lat), sl = Math.sin(probe.lat);
    const nx = cl * Math.sin(probe.lon);
    const ny = sl;
    const nz = cl * Math.cos(probe.lon);
    const cosZ = clamp(nx * sun.sunDir.x + ny * sun.sunDir.y + nz * sun.sunDir.z, -1, 1);
    zen = `${(Math.acos(cosZ) * 180 / Math.PI).toFixed(0)}°`;
  }

  return (
    <div style={{ ...ipStyles.panel, width }} ref={dragRef}>
      {/* Resize handle on the LEFT edge */}
      <div onMouseDown={onResizeStart} style={ipStyles.resizeHandle} title="Drag to resize" />

      <div style={ipStyles.header}>
        <div>
          <div style={ipStyles.eyebrow}>SIMULATION READOUT</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#fff' }}>Earth, live</div>
        </div>
        <button onClick={() => setCollapsed(true)} style={ipStyles.iconBtn} aria-label="Collapse">→</button>
      </div>

      <div style={ipStyles.scroll}>
        {/* ── Global stats ─────────────────────────────────────── */}
        <Section label="GLOBAL">
          <Grid>
            <Stat k="DAY"        v={hud.day} unit="" hi />
            <Stat k="TIME"       v={`${String(Math.floor(hud.timeOfDay)).padStart(2,'0')}:${String(Math.floor((hud.timeOfDay%1)*60)).padStart(2,'0')}`} />
            <Stat k="MEAN SURF T" v={fmt(stats?.avgT)} unit="°C" warm />
            <Stat k="T RANGE"    v={`${fmt(stats?.minT, 0)} … ${fmt(stats?.maxT, 0)}`} unit="°C" />
            <Stat k="CLOUD COVER" v={fmt(stats?.cloudCover, 0)} unit="%" />
            <Stat k="RAIN RATE"  v={fmt(stats?.rainRate, 1)} unit="" />
            <Stat k="TIDE RANGE" v={fmt(stats && stats.tideRange * 1000, 1)} unit="m" />
            <Stat k="TOTAL RAIN" v={fmt(sim?.totalRain, 0)} unit="" />
          </Grid>
        </Section>

        {/* ── Sun & Moon ──────────────────────────────────────── */}
        <Section label="SUN & MOON">
          <Grid>
            <Stat k="SUN DECL"   v={fmt(sunDecl, 1)} unit="°" />
            <Stat k="ZENITH @ PROBE" v={zen} />
            <Stat k="MOON PHASE" v={moonPhaseLabel} />
            <Stat k="TIDAL FORCE" v={fmt(params.moonMass / Math.pow(params.moonDistance, 3), 2)} unit="×" />
          </Grid>
        </Section>

        {/* ── Probe ───────────────────────────────────────────── */}
        <Section label="PROBE">
          {!probe ? (
            <div style={ipStyles.hint}>Click anywhere on the globe to pin a probe.</div>
          ) : (
            <>
              <div style={{ marginBottom: 8, fontSize: 12, color: '#7a94b0', fontFamily: "'JetBrains Mono', monospace" }}>
                {fmtLat(probe.lat)}  ·  {fmtLon(probe.lon)}  ·  {probe.isLand ? 'LAND' : 'OCEAN'}
              </div>
              <Grid>
                <Stat k="AIR T"     v={fmt(probe.T)}     unit="°C" warm />
                <Stat k="SURF T"    v={fmt(probe.surfT)} unit="°C" />
                <Stat k="HUMIDITY"  v={fmt(probe.q * 1000, 2)} unit="g/kg" />
                <Stat k="CLOUD"     v={fmt(probe.cloud * 1000, 2)} unit="g/kg" />
                <Stat k="WIND"      v={`${fmt(windMag(probe.u, probe.v), 1)} ${windDir(probe.u, probe.v)}`} />
                <Stat k="RAIN"      v={fmt(probe.rain, 2)} />
                {!probe.isLand && <Stat k="TIDE"     v={fmt(probe.tide * 1000, 1)} unit="m" />}
              </Grid>
            </>
          )}
        </Section>

        {/* ── Cross-section ───────────────────────────────────── */}
        <Section label="CROSS-SECTION (latitude slice)">
          <CrossSection sim={sim} probe={probe} width={width - 40} height={96} />
          <div style={ipStyles.hint}>
            Vertical band shows air temperature along the probed latitude. White blobs = clouds; the bottom strip is land (green) / ocean (blue).
          </div>
        </Section>

        {/* ── Lessons ─────────────────────────────────────────── */}
        <Section label="LESSONS">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {LESSONS.map((L, i) => (
              <button key={i} onClick={() => onLesson(i)}
                style={{ ...ipStyles.lessonChip, ...(lesson === i ? ipStyles.lessonChipActive : {}) }}>
                <span style={{ color: lesson === i ? '#ffd089' : '#7a94b0', fontFamily: "'JetBrains Mono', monospace" }}>
                  {String(i+1).padStart(2,'0')}
                </span>
                <span style={{ marginLeft: 8 }}>{L.title.split('· ')[1]}</span>
              </button>
            ))}
            <button onClick={() => onLesson(-1)}
              style={{ ...ipStyles.lessonChip, gridColumn: 'span 2', ...(lesson === -1 ? ipStyles.lessonChipActive : {}) }}>
              <span style={{ color: lesson === -1 ? '#ffd089' : '#7a94b0', fontFamily: "'JetBrains Mono', monospace" }}>∞</span>
              <span style={{ marginLeft: 8 }}>Free Sandbox</span>
            </button>
          </div>

          {lesson !== -1 && lesson != null && LESSONS[lesson] && (
            <div style={ipStyles.lessonCard}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>{LESSONS[lesson].title}</div>
              <div style={{ fontSize: 13, lineHeight: 1.5, color: '#b8c5d6', marginBottom: 10 }}>
                {LESSONS[lesson].body}
                <b style={{ color: '#ffd089' }}>{LESSONS[lesson].bodyBold}</b>
                {LESSONS[lesson].rest}
              </div>
              <div style={ipStyles.eyebrow}>TRY THIS</div>
              {LESSONS[lesson].try.map((t, i) => (
                <div key={i} style={{ fontSize: 12, color: '#c8d4e4', marginTop: 4, paddingLeft: 14, position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 0, color: '#4a6584' }}>→</span>{t}
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={ipStyles.eyebrow}>{label}</div>
      <div style={{ marginTop: 8 }}>{children}</div>
    </div>
  );
}
function Grid({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>{children}</div>;
}
function Stat({ k, v, unit = '', warm = false, hi = false }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.025)',
      border: '1px solid rgba(255,255,255,0.05)',
      borderRadius: 7, padding: '8px 10px',
    }}>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, letterSpacing: '0.18em', color: '#7a94b0' }}>{k}</div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: hi ? 17 : 14, marginTop: 2, fontWeight: 600,
        color: warm ? '#ffd089' : '#ffffff',
      }}>{v}<span style={{ fontSize: 11, color: '#7a94b0', marginLeft: 3 }}>{unit}</span></div>
    </div>
  );
}

const ipStyles = {
  panel: {
    position: 'relative', height: '100vh', flexShrink: 0,
    background: 'linear-gradient(180deg, rgba(10,14,24,0.92), rgba(5,8,16,0.92))',
    borderLeft: '1px solid rgba(255,255,255,0.08)',
    color: '#d8e4f0', fontFamily: "'DM Sans', sans-serif",
    display: 'flex', flexDirection: 'column',
  },
  resizeHandle: {
    position: 'absolute', left: -3, top: 0, bottom: 0, width: 6, cursor: 'ew-resize', zIndex: 5,
  },
  header: {
    padding: '18px 20px 12px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  scroll: { padding: '14px 20px 22px', overflowY: 'auto', flex: 1 },
  eyebrow: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
    letterSpacing: '0.22em', color: '#7a94b0',
  },
  iconBtn: {
    width: 28, height: 28, borderRadius: 6, border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.04)', color: '#d8e4f0',
    fontSize: 14, cursor: 'pointer',
  },
  expandBtn: {
    position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)',
    background: 'rgba(15,22,36,0.92)', color: '#d8e4f0',
    border: '1px solid rgba(255,255,255,0.12)', borderRight: 'none',
    borderRadius: '8px 0 0 8px', padding: '14px 10px', cursor: 'pointer',
    fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: '0.15em',
    writingMode: 'vertical-rl', zIndex: 50,
  },
  hint: { fontSize: 12, color: '#6a7d96', fontStyle: 'italic', marginTop: 6 },
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
  lessonCard: {
    marginTop: 10, padding: 12,
    background: 'rgba(255,208,137,0.04)',
    border: '1px solid rgba(255,208,137,0.18)',
    borderRadius: 8,
  },
};

Object.assign(window, { LESSONS, InfoPanel, CrossSection });
