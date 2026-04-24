// =============================================================================
// sandbox.jsx — Weather Sandbox v2 (3D)
// =============================================================================
// Top-level React app. Owns:
//   • simulation state (sim object, params, layer toggles, tweaks)
//   • the Three.js scene (created once into a canvas)
//   • the animation loop (decoupled physics & render rates)
//   • the layout — left: controls sidebar, centre: 3D canvas + scale slider,
//     right: expanded info panel.
//
// The actual physics live in atmosphere.jsx; the WebGL scene lives in globe.jsx;
// the multi-section right-hand panel lives in info-panel.jsx. This file just
// plumbs them together and renders the controls.
// =============================================================================

const { useState, useEffect, useRef, useCallback } = React;

const DEFAULT_PARAMS = {
  solarIntensity: 1.0,
  axialTilt: 23,
  rotationSpeed: 1.0,
  moonMass: 1.0,
  moonDistance: 1.0,
  humidity: 1.0,
  timeScale: 20,
  scale: 1,
};
const DEFAULT_LAYERS = {
  temperature: true, wind: true, clouds: true, tides: true, pressure: false,
};

// =============================================================================
// WebGL fallback
// =============================================================================
function WebGLUnavailable({ error }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(ellipse at 20% 0%, #0e1830 0%, #050810 50%)',
      color: '#d8e4f0', fontFamily: "'DM Sans', sans-serif",
    }}>
      <div style={{ maxWidth: 480, padding: 32, textAlign: 'center' }}>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: '0.25em', color: '#7a94b0' }}>
          WEBGL UNAVAILABLE
        </div>
        <div style={{ fontSize: 24, fontWeight: 600, margin: '10px 0 14px' }}>
          The 3D sandbox needs WebGL.
        </div>
        <div style={{ fontSize: 14, color: '#a8b6cc', lineHeight: 1.55, marginBottom: 18 }}>
          Your browser couldn't initialise a WebGL context. Try enabling hardware
          acceleration, updating your browser, or open the 2D version below.
        </div>
        <a href="Weather Sandbox v1.html" style={{
          display: 'inline-block', padding: '12px 18px',
          background: 'linear-gradient(180deg, #ffd089, #f0a050)',
          color: '#2a1a08', textDecoration: 'none', borderRadius: 10,
          fontWeight: 600,
        }}>Open Weather Sandbox v1 (2D) →</a>
        {error && <div style={{ marginTop: 18, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#5a6f8c' }}>
          {String(error.message || error)}
        </div>}
      </div>
    </div>
  );
}

// =============================================================================
// App
// =============================================================================
function App() {
  const canvasRef = useRef(null);
  const stageRef  = useRef(null);
  const sceneRef  = useRef(null);
  const simRef    = useRef(null);
  const rafRef    = useRef(0);
  const [glError, setGlError] = useState(null);

  const [params, setParams]       = useState(DEFAULT_PARAMS);
  const [showLayers, setShowLayers] = useState(DEFAULT_LAYERS);
  const [running, setRunning]     = useState(true);
  const [lesson, setLesson]       = useState(-1);
  const [tweaks, setTweak]        = useTweaks(TWEAK_DEFAULTS);
  const [probe, setProbe]         = useState(null);
  const [hud, setHud]             = useState({ day: 1, timeOfDay: 12, simHours: 0 });
  const [stats, setStats]         = useState(null);
  const [bodies, setBodies]       = useState({ sunDir: null, moonDir: null });

  // Refs that the RAF loop reads (avoids re-creating the loop on every change)
  const paramsRef = useRef(params);     useEffect(() => { paramsRef.current = params; }, [params]);
  const layersRef = useRef(showLayers); useEffect(() => { layersRef.current = showLayers; }, [showLayers]);
  const runningRef = useRef(running);   useEffect(() => { runningRef.current = running; }, [running]);
  const tweaksRef = useRef(tweaks);     useEffect(() => { tweaksRef.current = tweaks; }, [tweaks]);
  const probeRef  = useRef(probe);      useEffect(() => { probeRef.current = probe; }, [probe]);

  // ── Initialise sim ─────────────────────────────────────────────────────
  useEffect(() => {
    const sim = makeSim();
    initLandMask(sim, tweaks.climate);
    initAtmosphere(sim);
    simRef.current = sim;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Re-seed when climate changes; also push climate-signature params ──
  const prevClimateRef = useRef(tweaks.climate);
  useEffect(() => {
    if (prevClimateRef.current === tweaks.climate) return;
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
    // Also drop probe (cell index won't refer to the same place)
    setProbe(null);
  }, [tweaks.climate]);

  // ── Build the Three.js scene once ──────────────────────────────────────
  useEffect(() => {
    let scene;
    try {
      scene = createGlobeScene(canvasRef.current);
    } catch (e) {
      setGlError(e);
      return;
    }
    sceneRef.current = scene;
    // Initial palette + layers
    scene.applyClimatePalette(CLIMATES[tweaks.climate] || CLIMATES.earth, VISUAL_STYLES[tweaks.visualStyle] || VISUAL_STYLES.scientific);
    scene.setLayers(showLayers);

    // Resize
    const onResize = () => {
      const el = stageRef.current; if (!el) return;
      const r = el.getBoundingClientRect();
      scene.setSize(Math.max(200, r.width), Math.max(200, r.height));
    };
    onResize();
    window.addEventListener('resize', onResize);

    // Click → probe
    const onClick = (e) => {
      const r = canvasRef.current.getBoundingClientRect();
      const ndcX = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ndcY = -((e.clientY - r.top) / r.height) * 2 + 1;
      const hit = scene.pickGlobe(ndcX, ndcY);
      if (!hit) { setProbe(null); return; }
      const sim = simRef.current; if (!sim) return;
      setProbe(probeCell(sim, hit.lat, hit.lon));
    };
    canvasRef.current.addEventListener('click', onClick);

    // Animation loop
    let last = performance.now();
    let hudT = 0;
    const loop = (now) => {
      rafRef.current = requestAnimationFrame(loop);
      const dtReal = Math.min(0.05, (now - last) / 1000);
      last = now;

      const sim = simRef.current;
      const p = paramsRef.current;
      const tw = tweaksRef.current;
      const layers = layersRef.current;
      if (!sim) return;

      // ── Physics ──
      if (runningRef.current) {
        const simHoursThisFrame = dtReal * p.timeScale;
        const nSub = Math.max(1, Math.min(8, Math.ceil(simHoursThisFrame / 0.4)));
        const dtH = simHoursThisFrame / nSub;
        const dayLen = 24 / p.rotationSpeed;
        for (let s = 0; s < nSub; s++) {
          const tod = ((sim.simTime % dayLen) / dayLen) * 24;
          stepSim(sim, {
            ...p,
            chaos: tw.chaos || 0,
            timeOfDay: tod,
            dayLengthHrs: dayLen,
          }, dtH);
        }
      }

      // ── Update GPU ──
      const vstyle = VISUAL_STYLES[tw.visualStyle] || VISUAL_STYLES.scientific;
      scene.uploadSimTextures(sim);
      scene.updateWindArrows(sim, layers.wind, vstyle);
      const placement = scene.placeBodies(sim, p, p.scale);
      scene.setLayers(layers);
      scene.applyClimatePalette(CLIMATES[tw.climate] || CLIMATES.earth, vstyle);

      // Refresh probe cell values continuously
      const probeNow = probeRef.current;
      if (probeNow) {
        const refreshed = probeCell(sim, probeNow.lat, probeNow.lon);
        scene.setProbe(refreshed);
      } else {
        scene.setProbe(null);
      }

      scene.render();

      // Throttled state pushes (HUD, stats, probe data, sun/moon dirs)
      hudT += dtReal;
      if (hudT > 0.25) {
        hudT = 0;
        const dayLen = 24 / p.rotationSpeed;
        const tod = ((sim.simTime % dayLen) / dayLen) * 24;
        setHud({
          day: Math.floor(sim.simTime / 24) + 1,
          timeOfDay: tod,
          simHours: sim.simTime,
        });
        setStats(computeStats(sim));
        setBodies({ sunDir: placement.sunDir, moonDir: placement.moonDir });
        if (probeNow) {
          setProbe(probeCell(sim, probeNow.lat, probeNow.lon));
        }
      }
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', onResize);
      if (canvasRef.current) canvasRef.current.removeEventListener('click', onClick);
      scene.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reset helpers ──────────────────────────────────────────────────────
  const resetSim = useCallback(() => {
    const sim = makeSim();
    initLandMask(sim, tweaksRef.current.climate);
    initAtmosphere(sim);
    simRef.current = sim;
    setProbe(null);
  }, []);
  const resetDefaults = useCallback(() => {
    setParams(DEFAULT_PARAMS);
    setShowLayers(DEFAULT_LAYERS);
    setTweak('climate', TWEAK_DEFAULTS.climate);
    setTweak('visualStyle', TWEAK_DEFAULTS.visualStyle);
    setTweak('chaos', TWEAK_DEFAULTS.chaos);
    const sim = makeSim();
    initLandMask(sim, TWEAK_DEFAULTS.climate);
    initAtmosphere(sim);
    simRef.current = sim;
    setProbe(null);
  }, []);

  // Apply lesson preset
  const applyLesson = useCallback((i) => {
    setLesson(i);
    if (i === -1) return;
    const L = LESSONS[i]; if (!L) return;
    const { layers, ...rest } = L.preset;
    setParams(p => ({ ...p, ...rest }));
    setShowLayers(layers);
    resetSim();
  }, [resetSim]);

  // Scale slider — jumps the camera distance to the requested framing
  const onScaleChange = (v) => {
    setParams(p => ({ ...p, scale: v }));
    if (sceneRef.current) sceneRef.current.jumpScale(v);
  };

  if (glError) return <WebGLUnavailable error={glError} />;

  const update = (k, v) => setParams(p => ({ ...p, [k]: v }));
  const toggle = (k) => setShowLayers(s => ({ ...s, [k]: !s[k] }));

  return (
    <div style={styles.root}>
      <Sidebar
        params={params} update={update}
        showLayers={showLayers} toggle={toggle}
        running={running} setRunning={setRunning}
        resetSim={resetSim} resetDefaults={resetDefaults}
        onScaleChange={onScaleChange}
      />

      <div style={styles.stageCol}>
        <div ref={stageRef} style={styles.stage}>
          <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%', cursor: 'crosshair' }} />
          {/* Floating HUD overlay */}
          <div style={styles.hudOverlay}>
            <div style={styles.hudEyebrow}>SIMULATION</div>
            <div><span style={styles.hudKey}>DAY</span> <b style={styles.hudVal}>{hud.day}</b> &nbsp; <span style={styles.hudKey}>TIME</span> <b style={styles.hudVal}>
              {`${String(Math.floor(hud.timeOfDay)).padStart(2,'0')}:${String(Math.floor((hud.timeOfDay%1)*60)).padStart(2,'0')}`}
            </b></div>
            <div><span style={styles.hudKey}>AVG T</span> <b style={{ ...styles.hudVal, color: '#ffd089' }}>{stats ? stats.avgT.toFixed(1) : '—'}°C</b></div>
            <div><span style={styles.hudKey}>SCALE</span> <b style={styles.hudVal}>{params.scale.toFixed(1)}×</b></div>
            <div style={{ marginTop: 4, fontSize: 10, color: '#556d88' }}>
              {params.timeScale}× · drag to rotate · scroll to zoom · click to probe
            </div>
          </div>
        </div>
      </div>

      <InfoPanel
        sim={simRef.current}
        probe={probe}
        stats={stats}
        sun={{ sunDir: bodies.sunDir }}
        moon={{ moonDir: bodies.moonDir }}
        params={params}
        lesson={lesson}
        onLesson={applyLesson}
        hud={hud}
      />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Climate preset" />
        <TweakSelect label="World" value={tweaks.climate}
          options={[
            { value: 'earth', label: 'Earth' },
            { value: 'desert', label: 'Desert' },
            { value: 'iceage', label: 'Ice Age' },
            { value: 'waterworld', label: 'Water World' },
            { value: 'venus', label: 'Venus-like' },
          ]}
          onChange={(v) => setTweak('climate', v)} />

        <TweakSection label="Visual style" />
        <TweakRadio label="Look" value={tweaks.visualStyle}
          options={[
            { value: 'scientific', label: 'Scientific' },
            { value: 'painterly',  label: 'Painterly' },
            { value: 'blueprint',  label: 'Blueprint' },
          ]}
          onChange={(v) => setTweak('visualStyle', v)} />

        <TweakSection label="Atmosphere feel" />
        <TweakSlider label="Chaos" value={tweaks.chaos}
          min={0} max={1} step={0.01}
          onChange={(v) => setTweak('chaos', v)} />
      </TweaksPanel>
    </div>
  );
}

// =============================================================================
// Sidebar (left)
// =============================================================================
function Sidebar({ params, update, showLayers, toggle, running, setRunning, resetSim, resetDefaults, onScaleChange }) {
  return (
    <div style={styles.sidebar}>
      <div style={{ padding: '22px 22px 10px' }}>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '0.25em', color: '#7a94b0' }}>3D INTERACTIVE</div>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em', color: '#fff', marginTop: 4 }}>Weather Sandbox</div>
        <div style={{ fontSize: 12, color: '#7a94b0', marginTop: 6, lineHeight: 1.5 }}>
          A live physics simulation of Earth's atmosphere, hydrosphere, and the Moon — on a real sphere.
        </div>
      </div>

      <div style={styles.divider} />

      <div style={{ padding: '14px 22px' }}>
        <SectionLabel>VIEW</SectionLabel>
        <Slider label="Scale" unit="×" value={params.scale} min={1} max={10} step={0.1}
          onChange={onScaleChange} hint="Close orbit ←→ system view" />
      </div>

      <div style={styles.divider} />

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
          <Toggle label="Wind"        active={showLayers.wind}        onClick={() => toggle('wind')}        color="#bcd" />
          <Toggle label="Clouds & Rain" active={showLayers.clouds}    onClick={() => toggle('clouds')}      color="#fff" />
          <Toggle label="Tides"       active={showLayers.tides}       onClick={() => toggle('tides')}       color="#9ff" />
          <Toggle label="Pressure (in panel)" active={showLayers.pressure} onClick={() => toggle('pressure')} color="#8cf" />
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
    flex: 1, display: 'flex', alignItems: 'stretch', justifyContent: 'stretch',
    minWidth: 0, overflow: 'hidden', position: 'relative',
  },
  stage: {
    position: 'relative', flex: 1, minWidth: 0,
  },
  sidebar: {
    width: 320, flexShrink: 0, height: '100vh', overflowY: 'auto',
    background: 'linear-gradient(180deg, rgba(10,14,24,0.9), rgba(5,8,16,0.9))',
    borderRight: '1px solid rgba(255,255,255,0.06)',
    color: '#d8e4f0', fontFamily: "'DM Sans', sans-serif",
  },
  divider: { height: 1, background: 'rgba(255,255,255,0.05)', margin: '0 22px' },
  bigBtn: {
    flex: 1, padding: '12px', background: 'linear-gradient(180deg, #ffd089, #f0a050)',
    border: 'none', borderRadius: 10, color: '#2a1a08',
    fontSize: 14, fontWeight: 600, cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
  },
  hudOverlay: {
    position: 'absolute', left: 18, top: 18,
    background: 'rgba(10,14,24,0.7)', backdropFilter: 'blur(8px)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 10, padding: '12px 14px',
    fontFamily: "'JetBrains Mono', monospace",
    color: '#d8e4f0', fontSize: 12, lineHeight: 1.7,
    pointerEvents: 'none',
  },
  hudEyebrow: { fontSize: 10, letterSpacing: '0.18em', color: '#7a94b0', marginBottom: 6 },
  hudKey: { color: '#7a94b0' },
  hudVal: { color: '#fff' },
};

// =============================================================================
// Mount
// =============================================================================
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
