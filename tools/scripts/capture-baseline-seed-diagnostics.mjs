#!/usr/bin/env node
/**
 * Actual Baseline-Seed Diagnostic Capture
 * Runs deterministic baseline-seed mode and captures behavioral diagnostics
 * using Playwright for headless browser automation.
 * 
 * Usage: node tools/scripts/capture-baseline-seed-diagnostics.mjs
 */

import playwright from 'playwright'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.join(__dirname, '../..')

const BASELINE_SEED_URL = 'http://127.0.0.1:5173/?rdfxBaselineSeedMode=1&rdfxBaselineSeedDebug=1'
const DURATION_SECONDS = 65 // Run for 65s to capture past 60s checkpoint
const CHECKPOINT_SECONDS = [5, 20, 60]

async function captureBaselineSeedDiagnostics() {
  console.log('\n=== Baseline-Seed Diagnostic Capture ===')
  console.log(`URL: ${BASELINE_SEED_URL}`)
  console.log(`Duration: ${DURATION_SECONDS}s`)
  console.log(`Checkpoints: ${CHECKPOINT_SECONDS.join('s, ')}s\n`)

  const browser = await playwright.chromium.launch({ headless: true })
  let page = null
  const capturedData = {
    timestamp: new Date().toISOString(),
    checkpoints: {},
    errors: [],
  }

  try {
    page = await browser.newPage()

    // Set up console message capture
    const consoleLogs = []
    page.on('console', (msg) => {
      consoleLogs.push({ level: msg.type(), text: msg.text() })
    })

    console.log('[1] Loading baseline-seed page...')
    await page.goto(BASELINE_SEED_URL, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1000)

    // Verify baseline-seed mode is active
    const isModeActive = await page.evaluate(() => {
      const params = new URLSearchParams(window.location.search)
      return params.get('rdfxBaselineSeedMode') === '1'
    })

    if (!isModeActive) {
      throw new Error('Baseline-seed mode not detected in URL')
    }

    console.log('✓ Baseline-seed mode active')

    // Capture at each checkpoint
    for (const checkpointSec of CHECKPOINT_SECONDS) {
      console.log(`\n[*] Waiting for ${checkpointSec}s checkpoint...`)
      await page.waitForTimeout(checkpointSec * 1000)

      // Extract diagnostics from page
      const snapshot = await page.evaluate(() => {
        const debug = window.__debug_state || {}
        const adapter = debug.rendererAdapter || {}
        const diagnosticReport = adapter.baselineSeedDiagnosticsReport || {}

        return {
          elapsedSeconds: checkpointSec,
          timestamp: new Date().toISOString(),
          adapterDebug: {
            baselineSeedModeEnabled: adapter.baselineSeedModeEnabled || false,
            baselineSeedApplied: adapter.baselineSeedApplied || false,
            simulatorRaindropCount: adapter.simulatorRaindropCount || 0,
            lastFrameTotal: adapter.lastFrameTotal || 0,
          },
          controlsSnapshot: adapter.baselineSeedSimulatorOptionSnapshot || {},
          diagnostics: diagnosticReport,
          urlParams: {
            mode: new URLSearchParams(window.location.search).get('rdfxBaselineSeedMode'),
            debug: new URLSearchParams(window.location.search).get('rdfxBaselineSeedDebug'),
          },
        }
      })

      capturedData.checkpoints[checkpointSec] = snapshot
      console.log(`✓ Captured ${checkpointSec}s checkpoint`)
      console.log(`  Active drops: ${snapshot.adapterDebug.simulatorRaindropCount}`)
      console.log(`  Frame total: ${snapshot.adapterDebug.lastFrameTotal.toFixed(2)}s`)
    }

    // Final position at 65s
    await page.waitForTimeout(5000)
    const finalSnapshot = await page.evaluate(() => {
      const debug = window.__debug_state || {}
      const adapter = debug.rendererAdapter || {}
      return {
        finalDropCount: adapter.simulatorRaindropCount || 0,
        finalFrameTotal: adapter.lastFrameTotal || 0,
      }
    })

    console.log(`\n✓ Final state at ${DURATION_SECONDS}s`)
    console.log(`  Active drops: ${finalSnapshot.finalDropCount}`)
    console.log(`  Frame elapsed: ${finalSnapshot.finalFrameTotal.toFixed(2)}s`)
    capturedData.finalSnapshot = finalSnapshot

    // Write report
    const reportPath = path.join(ROOT_DIR, 'baseline-seed-diagnostic-capture.json')
    await fs.writeFile(reportPath, JSON.stringify(capturedData, null, 2))
    console.log(`\n✓ Report written to ${reportPath}`)

    return capturedData
  } catch (error) {
    console.error('\n✗ Capture failed:', error.message)
    capturedData.errors.push(error.message)

    const reportPath = path.join(ROOT_DIR, 'baseline-seed-diagnostic-capture-error.json')
    await fs.writeFile(reportPath, JSON.stringify(capturedData, null, 2))
    throw error
  } finally {
    if (page) {
      await page.close()
    }
    await browser.close()
  }
}

// Run capture
captureBaselineSeedDiagnostics()
  .then((data) => {
    console.log('\n=== Capture Complete ===')
    process.exit(0)
  })
  .catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })
