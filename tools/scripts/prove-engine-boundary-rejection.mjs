import { chromium } from 'playwright'

/**
 * Engine Boundary Rejection Proof Script
 * ===========================================================================
 *
 * Verifies boundary enforcement against invalid external inputs without changing runtime behavior.
 * Does NOT simulate rain, alter wetness math, or change any runtime semantics.
 * 
 * Coverage:
 * - External direct invocation rejection (missing internal boundary marker)
 * - Stale/mismatched runtimeSessionKey validation
 * - Invalid envelope source values
 * - Invalid applyBoundary values
 * - Malformed or missing envelope fields
 * 
 * Diagnostics: Console [MistyOS][Engine][BoundaryReject] warnings and rejection tracking.
 */

const BASE_URL = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5183'
const BOOT_TIMEOUT_MS = Number(process.env.MISTYOS_BOOT_TIMEOUT_MS || 15000)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fail(message, evidence = {}) {
  throw new Error(JSON.stringify(
    { ok: false, message, ...evidence },
    null,
    2
  ))
}

async function captureBoundaryRejectionDiagnostics(page) {
  const rejections = []
  const errors = []

  const onConsole = async (msg) => {
    const type = msg.type()
    const values = []
    for (const arg of msg.args()) {
      try {
        values.push(await arg.jsonValue())
      } catch {
        // Ignore non-serializable args
      }
    }

    const text = msg.text() || ''
    if (text.includes('[MistyOS][Engine][BoundaryReject]')) {
      rejections.push({
        type,
        values,
        text,
      })
    }

    if (type === 'error' && text.includes('BoundaryReject')) {
      errors.push({ text, values })
    }
  }

  page.on('console', onConsole)

  return {
    rejections,
    errors,
    off: () => page.off('console', onConsole),
  }
}

async function attemptExternalBoundaryViolations(page) {
  /**
   * Test suite: invalid external boundary calls against the engine.
   * Each test verifies that boundary violations are properly rejected.
   */

  const testResults = []

  // Get engine reference and active runtime session key
  const engineStatus = await page.evaluate(() => {
    const rt = window.__MISTYOS_PRESENTATION_RUNTIME || {}
    const engine = rt.__devEngineRef || null

    if (!engine) {
      return { engineFound: false, runtimeSessionKey: rt.runtimeSessionKey || null }
    }

    return {
      engineFound: Boolean(engine),
      runtimeSessionKey: rt.runtimeSessionKey || null,
      hasEnqueueMethod: Boolean(engine.enqueueRuntimeInputEnvelope),
      hasConsumeMethod: Boolean(engine.consumeRuntimeInputQueueAtBoundary),
      hasSeekMethod: Boolean(engine.seekToBootstrapFirstRainWindow),
      hasApplyWeatherMethod: Boolean(engine.applyRuntimeWeatherSnapshot),
      hasGetAuthoritySnapshot: Boolean(engine.getRuntimeInputAuthoritySnapshot),
    }
  })

  if (!engineStatus.engineFound) {
    fail('Engine not found on runtime surface', { engineStatus })
  }

  const activeRuntimeSessionKey = engineStatus.runtimeSessionKey

  // Test 1: External direct enqueueRuntimeInputEnvelope (missing internal boundary options)
  const test1Result = await page.evaluate(
    ({ sessionKey }) => {
      const engine = window.__MISTYOS_PRESENTATION_RUNTIME?.__devEngineRef
      if (!engine) return { ok: false, reason: 'engine-not-found' }

      const result = engine.enqueueRuntimeInputEnvelope(
        {
          source: 'engine:runtime-authority',
          applyBoundary: 'engine-runtime-boundary',
          runtimeSessionKey: sessionKey,
          sample: { sampleSec: 1 },
          weather: { rain: 0.5 },
        },
        // NOTE: No internal boundary options - this MUST be rejected
        null
      )

      return {
        method: 'enqueueRuntimeInputEnvelope',
        accepted: result?.accepted || false,
        rejected: result?.rejected || false,
        reason: result?.reason || 'unknown',
      }
    },
    { sessionKey: activeRuntimeSessionKey }
  )

  testResults.push({
    name: 'external-envelope-enqueue-rejected',
    description: 'External enqueue without internal boundary options must be rejected',
    expected: 'rejected',
    result: test1Result,
    passed: test1Result.rejected === true && test1Result.accepted === false,
  })

  // Test 2: consumeRuntimeInputQueueAtBoundary with external call (no internal options)
  const test2Result = await page.evaluate(() => {
    const engine = window.__MISTYOS_PRESENTATION_RUNTIME?.__devEngineRef
    if (!engine) return { ok: false, reason: 'engine-not-found' }

    const result = engine.consumeRuntimeInputQueueAtBoundary(
      'engine-runtime-boundary',
      // No internal boundary options
      null
    )

    return {
      method: 'consumeRuntimeInputQueueAtBoundary',
      accepted: result?.accepted || false,
      rejected: result?.rejected || false,
      reason: result?.reason || String(result) || 'unknown',
    }
  })

  testResults.push({
    name: 'external-queue-consume-rejected',
    description: 'External queue consume without internal options must be rejected',
    expected: 'rejected',
    result: test2Result,
    passed: test2Result.rejected === true || (test2Result === null),
  })

  // Test 3: seekToBootstrapFirstRainWindow with stale/mismatched sessionKey
  const test3Result = await page.evaluate(() => {
    const engine = window.__MISTYOS_PRESENTATION_RUNTIME?.__devEngineRef
    if (!engine) return { ok: false, reason: 'engine-not-found' }

    const result = engine.seekToBootstrapFirstRainWindow({
      runtimeSessionKey: 'stale-session-key-99999',
    })

    return {
      method: 'seekToBootstrapFirstRainWindow',
      accepted: result?.accepted || false,
      rejected: result?.rejected || false,
      reason: result?.reason || 'unknown',
    }
  })

  testResults.push({
    name: 'stale-session-key-rejected',
    description: 'Stale runtimeSessionKey must be rejected with appropriate reason',
    expected: 'rejected',
    result: test3Result,
    passed: test3Result.rejected === true,
  })

  // Test 4: enqueueRuntimeInputEnvelope with invalid source
  const test4Result = await page.evaluate(
    ({ sessionKey }) => {
      const engine = window.__MISTYOS_PRESENTATION_RUNTIME?.__devEngineRef
      if (!engine) return { ok: false, reason: 'engine-not-found' }

      const result = engine.enqueueRuntimeInputEnvelope(
        {
          source: 'invalid-external-source-xyz',
          applyBoundary: 'engine-runtime-boundary',
          runtimeSessionKey: sessionKey,
          sample: { sampleSec: 1 },
          weather: { rain: 0.5 },
        },
        null // No internal options
      )

      return {
        method: 'enqueueRuntimeInputEnvelope',
        testCase: 'invalid-source',
        accepted: result?.accepted || false,
        rejected: result?.rejected || false,
        reason: result?.reason || 'unknown',
      }
    },
    { sessionKey: activeRuntimeSessionKey }
  )

  testResults.push({
    name: 'invalid-envelope-source-rejected',
    description: 'Invalid envelope source in external call is rejected at boundary (external-runtime-envelope-rejected)',
    expected: 'rejected',
    result: test4Result,
    passed: test4Result.rejected === true,
  })

  // Test 5: enqueueRuntimeInputEnvelope with invalid applyBoundary
  const test5Result = await page.evaluate(
    ({ sessionKey }) => {
      const engine = window.__MISTYOS_PRESENTATION_RUNTIME?.__devEngineRef
      if (!engine) return { ok: false, reason: 'engine-not-found' }

      const result = engine.enqueueRuntimeInputEnvelope(
        {
          source: 'engine:runtime-authority',
          applyBoundary: 'invalid-boundary-zone-123',
          runtimeSessionKey: sessionKey,
          sample: { sampleSec: 1 },
          weather: { rain: 0.5 },
        },
        null // No internal options
      )

      return {
        method: 'enqueueRuntimeInputEnvelope',
        testCase: 'invalid-applyBoundary',
        accepted: result?.accepted || false,
        rejected: result?.rejected || false,
        reason: result?.reason || 'unknown',
      }
    },
    { sessionKey: activeRuntimeSessionKey }
  )

  testResults.push({
    name: 'invalid-apply-boundary-rejected',
    description: 'Invalid applyBoundary in external call is rejected at boundary (external-runtime-envelope-rejected)',
    expected: 'rejected',
    result: test5Result,
    passed: test5Result.rejected === true,
  })

  // Test 6: applyRuntimeWeatherSnapshot external call (no internal boundary options)
  const test6Result = await page.evaluate(
    ({ sessionKey }) => {
      const engine = window.__MISTYOS_PRESENTATION_RUNTIME?.__devEngineRef
      if (!engine) return { ok: false, reason: 'engine-not-found' }

      const result = engine.applyRuntimeWeatherSnapshot({
        source: 'engine:runtime-authority',
        sampleCallSite: 'external-boundary-test',
        runtimeSessionKey: sessionKey,
        snapshot: {
          weather: { rain: 0.5 },
        },
        // No internal boundary options - must be rejected
      })

      return {
        method: 'applyRuntimeWeatherSnapshot',
        result: result,
        isNull: result === null,
        isUndefined: result === undefined,
      }
    },
    { sessionKey: activeRuntimeSessionKey }
  )

  testResults.push({
    name: 'external-weather-snapshot-rejected',
    description: 'External applyRuntimeWeatherSnapshot without internal options returns null (rejection with diagnostic logging)',
    expected: 'null-return-with-diagnostic',
    result: test6Result,
    passed: test6Result.isNull === true,
  })

  // Test 7: Verify that seekToBootstrapFirstRainWindow with correct sessionKey is NOT rejected
  // (it may fail for other reasons, but shouldn't be rejected as external-runtime)
  const test7Result = await page.evaluate(
    ({ sessionKey }) => {
      const engine = window.__MISTYOS_PRESENTATION_RUNTIME?.__devEngineRef
      if (!engine) return { ok: false, reason: 'engine-not-found' }

      const result = engine.seekToBootstrapFirstRainWindow({
        runtimeSessionKey: sessionKey,
      })

      return {
        method: 'seekToBootstrapFirstRainWindow',
        hasResult: Boolean(result != null),
        isRejectedAsExternal: result?.reason === 'external-runtime-application-rejected' || false,
        resultReason: result?.reason || 'no-error',
      }
    },
    { sessionKey: activeRuntimeSessionKey }
  )

  testResults.push({
    name: 'valid-session-key-not-rejected-as-external',
    description: 'Valid seekToBootstrapFirstRainWindow with correct sessionKey should not be rejected as external',
    expected: 'accepted-or-other-error',
    result: test7Result,
    passed: test7Result.isRejectedAsExternal === false,
  })

  // Test 8: Missing envelope runtimeSessionKey
  const test8Result = await page.evaluate(() => {
    const engine = window.__MISTYOS_PRESENTATION_RUNTIME?.__devEngineRef
    if (!engine) return { ok: false, reason: 'engine-not-found' }

    const result = engine.enqueueRuntimeInputEnvelope(
      {
        source: 'engine:runtime-authority',
        applyBoundary: 'engine-runtime-boundary',
        // Missing runtimeSessionKey
        sample: { sampleSec: 1 },
        weather: { rain: 0.5 },
      },
      null
    )

    return {
      method: 'enqueueRuntimeInputEnvelope',
      testCase: 'missing-runtimeSessionKey',
      accepted: result?.accepted || false,
      rejected: result?.rejected || false,
      reason: result?.reason || 'unknown',
    }
  })

  testResults.push({
    name: 'missing-runtime-session-key-rejected',
    description: 'Missing runtimeSessionKey in external call is rejected at boundary',
    expected: 'rejected',
    result: test8Result,
    passed: test8Result.rejected === true,
  })

  return testResults
}

async function getRuntimeInputAuthoritySnapshot(page) {
  return page.evaluate(() => {
    const engine = window.__MISTYOS_PRESENTATION_RUNTIME?.__devEngineRef
    if (!engine) return null

    const authority = engine.getRuntimeInputAuthoritySnapshot?.()
    if (!authority) {
      return { method: 'snapshot-unavailable' }
    }

    return {
      rejectedCount: authority.rejectedCount || 0,
      enqueuedCount: authority.enqueuedCount || 0,
      lastRejectedInput: authority.lastRejectedInput || null,
    }
  })
}

async function main() {
  const browser = await chromium.launch({ headless: true })

  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } })
    const page = await context.newPage()

    // Load Presentation page in dev mode
    await page.goto(`${BASE_URL}/?rdfxDebug=1`, { waitUntil: 'domcontentloaded' })

    // Wait for engine to be bootstrapped and ready
    await page.waitForFunction(
      () => Boolean(window.__MISTYOS_PRESENTATION_STATS?.renderer),
      { timeout: BOOT_TIMEOUT_MS }
    )

    await sleep(500)

    // Capture console diagnostics during test execution
    const diagnostics = await captureBoundaryRejectionDiagnostics(page)

    // Run the boundary violation tests
    const testResults = await attemptExternalBoundaryViolations(page)

    diagnostics.off()

    // Capture the runtime input authority state to verify rejections were recorded
    const authoritySnapshot = await getRuntimeInputAuthoritySnapshot(page)

    // Generate report
    const allPassed = testResults.every((test) => test.passed)
    const passCount = testResults.filter((test) => test.passed).length
    const failCount = testResults.filter((test) => !test.passed).length

    const report = {
      generatedAt: new Date().toISOString(),
      summary: {
        passed: allPassed,
        passCount,
        failCount,
        totalTests: testResults.length,
      },
      tests: testResults,
      rejectionDiagnostics: {
        capturedConsoleWarnings: diagnostics.rejections.length,
        capturedErrors: diagnostics.errors.length,
      },
      runtimeInputAuthority: authoritySnapshot,
    }

    console.log('[MistyOS][BoundaryRejectionProof]', JSON.stringify(report, null, 2))

    if (!allPassed) {
      const failedTests = testResults.filter((t) => !t.passed)
      fail('Some boundary rejection tests failed', {
        failedTestCount: failedTests.length,
        failed: failedTests.map((t) => ({ name: t.name, result: t.result })),
      })
    }

    await context.close()
  } catch (error) {
    console.error('[MistyOS][BoundaryRejectionProof][FATAL]', error)
    process.exit(1)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error('[MistyOS][BoundaryRejectionProof][FATAL]', error)
  process.exit(1)
})

