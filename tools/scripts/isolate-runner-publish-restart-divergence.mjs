import { chromium } from 'playwright'

const BASE_URL = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5183'
const TIMELINE_ID = process.env.MISTYOS_TIMELINE_ID || 'runner-carve-diagnosis'
const DETERMINISTIC_SEED = Number(process.env.MISTYOS_DETERMINISTIC_SEED || 133742)
const WAIT_BEFORE_REFRESH_MS = Number(process.env.MISTYOS_WAIT_BEFORE_REFRESH_MS || 2500)
const BOOT_TIMEOUT_MS = Number(process.env.MISTYOS_BOOT_TIMEOUT_MS || 20000)
const FRAME_DIAGNOSTIC_COUNT = Number(process.env.MISTYOS_FRAME_DIAGNOSTIC_COUNT || 20)
const FLOAT_EPSILON = Number(process.env.MISTYOS_FLOAT_EPSILON || 1e-9)

const PRESENTATION_EVENTS = [
  'presentation-startup-begin',
  'pre-start-bootstrap-result',
  'pre-start-engine-state',
  'engine-started',
  'boot-parity-first-frame',
]

function fail(details) {
  throw new Error(JSON.stringify({ ok: false, ...details }, null, 2))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function numbersEqual(left, right, epsilon = FLOAT_EPSILON) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= epsilon
}

function shallowEqualSampledDrops(left, right) {
  if (left.length !== right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftDrop = left[index]
    const rightDrop = right[index]
    if (String(leftDrop?.id || '') !== String(rightDrop?.id || '')) {
      return false
    }
    if (!numbersEqual(leftDrop?.x, rightDrop?.x)) {
      return false
    }
    if (!numbersEqual(leftDrop?.y, rightDrop?.y)) {
      return false
    }
    if (!numbersEqual(leftDrop?.vx, rightDrop?.vx)) {
      return false
    }
    if (!numbersEqual(leftDrop?.vy, rightDrop?.vy)) {
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

async function publishRuntimePayload(page, timelineId, reason) {
  const result = await page.evaluate(({ targetTimelineId, publishReason }) => {
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
    const restartToken = `runner-divergence-${publishReason}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

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
  }, {
    targetTimelineId: timelineId,
    publishReason: reason,
  })

  if (!result?.ok) {
    fail({
      stage: 'bootstrap',
      metric: 'publishRuntimePayload',
      mode: reason,
      actualValue: result?.reason || 'unknown',
    })
  }
}

async function captureMode(page, mode, { nav = 'goto' } = {}) {
  const events = []
  const onConsole = async (message) => {
    if (message.type() !== 'info') {
      return
    }

    for (const arg of message.args()) {
      try {
        const value = await arg.jsonValue()
        if (value && typeof value === 'object') {
          if (typeof value.event === 'string' && PRESENTATION_EVENTS.includes(value.event)) {
            events.push({ source: 'presentation', event: value.event, payload: value })
          }
          if (typeof value.step === 'string' && value.step.startsWith('renderer-attach')) {
            events.push({ source: 'engine', event: value.step, payload: value })
          }
        }
      } catch {
        // Ignore non-serializable console args.
      }
    }
  }

  page.on('console', onConsole)

  if (nav === 'reload') {
    await page.reload({ waitUntil: 'domcontentloaded' })
  } else {
    await page.goto(`${BASE_URL}/?rdfxDebug=1`, { waitUntil: 'domcontentloaded' })
  }

  const stats = await page.waitForFunction((requiredFrameCount) => {
    const presentationStats = window.__MISTYOS_PRESENTATION_STATS || {}
    const bootstrap = presentationStats.bootstrap || {}
    return Array.isArray(bootstrap.initialFrameDiagnostics) && bootstrap.initialFrameDiagnostics.length >= requiredFrameCount
  }, FRAME_DIAGNOSTIC_COUNT, { timeout: BOOT_TIMEOUT_MS }).catch(() => null)

  page.off('console', onConsole)

  if (!stats) {
    fail({
      stage: 'bootstrap',
      metric: 'initialFrameDiagnosticsReady',
      mode,
      actualValue: 0,
    })
  }

  const payload = await page.evaluate(() => {
    const presentationStats = window.__MISTYOS_PRESENTATION_STATS || {}
    const bootstrap = presentationStats.bootstrap || {}
    const renderer = presentationStats.renderer || {}
    return {
      bootstrap,
      renderer,
    }
  })

  return {
    mode,
    sequence: events.map((entry) => entry.event),
    eventPayloads: events,
    bootstrap: payload.bootstrap,
    renderer: payload.renderer,
  }
}

function compareBootstrapSequence(publishRestart, coldLoad) {
  const publishSequence = publishRestart.sequence
  const coldSequence = coldLoad.sequence

  const maxLength = Math.max(publishSequence.length, coldSequence.length)
  for (let index = 0; index < maxLength; index += 1) {
    if (publishSequence[index] !== coldSequence[index]) {
      fail({
        stage: 'bootstrap',
        metric: 'bootstrapSequence',
        publishRestartValue: publishSequence[index] ?? 'missing',
        coldLoadValue: coldSequence[index] ?? 'missing',
        frameIndex: index,
      })
    }
  }
}

function compareFirstFrameConfig(publishRestart, coldLoad) {
  const publishFrame0 = publishRestart.bootstrap.initialFrameDiagnostics[0]
  const coldFrame0 = coldLoad.bootstrap.initialFrameDiagnostics[0]
  const fields = ['dropletsPerSeconds', 'rainIntensity', 'wetnessBaseline']

  for (const field of fields) {
    if (!numbersEqual(publishFrame0?.[field], coldFrame0?.[field])) {
      fail({
        stage: 'frame-0-config',
        metric: field,
        publishRestartValue: publishFrame0?.[field] ?? null,
        coldLoadValue: coldFrame0?.[field] ?? null,
        frameIndex: 0,
      })
    }
  }
}

function compareWetnessInitialization(publishRestart, coldLoad) {
  const publishFrame0 = publishRestart.bootstrap.initialFrameDiagnostics[0]
  const coldFrame0 = coldLoad.bootstrap.initialFrameDiagnostics[0]
  const fields = ['wetnessBaseline', 'fullRefresh']

  for (const field of fields) {
    const publishValue = publishFrame0?.[field]
    const coldValue = coldFrame0?.[field]
    const same = typeof publishValue === 'boolean'
      ? publishValue === coldValue
      : numbersEqual(publishValue, coldValue)

    if (!same) {
      fail({
        stage: 'wetness-initialization',
        metric: field,
        publishRestartValue: publishValue ?? null,
        coldLoadValue: coldValue ?? null,
        frameIndex: 0,
      })
    }
  }
}

function compareFirstFrames(publishRestart, coldLoad) {
  const publishFrames = publishRestart.bootstrap.initialFrameDiagnostics.slice(0, FRAME_DIAGNOSTIC_COUNT)
  const coldFrames = coldLoad.bootstrap.initialFrameDiagnostics.slice(0, FRAME_DIAGNOSTIC_COUNT)
  const frameCount = Math.min(publishFrames.length, coldFrames.length)

  for (let index = 0; index < frameCount; index += 1) {
    const publishFrame = publishFrames[index]
    const coldFrame = coldFrames[index]

    if (!numbersEqual(publishFrame?.simulatedDropletCount, coldFrame?.simulatedDropletCount)) {
      fail({
        stage: `frame-${index}`,
        metric: 'simulatedDropletCount',
        publishRestartValue: publishFrame?.simulatedDropletCount ?? null,
        coldLoadValue: coldFrame?.simulatedDropletCount ?? null,
        frameIndex: index,
      })
    }

    if (!shallowEqualSampledDrops(publishFrame?.sampledDrops || [], coldFrame?.sampledDrops || [])) {
      fail({
        stage: `frame-${index}`,
        metric: 'sampledDrops',
        publishRestartValue: publishFrame?.sampledDrops || [],
        coldLoadValue: coldFrame?.sampledDrops || [],
        frameIndex: index,
      })
    }

    if (!numbersEqual(publishFrame?.depositionDepthGain, coldFrame?.depositionDepthGain)) {
      fail({
        stage: 'deposition',
        metric: 'depositionDepthGain',
        publishRestartValue: publishFrame?.depositionDepthGain ?? null,
        coldLoadValue: coldFrame?.depositionDepthGain ?? null,
        frameIndex: index,
      })
    }

    if (!numbersEqual(publishFrame?.wetnessBaseline, coldFrame?.wetnessBaseline)) {
      fail({
        stage: `frame-${index}`,
        metric: 'wetnessBaseline',
        publishRestartValue: publishFrame?.wetnessBaseline ?? null,
        coldLoadValue: coldFrame?.wetnessBaseline ?? null,
        frameIndex: index,
      })
    }
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
    await publishRuntimePayload(studioPage, TIMELINE_ID, 'publish-restart')

    const publishPage = await runtimeContext.newPage()
    const publishRestart = await captureMode(publishPage, 'publish-restart', { nav: 'goto' })
    await sleep(WAIT_BEFORE_REFRESH_MS)

    const sharedStorageState = await runtimeContext.storageState()
    coldContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, storageState: sharedStorageState })
    await addDeterministicSeedScript(coldContext, DETERMINISTIC_SEED)

    const coldPage = await coldContext.newPage()
    const coldLoad = await captureMode(coldPage, 'cold-load', { nav: 'goto' })

    compareBootstrapSequence(publishRestart, coldLoad)
    compareFirstFrameConfig(publishRestart, coldLoad)
    compareWetnessInitialization(publishRestart, coldLoad)
    compareFirstFrames(publishRestart, coldLoad)

    console.log(JSON.stringify({
      ok: true,
      baseUrl: BASE_URL,
      timelineId: TIMELINE_ID,
      deterministicSeed: DETERMINISTIC_SEED,
      comparedModes: [publishRestart.mode, coldLoad.mode],
      message: 'No divergence found in bootstrap or first 20 frame diagnostics.',
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