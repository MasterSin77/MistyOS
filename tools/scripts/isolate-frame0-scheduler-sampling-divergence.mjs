import { chromium } from 'playwright'

const BASE_URL = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5183'
const TIMELINE_ID = process.env.MISTYOS_TIMELINE_ID || 'runner-carve-diagnosis'
const DETERMINISTIC_SEED = Number(process.env.MISTYOS_DETERMINISTIC_SEED || 133742)
const BOOT_TIMEOUT_MS = Number(process.env.MISTYOS_BOOT_TIMEOUT_MS || 20000)
const FLOAT_EPSILON = Number(process.env.MISTYOS_FLOAT_EPSILON || 1e-12)

const CAPTURED_EVENTS = new Set([
  'presentation-clock-reset',
  'presentation-runtime-payload-ready',
  'presentation-engine-created',
  'presentation-startup-begin',
  'pre-start-bootstrap-result',
  'pre-start-engine-state',
  'engine-started',
  'runtime-canonical-zero-sample',
  'runtime-first-scheduler-sample',
  'engine-first-tick',
])

function fail(details) {
  throw new Error(JSON.stringify({ ok: false, ...details }, null, 2))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nearlyEqual(left, right, epsilon = FLOAT_EPSILON) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= epsilon
}

function sanitizeValue(value) {
  return JSON.parse(JSON.stringify(value))
}

function compareRainTracks(left = [], right = []) {
  if (left.length !== right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (String(a?.trackKey || '') !== String(b?.trackKey || '')) {
      return false
    }
    if (JSON.stringify(a?.sourceClipIds || []) !== JSON.stringify(b?.sourceClipIds || [])) {
      return false
    }
    if (!nearlyEqual(a?.envelopeValue, b?.envelopeValue)) {
      return false
    }
    if (!nearlyEqual(a?.contribution, b?.contribution)) {
      return false
    }
    if (!nearlyEqual(a?.regionWeight, b?.regionWeight)) {
      return false
    }
    if (!nearlyEqual(a?.envelopeSampleSec, b?.envelopeSampleSec)) {
      return false
    }
    if (!nearlyEqual(a?.interpolationT, b?.interpolationT)) {
      return false
    }
    if (JSON.stringify(a?.previousPoint || null) !== JSON.stringify(b?.previousPoint || null)) {
      return false
    }
    if (JSON.stringify(a?.nextPoint || null) !== JSON.stringify(b?.nextPoint || null)) {
      return false
    }
  }

  return true
}

async function addDeterministicSeedScript(context, seed) {
  await context.addInitScript((seedValue) => {
    let state = (Number(seedValue) >>> 0) || 1
    const next = () => {
      state = (1664525 * state + 1013904223) >>> 0
      return state / 4294967296
    }

    Object.defineProperty(Math, 'random', {
      value: () => next(),
      writable: false,
      configurable: false,
    })
  }, seed)
}

async function publishRuntimePayload(page, timelineId) {
  const result = await page.evaluate(({ targetTimelineId }) => {
    const registryRaw = localStorage.getItem('mistyos.authoring.projects.v1')
    const activeProjectRaw = localStorage.getItem('mistyos.authoring.activeProjectId.v1')
    const registry = registryRaw ? JSON.parse(registryRaw) : { projects: [] }
    const activeProjectEntry = activeProjectRaw ? JSON.parse(activeProjectRaw) : {}
    const activeProjectId = String(activeProjectEntry?.projectId || registry?.projects?.[0]?.projectId || '').trim()

    if (!activeProjectId) {
      return { ok: false, reason: 'missing-active-project' }
    }

    const projectKey = `mistyos.authoring.project.v1.${activeProjectId}`
    const projectRaw = localStorage.getItem(projectKey)
    if (!projectRaw) {
      return { ok: false, reason: 'missing-project-document' }
    }

    const project = JSON.parse(projectRaw)
    const sourcePayload = project?.savedDocument?.runtimePayload || project?.publishedDocument?.runtimePayload || null
    const runtimePayload = sourcePayload
      ? JSON.parse(JSON.stringify(sourcePayload))
      : {
        schemaVersion: 1,
        selectedTimelineId: targetTimelineId,
        startupMode: 'immediate',
        timelineDurationSec: 180,
        loopPlayback: true,
        normalizedClips: [],
        authoredTimeline: null,
        settingsSnapshot: {},
      }

    runtimePayload.selectedTimelineId = targetTimelineId

    const nowIso = new Date().toISOString()
    const nextSavedRevision = Number(project?.savedDocument?.savedRevision || 0) + 1
    const nextPublishRevision = Number(project?.publishedDocument?.publishRevision || 0) + 1
    const restartToken = `frame0-sampling-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

    project.savedDocument = {
      schemaVersion: 1,
      savedRevision: nextSavedRevision,
      savedAt: nowIso,
      runtimePayload,
    }

    project.publishedDocument = {
      schemaVersion: 1,
      publishRevision: nextPublishRevision,
      publishedAt: nowIso,
      restartToken,
      fromSavedRevision: nextSavedRevision,
      runtimePayload,
    }

    localStorage.setItem(projectKey, JSON.stringify(project))
    localStorage.setItem('mistyos.authoring.activeProjectId.v1', JSON.stringify({ projectId: activeProjectId }))

    return { ok: true, publishRevision: nextPublishRevision, restartToken }
  }, { targetTimelineId: timelineId })

  if (!result?.ok) {
    fail({
      stage: 'bootstrap',
      metric: 'publishRuntimePayload',
      actualValue: result?.reason || 'unknown',
    })
  }
}

async function captureMode(page, mode) {
  const events = []
  const onConsole = async (message) => {
    if (message.type() !== 'info') {
      return
    }

    for (const arg of message.args()) {
      try {
        const value = await arg.jsonValue()
        if (!value || typeof value !== 'object') {
          continue
        }
        const eventName = typeof value.event === 'string' ? value.event : null
        if (eventName && CAPTURED_EVENTS.has(eventName)) {
          events.push({ event: eventName, payload: sanitizeValue(value) })
        }
      } catch {
        // Ignore non-serializable console args.
      }
    }
  }

  page.on('console', onConsole)
  await page.goto(`${BASE_URL}/?rdfxDebug=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const stats = window.__MISTYOS_PRESENTATION_STATS || {}
    return Array.isArray(stats.bootstrap?.initialFrameDiagnostics) && stats.bootstrap.initialFrameDiagnostics.length >= 1
  }, undefined, { timeout: BOOT_TIMEOUT_MS })
  await sleep(150)
  page.off('console', onConsole)

  const preStart = events.find((entry) => entry.event === 'pre-start-bootstrap-result')?.payload || null
  const canonicalZero = events.find((entry) => entry.event === 'runtime-canonical-zero-sample')?.payload || null
  const firstSample = events.find((entry) => entry.event === 'runtime-first-scheduler-sample')?.payload || null

  if (!preStart || !canonicalZero || !firstSample) {
    fail({
      stage: 'capture',
      metric: 'sampling-events-present',
      mode,
      foundEvents: events.map((entry) => entry.event),
    })
  }

  return {
    mode,
    events,
    ordering: events.map((entry) => entry.event),
    sampleAtZero: preStart.sampleAtZero,
    sampleAtFirstWindow: preStart.sampleAtFirstWindow,
    canonicalZeroSample: canonicalZero.sample,
    firstSample: firstSample.sample,
    frame0: await page.evaluate(() => {
      const stats = window.__MISTYOS_PRESENTATION_STATS || {}
      const frames = Array.isArray(stats?.bootstrap?.initialFrameDiagnostics)
        ? stats.bootstrap.initialFrameDiagnostics
        : []
      return frames[0] || null
    }),
  }
}

function eventIndex(ordering, name) {
  return ordering.indexOf(name)
}

function compareOrdering(publishRestart, coldLoad) {
  const orderChecks = [
    'presentation-clock-reset',
    'presentation-runtime-payload-ready',
    'presentation-engine-created',
    'presentation-startup-begin',
    'pre-start-bootstrap-result',
    'engine-started',
    'runtime-canonical-zero-sample',
    'runtime-first-scheduler-sample',
    'engine-first-tick',
  ]

  for (const eventName of orderChecks) {
    const leftIndex = eventIndex(publishRestart.ordering, eventName)
    const rightIndex = eventIndex(coldLoad.ordering, eventName)
    if (leftIndex !== rightIndex) {
      return {
        differs: true,
        eventName,
        publishRestartIndex: leftIndex,
        coldLoadIndex: rightIndex,
      }
    }
  }

  return { differs: false }
}

function buildReport(cause, publishRestart, coldLoad, extra = {}) {
  return {
    ok: false,
    cause,
    sampleAtZero: {
      publishRestart: publishRestart.sampleAtZero,
      coldLoad: coldLoad.sampleAtZero,
    },
    canonicalZeroSample: {
      publishRestart: publishRestart.canonicalZeroSample,
      coldLoad: coldLoad.canonicalZeroSample,
    },
    firstSample: {
      publishRestart: publishRestart.firstSample,
      coldLoad: coldLoad.firstSample,
    },
    frame0: {
      publishRestart: publishRestart.frame0,
      coldLoad: coldLoad.frame0,
    },
    ordering: {
      publishRestart: publishRestart.ordering,
      coldLoad: coldLoad.ordering,
      publishRestartFirstTickBeforeFirstSample: eventIndex(publishRestart.ordering, 'engine-first-tick') !== -1 && eventIndex(publishRestart.ordering, 'engine-first-tick') < eventIndex(publishRestart.ordering, 'runtime-first-scheduler-sample'),
      coldLoadFirstTickBeforeFirstSample: eventIndex(coldLoad.ordering, 'engine-first-tick') !== -1 && eventIndex(coldLoad.ordering, 'engine-first-tick') < eventIndex(coldLoad.ordering, 'runtime-first-scheduler-sample'),
    },
    ...extra,
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  let runtimeContext = null
  let coldContext = null

  try {
    runtimeContext = await browser.newContext({ viewport: { width: 1366, height: 900 } })
    await addDeterministicSeedScript(runtimeContext, DETERMINISTIC_SEED)

    const studioPage = await runtimeContext.newPage()
    await studioPage.goto(`${BASE_URL}/studio`, { waitUntil: 'domcontentloaded' })
    await publishRuntimePayload(studioPage, TIMELINE_ID)

    const publishPage = await runtimeContext.newPage()
    const publishRestart = await captureMode(publishPage, 'publish-restart')

    const storageState = await runtimeContext.storageState()
    coldContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, storageState })
    await addDeterministicSeedScript(coldContext, DETERMINISTIC_SEED)

    const coldPage = await coldContext.newPage()
    const coldLoad = await captureMode(coldPage, 'cold-load')

    if (!nearlyEqual(publishRestart.sampleAtZero?.rawElapsedSec, coldLoad.sampleAtZero?.rawElapsedSec) ||
        !nearlyEqual(publishRestart.sampleAtZero?.sampleInput?.normalizedSampleSec, coldLoad.sampleAtZero?.sampleInput?.normalizedSampleSec) ||
        !nearlyEqual(publishRestart.sampleAtZero?.rainIntensity, coldLoad.sampleAtZero?.rainIntensity) ||
        !compareRainTracks(publishRestart.sampleAtZero?.rainTracks, coldLoad.sampleAtZero?.rainTracks)) {
      fail(buildReport('time-0-sample-divergence', publishRestart, coldLoad, {
        findings: {
          timeValuesDiffer: true,
          orderingDiffers: false,
          identicalInputsDifferentOutputs: false,
        },
      }))
    }

    if (!nearlyEqual(publishRestart.canonicalZeroSample?.rawElapsedSec, 0) ||
        !nearlyEqual(coldLoad.canonicalZeroSample?.rawElapsedSec, 0) ||
        !nearlyEqual(publishRestart.canonicalZeroSample?.sampleInput?.normalizedSampleSec, 0) ||
        !nearlyEqual(coldLoad.canonicalZeroSample?.sampleInput?.normalizedSampleSec, 0) ||
        !nearlyEqual(publishRestart.canonicalZeroSample?.rainIntensity, coldLoad.canonicalZeroSample?.rainIntensity) ||
        !compareRainTracks(publishRestart.canonicalZeroSample?.rainTracks, coldLoad.canonicalZeroSample?.rainTracks)) {
      fail(buildReport('canonical-zero-handoff-divergence', publishRestart, coldLoad, {
        findings: {
          timeValuesDiffer: true,
          orderingDiffers: false,
          identicalInputsDifferentOutputs: false,
        },
      }))
    }

    if (!nearlyEqual(publishRestart.frame0?.rainIntensity, coldLoad.frame0?.rainIntensity)) {
      fail(buildReport('frame-0-rain-divergence', publishRestart, coldLoad, {
        findings: {
          timeValuesDiffer: false,
          orderingDiffers: false,
          identicalInputsDifferentOutputs: false,
        },
      }))
    }

    const ordering = compareOrdering(publishRestart, coldLoad)
    if (ordering.differs) {
      fail(buildReport('sampling-ordering-divergence', publishRestart, coldLoad, {
        findings: {
          timeValuesDiffer: false,
          orderingDiffers: true,
          identicalInputsDifferentOutputs: false,
        },
        orderingDifference: ordering,
      }))
    }

    const sameInputs = compareRainTracks(publishRestart.firstSample?.rainTracks, coldLoad.firstSample?.rainTracks)
      && nearlyEqual(publishRestart.firstSample?.sampleInput?.normalizedSampleSec, coldLoad.firstSample?.sampleInput?.normalizedSampleSec)

    if (sameInputs && !nearlyEqual(publishRestart.firstSample?.rainIntensity, coldLoad.firstSample?.rainIntensity)) {
      fail(buildReport('same-input-different-output', publishRestart, coldLoad, {
        findings: {
          timeValuesDiffer: false,
          orderingDiffers: false,
          identicalInputsDifferentOutputs: true,
        },
      }))
    }

    console.log(JSON.stringify({
      ok: true,
      message: 'Canonical zero-time handoff is aligned and frame-0 rainIntensity parity is preserved.',
      sampleAtZero: {
        publishRestart: publishRestart.sampleAtZero,
        coldLoad: coldLoad.sampleAtZero,
      },
      canonicalZeroSample: {
        publishRestart: publishRestart.canonicalZeroSample,
        coldLoad: coldLoad.canonicalZeroSample,
      },
      firstSample: {
        publishRestart: publishRestart.firstSample,
        coldLoad: coldLoad.firstSample,
      },
      frame0: {
        publishRestart: publishRestart.frame0,
        coldLoad: coldLoad.frame0,
      },
      ordering: {
        publishRestart: publishRestart.ordering,
        coldLoad: coldLoad.ordering,
      },
    }, null, 2))
  } finally {
    if (coldContext) {
      await coldContext.close()
    }
    if (runtimeContext) {
      await runtimeContext.close()
    }
    await browser.close()
  }
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  try {
    console.error(JSON.stringify(JSON.parse(message), null, 2))
  } catch {
    console.error(JSON.stringify({ ok: false, stage: 'unclassified-error', message }, null, 2))
  }
  process.exitCode = 1
}