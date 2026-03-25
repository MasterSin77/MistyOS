import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const BASE_URL = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5183'
const TIMELINE_ID = process.env.MISTYOS_TIMELINE_ID || 'runner-carve-diagnosis'
const SAMPLE_WINDOW_MS = Number(process.env.MISTYOS_SAMPLE_WINDOW_MS || 6000)
const SAMPLE_INTERVAL_MS = Number(process.env.MISTYOS_SAMPLE_INTERVAL_MS || 200)
const OUTPUT_DIR = path.resolve('tools/logs')
const PRESENTATION_PATH = '/?rdfxDebug=1'

function presentationUrl() {
  return `${BASE_URL}${PRESENTATION_PATH}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nowToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function publishRuntimePayload(page, timelineId, reason) {
  const result = await page.evaluate(({ targetTimelineId, publishReason, token }) => {
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
      return { ok: false, reason: 'missing-project-document', activeProjectId }
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
      restartToken: `phase1-rain-integrity-${publishReason}-${token}`,
      fromSavedRevision: nextSavedRevision,
      runtimePayload,
    }

    project.metadata = {
      ...(project.metadata || {}),
      updatedAt: nowIso,
      lastPublishedAt: nowIso,
    }

    localStorage.setItem(projectKey, JSON.stringify(project))
    localStorage.setItem('mistyos.authoring.activeProjectId.v1', JSON.stringify({ projectId: activeProjectId }))

    return {
      ok: true,
      activeProjectId,
      projectKey,
      publishRevision: nextPublishRevision,
      savedRevision: nextSavedRevision,
      timelineId: targetTimelineId,
      restartToken: project.publishedDocument.restartToken,
    }
  }, {
    targetTimelineId: timelineId,
    publishReason: reason,
    token: nowToken(),
  })

  if (!result?.ok) {
    throw new Error(`Publish failed: ${result?.reason || 'unknown'}`)
  }

  return result
}

async function waitForPresentationDebug(page) {
  await page.waitForFunction(() => Boolean(window.__MISTYOS_PRESENTATION_RAIN_DEBUG), {
    timeout: 15000,
  })
}

async function sampleWindow(page, stageLabel, stateLabel) {
  const samples = []
  const startedAt = Date.now()
  let sampleIndex = 0

  while (Date.now() - startedAt <= SAMPLE_WINDOW_MS) {
    const sample = await page.evaluate(({ index, label }) => {
      const rain = window.__MISTYOS_PRESENTATION_RAIN_DEBUG || {}
      const runtime = window.__MISTYOS_PRESENTATION_RUNTIME || {}
      const stats = window.__MISTYOS_PRESENTATION_STATS || {}
      const timing = stats?.timing || {}
      const renderer = stats?.renderer || {}
      const bootstrap = stats?.bootstrap || {}
      return {
        sampleIndex: index,
        stateLabel: String(label || 'unknown'),
        tsMs: Date.now(),
        currentTimeSec: Number(rain.currentTimeSec || 0),
        loopTimeSec: Number(rain.loopTimeSec || 0),
        rainIntensity: Number(rain.rainIntensity || 0),
        rainContribution: Number(rain.rainContribution || 0),
        fogContribution: Number(rain.fogContribution || 0),
        activeRainClipCount: Number(rain.activeRainClipCount || 0),
        activeFogClipCount: Number(rain.activeFogClipCount || 0),
        drivenDropletsPerSeconds: Number(rain.drivenDropletsPerSeconds || 0),
        effectiveRefillRate: Number(rain.effectiveRefillRate || 0),
        mismatchClass: String(rain.mismatchClass || 'none'),
        mismatchSeverity: String(rain.mismatchSeverity || 'none'),
        mismatchFrames: Number(rain.mismatchFrames || 0),
        simulatedDropletCount: Number(timing.simulatedDropletCount || 0),
        surfaceDropletCount: Number(timing.surfaceDropletCount || 0),
        renderedDropletPixelCoverage: Number(renderer.renderedDropletPixelCoverage || 0),
        rendererFrameDeltaEnergy: Number(renderer.frameDeltaEnergy || 0),
        rendererFrameSampleReady: Boolean(renderer.frameSampleReady),
        rendererRenderSucceeded: Boolean(renderer.renderSucceeded),
        rendererChannelCoverage: Number(timing.rendererChannelCoverage || 0),
        publishRevision: Number(runtime?.publishRevision || 0),
        fromSavedRevision: Number(runtime?.fromSavedRevision || 0),
        restartToken: String(runtime?.restartToken || ''),
        runtimeSessionKey: String(runtime?.runtimeSessionKey || ''),
        runtimePayloadHash: String(runtime?.runtimePayloadHash || ''),
        clockLastAction: String(runtime?.clockDebug?.lastAction || ''),
        bootstrap: {
          rendererCreated: Boolean(bootstrap.rendererCreated),
          rendererAttached: Boolean(bootstrap.rendererAttached),
          initialWeatherApplied: Boolean(bootstrap.initialWeatherApplied),
          initialRainApplied: Boolean(bootstrap.initialRainApplied),
          initialFogApplied: Boolean(bootstrap.initialFogApplied),
          seededDropletCount: Number(bootstrap.seededDropletCount || 0),
          firstVisibleRainFrame: Number(bootstrap.firstVisibleRainFrame || -1),
          firstRenderFrameTime: Number(bootstrap.firstRenderFrameTime || 0),
          refreshPath: Boolean(bootstrap.refreshPath),
          publishRestartPath: Boolean(bootstrap.publishRestartPath),
        },
      }
    }, { index: sampleIndex, label: stateLabel })

    samples.push(sample)
    sampleIndex += 1
    await sleep(SAMPLE_INTERVAL_MS)
  }

  const rainActiveSamples = samples.filter((entry) => entry.rainIntensity > 0.01 || entry.rainContribution > 0.01)
  const highMismatchSamples = samples.filter((entry) => entry.mismatchClass === 'rain-track-active-but-droplets-low')
  const mediumMismatchSamples = samples.filter((entry) => entry.mismatchClass === 'fog-active-rain-zero')

  return {
    stage: stageLabel,
    stateLabel,
    sampleCount: samples.length,
    rainActiveCount: rainActiveSamples.length,
    highMismatchCount: highMismatchSamples.length,
    mediumMismatchCount: mediumMismatchSamples.length,
    maxRainIntensity: samples.reduce((max, entry) => Math.max(max, entry.rainIntensity), 0),
    maxRainContribution: samples.reduce((max, entry) => Math.max(max, entry.rainContribution), 0),
    maxFogContribution: samples.reduce((max, entry) => Math.max(max, entry.fogContribution), 0),
    maxDropletsPerSeconds: samples.reduce((max, entry) => Math.max(max, entry.drivenDropletsPerSeconds), 0),
    samples,
  }
}

function evaluateResult(stages) {
  const reasons = []
  let pass = true

  stages.forEach((stage) => {
    if (stage.rainActiveCount === 0) {
      pass = false
      reasons.push(`${stage.stage}: rain never active in sample window`)
    }

    const highMismatchRatio = stage.sampleCount > 0
      ? stage.highMismatchCount / stage.sampleCount
      : 0

    if (highMismatchRatio > 0.35) {
      pass = false
      reasons.push(`${stage.stage}: sustained high mismatch ratio ${(highMismatchRatio * 100).toFixed(1)}%`)
    }
  })

  return {
    pass,
    reasons,
  }
}

function writeArtifact(report) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const outputPath = path.join(
    OUTPUT_DIR,
    `phase1-rain-fog-integrity-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return outputPath
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } })
  const page = await context.newPage()

  const output = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    timelineId: TIMELINE_ID,
    sampleWindowMs: SAMPLE_WINDOW_MS,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    cycles: [],
  }

  try {
    await page.goto(presentationUrl(), { waitUntil: 'domcontentloaded' })
    await waitForPresentationDebug(page)
    const initialLoadStage = await sampleWindow(page, 'initial-load', 'initial-load')

    const firstPublish = await publishRuntimePayload(page, TIMELINE_ID, 'initial')
    await page.goto(presentationUrl(), { waitUntil: 'domcontentloaded' })
    await waitForPresentationDebug(page)
    const initialStage = await sampleWindow(page, 'post-initial-publish-reload', 'post-publish')
    await page.goto(presentationUrl(), { waitUntil: 'domcontentloaded' })
    await waitForPresentationDebug(page)
    const refreshStage = await sampleWindow(page, 'post-initial-refresh', 'refresh')

    await page.goto(`${BASE_URL}/studio`, { waitUntil: 'domcontentloaded' })
    const secondPublish = await publishRuntimePayload(page, TIMELINE_ID, 'update-desktop')
    await page.goto(presentationUrl(), { waitUntil: 'domcontentloaded' })
    await waitForPresentationDebug(page)
    const updateDesktopStage = await sampleWindow(page, 'post-update-desktop-reload', 'post-publish')
    await page.goto(presentationUrl(), { waitUntil: 'domcontentloaded' })
    await waitForPresentationDebug(page)
    const updateRefreshStage = await sampleWindow(page, 'post-update-desktop-refresh', 'refresh')

    output.cycles.push({
      name: 'initial-load',
      publishRevision: Number(initialLoadStage?.samples?.[0]?.publishRevision || 0),
      restartToken: String(initialLoadStage?.samples?.[0]?.restartToken || ''),
      stage: initialLoadStage,
    })
    output.cycles.push({
      name: 'initial',
      publishRevision: firstPublish.publishRevision,
      restartToken: firstPublish.restartToken,
      stage: initialStage,
    })
    output.cycles.push({
      name: 'initial-refresh',
      publishRevision: firstPublish.publishRevision,
      restartToken: firstPublish.restartToken,
      stage: refreshStage,
    })
    output.cycles.push({
      name: 'update-desktop',
      publishRevision: secondPublish.publishRevision,
      restartToken: secondPublish.restartToken,
      stage: updateDesktopStage,
    })
    output.cycles.push({
      name: 'update-desktop-refresh',
      publishRevision: secondPublish.publishRevision,
      restartToken: secondPublish.restartToken,
      stage: updateRefreshStage,
    })

    const evaluation = evaluateResult(output.cycles.map((entry) => entry.stage))
    output.evaluation = evaluation

    const artifactPath = writeArtifact(output)

    console.log('Phase 1 rain/fog integrity report written:')
    console.log(artifactPath)
    console.log(JSON.stringify(output.evaluation, null, 2))

    if (!evaluation.pass) {
      process.exitCode = 1
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error('verify-publish-rain-fog-integrity failed:', error)
  process.exit(1)
})
