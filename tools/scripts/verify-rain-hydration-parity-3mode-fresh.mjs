import { chromium } from 'playwright'

const BASE_URL = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5183'
const TIMELINE_ID = process.env.MISTYOS_TIMELINE_ID || 'runner-carve-diagnosis'
const IDLE_BEFORE_REFRESH_MS = Number(process.env.MISTYOS_IDLE_MS || 2500)
const WAIT_AFTER_NAV_MS = Number(process.env.MISTYOS_WAIT_AFTER_NAV_MS || 3200)

const REQUIRED_EVENTS = [
  'pre-start-bootstrap-result',
  'boot-parity-first-frame',
  'boot-parity-summary',
]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toSummary(eventsByName) {
  const bootstrap = eventsByName['pre-start-bootstrap-result'] || {}
  const firstFrame = eventsByName['boot-parity-first-frame'] || {}

  return {
    mode: firstFrame.mode || bootstrap.bootPath || 'unknown',
    payloadHash: firstFrame.payloadHash || bootstrap.payloadHash || null,
    publishRevision: Number(firstFrame.publishRevision ?? bootstrap.publishRevision ?? 0),
    timelineId: firstFrame.timelineId || bootstrap.timelineId || null,
    sampledRainIntensity: Number(firstFrame.rainAtBootstrap ?? bootstrap.rainAtWindow ?? 0),
    preStartDropletsPerSeconds: Number(firstFrame.preStartDropletsPerSeconds ?? bootstrap.drivenDropletsPerSeconds ?? 0),
    adapterInitDropletsPerSeconds: Number(firstFrame.adapterInitDropletsPerSeconds ?? 0),
    firstFrameRainCount: Number(firstFrame.firstFrameRainCount ?? 0),
  }
}

function comparable(summary) {
  const copy = { ...summary }
  delete copy.mode
  return copy
}

function diffSummary(a, b) {
  const out = {}
  for (const key of Object.keys({ ...a, ...b })) {
    if (JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key])) {
      out[key] = {
        a: a?.[key],
        b: b?.[key],
      }
    }
  }
  return out
}

async function publishRuntimePayload(page, timelineId, reason) {
  const result = await page.evaluate(({ targetTimelineId, publishReason }) => {
    const registryRaw = localStorage.getItem('mistyos.authoring.projects.v1')
    const activeProjectRaw = localStorage.getItem('mistyos.authoring.activeProjectId.v1')
    const registry = registryRaw ? JSON.parse(registryRaw) : { projects: [] }
    const activeProjectEntry = activeProjectRaw ? JSON.parse(activeProjectRaw) : {}

    const activeProjectId = String(
      activeProjectEntry?.projectId || registry?.projects?.[0]?.projectId || '',
    ).trim()

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
        selectedSceneId: null,
        selectedPresetId: null,
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
    const restartToken = `fresh-verify-${publishReason}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

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

    return {
      ok: true,
      publishRevision: nextPublishRevision,
      restartToken,
      timelineId: targetTimelineId,
    }
  }, {
    targetTimelineId: timelineId,
    publishReason: reason,
  })

  if (!result?.ok) {
    throw new Error(`Publish failed: ${result?.reason || 'unknown'}`)
  }

  return result
}

async function capturePresentationDiagnostics(page, mode, { nav = 'goto' } = {}) {
  const events = []
  const contractViolations = []

  const onConsole = async (msg) => {
    const type = msg.type()
    const values = []
    for (const arg of msg.args()) {
      try {
        values.push(await arg.jsonValue())
      } catch {
        // Ignore non-serializable console arg
      }
    }

    const eventPayload = values.find((entry) => entry && typeof entry === 'object' && typeof entry.event === 'string')
    if (eventPayload && REQUIRED_EVENTS.includes(eventPayload.event)) {
      events.push({
        event: eventPayload.event,
        details: eventPayload,
      })
    }

    if (
      type === 'error' &&
      values.some((entry) => entry && typeof entry === 'object' && String(entry.event || '').includes('active-rain-with-zero-droplets'))
    ) {
      contractViolations.push(values)
    }

    const text = msg.text() || ''
    if (type === 'error' && text.includes('active-rain-with-zero-droplets')) {
      contractViolations.push([{ text }])
    }
  }

  page.on('console', onConsole)

  if (nav === 'reload') {
    await page.reload({ waitUntil: 'domcontentloaded' })
  } else {
    await page.goto(`${BASE_URL}/?rdfxDebug=1`, { waitUntil: 'domcontentloaded' })
  }

  await page.waitForFunction(() => Boolean(window.__MISTYOS_PRESENTATION_STATS?.renderer), {
    timeout: 15000,
  })

  await sleep(WAIT_AFTER_NAV_MS)

  page.off('console', onConsole)

  const byName = {}
  for (const item of events) {
    if (!byName[item.event]) {
      byName[item.event] = item.details
    }
  }

  const summary = toSummary(byName)

  console.log('[MistyOS][HydrationParity]', {
    mode,
    payloadHash: summary.payloadHash,
    publishRevision: summary.publishRevision,
    timelineId: summary.timelineId,
    sampledRainIntensity: summary.sampledRainIntensity,
    preStartDropletsPerSeconds: summary.preStartDropletsPerSeconds,
    adapterInitDropletsPerSeconds: summary.adapterInitDropletsPerSeconds,
    firstFrameRainCount: summary.firstFrameRainCount,
  })

  return {
    mode,
    summary,
    missingEvents: REQUIRED_EVENTS.filter((eventName) => !byName[eventName]),
    contractViolationCount: contractViolations.length,
  }
}

async function checkDevServerCachingAndFreshCode() {
  const rootResponse = await fetch(`${BASE_URL}/`, { cache: 'no-store' })
  const moduleResponse = await fetch(`${BASE_URL}/src/pages/PresentationPage.jsx`, { cache: 'no-store' })

  const rootCacheControl = rootResponse.headers.get('cache-control')
  const moduleCacheControl = moduleResponse.headers.get('cache-control')
  const moduleText = await moduleResponse.text()

  return {
    headers: {
      rootCacheControl,
      moduleCacheControl,
    },
    servedModuleMarkers: {
      hasBootParitySummary: moduleText.includes('boot-parity-summary'),
      hasPresentationContractViolation: moduleText.includes('active-rain-with-zero-droplets'),
      hasEngineContractViolationReference: moduleText.includes('withSchedulerInvariantHints'),
    },
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })

  try {
    const runtimeContext = await browser.newContext({ viewport: { width: 1366, height: 900 } })
    const runtimePage = await runtimeContext.newPage()

    await runtimePage.goto(`${BASE_URL}/studio`, { waitUntil: 'domcontentloaded' })
    const publishRestartDoc = await publishRuntimePayload(runtimePage, TIMELINE_ID, 'publish-restart')

    const publishRestart = await capturePresentationDiagnostics(runtimePage, 'publish-restart', { nav: 'goto' })
    await sleep(IDLE_BEFORE_REFRESH_MS)
    const manualRefreshAfterIdle = await capturePresentationDiagnostics(runtimePage, 'manual-refresh-after-idle', { nav: 'reload' })

    // Flow (a): cold load with cleared sessionStorage but valid published payload.
    // Use the same published lineage as flows (b) and (c) by cloning localStorage
    // after publish-restart has been applied.
    const sharedStorageState = await runtimeContext.storageState()
    const coldContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, storageState: sharedStorageState })
    const coldPage = await coldContext.newPage()
    const coldLoad = await capturePresentationDiagnostics(coldPage, 'cold-load-cleared-sessionStorage', { nav: 'goto' })
    await coldContext.close()

    const cacheVerification = await checkDevServerCachingAndFreshCode()

    const coldComparable = comparable(coldLoad.summary)
    const publishComparable = comparable(publishRestart.summary)
    const refreshComparable = comparable(manualRefreshAfterIdle.summary)

    const parityDiffs = {
      cold_vs_publish: diffSummary(coldComparable, publishComparable),
      publish_vs_refresh: diffSummary(publishComparable, refreshComparable),
      cold_vs_refresh: diffSummary(coldComparable, refreshComparable),
    }

    const missingAnyEvent = [coldLoad, publishRestart, manualRefreshAfterIdle]
      .some((entry) => entry.missingEvents.length > 0)

    const nonZeroFirstFrame = [coldLoad, publishRestart, manualRefreshAfterIdle]
      .every((entry) => Number(entry.summary.firstFrameRainCount || 0) > 0)

    const contractViolationCount = [coldLoad, publishRestart, manualRefreshAfterIdle]
      .reduce((sum, entry) => sum + Number(entry.contractViolationCount || 0), 0)

    const hasParityDivergence = Object.values(parityDiffs)
      .some((entry) => Object.keys(entry).length > 0)

    const cacheLooksFresh =
      cacheVerification.headers.rootCacheControl === 'no-store' &&
      cacheVerification.headers.moduleCacheControl === 'no-store' &&
      cacheVerification.servedModuleMarkers.hasBootParitySummary &&
      cacheVerification.servedModuleMarkers.hasPresentationContractViolation &&
      cacheVerification.servedModuleMarkers.hasEngineContractViolationReference

    const pass =
      !missingAnyEvent &&
      nonZeroFirstFrame &&
      contractViolationCount === 0 &&
      !hasParityDivergence &&
      cacheLooksFresh

    const report = {
      generatedAt: new Date().toISOString(),
      publishRestartDoc,
      modes: {
        coldLoad,
        publishRestart,
        manualRefreshAfterIdle,
      },
      parityDiffs,
      cacheVerification,
      checks: {
        missingAnyEvent,
        nonZeroFirstFrame,
        contractViolationCount,
        hasParityDivergence,
        cacheLooksFresh,
      },
    }

    console.log(JSON.stringify({ pass, report }, null, 2))

    if (!pass) {
      process.exitCode = 1
    }

    await runtimeContext.close()
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error('verify-rain-hydration-parity-3mode-fresh failed:', error)
  process.exit(1)
})
