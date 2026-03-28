import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WetSurfaceEngine } from './engine/WetSurfaceEngine'
import {
  DEFAULT_TUNING_CONFIG,
  STORAGE_KEYS,
  TUNING_SCHEMA,
  deepClone,
  formatValue,
  getByPath,
  getLinkedEffectiveConfig,
  mergeDeep,
  setByPath,
} from './tuning/tuningConfig'

const HUD_UPDATE_MS = 160
const HUD_COLLAPSED_STORAGE_KEY = 'mistyos.hud.collapsed.v1'

const RAW_BASELINE_PATHS = [
  'renderer',
  'fogSurface.baseFogLevel',
  'links.mistDensity',
  'links.fogSoftness',
]

const EMPTY_STATS = {
  fog: 0,
  droplets: 0,
  writing: false,
  renderer: {},
  effective: {},
  timing: {},
}

function useDebouncedStorage(key, value, delayMs) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      localStorage.setItem(key, JSON.stringify(value))
    }, delayMs)
    return () => window.clearTimeout(timer)
  }, [key, value, delayMs])
}

const PHASES = [
  { id: 1, label: 'Fog Build' },
  { id: 2, label: 'Fog + Droplets' },
  { id: 3, label: 'Unified Surface' },
]

function App() {
  const canvasRef = useRef(null)
  const engineRef = useRef(null)
  const importInputRef = useRef(null)
  const latestStatsRef = useRef(EMPTY_STATS)
  const appliedConfigSignatureRef = useRef('')
  const uiProfilerRef = useRef({
    avgMs: 0,
    rendersInWindow: 0,
  })
  const [phase, setPhase] = useState(3)
  const [hudStats, setHudStats] = useState(EMPTY_STATS)
  const [uiStats, setUiStats] = useState({ avgMs: 0, rendersPerSec: 0 })
  const [hudCollapsed, setHudCollapsed] = useState(() => {
    try {
      return localStorage.getItem(HUD_COLLAPSED_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [panelOpen, setPanelOpen] = useState(true)
  const [activeSection, setActiveSection] = useState('surfaceWetness')
  const [comparisonBaseline, setComparisonBaseline] = useState(null)
  const [comparisonNotice, setComparisonNotice] = useState('')

  const [tuningConfig, setTuningConfig] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.tuning)
      return saved ? mergeDeep(DEFAULT_TUNING_CONFIG, JSON.parse(saved)) : deepClone(DEFAULT_TUNING_CONFIG)
    } catch {
      return deepClone(DEFAULT_TUNING_CONFIG)
    }
  })

  const [savedPresets, setSavedPresets] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.presets)
      return saved ? JSON.parse(saved) : {}
    } catch {
      return {}
    }
  })

  const [abState, setAbState] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.ab)
      return saved
        ? JSON.parse(saved)
        : {
            active: 'A',
            A: { name: 'Slot A', config: deepClone(DEFAULT_TUNING_CONFIG) },
            B: { name: 'Slot B', config: deepClone(DEFAULT_TUNING_CONFIG) },
          }
    } catch {
      return {
        active: 'A',
        A: { name: 'Slot A', config: deepClone(DEFAULT_TUNING_CONFIG) },
        B: { name: 'Slot B', config: deepClone(DEFAULT_TUNING_CONFIG) },
      }
    }
  })

  const [favorites, setFavorites] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.favorites)
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })

  const [presetName, setPresetName] = useState('')
  const [sweepState, setSweepState] = useState({
    running: false,
    secondsPerStep: 2,
    paramA: 'dropletInteraction.largeRunnerBoostStrength',
    minA: 0.6,
    maxA: 1.6,
    stepsA: 4,
    useParamB: false,
    paramB: 'links.largeRunnerInfluence',
    minB: 0.8,
    maxB: 1.6,
    stepsB: 3,
    combinations: [],
    index: 0,
  })

  const backgroundSrc = useMemo(() => '/media/rain-room.jpg', [])
  const effectiveConfig = useMemo(() => getLinkedEffectiveConfig(tuningConfig), [tuningConfig])
  const activeAbName = abState?.[abState.active]?.name || 'Custom'

  const onEngineStats = useCallback((nextStats) => {
    latestStatsRef.current = nextStats
  }, [])

  const onProfilerRender = useCallback((id, phaseName, actualDuration) => {
    const bucket = uiProfilerRef.current
    bucket.avgMs = bucket.avgMs > 0 ? bucket.avgMs * 0.85 + actualDuration * 0.15 : actualDuration
    bucket.rendersInWindow += 1
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas) {
      return undefined
    }

    const engine = new WetSurfaceEngine(canvas, {
      backgroundSrc,
      phase,
      tuningConfig: effectiveConfig,
      onStats: onEngineStats,
    })

    engineRef.current = engine
    engine.start()

    return () => {
      engine.stop()
      engineRef.current = null
    }
  }, [backgroundSrc, onEngineStats])

  useEffect(() => {
    engineRef.current?.setPhase(phase)
  }, [phase])

  useEffect(() => {
    const signature = JSON.stringify(effectiveConfig)
    if (signature === appliedConfigSignatureRef.current) {
      return
    }
    appliedConfigSignatureRef.current = signature
    engineRef.current?.setTuningConfig(effectiveConfig)
  }, [effectiveConfig])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const nextStats = latestStatsRef.current || EMPTY_STATS
      setHudStats(nextStats)

      const bucket = uiProfilerRef.current
      setUiStats({
        avgMs: bucket.avgMs,
        rendersPerSec: Math.round((bucket.rendersInWindow * 1000) / HUD_UPDATE_MS),
      })
      bucket.rendersInWindow = 0
    }, HUD_UPDATE_MS)
    return () => window.clearInterval(timer)
  }, [])

  useDebouncedStorage(STORAGE_KEYS.tuning, tuningConfig, 600)
  useDebouncedStorage(STORAGE_KEYS.presets, savedPresets, 350)
  useDebouncedStorage(STORAGE_KEYS.ab, abState, 350)
  useDebouncedStorage(STORAGE_KEYS.favorites, favorites, 350)

  useEffect(() => {
    try {
      localStorage.setItem(HUD_COLLAPSED_STORAGE_KEY, hudCollapsed ? '1' : '0')
    } catch {
      // Ignore storage failures; HUD still works in-memory.
    }
  }, [hudCollapsed])

  useEffect(() => {
    if (!comparisonNotice) {
      return undefined
    }
    const timer = window.setTimeout(() => setComparisonNotice(''), 1800)
    return () => window.clearTimeout(timer)
  }, [comparisonNotice])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === '1' || event.key === '2' || event.key === '3') {
        setPhase(Number(event.key))
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const rendererStats = hudStats.renderer || {}
  const timingStats = hudStats.timing || {}

  const onNumberControlChange = useCallback((path, value, isInteger = false) => {
    const parsed = Number(value)
    const safeValue = Number.isFinite(parsed) ? (isInteger ? Math.round(parsed) : parsed) : 0
    setTuningConfig((prev) => setByPath(prev, path, safeValue))
  }, [])

  const onToggleControlChange = useCallback((path, checked) => {
    setTuningConfig((prev) => setByPath(prev, path, checked))
  }, [])

  const onSelectControlChange = useCallback((path, value) => {
    setTuningConfig((prev) => setByPath(prev, path, value))
  }, [])

  const resetSection = useCallback((sectionKey) => {
    setTuningConfig((prev) => ({
      ...prev,
      [sectionKey]: deepClone(DEFAULT_TUNING_CONFIG[sectionKey]),
    }))
  }, [])

  const resetAll = useCallback(() => {
    setTuningConfig(deepClone(DEFAULT_TUNING_CONFIG))
  }, [])

  const savePreset = useCallback(() => {
    const name = presetName.trim() || `Preset ${new Date().toLocaleTimeString()}`
    setSavedPresets((prev) => ({
      ...prev,
      [name]: deepClone(tuningConfig),
    }))
    setPresetName(name)
  }, [presetName, tuningConfig])

  const loadPreset = useCallback((name) => {
    const preset = savedPresets[name]
    if (!preset) {
      return
    }
    setPresetName(name)
    setTuningConfig(mergeDeep(DEFAULT_TUNING_CONFIG, preset))
  }, [savedPresets])

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(tuningConfig, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `mistyos-tuning-${Date.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [tuningConfig])

  const importJsonFromFile = useCallback(async (event) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      setTuningConfig(mergeDeep(DEFAULT_TUNING_CONFIG, parsed))
    } catch {
      // Ignore invalid import payloads and preserve current tuning state.
    }
    event.target.value = ''
  }, [])

  const copyCurrentJson = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(tuningConfig, null, 2))
    } catch {
      // Clipboard writes may be denied by browser permissions.
    }
  }, [tuningConfig])

  const captureScreenshot = useCallback(() => {
    const dataUrl = engineRef.current?.getCanvasSnapshotDataUrl?.() || canvasRef.current?.toDataURL('image/png')
    if (!dataUrl) {
      return
    }
    const anchor = document.createElement('a')
    anchor.href = dataUrl
    anchor.download = `mistyos-screenshot-${Date.now()}.png`
    anchor.click()
  }, [])

  const setCurrentToAbSlot = useCallback((slot) => {
    setAbState((prev) => ({
      ...prev,
      [slot]: {
        name: presetName.trim() || `Current ${slot}`,
        config: deepClone(tuningConfig),
      },
    }))
  }, [presetName, tuningConfig])

  const swapAb = useCallback(() => {
    const nextActive = abState.active === 'A' ? 'B' : 'A'
    const nextConfig = abState[nextActive]?.config
    setAbState((prev) => ({ ...prev, active: nextActive }))
    if (nextConfig) {
      setTuningConfig(mergeDeep(DEFAULT_TUNING_CONFIG, nextConfig))
    }
  }, [abState])

  const markFavorite = useCallback(() => {
    setFavorites((prev) => [
      {
        id: `${Date.now()}`,
        name: presetName.trim() || `Favorite ${prev.length + 1}`,
        config: deepClone(tuningConfig),
      },
      ...prev,
    ])
  }, [presetName, tuningConfig])

  const applyFavorite = useCallback((id) => {
    const favorite = favorites.find((item) => item.id === id)
    if (!favorite) {
      return
    }
    setPresetName(favorite.name)
    setTuningConfig(mergeDeep(DEFAULT_TUNING_CONFIG, favorite.config))
  }, [favorites])

  const removeFavorite = useCallback((id) => {
    setFavorites((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const buildSweepCombinations = useCallback(() => {
    const valuesA = []
    const stepsA = Math.max(2, Number(sweepState.stepsA) || 2)
    for (let i = 0; i < stepsA; i += 1) {
      const t = i / (stepsA - 1)
      valuesA.push(Number(sweepState.minA) + (Number(sweepState.maxA) - Number(sweepState.minA)) * t)
    }

    const list = []
    if (!sweepState.useParamB) {
      for (let i = 0; i < valuesA.length; i += 1) {
        list.push({ [sweepState.paramA]: valuesA[i] })
      }
      return list
    }

    const valuesB = []
    const stepsB = Math.max(2, Number(sweepState.stepsB) || 2)
    for (let i = 0; i < stepsB; i += 1) {
      const t = i / (stepsB - 1)
      valuesB.push(Number(sweepState.minB) + (Number(sweepState.maxB) - Number(sweepState.minB)) * t)
    }

    for (let a = 0; a < valuesA.length; a += 1) {
      for (let b = 0; b < valuesB.length; b += 1) {
        list.push({ [sweepState.paramA]: valuesA[a], [sweepState.paramB]: valuesB[b] })
      }
    }
    return list
  }, [sweepState])

  const startSweep = useCallback(() => {
    const combinations = buildSweepCombinations()
    if (!combinations.length) {
      return
    }
    const first = combinations[0]
    setTuningConfig((old) => {
      let next = old
      for (const [path, value] of Object.entries(first)) {
        next = setByPath(next, path, value)
      }
      return next
    })
    setSweepState((prev) => ({ ...prev, running: true, combinations, index: 0 }))
  }, [buildSweepCombinations])

  const stopSweep = useCallback(() => {
    setSweepState((prev) => ({ ...prev, running: false }))
  }, [])

  const pickRawBaselineSettings = useCallback((sourceConfig) => {
    let baseline = {}
    for (const path of RAW_BASELINE_PATHS) {
      const value = getByPath(sourceConfig, path)
      baseline = setByPath(baseline, path, deepClone(value))
    }
    return baseline
  }, [])

  const applyRawBaselineToComposite = useCallback((sourceBaseline, noticeText) => {
    setTuningConfig((prev) => {
      let next = prev
      for (const path of RAW_BASELINE_PATHS) {
        const value = getByPath(sourceBaseline, path)
        next = setByPath(next, path, deepClone(value))
      }
      return next
    })
    setComparisonNotice(noticeText)
  }, [])

  const copyRawToComposite = useCallback(() => {
    const baseline = pickRawBaselineSettings(tuningConfig)
    setComparisonBaseline(baseline)
    applyRawBaselineToComposite(baseline, 'Copied RAW baseline to composite controls.')
  }, [pickRawBaselineSettings, tuningConfig, applyRawBaselineToComposite])

  const resetCompositeToRawBaseline = useCallback(() => {
    if (!comparisonBaseline) {
      return
    }
    applyRawBaselineToComposite(comparisonBaseline, 'Composite reset to saved RAW baseline.')
  }, [comparisonBaseline, applyRawBaselineToComposite])

  useEffect(() => {
    if (!sweepState.running || !sweepState.combinations.length) {
      return undefined
    }

    const intervalMs = Math.max(300, Number(sweepState.secondsPerStep) * 1000)
    const timer = window.setInterval(() => {
      setSweepState((prev) => {
        const nextIndex = (prev.index + 1) % prev.combinations.length
        const combo = prev.combinations[nextIndex]

        setTuningConfig((old) => {
          let next = old
          for (const [path, value] of Object.entries(combo)) {
            next = setByPath(next, path, value)
          }
          return next
        })

        return {
          ...prev,
          index: nextIndex,
        }
      })
    }, intervalMs)

    return () => window.clearInterval(timer)
  }, [sweepState.running, sweepState.combinations, sweepState.secondsPerStep])

  const allSweepPaths = useMemo(() => {
    const paths = []
    for (const section of TUNING_SCHEMA) {
      for (const control of section.controls || []) {
        paths.push(control.path)
      }
    }
    return paths
  }, [])

  const splitCompareHeadersVisible =
    tuningConfig?.debug?.viewMode === 'split-compare' ||
    Boolean(tuningConfig?.debug?.splitCompareEnabled) ||
    Boolean(tuningConfig?.debug?.overlayBackendCompareEnabled)

  const panelElement = useMemo(
    () => (
      <aside className={`tuning-panel ${panelOpen ? 'open' : 'collapsed'}`}>
        <button className="panel-tab" type="button" onClick={() => setPanelOpen((prev) => !prev)}>
          {panelOpen ? 'Collapse Tuning' : 'Open Tuning'}
        </button>

        {panelOpen ? (
          <div className="panel-body">
            <div className="section-tabs">
              {TUNING_SCHEMA.map((section) => (
                <button
                  key={section.key}
                  className={activeSection === section.key ? 'active' : ''}
                  type="button"
                  onClick={() => setActiveSection(section.key)}
                >
                  {section.title}
                </button>
              ))}
            </div>

            {TUNING_SCHEMA.filter((section) => section.key === activeSection).map((section) => (
              <section key={section.key} className="panel-section">
                <div className="section-header">
                  <h3>{section.title}</h3>
                  {DEFAULT_TUNING_CONFIG[section.key] ? (
                    <button type="button" onClick={() => resetSection(section.key)}>
                      Reset Section
                    </button>
                  ) : null}
                </div>

                {(section.controls || []).map((control) => {
                  const value = getByPath(tuningConfig, control.path)
                  const isInteger = Number(control.step) >= 1
                  return (
                    <div className="control-row" key={control.path} title={control.tooltip}>
                      <label>{control.label}</label>
                      <span className="value">{formatValue(value)}</span>
                      <input
                        type="range"
                        min={control.min}
                        max={control.max}
                        step={control.step}
                        value={value}
                        title={control.tooltip}
                        onChange={(event) => onNumberControlChange(control.path, event.target.value, isInteger)}
                      />
                    </div>
                  )
                })}

                {(section.toggles || []).map((toggle) => {
                  const value = Boolean(getByPath(tuningConfig, toggle.path))
                  return (
                    <label className="toggle-row" key={toggle.path} title={toggle.tooltip}>
                      <span>{toggle.label}</span>
                      <input
                        type="checkbox"
                        checked={value}
                        onChange={(event) => onToggleControlChange(toggle.path, event.target.checked)}
                      />
                    </label>
                  )
                })}

                {(section.selects || []).map((select) => {
                  const value = getByPath(tuningConfig, select.path)
                  return (
                    <label className="select-row" key={select.path} title={select.tooltip}>
                      <span>{select.label}</span>
                      <select value={value} onChange={(event) => onSelectControlChange(select.path, event.target.value)}>
                        {select.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                  )
                })}
              </section>
            ))}

            <section className="panel-section">
              <div className="section-header">
                <h3>Presets</h3>
                <button type="button" onClick={resetAll}>Reset All</button>
              </div>
              <div className="preset-row">
                <input
                  value={presetName}
                  placeholder="Preset name"
                  onChange={(event) => setPresetName(event.target.value)}
                />
                <button type="button" onClick={savePreset}>Save Preset</button>
              </div>
              <div className="preset-list">
                {Object.keys(savedPresets).map((name) => (
                  <button key={name} type="button" onClick={() => loadPreset(name)}>
                    Load: {name}
                  </button>
                ))}
              </div>
              <div className="button-grid">
                <button type="button" onClick={exportJson}>Export JSON</button>
                <button type="button" onClick={() => importInputRef.current?.click()}>Import JSON</button>
                <button type="button" onClick={copyCurrentJson}>Copy Settings JSON</button>
                <button type="button" onClick={captureScreenshot}>Screenshot Current State</button>
              </div>
              <input ref={importInputRef} type="file" accept="application/json" hidden onChange={importJsonFromFile} />
            </section>

            <section className="panel-section">
              <div className="section-header">
                <h3>Debug / Comparison</h3>
              </div>
              <p className="mini-line">Active A/B: {activeAbName}</p>
              <p className="mini-line">Native simulator path: yes</p>
              <p className="mini-line">Linked runner influence: {formatValue(effectiveConfig.links.largeRunnerInfluence || 0)}</p>
              <p className="mini-line">Linked fog softness: {formatValue(effectiveConfig.links.fogSoftness || 0)}</p>
              <p className="mini-line">Linked mist density: {formatValue(effectiveConfig.links.mistDensity || 0)}</p>
              <div className="button-grid">
                <button type="button" onClick={() => setCurrentToAbSlot('A')}>Store A</button>
                <button type="button" onClick={() => setCurrentToAbSlot('B')}>Store B</button>
                <button type="button" onClick={swapAb}>A/B Swap</button>
                <button type="button" onClick={markFavorite}>Mark Favorite</button>
              </div>
              {splitCompareHeadersVisible ? (
                <>
                  <div className="button-grid compare-actions">
                    <button type="button" onClick={copyRawToComposite}>Copy RAW -&gt; Composite</button>
                    <button type="button" onClick={resetCompositeToRawBaseline} disabled={!comparisonBaseline}>
                      Reset Composite to RAW Baseline
                    </button>
                  </div>
                  <p className="mini-line">Copy scope: Native Renderer + baseline mist/fog links.</p>
                  {comparisonNotice ? <p className="mini-line compare-notice">{comparisonNotice}</p> : null}
                </>
              ) : null}
            </section>

            <section className="panel-section">
              <div className="section-header">
                <h3>Parameter Sweep</h3>
              </div>
              <label className="select-row">
                <span>Parameter A</span>
                <select value={sweepState.paramA} onChange={(event) => setSweepState((prev) => ({ ...prev, paramA: event.target.value }))}>
                  {allSweepPaths.map((path) => (
                    <option key={path} value={path}>{path}</option>
                  ))}
                </select>
              </label>
              <div className="sweep-grid">
                <label>
                  <span>A Min</span>
                  <input type="number" value={sweepState.minA} step="0.01" onChange={(event) => setSweepState((prev) => ({ ...prev, minA: Number(event.target.value) }))} />
                </label>
                <label>
                  <span>A Max</span>
                  <input type="number" value={sweepState.maxA} step="0.01" onChange={(event) => setSweepState((prev) => ({ ...prev, maxA: Number(event.target.value) }))} />
                </label>
                <label>
                  <span>A Steps</span>
                  <input type="number" value={sweepState.stepsA} step="1" min="2" onChange={(event) => setSweepState((prev) => ({ ...prev, stepsA: Number(event.target.value) }))} />
                </label>
              </div>
              <label className="toggle-row">
                <span>Use Parameter B</span>
                <input type="checkbox" checked={sweepState.useParamB} onChange={(event) => setSweepState((prev) => ({ ...prev, useParamB: event.target.checked }))} />
              </label>
              {sweepState.useParamB ? (
                <>
                  <label className="select-row">
                    <span>Parameter B</span>
                    <select value={sweepState.paramB} onChange={(event) => setSweepState((prev) => ({ ...prev, paramB: event.target.value }))}>
                      {allSweepPaths.map((path) => (
                        <option key={path} value={path}>{path}</option>
                      ))}
                    </select>
                  </label>
                  <div className="sweep-grid">
                    <label>
                      <span>B Min</span>
                      <input type="number" value={sweepState.minB} step="0.01" onChange={(event) => setSweepState((prev) => ({ ...prev, minB: Number(event.target.value) }))} />
                    </label>
                    <label>
                      <span>B Max</span>
                      <input type="number" value={sweepState.maxB} step="0.01" onChange={(event) => setSweepState((prev) => ({ ...prev, maxB: Number(event.target.value) }))} />
                    </label>
                    <label>
                      <span>B Steps</span>
                      <input type="number" value={sweepState.stepsB} step="1" min="2" onChange={(event) => setSweepState((prev) => ({ ...prev, stepsB: Number(event.target.value) }))} />
                    </label>
                  </div>
                </>
              ) : null}
              <label className="select-row">
                <span>Seconds / Step</span>
                <input
                  type="number"
                  min="0.3"
                  step="0.1"
                  value={sweepState.secondsPerStep}
                  onChange={(event) => setSweepState((prev) => ({ ...prev, secondsPerStep: Number(event.target.value) }))}
                />
              </label>
              <div className="button-grid">
                <button type="button" onClick={startSweep}>Start Sweep</button>
                <button type="button" onClick={stopSweep}>Stop Sweep</button>
              </div>
              <p className="mini-line">Combinations: {sweepState.combinations.length}</p>
              <p className="mini-line">Sweep running: {sweepState.running ? 'yes' : 'no'}</p>
            </section>

            <section className="panel-section favorites-tray">
              <div className="section-header">
                <h3>Favorites Tray</h3>
              </div>
              <div className="favorite-list">
                {favorites.map((favorite) => (
                  <div className="favorite-item" key={favorite.id}>
                    <button type="button" onClick={() => applyFavorite(favorite.id)}>{favorite.name}</button>
                    <button type="button" onClick={() => removeFavorite(favorite.id)}>x</button>
                  </div>
                ))}
              </div>
            </section>
          </div>
        ) : null}
      </aside>
    ),
    [
      panelOpen,
      activeSection,
      tuningConfig,
      presetName,
      savedPresets,
      sweepState,
      favorites,
      activeAbName,
      effectiveConfig,
      allSweepPaths,
      onNumberControlChange,
      onToggleControlChange,
      onSelectControlChange,
      resetSection,
      resetAll,
      savePreset,
      loadPreset,
      exportJson,
      copyCurrentJson,
      captureScreenshot,
      importJsonFromFile,
      setCurrentToAbSlot,
      swapAb,
      markFavorite,
      applyFavorite,
      removeFavorite,
      startSweep,
      stopSweep,
      splitCompareHeadersVisible,
      copyRawToComposite,
      resetCompositeToRawBaseline,
      comparisonBaseline,
      comparisonNotice,
    ],
  )

  return (
    <Profiler id="app-ui" onRender={onProfilerRender}>
      <div className="app-shell">
        <canvas ref={canvasRef} className="wet-canvas" aria-label="MistyOS wet surface simulation" />
        <div
          className={`hud ${hudCollapsed ? 'collapsed' : 'expanded'} ${splitCompareHeadersVisible ? 'split-compare-visible' : ''}`}
        >
          <div className="hud-header-row">
            <p className="title">MistyOS Wet Surface POC</p>
            <button className="hud-toggle" type="button" onClick={() => setHudCollapsed((prev) => !prev)}>
              {hudCollapsed ? 'Expand HUD' : 'Minimize HUD'}
            </button>
          </div>

          {hudCollapsed ? (
            <p className="line">Frame {(timingStats.avgFrameMs || 0).toFixed(2)}ms | Fog {Math.round(hudStats.fog * 100)}%</p>
          ) : (
            <>
              <p className="line">Phase: {PHASES.find((item) => item.id === phase)?.label}</p>
              <p className="line">Fog: {Math.round(hudStats.fog * 100)}%</p>
              <p className="line">Droplets: {hudStats.droplets}</p>
              <p className="line">Writing: {hudStats.writing ? 'active' : 'idle'}</p>
              <p className="line">Avg frame ms: {(timingStats.avgFrameMs || 0).toFixed(2)}</p>
              <p className="line">Engine ms: {(timingStats.engineMs || 0).toFixed(2)}</p>
              <p className="line">Renderer ms: {(timingStats.rendererMs || 0).toFixed(2)}</p>
              <p className="line">Wetness ms: {(timingStats.wetnessMs || 0).toFixed(2)}</p>
              <p className="line">Renderer sampling source: {timingStats.rendererSamplingSource || 'fog-canvas-alpha-compat'}</p>
              <p className="line">Renderer wetness mean: {(timingStats.rendererWetnessSampleMean || 0).toFixed(5)}</p>
              <p className="line">Renderer wetness var: {(timingStats.rendererWetnessSampleVariance || 0).toFixed(6)}</p>
              <p className="line">Renderer trail mean: {(timingStats.rendererTrailSampleMean || 0).toFixed(5)}</p>
              <p className="line">Renderer runner mean: {(timingStats.rendererRunnerSampleMean || 0).toFixed(5)}</p>
              <p className="line">Debug wetness peak: {(timingStats.debugWetnessPeak || 0).toFixed(5)}</p>
              <p className="line">Debug trail peak: {(timingStats.debugTrailPeak || 0).toFixed(5)}</p>
              <p className="line">Debug runner peak: {(timingStats.debugRunnerPeak || 0).toFixed(5)}</p>
              <p className="line">Renderer channel coverage: {(((timingStats.rendererChannelCoverage || 0) * 100)).toFixed(2)}%</p>
              <p className="line">Renderer carve coverage: {(((timingStats.rendererCarveCoverage || 0) * 100)).toFixed(2)}%</p>
              <p className="line">Wetness backend: {timingStats.wetnessBackend || 'cpu-grid'}</p>
              <p className="line">Interaction backend: {timingStats.interactionBackend || 'cpu-direct'}</p>
              <p className="line">Compatibility mode: {timingStats.compatibilityMode || 'cpu-compat'}</p>
              <p className="line">GPU write queue depth: {Math.round(timingStats.gpuInteractionWritesQueued || 0)}</p>
              <p className="line">GPU writes consumed: {(timingStats.gpuInteractionWritesConsumed || 0).toFixed(2)}</p>
              <p className="line">GPU writes dropped: {Math.round(timingStats.gpuInteractionWritesDropped || 0)}</p>
              <p className="line">GPU writes coalesced: {Math.round(timingStats.gpuInteractionWritesCoalesced || 0)}</p>
              <p className="line">GPU write pressure: {timingStats.gpuInteractionPressure || 'low'}</p>
              <p className="line">GPU write budget: {Math.round(timingStats.gpuInteractionWriteBudget || 128)}</p>
              <p className="line">GPU sim kernel: {timingStats.gpuSimKernel || 'off'}</p>
              <p className="line">GPU sim readback ms: {(timingStats.gpuSimReadbackMs || 0).toFixed(3)}</p>
              <p className="line">CPU fog alpha mean: {(timingStats.cpuFogAlphaMean || 0).toFixed(5)}</p>
              <p className="line">GPU fog alpha mean: {(timingStats.gpuFogAlphaMean || 0).toFixed(5)}</p>
              <p className="line">GPU-CPU alpha delta: {(timingStats.gpuCpuAlphaDelta || 0).toFixed(5)}</p>
              <p className="line">GPU-CPU alpha MAE: {(timingStats.gpuCpuAlphaMae || 0).toFixed(5)}</p>
              <p className="line">CPU fog alpha var: {(timingStats.cpuFogAlphaVariance || 0).toFixed(6)}</p>
              <p className="line">GPU fog alpha var: {(timingStats.gpuFogAlphaVariance || 0).toFixed(6)}</p>
              <p className="line">GPU-CPU var delta: {(timingStats.gpuCpuVarianceDelta || 0).toFixed(6)}</p>
              <p className="line">GPU-CPU tile max MAE: {(timingStats.gpuCpuTileMaxMae || 0).toFixed(6)}</p>
              <p className="line">GPU-CPU hotspot tile: {timingStats.gpuCpuTileHotspot || 'n/a'}</p>
              <p className="line">GPU parity gate: {timingStats.gpuParityGateStatus || 'n/a'}</p>
              <p className="line">GPU parity failures: {timingStats.gpuParityGateFailures || 'n/a'}</p>
              <p className="line">GPU overlay UV mode: {timingStats.gpuOverlayUvMode || 'n/a'}</p>
              <p className="line">GPU overlay fog alpha mean: {(timingStats.gpuOverlayFogAlphaMean || 0).toFixed(5)}</p>
              <p className="line">GPU overlay fog alpha max: {(timingStats.gpuOverlayFogAlphaMax || 0).toFixed(5)}</p>
              <p className="line">GPU present target: {timingStats.gpuOverlayPresentTarget || 'n/a'}</p>
              <p className="line">GPU present framebuffer: {timingStats.gpuOverlayPresentFramebuffer || 'n/a'}</p>
              <p className="line">GPU present samples: {timingStats.gpuOverlayPresentSamples || 'n/a'}</p>
              <p className="line">GPU present scene source: {timingStats.gpuOverlayPresentSceneSource || 'n/a'}</p>
              <p className="line">GPU present clear RGBA: {timingStats.gpuOverlayPresentClearRgba || 'n/a'}</p>
              <p className="line">GPU present blend enabled: {timingStats.gpuOverlayPresentBlendEnabled || 'n/a'}</p>
              <p className="line">GPU present blend mode: {timingStats.gpuOverlayPresentBlendMode || 'n/a'}</p>
              <p className="line">GPU present alpha convention: {timingStats.gpuOverlayPresentAlphaConvention || 'n/a'}</p>
              <p className="line">GPU present ctx alpha: {timingStats.gpuOverlayPresentContextAlpha || 'n/a'}</p>
              <p className="line">GPU present ctx premultiplied: {timingStats.gpuOverlayPresentContextPremultiplied || 'n/a'}</p>
              <p className="line">Overlay ms: {(timingStats.overlayMs || 0).toFixed(2)}</p>
              <p className="line">Overlay backend: {timingStats.overlayBackend || 'cpu-2d'}</p>
              <p className="line">Droplet proc ms: {(timingStats.dropletProcessingMs || 0).toFixed(2)}</p>
              <p className="line">Trail/capsule clear ms: {(timingStats.clearingMs || 0).toFixed(2)}</p>
              <p className="line">Diffusion ms: {(timingStats.diffusionMs || 0).toFixed(2)}</p>
              <p className="line">Field-to-image ms: {(timingStats.imageConvertMs || 0).toFixed(2)}</p>
              <p className="line">Scene age: {(timingStats.sceneAgeSec || 0).toFixed(1)}s</p>
              <p className="line">Wetness trend: {(timingStats.wetnessTrendMsPerMin || 0).toFixed(2)} ms/min</p>
              <p className="line">Wetness res: {timingStats.wetnessResolutionLabel || 'n/a'} ({timingStats.wetnessResolutionPixels || 0}px)</p>
              <p className="line">Active region px: {timingStats.activeRegionPixels || 0}</p>
              <p className="line">Active coverage: {timingStats.totalWetnessPixels ? (((timingStats.activeRegionPixels || 0) / timingStats.totalWetnessPixels) * 100).toFixed(1) : '0.0'}%</p>
              <p className="line">Recovery pixels/frame: {timingStats.recoveryPixels || 0} {timingStats.recoveryFullField ? '(full)' : '(dirty)'}</p>
              <p className="line">Diffusion pixels/frame: {timingStats.diffusionPixels || 0} {timingStats.diffusionFullField ? '(full)' : '(dirty)'}</p>
              <p className="line">Image pixels/frame: {timingStats.imagePixels || 0} {timingStats.imageFullField ? '(full)' : '(dirty)'}</p>
              <p className="line">Smoothing stride: every {timingStats.smoothingStride || 1}f {timingStats.smoothingSkippedByStride ? '(skipped this frame)' : ''}</p>
              <p className="line">Trail ops/frame: {timingStats.trailOps || 0}</p>
              <p className="line">Clear blob ops/frame: {timingStats.clearAreaOps || 0}</p>
              <p className="line">UI ms: {(uiStats.avgMs || 0).toFixed(2)}</p>
              <p className="line">UI renders/s: {uiStats.rendersPerSec}</p>
              <p className="line">Settings set calls: {timingStats.setTuningConfigCalls || 0}</p>
              <p className="line">Settings apply calls: {timingStats.applyLiveSettingsCalls || 0}</p>
              <p className="line">Renderer ready: {rendererStats.ready ? 'yes' : 'no'}</p>
              <p className="line">Renderer render: {rendererStats.renderSucceeded ? 'ok' : 'no'}</p>
              {rendererStats.debugEnabled ? (
                <>
                  <p className="line">Script loaded: {rendererStats.scriptLoaded ? 'yes' : 'no'}</p>
                  <p className="line">Init started: {rendererStats.initStarted ? 'yes' : 'no'}</p>
                  <p className="line">Init completed: {rendererStats.initCompleted ? 'yes' : 'no'}</p>
                  <p className="line">RaindropFX calls: {rendererStats.renderCalls || 0}</p>
                  <p className="line">RaindropFX input: {rendererStats.lastInputCount || 0}</p>
                  <p className="line">Native sim droplets: {rendererStats.simulatorRaindropCount || 0}</p>
                  <p className="line">Sim entity field: {rendererStats.simulatorEntityField || 'n/a'}</p>
                  <p className="line">Sim update return: {rendererStats.simulatorUpdateReturnType || 'n/a'}</p>
                  <p className="line">Sim update count: {rendererStats.simulatorUpdateReturnedCount || 0}</p>
                  <p className="line">Renderer source: {rendererStats.rendererInputSource || 'n/a'}</p>
                  <p className="line">Spawn interval: {JSON.stringify(rendererStats.simulatorSpawnInterval ?? 'n/a')}</p>
                  <p className="line">Spawn limit: {rendererStats.simulatorSpawnLimit ?? 'n/a'}</p>
                  <p className="line">Baseline groups applied: {rendererStats.baselineSeedGroupsApplied ? JSON.stringify(rendererStats.baselineSeedGroupsApplied) : 'n/a'}</p>
                  <p className="line">Baseline sim options: {rendererStats.baselineSeedSimulatorOptionSnapshot ? JSON.stringify(rendererStats.baselineSeedSimulatorOptionSnapshot) : 'n/a'}</p>
                  <p className="line">Baseline unsupported: {rendererStats.baselineSeedUnsupportedControls ? JSON.stringify(rendererStats.baselineSeedUnsupportedControls) : 'n/a'}</p>
                  <p className="line">Procedural droplets/s: {rendererStats.proceduralDropletsPerSecond ?? 'n/a'}</p>
                  <p className="line">Procedural mist: {rendererStats.proceduralMistEnabled === null || rendererStats.proceduralMistEnabled === undefined ? 'n/a' : rendererStats.proceduralMistEnabled ? 'on' : 'off'}</p>
                  <p className="line">Frame dt: {(rendererStats.frameDt || 0).toFixed(3)}s</p>
                  <p className="line">Frame delta: {Math.round(rendererStats.frameDeltaEnergy || 0)}</p>
                  {rendererStats.lastError ? <p className="line">Renderer error: {rendererStats.lastError}</p> : null}
                </>
              ) : null}
              <p className="hint">Drag to write. Press 1/2/3 to view each milestone.</p>
              <p className="hint">Debug: append ?rdfxDebug=1 (&rdfxOnly=1, &rdfxNativeOnly=1) to URL.</p>
            </>
          )}
        </div>
        {panelElement}
      </div>
    </Profiler>
  )
}

export default App
