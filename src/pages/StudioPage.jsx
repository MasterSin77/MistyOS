import { Component, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  STARTUP_MODES,
  getPresetById,
  getTimelineById,
  getStudioDefaultSettings,
  getStudioSettings,
  saveStudioSettings,
  presetCatalog,
  sceneCatalog,
  timelineCatalog,
} from '../config'
import { WetSurfaceEngine } from '../engine/WetSurfaceEngine'
import { createFourQuadrantRegionModel } from '../scheduler/region-model'
import { createSchedulerRuntime } from '../scheduler/runtime'
import { TimelineEditor } from '../scheduler/TimelineEditor'
import { INTENT_KINDS, REGION_IDS } from '../scheduler/model'
import { compileClipsToTimeline, createDefaultClip, normalizeClip, parseTimelineToClips } from '../scheduler/clips'
import { STAGE_PIXEL_HEIGHT, STAGE_PIXEL_WIDTH } from '../reference/background-presets'
import {
  DEFAULT_TUNING_CONFIG,
  TUNING_SCHEMA,
  getLinkedEffectiveConfig,
  mergeDeep,
} from '../tuning/tuningConfig'
import {
  buildWorkingRuntimePayload,
  cloneActiveProjectAs,
  createProject,
  exportActiveProjectDocument,
  getPublishedRuntimeDocument,
  getProjectRegistry,
  getRuntimeSurfacePriorityState,
  getSavedAuthoringDocument,
  handoffRuntimeSurfaceToPresentation,
  importProjectDocument,
  publishRuntimeSurfacePriorityHeartbeat,
  publishSavedAuthoringDocument,
  releaseRuntimeSurfacePriorityHeartbeat,
  resolveRuntimeSurfacePriorityState,
  runtimePayloadFingerprint,
  saveSavedAuthoringDocument,
  subscribeProjectRegistry,
  subscribePublishedRuntimeDocument,
  subscribeRuntimeSurfacePriorityState,
  subscribeSavedAuthoringDocument,
  switchActiveProject,
} from '../runtime/authoringRuntimeBridge'
import {
  buildRuntimeWeatherDrivenConfig,
  resolveRuntimeExecutionFromPayload,
  shortRuntimePayloadHash,
} from '../runtime/runtimeExecution'
import { StudioIcon } from '../components/StudioIcon'
import { getRuntimeSamples, resetRuntimeSamples, setVerificationActive } from '../verification/runtimeSampleStore'
import { runVerificationEngine } from '../verification/verificationEngine'
import {
  getDefaultVerificationScenarioId,
  getVerificationScenarioRegistry,
  resolveVerificationScenario,
} from '../verification/verificationScenarioRegistry'
import {
  getLatestVerificationArtifact,
  getVerificationArtifactIndex,
  persistVerificationArtifact,
  subscribeVerificationArtifacts,
} from '../verification/verificationArtifactStore'
import { buildVerificationArtifactReport, buildFullSuiteArtifactReport } from '../verification/artifactBuilder'

function isDevRuntime() {
  try {
    return Boolean(import.meta?.env?.DEV)
  } catch {
    return false
  }
}

function waitMs(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function evaluateLineageAssertions(expectations) {
  const checks = [
    {
      id: 'lineage-has-publish-revision',
      type: 'lineage_check',
      pass: Boolean(expectations?.hasPublishRevision),
      expected: true,
      actual: Boolean(expectations?.hasPublishRevision),
      reason: expectations?.hasPublishRevision ? null : 'Published revision was missing for the current run.',
    },
    {
      id: 'lineage-has-restart-token',
      type: 'lineage_check',
      pass: Boolean(expectations?.hasRestartToken),
      expected: true,
      actual: Boolean(expectations?.hasRestartToken),
      reason: expectations?.hasRestartToken ? null : 'Restart token was missing for the current published run.',
    },
    {
      id: 'lineage-scene-id-aligned',
      type: 'lineage_check',
      pass: !expectations?.activeSceneId || expectations?.selectedSceneId === expectations?.activeSceneId,
      expected: expectations?.activeSceneId || null,
      actual: expectations?.selectedSceneId || null,
      reason: !expectations?.activeSceneId || expectations?.selectedSceneId === expectations?.activeSceneId
        ? null
        : 'Published scene id does not match the active Studio scene.',
    },
    {
      id: 'lineage-timeline-id-aligned',
      type: 'lineage_check',
      pass: !expectations?.activeTimelineId || expectations?.selectedTimelineId === expectations?.activeTimelineId,
      expected: expectations?.activeTimelineId || null,
      actual: expectations?.selectedTimelineId || null,
      reason: !expectations?.activeTimelineId || expectations?.selectedTimelineId === expectations?.activeTimelineId
        ? null
        : 'Published timeline id does not match the active Studio timeline.',
    },
  ]

  return {
    pass: checks.every((check) => check.pass),
    assertionResults: checks,
  }
}

const MIN_LEFT_WIDTH = 180
const MIN_RIGHT_WIDTH = 260
const MIN_CENTER_WIDTH = 460
const MIN_TIMELINE_HEIGHT = 160
const MIN_SCENE_HEIGHT = 240
const COLLAPSED_TIMELINE_HEIGHT = 44
const COLLAPSED_SIDE_PANEL_WIDTH = 126
const PLAYBACK_TICK_MS = 1000 / 30
const SHUTTLE_RATE = 3
const RUNTIME_SURFACE_HEARTBEAT_INTERVAL_MS = 1500
const RUNTIME_SURFACE_HEARTBEAT_TTL_MS = 5000
const PRESENTATION_WINDOW_NAME = 'mistyos-presentation-window'
const PLAYBACK_EPSILON = 0.0001
const BASE_UI_FONT_PX = 16
const UI_FONT_STEPS = [16, 18, 20, 22, 24]
const UI_SCALE_MIN = UI_FONT_STEPS[0] / BASE_UI_FONT_PX
const UI_SCALE_MAX = UI_FONT_STEPS[UI_FONT_STEPS.length - 1] / BASE_UI_FONT_PX
const PRIMARY_WEATHER_CLIP_TYPES = ['wind', 'rain', 'mist']
const PREVIEW_MODES = ['contain', 'fill', 'native', 'zoom']
const STUDIO_MENU_ORDER = ['file', 'edit', 'view', 'layout', 'tools', 'help']
const STUDIO_MENU_MNEMONICS = {
  file: 'f',
  edit: 'e',
  view: 'v',
  layout: 'l',
  tools: 't',
  help: 'h',
}
const WORKFLOW_COMMAND_IDS = {
  save: 'file.workflow.save',
  saveAs: 'file.workflow.saveAs',
  revertToSaved: 'file.workflow.revertToSaved',
  updateDesktop: 'file.workflow.updateDesktop',
  importProject: 'file.workflow.importProject',
  exportAuthoringState: 'file.workflow.exportAuthoringState',
  exportRuntimePayload: 'file.workflow.exportRuntimePayload',
}
const VERIFICATION_COMMAND_IDS = {
  run: 'tools.verification.run',
  exportLatestReport: 'tools.verification.exportLatestReport',
  runAndExport: 'tools.verification.runAndExport',
  runFullSuite: 'tools.verification.runFullSuite',
}
const MENU_SUBMENU_DEFAULTS = {
  file: 'runtime',
  edit: 'timeline',
  view: 'scene-preview',
  layout: 'presets',
  tools: 'diagnostics',
  help: 'quick-start',
}
const MENU_SUBMENU_MAX_ROWS = {
  file: Math.max(3, Object.values(STARTUP_MODES).length),
  edit: 1,
  view: 8,
  layout: 3,
  tools: 4,
  help: 1,
}
const PREVIEW_SCENE_WIDTH = STAGE_PIXEL_WIDTH
const PREVIEW_SCENE_HEIGHT = STAGE_PIXEL_HEIGHT
const PREVIEW_MATTE_INSET_PX = 16
const TIMELINE_PANEL_HEADER_HEIGHT = 33
const TIMELINE_EDITOR_TOOLBAR_HEIGHT = 32
const TIMELINE_RULER_HEIGHT = 18
const TIMELINE_GROUP_HEADER_HEIGHT = 18
const TIMELINE_STATE_TRACK_HEIGHT = 36
const TIMELINE_EVENT_TRACK_HEIGHT = 28
const TIMELINE_GROUP_COUNT = 4
const TIMELINE_STATE_TRACK_COUNT = 6
const TIMELINE_EVENT_TRACK_COUNT = 1
const TIMELINE_PANEL_VERTICAL_ALLOWANCE = 10
// Content-aware max height: compute from actual row heights to prevent over-expansion
const TIMELINE_CONTENT_AWARE_MAX_HEIGHT = TIMELINE_PANEL_HEADER_HEIGHT
  + TIMELINE_EDITOR_TOOLBAR_HEIGHT
  + TIMELINE_RULER_HEIGHT
  + (TIMELINE_GROUP_COUNT * TIMELINE_GROUP_HEADER_HEIGHT)
  + (TIMELINE_STATE_TRACK_COUNT * TIMELINE_STATE_TRACK_HEIGHT)
  + (TIMELINE_EVENT_TRACK_COUNT * TIMELINE_EVENT_TRACK_HEIGHT)
  + TIMELINE_PANEL_VERTICAL_ALLOWANCE

function matchesAccelerator(accelerator, event) {
  if (!accelerator) {
    return false
  }

  const tokens = String(accelerator).toLowerCase().split('+').map((token) => token.trim()).filter(Boolean)
  if (!tokens.length) {
    return false
  }

  const requiresCtrl = tokens.includes('ctrl')
  const requiresShift = tokens.includes('shift')
  const requiresAlt = tokens.includes('alt')
  const keyToken = tokens[tokens.length - 1]

  if (Boolean(event.ctrlKey || event.metaKey) !== requiresCtrl) {
    return false
  }
  if (Boolean(event.shiftKey) !== requiresShift) {
    return false
  }
  if (Boolean(event.altKey) !== requiresAlt) {
    return false
  }

  return event.key.toLowerCase() === keyToken
}

const REGION_SAMPLE_UV = {
  global: { x: 0.5, y: 0.5 },
  q1: { x: 0.25, y: 0.25 },
  q2: { x: 0.75, y: 0.25 },
  q3: { x: 0.25, y: 0.75 },
  q4: { x: 0.75, y: 0.75 },
}

const VALIDATION_DEFAULTS = {
  windStartSec: 8,
  windDurationSec: 44,
  windIntensity: 0.95,
  windBlendInSec: 14,
  windBlendOutSec: 14,
  regionStartSec: 58,
  regionDurationSec: 34,
  regionIntensity: 0.82,
  regionTarget: 'q2',
  intentStartSec: 104,
  intentDurationSec: 24,
  intentLeadInSec: 7,
  intentRegion: 'q3',
  revealStyle: 'soft-lift',
  recoveryStyle: 'gentle-settle',
}

const DEFAULT_WORKSPACE_LAYOUT = {
  leftWidth: 240,
  rightWidth: 320,
  bottomHeight: 280,
  timelineRestoreHeight: 280,
  timelineMaximized: false,
  utilityPanelOpen: false,
  uiFontPx: BASE_UI_FONT_PX,
  uiScale: 1.1,
  density: 'comfortable',
  timelineEventLabels: 'full',
  timelineSnapSeconds: 1,
  timelineFitToWindow: false,
  assetCardSize: 'compact',
  previewMode: 'contain',
  previewZoom: 1,
  showPreviewDevReadout: false,
  showSceneGrid: false,
  showDiagnosticsOverlay: false,
  showCompositionGuides: true,
}

const LAYOUT_PRESETS = {
  editing: {
    leftWidth: 280,
    rightWidth: 360,
    bottomHeight: 300,
    utilityPanelOpen: true,
  },
  review: {
    leftWidth: 220,
    rightWidth: 300,
    bottomHeight: 340,
    utilityPanelOpen: false,
  },
  focus: {
    leftWidth: 200,
    rightWidth: 280,
    bottomHeight: 250,
    utilityPanelOpen: false,
  },
}

const ADVANCED_TUNING_TABS = [
  {
    id: 'atmosphere',
    label: 'Atmosphere',
    groups: [
      {
        id: 'atmosphere-links',
        label: 'Atmosphere Links',
        description: 'Cross-system links used when balancing scene-wide weather response.',
        controls: ['links.mistDensity', 'links.fogSoftness'],
      },
      {
        id: 'atmosphere-mist',
        label: 'Mist Layer',
        description: 'Base mist intensity and tint controls used by atmosphere compositing.',
        controls: ['renderer.mistTime', 'renderer.mistColorR', 'renderer.mistColorG', 'renderer.mistColorB', 'renderer.mistColorA'],
        toggles: ['renderer.mistEnabled'],
      },
    ],
  },
  {
    id: 'rain-physics',
    label: 'Rain Physics',
    groups: [
      {
        id: 'rain-spawn',
        label: 'Rain Spawn',
        description: 'Procedural droplet generation controls from the original harness.',
        controls: ['renderer.dropletsPerSeconds', 'renderer.dropletSizeMin', 'renderer.dropletSizeMax'],
      },
      {
        id: 'rain-interaction',
        label: 'Droplet Interaction',
        description: 'Low-level droplet-to-surface interaction and runner behavior tuning.',
        controls: [
          'dropletInteraction.headClearStrength',
          'dropletInteraction.headClearRadiusMultiplier',
          'dropletInteraction.trailClearStrength',
          'dropletInteraction.trailClearRadiusMultiplier',
          'dropletInteraction.largeRunnerSizeGateStart',
          'dropletInteraction.largeRunnerSizeGateRange',
          'dropletInteraction.largeRunnerMassGateStart',
          'dropletInteraction.largeRunnerMassGateRange',
          'dropletInteraction.largeRunnerBoostStrength',
          'dropletInteraction.largeRunnerRadiusBoost',
          'dropletInteraction.largeRunnerTrailBoost',
          'dropletInteraction.largeRunnerTrailRadiusBoost',
          'dropletInteraction.slopePlausibilityThreshold',
          'links.largeRunnerInfluence',
        ],
        toggles: ['dropletInteraction.downwardOnly'],
      },
    ],
  },
  {
    id: 'surface-wetness',
    label: 'Surface Wetness',
    groups: [
      {
        id: 'surface-core',
        label: 'Wetness Core',
        description: 'Surface field accumulation, diffusion, and recovery controls.',
        controls: [
          'surfaceWetness.initialWetness',
          'surfaceWetness.maxWetness',
          'surfaceWetness.refillRate',
          'surfaceWetness.recoveryRate',
          'surfaceWetness.diffusionRate',
          'surfaceWetness.trailRecoveryRate',
          'surfaceWetness.runnerMemoryRecoveryRate',
        ],
      },
      {
        id: 'surface-links',
        label: 'Wetness Linkage',
        description: 'Link controls that influence runner-driven wetness behavior.',
        controls: ['links.largeRunnerInfluence'],
      },
    ],
  },
  {
    id: 'fog-system',
    label: 'Fog System',
    groups: [
      {
        id: 'fog-core',
        label: 'Fog Core',
        description: 'Fog build, fill, and smoothing controls for scheduler-driven atmosphere.',
        controls: [
          'fogSurface.baseFogLevel',
          'fogSurface.fogScale',
          'fogSurface.fogTintStrength',
          'fogSurface.fogAlphaMultiplier',
          'fogSurface.fogFillBoost',
          'fogSurface.wetnessFogGain',
          'fogSurface.wetnessSoftnessGain',
          'fogSurface.trailMistGain',
          'fogSurface.runnerChannelGain',
          'fogSurface.runnerChannelThreshold',
          'fogSurface.debugSurfaceContrast',
          'fogSurface.smoothingPassCount',
        ],
      },
      {
        id: 'fog-links',
        label: 'Fog Linkage',
        description: 'Global links that influence fog softness and mist density response.',
        controls: ['links.fogSoftness', 'links.mistDensity'],
      },
    ],
  },
  {
    id: 'render-interpretation',
    label: 'Render Interpretation',
    groups: [
      {
        id: 'render-lighting',
        label: 'Droplet Lighting',
        description: 'Lighting and optical interpretation controls for droplet rendering.',
        controls: [
          'renderer.raindropLightPosX',
          'renderer.raindropLightPosY',
          'renderer.raindropLightPosZ',
          'renderer.raindropDiffuseLightR',
          'renderer.raindropDiffuseLightG',
          'renderer.raindropDiffuseLightB',
          'renderer.raindropSpecularShininess',
          'renderer.raindropSpecularLightR',
          'renderer.raindropSpecularLightG',
          'renderer.raindropSpecularLightB',
          'renderer.raindropLightBump',
        ],
      },
      {
        id: 'render-composite',
        label: 'Compositing',
        description: 'Renderer compose mode and overlay blend interpretation controls.',
        controls: ['debug.compositeOverlayStrength'],
        selects: ['renderer.raindropCompose'],
      },
    ],
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    groups: [
      {
        id: 'diag-views',
        label: 'Debug Views',
        description: 'Studio-only debug view, split-compare, and compatibility mode toggles.',
        toggles: [
          'debug.showRawRendererInset',
          'debug.freezeRain',
          'debug.freezeBackground',
          'debug.splitCompareEnabled',
          'debug.overlayBackendCompareEnabled',
          'debug.splitRawOnRight',
        ],
        selects: ['debug.viewMode', 'debug.compatibilityMode'],
      },
      {
        id: 'diag-gpu',
        label: 'GPU Prototypes & Parity',
        description: 'Runtime prototype flags and parity gate thresholds for troubleshooting.',
        controls: [
          'debug.gpuParityThresholdMeanDelta',
          'debug.gpuParityThresholdMae',
          'debug.gpuParityThresholdVarianceDelta',
          'debug.gpuParityThresholdTileMaxMae',
        ],
        toggles: [
          'debug.useGpuOverlayPrototype',
          'debug.useGpuFogCompositing',
          'debug.useGpuWetnessSimulation',
          'debug.useGpuWritingInteractionPrototype',
          'debug.gpuParityGateEnabled',
        ],
      },
      {
        id: 'diag-refresh',
        label: 'Refresh & Smoothing Diagnostics',
        description: 'Wetness refresh cadence and smoothing diagnostics used for backend verification.',
        controls: ['debug.wetnessFullRefreshIntervalFrames', 'debug.wetnessSmoothingStride'],
        toggles: ['debug.wetnessRegionOnlySmoothing'],
      },
    ],
  },
]

const CONTROL_INDEX = buildTuningControlIndex()

function StudioPage() {
  const workspaceShellRef = useRef(null)
  const centerWorkspaceRef = useRef(null)
  const leftPanelRef = useRef(null)
  const rightPanelRef = useRef(null)
  const bottomTimelineRef = useRef(null)
  const previewFitSourceRef = useRef(null)
  const previewViewportRef = useRef(null)
  const previewResizeProxyRef = useRef(null)
  const previewPresentationRef = useRef(null)
  const previewLogicalRootRef = useRef(null)
  const previewStageRef = useRef(null)
  const previewCanvasRef = useRef(null)
  const previewEngineRef = useRef(null)
  const previewHostIdentityRef = useRef(0)
  const previewLastHostRef = useRef(null)
  const previewRuntimePayloadStabilityRef = useRef({
    fingerprint: null,
    payload: null,
    source: 'working',
  })
  const previewMountCountRef = useRef(0)
  const previewUnmountCountRef = useRef(0)
  const previewLoopRunningRef = useRef(false)
  const studioSurfaceSessionIdRef = useRef(`studio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const menuRegionRef = useRef(null)
  const menuTriggerRefs = useRef({})
  const menuCloseTimerRef = useRef(null)
  const menuRestoreFocusRef = useRef(null)
  const menuKeyboardAnchorRef = useRef({ section: 'cascade', index: 0 })
  const importProjectInputRef = useRef(null)
  const previewPreviousModeRef = useRef(getStudioSettings().studio?.workspaceLayout?.previewMode || DEFAULT_WORKSPACE_LAYOUT.previewMode)
  const previewPreviousPresentationRef = useRef({ width: PREVIEW_SCENE_WIDTH, height: PREVIEW_SCENE_HEIGHT, scale: 1 })
  const previewFitSourceCycleRef = useRef({ width: 0, height: 0, scale: 1 })
  const schedulerRef = useRef(null)
  const playbackClockRef = useRef(performance.now())
  const playheadRef = useRef(0)
  const transportModeRef = useRef('stopped')
  const hydratedProjectIdRef = useRef(null)
  const scrubActiveRef = useRef(false)
  const resizeFrameRef = useRef(0)
  const pendingPointerRef = useRef(null)

  const [settings, setSettings] = useState(() => getStudioSettings())
  const [projectRegistry, setProjectRegistry] = useState(() => getProjectRegistry())
  const [savedDocument, setSavedDocument] = useState(() => getSavedAuthoringDocument())
  const [publishedDocument, setPublishedDocument] = useState(() => getPublishedRuntimeDocument())
  const [projectLoadWarning, setProjectLoadWarning] = useState('')
  const [assetQuery, setAssetQuery] = useState('')
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState('preview')
  const [activeSceneId, setActiveSceneId] = useState(sceneCatalog[0]?.id || '')
  const [activeTimelineId, setActiveTimelineId] = useState(() => getStudioSettings().defaultTimelineId || timelineCatalog[0]?.id || '')
  const [activePresetId, setActivePresetId] = useState(sceneCatalog[0]?.presetId || presetCatalog[0]?.id || '')
  const [selectedTimelineSelection, setSelectedTimelineSelection] = useState(null)
  const [compositionRegionContext, setCompositionRegionContext] = useState('global')
  const [assetBrowserSelection, setAssetBrowserSelection] = useState(null)
  const [validationDraft, setValidationDraft] = useState(VALIDATION_DEFAULTS)
  const [previewDriveSnapshot, setPreviewDriveSnapshot] = useState({
    fogBase: 0,
    fogAlpha: 0,
    mistAlpha: 0,
    dropletsPerSeconds: 0,
  })
  const [schedulerSnapshot, setSchedulerSnapshot] = useState({
    sampleSec: 0,
    weather: {
      wind: 0,
      rain: 0,
      mist: 0,
      washdown: 0,
      fogBuildup: 0,
      fogClearing: 0,
    },
    activeIntentEvents: [],
    diagnostics: {
      weatherTrackContributions: [],
      intentContributions: [],
      weatherBeforeIntent: {
        wind: 0,
        rain: 0,
        mist: 0,
        washdown: 0,
        fogBuildup: 0,
        fogClearing: 0,
      },
      weatherAfterIntent: {
        wind: 0,
        rain: 0,
        mist: 0,
        washdown: 0,
        fogBuildup: 0,
        fogClearing: 0,
      },
      sampleUv: REGION_SAMPLE_UV.global,
    },
  })
  const [timelinePlayheadSec, setTimelinePlayheadSec] = useState(0)
  const [transportMode, setTransportMode] = useState('stopped')
  const [loopPlayback, setLoopPlayback] = useState(true)
  const [previewStats, setPreviewStats] = useState({ fog: 0, droplets: 0, timing: {} })
  const [studioDocumentVisible, setStudioDocumentVisible] = useState(() => document.visibilityState === 'visible')
  const [studioWindowFocused, setStudioWindowFocused] = useState(() => document.hasFocus())
  const [runtimeSurfacePriorityState, setRuntimeSurfacePriorityState] = useState(() => getRuntimeSurfacePriorityState())
  const [updateDesktopHandoffPending, setUpdateDesktopHandoffPending] = useState(false)
  const [desktopSwitchFallbackVisible, setDesktopSwitchFallbackVisible] = useState(false)
  const [previewRawViewportSize, setPreviewRawViewportSize] = useState({ width: 0, height: 0 })
  const [previewViewportSize, setPreviewViewportSize] = useState({ width: 0, height: 0 })
  const [previewDevicePixelRatio, setPreviewDevicePixelRatio] = useState(() => window.devicePixelRatio || 1)
  const [previewHostDiagnostics, setPreviewHostDiagnostics] = useState({
    hostWidth: 0,
    hostHeight: 0,
    canvasWidth: 0,
    canvasHeight: 0,
    hostId: 'unbound',
    mountCount: 0,
    unmountCount: 0,
    invalidDimensions: false,
  })
  const [previewElementDiagnostics, setPreviewElementDiagnostics] = useState({})
  const [previewFitSourceChangedAfterScaleChange, setPreviewFitSourceChangedAfterScaleChange] = useState(false)
  const [previewHostReady, setPreviewHostReady] = useState(false)
  const [previewInitialViewportMeasured, setPreviewInitialViewportMeasured] = useState(false)
  const [previewInitialLayoutReady, setPreviewInitialLayoutReady] = useState(false)
  const [previewInitialComputeRan, setPreviewInitialComputeRan] = useState(false)
  const [previewMeasuredViewportForInitial, setPreviewMeasuredViewportForInitial] = useState({ width: 0, height: 0 })
  const [previewLayoutResetCount, setPreviewLayoutResetCount] = useState(0)
  const [previewTransitionSnapshot, setPreviewTransitionSnapshot] = useState({
    previousMode: DEFAULT_WORKSPACE_LAYOUT.previewMode,
    nextMode: DEFAULT_WORKSPACE_LAYOUT.previewMode,
    previousPresentation: { width: PREVIEW_SCENE_WIDTH, height: PREVIEW_SCENE_HEIGHT },
    nextPresentation: { width: PREVIEW_SCENE_WIDTH, height: PREVIEW_SCENE_HEIGHT },
    previousScale: 1,
    nextScale: 1,
    resetRan: false,
    reason: 'initial',
  })
  const [menuOpen, setMenuOpen] = useState(null)
  const [menuSubmenuState, setMenuSubmenuState] = useState(MENU_SUBMENU_DEFAULTS)
  const [menuDropdownStyle, setMenuDropdownStyle] = useState(null)
  const [menuKeyboardActive, setMenuKeyboardActive] = useState(false)
  const [menuKeyboardSection, setMenuKeyboardSection] = useState('cascade')
  const [menuKeyboardIndex, setMenuKeyboardIndex] = useState(0)
  const [isResizing, setIsResizing] = useState(null)
  const [panelState, setPanelState] = useState({
    left: false,
    center: false,
    right: false,
    bottom: false,
  })
  const [focusPanel, setFocusPanel] = useState(null)
  const [activeUtilityTab, setActiveUtilityTab] = useState('atmosphere')
  const [verificationRunning, setVerificationRunning] = useState(false)
  const [selectedVerificationScenarioId, setSelectedVerificationScenarioId] = useState(getDefaultVerificationScenarioId)
  const [latestVerificationArtifact, setLatestVerificationArtifact] = useState(() => getLatestVerificationArtifact())
  const [recentVerificationRuns, setRecentVerificationRuns] = useState(() => getVerificationArtifactIndex({ limit: 6 }))
  const resizeWidthRef = useRef(typeof window === 'undefined' ? 1440 : window.innerWidth)
  const autoCollapsedPanelsRef = useRef({ left: false, right: false })
  const autoCompressedLeftWidthRef = useRef(null)
  const presentationWindowRef = useRef(null)

  const [workspaceLayout, setWorkspaceLayout] = useState(() => {
    const persisted = getStudioSettings().studio?.workspaceLayout
    return normalizeWorkspaceLayout(persisted)
  })
  const workspaceLayoutRef = useRef(workspaceLayout)
  const layoutBounds = useMemo(
    () => getScaledLayoutBounds(workspaceLayout.uiScale, workspaceLayout.density),
    [workspaceLayout.density, workspaceLayout.uiScale],
  )

  const [tuningConfig, setTuningConfig] = useState(() => {
    const preset = getPresetById(sceneCatalog[0]?.presetId)
    return mergeDeep(DEFAULT_TUNING_CONFIG, preset?.tuning || {})
  })

  const timelineOptions = useMemo(() => timelineCatalog.map((item) => item.id), [])
  const regionModel = useMemo(
    () => createFourQuadrantRegionModel({ softness: 0.45 }),
    [],
  )
  const selectedScene = useMemo(
    () => sceneCatalog.find((item) => item.id === activeSceneId) || sceneCatalog[0],
    [activeSceneId],
  )
  const selectedTimeline = useMemo(
    () => getTimelineById(activeTimelineId || selectedScene?.timelineId),
    [activeTimelineId, selectedScene?.timelineId],
  )
  const inspectedScene = useMemo(
    () => assetBrowserSelection?.type === 'scene'
      ? sceneCatalog.find((item) => item.id === assetBrowserSelection.id) || null
      : null,
    [assetBrowserSelection],
  )
  const inspectedTimeline = useMemo(
    () => assetBrowserSelection?.type === 'timeline'
      ? getTimelineById(assetBrowserSelection.id)
      : null,
    [assetBrowserSelection],
  )
  const inspectedPreset = useMemo(
    () => assetBrowserSelection?.type === 'preset'
      ? presetCatalog.find((item) => item.id === assetBrowserSelection.id) || null
      : null,
    [assetBrowserSelection],
  )

  const [editorClips, setEditorClips] = useState(() =>
    parseTimelineToClips(getTimelineById(
      getStudioSettings().defaultTimelineId || timelineCatalog[0]?.id || '',
    )),
  )

  const timelineDurationSec = selectedTimeline?.duration?.seconds || 180
  const previewViewportClassName = `scene-preview-viewport scene-preview-viewport--${workspaceLayout.previewMode}`
  const previewVisibleBox = useMemo(() => ({
    width: Math.max(0, Math.round(previewViewportSize.width || 0)),
    height: Math.max(0, Math.round(previewViewportSize.height || 0)),
  }), [previewViewportSize.height, previewViewportSize.width])
  const previewPaddedFitBox = useMemo(() => {
    const inset = PREVIEW_MATTE_INSET_PX
    return {
      inset,
      width: Math.max(0, previewVisibleBox.width - (inset * 2)),
      height: Math.max(0, previewVisibleBox.height - (inset * 2)),
    }
  }, [previewVisibleBox.height, previewVisibleBox.width])
  const previewContainBaselineScale = useMemo(() => {
    if (previewPaddedFitBox.width <= 0 || previewPaddedFitBox.height <= 0) {
      return 1
    }
    const fitScale = Math.min(
      previewPaddedFitBox.width / PREVIEW_SCENE_WIDTH,
      previewPaddedFitBox.height / PREVIEW_SCENE_HEIGHT,
    )
    return Math.min(1, fitScale)
  }, [previewPaddedFitBox.height, previewPaddedFitBox.width])
  const previewZoomPercent = Math.round(workspaceLayout.previewZoom * 100)

  const previewPresentation = useMemo(() => {
    const authoredWidth = PREVIEW_SCENE_WIDTH
    const authoredHeight = PREVIEW_SCENE_HEIGHT

    if (previewVisibleBox.width <= 0 || previewVisibleBox.height <= 0 || previewPaddedFitBox.width <= 0 || previewPaddedFitBox.height <= 0) {
      return {
        width: authoredWidth,
        height: authoredHeight,
        scale: 1,
      }
    }

    const fitScale = Math.min(
      previewPaddedFitBox.width / authoredWidth,
      previewPaddedFitBox.height / authoredHeight,
    )

    if (workspaceLayout.previewMode === 'contain') {
      const scale = previewContainBaselineScale
      return {
        width: Math.max(1, Math.round(authoredWidth * scale)),
        height: Math.max(1, Math.round(authoredHeight * scale)),
        scale,
      }
    }

    if (workspaceLayout.previewMode === 'fill') {
      return {
        width: Math.max(1, Math.round(authoredWidth * fitScale)),
        height: Math.max(1, Math.round(authoredHeight * fitScale)),
        scale: fitScale,
      }
    }

    if (workspaceLayout.previewMode === 'native') {
      return {
        width: authoredWidth,
        height: authoredHeight,
        scale: 1,
      }
    }

    const zoomScale = previewContainBaselineScale * workspaceLayout.previewZoom
    return {
      width: Math.max(1, Math.round(authoredWidth * zoomScale)),
      height: Math.max(1, Math.round(authoredHeight * zoomScale)),
      scale: zoomScale,
    }
  }, [previewContainBaselineScale, previewPaddedFitBox.height, previewPaddedFitBox.width, previewVisibleBox.height, previewVisibleBox.width, workspaceLayout.previewMode, workspaceLayout.previewZoom])

  const previewScale = previewPresentation.scale
  const previewUpscaleActive = previewScale > 1.001
  const previewDimensionIssues = useMemo(() => {
    const checks = [
      previewViewportSize.width,
      previewViewportSize.height,
      previewPresentation.width,
      previewPresentation.height,
      PREVIEW_SCENE_WIDTH,
      PREVIEW_SCENE_HEIGHT,
      previewScale,
      previewHostDiagnostics.hostWidth,
      previewHostDiagnostics.hostHeight,
    ]

    return checks.some((value) => !Number.isFinite(value) || value < 0)
  }, [
    previewHostDiagnostics.hostHeight,
    previewHostDiagnostics.hostWidth,
    previewPresentation.height,
    previewPresentation.width,
    previewScale,
    previewViewportSize.height,
    previewViewportSize.width,
  ])
  const previewHasRenderedFrame = (previewStats?.timing?.avgFrameMs || 0) > 0
  const previewPostFrameInvalid = previewHasRenderedFrame && (
    previewDimensionIssues
    || previewHostDiagnostics.invalidDimensions
    || previewHostDiagnostics.hostWidth <= 0
    || previewHostDiagnostics.hostHeight <= 0
    || previewPresentation.width <= 0
    || previewPresentation.height <= 0
    || previewScale <= 0
  )

  const previewPresentationStyle = {
    width: `${previewPresentation.width}px`,
    height: `${previewPresentation.height}px`,
  }
  const previewExpectedCanvasBackingWidth = Math.max(1, Math.round(PREVIEW_SCENE_WIDTH * previewDevicePixelRatio))
  const previewExpectedCanvasBackingHeight = Math.max(1, Math.round(PREVIEW_SCENE_HEIGHT * previewDevicePixelRatio))
  const previewCanvasBackingMatchesLogical = (
    previewElementDiagnostics.canvasAttributes?.width === previewExpectedCanvasBackingWidth
    && previewElementDiagnostics.canvasAttributes?.height === previewExpectedCanvasBackingHeight
  )

  const logicalCompositionStyle = {
    width: `${PREVIEW_SCENE_WIDTH}px`,
    height: `${PREVIEW_SCENE_HEIGHT}px`,
    minWidth: `${PREVIEW_SCENE_WIDTH}px`,
    minHeight: `${PREVIEW_SCENE_HEIGHT}px`,
    transform: `scale(${previewScale})`,
    transformOrigin: 'top left',
  }
  const previewStageStyle = {
    width: `${PREVIEW_SCENE_WIDTH}px`,
    height: `${PREVIEW_SCENE_HEIGHT}px`,
    minWidth: `${PREVIEW_SCENE_WIDTH}px`,
    minHeight: `${PREVIEW_SCENE_HEIGHT}px`,
    maxWidth: 'none',
    maxHeight: 'none',
  }
  const previewCanvasStyle = {
    position: 'absolute',
    inset: '0',
    width: `${PREVIEW_SCENE_WIDTH}px`,
    height: `${PREVIEW_SCENE_HEIGHT}px`,
    minWidth: `${PREVIEW_SCENE_WIDTH}px`,
    minHeight: `${PREVIEW_SCENE_HEIGHT}px`,
    maxWidth: 'none',
    maxHeight: 'none',
    display: 'block',
  }

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development' || !previewPostFrameInvalid) {
      return
    }

    console.warn('[StudioPreview] Invalid dimensions detected after first rendered frame.', {
      viewport: previewViewportSize,
      presentation: previewPresentation,
      logical: { width: PREVIEW_SCENE_WIDTH, height: PREVIEW_SCENE_HEIGHT },
      scale: previewScale,
      host: previewHostDiagnostics,
    })
  }, [previewHostDiagnostics, previewPostFrameInvalid, previewPresentation, previewScale, previewViewportSize])

  useEffect(() => {
    const viewport = previewViewportRef.current
    const presentation = previewPresentationRef.current
    const logical = previewLogicalRootRef.current
    const host = previewStageRef.current
    const canvas = previewCanvasRef.current

    if (panelState.center || !viewport || !presentation || !logical || !host || !canvas) {
      return
    }

    const previousMode = previewPreviousModeRef.current
    const previousPresentation = previewPreviousPresentationRef.current
    const nextPresentation = {
      width: previewPresentation.width,
      height: previewPresentation.height,
    }
    const reason = previousMode !== workspaceLayout.previewMode
      ? 'mode-change'
      : previewDevicePixelRatio !== (previewTransitionSnapshot?.devicePixelRatio || previewDevicePixelRatio)
        ? 'dpr-change'
        : 'layout-reset'

    viewport.scrollLeft = 0
    viewport.scrollTop = 0

    ;[viewport, presentation, logical, host, canvas].forEach((element) => {
      element.style.removeProperty('clip-path')
      element.style.removeProperty('clip')
      element.style.removeProperty('translate')
    })

    presentation.style.removeProperty('overflow')
    logical.style.removeProperty('overflow')
    host.style.removeProperty('transform')
    canvas.style.removeProperty('transform')
    canvas.style.removeProperty('top')
    canvas.style.removeProperty('left')
    canvas.style.removeProperty('right')
    canvas.style.removeProperty('bottom')

    setPreviewLayoutResetCount((count) => count + 1)
    setPreviewTransitionSnapshot({
      previousMode,
      nextMode: workspaceLayout.previewMode,
      previousPresentation: {
        width: previousPresentation.width,
        height: previousPresentation.height,
      },
      nextPresentation,
      previousScale: previousPresentation.scale,
      nextScale: previewScale,
      resetRan: true,
      reason,
      devicePixelRatio: previewDevicePixelRatio,
    })

    previewPreviousModeRef.current = workspaceLayout.previewMode
    previewPreviousPresentationRef.current = {
      width: previewPresentation.width,
      height: previewPresentation.height,
      scale: previewScale,
    }

    window.requestAnimationFrame(() => {
      previewEngineRef.current?.resize?.()
    })
  }, [
    panelState.bottom,
    panelState.center,
    panelState.left,
    panelState.right,
    previewDevicePixelRatio,
    previewPresentation.height,
    previewPresentation.width,
    previewScale,
    previewViewportSize.height,
    previewViewportSize.width,
    workspaceLayout.bottomHeight,
    workspaceLayout.leftWidth,
    workspaceLayout.previewMode,
    workspaceLayout.previewZoom,
    workspaceLayout.rightWidth,
  ])
  const normalizedEditorClips = useMemo(
    () => editorClips.map((clip) => normalizeClip(clip, timelineDurationSec)).filter(Boolean),
    [editorClips, timelineDurationSec],
  )
  const authoredTimeline = useMemo(
    () => compileClipsToTimeline(normalizedEditorClips, timelineDurationSec, selectedTimeline?.id),
    [normalizedEditorClips, timelineDurationSec, selectedTimeline?.id],
  )
  const selectedTimelineBaselineClips = useMemo(() => {
    try {
      return parseTimelineToClips(selectedTimeline)
        .map((clip) => normalizeClip(clip, timelineDurationSec))
        .filter(Boolean)
    } catch {
      return []
    }
  }, [selectedTimeline, timelineDurationSec])
  const hasAuthoredTimelineOverride = useMemo(
    () => runtimePayloadFingerprint(normalizedEditorClips) !== runtimePayloadFingerprint(selectedTimelineBaselineClips),
    [normalizedEditorClips, selectedTimelineBaselineClips],
  )
  const workingRuntimePayload = useMemo(() => buildWorkingRuntimePayload({
    selectedSceneId: activeSceneId,
    selectedPresetId: activePresetId,
    selectedTimelineId: activeTimelineId,
    startupMode: settings.startupMode,
    timelineDurationSec,
    normalizedClips: hasAuthoredTimelineOverride ? normalizedEditorClips : null,
    authoredTimeline: hasAuthoredTimelineOverride ? authoredTimeline : null,
    loopPlayback,
    settingsSnapshot: {
      startupMode: settings.startupMode,
      staticStartup: settings.staticStartup,
      scenePerVisit: settings.scenePerVisit,
      presentation: {
        autoRunTimeline: settings.presentation?.autoRunTimeline,
      },
    },
  }), [
    activePresetId,
    activeSceneId,
    activeTimelineId,
    authoredTimeline,
    hasAuthoredTimelineOverride,
    loopPlayback,
    normalizedEditorClips,
    settings.presentation?.autoRunTimeline,
    settings.scenePerVisit,
    settings.startupMode,
    settings.staticStartup,
    timelineDurationSec,
  ])
  const workingPayloadFingerprint = useMemo(
    () => runtimePayloadFingerprint(workingRuntimePayload),
    [workingRuntimePayload],
  )
  const savedPayloadFingerprint = useMemo(
    () => runtimePayloadFingerprint(savedDocument?.runtimePayload || null),
    [savedDocument?.runtimePayload],
  )
  const publishedPayloadFingerprint = useMemo(
    () => runtimePayloadFingerprint(publishedDocument?.runtimePayload || null),
    [publishedDocument?.runtimePayload],
  )
  const previewRuntimePayloadCandidate = useMemo(
    () => publishedDocument?.runtimePayload || savedDocument?.runtimePayload || workingRuntimePayload || null,
    [publishedDocument?.runtimePayload, savedDocument?.runtimePayload, workingRuntimePayload],
  )
  const previewRuntimeSourceCandidate = publishedDocument?.runtimePayload
    ? 'published'
    : savedDocument?.runtimePayload
      ? 'saved'
      : 'working'
  const previewRuntimePayloadCandidateFingerprint = useMemo(
    () => runtimePayloadFingerprint(previewRuntimePayloadCandidate),
    [previewRuntimePayloadCandidate],
  )
  const previewRuntimeSelection = useMemo(() => {
    const stableSelection = previewRuntimePayloadStabilityRef.current
    if (stableSelection.fingerprint === previewRuntimePayloadCandidateFingerprint) {
      return {
        payload: stableSelection.payload,
        source: stableSelection.source,
      }
    }

    const nextSelection = {
      fingerprint: previewRuntimePayloadCandidateFingerprint,
      payload: previewRuntimePayloadCandidate,
      source: previewRuntimeSourceCandidate,
    }
    previewRuntimePayloadStabilityRef.current = nextSelection

    return {
      payload: nextSelection.payload,
      source: nextSelection.source,
    }
  }, [previewRuntimePayloadCandidate, previewRuntimePayloadCandidateFingerprint, previewRuntimeSourceCandidate])
  const previewRuntimePayload = previewRuntimeSelection.payload
  const previewRuntimeSource = previewRuntimeSelection.source
  const previewRuntimeExecution = useMemo(
    () => resolveRuntimeExecutionFromPayload(previewRuntimePayload),
    [previewRuntimePayload],
  )
  const previewRuntimeScene = previewRuntimeExecution.scene
  const previewRuntimeTimeline = previewRuntimeExecution.timeline
  const previewRuntimeBasePreset = previewRuntimeExecution.basePreset
  const previewRuntimeTimelineId = previewRuntimeExecution.timelineId
  const previewRuntimePayloadHash = useMemo(
    () => shortRuntimePayloadHash(previewRuntimePayload),
    [previewRuntimePayload],
  )
  const previewRuntimePublishRevision = publishedDocument?.publishRevision || 0
  const previewRuntimeRestartToken = publishedDocument?.restartToken || 'local-default'
  const resolvedRuntimeSurfacePriority = useMemo(
    () => resolveRuntimeSurfacePriorityState(runtimeSurfacePriorityState),
    [runtimeSurfacePriorityState],
  )
  const studioPreviewPauseReason = useMemo(() => {
    if (!studioDocumentVisible) {
      return 'tab-hidden'
    }
    if (!studioWindowFocused) {
      return 'tab-unfocused'
    }
    if (resolvedRuntimeSurfacePriority.resolvedSurfaceType === 'presentation') {
      if (
        updateDesktopHandoffPending
        || resolvedRuntimeSurfacePriority.resolvedReason === 'update-desktop-handoff'
      ) {
        return 'update-desktop-handoff'
      }
      return 'presentation-focused'
    }
    return 'studio-focused'
  }, [
    resolvedRuntimeSurfacePriority.resolvedReason,
    resolvedRuntimeSurfacePriority.resolvedSurfaceType,
    studioDocumentVisible,
    studioWindowFocused,
    updateDesktopHandoffPending,
  ])
  const studioPreviewPaused = studioPreviewPauseReason !== 'studio-focused'
  const hasUnsavedChanges = workingPayloadFingerprint !== savedPayloadFingerprint
  const publishIsOutdated = savedPayloadFingerprint !== publishedPayloadFingerprint
  const activeProjectId = projectRegistry.activeProjectId || null
  const activeProjectMeta = useMemo(
    () => projectRegistry.projects.find((project) => project.projectId === activeProjectId) || null,
    [activeProjectId, projectRegistry.projects],
  )
  const timelineBoundariesSec = useMemo(() => {
    const markers = new Set([0, timelineDurationSec])
    for (const clip of editorClips) {
      markers.add(clamp(Number(clip.startSec) || 0, 0, timelineDurationSec))
    }
    return Array.from(markers).sort((a, b) => a - b)
  }, [editorClips, timelineDurationSec])
  const verificationScenarioRegistry = useMemo(() => getVerificationScenarioRegistry(), [])
  const resolvedVerificationScenario = useMemo(
    () => resolveVerificationScenario(selectedVerificationScenarioId, {
      authoredTimeline,
      publishedDocument,
      activeSceneId,
      activeTimelineId,
    }),
    [activeSceneId, activeTimelineId, authoredTimeline, publishedDocument, selectedVerificationScenarioId],
  )
  const runtimeScheduler = useMemo(
    () => createSchedulerRuntime(previewRuntimeTimeline, {
      regionModel,
      includeDiagnostics: true,
    }),
    [previewRuntimeTimeline, regionModel],
  )

  const selectedClip = useMemo(() => {
    const clipId = selectedTimelineSelection?.clipId
    if (!clipId) {
      return null
    }
    return editorClips.find((clip) => clip.id === clipId) || null
  }, [selectedTimelineSelection?.clipId, editorClips])
  const activeAuthoringRegion = selectedClip?.region || compositionRegionContext || 'global'

  const selectedTimelineKey = selectedTimeline?.id || activeTimelineId || 'timeline-fallback'

  useEffect(() => {
    const updateVisibilityAndFocus = () => {
      setStudioDocumentVisible(document.visibilityState === 'visible')
      setStudioWindowFocused(document.hasFocus())
    }

    updateVisibilityAndFocus()
    window.addEventListener('focus', updateVisibilityAndFocus)
    window.addEventListener('blur', updateVisibilityAndFocus)
    document.addEventListener('visibilitychange', updateVisibilityAndFocus)

    return () => {
      window.removeEventListener('focus', updateVisibilityAndFocus)
      window.removeEventListener('blur', updateVisibilityAndFocus)
      document.removeEventListener('visibilitychange', updateVisibilityAndFocus)
    }
  }, [])

  useEffect(() => subscribeRuntimeSurfacePriorityState(setRuntimeSurfacePriorityState), [])

  useEffect(() => {
    const publishOrReleaseStudioHeartbeat = () => {
      const visible = document.visibilityState === 'visible'
      const focused = document.hasFocus()

      if (updateDesktopHandoffPending && !visible) {
        setUpdateDesktopHandoffPending(false)
      }

      if (updateDesktopHandoffPending && visible && !focused) {
        setUpdateDesktopHandoffPending(false)
      }

      if (updateDesktopHandoffPending && visible && focused) {
        releaseRuntimeSurfacePriorityHeartbeat({
          surfaceType: 'studio',
          surfaceSessionId: studioSurfaceSessionIdRef.current,
        })
        return
      }

      if (visible && focused) {
        publishRuntimeSurfacePriorityHeartbeat({
          surfaceType: 'studio',
          surfaceSessionId: studioSurfaceSessionIdRef.current,
          surfaceWindowId: `${window.location.pathname || '/studio'}:${activeProjectId || 'no-project'}`,
          reason: 'studio-focused',
          visibilityState: 'visible',
          isFocused: true,
          heartbeatTtlMs: RUNTIME_SURFACE_HEARTBEAT_TTL_MS,
        })
        return
      }

      releaseRuntimeSurfacePriorityHeartbeat({
        surfaceType: 'studio',
        surfaceSessionId: studioSurfaceSessionIdRef.current,
      })
    }

    publishOrReleaseStudioHeartbeat()
    const timer = window.setInterval(publishOrReleaseStudioHeartbeat, RUNTIME_SURFACE_HEARTBEAT_INTERVAL_MS)
    window.addEventListener('focus', publishOrReleaseStudioHeartbeat)
    window.addEventListener('blur', publishOrReleaseStudioHeartbeat)
    document.addEventListener('visibilitychange', publishOrReleaseStudioHeartbeat)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', publishOrReleaseStudioHeartbeat)
      window.removeEventListener('blur', publishOrReleaseStudioHeartbeat)
      document.removeEventListener('visibilitychange', publishOrReleaseStudioHeartbeat)
      releaseRuntimeSurfacePriorityHeartbeat({
        surfaceType: 'studio',
        surfaceSessionId: studioSurfaceSessionIdRef.current,
      })
    }
  }, [activeProjectId, updateDesktopHandoffPending])

  useEffect(() => {
    if (!selectedScene) {
      return
    }
    setActivePresetId(selectedScene.presetId)
    setActiveTimelineId((prev) => prev || selectedScene.timelineId)
  }, [selectedScene])

  useEffect(() => {
    const preset = getPresetById(activePresetId)
    setTuningConfig(mergeDeep(DEFAULT_TUNING_CONFIG, preset?.tuning || {}))
  }, [activePresetId])

  useEffect(() => {
    setSelectedTimelineSelection(null)
    setCompositionRegionContext('global')
  }, [selectedTimelineKey])

  useEffect(() => {
    if (!selectedClip?.region) {
      return
    }
    setCompositionRegionContext(selectedClip.region)
  }, [selectedClip?.region])

  useEffect(() => {
    try {
      setEditorClips(parseTimelineToClips(selectedTimeline))
    } catch (error) {
      console.error('[Studio] Failed to parse timeline clips; falling back to empty editor clip set.', error)
      setEditorClips([])
    }
  }, [selectedTimelineKey, selectedTimeline])

  useEffect(() => {
    setTimelinePlayheadSec(0)
    setTransportMode('stopped')
    setLoopPlayback(selectedTimeline?.loop !== false)
  }, [selectedTimelineKey, selectedTimeline?.loop])

  useEffect(() => {
    schedulerRef.current = runtimeScheduler
  }, [runtimeScheduler])

  useEffect(() => {
    let mediaQueryList = null

    const updateDevicePixelRatio = () => {
      const nextRatio = window.devicePixelRatio || 1
      setPreviewDevicePixelRatio((prev) => (Math.abs(prev - nextRatio) > 0.001 ? nextRatio : prev))

      if (mediaQueryList) {
        mediaQueryList.removeEventListener('change', updateDevicePixelRatio)
      }
      mediaQueryList = window.matchMedia(`(resolution: ${nextRatio}dppx)`)
      mediaQueryList.addEventListener('change', updateDevicePixelRatio)
    }

    updateDevicePixelRatio()
    window.addEventListener('resize', updateDevicePixelRatio)

    return () => {
      window.removeEventListener('resize', updateDevicePixelRatio)
      mediaQueryList?.removeEventListener('change', updateDevicePixelRatio)
    }
  }, [])

  useEffect(() => {
    const fitSourceElement = previewFitSourceRef.current
    if (!fitSourceElement) {
      return undefined
    }

    let frameId = 0

    const updateViewportSize = () => {
      const fitSourceRect = fitSourceElement.getBoundingClientRect()
      const rawWidth = Math.round(fitSourceRect.width || 0)
      const rawHeight = Math.round(fitSourceRect.height || 0)
      const width = Number.isFinite(rawWidth) && rawWidth > 0 ? Math.max(0, rawWidth) : 0
      const height = Number.isFinite(rawHeight) && rawHeight > 0 ? Math.max(0, rawHeight) : 0

      const previousCycle = previewFitSourceCycleRef.current
      const fitSourceChanged = previousCycle.width !== width || previousCycle.height !== height
      const scaleChanged = Math.abs((previousCycle.scale || 1) - previewScale) > 0.0005
      const changedAfterScaleChange = fitSourceChanged && scaleChanged

      previewFitSourceCycleRef.current = {
        width,
        height,
        scale: previewScale,
      }

      setPreviewFitSourceChangedAfterScaleChange((prev) => (prev === changedAfterScaleChange ? prev : changedAfterScaleChange))

      if (process.env.NODE_ENV === 'development' && (rawWidth <= 0 || rawHeight <= 0)) {
        console.warn('[StudioPreview] Viewport measured with non-positive size.', { rawWidth, rawHeight })
      }

      setPreviewRawViewportSize((prev) => {
        const next = {
          width: Math.max(0, rawWidth),
          height: Math.max(0, rawHeight),
        }
        return prev.width === next.width && prev.height === next.height ? prev : next
      })

      setPreviewViewportSize((prev) => {
        const next = { width, height }
        return prev.width === next.width && prev.height === next.height ? prev : next
      })

      if (!previewInitialViewportMeasured && width > 0 && height > 0) {
        setPreviewInitialViewportMeasured(true)
        setPreviewMeasuredViewportForInitial({ width, height })
        if (process.env.NODE_ENV === 'development') {
          console.info('[StudioPreview] Initial effective fit box confirmed.', {
            rawWidth,
            rawHeight,
            width,
            height,
          })
        }
      }
    }

    const scheduleViewportSizeUpdate = () => {
      window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(updateViewportSize)
    }

    scheduleViewportSizeUpdate()

    const observedElements = [
      fitSourceElement,
      centerWorkspaceRef.current,
      leftPanelRef.current,
      rightPanelRef.current,
      bottomTimelineRef.current,
      workspaceShellRef.current,
    ].filter(Boolean)

    const observer = new window.ResizeObserver(() => scheduleViewportSizeUpdate())
    observedElements.forEach((observedElement) => observer.observe(observedElement))
    window.addEventListener('resize', scheduleViewportSizeUpdate)

    return () => {
      window.removeEventListener('resize', scheduleViewportSizeUpdate)
      window.cancelAnimationFrame(frameId)
      observer.disconnect()
    }
  }, [panelState.center, previewDevicePixelRatio, previewInitialViewportMeasured, previewScale, workspaceLayout.bottomHeight, workspaceLayout.leftWidth, workspaceLayout.rightWidth])

  // Initial layout settle: wait for viewport measurement, then run authoritative recompute
  useEffect(() => {
    if (!previewInitialViewportMeasured || previewInitialComputeRan) {
      return
    }

    const viewport = previewViewportRef.current
    const presentation = previewPresentationRef.current
    const logical = previewLogicalRootRef.current
    const host = previewStageRef.current
    const canvas = previewCanvasRef.current

    if (panelState.center || !viewport || !presentation || !logical || !host || !canvas) {
      return
    }

    // Run authoritative layout reset for initial measurement
    viewport.scrollLeft = 0
    viewport.scrollTop = 0

    ;[viewport, presentation, logical, host, canvas].forEach((element) => {
      element.style.removeProperty('clip-path')
      element.style.removeProperty('clip')
      element.style.removeProperty('translate')
    })

    presentation.style.removeProperty('overflow')
    logical.style.removeProperty('overflow')
    host.style.removeProperty('transform')
    canvas.style.removeProperty('transform')
    canvas.style.removeProperty('top')
    canvas.style.removeProperty('left')
    canvas.style.removeProperty('right')
    canvas.style.removeProperty('bottom')

    setPreviewLayoutResetCount((count) => count + 1)
    setPreviewInitialLayoutReady(true)
    setPreviewInitialComputeRan(true)
    setPreviewTransitionSnapshot({
      previousMode: DEFAULT_WORKSPACE_LAYOUT.previewMode,
      nextMode: workspaceLayout.previewMode,
      previousPresentation: { width: PREVIEW_SCENE_WIDTH, height: PREVIEW_SCENE_HEIGHT },
      nextPresentation: {
        width: previewPresentation.width,
        height: previewPresentation.height,
      },
      previousScale: 1,
      nextScale: previewScale,
      resetRan: true,
      reason: 'initial-layout-settle',
      devicePixelRatio: previewDevicePixelRatio,
      initialMeasuredViewport: previewMeasuredViewportForInitial,
    })

    previewPreviousModeRef.current = workspaceLayout.previewMode
    previewPreviousPresentationRef.current = {
      width: previewPresentation.width,
      height: previewPresentation.height,
      scale: previewScale,
    }

    window.requestAnimationFrame(() => {
      previewEngineRef.current?.resize?.()
    })

    if (process.env.NODE_ENV === 'development') {
      console.info('[StudioPreview] Initial layout settle completed.', {
        measuredViewport: previewMeasuredViewportForInitial,
        presentation: {
          width: previewPresentation.width,
          height: previewPresentation.height,
        },
        scale: previewScale,
      })
    }
  }, [
    panelState.bottom,
    panelState.center,
    panelState.left,
    panelState.right,
    previewDevicePixelRatio,
    previewInitialViewportMeasured,
    previewInitialComputeRan,
    previewPresentation.height,
    previewPresentation.width,
    previewScale,
    workspaceLayout.previewMode,
    workspaceLayout.previewZoom,
  ])

  useEffect(() => {
    const host = previewStageRef.current
    if (!host || panelState.center) {
      return undefined
    }

    if (!host.dataset.previewHostId) {
      previewHostIdentityRef.current += 1
      host.dataset.previewHostId = `host-${previewHostIdentityRef.current}`
    }

    if (previewLastHostRef.current && previewLastHostRef.current !== host && process.env.NODE_ENV === 'development') {
      console.warn('[StudioPreview] Renderer host node identity changed.', {
        previous: previewLastHostRef.current.dataset.previewHostId,
        next: host.dataset.previewHostId,
      })
    }
    previewLastHostRef.current = host

    const updateHostDiagnostics = () => {
      const canvas = previewCanvasRef.current
      const hostWidth = Number.isFinite(host.clientWidth) ? Math.max(0, Math.floor(host.clientWidth)) : 0
      const hostHeight = Number.isFinite(host.clientHeight) ? Math.max(0, Math.floor(host.clientHeight)) : 0
      const canvasWidth = canvas ? Math.max(0, Math.floor(canvas.width || 0)) : 0
      const canvasHeight = canvas ? Math.max(0, Math.floor(canvas.height || 0)) : 0
      const invalidDimensions = [hostWidth, hostHeight, canvasWidth, canvasHeight].some((value) => !Number.isFinite(value) || value < 0)
      const ready = hostWidth > 0 && hostHeight > 0

      setPreviewHostReady(ready)
      setPreviewHostDiagnostics((prev) => ({
        ...prev,
        hostWidth,
        hostHeight,
        canvasWidth,
        canvasHeight,
        hostId: host.dataset.previewHostId || 'unbound',
        invalidDimensions,
      }))

      if (process.env.NODE_ENV === 'development' && (invalidDimensions || !ready)) {
        console.warn('[StudioPreview] Host diagnostics flagged invalid or non-ready dimensions.', {
          hostId: host.dataset.previewHostId,
          hostWidth,
          hostHeight,
          canvasWidth,
          canvasHeight,
          invalidDimensions,
        })
      }
    }

    updateHostDiagnostics()

    const observer = new window.ResizeObserver(() => updateHostDiagnostics())
    observer.observe(host)
    return () => observer.disconnect()
  }, [panelState.center])

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development' || panelState.center) {
      return undefined
    }

    const collectMetrics = (element, label) => {
      if (!element) {
        return null
      }

      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)

      return {
        label,
        clientWidth: Math.round(element.clientWidth || 0),
        clientHeight: Math.round(element.clientHeight || 0),
        offsetWidth: Math.round(element.offsetWidth || 0),
        offsetHeight: Math.round(element.offsetHeight || 0),
        computedWidth: style.width,
        computedHeight: style.height,
        rectWidth: Math.round(rect.width || 0),
        rectHeight: Math.round(rect.height || 0),
        position: style.position,
        transform: style.transform !== 'none',
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        clipped: ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflowY),
      }
    }

    const updateElementDiagnostics = () => {
      const host = previewStageRef.current
      const canvas = previewCanvasRef.current
      const logical = previewLogicalRootRef.current

      const fitSourceRect = previewFitSourceRef.current?.getBoundingClientRect() || null
      const logicalRect = logical?.getBoundingClientRect() || null
      const effectiveRect = fitSourceRect
        ? {
          left: fitSourceRect.left,
          top: fitSourceRect.top,
          right: fitSourceRect.right,
          bottom: fitSourceRect.bottom,
          width: Math.max(0, Math.round(fitSourceRect.width || 0)),
          height: Math.max(0, Math.round(fitSourceRect.height || 0)),
        }
        : null

      const displayedRect = effectiveRect && logicalRect
        ? {
          width: Math.max(0, Math.round(Math.min(effectiveRect.right, logicalRect.right) - Math.max(effectiveRect.left, logicalRect.left))),
          height: Math.max(0, Math.round(Math.min(effectiveRect.bottom, logicalRect.bottom) - Math.max(effectiveRect.top, logicalRect.top))),
        }
        : null
      const compositionVisible = logicalRect
        ? displayedRect?.width === Math.round(logicalRect.width || 0) && displayedRect?.height === Math.round(logicalRect.height || 0)
        : false

      setPreviewElementDiagnostics({
        fitSource: collectMetrics(previewFitSourceRef.current, 'fit-source'),
        viewport: collectMetrics(previewViewportRef.current, 'viewport'),
        presentation: collectMetrics(previewPresentationRef.current, 'presentation'),
        logical: collectMetrics(logical, 'logical'),
        host: collectMetrics(host, 'host'),
        canvas: collectMetrics(canvas, 'canvas'),
        displayedRect,
        compositionVisible,
        visiblePreviewBox: {
          width: previewVisibleBox.width,
          height: previewVisibleBox.height,
        },
        effectiveFitBox: {
          width: previewPaddedFitBox.width,
          height: previewPaddedFitBox.height,
          inset: PREVIEW_MATTE_INSET_PX,
          differsFromRaw: previewViewportSize.width !== previewRawViewportSize.width || previewViewportSize.height !== previewRawViewportSize.height,
        },
        fitSourceStable: !previewFitSourceChangedAfterScaleChange,
        fitSourceChangedAfterScaleChange: previewFitSourceChangedAfterScaleChange,
        canvasAttributes: canvas
          ? {
            width: canvas.width,
            height: canvas.height,
          }
          : null,
      })
    }

    updateElementDiagnostics()

    const observedElements = [
      previewFitSourceRef.current,
      previewViewportRef.current,
      previewPresentationRef.current,
      previewLogicalRootRef.current,
      previewStageRef.current,
      previewCanvasRef.current,
    ].filter(Boolean)

    const observer = new window.ResizeObserver(() => updateElementDiagnostics())
    observedElements.forEach((element) => observer.observe(element))
    const rafId = window.requestAnimationFrame(updateElementDiagnostics)

    return () => {
      window.cancelAnimationFrame(rafId)
      observer.disconnect()
    }
  }, [panelState.center, previewFitSourceChangedAfterScaleChange, previewHostDiagnostics.hostHeight, previewHostDiagnostics.hostWidth, previewPaddedFitBox.height, previewPaddedFitBox.width, previewRawViewportSize.height, previewRawViewportSize.width, previewScale, previewViewportSize.height, previewViewportSize.width, previewVisibleBox.height, previewVisibleBox.width, workspaceLayout.previewMode])

  useEffect(() => {
    const canvas = previewCanvasRef.current
    const previewStage = previewStageRef.current
    const resizeProxy = previewResizeProxyRef.current
    const stageWidth = previewStage ? previewStage.clientWidth : 0
    const stageHeight = previewStage ? previewStage.clientHeight : 0

    if (panelState.center || !canvas || !previewRuntimeScene || !previewStage || !resizeProxy || !previewHostReady) {
      if (process.env.NODE_ENV === 'development' && !panelState.center) {
        console.info('[StudioPreview] Skipping engine mount until host is ready.', {
          hasCanvas: Boolean(canvas),
          hasScene: Boolean(previewRuntimeScene),
          hasStage: Boolean(previewStage),
          hasResizeProxy: Boolean(resizeProxy),
          previewHostReady,
          stageWidth,
          stageHeight,
        })
      }
      return undefined
    }

    if (!Number.isFinite(stageWidth) || !Number.isFinite(stageHeight) || stageWidth <= 0 || stageHeight <= 0) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[StudioPreview] Skipping engine mount due to invalid stage dimensions.', {
          stageWidth,
          stageHeight,
        })
      }
      return undefined
    }

    previewMountCountRef.current += 1

    const engine = new WetSurfaceEngine(canvas, {
      backgroundSrc: previewRuntimeScene.background?.src || '/media/rain-room.jpg',
      phase: 3,
      tuningConfig: getLinkedEffectiveConfig(previewRuntimeBasePreset),
      onStats: (stats) => setPreviewStats(stats),
      resizeMode: 'element',
      viewportElement: resizeProxy,
    })
    previewEngineRef.current = engine

    setPreviewHostDiagnostics((prev) => ({
      ...prev,
      mountCount: previewMountCountRef.current,
      unmountCount: previewUnmountCountRef.current,
      hostId: previewStage.dataset.previewHostId || prev.hostId,
    }))

    if (process.env.NODE_ENV === 'development') {
      console.info('[StudioPreview] Engine mounted.', {
        mountCount: previewMountCountRef.current,
        hostId: previewStage.dataset.previewHostId,
        stageWidth,
        stageHeight,
      })
    }

    engine.start()
    previewLoopRunningRef.current = true

    return () => {
      previewUnmountCountRef.current += 1
      setPreviewHostDiagnostics((prev) => ({
        ...prev,
        mountCount: previewMountCountRef.current,
        unmountCount: previewUnmountCountRef.current,
      }))

      if (process.env.NODE_ENV === 'development') {
        console.info('[StudioPreview] Engine unmounted.', {
          mountCount: previewMountCountRef.current,
          unmountCount: previewUnmountCountRef.current,
          hostId: previewStage.dataset.previewHostId,
        })
      }

      engine.stop()
      previewEngineRef.current = null
      previewLoopRunningRef.current = false
    }
  }, [panelState.center, previewHostReady, previewRuntimeBasePreset, previewRuntimeScene])

  useEffect(() => {
    const engine = previewEngineRef.current
    if (!engine) {
      return
    }

    if (studioPreviewPaused) {
      if (previewLoopRunningRef.current) {
        engine.setLoopActive?.(false, `studio-preview-paused:${studioPreviewPauseReason}`)
        previewLoopRunningRef.current = false
      }
      return
    }

    if (!previewLoopRunningRef.current) {
      engine.setLoopActive?.(true, 'studio-preview-resumed')
      previewLoopRunningRef.current = true
    }
  }, [studioPreviewPauseReason, studioPreviewPaused])

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') {
      return undefined
    }

    window.__MISTYOS_STUDIO_PREVIEW_STATS = previewStats
    window.__MISTYOS_STUDIO_RUNTIME = {
      activeTimelineId,
      activeWorkspaceTab,
      activeSurface: resolvedRuntimeSurfacePriority.resolvedSurfaceType || null,
      currentSurfacePriority: resolvedRuntimeSurfacePriority.resolvedSurfaceType || null,
      currentSurfacePriorityReason: resolvedRuntimeSurfacePriority.resolvedReason || null,
      studioPreviewPaused,
      studioPreviewPauseReason,
      updateDesktopHandoffPending,
    }

    return () => {
      delete window.__MISTYOS_STUDIO_PREVIEW_STATS
      delete window.__MISTYOS_STUDIO_RUNTIME
    }
  }, [
    activeTimelineId,
    activeWorkspaceTab,
    previewStats,
    resolvedRuntimeSurfacePriority.resolvedReason,
    resolvedRuntimeSurfacePriority.resolvedSurfaceType,
    studioPreviewPauseReason,
    studioPreviewPaused,
    updateDesktopHandoffPending,
  ])

  useEffect(() => {
    const engine = previewEngineRef.current
    const canvas = previewCanvasRef.current
    if (!canvas) {
      return
    }

    const hasInvalidResizeInputs = (
      !Number.isFinite(previewExpectedCanvasBackingWidth)
      || !Number.isFinite(previewExpectedCanvasBackingHeight)
      || previewExpectedCanvasBackingWidth <= 0
      || previewExpectedCanvasBackingHeight <= 0
      || !Number.isFinite(previewDevicePixelRatio)
      || previewDevicePixelRatio <= 0
    )

    if (hasInvalidResizeInputs) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[StudioPreview] Skipping backing-buffer sync due to invalid dimensions.', {
          previewExpectedCanvasBackingWidth,
          previewExpectedCanvasBackingHeight,
          previewDevicePixelRatio,
        })
      }
      return
    }

    canvas.style.width = `${PREVIEW_SCENE_WIDTH}px`
    canvas.style.height = `${PREVIEW_SCENE_HEIGHT}px`

    if (engine) {
      engine.resize?.()
    }

    if (canvas.width !== previewExpectedCanvasBackingWidth || canvas.height !== previewExpectedCanvasBackingHeight) {
      canvas.width = previewExpectedCanvasBackingWidth
      canvas.height = previewExpectedCanvasBackingHeight
    }
  }, [previewDevicePixelRatio, previewExpectedCanvasBackingHeight, previewExpectedCanvasBackingWidth])

  const sampleSchedulerAt = useCallback((sampleSec, options = {}) => {
    if (!schedulerRef.current) {
      return
    }

    const sampleUv = getSampleUvForRegion(options.regionId || selectedClip?.region)
    const snapshot = schedulerRef.current.sample({
      elapsedSec: sampleSec,
      fps: 60,
      uv: sampleUv,
      includeDiagnostics: true,
      captureVerification: true,
    })
    setSchedulerSnapshot(snapshot)

    const weather = snapshot.weather
    const drivenConfig = buildRuntimeWeatherDrivenConfig(previewRuntimeBasePreset, weather)
    setPreviewDriveSnapshot({
      fogBase: drivenConfig.fogSurface.baseFogLevel,
      fogAlpha: drivenConfig.fogSurface.fogAlphaMultiplier,
      mistAlpha: drivenConfig.renderer.mistColorA,
      dropletsPerSeconds: drivenConfig.renderer.dropletsPerSeconds,
    })
    previewEngineRef.current?.setTuningConfig(getLinkedEffectiveConfig(drivenConfig))
  }, [previewRuntimeBasePreset, selectedClip?.region])

  useEffect(() => {
    playheadRef.current = timelinePlayheadSec
  }, [timelinePlayheadSec])

  useEffect(() => {
    transportModeRef.current = transportMode
  }, [transportMode])

  useEffect(() => {
    sampleSchedulerAt(timelinePlayheadSec)
  }, [timelinePlayheadSec, sampleSchedulerAt, selectedTimelineKey])

  useEffect(() => {
    playbackClockRef.current = performance.now()
    const timer = window.setInterval(() => {
      if (studioPreviewPaused) {
        playbackClockRef.current = performance.now()
        return
      }

      if (scrubActiveRef.current) {
        playbackClockRef.current = performance.now()
        return
      }

      const mode = transportModeRef.current
      const now = performance.now()
      const dtSec = Math.max(0, (now - playbackClockRef.current) / 1000)
      playbackClockRef.current = now

      const rate = mode === 'playing'
        ? 1
        : mode === 'rewind'
          ? -SHUTTLE_RATE
          : mode === 'fastForward'
            ? SHUTTLE_RATE
            : 0

      if (rate === 0) {
        return
      }

      const previousSec = playheadRef.current
      let nextSec = previousSec + dtSec * rate

      if (loopPlayback) {
        nextSec = ((nextSec % timelineDurationSec) + timelineDurationSec) % timelineDurationSec
      } else {
        nextSec = clamp(nextSec, 0, timelineDurationSec)
        const reachedBoundary = nextSec <= 0 || nextSec >= timelineDurationSec
        if (reachedBoundary) {
          setTransportMode('paused')
        }
      }

      if (Math.abs(nextSec - previousSec) > PLAYBACK_EPSILON) {
        setTimelinePlayheadSec(nextSec)
      }
    }, PLAYBACK_TICK_MS)

    return () => window.clearInterval(timer)
  }, [timelineDurationSec, loopPlayback, studioPreviewPaused])

  useEffect(() => {
    const nextLayout = normalizeWorkspaceLayout(settings.studio?.workspaceLayout)
    setWorkspaceLayout(nextLayout)
  }, [settings.studio?.workspaceLayout])

  useEffect(() => {
    workspaceLayoutRef.current = workspaceLayout
  }, [workspaceLayout])

  useEffect(() => subscribeProjectRegistry(setProjectRegistry), [])

  useEffect(() => subscribeSavedAuthoringDocument(setSavedDocument), [])

  useEffect(() => subscribePublishedRuntimeDocument(setPublishedDocument), [])

  const updateSettings = (updater) => {
    setSettings((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      return saveStudioSettings(next)
    })
  }

  const updateWorkspaceLayout = useCallback((partial, persist = true) => {
    setWorkspaceLayout((old) => {
      const merged = { ...old, ...partial }
      if (persist) {
        updateSettings((prev) => ({
          ...old,
          studio: {
            ...old.studio,
            workspaceLayout: merged,
          },
        }))
      }
      return merged
    })
  }, [])

    const setUiFontSize = useCallback((nextFontPx) => {
    const snapped = snapFontSizeStep(Number(nextFontPx))
    updateWorkspaceLayout({
      uiFontPx: snapped,
      uiScale: snapped / BASE_UI_FONT_PX,
    }, true)
  }, [updateWorkspaceLayout])

  const stepUiFontSize = useCallback((direction) => {
    const currentIndex = getFontStepIndex(workspaceLayoutRef.current.uiFontPx)
    const nextIndex = clamp(currentIndex + direction, 0, UI_FONT_STEPS.length - 1)
    setUiFontSize(UI_FONT_STEPS[nextIndex])
  }, [setUiFontSize])

  const getStageStackHeight = useCallback(() => {
    const centerHeight = centerWorkspaceRef.current?.getBoundingClientRect().height || 0
    const timelineHeight = panelState.bottom ? layoutBounds.collapsedTimelineHeight : workspaceLayoutRef.current.bottomHeight
    return Math.max(centerHeight + timelineHeight, layoutBounds.minSceneHeight + layoutBounds.minTimelineHeight)
  }, [layoutBounds.collapsedTimelineHeight, layoutBounds.minSceneHeight, layoutBounds.minTimelineHeight, panelState.bottom])

  const getTimelineHeightBounds = useCallback((stageStackHeight = getStageStackHeight()) => ({
    min: layoutBounds.minTimelineHeight,
    max: Math.max(
      layoutBounds.minTimelineHeight,
      Math.min(stageStackHeight - layoutBounds.minSceneHeight, layoutBounds.maxTimelineHeight),
    ),
  }), [getStageStackHeight, layoutBounds.maxTimelineHeight, layoutBounds.minSceneHeight, layoutBounds.minTimelineHeight])

  const clampTimelineHeight = useCallback((height, stageStackHeight = getStageStackHeight()) => {
    const { min, max } = getTimelineHeightBounds(stageStackHeight)
    return clamp(height, min, max)
  }, [getStageStackHeight, getTimelineHeightBounds])

  useEffect(() => {
    if (!isResizing) {
      return undefined
    }

    const applyResizePointer = (clientX, clientY) => {
      if (isResizing.type === 'left') {
        const maxLeft = Math.max(layoutBounds.minLeftWidth, window.innerWidth - workspaceLayoutRef.current.rightWidth - layoutBounds.minCenterWidth - 80)
        const leftWidth = clamp(isResizing.startValue + (clientX - isResizing.startX), layoutBounds.minLeftWidth, maxLeft)
        updateWorkspaceLayout({ leftWidth }, false)
      }

      if (isResizing.type === 'right') {
        const maxRight = Math.max(layoutBounds.minRightWidth, window.innerWidth - workspaceLayoutRef.current.leftWidth - layoutBounds.minCenterWidth - 80)
        const rightWidth = clamp(isResizing.startValue - (clientX - isResizing.startX), layoutBounds.minRightWidth, maxRight)
        updateWorkspaceLayout({ rightWidth }, false)
      }

      if (isResizing.type === 'bottom') {
        const bottomHeight = clampTimelineHeight(
          isResizing.startValue - (clientY - isResizing.startY),
          isResizing.stageStackHeight,
        )
        updateWorkspaceLayout({
          bottomHeight,
          timelineRestoreHeight: bottomHeight,
          timelineMaximized: false,
        }, false)
      }
    }

    const flushPendingResize = () => {
      resizeFrameRef.current = 0
      const point = pendingPointerRef.current
      if (!point) {
        return
      }
      pendingPointerRef.current = null
      applyResizePointer(point.clientX, point.clientY)
    }

    const handleMouseMove = (event) => {
      pendingPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
      }

      if (!resizeFrameRef.current) {
        resizeFrameRef.current = window.requestAnimationFrame(flushPendingResize)
      }
    }

    const handleMouseUp = () => {
      if (resizeFrameRef.current) {
        window.cancelAnimationFrame(resizeFrameRef.current)
        flushPendingResize()
      }
      updateWorkspaceLayout(workspaceLayoutRef.current, true)
      setIsResizing(null)
      pendingPointerRef.current = null
      document.body.classList.remove('studio-resizing')
    }

    document.body.classList.add('studio-resizing')
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      if (resizeFrameRef.current) {
        window.cancelAnimationFrame(resizeFrameRef.current)
        resizeFrameRef.current = 0
      }
      pendingPointerRef.current = null
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('studio-resizing')
    }
  }, [clampTimelineHeight, isResizing, layoutBounds.minCenterWidth, layoutBounds.minLeftWidth, layoutBounds.minRightWidth, updateWorkspaceLayout])

  useEffect(() => {
    const handleViewportResize = () => {
      const width = window.innerWidth
      const shrinking = width < resizeWidthRef.current
      const growing = width > resizeWidthRef.current
      resizeWidthRef.current = width

      if (shrinking && width < 1260 && !panelState.right) {
        autoCollapsedPanelsRef.current.right = true
        setPanelState((prev) => ({ ...prev, right: true }))
      }

      if (shrinking && width < 1040) {
        const currentLeftWidth = workspaceLayoutRef.current.leftWidth
        const compressedLeftWidth = clamp(currentLeftWidth, layoutBounds.minLeftWidth, Math.round(210 * workspaceLayoutRef.current.uiScale))
        if (compressedLeftWidth !== currentLeftWidth) {
          if (autoCompressedLeftWidthRef.current == null) {
            autoCompressedLeftWidthRef.current = currentLeftWidth
          }
          updateWorkspaceLayout({ leftWidth: compressedLeftWidth }, false)
        }
        if (!panelState.left && width < 940) {
          autoCollapsedPanelsRef.current.left = true
          setPanelState((prev) => ({ ...prev, left: true }))
        }
      }

      if (growing && width >= 1260 && autoCollapsedPanelsRef.current.right) {
        if (panelState.right) {
          setPanelState((prev) => ({ ...prev, right: false }))
        }
        autoCollapsedPanelsRef.current.right = false
      }

      if (growing && width >= 940 && autoCollapsedPanelsRef.current.left) {
        if (panelState.left) {
          setPanelState((prev) => ({ ...prev, left: false }))
        }
        autoCollapsedPanelsRef.current.left = false
      }

      if (growing && width >= 1040 && autoCompressedLeftWidthRef.current != null) {
        const desiredLeftWidth = autoCompressedLeftWidthRef.current
        const maxLeft = Math.max(layoutBounds.minLeftWidth, width - workspaceLayoutRef.current.rightWidth - layoutBounds.minCenterWidth - 80)
        const restoredLeftWidth = clamp(desiredLeftWidth, layoutBounds.minLeftWidth, maxLeft)

        if (restoredLeftWidth !== workspaceLayoutRef.current.leftWidth) {
          updateWorkspaceLayout({ leftWidth: restoredLeftWidth }, false)
        }

        if (maxLeft >= desiredLeftWidth) {
          autoCompressedLeftWidthRef.current = null
        }
      }

      const stageStackHeight = getStageStackHeight()
      const boundedHeight = clampTimelineHeight(workspaceLayoutRef.current.bottomHeight, stageStackHeight)
      if (boundedHeight !== workspaceLayoutRef.current.bottomHeight) {
        updateWorkspaceLayout({
          bottomHeight: boundedHeight,
          timelineRestoreHeight: workspaceLayoutRef.current.timelineMaximized
            ? workspaceLayoutRef.current.timelineRestoreHeight
            : boundedHeight,
        }, false)
      } else if (workspaceLayoutRef.current.timelineMaximized) {
        const maxTimelineHeight = getTimelineHeightBounds(stageStackHeight).max
        if (workspaceLayoutRef.current.bottomHeight !== maxTimelineHeight) {
          updateWorkspaceLayout({ bottomHeight: maxTimelineHeight }, false)
        }
      }
    }

    const scheduleViewportResize = () => window.requestAnimationFrame(handleViewportResize)

    scheduleViewportResize()
    window.addEventListener('resize', scheduleViewportResize)
    return () => window.removeEventListener('resize', scheduleViewportResize)
  }, [clampTimelineHeight, getStageStackHeight, getTimelineHeightBounds, layoutBounds.minCenterWidth, layoutBounds.minLeftWidth, panelState.left, panelState.right, updateWorkspaceLayout])

  useEffect(() => {
    const bounds = getScaledLayoutBounds(workspaceLayout.uiScale, workspaceLayout.density)
    const stageStackHeight = getStageStackHeight()

    const nextLeft = clamp(workspaceLayout.leftWidth, bounds.minLeftWidth, bounds.maxLeftWidth)
    const nextRight = clamp(workspaceLayout.rightWidth, bounds.minRightWidth, bounds.maxRightWidth)
    const nextBottom = clampTimelineHeight(workspaceLayout.bottomHeight, stageStackHeight)
    const nextRestore = clampTimelineHeight(workspaceLayout.timelineRestoreHeight, stageStackHeight)

    const hasChange = (
      nextLeft !== workspaceLayout.leftWidth
      || nextRight !== workspaceLayout.rightWidth
      || nextBottom !== workspaceLayout.bottomHeight
      || nextRestore !== workspaceLayout.timelineRestoreHeight
    )

    if (hasChange) {
      updateWorkspaceLayout({
        leftWidth: nextLeft,
        rightWidth: nextRight,
        bottomHeight: nextBottom,
        timelineRestoreHeight: nextRestore,
      }, true)
    }
  }, [clampTimelineHeight, getStageStackHeight, updateWorkspaceLayout, workspaceLayout.bottomHeight, workspaceLayout.density, workspaceLayout.leftWidth, workspaceLayout.rightWidth, workspaceLayout.timelineRestoreHeight, workspaceLayout.uiScale])

  const beginResize = useCallback((type, event) => {
    event.preventDefault()
    setIsResizing({
      type,
      startX: event.clientX,
      startY: event.clientY,
      stageStackHeight: type === 'bottom' ? getStageStackHeight() : null,
      startValue: type === 'left'
        ? workspaceLayout.leftWidth
        : type === 'right'
          ? workspaceLayout.rightWidth
          : workspaceLayout.bottomHeight,
    })
  }, [getStageStackHeight, workspaceLayout])

  const toggleTimelineMaximize = useCallback(() => {
    if (panelState.bottom) {
      return
    }

    const stageStackHeight = getStageStackHeight()
    if (workspaceLayout.timelineMaximized) {
      const restoreHeight = clampTimelineHeight(workspaceLayout.timelineRestoreHeight, stageStackHeight)
      updateWorkspaceLayout({
        bottomHeight: restoreHeight,
        timelineRestoreHeight: restoreHeight,
        timelineMaximized: false,
      }, true)
      return
    }

    const restoreHeight = clampTimelineHeight(workspaceLayout.bottomHeight, stageStackHeight)
    const maxTimelineHeight = getTimelineHeightBounds(stageStackHeight).max
    updateWorkspaceLayout({
      bottomHeight: maxTimelineHeight,
      timelineRestoreHeight: restoreHeight,
      timelineMaximized: true,
    }, true)
  }, [clampTimelineHeight, getStageStackHeight, getTimelineHeightBounds, panelState.bottom, updateWorkspaceLayout, workspaceLayout.bottomHeight, workspaceLayout.timelineMaximized, workspaceLayout.timelineRestoreHeight])

  const togglePanelCollapse = useCallback((panel) => {
    if (panel === 'left' || panel === 'right') {
      autoCollapsedPanelsRef.current[panel] = false
    }
    setPanelState((prev) => ({
      ...prev,
      [panel]: !prev[panel],
    }))
    setFocusPanel((prev) => (prev === panel ? null : prev))
  }, [])

  const maximizePanel = useCallback((panel) => {
    setFocusPanel(panel)
    setPanelState({
      left: panel !== 'left',
      center: panel !== 'center',
      right: panel !== 'right',
      bottom: panel !== 'bottom',
    })
  }, [])

  const restorePanel = useCallback((panel) => {
    if (panel === 'left' || panel === 'right') {
      autoCollapsedPanelsRef.current[panel] = false
    }
    setPanelState((prev) => ({
      ...prev,
      [panel]: false,
    }))
    setFocusPanel(null)
  }, [])

  const restoreAllPanels = useCallback(() => {
    autoCollapsedPanelsRef.current.left = false
    autoCollapsedPanelsRef.current.right = false
    setPanelState({
      left: false,
      center: false,
      right: false,
      bottom: false,
    })
    setFocusPanel(null)
  }, [])

  const setPanelVisibility = useCallback((panel, visible) => {
    if (panel === 'left' || panel === 'right') {
      autoCollapsedPanelsRef.current[panel] = false
    }
    if (visible) {
      restorePanel(panel)
      return
    }
    setPanelState((prev) => ({ ...prev, [panel]: true }))
    setFocusPanel((prev) => (prev === panel ? null : prev))
  }, [restorePanel])

  const togglePanelFromMenu = useCallback((panel) => {
    if (panel === 'left' || panel === 'right') {
      autoCollapsedPanelsRef.current[panel] = false
    }
    setPanelState((prev) => {
      const nextCollapsed = !prev[panel]
      if (!nextCollapsed) {
        setFocusPanel(null)
      }
      return {
        ...prev,
        [panel]: nextCollapsed,
      }
    })
  }, [])

  const handleTransportPlay = useCallback(() => {
    setTransportMode('playing')
  }, [])

  const handleTransportPause = useCallback(() => {
    setTransportMode('paused')
  }, [])

  const handleTransportStop = useCallback(() => {
    setTransportMode('stopped')
    setTimelinePlayheadSec(0)
  }, [])

  const handleTransportRewindStart = useCallback(() => {
    setTransportMode('rewind')
  }, [])

  const handleTransportFastForwardStart = useCallback(() => {
    setTransportMode('fastForward')
  }, [])

  const handleTransportShuttleEnd = useCallback(() => {
    setTransportMode((prev) => (prev === 'rewind' || prev === 'fastForward' ? 'paused' : prev))
  }, [])

  const handleTransportSkip = useCallback(() => {
    const current = playheadRef.current
    const nextBoundary = timelineBoundariesSec.find((sec) => sec > current + PLAYBACK_EPSILON)
    if (typeof nextBoundary === 'number') {
      setTimelinePlayheadSec(nextBoundary)
      return
    }

    setTimelinePlayheadSec(loopPlayback ? 0 : timelineDurationSec)
  }, [timelineBoundariesSec, timelineDurationSec, loopPlayback])

  const handleScrubStart = useCallback((sampleSec) => {
    scrubActiveRef.current = true
    setTransportMode('paused')
    setTimelinePlayheadSec(clamp(sampleSec, 0, timelineDurationSec))
  }, [timelineDurationSec])

  const handleScrub = useCallback((sampleSec) => {
    setTimelinePlayheadSec(clamp(sampleSec, 0, timelineDurationSec))
  }, [timelineDurationSec])

  const handleScrubEnd = useCallback((sampleSec) => {
    scrubActiveRef.current = false
    if (typeof sampleSec === 'number') {
      setTimelinePlayheadSec(clamp(sampleSec, 0, timelineDurationSec))
    }
  }, [timelineDurationSec])

  useEffect(() => {
    const handleTransportKeydown = (event) => {
      const target = event.target
      const isTypingTarget = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || Boolean(target?.isContentEditable)
      if (isTypingTarget) {
        return
      }

      if (event.code === 'Space') {
        event.preventDefault()
        setTransportMode((prev) => (prev === 'playing' ? 'paused' : 'playing'))
      }

      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        handleTransportStop()
      }

      if (event.shiftKey && event.key === 'ArrowRight') {
        event.preventDefault()
        handleTransportSkip()
      }
    }

    window.addEventListener('keydown', handleTransportKeydown)
    return () => window.removeEventListener('keydown', handleTransportKeydown)
  }, [handleTransportSkip, handleTransportStop])

  const applyRuntimePayloadToStudio = useCallback((payload, options = {}) => {
    if (!payload || typeof payload !== 'object') {
      return false
    }

    const allowSettingsSync = options.syncSettings !== false
    const warnings = []

    const requestedSceneId = payload.selectedSceneId
    const requestedTimelineId = payload.selectedTimelineId
    const requestedPresetId = payload.selectedPresetId

    const fallbackSceneId = sceneCatalog[0]?.id || activeSceneId
    const fallbackTimelineId = timelineCatalog[0]?.id || activeTimelineId
    const fallbackPresetId = presetCatalog[0]?.id || activePresetId

    const hasScene = sceneCatalog.some((scene) => scene.id === requestedSceneId)
    const hasTimeline = timelineCatalog.some((timeline) => timeline.id === requestedTimelineId)
    const hasPreset = presetCatalog.some((preset) => preset.id === requestedPresetId)

    const nextSceneId = hasScene ? requestedSceneId : fallbackSceneId
    const nextTimelineId = hasTimeline ? requestedTimelineId : fallbackTimelineId
    let nextPresetId = hasPreset ? requestedPresetId : fallbackPresetId

    const linkedScenePresetId = sceneCatalog.find((scene) => scene.id === nextSceneId)?.presetId
    if (!hasPreset && linkedScenePresetId && presetCatalog.some((preset) => preset.id === linkedScenePresetId)) {
      nextPresetId = linkedScenePresetId
    }

    if (requestedSceneId && !hasScene) {
      warnings.push(`Missing scene ${requestedSceneId}; loaded fallback scene ${nextSceneId}.`)
    }
    if (requestedTimelineId && !hasTimeline) {
      warnings.push(`Missing timeline ${requestedTimelineId}; loaded fallback timeline ${nextTimelineId}.`)
    }
    if (requestedPresetId && !hasPreset) {
      warnings.push(`Missing preset ${requestedPresetId}; loaded fallback preset ${nextPresetId}.`)
    }

    setActiveSceneId(nextSceneId)
    setActivePresetId(nextPresetId)
    setActiveTimelineId(nextTimelineId)

    const hasAuthoredTimelinePayload = Boolean(payload.authoredTimeline && typeof payload.authoredTimeline === 'object')
    const resolveSelectedTimelineClips = () => {
      const nextTimeline = timelineCatalog.find((timeline) => timeline.id === nextTimelineId)
      try {
        setEditorClips(parseTimelineToClips(nextTimeline))
      } catch (error) {
        console.warn('[MistyOS][Studio] Timeline clip rehydrate failed; using empty clip set.', {
          requestedTimelineId,
          nextTimelineId,
          error: error instanceof Error ? error.message : String(error),
        })
        setEditorClips([])
      }
    }

    if (Array.isArray(payload.normalizedClips)) {
      setEditorClips(payload.normalizedClips)
    } else if ((payload.normalizedClips === null || payload.normalizedClips === undefined) && !hasAuthoredTimelinePayload) {
      // Preloaded timeline saves intentionally omit authored clips; hydrate from the selected catalog timeline.
      resolveSelectedTimelineClips()
    } else if (payload.normalizedClips !== undefined) {
      const normalizedClipDataType = payload.normalizedClips === null
        ? 'null'
        : Array.isArray(payload.normalizedClips)
          ? 'array'
          : typeof payload.normalizedClips
      console.warn('[MistyOS][Studio] Invalid clip payload detected during runtime payload apply.', {
        requestedTimelineId,
        nextTimelineId,
        normalizedClipDataType,
        hasAuthoredTimelinePayload,
      })
      warnings.push('Invalid clip data detected; reloaded selected timeline clips.')
      resolveSelectedTimelineClips()
    } else if (hasAuthoredTimelinePayload) {
      console.warn('[MistyOS][Studio] Authored timeline payload missing normalized clips; reloading selected timeline clips.', {
        requestedTimelineId,
        nextTimelineId,
      })
      warnings.push('Authored clip payload was incomplete; reloaded selected timeline clips.')
      resolveSelectedTimelineClips()
    }
    if (typeof payload.loopPlayback === 'boolean') {
      setLoopPlayback(payload.loopPlayback)
    }

    if (allowSettingsSync && payload.settingsSnapshot) {
      const snapshot = payload.settingsSnapshot
      updateSettings((prev) => ({
        ...prev,
        startupMode: snapshot.startupMode ?? prev.startupMode,
        staticStartup: snapshot.staticStartup ?? prev.staticStartup,
        scenePerVisit: snapshot.scenePerVisit ?? prev.scenePerVisit,
        presentation: {
          ...prev.presentation,
          autoRunTimeline: snapshot.presentation?.autoRunTimeline ?? prev.presentation?.autoRunTimeline,
        },
      }))
    }

    if (warnings.length) {
      setProjectLoadWarning(warnings.join(' '))
    } else if (options.clearWarning !== false) {
      setProjectLoadWarning('')
    }

    return true
  }, [activePresetId, activeSceneId, activeTimelineId, updateSettings])

  useEffect(() => {
    const activeId = projectRegistry.activeProjectId
    if (!activeId || hydratedProjectIdRef.current === activeId) {
      return
    }

    hydratedProjectIdRef.current = activeId
    const payload = savedDocument?.runtimePayload
    if (payload) {
      applyRuntimePayloadToStudio(payload, { syncSettings: true, clearWarning: false })
    }
  }, [applyRuntimePayloadToStudio, projectRegistry.activeProjectId, savedDocument?.runtimePayload])

  const handleSwitchProject = useCallback((projectId) => {
    if (!projectId || projectId === activeProjectId) {
      return
    }

    if (hasUnsavedChanges && !window.confirm('Switch project and discard current unsaved working edits?')) {
      return
    }

    switchActiveProject(projectId)
  }, [activeProjectId, hasUnsavedChanges])

  const handleActiveTimelineChange = useCallback((timelineId) => {
    if (!timelineId) {
      return
    }

    setActiveTimelineId(timelineId)
    updateSettings((prev) => ({ ...prev, defaultTimelineId: timelineId }))
  }, [updateSettings])

  const handleCreateProjectFromCurrent = useCallback((options = {}) => {
    const suggestedName = options.suggestedName || `${activeProjectMeta?.name || 'Project'} Copy`
    const input = window.prompt('New project name', suggestedName)
    if (input === null) {
      return
    }

    const name = input.trim() || suggestedName
    const created = cloneActiveProjectAs({
      name,
      runtimePayload: workingRuntimePayload,
    })

    if (created) {
      setProjectLoadWarning('')
    }
  }, [activeProjectMeta?.name, workingRuntimePayload])

  const handleCreateBlankProject = useCallback(() => {
    const suggestedName = `Project ${projectRegistry.projects.length + 1}`
    const input = window.prompt('Project name', suggestedName)
    if (input === null) {
      return
    }
    const name = input.trim() || suggestedName
    createProject({
      name,
      runtimePayload: workingRuntimePayload,
      setActive: true,
    })
    setProjectLoadWarning('')
  }, [projectRegistry.projects.length, workingRuntimePayload])

  const exportAuthoringState = useCallback(() => {
    const exportDocument = exportActiveProjectDocument({ workingRuntimePayload })
    if (!exportDocument) {
      return
    }

    const blob = new Blob([JSON.stringify(exportDocument, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    const sanitizedName = (activeProjectMeta?.name || 'project').replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').toLowerCase()
    anchor.download = `mistyos-project-${sanitizedName}-${Date.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [activeProjectMeta?.name, workingRuntimePayload])

  const exportRuntimePayload = useCallback(() => {
    const sourcePayload = savedDocument?.runtimePayload || publishedDocument?.runtimePayload || workingRuntimePayload
    const exportDocument = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      type: 'mistyos-runtime-payload',
      runtimePayload: sourcePayload,
      source: savedDocument ? 'saved' : publishedDocument ? 'published' : 'working',
      publishRevision: publishedDocument?.publishRevision || null,
      savedRevision: savedDocument?.savedRevision || null,
    }

    const blob = new Blob([JSON.stringify(exportDocument, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `mistyos-runtime-payload-${Date.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [publishedDocument, savedDocument, workingRuntimePayload])

  const exportVerificationReport = useCallback((artifact = latestVerificationArtifact) => {
    if (!artifact) {
      console.warn('[MistyOS][Verification] No report is available to export for the current project/lineage.')
      return false
    }

    const blob = new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `mistyos-verification-report-${artifact.artifactId || Date.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    return true
  }, [latestVerificationArtifact])

  const exportLatestVerificationReport = useCallback(() => {
    exportVerificationReport(latestVerificationArtifact)
  }, [exportVerificationReport, latestVerificationArtifact])

  const exportLatestVerificationArtifact = useCallback(() => {
    exportLatestVerificationReport()
  }, [exportLatestVerificationReport])

  const copyLatestVerificationArtifact = useCallback(async () => {
    if (!latestVerificationArtifact) {
      console.warn('[MistyOS][Verification] No report is available to copy for the current project/lineage.')
      return
    }

    const payload = JSON.stringify(latestVerificationArtifact, null, 2)

    try {
      await navigator.clipboard.writeText(payload)
      console.info('[MistyOS][Verification] Latest verification report JSON copied to clipboard.')
    } catch {
      console.warn('[MistyOS][Verification] Clipboard copy failed; use Export Latest Verification Report.')
    }
  }, [latestVerificationArtifact])

  const importProjectFromFile = useCallback((file) => {
    if (!file) {
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || '{}'))
        const maybePayload = parsed?.workingRuntimePayload
          || parsed?.savedDocument?.runtimePayload
          || parsed?.runtimePayload
          || parsed

        if (!maybePayload || typeof maybePayload !== 'object') {
          throw new Error('Imported JSON did not include a valid runtime payload object.')
        }

        if (Array.isArray(maybePayload.normalizedClips) === false && maybePayload.normalizedClips !== undefined) {
          throw new Error('Imported payload has invalid normalizedClips format.')
        }

        if (!window.confirm('Import will create and switch to a new project context. Continue?')) {
          return
        }

        const fileNameStem = file.name.replace(/\.json$/i, '')
        const importedName = parsed?.metadata?.name || parsed?.name || fileNameStem || 'Imported Project'
        const imported = importProjectDocument({
          metadata: { name: importedName },
          runtimePayload: maybePayload,
        }, {
          name: importedName,
        })

        const applied = applyRuntimePayloadToStudio(maybePayload, { syncSettings: true, clearWarning: false })
        devLog('import-project', {
          applied,
          importedProjectId: imported?.metadata?.projectId || 'unknown',
          sceneId: maybePayload?.selectedSceneId || 'unknown',
          timelineId: maybePayload?.selectedTimelineId || 'unknown',
        })
      } catch (error) {
        setProjectLoadWarning(error instanceof Error ? error.message : 'Import failed.')
        devLog('import-project-failed', {
          reason: 'invalid-json',
          message: error instanceof Error ? error.message : 'Unknown parse error',
        })
      }
    }
    reader.readAsText(file)
  }, [applyRuntimePayloadToStudio])

  const triggerProjectImport = useCallback(() => {
    importProjectInputRef.current?.click()
  }, [])

  const handleProjectImportInputChange = useCallback((event) => {
    const file = event.target.files?.[0] || null
    importProjectFromFile(file)
    event.target.value = ''
  }, [importProjectFromFile])

  const revertToSavedPayload = useCallback(() => {
    if (!savedDocument?.runtimePayload) {
      return
    }

    if (!window.confirm('Revert working edits to the last saved snapshot? Unsaved changes will be lost.')) {
      return
    }

    applyRuntimePayloadToStudio(savedDocument.runtimePayload, { syncSettings: true })
    devLog('revert-to-saved', {
      savedRevision: savedDocument.savedRevision,
      publishRevision: publishedDocument?.publishRevision || 0,
    })
  }, [applyRuntimePayloadToStudio, publishedDocument?.publishRevision, savedDocument])

  const exportStudioConfig = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `mistyos-studio-settings-${Date.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const exportTuningConfig = () => {
    const blob = new Blob([JSON.stringify(tuningConfig, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `mistyos-studio-tuning-${Date.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const attemptSwitchToPresentationWindow = (source = 'update-desktop') => {
    const presentationRoute = settings?.presentation?.launcher?.presentationRoute || '/'
    let presentationUrl = '/'
    try {
      presentationUrl = new URL(presentationRoute, window.location.origin).toString()
    } catch {
      presentationUrl = `${window.location.origin}/`
    }

    let targetWindow = presentationWindowRef.current
    const refLooksCanonical = Boolean(
      targetWindow
      && !targetWindow.closed
      && targetWindow.name === PRESENTATION_WINDOW_NAME,
    )
    if (!refLooksCanonical) {
      targetWindow = null
      presentationWindowRef.current = null
    }

    const reusedExistingWindow = Boolean(targetWindow && !targetWindow.closed)
    let openedOrReusedWindow = reusedExistingWindow

    if (!reusedExistingWindow) {
      try {
        targetWindow = window.open(presentationUrl, PRESENTATION_WINDOW_NAME)
      } catch {
        targetWindow = null
      }
      openedOrReusedWindow = Boolean(targetWindow && !targetWindow.closed)
      if (openedOrReusedWindow) {
        try {
          if (targetWindow.name !== PRESENTATION_WINDOW_NAME) {
            targetWindow.name = PRESENTATION_WINDOW_NAME
          }
        } catch {
          // Ignore; named targeting is already best-effort.
        }
        presentationWindowRef.current = targetWindow
      }
    }

    if (targetWindow && !targetWindow.closed) {
      try {
        targetWindow.focus()
      } catch {
        // Ignore browser-level focus restrictions and rely on fallback affordance.
      }
    }

    const browserBlockedOrIgnored = !(targetWindow && !targetWindow.closed)
    const likelyForegrounded = Boolean(targetWindow && !targetWindow.closed && !document.hasFocus())
    const fallbackNeeded = browserBlockedOrIgnored || !likelyForegrounded
    setDesktopSwitchFallbackVisible(fallbackNeeded)

    return {
      source,
      presentationUrl,
      reusedExistingWindow,
      openedOrReusedWindow,
      browserBlockedOrIgnored,
      likelyForegrounded,
      fallbackNeeded,
    }
  }

  const handleSaveAuthoringState = useCallback(() => {
    const saved = saveSavedAuthoringDocument(workingRuntimePayload)
    setSavedDocument(saved)
    devLog('save-command', {
      savedRevision: saved?.savedRevision || 0,
      publishRevision: publishedDocument?.publishRevision || 0,
      hasUnsavedChanges: false,
    })
  }, [publishedDocument?.publishRevision, workingRuntimePayload])

  const handlePublishToDesktop = useCallback(() => {
    if (hasUnsavedChanges) {
      devLog('publish-command-blocked', {
        reason: 'unsaved-working-state',
        savedRevision: savedDocument?.savedRevision || 0,
        publishRevision: publishedDocument?.publishRevision || 0,
      })
      return null
    }

    if (!savedDocument) {
      devLog('publish-command-blocked', {
        reason: 'missing-saved-document',
        publishRevision: publishedDocument?.publishRevision || 0,
      })
      return null
    }

    const published = publishSavedAuthoringDocument(savedDocument)
    if (published) {
      setPublishedDocument(published)
      handoffRuntimeSurfaceToPresentation({
        sourceSurfaceWindowId: `${window.location.pathname || '/studio'}:${activeProjectId || 'no-project'}`,
        reason: 'update-desktop-handoff',
        heartbeatTtlMs: RUNTIME_SURFACE_HEARTBEAT_TTL_MS,
      })
      setUpdateDesktopHandoffPending(true)
      const presentationWindowSwitch = attemptSwitchToPresentationWindow('update-desktop')
      devLog('publish-command', {
        publishRevision: published.publishRevision,
        fromSavedRevision: published.fromSavedRevision,
        restartToken: published.restartToken,
        ownershipHandoff: 'studio->presentation',
        presentationWindowSwitch,
      })
    }
    return published || null
  }, [
    activeProjectId,
    hasUnsavedChanges,
    publishedDocument?.publishRevision,
    savedDocument,
  ])

  const saveStatusLabel = hasUnsavedChanges
    ? 'Unsaved edits'
    : savedDocument
      ? `Saved r${savedDocument.savedRevision}`
      : 'Not saved'
  const publishStatusLabel = publishedDocument
    ? `Published r${publishedDocument.publishRevision}`
    : 'Not published'
  const publishStateLabel = !publishedDocument
    ? 'Published: Not published'
    : publishIsOutdated
      ? 'Published: Outdated'
      : 'Published: Up to date'
  const activeProjectLabel = activeProjectMeta?.name || 'Untitled Project'
  const currentVerificationLineage = useMemo(() => ({
    projectId: activeProjectId || undefined,
    publishRevision: publishedDocument?.publishRevision || undefined,
    restartToken: publishedDocument?.restartToken || undefined,
    sceneId: publishedDocument?.runtimePayload?.selectedSceneId || undefined,
    timelineId: publishedDocument?.runtimePayload?.selectedTimelineId || undefined,
  }), [
    activeProjectId,
    publishedDocument?.publishRevision,
    publishedDocument?.restartToken,
    publishedDocument?.runtimePayload?.selectedSceneId,
    publishedDocument?.runtimePayload?.selectedTimelineId,
  ])

  const refreshVerificationReadout = useCallback(() => {
    const lineageMatch = getLatestVerificationArtifact(currentVerificationLineage)
    const projectRecent = getVerificationArtifactIndex({
      projectId: activeProjectId || undefined,
      limit: 6,
    })

    setLatestVerificationArtifact(lineageMatch || getLatestVerificationArtifact({ projectId: activeProjectId || undefined }) || null)
    setRecentVerificationRuns(projectRecent)
  }, [activeProjectId, currentVerificationLineage])

  useEffect(() => {
    refreshVerificationReadout()
  }, [refreshVerificationReadout])

  useEffect(() => subscribeVerificationArtifacts(() => {
    refreshVerificationReadout()
  }), [refreshVerificationReadout])

  const verificationStatusLabel = !latestVerificationArtifact
    ? 'Not run'
    : latestVerificationArtifact.pass
      ? 'Pass'
      : 'Fail'
  const verificationScenarioLabel = latestVerificationArtifact?.scenarioName || 'None'
  const verificationSampleCount = Number(latestVerificationArtifact?.sampleCount || latestVerificationArtifact?.samples?.length || 0)
  const verificationCreatedAtLabel = formatRuntimeTimestamp(latestVerificationArtifact?.createdAt)
  const verificationReportReadyLabel = latestVerificationArtifact ? 'Ready to export' : 'Not available'

  const handleTimelineClipSelected = useCallback((selection) => {
    setSelectedTimelineSelection(selection)
    if (selection?.region) {
      setCompositionRegionContext(selection.region)
    }
  }, [])

  const devLog = useCallback((event, detail = {}) => {
    console.info('[MistyOS][Studio]', {
      event,
      ...detail,
    })
  }, [])

  const handleRunVerificationCurrentTimeline = useCallback(async () => {
    if (verificationRunning) {
      return null
    }

    if (!resolvedVerificationScenario) {
      console.warn('[MistyOS][Verification] Selected scenario is not available on the current authored timeline.')
      return null
    }

    const previousTransportMode = transportModeRef.current
    const previousPlayheadSec = playheadRef.current

    setVerificationRunning(true)
    resetRuntimeSamples()
    setVerificationActive(true)

    try {
      const published = handlePublishToDesktop()
      if (!published) {
        console.warn('[MistyOS][Verification] Verification requires the existing Update Desktop path to succeed first.')
        return null
      }

      let runtimeSamples = []
      let assertionResults = []
      let verificationPass = false
      let verificationField = null

      if (resolvedVerificationScenario.kind === 'runtime-sample') {
        const captureStartTimeSec = resolvedVerificationScenario.captureStartTimeSec || 0
        const captureRegionId = resolvedVerificationScenario.runtimeScenario?.region || 'global'

        setTimelinePlayheadSec(captureStartTimeSec)
        resolvedVerificationScenario.probeTimesSec?.forEach((sampleTimeSec) => {
          sampleSchedulerAt(sampleTimeSec, { regionId: captureRegionId })
        })
        setTransportMode('playing')

        await waitMs(resolvedVerificationScenario.captureDurationMs)

        runtimeSamples = getRuntimeSamples()
        const verificationResult = runVerificationEngine(runtimeSamples, resolvedVerificationScenario.runtimeScenario)
        assertionResults = verificationResult.assertionResults
        verificationPass = verificationResult.pass
        verificationField = verificationResult.field
      } else {
        const lineageResult = evaluateLineageAssertions(resolvedVerificationScenario.lineageExpectations)
        assertionResults = lineageResult.assertionResults
        verificationPass = lineageResult.pass
      }

      const artifact = buildVerificationArtifactReport({
        projectId: activeProjectId,
        projectName: activeProjectMeta?.name || null,
        saveRevision: savedDocument?.savedRevision || 0,
        publishRevision: published.publishRevision || 0,
        restartToken: published.restartToken || null,
        sceneId: published.runtimePayload?.selectedSceneId || null,
        timelineId: published.runtimePayload?.selectedTimelineId || authoredTimeline?.id || null,
        publishedAt: published.publishedAt || null,
        runtimePayloadFingerprint: runtimePayloadFingerprint(published.runtimePayload || null),
        scenario: {
          ...resolvedVerificationScenario,
          runtimeScenario: {
            ...(resolvedVerificationScenario.runtimeScenario || {}),
            field: verificationField || resolvedVerificationScenario.runtimeScenario?.field || null,
          },
        },
        pass: verificationPass,
        assertionResults,
        runtimeSamples,
        authoredClips: editorClips,
        authoredTimeline,
      })

      const persistedArtifact = persistVerificationArtifact(artifact)
      setLatestVerificationArtifact(persistedArtifact)
      refreshVerificationReadout()

      console.info('[MistyOS][VerificationArtifact]', persistedArtifact)
      return persistedArtifact
    } catch (error) {
      console.error('[MistyOS][Verification] Run failed.', error)
      return null
    } finally {
      setVerificationActive(false)
      setTransportMode(previousTransportMode)
      setTimelinePlayheadSec(previousPlayheadSec)
      setVerificationRunning(false)
    }
  }, [
    activeProjectId,
    activeProjectMeta?.name,
    authoredTimeline,
    authoredTimeline?.id,
    editorClips,
    handlePublishToDesktop,
    refreshVerificationReadout,
    runtimePayloadFingerprint,
    resolvedVerificationScenario,
    sampleSchedulerAt,
    savedDocument?.savedRevision,
    verificationRunning,
  ])

  const handleRunVerificationAndExportReport = useCallback(async () => {
    const persistedArtifact = await handleRunVerificationCurrentTimeline()
    if (!persistedArtifact) {
      return
    }

    exportVerificationReport(persistedArtifact)
  }, [exportVerificationReport, handleRunVerificationCurrentTimeline])

  const handleRunFullVerificationSuite = useCallback(async () => {
    if (verificationRunning) {
      return null
    }

    const previousTransportMode = transportModeRef.current
    const previousPlayheadSec = playheadRef.current

    setVerificationRunning(true)
    setVerificationActive(true)

    try {
      const published = handlePublishToDesktop()
      if (!published) {
        console.warn('[MistyOS][Verification] Full suite requires publish to succeed.')
        return null
      }

      const suiteContext = {
        authoredTimeline,
        publishedDocument,
        activeSceneId,
        activeTimelineId,
      }

      const allScenarioIds = getVerificationScenarioRegistry().map((entry) => entry.id)
      const scenarioArtifacts = []

      for (const scenarioId of allScenarioIds) {
        const resolvedScenario = resolveVerificationScenario(scenarioId, suiteContext)
        if (!resolvedScenario) {
          console.info(`[MistyOS][Verification] Full suite: skipping unresolvable scenario: ${scenarioId}`)
          continue
        }

        resetRuntimeSamples()
        let runtimeSamples = []
        let assertionResults = []
        let verificationPass = false
        let verificationField = null

        if (resolvedScenario.kind === 'runtime-sample') {
          const captureStartTimeSec = resolvedScenario.captureStartTimeSec || 0
          const captureRegionId = resolvedScenario.runtimeScenario?.region || 'global'

          setTimelinePlayheadSec(captureStartTimeSec)
          resolvedScenario.probeTimesSec?.forEach((sampleTimeSec) => {
            sampleSchedulerAt(sampleTimeSec, { regionId: captureRegionId })
          })
          setTransportMode('playing')

          // eslint-disable-next-line no-await-in-loop
          await waitMs(resolvedScenario.captureDurationMs)

          runtimeSamples = getRuntimeSamples()
          const verificationResult = runVerificationEngine(runtimeSamples, resolvedScenario.runtimeScenario)
          assertionResults = verificationResult.assertionResults
          verificationPass = verificationResult.pass
          verificationField = verificationResult.field
        } else if (resolvedScenario.kind === 'lineage-check') {
          const lineageResult = evaluateLineageAssertions(resolvedScenario.lineageExpectations)
          assertionResults = lineageResult.assertionResults
          verificationPass = lineageResult.pass
        }

        const scenarioArtifact = buildVerificationArtifactReport({
          projectId: activeProjectId,
          projectName: activeProjectMeta?.name || null,
          saveRevision: savedDocument?.savedRevision || 0,
          publishRevision: published.publishRevision || 0,
          restartToken: published.restartToken || null,
          sceneId: published.runtimePayload?.selectedSceneId || null,
          timelineId: published.runtimePayload?.selectedTimelineId || authoredTimeline?.id || null,
          publishedAt: published.publishedAt || null,
          runtimePayloadFingerprint: runtimePayloadFingerprint(published.runtimePayload || null),
          scenario: {
            ...resolvedScenario,
            runtimeScenario: {
              ...(resolvedScenario.runtimeScenario || {}),
              field: verificationField || resolvedScenario.runtimeScenario?.field || null,
            },
          },
          pass: verificationPass,
          assertionResults,
          runtimeSamples,
          authoredClips: editorClips,
          authoredTimeline,
        })

        scenarioArtifacts.push(scenarioArtifact)
        console.info(`[MistyOS][Verification][Suite] ${resolvedScenario.scenarioName}: ${verificationPass ? 'PASS' : 'FAIL'}`)
      }

      if (scenarioArtifacts.length === 0) {
        console.warn('[MistyOS][Verification] Full suite produced no scenario results.')
        return null
      }

      const suiteArtifact = buildFullSuiteArtifactReport({
        projectId: activeProjectId,
        projectName: activeProjectMeta?.name || null,
        saveRevision: savedDocument?.savedRevision || 0,
        publishRevision: published.publishRevision || 0,
        restartToken: published.restartToken || null,
        sceneId: published.runtimePayload?.selectedSceneId || null,
        timelineId: published.runtimePayload?.selectedTimelineId || authoredTimeline?.id || null,
        publishedAt: published.publishedAt || null,
        runtimePayloadFingerprint: runtimePayloadFingerprint(published.runtimePayload || null),
        scenarioArtifacts,
      })

      const persistedSuiteArtifact = persistVerificationArtifact(suiteArtifact)
      setLatestVerificationArtifact(persistedSuiteArtifact)
      refreshVerificationReadout()

      console.info('[MistyOS][VerificationSuite]', persistedSuiteArtifact)
      return persistedSuiteArtifact
    } catch (error) {
      console.error('[MistyOS][Verification] Full suite run failed.', error)
      return null
    } finally {
      setVerificationActive(false)
      setTransportMode(previousTransportMode)
      setTimelinePlayheadSec(previousPlayheadSec)
      setVerificationRunning(false)
    }
  }, [
    activeProjectId,
    activeProjectMeta?.name,
    activeSceneId,
    activeTimelineId,
    authoredTimeline,
    editorClips,
    handlePublishToDesktop,
    publishedDocument,
    refreshVerificationReadout,
    runtimePayloadFingerprint,
    sampleSchedulerAt,
    savedDocument?.savedRevision,
    verificationRunning,
  ])

  const handleRunFullVerificationSuiteAndExportReport = useCallback(async () => {
    const persistedSuiteArtifact = await handleRunFullVerificationSuite()
    if (!persistedSuiteArtifact) {
      return
    }

    exportVerificationReport(persistedSuiteArtifact)
  }, [exportVerificationReport, handleRunFullVerificationSuite])

  const selectClipById = useCallback((clipId) => {
    const clip = editorClips.find((item) => item.id === clipId)
    if (!clip) {
      return
    }
    setSelectedTimelineSelection({
      clipId: clip.id,
      clip,
      trackKind: clip.trackKind,
      region: clip.region,
      intentKind: clip.intentKind,
    })
    setCompositionRegionContext(clip.region || 'global')
  }, [editorClips])

  const handleCompositionRegionFocus = useCallback((regionId) => {
    const nextRegion = REGION_IDS.includes(regionId) ? regionId : 'global'
    setActiveWorkspaceTab('composition')
    setCompositionRegionContext(nextRegion)
    if (selectedTimelineSelection?.clipId) {
      const clipId = selectedTimelineSelection.clipId
      setEditorClips((prev) => prev.map((clip) => (
        clip.id === clipId ? { ...clip, region: nextRegion } : clip
      )))
    }
  }, [selectedTimelineSelection?.clipId])

  const updateSelectedClip = useCallback((patch) => {
    const clipId = selectedTimelineSelection?.clipId
    if (!clipId) {
      return
    }
    setEditorClips((prev) => prev.map((clip) => (
      clip.id === clipId ? { ...clip, ...patch } : clip
    )))
    if (patch?.region) {
      setCompositionRegionContext(patch.region)
    }
  }, [selectedTimelineSelection?.clipId])

  const updateSelectedClipDuration = useCallback((durationSec) => {
    const clipId = selectedTimelineSelection?.clipId
    if (!clipId) {
      return
    }
    setEditorClips((prev) => prev.map((clip) => {
      if (clip.id !== clipId) {
        return clip
      }
      const safeDuration = clamp(durationSec, 1, (selectedTimeline?.duration?.seconds || 180) - clip.startSec)
      return {
        ...clip,
        endSec: clip.startSec + safeDuration,
      }
    }))
  }, [selectedTimelineSelection?.clipId, selectedTimeline?.duration?.seconds])

  const setValidationField = useCallback((field, value) => {
    setValidationDraft((prev) => ({
      ...prev,
      [field]: value,
    }))
  }, [])

  const appendValidationClip = useCallback((trackKind, partial) => {
    setEditorClips((prev) => ([
      ...prev,
      createDefaultClip(trackKind, partial, timelineDurationSec),
    ]))
  }, [timelineDurationSec])

  const addValidationWindRamp = useCallback(() => {
    appendValidationClip('wind', {
      id: `validation-wind-${Date.now()}`,
      startSec: validationDraft.windStartSec,
      endSec: validationDraft.windStartSec + validationDraft.windDurationSec,
      intensity: validationDraft.windIntensity,
      blendInSec: validationDraft.windBlendInSec,
      blendOutSec: validationDraft.windBlendOutSec,
      region: 'global',
    })
  }, [appendValidationClip, validationDraft])

  const addValidationRegionalMist = useCallback(() => {
    appendValidationClip('mist', {
      id: `validation-mist-${Date.now()}`,
      startSec: validationDraft.regionStartSec,
      endSec: validationDraft.regionStartSec + validationDraft.regionDurationSec,
      intensity: validationDraft.regionIntensity,
      blendInSec: 5,
      blendOutSec: 5,
      region: validationDraft.regionTarget,
    })
  }, [appendValidationClip, validationDraft])

  const addValidationClockReveal = useCallback(() => {
    appendValidationClip('intent', {
      id: `validation-clock-reveal-${Date.now()}`,
      intentKind: 'clock-reveal',
      startSec: validationDraft.intentStartSec,
      endSec: validationDraft.intentStartSec + validationDraft.intentDurationSec,
      region: validationDraft.intentRegion,
      leadInBehavior: 'soft-ramp',
      payload: {
        leadInSec: validationDraft.intentLeadInSec,
        revealStyle: validationDraft.revealStyle,
        recoveryStyle: validationDraft.recoveryStyle,
      },
    })
  }, [appendValidationClip, validationDraft])

  const regionInfluenceDiagnostics = useMemo(() => {
    const sampleSec = schedulerSnapshot.sampleSec || 0
    if (!runtimeScheduler?.sample) {
      return []
    }
    return ['q1', 'q2', 'q3', 'q4'].map((regionId) => {
      let sample
      try {
        sample = runtimeScheduler.sample({
          elapsedSec: sampleSec,
          fps: 60,
          uv: getSampleUvForRegion(regionId),
          includeDiagnostics: true,
        })
      } catch (error) {
        console.error(`[Studio] Spatial influence sample failed for ${regionId}.`, error)
        sample = {
          weather: {
            wind: 0,
            rain: 0,
            mist: 0,
            washdown: 0,
            fogBuildup: 0,
            fogClearing: 0,
          },
          diagnostics: null,
        }
      }
      return {
        regionId,
        weather: sample.weather,
        diagnostics: sample.diagnostics,
      }
    })
  }, [runtimeScheduler, schedulerSnapshot.sampleSec])

  const selectedClipTrackSample = useMemo(() => {
    if (!selectedClip || selectedClip.trackKind === 'intent') {
      return null
    }
    const contributions = schedulerSnapshot.diagnostics?.weatherTrackContributions || []
    const selectedClipId = selectedClip.id

    if (typeof selectedClipId === 'string' && selectedClipId.length > 0) {
      const lineageMatch = contributions.find(
        (item) => Array.isArray(item.sourceClipIds) && item.sourceClipIds.includes(selectedClipId),
      )
      if (lineageMatch) {
        return lineageMatch
      }
    }

    return contributions.find(
      (item) => item.kind === selectedClip.trackKind && (item.region || 'global') === (selectedClip.region || 'global'),
    ) || null
  }, [schedulerSnapshot.diagnostics?.weatherTrackContributions, selectedClip])

  const selectedIntentSample = useMemo(() => {
    if (!selectedClip || selectedClip.trackKind !== 'intent') {
      return null
    }
    return schedulerSnapshot.diagnostics?.intentContributions?.find((item) => item.id === selectedClip.id) || null
  }, [schedulerSnapshot.diagnostics?.intentContributions, selectedClip])

  const selectedCompiledTrack = useMemo(() => {
    if (!selectedClip || selectedClip.trackKind === 'intent') {
      return null
    }
    return authoredTimeline.weatherTracks.find(
      (track) => track.kind === selectedClip.trackKind && (track.region || 'global') === (selectedClip.region || 'global'),
    ) || null
  }, [authoredTimeline.weatherTracks, selectedClip])

  const mediaAssets = useMemo(() => {
    const bySrc = new Map()
    sceneCatalog.forEach((scene) => {
      const src = scene.background?.src
      if (src && !bySrc.has(src)) {
        bySrc.set(src, {
          id: src,
          name: scene.background?.label || src.split('/').pop() || src,
        })
      }
    })
    return Array.from(bySrc.values())
  }, [])

  const normalizedAssetQuery = assetQuery.trim().toLowerCase()
  const filteredScenes = useMemo(
    () => sceneCatalog.filter((scene) => {
      if (!normalizedAssetQuery) {
        return true
      }
      return `${scene.name} ${scene.id}`.toLowerCase().includes(normalizedAssetQuery)
    }),
    [normalizedAssetQuery],
  )
  const filteredMediaAssets = useMemo(
    () => mediaAssets.filter((media) => {
      if (!normalizedAssetQuery) {
        return true
      }
      return `${media.name} ${media.id}`.toLowerCase().includes(normalizedAssetQuery)
    }),
    [mediaAssets, normalizedAssetQuery],
  )
  const filteredPresets = useMemo(
    () => presetCatalog.filter((preset) => {
      if (!normalizedAssetQuery) {
        return true
      }
      return `${preset.name} ${preset.id}`.toLowerCase().includes(normalizedAssetQuery)
    }),
    [normalizedAssetQuery],
  )
  const filteredTimelines = useMemo(
    () => timelineCatalog.filter((timeline) => {
      if (!normalizedAssetQuery) {
        return true
      }
      return `${timeline.name} ${timeline.id}`.toLowerCase().includes(normalizedAssetQuery)
    }),
    [normalizedAssetQuery],
  )

  const totalAssetCount = filteredScenes.length + filteredMediaAssets.length + filteredPresets.length + filteredTimelines.length

  const timing = previewStats.timing || {}
  const selectedClipRegion = activeAuthoringRegion
  const selectedClipSpanStyle = selectedClip
    ? {
      left: `${clamp((selectedClip.startSec / timelineDurationSec) * 100, 0, 100)}%`,
      width: `${clamp(((selectedClip.endSec - selectedClip.startSec) / timelineDurationSec) * 100, 0.5, 100)}%`,
    }
    : null

  const workspaceStyle = {
    '--studio-left-width': `${panelState.left ? layoutBounds.collapsedSidePanelWidth : workspaceLayout.leftWidth}px`,
    '--studio-right-width': `${panelState.right ? layoutBounds.collapsedSidePanelWidth : workspaceLayout.rightWidth}px`,
    '--studio-bottom-height': `${panelState.bottom ? layoutBounds.collapsedTimelineHeight : workspaceLayout.bottomHeight}px`,
    '--studio-ui-scale': workspaceLayout.uiScale,
    '--studio-density-scale': workspaceLayout.density === 'compact' ? 0.92 : 1,
    '--studio-font-size': `${workspaceLayout.uiFontPx}px`,
    '--studio-menubar-height': `${Math.round(32 * workspaceLayout.uiScale)}px`,
    '--studio-footer-height': `${Math.round(36 * workspaceLayout.uiScale)}px`,
    '--studio-control-min-height': `${Math.round(28 * workspaceLayout.uiScale)}px`,
  }
  const uiFontIndex = getFontStepIndex(workspaceLayout.uiFontPx)

  const applyLayoutPreset = (presetId) => {
    const preset = LAYOUT_PRESETS[presetId]
    if (!preset) {
      return
    }
    updateWorkspaceLayout(preset, true)
  }

  const resetWorkspaceLayout = () => {
    restoreAllPanels()
    updateWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, true)
  }

  const resetStudioDefaults = () => {
    setSettings(saveStudioSettings(getStudioDefaultSettings()))
  }

  const setMenuTriggerRef = useCallback((menuId, element) => {
    if (!menuId) {
      return
    }
    if (element) {
      menuTriggerRefs.current[menuId] = element
      return
    }
    delete menuTriggerRefs.current[menuId]
  }, [])

  const computeMenuDropdownStyle = useCallback((menuId) => {
    const trigger = menuTriggerRefs.current[menuId]
    if (!trigger) {
      return null
    }

    const rect = trigger.getBoundingClientRect()
    const viewportPadding = 8
    const estimatedWidth = menuId === 'view' ? 420 : 300
    const maxLeft = Math.max(viewportPadding, window.innerWidth - estimatedWidth - viewportPadding)
    const left = Math.min(Math.max(viewportPadding, Math.round(rect.left)), maxLeft)

    return {
      top: `${Math.round(rect.bottom + 4)}px`,
      left: `${left}px`,
    }
  }, [])

  const clearMenuCloseTimer = useCallback(() => {
    if (menuCloseTimerRef.current) {
      window.clearTimeout(menuCloseTimerRef.current)
      menuCloseTimerRef.current = null
    }
  }, [])

  const closeMenu = useCallback((restoreFocus = true) => {
    clearMenuCloseTimer()
    setMenuOpen(null)
    setMenuKeyboardActive(false)
    setMenuKeyboardSection('cascade')
    setMenuKeyboardIndex(0)

    if (!restoreFocus) {
      return
    }

    const previousElement = menuRestoreFocusRef.current
    if (previousElement instanceof HTMLElement && document.contains(previousElement)) {
      previousElement.focus()
    }
    menuRestoreFocusRef.current = null
  }, [clearMenuCloseTimer])

  const openMenu = useCallback((menuId, options = {}) => {
    if (!STUDIO_MENU_ORDER.includes(menuId)) {
      return
    }

    const keyboard = options.keyboard === true
    const preserveAnchor = options.preserveAnchor === true

    if (!menuOpen) {
      const activeElement = document.activeElement
      if (activeElement instanceof HTMLElement) {
        menuRestoreFocusRef.current = activeElement
      }
    }

    clearMenuCloseTimer()
    setMenuOpen(menuId)
    if (!preserveAnchor) {
      setMenuKeyboardSection('cascade')
      setMenuKeyboardIndex(0)
      menuKeyboardAnchorRef.current = { section: 'cascade', index: 0 }
    }
    if (keyboard) {
      setMenuKeyboardActive(true)
    }
  }, [clearMenuCloseTimer, menuOpen])

  const handleMenuRegionMouseEnter = useCallback(() => {
    clearMenuCloseTimer()
  }, [clearMenuCloseTimer])

  const handleMenuRegionMouseLeave = useCallback(() => {
    clearMenuCloseTimer()
  }, [clearMenuCloseTimer])

  const toggleMenu = useCallback((menuId) => {
    if (!STUDIO_MENU_ORDER.includes(menuId)) {
      return
    }
    clearMenuCloseTimer()
    setMenuOpen((previous) => {
      if (previous === menuId) {
        setMenuKeyboardActive(false)
        setMenuKeyboardSection('cascade')
        setMenuKeyboardIndex(0)
        const previousElement = menuRestoreFocusRef.current
        if (previousElement instanceof HTMLElement && document.contains(previousElement)) {
          previousElement.focus()
        }
        menuRestoreFocusRef.current = null
        return null
      }

      if (!previous) {
        const activeElement = document.activeElement
        if (activeElement instanceof HTMLElement) {
          menuRestoreFocusRef.current = activeElement
        }
      }

      setMenuKeyboardSection('cascade')
      setMenuKeyboardIndex(0)
      menuKeyboardAnchorRef.current = { section: 'cascade', index: 0 }
      return menuId
    })
  }, [clearMenuCloseTimer])

  const handleMenuTriggerMouseEnter = useCallback((menuId) => {
    clearMenuCloseTimer()
    if (!menuOpen || menuOpen === menuId) {
      return
    }
    openMenu(menuId, { preserveAnchor: true })
  }, [clearMenuCloseTimer, menuOpen, openMenu])

  const commandRegistry = useMemo(() => {
    const startupCommands = Object.values(STARTUP_MODES).reduce((accumulator, mode) => {
      accumulator[`file.startupMode.${mode}`] = {
        id: `file.startupMode.${mode}`,
        label: () => `Startup Mode: ${mode}`,
        type: 'radio',
        checked: () => settings.startupMode === mode,
        run: () => updateSettings((prev) => ({ ...prev, startupMode: mode })),
      }
      return accumulator
    }, {})

    const fontCommands = UI_FONT_STEPS.reduce((accumulator, fontStep) => {
      accumulator[`view.ui.font.${fontStep}`] = {
        id: `view.ui.font.${fontStep}`,
        label: () => `Font Size: ${fontStep}px`,
        type: 'radio',
        checked: () => workspaceLayout.uiFontPx === fontStep,
        run: () => setUiFontSize(fontStep),
      }
      return accumulator
    }, {})

    const projectSwitchCommands = projectRegistry.projects.reduce((accumulator, project) => {
      const commandId = `file.project.switch.${project.projectId}`
      accumulator[commandId] = {
        id: commandId,
        label: () => `Switch to ${project.name}`,
        type: 'radio',
        checked: () => activeProjectId === project.projectId,
        run: () => handleSwitchProject(project.projectId),
      }
      return accumulator
    }, {})

    return {
      [WORKFLOW_COMMAND_IDS.save]: {
        id: WORKFLOW_COMMAND_IDS.save,
        label: () => (hasUnsavedChanges ? 'Save' : 'Save (Up to Date)'),
        mnemonic: 'S',
        accelerator: 'Ctrl+S',
        role: 'action',
        run: handleSaveAuthoringState,
      },
      [WORKFLOW_COMMAND_IDS.saveAs]: {
        id: WORKFLOW_COMMAND_IDS.saveAs,
        label: 'Save As',
        mnemonic: 'A',
        accelerator: 'Ctrl+Shift+S',
        role: 'action',
        run: () => handleCreateProjectFromCurrent({
          suggestedName: `${activeProjectMeta?.name || 'Project'} Copy`,
        }),
      },
      [WORKFLOW_COMMAND_IDS.revertToSaved]: {
        id: WORKFLOW_COMMAND_IDS.revertToSaved,
        label: 'Revert to Saved',
        mnemonic: 'R',
        accelerator: 'Ctrl+Alt+R',
        role: 'destructive',
        type: 'destructive',
        enabled: () => Boolean(savedDocument) && hasUnsavedChanges,
        run: revertToSavedPayload,
      },
      [WORKFLOW_COMMAND_IDS.updateDesktop]: {
        id: WORKFLOW_COMMAND_IDS.updateDesktop,
        label: () => (publishIsOutdated ? 'Update Desktop' : 'Update Desktop (Republish)'),
        mnemonic: 'U',
        accelerator: 'Ctrl+Shift+P',
        role: 'action',
        enabled: () => Boolean(savedDocument) && !hasUnsavedChanges,
        run: handlePublishToDesktop,
      },
      [WORKFLOW_COMMAND_IDS.importProject]: {
        id: WORKFLOW_COMMAND_IDS.importProject,
        label: 'Import Project',
        mnemonic: 'I',
        accelerator: 'Ctrl+Shift+O',
        role: 'action',
        run: triggerProjectImport,
      },
      [WORKFLOW_COMMAND_IDS.exportAuthoringState]: {
        id: WORKFLOW_COMMAND_IDS.exportAuthoringState,
        label: 'Export Authoring State',
        mnemonic: 'E',
        accelerator: 'Ctrl+Shift+E',
        role: 'action',
        run: exportAuthoringState,
      },
      [WORKFLOW_COMMAND_IDS.exportRuntimePayload]: {
        id: WORKFLOW_COMMAND_IDS.exportRuntimePayload,
        label: 'Export Runtime Payload',
        mnemonic: 'P',
        role: 'action',
        run: exportRuntimePayload,
      },
      'file.saveAuthoring': {
        id: 'file.saveAuthoring',
        label: () => (hasUnsavedChanges ? 'Save Authoring State' : 'Save Authoring State (up to date)'),
        accelerator: 'Ctrl+S',
        role: 'action',
        run: handleSaveAuthoringState,
      },
      'file.project.new': {
        id: 'file.project.new',
        label: 'New Project from Current State',
        role: 'action',
        run: handleCreateBlankProject,
      },
      'file.publishDesktop': {
        id: 'file.publishDesktop',
        label: () => (publishIsOutdated ? 'Update Desktop (Publish)' : 'Update Desktop (Republish)'),
        accelerator: 'Ctrl+Shift+P',
        role: 'action',
        enabled: () => Boolean(savedDocument) && !hasUnsavedChanges,
        run: handlePublishToDesktop,
      },
      'file.exportStudioJson': { id: 'file.exportStudioJson', label: 'Export Studio JSON', role: 'action', run: exportStudioConfig },
      'file.exportTuningJson': { id: 'file.exportTuningJson', label: 'Export Tuning JSON', role: 'action', run: exportTuningConfig },
      'file.resetLayout': { id: 'file.resetLayout', label: 'Reset Studio Layout', role: 'destructive', type: 'destructive', run: resetWorkspaceLayout },
      'file.resetDefaults': { id: 'file.resetDefaults', label: 'Reset Studio Defaults', role: 'destructive', type: 'destructive', run: resetStudioDefaults },
      ...startupCommands,
      'edit.revertTimeline': {
        id: 'edit.revertTimeline',
        label: 'Revert Timeline to Preset',
        role: 'destructive',
        type: 'destructive',
        enabled: () => Boolean(selectedTimeline),
        run: () => setEditorClips(parseTimelineToClips(selectedTimeline)),
      },
      'edit.resetWorkspaceLayout': { id: 'edit.resetWorkspaceLayout', label: 'Reset Workspace Layout', role: 'destructive', type: 'destructive', run: resetWorkspaceLayout },
      'view.previewMode.contain': {
        id: 'view.previewMode.contain',
        label: 'Preview Mode: Contain',
        type: 'radio',
        checked: () => workspaceLayout.previewMode === 'contain',
        run: () => updateWorkspaceLayout({ previewMode: 'contain' }, true),
      },
      'view.previewMode.fill': {
        id: 'view.previewMode.fill',
        label: 'Preview Mode: Fill',
        type: 'radio',
        checked: () => workspaceLayout.previewMode === 'fill',
        run: () => updateWorkspaceLayout({ previewMode: 'fill' }, true),
      },
      'view.previewMode.native': {
        id: 'view.previewMode.native',
        label: 'Preview Mode: Native',
        type: 'radio',
        checked: () => workspaceLayout.previewMode === 'native',
        run: () => updateWorkspaceLayout({ previewMode: 'native' }, true),
      },
      'view.previewMode.zoom': {
        id: 'view.previewMode.zoom',
        label: 'Preview Mode: Zoom',
        type: 'radio',
        checked: () => workspaceLayout.previewMode === 'zoom',
        run: () => updateWorkspaceLayout({
          previewMode: 'zoom',
          previewZoom: workspaceLayout.previewMode === 'zoom' ? workspaceLayout.previewZoom : 1,
        }, true),
      },
      'view.sceneGrid': {
        id: 'view.sceneGrid',
        label: () => (workspaceLayout.showSceneGrid ? 'Hide Grid' : 'Show Grid'),
        type: 'checkbox',
        checked: () => workspaceLayout.showSceneGrid,
        run: () => updateWorkspaceLayout({ showSceneGrid: !workspaceLayout.showSceneGrid }, true),
      },
      'view.diagnosticsOverlay': {
        id: 'view.diagnosticsOverlay',
        label: () => (workspaceLayout.showDiagnosticsOverlay ? 'Hide Diagnostics Overlay' : 'Show Diagnostics Overlay'),
        type: 'checkbox',
        checked: () => workspaceLayout.showDiagnosticsOverlay,
        run: () => updateWorkspaceLayout({ showDiagnosticsOverlay: !workspaceLayout.showDiagnosticsOverlay }, true),
      },
      'view.compositionGuides': {
        id: 'view.compositionGuides',
        label: () => (workspaceLayout.showCompositionGuides ? 'Hide Composition Guides' : 'Show Composition Guides'),
        type: 'checkbox',
        checked: () => workspaceLayout.showCompositionGuides,
        run: () => {
          setActiveWorkspaceTab('composition')
          updateWorkspaceLayout({ showCompositionGuides: !workspaceLayout.showCompositionGuides }, true)
        },
      },
      'view.previewDevPanel': {
        id: 'view.previewDevPanel',
        label: () => (workspaceLayout.showPreviewDevReadout ? 'Disable Preview Dev Panel' : 'Enable Preview Dev Panel'),
        type: 'checkbox',
        checked: () => workspaceLayout.showPreviewDevReadout,
        run: () => updateWorkspaceLayout({ showPreviewDevReadout: !workspaceLayout.showPreviewDevReadout }, true),
      },
      'view.panels.left': {
        id: 'view.panels.left',
        label: () => (panelState.left ? 'Show Assets' : 'Collapse Assets'),
        type: 'checkbox',
        checked: () => !panelState.left,
        run: () => togglePanelFromMenu('left'),
      },
      'view.panels.center': {
        id: 'view.panels.center',
        label: () => (panelState.center ? 'Show Scene Preview' : 'Collapse Scene Preview'),
        type: 'checkbox',
        checked: () => !panelState.center,
        run: () => togglePanelFromMenu('center'),
      },
      'view.panels.right': {
        id: 'view.panels.right',
        label: () => (panelState.right ? 'Show Inspector' : 'Collapse Inspector'),
        type: 'checkbox',
        checked: () => !panelState.right,
        run: () => togglePanelFromMenu('right'),
      },
      'view.panels.bottom': {
        id: 'view.panels.bottom',
        label: () => (panelState.bottom ? 'Show Timeline' : 'Collapse Timeline'),
        type: 'checkbox',
        checked: () => !panelState.bottom,
        run: () => togglePanelFromMenu('bottom'),
      },
      'view.panels.utility': {
        id: 'view.panels.utility',
        label: () => (workspaceLayout.utilityPanelOpen ? 'Hide Advanced Tuning' : 'Show Advanced Tuning'),
        type: 'checkbox',
        checked: () => workspaceLayout.utilityPanelOpen,
        run: () => updateWorkspaceLayout({ utilityPanelOpen: !workspaceLayout.utilityPanelOpen }, true),
      },
      'view.panels.restoreAll': {
        id: 'view.panels.restoreAll',
        label: 'Restore All Panels',
        run: restoreAllPanels,
      },
      'view.timeline.eventLabels.compact': {
        id: 'view.timeline.eventLabels.compact',
        label: 'Event Labels: Compact',
        type: 'radio',
        checked: () => workspaceLayout.timelineEventLabels === 'compact',
        run: () => updateWorkspaceLayout({ timelineEventLabels: 'compact' }, true),
      },
      'view.timeline.eventLabels.full': {
        id: 'view.timeline.eventLabels.full',
        label: 'Event Labels: Full',
        type: 'radio',
        checked: () => workspaceLayout.timelineEventLabels === 'full',
        run: () => updateWorkspaceLayout({ timelineEventLabels: 'full' }, true),
      },
      'view.timeline.fitToWindow': {
        id: 'view.timeline.fitToWindow',
        label: () => (workspaceLayout.timelineFitToWindow ? 'Disable Fit to Window' : 'Enable Fit to Window'),
        type: 'checkbox',
        checked: () => workspaceLayout.timelineFitToWindow,
        run: () => updateWorkspaceLayout({ timelineFitToWindow: !workspaceLayout.timelineFitToWindow }, true),
      },
      'view.timeline.snap.1': {
        id: 'view.timeline.snap.1',
        label: 'Snap: 1s',
        type: 'radio',
        checked: () => workspaceLayout.timelineSnapSeconds === 1,
        run: () => updateWorkspaceLayout({ timelineSnapSeconds: 1 }, true),
      },
      'view.timeline.snap.5': {
        id: 'view.timeline.snap.5',
        label: 'Snap: 5s',
        type: 'radio',
        checked: () => workspaceLayout.timelineSnapSeconds === 5,
        run: () => updateWorkspaceLayout({ timelineSnapSeconds: 5 }, true),
      },
      'view.timeline.snap.10': {
        id: 'view.timeline.snap.10',
        label: 'Snap: 10s',
        type: 'radio',
        checked: () => workspaceLayout.timelineSnapSeconds === 10,
        run: () => updateWorkspaceLayout({ timelineSnapSeconds: 10 }, true),
      },
      'view.assets.cards.compact': {
        id: 'view.assets.cards.compact',
        label: 'Asset Cards: Compact',
        type: 'radio',
        checked: () => workspaceLayout.assetCardSize === 'compact',
        run: () => updateWorkspaceLayout({ assetCardSize: 'compact' }, true),
      },
      'view.assets.cards.large': {
        id: 'view.assets.cards.large',
        label: 'Asset Cards: Large',
        type: 'radio',
        checked: () => workspaceLayout.assetCardSize === 'large',
        run: () => updateWorkspaceLayout({ assetCardSize: 'large' }, true),
      },
      'view.ui.density': {
        id: 'view.ui.density',
        label: () => `Density: ${workspaceLayout.density === 'compact' ? 'Compact' : 'Comfortable'}`,
        run: () => updateWorkspaceLayout({ density: workspaceLayout.density === 'compact' ? 'comfortable' : 'compact' }, true),
      },
      ...fontCommands,
      'view.workspace.resetLayout': { id: 'view.workspace.resetLayout', label: 'Reset Layout', run: resetWorkspaceLayout },
      'layout.preset.editing': { id: 'layout.preset.editing', label: 'Preset: Editing', run: () => applyLayoutPreset('editing') },
      'layout.preset.review': { id: 'layout.preset.review', label: 'Preset: Review', run: () => applyLayoutPreset('review') },
      'layout.preset.focus': { id: 'layout.preset.focus', label: 'Preset: Focus', run: () => applyLayoutPreset('focus') },
      'layout.workspace.reset': { id: 'layout.workspace.reset', label: 'Reset Layout', run: resetWorkspaceLayout },
      'tools.openDiagnostics': { id: 'tools.openDiagnostics', label: 'Open Diagnostics', run: () => setActiveWorkspaceTab('diagnostics') },
      'tools.openSpatialDiagnostics': { id: 'tools.openSpatialDiagnostics', label: 'Open Spatial Diagnostics', run: () => setActiveWorkspaceTab('spatial') },
      'tools.openWeatherOverlay': { id: 'tools.openWeatherOverlay', label: 'Open Weather Overlay', run: () => setActiveWorkspaceTab('weather') },
      [VERIFICATION_COMMAND_IDS.run]: {
        id: VERIFICATION_COMMAND_IDS.run,
        label: () => verificationRunning
          ? 'Running Verification...'
          : 'Run Verification',
        enabled: () => !verificationRunning && !hasUnsavedChanges && Boolean(savedDocument) && Boolean(resolvedVerificationScenario),
        run: () => {
          void handleRunVerificationCurrentTimeline()
        },
      },
      [VERIFICATION_COMMAND_IDS.exportLatestReport]: {
        id: VERIFICATION_COMMAND_IDS.exportLatestReport,
        label: 'Export Latest Verification Report',
        enabled: () => Boolean(latestVerificationArtifact),
        run: exportLatestVerificationReport,
      },
      [VERIFICATION_COMMAND_IDS.runAndExport]: {
        id: VERIFICATION_COMMAND_IDS.runAndExport,
        label: () => verificationRunning
          ? 'Running Verification + Exporting Report...'
          : 'Run Verification + Export Report',
        enabled: () => !verificationRunning && !hasUnsavedChanges && Boolean(savedDocument) && Boolean(resolvedVerificationScenario),
        run: () => {
          void handleRunVerificationAndExportReport()
        },
      },
      [VERIFICATION_COMMAND_IDS.runFullSuite]: {
        id: VERIFICATION_COMMAND_IDS.runFullSuite,
        label: () => verificationRunning
          ? 'Running Full Verification Suite + Exporting Report...'
          : 'Run Full Verification Suite + Export Report',
        enabled: () => !verificationRunning && !hasUnsavedChanges && Boolean(savedDocument),
        run: () => {
          void handleRunFullVerificationSuiteAndExportReport()
        },
      },
      'tools.runVerificationCurrentTimeline': {
        id: 'tools.runVerificationCurrentTimeline',
        label: () => verificationRunning
          ? 'Running Verification...'
          : 'Run Verification',
        enabled: () => !verificationRunning && !hasUnsavedChanges && Boolean(savedDocument) && Boolean(resolvedVerificationScenario),
        run: () => {
          void handleRunVerificationCurrentTimeline()
        },
      },
      'tools.exportLatestVerificationArtifact': {
        id: 'tools.exportLatestVerificationArtifact',
        label: 'Export Latest Verification Report',
        enabled: () => Boolean(latestVerificationArtifact),
        run: exportLatestVerificationReport,
      },
      'tools.copyLatestVerificationArtifact': {
        id: 'tools.copyLatestVerificationArtifact',
        label: 'Copy Latest Verification Report JSON',
        enabled: () => Boolean(latestVerificationArtifact),
        run: () => {
          void copyLatestVerificationArtifact()
        },
      },
      'help.openScenePreview': { id: 'help.openScenePreview', label: 'Open Scene Preview', run: () => setActiveWorkspaceTab('preview') },
      'help.showAdvancedTuning': {
        id: 'help.showAdvancedTuning',
        label: 'Show Advanced Tuning Panel',
        run: () => updateWorkspaceLayout({ utilityPanelOpen: true }, true),
      },
      'workspace.tab.preview': { id: 'workspace.tab.preview', label: 'Open preview workspace', run: () => setActiveWorkspaceTab('preview') },
      'workspace.tab.composition': { id: 'workspace.tab.composition', label: 'Open composition workspace', run: () => setActiveWorkspaceTab('composition') },
      'workspace.tab.spatial': { id: 'workspace.tab.spatial', label: 'Open spatial workspace', run: () => setActiveWorkspaceTab('spatial') },
      'workspace.tab.diagnostics': { id: 'workspace.tab.diagnostics', label: 'Open diagnostics workspace', run: () => setActiveWorkspaceTab('diagnostics') },
      'workspace.tab.weather': { id: 'workspace.tab.weather', label: 'Open weather workspace', run: () => setActiveWorkspaceTab('weather') },
      'transport.play': { id: 'transport.play', label: 'Play timeline', run: handleTransportPlay },
      'transport.stop': { id: 'transport.stop', label: 'Stop timeline', run: handleTransportStop },
      'workspace.utility.toggle': {
        id: 'workspace.utility.toggle',
        label: () => (workspaceLayout.utilityPanelOpen ? 'Hide advanced tuning panel' : 'Show advanced tuning panel'),
        type: 'checkbox',
        checked: () => workspaceLayout.utilityPanelOpen,
        run: () => updateWorkspaceLayout({ utilityPanelOpen: !workspaceLayout.utilityPanelOpen }, true),
      },
      ...projectSwitchCommands,
    }
  }, [
    activeProjectId,
    activeProjectMeta?.name,
    applyLayoutPreset,
    exportAuthoringState,
    exportRuntimePayload,
    exportStudioConfig,
    exportTuningConfig,
    handleCreateBlankProject,
    handleCreateProjectFromCurrent,
    handlePublishToDesktop,
    handleSaveAuthoringState,
    handleSwitchProject,
    handleTransportPlay,
    handleTransportStop,
    hasUnsavedChanges,
    panelState.bottom,
    panelState.center,
    panelState.left,
    panelState.right,
    publishIsOutdated,
    resetStudioDefaults,
    resetWorkspaceLayout,
    revertToSavedPayload,
    restoreAllPanels,
    projectRegistry.projects,
    selectedTimeline,
    setUiFontSize,
    settings.startupMode,
    togglePanelFromMenu,
    triggerProjectImport,
    updateSettings,
    updateWorkspaceLayout,
    workspaceLayout.assetCardSize,
    workspaceLayout.density,
    workspaceLayout.previewMode,
    workspaceLayout.previewZoom,
    workspaceLayout.showCompositionGuides,
    workspaceLayout.showDiagnosticsOverlay,
    workspaceLayout.showPreviewDevReadout,
    workspaceLayout.showSceneGrid,
    workspaceLayout.timelineEventLabels,
    workspaceLayout.timelineFitToWindow,
    workspaceLayout.timelineSnapSeconds,
    workspaceLayout.uiFontPx,
    workspaceLayout.utilityPanelOpen,
    copyLatestVerificationArtifact,
    exportLatestVerificationReport,
    handleRunFullVerificationSuiteAndExportReport,
    handleRunVerificationAndExportReport,
    handleRunVerificationCurrentTimeline,
    latestVerificationArtifact,
    resolvedVerificationScenario,
    verificationRunning,
    savedDocument,
  ])

  const resolveCommand = useCallback((commandId) => {
    const command = commandRegistry[commandId]
    if (!command) {
      return null
    }

    const label = typeof command.label === 'function' ? command.label() : command.label
    const enabled = command.enabled ? Boolean(command.enabled()) : true
    const checked = command.checked ? Boolean(command.checked()) : false

    return {
      ...command,
      label,
      enabled,
      checked,
      commandRole: command.role || command.type || 'action',
      mnemonic: command.mnemonic || null,
      destructive: command.type === 'destructive' || command.role === 'destructive' || command.destructive === true,
    }
  }, [commandRegistry])

  const executeCommand = useCallback((commandId, options = {}) => {
    const command = resolveCommand(commandId)
    if (!command || !command.enabled || typeof command.run !== 'function') {
      return
    }

    command.run()
    if (options.closeMenu !== false) {
      closeMenu(options.restoreFocus ?? false)
    }
  }, [closeMenu, resolveCommand])

  const invokeCommandButton = useCallback((commandId) => {
    executeCommand(commandId, { closeMenu: true, restoreFocus: true })
  }, [executeCommand])

  const getMenuActionProps = useCallback((commandId) => {
    const command = resolveCommand(commandId)
    if (!command) {
      return {
        disabled: true,
        role: 'menuitem',
        'aria-checked': undefined,
        label: commandId,
        accelerator: '',
        mnemonic: '',
        destructive: false,
      }
    }

    const role = command.type === 'checkbox'
      ? 'menuitemcheckbox'
      : command.type === 'radio'
        ? 'menuitemradio'
        : 'menuitem'

    return {
      disabled: !command.enabled,
      role,
      'aria-checked': role === 'menuitem' ? undefined : command.checked,
      label: command.label,
      accelerator: command.accelerator || '',
      mnemonic: command.mnemonic || '',
      destructive: command.destructive,
    }
  }, [resolveCommand])

  const bindMenuCommand = useCallback((commandId, options = {}) => {
    const action = getMenuActionProps(commandId)
    const onClick = () => invokeCommandButton(commandId)
    return {
      disabled: action.disabled,
      role: action.role,
      'aria-checked': action['aria-checked'],
      'aria-keyshortcuts': action.accelerator || undefined,
      className: `studio-menu-command${action.destructive ? ' is-destructive' : ''}${options.className ? ` ${options.className}` : ''}`,
      title: action.accelerator ? `${action.label} (${action.accelerator})` : action.label,
      onClick,
      label: action.label,
      accelerator: action.accelerator,
      mnemonic: action.mnemonic,
    }
  }, [getMenuActionProps, invokeCommandButton])

  const renderMenuCommandButton = useCallback((commandId) => {
    const action = bindMenuCommand(commandId)
    return (
      <button
        key={commandId}
        type="button"
        role={action.role}
        aria-checked={action['aria-checked']}
        aria-keyshortcuts={action['aria-keyshortcuts']}
        className={action.className}
        disabled={action.disabled}
        title={action.title}
        onClick={action.onClick}
      >
        <span className="studio-menu-command-label">{action.label}</span>
        <span className="studio-menu-command-accelerator" aria-hidden="true">{action.accelerator || ''}</span>
      </button>
    )
  }, [bindMenuCommand])

  useEffect(() => {
    if (!menuOpen) {
      setMenuDropdownStyle(null)
      setMenuKeyboardActive(false)
      setMenuKeyboardSection('cascade')
      setMenuKeyboardIndex(0)
      return undefined
    }

    const updateDropdownPosition = () => {
      setMenuDropdownStyle(computeMenuDropdownStyle(menuOpen))
    }

    updateDropdownPosition()
    window.addEventListener('resize', updateDropdownPosition)
    window.addEventListener('scroll', updateDropdownPosition, true)

    return () => {
      window.removeEventListener('resize', updateDropdownPosition)
      window.removeEventListener('scroll', updateDropdownPosition, true)
    }
  }, [computeMenuDropdownStyle, menuOpen])

  useEffect(() => {
    const handlePointerDownOutside = (event) => {
      if (!menuOpen) {
        return
      }
      const region = menuRegionRef.current
      if (!region?.contains(event.target)) {
        closeMenu(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDownOutside)
    return () => window.removeEventListener('pointerdown', handlePointerDownOutside)
  }, [closeMenu, menuOpen])

  useEffect(() => () => closeMenu(false), [closeMenu])

  useEffect(() => {
    if (!menuOpen || !MENU_SUBMENU_DEFAULTS[menuOpen]) {
      return
    }

    setMenuSubmenuState((previous) => ({
      ...previous,
      [menuOpen]: MENU_SUBMENU_DEFAULTS[menuOpen],
    }))
  }, [menuOpen])

  useEffect(() => {
    const handleStudioMenuKeydown = (event) => {
      const target = event.target
      const isTypingTarget = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || Boolean(target?.isContentEditable)

      const hasModifierShortcut = event.ctrlKey || event.metaKey

      if (hasModifierShortcut) {
        const commandEntries = Object.entries(commandRegistry)
        const match = commandEntries.find(([, command]) => matchesAccelerator(command.accelerator, event))

        if (match) {
          event.preventDefault()
          executeCommand(match[0], { closeMenu: false, restoreFocus: false })
          return
        }
      }

      if (!menuOpen && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.length === 1) {
        const key = event.key.toLowerCase()
        const targetMenuId = Object.entries(STUDIO_MENU_MNEMONICS).find(([, mnemonic]) => mnemonic === key)?.[0]
        if (targetMenuId) {
          event.preventDefault()
          openMenu(targetMenuId, { keyboard: true })
          return
        }
      }

      if (isTypingTarget || !menuOpen) {
        return
      }

      const menuIndex = STUDIO_MENU_ORDER.indexOf(menuOpen)
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu(true)
        return
      }

      const region = menuRegionRef.current
      if (!region) {
        return
      }

      const cascadeButtons = Array.from(region.querySelectorAll('.studio-menu-cascade-list button:not(:disabled)'))
      const submenuButtons = Array.from(region.querySelectorAll('.studio-menu-submenu-panel button:not(:disabled):not([tabindex="-1"])'))
      const activeList = menuKeyboardSection === 'submenu' ? submenuButtons : cascadeButtons

      if (event.key === 'ArrowRight') {
        if (menuKeyboardSection === 'cascade' && submenuButtons.length) {
          event.preventDefault()
          setMenuKeyboardSection('submenu')
          setMenuKeyboardIndex(0)
          menuKeyboardAnchorRef.current = { section: 'submenu', index: 0 }
          setMenuKeyboardActive(true)
          submenuButtons[0]?.focus()
          return
        }

        event.preventDefault()
        const delta = 1
        const nextIndex = (menuIndex + delta + STUDIO_MENU_ORDER.length) % STUDIO_MENU_ORDER.length
        const nextMenu = STUDIO_MENU_ORDER[nextIndex]
        openMenu(nextMenu, { keyboard: true, preserveAnchor: true })
        return
      }

      if (event.key === 'ArrowLeft') {
        if (menuKeyboardSection === 'submenu' && cascadeButtons.length) {
          event.preventDefault()
          setMenuKeyboardSection('cascade')
          setMenuKeyboardIndex(0)
          menuKeyboardAnchorRef.current = { section: 'cascade', index: 0 }
          setMenuKeyboardActive(true)
          cascadeButtons[0]?.focus()
          return
        }

        event.preventDefault()
        const delta = -1
        const nextIndex = (menuIndex + delta + STUDIO_MENU_ORDER.length) % STUDIO_MENU_ORDER.length
        const nextMenu = STUDIO_MENU_ORDER[nextIndex]
        openMenu(nextMenu, { keyboard: true, preserveAnchor: true })
        return
      }

      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && activeList.length) {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex = (menuKeyboardIndex + delta + activeList.length) % activeList.length
        setMenuKeyboardIndex(nextIndex)
        menuKeyboardAnchorRef.current = { section: menuKeyboardSection, index: nextIndex }
        setMenuKeyboardActive(true)
        activeList[nextIndex]?.focus()
        return
      }

      if (event.key === 'Tab') {
        event.preventDefault()
        const nextSection = menuKeyboardSection === 'cascade' ? 'submenu' : 'cascade'
        const nextList = nextSection === 'submenu' ? submenuButtons : cascadeButtons
        if (!nextList.length) {
          return
        }
        setMenuKeyboardSection(nextSection)
        setMenuKeyboardIndex(0)
        menuKeyboardAnchorRef.current = { section: nextSection, index: 0 }
        setMenuKeyboardActive(true)
        nextList[0]?.focus()
        return
      }

      if (event.key === 'Enter' || event.key === ' ') {
        const focused = document.activeElement
        if (focused instanceof HTMLElement) {
          event.preventDefault()
          focused.click()
        }
      }
    }

    window.addEventListener('keydown', handleStudioMenuKeydown)
    return () => window.removeEventListener('keydown', handleStudioMenuKeydown)
  }, [
    closeMenu,
    commandRegistry,
    executeCommand,
    menuKeyboardIndex,
    menuKeyboardSection,
    menuOpen,
    openMenu,
  ])

  useEffect(() => {
    if (!menuOpen || !menuKeyboardActive) {
      return
    }

    const region = menuRegionRef.current
    if (!region) {
      return
    }

    const selector = menuKeyboardSection === 'submenu'
      ? '.studio-menu-submenu-panel button:not(:disabled):not([tabindex="-1"])'
      : '.studio-menu-cascade-list button:not(:disabled)'
    const buttons = Array.from(region.querySelectorAll(selector))
    if (!buttons.length) {
      return
    }

    const boundedIndex = clamp(menuKeyboardIndex, 0, buttons.length - 1)
    buttons[boundedIndex]?.focus()
  }, [menuKeyboardActive, menuKeyboardIndex, menuKeyboardSection, menuOpen])

  const setAdvancedNumericControl = useCallback((path, value, isInteger = false) => {
    const parsed = Number(value)
    const safeValue = Number.isFinite(parsed) ? (isInteger ? Math.round(parsed) : parsed) : 0
    setTuningConfig((prev) => setByPath(prev, path, safeValue))
  }, [])

  const setAdvancedToggleControl = useCallback((path, checked) => {
    setTuningConfig((prev) => setByPath(prev, path, checked))
  }, [])

  const setAdvancedSelectControl = useCallback((path, value) => {
    setTuningConfig((prev) => setByPath(prev, path, value))
  }, [])

  const activeUtilityConfig = useMemo(
    () => ADVANCED_TUNING_TABS.find((tab) => tab.id === activeUtilityTab) || ADVANCED_TUNING_TABS[0],
    [activeUtilityTab],
  )

  const renderPanelActions = (panel, panelLabel) => {
    const collapsed = panelState[panel]
    const focused = focusPanel === panel
    const primaryAction = focused && !collapsed
      ? restoreAllPanels
      : collapsed
        ? () => restorePanel(panel)
        : () => togglePanelCollapse(panel)
    const primaryActionLabel = focused && !collapsed
      ? 'Restore workspace layout'
      : collapsed
        ? 'Expand panel'
        : 'Collapse panel'

    return (
      <div className="studio-panel-actions" role="group" aria-label={`${panelLabel} panel actions`}>
        <button
          type="button"
          className="studio-icon-button"
          onClick={primaryAction}
          title={primaryActionLabel}
          aria-label={focused && !collapsed ? primaryActionLabel : `${primaryActionLabel} ${panelLabel} panel`}
        >
          <StudioIcon name={collapsed ? 'chevron-right' : 'chevron-down'} className="studio-icon-glyph" />
        </button>
        {focused ? (
          <button
            type="button"
            className="studio-icon-button"
            onClick={restoreAllPanels}
            title="Restore workspace layout"
            aria-label="Restore workspace layout"
          >
            <StudioIcon name="layout-restore" className="studio-icon-glyph" />
          </button>
        ) : (
          <button
            type="button"
            className="studio-icon-button"
            onClick={() => maximizePanel(panel)}
            title={`Maximize ${panelLabel} panel`}
            aria-label={`Maximize ${panelLabel} panel`}
          >
            <StudioIcon name="maximize" className="studio-icon-glyph" />
          </button>
        )}
      </div>
    )
  }

  const activeMenuSubmenu = menuOpen ? (menuSubmenuState[menuOpen] || MENU_SUBMENU_DEFAULTS[menuOpen] || null) : null
  const menuSubmenuRowCount = menuOpen
    ? (menuOpen === 'file'
      ? Math.max(MENU_SUBMENU_MAX_ROWS.file || 6, projectRegistry.projects.length + 5)
      : (MENU_SUBMENU_MAX_ROWS[menuOpen] || 6))
    : 6
  const menuDropdownRenderStyle = useMemo(() => ({
    ...(menuDropdownStyle || {}),
    '--studio-menu-submenu-rows': String(menuSubmenuRowCount),
  }), [menuDropdownStyle, menuSubmenuRowCount])
  const setActiveMenuSubmenu = (submenuId) => {
    if (!menuOpen || !submenuId) {
      return
    }
    setMenuKeyboardSection('cascade')
    setMenuKeyboardIndex(0)
    menuKeyboardAnchorRef.current = { section: 'cascade', index: 0 }
    setMenuSubmenuState((previous) => ({
      ...previous,
      [menuOpen]: submenuId,
    }))
  }

  return (
    <div
      ref={workspaceShellRef}
      className={`studio-workspace-shell density-${workspaceLayout.density}${focusPanel ? ` focus-${focusPanel}` : ''}`}
      style={workspaceStyle}
      onClick={() => {
        if (menuOpen) {
          closeMenu(false)
        }
      }}
    >
      <input
        ref={importProjectInputRef}
        type="file"
        accept="application/json,.json"
        tabIndex={-1}
        className="studio-hidden-input"
        onChange={handleProjectImportInputChange}
        aria-hidden="true"
      />
      <header
        ref={menuRegionRef}
        className="studio-menubar"
        role="menubar"
        aria-label="Studio menu"
        onMouseEnter={handleMenuRegionMouseEnter}
        onMouseLeave={handleMenuRegionMouseLeave}
      >
        <button
          type="button"
          ref={(element) => setMenuTriggerRef('file', element)}
          className={`studio-menu-trigger${menuOpen === 'file' ? ' open' : ''}`}
          aria-label="File menu"
          title="File menu (Alt+F)"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={menuOpen === 'file'}
          onClick={(event) => { event.stopPropagation(); toggleMenu('file') }}
          onMouseEnter={() => handleMenuTriggerMouseEnter('file')}
        >
          <StudioIcon name="file-menu" className="studio-icon-glyph" />
          <span className="studio-menu-trigger-label">File</span>
        </button>
        <button
          type="button"
          ref={(element) => setMenuTriggerRef('edit', element)}
          className={`studio-menu-trigger${menuOpen === 'edit' ? ' open' : ''}`}
          aria-label="Edit menu"
          title="Edit menu (Alt+E)"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={menuOpen === 'edit'}
          onClick={(event) => { event.stopPropagation(); toggleMenu('edit') }}
          onMouseEnter={() => handleMenuTriggerMouseEnter('edit')}
        >
          <StudioIcon name="edit-menu" className="studio-icon-glyph" />
          <span className="studio-menu-trigger-label">Edit</span>
        </button>
        <button
          type="button"
          ref={(element) => setMenuTriggerRef('view', element)}
          className={`studio-menu-trigger${menuOpen === 'view' ? ' open' : ''}`}
          aria-label="View menu"
          title="View menu (Alt+V)"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={menuOpen === 'view'}
          onClick={(event) => { event.stopPropagation(); toggleMenu('view') }}
          onMouseEnter={() => handleMenuTriggerMouseEnter('view')}
        >
          <StudioIcon name="view-menu" className="studio-icon-glyph" />
          <span className="studio-menu-trigger-label">View</span>
        </button>
        <button
          type="button"
          ref={(element) => setMenuTriggerRef('layout', element)}
          className={`studio-menu-trigger${menuOpen === 'layout' ? ' open' : ''}`}
          aria-label="Layout menu"
          title="Layout menu (Alt+L)"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={menuOpen === 'layout'}
          onClick={(event) => { event.stopPropagation(); toggleMenu('layout') }}
          onMouseEnter={() => handleMenuTriggerMouseEnter('layout')}
        >
          <StudioIcon name="layout-menu" className="studio-icon-glyph" />
          <span className="studio-menu-trigger-label">Layout</span>
        </button>
        <button
          type="button"
          ref={(element) => setMenuTriggerRef('tools', element)}
          className={`studio-menu-trigger${menuOpen === 'tools' ? ' open' : ''}`}
          aria-label="Tools menu"
          title="Tools menu (Alt+T)"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={menuOpen === 'tools'}
          onClick={(event) => { event.stopPropagation(); toggleMenu('tools') }}
          onMouseEnter={() => handleMenuTriggerMouseEnter('tools')}
        >
          <StudioIcon name="tools-menu" className="studio-icon-glyph" />
          <span className="studio-menu-trigger-label">Tools</span>
        </button>
        <button
          type="button"
          ref={(element) => setMenuTriggerRef('help', element)}
          className={`studio-menu-trigger${menuOpen === 'help' ? ' open' : ''}`}
          aria-label="Help menu"
          title="Help menu (Alt+H)"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={menuOpen === 'help'}
          onClick={(event) => { event.stopPropagation(); toggleMenu('help') }}
          onMouseEnter={() => handleMenuTriggerMouseEnter('help')}
        >
          <StudioIcon name="help-menu" className="studio-icon-glyph" />
          <span className="studio-menu-trigger-label">Help</span>
        </button>
        <div className="studio-menubar-brand" aria-hidden="true">MistyOS Studio</div>

        {menuOpen === 'file' ? (
          <div
            className="studio-menu-dropdown studio-menu-dropdown--cascade"
            style={menuDropdownRenderStyle}
            onClick={(event) => event.stopPropagation()}
            onMouseEnter={handleMenuRegionMouseEnter}
            onMouseLeave={handleMenuRegionMouseLeave}
          >
            <div className="studio-menu-cascade-list" role="menu" aria-label="File categories">
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'runtime' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('runtime')}><span>Runtime</span><span aria-hidden="true">▸</span></button>
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'context' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('context')}><span>Context</span><span aria-hidden="true">▸</span></button>
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'export' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('export')}><span>Export</span><span aria-hidden="true">▸</span></button>
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'workspace' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('workspace')}><span>Workspace</span><span aria-hidden="true">▸</span></button>
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'startup' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('startup')}><span>Startup</span><span aria-hidden="true">▸</span></button>
            </div>
            <div className="studio-menu-submenu-panel" role="menu" aria-label="File submenu">
              {activeMenuSubmenu === 'runtime' ? (
                <>
                  {renderMenuCommandButton(WORKFLOW_COMMAND_IDS.save)}
                  {renderMenuCommandButton(WORKFLOW_COMMAND_IDS.saveAs)}
                  {renderMenuCommandButton(WORKFLOW_COMMAND_IDS.revertToSaved)}
                  <div className="studio-menu-separator" role="separator" aria-hidden="true" />
                  {renderMenuCommandButton(WORKFLOW_COMMAND_IDS.updateDesktop)}
                </>
              ) : null}
              {activeMenuSubmenu === 'context' ? (
                <>
                  {renderMenuCommandButton('file.project.new')}
                  <div className="studio-menu-separator" role="separator" aria-hidden="true" />
                  {projectRegistry.projects.map((project) => (
                    renderMenuCommandButton(`file.project.switch.${project.projectId}`)
                  ))}
                  <div className="studio-menu-separator" role="separator" aria-hidden="true" />
                  <div className="studio-menu-fields">
                    <label className="studio-menu-field">
                      <span>Scene</span>
                      <select value={activeSceneId} onChange={(event) => setActiveSceneId(event.target.value)}>
                        {sceneCatalog.map((scene) => (
                          <option key={scene.id} value={scene.id}>{scene.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="studio-menu-field">
                      <span>Timeline</span>
                      <strong>{selectedTimeline?.name || activeTimelineId || timelineOptions[0] || 'None'}</strong>
                    </label>
                    <label className="studio-menu-field">
                      <span>Preset</span>
                      <select value={activePresetId} onChange={(event) => setActivePresetId(event.target.value)}>
                        {presetCatalog.map((preset) => (
                          <option key={preset.id} value={preset.id}>{preset.name}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                </>
              ) : null}
              {activeMenuSubmenu === 'export' ? (
                <>
                  {renderMenuCommandButton(WORKFLOW_COMMAND_IDS.importProject)}
                  <div className="studio-menu-separator" role="separator" aria-hidden="true" />
                  {renderMenuCommandButton(WORKFLOW_COMMAND_IDS.exportAuthoringState)}
                  {renderMenuCommandButton(WORKFLOW_COMMAND_IDS.exportRuntimePayload)}
                  <div className="studio-menu-separator" role="separator" aria-hidden="true" />
                  {renderMenuCommandButton('file.exportStudioJson')}
                  {renderMenuCommandButton('file.exportTuningJson')}
                </>
              ) : null}
              {activeMenuSubmenu === 'workspace' ? (
                <>
                  {renderMenuCommandButton('file.resetLayout')}
                  {renderMenuCommandButton('file.resetDefaults')}
                </>
              ) : null}
              {activeMenuSubmenu === 'startup' ? Object.values(STARTUP_MODES).map((mode) => (
                renderMenuCommandButton(`file.startupMode.${mode}`)
              )) : null}
            </div>
          </div>
        ) : null}
        {menuOpen === 'edit' ? (
          <div
            className="studio-menu-dropdown studio-menu-dropdown--cascade"
            style={menuDropdownRenderStyle}
            onClick={(event) => event.stopPropagation()}
            onMouseEnter={handleMenuRegionMouseEnter}
            onMouseLeave={handleMenuRegionMouseLeave}
          >
            <div className="studio-menu-cascade-list" role="menu" aria-label="Edit categories">
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'timeline' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('timeline')}><span>Timeline</span><span aria-hidden="true">▸</span></button>
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'workspace' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('workspace')}><span>Workspace</span><span aria-hidden="true">▸</span></button>
            </div>
            <div className="studio-menu-submenu-panel" role="menu" aria-label="Edit submenu">
              {activeMenuSubmenu === 'timeline' ? (
                renderMenuCommandButton('edit.revertTimeline')
              ) : null}
              {activeMenuSubmenu === 'workspace' ? (
                renderMenuCommandButton('edit.resetWorkspaceLayout')
              ) : null}
            </div>
          </div>
        ) : null}
        {menuOpen === 'view' ? (
          <div
            className="studio-menu-dropdown studio-menu-dropdown--cascade"
            style={menuDropdownRenderStyle}
            onClick={(event) => event.stopPropagation()}
            onMouseEnter={handleMenuRegionMouseEnter}
            onMouseLeave={handleMenuRegionMouseLeave}
          >
            <div className="studio-menu-cascade-list" role="menu" aria-label="View categories">
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'scene-preview' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('scene-preview')}><span>Scene Preview</span><span aria-hidden="true">▸</span></button>
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'panels' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('panels')}><span>Panels</span><span aria-hidden="true">▸</span></button>
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'timeline' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('timeline')}><span>Timeline</span><span aria-hidden="true">▸</span></button>
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'assets' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('assets')}><span>Assets</span><span aria-hidden="true">▸</span></button>
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'ui' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('ui')}><span>UI</span><span aria-hidden="true">▸</span></button>
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'workspace' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('workspace')}><span>Workspace</span><span aria-hidden="true">▸</span></button>
            </div>

            <div className="studio-menu-submenu-panel" role="menu" aria-label={`View ${activeMenuSubmenu} submenu`}>
                {activeMenuSubmenu === 'scene-preview' ? (
                  <>
                    {renderMenuCommandButton('view.previewMode.contain')}
                    {renderMenuCommandButton('view.previewMode.fill')}
                    {renderMenuCommandButton('view.previewMode.native')}
                    {renderMenuCommandButton('view.previewMode.zoom')}
                    <div className="studio-menu-separator" role="separator" aria-hidden="true" />
                    {renderMenuCommandButton('view.sceneGrid')}
                    {renderMenuCommandButton('view.diagnosticsOverlay')}
                    {renderMenuCommandButton('view.compositionGuides')}
                    {renderMenuCommandButton('view.previewDevPanel')}
                  </>
                ) : null}

                {activeMenuSubmenu === 'panels' ? (
                  <>
                    {renderMenuCommandButton('view.panels.left')}
                    {renderMenuCommandButton('view.panels.center')}
                    {renderMenuCommandButton('view.panels.right')}
                    {renderMenuCommandButton('view.panels.bottom')}
                    {renderMenuCommandButton('view.panels.utility')}
                    <div className="studio-menu-separator" role="separator" aria-hidden="true" />
                    {renderMenuCommandButton('view.panels.restoreAll')}
                  </>
                ) : null}

                {activeMenuSubmenu === 'timeline' ? (
                  <>
                    {renderMenuCommandButton('view.timeline.eventLabels.compact')}
                    {renderMenuCommandButton('view.timeline.eventLabels.full')}
                    {renderMenuCommandButton('view.timeline.fitToWindow')}
                    <div className="studio-menu-separator" role="separator" aria-hidden="true" />
                    {renderMenuCommandButton('view.timeline.snap.1')}
                    {renderMenuCommandButton('view.timeline.snap.5')}
                    {renderMenuCommandButton('view.timeline.snap.10')}
                  </>
                ) : null}

                {activeMenuSubmenu === 'assets' ? (
                  <>
                    {renderMenuCommandButton('view.assets.cards.compact')}
                    {renderMenuCommandButton('view.assets.cards.large')}
                  </>
                ) : null}

                {activeMenuSubmenu === 'ui' ? (
                  <>
                    {renderMenuCommandButton('view.ui.density')}
                    <div className="studio-menu-separator" role="separator" aria-hidden="true" />
                    {UI_FONT_STEPS.map((fontStep) => (
                      renderMenuCommandButton(`view.ui.font.${fontStep}`)
                    ))}
                  </>
                ) : null}

                {activeMenuSubmenu === 'workspace' ? (
                  renderMenuCommandButton('view.workspace.resetLayout')
                ) : null}
            </div>
          </div>
        ) : null}
        {menuOpen === 'layout' ? (
          <div
            className="studio-menu-dropdown studio-menu-dropdown--cascade"
            style={menuDropdownRenderStyle}
            onClick={(event) => event.stopPropagation()}
            onMouseEnter={handleMenuRegionMouseEnter}
            onMouseLeave={handleMenuRegionMouseLeave}
          >
            <div className="studio-menu-cascade-list" role="menu" aria-label="Layout categories">
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'presets' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('presets')}><span>Presets</span><span aria-hidden="true">▸</span></button>
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'workspace' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('workspace')}><span>Workspace</span><span aria-hidden="true">▸</span></button>
            </div>
            <div className="studio-menu-submenu-panel" role="menu" aria-label="Layout submenu">
              {activeMenuSubmenu === 'presets' ? (
                <>
                  {renderMenuCommandButton('layout.preset.editing')}
                  {renderMenuCommandButton('layout.preset.review')}
                  {renderMenuCommandButton('layout.preset.focus')}
                </>
              ) : null}
              {activeMenuSubmenu === 'workspace' ? (
                renderMenuCommandButton('layout.workspace.reset')
              ) : null}
            </div>
          </div>
        ) : null}
        {menuOpen === 'tools' ? (
          <div
            className="studio-menu-dropdown studio-menu-dropdown--cascade"
            style={menuDropdownRenderStyle}
            onClick={(event) => event.stopPropagation()}
            onMouseEnter={handleMenuRegionMouseEnter}
            onMouseLeave={handleMenuRegionMouseLeave}
          >
            <div className="studio-menu-cascade-list" role="menu" aria-label="Tools categories">
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'diagnostics' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('diagnostics')}><span>Diagnostics</span><span aria-hidden="true">▸</span></button>
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'overlays' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('overlays')}><span>Overlays</span><span aria-hidden="true">▸</span></button>
            </div>
            <div className="studio-menu-submenu-panel" role="menu" aria-label="Tools submenu">
              {activeMenuSubmenu === 'diagnostics' ? (
                <>
                  {renderMenuCommandButton('tools.openDiagnostics')}
                  {renderMenuCommandButton('tools.openSpatialDiagnostics')}
                  {renderMenuCommandButton(VERIFICATION_COMMAND_IDS.run)}
                  {renderMenuCommandButton(VERIFICATION_COMMAND_IDS.exportLatestReport)}
                  {renderMenuCommandButton(VERIFICATION_COMMAND_IDS.runAndExport)}
                  {renderMenuCommandButton(VERIFICATION_COMMAND_IDS.runFullSuite)}
                  {renderMenuCommandButton('tools.copyLatestVerificationArtifact')}
                </>
              ) : null}
              {activeMenuSubmenu === 'overlays' ? (
                renderMenuCommandButton('tools.openWeatherOverlay')
              ) : null}
            </div>
          </div>
        ) : null}
        {menuOpen === 'help' ? (
          <div
            className="studio-menu-dropdown studio-menu-dropdown--cascade"
            style={menuDropdownRenderStyle}
            onClick={(event) => event.stopPropagation()}
            onMouseEnter={handleMenuRegionMouseEnter}
            onMouseLeave={handleMenuRegionMouseLeave}
          >
            <div className="studio-menu-cascade-list" role="menu" aria-label="Help categories">
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'quick-start' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('quick-start')}><span>Quick Start</span><span aria-hidden="true">▸</span></button>
              <button type="button" className={`studio-menu-cascade-trigger${activeMenuSubmenu === 'workspace' ? ' active' : ''}`} onMouseEnter={() => setActiveMenuSubmenu('workspace')}><span>Workspace</span><span aria-hidden="true">▸</span></button>
            </div>
            <div className="studio-menu-submenu-panel" role="menu" aria-label="Help submenu">
              {activeMenuSubmenu === 'quick-start' ? (
                renderMenuCommandButton('help.openScenePreview')
              ) : null}
              {activeMenuSubmenu === 'workspace' ? (
                renderMenuCommandButton('help.showAdvancedTuning')
              ) : null}
            </div>
          </div>
        ) : null}
      </header>

      <aside ref={leftPanelRef} className={`studio-left-panel${panelState.left ? ' is-collapsed' : ''}`}>
        <div className="studio-panel-header">
          <span>Asset Browser</span>
          {renderPanelActions('left', 'Assets')}
        </div>
        {!panelState.left ? (
          <StudioSectionBoundary sectionName="asset-browser-rendering">
            <>
              <div className="asset-rail-toolbar">
                <input
                  type="search"
                  value={assetQuery}
                  onChange={(event) => setAssetQuery(event.target.value)}
                  placeholder="Filter assets"
                  aria-label="Filter assets"
                />
                <span>{totalAssetCount}</span>
              </div>

              <div className="asset-group-label">Assets</div>
              <div className="asset-section">
                <div className="asset-section-label">Scenes</div>
                <div className="asset-list rail-compact card-size-compact asset-list--dense">
                  {filteredScenes.map((scene) => (
                    <button key={scene.id} type="button" className={`asset-card ${scene.id === activeSceneId ? 'active' : ''}`} onClick={() => setAssetBrowserSelection({ type: 'scene', id: scene.id })}>
                      <span className="asset-item-main"><span className="asset-item-icon">◼</span>{scene.name}</span>
                      <small>{scene.id}</small>
                    </button>
                  ))}
                  {!filteredScenes.length ? <p className="asset-empty">No matching scenes</p> : null}
                </div>
              </div>
              <div className="asset-section">
                <div className="asset-section-label">Media</div>
                <div className="asset-list rail-compact card-size-compact asset-list--dense">
                  {filteredMediaAssets.map((media) => (
                    <button key={media.id} type="button" className={`asset-card${assetBrowserSelection?.type === 'media' && assetBrowserSelection?.id === media.id ? ' active' : ''}`} onClick={() => setAssetBrowserSelection({ type: 'media', id: media.id })}>
                      <span className="asset-item-main"><span className="asset-item-icon">▦</span>{media.name}</span>
                    </button>
                  ))}
                  {!filteredMediaAssets.length ? <p className="asset-empty">No matching media</p> : null}
                </div>
              </div>

              <div className="asset-group-label">Weather</div>
              <div className="asset-section">
                <div className="asset-section-label">Timelines</div>
                <p className="asset-empty">Click a timeline to inspect it. Use Inspector Active Timeline to activate it.</p>
                <div className="asset-list rail-compact card-size-compact asset-list--dense">
                  {filteredTimelines.map((timeline) => (
                    <button
                      key={timeline.id}
                      type="button"
                      className={`asset-card ${assetBrowserSelection?.type === 'timeline' && assetBrowserSelection?.id === timeline.id ? 'active' : ''}`}
                      onClick={() => setAssetBrowserSelection({ type: 'timeline', id: timeline.id })}
                    >
                      <span className="asset-item-main"><span className="asset-item-icon">▤</span>{timeline.name}</span>
                      <small>{timeline.id === activeTimelineId ? `${timeline.id} (active)` : timeline.id}</small>
                    </button>
                  ))}
                  {!filteredTimelines.length ? <p className="asset-empty">No matching timelines</p> : null}
                </div>
              </div>
              <div className="asset-section">
                <div className="asset-section-label">Presets</div>
                <div className="asset-list rail-compact card-size-compact asset-list--dense">
                  {filteredPresets.map((preset) => (
                    <button key={preset.id} type="button" className={`asset-card ${preset.id === activePresetId ? 'active' : ''}`} onClick={() => setAssetBrowserSelection({ type: 'preset', id: preset.id })}>
                      <span className="asset-item-main"><span className="asset-item-icon">◈</span>{preset.name}</span>
                    </button>
                  ))}
                  {!filteredPresets.length ? <p className="asset-empty">No matching presets</p> : null}
                </div>
              </div>
            </>
          </StudioSectionBoundary>
        ) : null}
      </aside>

      <div
        className={`studio-splitter studio-splitter-left${panelState.left ? ' studio-splitter-disabled' : ''}`}
        onMouseDown={(event) => beginResize('left', event)}
        role="separator"
        aria-label="Resize asset rail"
      />

      <main ref={centerWorkspaceRef} className={`studio-center-workspace${panelState.center ? ' is-collapsed' : ''}`}>
        <div className="studio-panel-header studio-panel-header--primary">
          <div className="studio-panel-title-row">
            <span>Scene Preview</span>
            <div className="studio-inline-tabs" role="tablist" aria-label="Scene workspace mode">
              <button
                type="button"
                className={`studio-icon-toggle ${activeWorkspaceTab === 'preview' ? 'active' : ''}`}
                onClick={() => executeCommand('workspace.tab.preview', { closeMenu: false, restoreFocus: false })}
                aria-label="Open preview workspace"
                title="Preview workspace"
              >
                <StudioIcon name="preview" className="studio-icon-glyph" />
              </button>
              <button
                type="button"
                className={`studio-icon-toggle ${activeWorkspaceTab === 'composition' ? 'active' : ''}`}
                onClick={() => executeCommand('workspace.tab.composition', { closeMenu: false, restoreFocus: false })}
                aria-label="Open composition workspace"
                title="Composition workspace"
              >
                <StudioIcon name="composition" className="studio-icon-glyph" />
              </button>
              <button
                type="button"
                className={`studio-icon-toggle ${activeWorkspaceTab === 'spatial' ? 'active' : ''}`}
                onClick={() => executeCommand('workspace.tab.spatial', { closeMenu: false, restoreFocus: false })}
                aria-label="Open spatial workspace"
                title="Spatial workspace"
              >
                <StudioIcon name="spatial" className="studio-icon-glyph" />
              </button>
              <button
                type="button"
                className={`studio-icon-toggle ${activeWorkspaceTab === 'diagnostics' ? 'active' : ''}`}
                onClick={() => executeCommand('workspace.tab.diagnostics', { closeMenu: false, restoreFocus: false })}
                aria-label="Open diagnostics workspace"
                title="Diagnostics workspace"
              >
                <StudioIcon name="diagnostics" className="studio-icon-glyph" />
              </button>
              <button
                type="button"
                className={`studio-icon-toggle ${activeWorkspaceTab === 'weather' ? 'active' : ''}`}
                onClick={() => executeCommand('workspace.tab.weather', { closeMenu: false, restoreFocus: false })}
                aria-label="Open weather workspace"
                title="Weather workspace"
              >
                <StudioIcon name="weather" className="studio-icon-glyph" />
              </button>
            </div>
            <div className="scene-preview-toolbar" role="toolbar" aria-label="Scene preview view controls">
              <button
                type="button"
                className={`studio-icon-toggle ${workspaceLayout.previewMode === 'contain' ? 'active' : ''}`}
                onClick={() => executeCommand('view.previewMode.contain', { closeMenu: false, restoreFocus: false })}
                aria-label="Set preview mode to contain"
                title="Contain full composition without upscaling"
              >
                <StudioIcon name="contain" className="studio-icon-glyph" />
              </button>
              <button
                type="button"
                className={`studio-icon-toggle ${workspaceLayout.previewMode === 'fill' ? 'active' : ''}`}
                onClick={() => executeCommand('view.previewMode.fill', { closeMenu: false, restoreFocus: false })}
                aria-label="Set preview mode to fill"
                title="Fill viewport while preserving aspect ratio"
              >
                <StudioIcon name="fill" className="studio-icon-glyph" />
              </button>
              <button
                type="button"
                className={`studio-icon-toggle ${workspaceLayout.previewMode === 'native' ? 'active' : ''}`}
                onClick={() => executeCommand('view.previewMode.native', { closeMenu: false, restoreFocus: false })}
                aria-label="Set preview mode to native scale"
                title="Show composition at native scale with scrolling"
              >
                <StudioIcon name="native" className="studio-icon-glyph" />
              </button>
              <button
                type="button"
                className={`studio-icon-toggle ${workspaceLayout.previewMode === 'zoom' ? 'active' : ''}`}
                onClick={() => executeCommand('view.previewMode.zoom', { closeMenu: false, restoreFocus: false })}
                aria-label="Set preview mode to manual zoom"
                title="Enable manual preview zoom"
              >
                <StudioIcon name="zoom" className="studio-icon-glyph" />
              </button>
              {workspaceLayout.previewMode === 'zoom' ? (
                <label className="scene-preview-zoom-control">
                  <span>{`${previewZoomPercent}%`}</span>
                  <input
                    type="range"
                    min="0.25"
                    max="4"
                    step="0.05"
                    value={workspaceLayout.previewZoom}
                    onChange={(event) => updateWorkspaceLayout({ previewZoom: Number(event.target.value) }, true)}
                    aria-label="Manual scene preview zoom"
                  />
                </label>
              ) : null}
            </div>
          </div>
          {renderPanelActions('center', 'Scene Preview')}
        </div>
        {!panelState.center ? (
          <StudioSectionBoundary sectionName="scene-preview-rendering">
            <>
              <div className="workspace-tab-body">
                <section className="workspace-panel workspace-panel--persistent active">
                <div ref={previewFitSourceRef} className="scene-preview-fit-source">
                <div ref={previewViewportRef} className={previewViewportClassName}>
                {process.env.NODE_ENV === 'development' && workspaceLayout.showPreviewDevReadout && (
                  <div className="scene-preview-debug-readout" title="Development debug: viewport and composition metrics">
                    <div>Mode: {workspaceLayout.previewMode}</div>
                    <div>Runtime source: {previewRuntimeSource}</div>
                    <div>publishRevision: {previewRuntimePublishRevision}</div>
                    <div>restartToken: {previewRuntimeRestartToken}</div>
                    <div>timelineId: {previewRuntimeTimelineId}</div>
                    <div>runtimePayloadHash: {previewRuntimePayloadHash}</div>
                    <div>activeSurface: {resolvedRuntimeSurfacePriority.resolvedSurfaceType || 'none'}</div>
                    <div>studioPreviewPaused: {studioPreviewPaused ? 'true' : 'false'} ({studioPreviewPauseReason})</div>
                    <div>Visible box: {previewVisibleBox.width}x{previewVisibleBox.height}px</div>
                    <div>Padded fit box: {previewPaddedFitBox.width}x{previewPaddedFitBox.height}px (inset {PREVIEW_MATTE_INSET_PX}px)</div>
                    <div>Contain baseline: {previewContainBaselineScale.toFixed(3)}x</div>
                    <div>Zoom: {previewZoomPercent}%</div>
                    <div>Final displayed scale: {previewScale.toFixed(3)}x</div>
                    <div>DPR: {previewDevicePixelRatio.toFixed(2)}</div>
                    <div>VP: {previewRawViewportSize.width}x{previewRawViewportSize.height}px</div>
                    <div>Authored: {PREVIEW_SCENE_WIDTH}x{PREVIEW_SCENE_HEIGHT}px</div>
                    <div>Presentation: {previewPresentation.width}x{previewPresentation.height}px</div>
                    <div>Logical: {PREVIEW_SCENE_WIDTH}x{PREVIEW_SCENE_HEIGHT}px</div>
                    <div>Scale: {previewScale.toFixed(3)}x</div>
                    <div>Upscale: {previewUpscaleActive ? 'on' : 'off'}</div>
                    <div>Host: {previewHostDiagnostics.hostWidth}x{previewHostDiagnostics.hostHeight}px</div>
                    <div>Canvas: {previewHostDiagnostics.canvasWidth}x{previewHostDiagnostics.canvasHeight}px</div>
                    <div>Host ID: {previewHostDiagnostics.hostId}</div>
                    <div>Mounts: {previewHostDiagnostics.mountCount} / Unmounts: {previewHostDiagnostics.unmountCount}</div>
                    <div>Invalid dims: {previewHostDiagnostics.invalidDimensions || previewDimensionIssues ? 'yes' : 'no'}</div>
                    <div>Post-frame invalid: {previewPostFrameInvalid ? 'yes' : 'no'}</div>
                    <div>Host==Logical: {previewHostDiagnostics.hostWidth === PREVIEW_SCENE_WIDTH && previewHostDiagnostics.hostHeight === PREVIEW_SCENE_HEIGHT ? 'yes' : 'no'}</div>
                    <div>Canvas==Logical: {previewElementDiagnostics.canvas?.clientWidth === PREVIEW_SCENE_WIDTH && previewElementDiagnostics.canvas?.clientHeight === PREVIEW_SCENE_HEIGHT ? 'yes' : 'no'}</div>
                    <div>CanvasBacking==Logical: {previewCanvasBackingMatchesLogical ? 'yes' : 'no'}</div>
                    <div>Reset count: {previewLayoutResetCount}</div>
                    <div>Mode transition: {previewTransitionSnapshot.previousMode} {'->'} {previewTransitionSnapshot.nextMode}</div>
                    <div>Prev present: {previewTransitionSnapshot.previousPresentation.width}x{previewTransitionSnapshot.previousPresentation.height}</div>
                    <div>Next present: {previewTransitionSnapshot.nextPresentation.width}x{previewTransitionSnapshot.nextPresentation.height}</div>
                    <div>Prev scale: {Number(previewTransitionSnapshot.previousScale || 0).toFixed(3)}</div>
                    <div>Next scale: {Number(previewTransitionSnapshot.nextScale || 0).toFixed(3)}</div>
                    <div>Reset ran: {previewTransitionSnapshot.resetRan ? 'yes' : 'no'} ({previewTransitionSnapshot.reason})</div>
                    <div>Initial layout ready: {previewInitialLayoutReady ? 'yes' : 'no'}</div>
                    <div>Initial recompute ran: {previewInitialComputeRan ? 'yes' : 'no'}</div>
                    <div>Initial measured VP: {previewMeasuredViewportForInitial.width}x{previewMeasuredViewportForInitial.height}px</div>
                    <div>Viewport shell: {previewElementDiagnostics.viewport?.clientWidth || 0}/{previewElementDiagnostics.viewport?.offsetWidth || 0}/{previewElementDiagnostics.viewport?.rectWidth || 0}</div>
                    <div>FitSourceStable: {previewElementDiagnostics.fitSourceStable ? 'yes' : 'no'}</div>
                    <div>Fit source changed after scale changed: {previewElementDiagnostics.fitSourceChangedAfterScaleChange ? 'yes' : 'no'}</div>
                    <div>Fit source rect: {previewElementDiagnostics.fitSource?.rectWidth || 0}x{previewElementDiagnostics.fitSource?.rectHeight || 0}</div>
                    <div>Presentation rect: {previewElementDiagnostics.presentation?.rectWidth || 0}x{previewElementDiagnostics.presentation?.rectHeight || 0}</div>
                    <div>Effective fit box: {previewElementDiagnostics.effectiveFitBox?.width || 0}x{previewElementDiagnostics.effectiveFitBox?.height || 0}</div>
                    <div>Effective differs: {previewElementDiagnostics.effectiveFitBox?.differsFromRaw ? 'yes' : 'no'}</div>
                    <div>Presentation box: {previewElementDiagnostics.presentation?.clientWidth || 0}/{previewElementDiagnostics.presentation?.offsetWidth || 0}/{previewElementDiagnostics.presentation?.rectWidth || 0}</div>
                    <div>Logical box: {previewElementDiagnostics.logical?.clientWidth || 0}/{previewElementDiagnostics.logical?.offsetWidth || 0}/{previewElementDiagnostics.logical?.rectWidth || 0}</div>
                    <div>Displayed rect: {previewElementDiagnostics.displayedRect?.width || 0}x{previewElementDiagnostics.displayedRect?.height || 0}</div>
                    <div>Composition fully visible: {previewElementDiagnostics.compositionVisible ? 'yes' : 'no'}</div>
                    <div>Host box: {previewElementDiagnostics.host?.clientWidth || 0}/{previewElementDiagnostics.host?.offsetWidth || 0}/{previewElementDiagnostics.host?.rectWidth || 0}</div>
                    <div>Canvas box: {previewElementDiagnostics.canvas?.clientWidth || 0}/{previewElementDiagnostics.canvas?.offsetWidth || 0}/{previewElementDiagnostics.canvas?.rectWidth || 0}</div>
                    <div>Canvas attrs: {previewElementDiagnostics.canvasAttributes?.width || 0}x{previewElementDiagnostics.canvasAttributes?.height || 0}</div>
                  </div>
                )}
                <div ref={previewResizeProxyRef} className="scene-preview-resize-proxy" aria-hidden="true" />
                <div ref={previewPresentationRef} className="scene-preview-presentation" style={previewPresentationStyle}>
                <div ref={previewLogicalRootRef} className="scene-preview-logical-root" style={logicalCompositionStyle}>
                <div
                  ref={previewStageRef}
                  className={`studio-scene-stage ${workspaceLayout.showSceneGrid ? 'show-grid' : ''}${process.env.NODE_ENV === 'development' ? ' studio-scene-stage--debug-host' : ''}`}
                  style={previewStageStyle}
                >
                  <canvas ref={previewCanvasRef} style={previewCanvasStyle} className={`preview-strip-canvas${process.env.NODE_ENV === 'development' ? ' preview-strip-canvas--debug' : ''}`} />

                  {selectedClipSpanStyle ? (
                    <div className="scene-selected-clip-span" style={selectedClipSpanStyle}>
                      <span>{selectedClip.trackKind === 'intent' ? (selectedClip.intentKind || 'intent') : selectedClip.trackKind}</span>
                    </div>
                  ) : null}

                  <div className={`scene-overlay scene-overlay--composition ${activeWorkspaceTab === 'composition' ? 'active' : ''}`}>
                    {/* Explicit cross-hair lines drawn above quadrant cells */}
                    <div className="comp-guide-h" aria-hidden="true" />
                    <div className="comp-guide-v" aria-hidden="true" />
                    <button
                      type="button"
                      className={`quadrant-guide q1${selectedClipRegion === 'q1' ? ' highlighted' : ''}`}
                      onClick={() => handleCompositionRegionFocus('q1')}
                      title="Set authoring region context to Q1"
                    >
                      Q1
                    </button>
                    <button
                      type="button"
                      className={`quadrant-guide q2${selectedClipRegion === 'q2' ? ' highlighted' : ''}`}
                      onClick={() => handleCompositionRegionFocus('q2')}
                      title="Set authoring region context to Q2"
                    >
                      Q2
                    </button>
                    <button
                      type="button"
                      className={`quadrant-guide q3${selectedClipRegion === 'q3' ? ' highlighted' : ''}`}
                      onClick={() => handleCompositionRegionFocus('q3')}
                      title="Set authoring region context to Q3"
                    >
                      Q3
                    </button>
                    <button
                      type="button"
                      className={`quadrant-guide q4${selectedClipRegion === 'q4' ? ' highlighted' : ''}`}
                      onClick={() => handleCompositionRegionFocus('q4')}
                      title="Set authoring region context to Q4"
                    >
                      Q4
                    </button>

                    {editorClips.filter((clip) => clip.trackKind === 'intent').map((clip) => (
                      <button
                        type="button"
                        key={clip.id}
                        className={`intent-chip ${clip.region || 'global'}${selectedClip?.id === clip.id ? ' selected' : ''}`}
                        title={`Intent Node\nType: ${clip.intentKind || 'intent'}\nRegion: ${clip.region || 'global'}\nTriggered at ${clip.startSec.toFixed(1)}s`}
                        onClick={() => selectClipById(clip.id)}
                      >
                        {clip.intentKind || 'intent'}
                      </button>
                    ))}
                  </div>

                  <div className={`scene-overlay scene-overlay--weather ${activeWorkspaceTab === 'weather' ? 'active' : ''}`}>
                    <div className="weather-overlay-chip" title={`Weather Node\nWind: ${schedulerSnapshot.weather.wind.toFixed(2)}\nDriven by timeline weather track`}>
                      <strong>Wind</strong>
                      <span>{schedulerSnapshot.weather.wind.toFixed(2)}</span>
                    </div>
                    <div className="weather-overlay-chip" title={`Weather Node\nRain: ${schedulerSnapshot.weather.rain.toFixed(2)}\nDriven by timeline weather track`}>
                      <strong>Rain</strong>
                      <span>{schedulerSnapshot.weather.rain.toFixed(2)}</span>
                    </div>
                    <div className="weather-overlay-chip" title={`Weather Node\nMist: ${schedulerSnapshot.weather.mist.toFixed(2)}\nDriven by timeline weather track`}>
                      <strong>Mist</strong>
                      <span>{schedulerSnapshot.weather.mist.toFixed(2)}</span>
                    </div>
                    <div className="weather-overlay-chip" title={`Weather Node\nFog buildup: ${schedulerSnapshot.weather.fogBuildup.toFixed(2)}\nFog clearing: ${schedulerSnapshot.weather.fogClearing.toFixed(2)}`}>
                      <strong>Fog</strong>
                      <span>{schedulerSnapshot.weather.fogBuildup.toFixed(2)} / {schedulerSnapshot.weather.fogClearing.toFixed(2)}</span>
                    </div>
                  </div>

                  <div className={`scene-overlay scene-overlay--diagnostics ${activeWorkspaceTab === 'diagnostics' && workspaceLayout.showDiagnosticsOverlay ? 'active' : ''}`}>
                    <StudioSectionBoundary sectionName="diagnostics-overlay">
                      <div className="diag-overlay-card" title="Diagnostics Overlay\nPerformance counters from active preview renderer">
                        <h4>Performance</h4>
                        <p>Frame ms: {(timing.avgFrameMs || 0).toFixed(2)}</p>
                        <p>Renderer ms: {(timing.rendererMs || 0).toFixed(2)}</p>
                      </div>
                      <div className="diag-overlay-card" title="Diagnostics Overlay\nDerived wet-surface metrics for current frame">
                        <h4>Surface</h4>
                        <p>Fog: {Math.round((previewStats.fog || 0) * 100)}%</p>
                        <p>Droplets: {previewStats.droplets || 0}</p>
                      </div>
                      <div className="diag-overlay-card" title="Diagnostics Overlay\nRunner-carve continuity metrics for current frame">
                        <h4>Runner Carve</h4>
                        <p>Mode: {timing.runnerCarveLastMode || 'none'}</p>
                        <p>Spacing/radius: {(timing.runnerCarveSpacingRatioMean || 0).toFixed(2)} mean / {(timing.runnerCarveSpacingRatioMax || 0).toFixed(2)} max</p>
                        <p>Gap risk: {(((timing.runnerCarveGapFraction || 0) * 100)).toFixed(1)}%</p>
                        <p>Depth gain: {(timing.runnerCarveDepthGainMean || 0).toFixed(4)}</p>
                        <p>Smooth retention: {(timing.runnerCarvePostSmoothRetentionMean || 0).toFixed(2)}</p>
                        <p>Recovery ratio: {(timing.runnerCarveRecoveryRatioMean || 0).toFixed(2)}</p>
                      </div>
                      <div className="diag-overlay-card" title="Diagnostics Overlay\nScheduler timeline and active event telemetry">
                        <h4>Scheduler</h4>
                        <p>Events: {schedulerSnapshot.activeIntentEvents?.length || 0}</p>
                        <p>Timeline: {selectedTimelineKey}</p>
                      </div>
                    </StudioSectionBoundary>
                  </div>

                  <div className={`scene-overlay scene-overlay--spatial ${activeWorkspaceTab === 'spatial' ? 'active' : ''}`}>
                    <StudioSectionBoundary sectionName="spatial-influence-overlay">
                      {regionInfluenceDiagnostics.map((regionSample) => (
                        <button
                          type="button"
                          key={regionSample.regionId}
                          className={`spatial-cell ${regionSample.regionId === (selectedClip?.region || compositionRegionContext || 'global') ? 'selected' : ''}`}
                          onClick={() => handleCompositionRegionFocus(regionSample.regionId)}
                        >
                          <h4>{regionSample.regionId.toUpperCase()}</h4>
                          <p>Wind {(regionSample.weather?.wind || 0).toFixed(2)}</p>
                          <p>Rain {(regionSample.weather?.rain || 0).toFixed(2)}</p>
                          <p>Mist {(regionSample.weather?.mist || 0).toFixed(2)}</p>
                          <p>Fog {(regionSample.weather?.fogBuildup || 0).toFixed(2)} / {(regionSample.weather?.fogClearing || 0).toFixed(2)}</p>
                        </button>
                      ))}
                    </StudioSectionBoundary>
                  </div>
                </div>
                </div>
                </div>
                </div>
                </div>
                </section>
              </div>
            </>
          </StudioSectionBoundary>
        ) : null}

      </main>

      <div

        className={`studio-splitter studio-splitter-right${panelState.right ? ' studio-splitter-disabled' : ''}`}

        onMouseDown={(event) => beginResize('right', event)}

        role="separator"

        aria-label="Resize inspector"

      />            <aside ref={rightPanelRef} className={`studio-right-panel${panelState.right ? ' is-collapsed' : ''}`}>
        <div className="studio-panel-header">
          <span>Inspector</span>
          {renderPanelActions('right', 'Inspector')}
        </div>

        {!panelState.right ? (
          <StudioSectionBoundary sectionName="inspector-rendering">
            <>
            {!selectedClip ? (
              <>
                {assetBrowserSelection?.type === 'scene' ? (
                  <section className="inspector-block">
                    <h3>Scene</h3>
                    <p className="inspector-item-id">{inspectedScene?.id || selectedScene?.id}</p>
                    <div className="inspector-group">
                      <h4>Scene</h4>
                      <div className="inspector-summary-row"><span>Inspected</span><span>{inspectedScene?.name || 'Active scene'}</span></div>
                      <label>
                        Active Scene
                        <select
                          value={activeSceneId}
                          onChange={(event) => { setActiveSceneId(event.target.value); setAssetBrowserSelection({ type: 'scene', id: event.target.value }) }}
                        >
                          {sceneCatalog.map((scene) => (
                            <option key={scene.id} value={scene.id}>{scene.name}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Active Preset
                        <select value={activePresetId} onChange={(event) => setActivePresetId(event.target.value)}>
                          {presetCatalog.map((preset) => (
                            <option key={preset.id} value={preset.id}>{preset.name}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Active Timeline
                        <select
                          value={activeTimelineId || timelineOptions[0]}
                          onChange={(event) => handleActiveTimelineChange(event.target.value)}
                        >
                          {timelineOptions.map((id) => (
                            <option key={id} value={id}>{id}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="inspector-group">
                      <h4>Startup Behavior</h4>
                      <label>
                        Startup Mode
                        <select
                          value={settings.startupMode || 'studio'}
                          onChange={(event) => updateSettings((prev) => ({ ...prev, startupMode: event.target.value }))}
                        >
                          {Object.values(STARTUP_MODES).map((mode) => (
                            <option key={mode} value={mode}>{mode}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </section>
                ) : assetBrowserSelection?.type === 'timeline' ? (
                  <section className="inspector-block">
                    <h3>Timeline</h3>
                    <p className="inspector-item-id">{inspectedTimeline?.id || selectedTimeline?.id}</p>
                    <div className="inspector-group">
                      <h4>Timeline</h4>
                      <div className="inspector-summary-row"><span>Inspected</span><span>{inspectedTimeline?.name || 'Active timeline'}</span></div>
                      <div className="inspector-summary-row"><span>Active</span><span>{selectedTimeline?.name || activeTimelineId || 'None'}</span></div>
                      <p className="asset-empty">Asset Browser timeline clicks inspect only. Use Active Timeline here to drive preview and save.</p>
                      <label>
                        Active Timeline
                        <select
                          value={activeTimelineId || timelineOptions[0]}
                          onChange={(event) => handleActiveTimelineChange(event.target.value)}
                        >
                          {timelineOptions.map((id) => (
                            <option key={id} value={id}>{id}</option>
                          ))}
                        </select>
                      </label>
                      <div className="inspector-summary-row"><span>Duration</span><span>{timelineDurationSec.toFixed(0)}s</span></div>
                      <div className="inspector-summary-row"><span>Weather Clips</span><span>{editorClips.filter((c) => c.trackKind !== 'intent').length}</span></div>
                      <div className="inspector-summary-row"><span>Intent Events</span><span>{editorClips.filter((c) => c.trackKind === 'intent').length}</span></div>
                    </div>
                    <div className="inspector-group">
                      <h4>Playback</h4>
                      <label className="inspector-toggle-row">
                        Loop
                        <input type="checkbox" checked={loopPlayback} onChange={(event) => setLoopPlayback(event.target.checked)} />
                      </label>
                    </div>
                  </section>
                ) : assetBrowserSelection?.type === 'preset' ? (
                  <section className="inspector-block">
                    <h3>Preset</h3>
                    <p className="inspector-item-id">{inspectedPreset?.id || activePresetId}</p>
                    <div className="inspector-group">
                      <h4>Active Preset</h4>
                      <div className="inspector-summary-row"><span>Inspected</span><span>{inspectedPreset?.name || 'Active preset'}</span></div>
                      <label>
                        Preset
                        <select
                          value={activePresetId}
                          onChange={(event) => { setActivePresetId(event.target.value); setAssetBrowserSelection({ type: 'preset', id: event.target.value }) }}
                        >
                          {presetCatalog.map((preset) => (
                            <option key={preset.id} value={preset.id}>{preset.name}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </section>
                ) : (
                  <>
                    <section className="inspector-block inspector-block--summary">
                      <h3>Workspace Summary</h3>
                      <div className="inspector-group">
                        <h4>Active Context</h4>
                        <div className="inspector-summary-row"><span>Scene</span><span>{selectedScene?.name || '—'}</span></div>
                        <div className="inspector-summary-row"><span>Preset</span><span>{presetCatalog.find((p) => p.id === activePresetId)?.name || activePresetId}</span></div>
                        <div className="inspector-summary-row"><span>Timeline</span><span>{selectedTimeline?.name || selectedTimeline?.id}</span></div>
                        <div className="inspector-summary-row"><span>Duration</span><span>{timelineDurationSec.toFixed(0)}s</span></div>
                        <div className="inspector-summary-row"><span>Clips</span><span>{editorClips.filter((c) => c.trackKind !== 'intent').length} weather · {editorClips.filter((c) => c.trackKind === 'intent').length} intent</span></div>
                      </div>
                      <div className="inspector-group">
                        <h4>Session</h4>
                        <div className="inspector-summary-row"><span>Startup Mode</span><span>{settings.startupMode || 'studio'}</span></div>
                        <div className="inspector-summary-row"><span>Loop</span><span>{loopPlayback ? 'On' : 'Off'}</span></div>
                        <div className="inspector-summary-row"><span>Composition Guides</span><span>{activeWorkspaceTab === 'composition' ? 'On' : 'Off'}</span></div>
                        <div className="inspector-summary-row"><span>Authoring Region</span><span>{String(activeAuthoringRegion || 'global').toUpperCase()}</span></div>
                        <div className="inspector-summary-row"><span>Playhead</span><span>{timelinePlayheadSec.toFixed(1)}s</span></div>
                      </div>
                      <div className="inspector-group">
                        <h4>Verification</h4>
                        <label>
                          Scenario
                          <select
                            value={selectedVerificationScenarioId}
                            onChange={(event) => setSelectedVerificationScenarioId(event.target.value)}
                          >
                            {verificationScenarioRegistry.map((scenario) => (
                              <option key={scenario.id} value={scenario.id}>{scenario.label}</option>
                            ))}
                          </select>
                        </label>
                        <div className="inspector-summary-row"><span>Last Status</span><span>{verificationStatusLabel}</span></div>
                        <div className="inspector-summary-row"><span>Scenario</span><span>{verificationScenarioLabel}</span></div>
                        <div className="inspector-summary-row"><span>Pass/Fail</span><span>{latestVerificationArtifact ? (latestVerificationArtifact.pass ? 'Pass' : 'Fail') : 'n/a'}</span></div>
                        <div className="inspector-summary-row"><span>Latest Report</span><span>{verificationReportReadyLabel}</span></div>
                        <div className="inspector-summary-row"><span>Sample Count</span><span>{verificationSampleCount}</span></div>
                        <div className="inspector-summary-row"><span>publishRevision</span><span>{latestVerificationArtifact?.publishRevision ?? 'n/a'}</span></div>
                        <div className="inspector-summary-row"><span>restartToken</span><span>{latestVerificationArtifact?.restartToken || 'n/a'}</span></div>
                        <div className="inspector-summary-row"><span>Run At</span><span>{verificationCreatedAtLabel}</span></div>
                        <div className="inspector-quick-actions">
                          <button
                            type="button"
                            className="inspector-action-btn"
                            onClick={() => {
                              void handleRunVerificationCurrentTimeline()
                            }}
                            disabled={verificationRunning || hasUnsavedChanges || !savedDocument || !resolvedVerificationScenario}
                          >
                            {verificationRunning ? 'Running...' : 'Run Verification'}
                          </button>
                          <button
                            type="button"
                            className="inspector-action-btn"
                            onClick={exportLatestVerificationReport}
                            disabled={!latestVerificationArtifact}
                          >
                            Export Latest Verification Report
                          </button>
                          <button
                            type="button"
                            className="inspector-action-btn"
                            onClick={() => {
                              void handleRunVerificationAndExportReport()
                            }}
                            disabled={verificationRunning || hasUnsavedChanges || !savedDocument || !resolvedVerificationScenario}
                          >
                            Run Verification + Export Report
                          </button>
                          <button
                            type="button"
                            className="inspector-action-btn"
                            onClick={() => {
                              void copyLatestVerificationArtifact()
                            }}
                            disabled={!latestVerificationArtifact}
                          >
                            Copy JSON
                          </button>
                        </div>
                        {latestVerificationArtifact ? (
                          <details>
                            <summary>Latest Verification Report JSON</summary>
                            <pre style={{ maxHeight: '160px', overflow: 'auto', margin: '8px 0 0', padding: '8px', borderRadius: '6px', background: 'rgba(10, 14, 20, 0.46)' }}>
                              {JSON.stringify(latestVerificationArtifact, null, 2)}
                            </pre>
                          </details>
                        ) : null}
                        {recentVerificationRuns.length > 0 ? (
                          <div className="inspector-summary-row"><span>Recent Runs</span><span>{recentVerificationRuns.length}</span></div>
                        ) : null}
                      </div>
                      <div className="inspector-group">
                        <h4>Quick Actions</h4>
                        <div className="inspector-quick-actions">
                          <button
                            type="button"
                            className="inspector-action-btn inspector-action-btn--icon"
                            onClick={() => executeCommand('transport.play', { closeMenu: false, restoreFocus: false })}
                            aria-label="Play timeline from current playhead"
                            title="Play timeline"
                          >
                            <StudioIcon name="play" className="studio-icon-glyph" />
                          </button>
                          <button
                            type="button"
                            className="inspector-action-btn inspector-action-btn--icon"
                            onClick={() => executeCommand('transport.stop', { closeMenu: false, restoreFocus: false })}
                            aria-label="Stop timeline and return to start"
                            title="Stop timeline"
                          >
                            <StudioIcon name="stop" className="studio-icon-glyph" />
                          </button>
                          <button
                            type="button"
                            className="inspector-action-btn inspector-action-btn--icon"
                            onClick={() => executeCommand('workspace.utility.toggle', { closeMenu: false, restoreFocus: false })}
                            aria-label={workspaceLayout.utilityPanelOpen ? 'Hide advanced tuning panel' : 'Show advanced tuning panel'}
                            title={workspaceLayout.utilityPanelOpen ? 'Hide advanced tuning' : 'Show advanced tuning'}
                          >
                            <StudioIcon name="tuning" className="studio-icon-glyph" />
                          </button>
                        </div>
                      </div>
                    </section>

                    <StudioSectionBoundary sectionName="validation-authoring-controls">
                      <section className="inspector-block">
                      <h3>Validation Authoring</h3>
                      <p>Create the three vertical-slice verification scenarios directly on the timeline.</p>
                      <div className="inspector-group">
                        <h4>Scenario 1: Global Wind Ramp</h4>
                        <label>
                          Start
                          <input type="number" min="0" max={timelineDurationSec} step="1" value={validationDraft.windStartSec} onChange={(event) => setValidationField('windStartSec', Number(event.target.value))} />
                        </label>
                        <label>
                          Duration
                          <input type="number" min="1" max={timelineDurationSec} step="1" value={validationDraft.windDurationSec} onChange={(event) => setValidationField('windDurationSec', Number(event.target.value))} />
                        </label>
                        <label>
                          Intensity
                          <input type="range" min="0" max="1" step="0.01" value={validationDraft.windIntensity} onChange={(event) => setValidationField('windIntensity', Number(event.target.value))} />
                        </label>
                        <label>
                          Blend In / Out
                          <div className="inspector-inline-fields">
                            <input type="number" min="0" max="30" step="0.5" value={validationDraft.windBlendInSec} onChange={(event) => setValidationField('windBlendInSec', Number(event.target.value))} />
                            <input type="number" min="0" max="30" step="0.5" value={validationDraft.windBlendOutSec} onChange={(event) => setValidationField('windBlendOutSec', Number(event.target.value))} />
                          </div>
                        </label>
                        <button type="button" className="inspector-action-btn" onClick={addValidationWindRamp}>Add Wind Ramp Clip</button>
                      </div>
                      <div className="inspector-group">
                        <h4>Scenario 2: Regional Mist</h4>
                        <label>
                          Target Region
                          <select value={validationDraft.regionTarget} onChange={(event) => setValidationField('regionTarget', event.target.value)}>
                            {REGION_IDS.filter((id) => id !== 'global').map((regionId) => (
                              <option key={regionId} value={regionId}>{regionId}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Start / Duration
                          <div className="inspector-inline-fields">
                            <input type="number" min="0" max={timelineDurationSec} step="1" value={validationDraft.regionStartSec} onChange={(event) => setValidationField('regionStartSec', Number(event.target.value))} />
                            <input type="number" min="1" max={timelineDurationSec} step="1" value={validationDraft.regionDurationSec} onChange={(event) => setValidationField('regionDurationSec', Number(event.target.value))} />
                          </div>
                        </label>
                        <label>
                          Intensity
                          <input type="range" min="0" max="1" step="0.01" value={validationDraft.regionIntensity} onChange={(event) => setValidationField('regionIntensity', Number(event.target.value))} />
                        </label>
                        <button type="button" className="inspector-action-btn" onClick={addValidationRegionalMist}>Add Regional Mist Clip</button>
                      </div>
                      <div className="inspector-group">
                        <h4>Scenario 3: Clock Reveal Intent</h4>
                        <label>
                          Start / Duration
                          <div className="inspector-inline-fields">
                            <input type="number" min="0" max={timelineDurationSec} step="1" value={validationDraft.intentStartSec} onChange={(event) => setValidationField('intentStartSec', Number(event.target.value))} />
                            <input type="number" min="1" max={timelineDurationSec} step="1" value={validationDraft.intentDurationSec} onChange={(event) => setValidationField('intentDurationSec', Number(event.target.value))} />
                          </div>
                        </label>
                        <label>
                          Target Region
                          <select value={validationDraft.intentRegion} onChange={(event) => setValidationField('intentRegion', event.target.value)}>
                            {REGION_IDS.map((regionId) => (
                              <option key={regionId} value={regionId}>{regionId}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Lead-In Seconds
                          <input type="number" min="0" max="20" step="0.5" value={validationDraft.intentLeadInSec} onChange={(event) => setValidationField('intentLeadInSec', Number(event.target.value))} />
                        </label>
                        <label>
                          Reveal / Recovery
                          <div className="inspector-inline-fields">
                            <select value={validationDraft.revealStyle} onChange={(event) => setValidationField('revealStyle', event.target.value)}>
                              <option value="soft-lift">soft-lift</option>
                              <option value="snap">snap</option>
                              <option value="surge">surge</option>
                            </select>
                            <select value={validationDraft.recoveryStyle} onChange={(event) => setValidationField('recoveryStyle', event.target.value)}>
                              <option value="gentle-settle">gentle-settle</option>
                              <option value="linger">linger</option>
                              <option value="washout">washout</option>
                            </select>
                          </div>
                        </label>
                        <button type="button" className="inspector-action-btn" onClick={addValidationClockReveal}>Add Clock Reveal Intent</button>
                      </div>
                      </section>
                    </StudioSectionBoundary>
                  </>
                )}
              </>
            ) : null}

            {selectedClip && selectedClip.trackKind !== 'intent' ? (
              <section className="inspector-block">
                <h3>State Clip Inspector</h3>
                <p>Clip: {selectedClip.id}</p>
                <p>{PRIMARY_WEATHER_CLIP_TYPES.includes(selectedClip.trackKind)
                  ? `${selectedClip.trackKind.toUpperCase()} schema: intensity, duration, blendInSec, blendOutSec, region`
                  : `Non-primary weather track: ${selectedClip.trackKind}`}</p>
                <div className="inspector-group">
                  <h4>Core</h4>
                  <label>
                    Intensity
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={selectedClip.intensity ?? 0.5}
                      onChange={(event) => updateSelectedClip({ intensity: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    Duration
                    <input
                      type="range"
                      min="1"
                      max={Math.max(1, (selectedTimeline?.duration?.seconds || 180) - selectedClip.startSec)}
                      step="1"
                      value={Math.max(1, selectedClip.endSec - selectedClip.startSec)}
                      onChange={(event) => updateSelectedClipDuration(Number(event.target.value))}
                    />
                  </label>
                </div>
                <div className="inspector-group">
                  <h4>Transitions</h4>
                  <label>
                    Blend In
                    <input
                      type="range"
                      min="0"
                      max="5"
                      step="0.1"
                      value={selectedClip.blendInSec ?? 1}
                      onChange={(event) => updateSelectedClip({ blendInSec: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    Blend Out
                    <input
                      type="range"
                      min="0"
                      max="5"
                      step="0.1"
                      value={selectedClip.blendOutSec ?? 1}
                      onChange={(event) => updateSelectedClip({ blendOutSec: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    Region
                    <select
                      value={selectedClip.region || 'global'}
                      onChange={(event) => updateSelectedClip({ region: event.target.value })}
                    >
                      {REGION_IDS.map((regionId) => (
                        <option key={regionId} value={regionId}>{regionId}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="inspector-group">
                  <h4>Pipeline Trace</h4>
                  <div className="inspector-summary-row"><span>Authoring</span><span>{selectedClip.trackKind} @ {(selectedClip.startSec || 0).toFixed(1)}s</span></div>
                  <div className="inspector-summary-row"><span>Compiler Track</span><span>{selectedClip.trackKind}:{selectedClip.region || 'global'}</span></div>
                  <div className="inspector-summary-row"><span>Envelope Points</span><span>{selectedCompiledTrack?.envelope?.length || 0}</span></div>
                  <div className="inspector-summary-row"><span>Envelope Sample</span><span>{(selectedClipTrackSample?.envelopeValue || 0).toFixed(3)}</span></div>
                  <div className="inspector-summary-row"><span>Region Weight</span><span>{(selectedClipTrackSample?.regionWeight || 0).toFixed(3)}</span></div>
                  <div className="inspector-summary-row"><span>Runtime Contribution</span><span>{(selectedClipTrackSample?.contribution || 0).toFixed(3)}</span></div>
                  <div className="inspector-summary-row"><span>Preview Driver</span><span>droplets {previewDriveSnapshot.dropletsPerSeconds}</span></div>
                </div>
              </section>
            ) : null}

            {selectedClip?.trackKind === 'intent' ? (
              <section className="inspector-block">
                <h3>Intent Clip Inspector</h3>
                <p>Clip: {selectedClip.id}</p>
                <p>Concrete workflow: Clock Reveal compiles into weather bias through timeline runtime.</p>
                <div className="inspector-group">
                  <h4>Intent</h4>
                  <label>
                    Intent Type
                    <select
                      value={selectedClip.intentKind || 'clock-reveal'}
                      onChange={(event) => updateSelectedClip({ intentKind: event.target.value })}
                    >
                      {INTENT_KINDS.map((intentKind) => (
                        <option key={intentKind} value={intentKind}>{intentKind}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Target Region
                    <select
                      value={selectedClip.region || 'global'}
                      onChange={(event) => updateSelectedClip({ region: event.target.value })}
                    >
                      {REGION_IDS.map((regionId) => (
                        <option key={regionId} value={regionId}>{regionId}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="inspector-group">
                  <h4>Timing Behavior</h4>
                  <label>
                    Start Time
                    <input
                      type="range"
                      min="0"
                      max={Math.max(0, timelineDurationSec - 1)}
                      step="0.5"
                      value={selectedClip.startSec}
                      onChange={(event) => {
                        const startSec = Number(event.target.value)
                        const durationSec = Math.max(0.1, selectedClip.endSec - selectedClip.startSec)
                        updateSelectedClip({ startSec, endSec: startSec + durationSec })
                      }}
                    />
                  </label>
                  <label>
                    Duration
                    <input
                      type="range"
                      min="1"
                      max={Math.max(1, timelineDurationSec - selectedClip.startSec)}
                      step="0.5"
                      value={Math.max(1, selectedClip.endSec - selectedClip.startSec)}
                      onChange={(event) => updateSelectedClipDuration(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    Lead-in Behavior
                    <select
                      value={selectedClip.leadInBehavior || 'soft-ramp'}
                      onChange={(event) => updateSelectedClip({ leadInBehavior: event.target.value })}
                    >
                      <option value="soft-ramp">soft-ramp</option>
                      <option value="instant">instant</option>
                      <option value="hold-then-release">hold-then-release</option>
                    </select>
                  </label>
                  <label>
                    Lead-in Duration (sec)
                    <input
                      type="number"
                      min="0"
                      max="20"
                      step="0.5"
                      value={selectedClip.payload?.leadInSec ?? 2}
                      onChange={(event) => updateSelectedClip({
                        payload: {
                          ...(selectedClip.payload || {}),
                          leadInSec: Number(event.target.value),
                        },
                      })}
                    />
                  </label>
                  <label>
                    Reveal Style
                    <select
                      value={selectedClip.payload?.revealStyle || 'soft-lift'}
                      onChange={(event) => updateSelectedClip({
                        payload: {
                          ...(selectedClip.payload || {}),
                          revealStyle: event.target.value,
                        },
                      })}
                    >
                      <option value="soft-lift">soft-lift</option>
                      <option value="snap">snap</option>
                      <option value="surge">surge</option>
                    </select>
                  </label>
                  <label>
                    Recovery Style
                    <select
                      value={selectedClip.payload?.recoveryStyle || 'gentle-settle'}
                      onChange={(event) => updateSelectedClip({
                        payload: {
                          ...(selectedClip.payload || {}),
                          recoveryStyle: event.target.value,
                        },
                      })}
                    >
                      <option value="gentle-settle">gentle-settle</option>
                      <option value="linger">linger</option>
                      <option value="washout">washout</option>
                    </select>
                  </label>
                </div>
                <div className="inspector-group">
                  <h4>Pipeline Trace</h4>
                  <div className="inspector-summary-row"><span>Compiler Event</span><span>{selectedClip.intentKind || 'clock-reveal'}</span></div>
                  <div className="inspector-summary-row"><span>Region Weight</span><span>{(selectedIntentSample?.regionWeight || 0).toFixed(3)}</span></div>
                  <div className="inspector-summary-row"><span>Mist Bias</span><span>{(selectedIntentSample?.contribution?.mist || 0).toFixed(3)}</span></div>
                  <div className="inspector-summary-row"><span>Fog Buildup Bias</span><span>{(selectedIntentSample?.contribution?.fogBuildup || 0).toFixed(3)}</span></div>
                  <div className="inspector-summary-row"><span>Fog Clearing Bias</span><span>{(selectedIntentSample?.contribution?.fogClearing || 0).toFixed(3)}</span></div>
                </div>
              </section>
            ) : null}
            </>
          </StudioSectionBoundary>
        ) : null}

        {!panelState.right ? (
          workspaceLayout.utilityPanelOpen ? (
            <section className="studio-utility-panel open docked">
              <div className="utility-header">
                <h3>Advanced Weather Tuning Panel</h3>
                <button
                  type="button"
                  onClick={() => updateWorkspaceLayout({ utilityPanelOpen: false }, true)}
                  aria-label="Hide advanced tuning panel"
                  title="Hide advanced tuning panel"
                >
                  <StudioIcon name="tuning" className="studio-icon-glyph" />
                </button>
              </div>
              <p className="utility-subtitle">Optional instrumentation for troubleshooting after timeline authoring decisions are in place.</p>
              <div className="section-tabs utility-tabs" role="tablist" aria-label="Advanced tuning tabs">
                {ADVANCED_TUNING_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={activeUtilityTab === tab.id ? 'active' : ''}
                    onClick={() => setActiveUtilityTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="utility-scroll">
                {activeUtilityConfig.groups.map((group) => {
                  const controls = (group.controls || [])
                    .map((path) => ({ path, definition: CONTROL_INDEX.controls.get(path) }))
                    .filter((entry) => Boolean(entry.definition))
                  const toggles = (group.toggles || [])
                    .map((path) => ({ path, definition: CONTROL_INDEX.toggles.get(path) }))
                    .filter((entry) => Boolean(entry.definition))
                  const selects = (group.selects || [])
                    .map((path) => ({ path, definition: CONTROL_INDEX.selects.get(path) }))
                    .filter((entry) => Boolean(entry.definition))

                  if (!controls.length && !toggles.length && !selects.length) {
                    return null
                  }

                  return (
                    <section key={`${activeUtilityConfig.id}-${group.id}`} className="utility-group-block">
                      <div className="utility-group-header">
                        <h4>{group.label}</h4>
                        {group.description ? <p>{group.description}</p> : null}
                      </div>

                      {controls.map(({ path, definition }) => {
                        const value = Number(getByPath(tuningConfig, path) ?? definition.min)
                        const isInteger = Number(definition.step) >= 1
                        return (
                          <label key={`${group.id}-${path}`} className="utility-control-row" title={definition.tooltip || group.label}>
                            <span>{definition.label}</span>
                            <span>{formatControlValue(value, definition.step)}</span>
                            <input
                              type="range"
                              min={definition.min}
                              max={definition.max}
                              step={definition.step}
                              value={value}
                              onChange={(event) => setAdvancedNumericControl(path, event.target.value, isInteger)}
                            />
                          </label>
                        )
                      })}

                      {toggles.map(({ path, definition }) => (
                        <label key={`${group.id}-${path}`} className="utility-toggle-row" title={definition.tooltip || group.label}>
                          <span>{definition.label}</span>
                          <input
                            type="checkbox"
                            checked={Boolean(getByPath(tuningConfig, path))}
                            onChange={(event) => setAdvancedToggleControl(path, event.target.checked)}
                          />
                        </label>
                      ))}

                      {selects.map(({ path, definition }) => (
                        <label key={`${group.id}-${path}`} className="utility-select-row" title={definition.tooltip || group.label}>
                          <span>{definition.label}</span>
                          <select
                            value={String(getByPath(tuningConfig, path) ?? definition.options?.[0] ?? '')}
                            onChange={(event) => setAdvancedSelectControl(path, event.target.value)}
                          >
                            {(definition.options || []).map((option) => (
                              <option key={`${path}-${option}`} value={option}>{option}</option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </section>
                  )
                })}
              </div>
            </section>
          ) : (
            <button
              type="button"
              className="studio-utility-restore-tab"
              onClick={() => updateWorkspaceLayout({ utilityPanelOpen: true }, true)}
              aria-label="Show advanced tuning panel"
              title="Show advanced tuning panel"
            >
              <StudioIcon name="tuning" className="studio-icon-glyph" />
            </button>
          )
        ) : null}
      </aside>

      <div
        className={`studio-splitter studio-splitter-bottom${isResizing?.type === 'bottom' ? ' active' : ''}${panelState.bottom ? ' studio-splitter-disabled' : ''}`}
        onMouseDown={(event) => beginResize('bottom', event)}
        onDoubleClick={toggleTimelineMaximize}
        role="separator"
        aria-label="Resize timeline"
        aria-orientation="horizontal"
        title={workspaceLayout.timelineMaximized ? 'Restore timeline height' : 'Drag to resize timeline. Double-click to maximize.'}
      />

      <section ref={bottomTimelineRef} className={`studio-bottom-timeline${panelState.bottom ? ' is-collapsed' : ''}`}>
        <div className="studio-panel-header">
          <span>Atmosphere Timeline</span>
          {renderPanelActions('bottom', 'Timeline')}
        </div>
        {!panelState.bottom ? (
          <StudioSectionBoundary sectionName="timeline-editor">
            <TimelineEditor
              key={selectedTimelineKey}
              initialClips={editorClips}
              onClipsCommit={setEditorClips}
              onClipSelect={handleTimelineClipSelected}
              selectedClipId={selectedTimelineSelection?.clipId || null}
              authoringRegionContext={compositionRegionContext}
              playheadSec={timelinePlayheadSec}
              totalDurationSec={selectedTimeline?.duration?.seconds || 180}
              playbackMode={transportMode}
              loopEnabled={loopPlayback}
              eventLabelDensity={workspaceLayout.timelineEventLabels}
              defaultSnapSeconds={workspaceLayout.timelineSnapSeconds}
              defaultFitToContent={workspaceLayout.timelineFitToWindow}
              onSnapChange={(next) => updateWorkspaceLayout({ timelineSnapSeconds: next }, true)}
              onFitToContentChange={(next) => updateWorkspaceLayout({ timelineFitToWindow: next }, true)}
              onEventLabelDensityChange={(next) => updateWorkspaceLayout({ timelineEventLabels: next }, true)}
              onTransportPlay={handleTransportPlay}
              onTransportPause={handleTransportPause}
              onTransportStop={handleTransportStop}
              onTransportRewindStart={handleTransportRewindStart}
              onTransportFastForwardStart={handleTransportFastForwardStart}
              onTransportShuttleEnd={handleTransportShuttleEnd}
              onTransportSkip={handleTransportSkip}
              onLoopToggle={setLoopPlayback}
              onScrubStart={handleScrubStart}
              onScrub={handleScrub}
              onScrubEnd={handleScrubEnd}
            />
          </StudioSectionBoundary>
        ) : null}
      </section>

      <footer className="studio-footer" role="contentinfo" aria-label="Studio footer controls">
        <div className="studio-footer-scroll">
          <div className="studio-footer-zoom" role="group" aria-label="UI size">
            <span className="studio-footer-zoom-icon" aria-hidden="true">
              <StudioIcon name="type" className="studio-icon-glyph" />
            </span>
            <button
              type="button"
              className="studio-footer-icon-btn"
              onClick={() => stepUiFontSize(-1)}
              aria-label="Decrease font size"
              title="Decrease font size"
            >
              <StudioIcon name="minus" className="studio-icon-glyph" />
            </button>
            <input
              type="range"
              min="0"
              max={String(UI_FONT_STEPS.length - 1)}
              step="1"
              value={uiFontIndex}
              onChange={(event) => setUiFontSize(UI_FONT_STEPS[Number(event.target.value)])}
              aria-label="Studio font size"
            />
            <button
              type="button"
              className="studio-footer-icon-btn"
              onClick={() => stepUiFontSize(1)}
              aria-label="Increase font size"
              title="Increase font size"
            >
              <StudioIcon name="plus" className="studio-icon-glyph" />
            </button>
            <button
              type="button"
              className="studio-footer-icon-btn"
              onClick={() => setUiFontSize(DEFAULT_WORKSPACE_LAYOUT.uiFontPx)}
              aria-label="Reset font size to default"
              title="Reset font size"
            >
              <StudioIcon name="reset" className="studio-icon-glyph" />
            </button>
            <strong className="studio-footer-zoom-value">{workspaceLayout.uiFontPx}px</strong>
          </div>
          <div className="studio-footer-actions" role="group" aria-label="Runtime publish workflow">
            <button
              type="button"
              className="studio-footer-action-btn"
              onClick={() => executeCommand(WORKFLOW_COMMAND_IDS.save, { closeMenu: false, restoreFocus: false })}
              title={getMenuActionProps(WORKFLOW_COMMAND_IDS.save).label}
            >
              Save
            </button>
            <button
              type="button"
              className="studio-footer-action-btn studio-footer-action-btn--publish"
              onClick={() => executeCommand(WORKFLOW_COMMAND_IDS.updateDesktop, { closeMenu: false, restoreFocus: false })}
              disabled={getMenuActionProps(WORKFLOW_COMMAND_IDS.updateDesktop).disabled}
              title={getMenuActionProps(WORKFLOW_COMMAND_IDS.updateDesktop).label}
            >
              Update Desktop
            </button>
          </div>
          <div className="studio-footer-status" role="status" aria-live="polite">
            <span className="studio-footer-chip">
              Project: {activeProjectLabel}
            </span>
            <span className={`studio-footer-chip${hasUnsavedChanges ? ' is-warning' : ' is-ok'}`}>
              Working: {saveStatusLabel}
            </span>
            <span className={`studio-footer-chip${publishIsOutdated ? ' is-warning' : ' is-ok'}`}>
              {publishStateLabel}
            </span>
            {projectLoadWarning ? (
              <span className="studio-footer-chip is-warning">
                Warning: {projectLoadWarning}
              </span>
            ) : null}
            {desktopSwitchFallbackVisible ? (
              <button
                type="button"
                className="studio-footer-chip studio-footer-chip-button"
                onClick={() => attemptSwitchToPresentationWindow('manual-fallback')}
                title="Open or focus the Presentation window"
              >
                Desktop updated - click to switch
              </button>
            ) : null}
          </div>
        </div>
      </footer>

    </div>
  )
}

class StudioSectionBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error) {
    const sectionName = this.props.sectionName || 'unknown-section'
    console.error(`[Studio] Section failed to render: ${sectionName}`, error)
  }

  componentDidUpdate(prevProps) {
    if (prevProps.sectionName !== this.props.sectionName && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    return (
      <div className="studio-section-fallback" role="status">
        <strong>Section unavailable</strong>
        <span>{this.props.sectionName || 'Unknown Studio section'} failed safely.</span>
      </div>
    )
  }
}

function getSampleUvForRegion(regionId) {
  return REGION_SAMPLE_UV[regionId] || REGION_SAMPLE_UV.global
}

function normalizeWorkspaceLayout(layout) {
  const normalizedPreviewMode = layout?.previewMode === 'fit'
    ? 'contain'
    : layout?.previewMode === 'scroll'
      ? 'native'
      : layout?.previewMode

  const safeBottomHeight = Math.max(MIN_TIMELINE_HEIGHT, Number(layout?.bottomHeight ?? DEFAULT_WORKSPACE_LAYOUT.bottomHeight))
  const safeRestoreHeight = Math.max(
    MIN_TIMELINE_HEIGHT,
    Number(layout?.timelineRestoreHeight ?? layout?.bottomHeight ?? DEFAULT_WORKSPACE_LAYOUT.timelineRestoreHeight),
  )

  const legacyFontFromScale = Number(layout?.uiScale) * BASE_UI_FONT_PX
  const rawFontPx = Number(layout?.uiFontPx)
  const resolvedFontPx = Number.isFinite(rawFontPx)
    ? rawFontPx
    : Number.isFinite(legacyFontFromScale)
      ? legacyFontFromScale
      : DEFAULT_WORKSPACE_LAYOUT.uiFontPx
  const uiFontPx = snapFontSizeStep(resolvedFontPx)

  return {
    ...DEFAULT_WORKSPACE_LAYOUT,
    ...(layout || {}),
    leftWidth: clamp(Number(layout?.leftWidth ?? DEFAULT_WORKSPACE_LAYOUT.leftWidth), MIN_LEFT_WIDTH, 460),
    rightWidth: clamp(Number(layout?.rightWidth ?? DEFAULT_WORKSPACE_LAYOUT.rightWidth), MIN_RIGHT_WIDTH, 520),
    bottomHeight: safeBottomHeight,
    timelineRestoreHeight: safeRestoreHeight,
    timelineMaximized: layout?.timelineMaximized === true,
    uiFontPx,
    uiScale: clamp(uiFontPx / BASE_UI_FONT_PX, UI_SCALE_MIN, UI_SCALE_MAX),
    density: layout?.density === 'compact' ? 'compact' : 'comfortable',
    timelineEventLabels: layout?.timelineEventLabels === 'compact'
      ? 'compact'
      : layout?.timelineEventLabels === 'full'
        ? 'full'
        : 'full',
    timelineSnapSeconds: [1, 5, 10].includes(Number(layout?.timelineSnapSeconds)) ? Number(layout.timelineSnapSeconds) : 1,
    timelineFitToWindow: layout?.timelineFitToWindow === true,
    assetCardSize: layout?.assetCardSize === 'large' ? 'large' : 'compact',
    previewMode: PREVIEW_MODES.includes(normalizedPreviewMode) ? normalizedPreviewMode : DEFAULT_WORKSPACE_LAYOUT.previewMode,
    previewZoom: clamp(Number(layout?.previewZoom ?? DEFAULT_WORKSPACE_LAYOUT.previewZoom), 0.25, 4),
    showPreviewDevReadout: layout?.showPreviewDevReadout === true,
    showSceneGrid: Boolean(layout?.showSceneGrid),
    showDiagnosticsOverlay: layout?.showDiagnosticsOverlay === true,
    showCompositionGuides: layout?.showCompositionGuides !== false,
    utilityPanelOpen: Boolean(layout?.utilityPanelOpen),
  }
}

function getFontStepIndex(fontPx) {
  const snapped = snapFontSizeStep(fontPx)
  const index = UI_FONT_STEPS.indexOf(snapped)
  return index >= 0 ? index : UI_FONT_STEPS.indexOf(DEFAULT_WORKSPACE_LAYOUT.uiFontPx)
}

function snapFontSizeStep(fontPx) {
  const value = Number(fontPx)
  if (!Number.isFinite(value)) {
    return DEFAULT_WORKSPACE_LAYOUT.uiFontPx
  }

  let nearest = UI_FONT_STEPS[0]
  let nearestDistance = Math.abs(value - nearest)
  for (const step of UI_FONT_STEPS) {
    const distance = Math.abs(value - step)
    if (distance < nearestDistance) {
      nearest = step
      nearestDistance = distance
    }
  }
  return nearest
}

function getScaledLayoutBounds(uiScale, density = 'comfortable') {
  const safeScale = clamp(Number(uiScale) || 1, UI_SCALE_MIN, UI_SCALE_MAX)
  const densityFactor = density === 'compact' ? 0.95 : 1
  const sizeScale = safeScale * densityFactor

  // Track rows, rulers, and group headers use fixed px heights and do not scale.
  // Only the panel header (based on --studio-control-min-height = 28*scale) and
  // the toolbar (calc(32px * scale)) actually grow with font size.
  const scaledHeaderPx = Math.round(28 * sizeScale) + Math.round(32 * sizeScale)
  const fixedContentPx = TIMELINE_RULER_HEIGHT
    + (TIMELINE_GROUP_COUNT * TIMELINE_GROUP_HEADER_HEIGHT)
    + (TIMELINE_STATE_TRACK_COUNT * TIMELINE_STATE_TRACK_HEIGHT)
    + (TIMELINE_EVENT_TRACK_COUNT * TIMELINE_EVENT_TRACK_HEIGHT)
    + TIMELINE_PANEL_VERTICAL_ALLOWANCE
  const maxTimelineHeight = scaledHeaderPx + fixedContentPx

  return {
    minLeftWidth: Math.round(MIN_LEFT_WIDTH * sizeScale),
    minRightWidth: Math.round(MIN_RIGHT_WIDTH * sizeScale),
    minCenterWidth: Math.round(MIN_CENTER_WIDTH * sizeScale),
    minTimelineHeight: Math.round(MIN_TIMELINE_HEIGHT * sizeScale),
    minSceneHeight: Math.round(MIN_SCENE_HEIGHT * sizeScale),
    maxLeftWidth: Math.round(460 * sizeScale),
    maxRightWidth: Math.round(520 * sizeScale),
    maxTimelineHeight,
    collapsedSidePanelWidth: Math.round(COLLAPSED_SIDE_PANEL_WIDTH * sizeScale),
    collapsedTimelineHeight: Math.round(COLLAPSED_TIMELINE_HEIGHT * sizeScale),
  }
}

function getByPath(source, path) {
  const segments = path.split('.')
  let cursor = source
  for (const segment of segments) {
    cursor = cursor?.[segment]
    if (cursor === undefined) {
      return undefined
    }
  }
  return cursor
}

function setByPath(source, path, value) {
  const segments = path.split('.')
  const output = Array.isArray(source) ? source.slice() : { ...source }
  let cursor = output

  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index]
    const next = cursor[key]
    cursor[key] = Array.isArray(next) ? next.slice() : { ...(next || {}) }
    cursor = cursor[key]
  }

  cursor[segments[segments.length - 1]] = value
  return output
}

function formatControlValue(value, step) {
  if (step >= 1) {
    return String(Math.round(value))
  }
  if (step >= 0.1) {
    return value.toFixed(1)
  }
  if (step >= 0.01) {
    return value.toFixed(2)
  }
  return value.toFixed(3)
}

function buildTuningControlIndex() {
  const controls = new Map()
  const toggles = new Map()
  const selects = new Map()

  TUNING_SCHEMA.forEach((section) => {
    ;(section.controls || []).forEach((control) => controls.set(control.path, control))
    ;(section.toggles || []).forEach((toggle) => toggles.set(toggle.path, toggle))
    ;(section.selects || []).forEach((select) => selects.set(select.path, select))
  })

  controls.set('debug.wetnessSmoothingStride', {
    path: 'debug.wetnessSmoothingStride',
    label: 'Wetness Smoothing Stride',
    min: 1,
    max: 8,
    step: 1,
    tooltip: 'Stride used during smoothing passes (higher values skip pixels for diagnostics).',
  })
  toggles.set('debug.wetnessRegionOnlySmoothing', {
    path: 'debug.wetnessRegionOnlySmoothing',
    label: 'Region-Only Smoothing',
    tooltip: 'Limit smoothing to active update regions for parity diagnostics.',
  })

  return { controls, toggles, selects }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function formatRuntimeTimestamp(value) {
  if (!value) {
    return 'n/a'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'n/a'
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default StudioPage
