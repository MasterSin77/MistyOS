import { chromium } from 'playwright'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const baseUrl = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5186'
const probeDurationMs = Number(process.env.MISTYOS_PROBE_DURATION_MS || 26000)
const probeIntervalMs = Number(process.env.MISTYOS_PROBE_INTERVAL_MS || 2000)
const timelineId = 'runner-carve-diagnosis'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1720, height: 1080 } })
const studio = await context.newPage()
const presentation = await context.newPage()

try {
  await presentation.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
  await presentation.waitForSelector('.presentation-runtime-meta', { timeout: 15000 })

  const initialPresentationMeta = await readPresentationMeta(presentation)
  const initialPresentationPublishRevision = extractMetaNumber(initialPresentationMeta.metaLines, 'publishRevision') || 0
  const initialPresentationRestartToken = extractMetaValue(initialPresentationMeta.metaLines, 'restartToken') || 'local-default'
  const initialPresentationNavCount = await presentation.evaluate(() => {
    window.__MISTYOS_NAV_COUNT = (window.__MISTYOS_NAV_COUNT || 0) + 1
    return window.__MISTYOS_NAV_COUNT
  })

  await studio.goto(`${baseUrl}/studio`, { waitUntil: 'domcontentloaded' })
  await studio.waitForSelector('.studio-footer-status', { timeout: 15000 })
  await studio.waitForSelector('.tl-time-readout', { timeout: 15000 })

  await studio.getByRole('button', { name: /runner-carve-diagnosis/i }).click()
  const timelineSelect = studio.locator('label:has-text("Active Timeline") select').first()
  await timelineSelect.selectOption(timelineId)
  await studio.waitForFunction(
    (expectedTimelineId) => window.__MISTYOS_STUDIO_RUNTIME?.activeTimelineId === expectedTimelineId,
    timelineId,
  )

  await studio.getByRole('button', { name: /^Stop timeline/ }).first().click()
  await studio.getByRole('button', { name: 'Play timeline from current playhead' }).first().click()

  const studioSamples = await collectSamples(studio, probeDurationMs, probeIntervalMs, async (elapsedMs) => studio.evaluate((currentElapsedMs) => {
    const stats = window.__MISTYOS_STUDIO_PREVIEW_STATS || null
    const timing = stats?.timing || {}
    return {
      elapsedMs: currentElapsedMs,
      timeReadout: document.querySelector('.tl-time-readout')?.textContent?.trim() || '',
      footerStatus: document.querySelector('.studio-footer-status')?.textContent?.trim() || '',
      activeTimelineId: window.__MISTYOS_STUDIO_RUNTIME?.activeTimelineId || null,
      runnerCarveSamples: timing.runnerCarveSamples || 0,
      runnerCarveSegmentSamples: timing.runnerCarveSegmentSamples || 0,
      runnerCarvePointSamples: timing.runnerCarvePointSamples || 0,
      runnerCarveLastMode: timing.runnerCarveLastMode || 'none',
      runnerCarveSpacingRatioMean: timing.runnerCarveSpacingRatioMean || 0,
      runnerCarveSpacingRatioMax: timing.runnerCarveSpacingRatioMax || 0,
      runnerCarveGapFraction: timing.runnerCarveGapFraction || 0,
      runnerCarveDepthGainMean: timing.runnerCarveDepthGainMean || 0,
      runnerCarvePostSmoothRetentionMean: timing.runnerCarvePostSmoothRetentionMean || 0,
      runnerCarveRecoveryRatioMean: timing.runnerCarveRecoveryRatioMean || 0,
      runnerCarveRecoveryLossMean: timing.runnerCarveRecoveryLossMean || 0,
      runnerCarveLastSpacingRatio: timing.runnerCarveLastSpacingRatio || 0,
      runnerCarveLastBeforeDepth: timing.runnerCarveLastBeforeDepth || 0,
      runnerCarveLastAfterDepth: timing.runnerCarveLastAfterDepth || 0,
      runnerCarveLastPostSmoothDepth: timing.runnerCarveLastPostSmoothDepth || 0,
      runnerCarveLastRecoveredDepth: timing.runnerCarveLastRecoveredDepth || 0,
    }
  }, elapsedMs))

  const studioActivity = studioSamples.find((sample) => sample.runnerCarveSamples > 0)
  assert(studioActivity, 'Studio probe did not record any runner-carve activity.')

  await saveAndPublish(studio)

  await presentation.waitForFunction(
    ({ previousPublishRevision, previousRestartToken, expectedTimelineId }) => {
      const metaLines = Array.from(document.querySelectorAll('.presentation-runtime-meta > div')).map((node) => node.textContent || '')
      const publishLine = metaLines.find((line) => line.startsWith('publishRevision:')) || ''
      const restartLine = metaLines.find((line) => line.startsWith('restartToken:')) || ''
      const runtimeTimelineLine = metaLines.find((line) => line.startsWith('runtimeTimelineId:')) || ''
      const timelineLine = metaLines.find((line) => line.startsWith('timelineId:')) || ''

      const nextPublishRevision = Number((publishLine.match(/(\d+)/) || [])[1] || 0)
      const nextRestartToken = restartLine.split(':').slice(1).join(':').trim()
      const hasExpectedTimeline = timelineLine.trim() === `timelineId: ${expectedTimelineId}`
      const hasExpectedRuntimeTimeline = runtimeTimelineLine.trim() === `runtimeTimelineId: ${expectedTimelineId}`

      const canvas = document.querySelector('.presentation-canvas')
      const canvasOpacity = canvas ? Number(window.getComputedStyle(canvas).opacity || 0) : 0
      const stats = window.__MISTYOS_PRESENTATION_STATS || null
      const timing = stats?.timing || {}
      const hasRunnerActivity = Number(timing.runnerCarveSamples || 0) > 0

      return (
        nextPublishRevision > previousPublishRevision
        && nextRestartToken
        && nextRestartToken !== previousRestartToken
        && hasExpectedTimeline
        && hasExpectedRuntimeTimeline
        && canvasOpacity > 0.95
        && hasRunnerActivity
      )
    },
    {
      previousPublishRevision: initialPresentationPublishRevision,
      previousRestartToken: initialPresentationRestartToken,
      expectedTimelineId: timelineId,
    },
    { timeout: 30000 },
  )

  const presentationNavCount = await presentation.evaluate(() => window.__MISTYOS_NAV_COUNT || 0)
  assert(
    presentationNavCount === initialPresentationNavCount,
    'Presentation page navigated during publish; expected in-place runtime update without refresh.',
  )

  const studioFooterText = await studio.locator('.studio-footer-status').innerText()
  assert(
    new RegExp(`timelineId:\\s*${timelineId}`, 'i').test(studioFooterText),
    'Studio footer does not show timelineId runner-carve-diagnosis.',
  )
  assert(
    new RegExp(`runtimeTimelineId:\\s*${timelineId}`, 'i').test(studioFooterText),
    'Studio footer does not show runtimeTimelineId runner-carve-diagnosis.',
  )

  const presentationMetaAfterPublish = await readPresentationMeta(presentation)

  assert(
    presentationMetaAfterPublish.metaLines.some((line) => line.trim() === `timelineId: ${timelineId}`),
    'Presentation metadata does not show timelineId runner-carve-diagnosis.',
  )
  assert(
    presentationMetaAfterPublish.metaLines.some((line) => line.trim() === `runtimeTimelineId: ${timelineId}`),
    'Presentation metadata does not show runtimeTimelineId runner-carve-diagnosis.',
  )

  const presentationSamples = await collectSamples(presentation, probeDurationMs, probeIntervalMs, async (elapsedMs) => presentation.evaluate((currentElapsedMs) => {
    const stats = window.__MISTYOS_PRESENTATION_STATS || null
    const timing = stats?.timing || {}
    return {
      elapsedMs: currentElapsedMs,
      metaLines: Array.from(document.querySelectorAll('.presentation-runtime-meta > div')).map((node) => node.textContent || ''),
      runnerCarveSamples: timing.runnerCarveSamples || 0,
      runnerCarveSegmentSamples: timing.runnerCarveSegmentSamples || 0,
      runnerCarvePointSamples: timing.runnerCarvePointSamples || 0,
      runnerCarveLastMode: timing.runnerCarveLastMode || 'none',
      runnerCarveSpacingRatioMean: timing.runnerCarveSpacingRatioMean || 0,
      runnerCarveSpacingRatioMax: timing.runnerCarveSpacingRatioMax || 0,
      runnerCarveGapFraction: timing.runnerCarveGapFraction || 0,
      runnerCarveDepthGainMean: timing.runnerCarveDepthGainMean || 0,
      runnerCarvePostSmoothRetentionMean: timing.runnerCarvePostSmoothRetentionMean || 0,
      runnerCarveRecoveryRatioMean: timing.runnerCarveRecoveryRatioMean || 0,
      runnerCarveRecoveryLossMean: timing.runnerCarveRecoveryLossMean || 0,
      runnerCarveLastSpacingRatio: timing.runnerCarveLastSpacingRatio || 0,
      runnerCarveLastBeforeDepth: timing.runnerCarveLastBeforeDepth || 0,
      runnerCarveLastAfterDepth: timing.runnerCarveLastAfterDepth || 0,
      runnerCarveLastPostSmoothDepth: timing.runnerCarveLastPostSmoothDepth || 0,
      runnerCarveLastRecoveredDepth: timing.runnerCarveLastRecoveredDepth || 0,
    }
  }, elapsedMs))

  const presentationActivity = presentationSamples.find((sample) => sample.runnerCarveSamples > 0)
  assert(presentationActivity, 'Presentation probe did not record any runner-carve activity.')

  console.log(JSON.stringify({
    baseUrl,
    timelineId,
    initialPresentationPublishRevision,
    initialPresentationRestartToken,
    presentationMetaAfterPublish,
    probeDurationMs,
    probeIntervalMs,
    studio: summarizeSamples(studioSamples),
    presentation: summarizeSamples(presentationSamples),
  }, null, 2))
} finally {
  await browser.close()
}

async function collectSamples(page, totalMs, intervalMs, readSample) {
  const samples = []
  for (let elapsedMs = 0; elapsedMs <= totalMs; elapsedMs += intervalMs) {
    if (elapsedMs > 0) {
      await page.waitForTimeout(intervalMs)
    }
    samples.push(await readSample(elapsedMs))
  }
  return samples
}

function summarizeSamples(samples) {
  const activeSamples = samples.filter((sample) => sample.runnerCarveSamples > 0)
  const peakSample = activeSamples.reduce((best, sample) => {
    if (!best) {
      return sample
    }
    return sample.runnerCarveDepthGainMean > best.runnerCarveDepthGainMean ? sample : best
  }, null)

  const aggregate = activeSamples.reduce((acc, sample) => {
    acc.count += 1
    acc.spacingRatioMean += sample.runnerCarveSpacingRatioMean
    acc.spacingRatioMax = Math.max(acc.spacingRatioMax, sample.runnerCarveSpacingRatioMax)
    acc.gapFraction += sample.runnerCarveGapFraction
    acc.depthGainMean += sample.runnerCarveDepthGainMean
    acc.postSmoothRetentionMean += sample.runnerCarvePostSmoothRetentionMean
    acc.recoveryRatioMean += sample.runnerCarveRecoveryRatioMean
    acc.recoveryLossMean += sample.runnerCarveRecoveryLossMean
    return acc
  }, {
    count: 0,
    spacingRatioMean: 0,
    spacingRatioMax: 0,
    gapFraction: 0,
    depthGainMean: 0,
    postSmoothRetentionMean: 0,
    recoveryRatioMean: 0,
    recoveryLossMean: 0,
  })

  const divisor = aggregate.count || 1

  return {
    activeSampleCount: activeSamples.length,
    activeWindowStartMs: activeSamples[0]?.elapsedMs ?? null,
    activeWindowEndMs: activeSamples.at(-1)?.elapsedMs ?? null,
    peakSample,
    averages: {
      spacingRatioMean: aggregate.spacingRatioMean / divisor,
      spacingRatioMax: aggregate.spacingRatioMax,
      gapFraction: aggregate.gapFraction / divisor,
      depthGainMean: aggregate.depthGainMean / divisor,
      postSmoothRetentionMean: aggregate.postSmoothRetentionMean / divisor,
      recoveryRatioMean: aggregate.recoveryRatioMean / divisor,
      recoveryLossMean: aggregate.recoveryLossMean / divisor,
    },
    samples,
  }
}

async function saveAndPublish(studio) {
  await studio.keyboard.press('Control+S')
  await studio.waitForFunction(() => {
    const text = document.querySelector('.studio-footer-status')?.textContent || ''
    return /Saved:\s*r\d+/i.test(text)
  })

  await studio.keyboard.press('Control+Shift+P')
  await studio.waitForFunction(() => {
    const text = document.querySelector('.studio-footer-status')?.textContent || ''
    return /Published:\s*Up to date/i.test(text)
  })
}

async function readPresentationMeta(page) {
  return page.evaluate(() => {
    const metaLines = Array.from(document.querySelectorAll('.presentation-runtime-meta > div')).map((node) => node.textContent || '')
    return {
      metaLines,
      canvasOpacity: Number(window.getComputedStyle(document.querySelector('.presentation-canvas'))?.opacity || 0),
    }
  })
}

function extractMetaValue(lines, label) {
  const line = lines.find((value) => value.toLowerCase().startsWith(`${String(label).toLowerCase()}:`)) || ''
  return line.split(':').slice(1).join(':').trim() || null
}

function extractMetaNumber(lines, label) {
  const value = extractMetaValue(lines, label)
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}