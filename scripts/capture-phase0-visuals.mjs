import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5173/?rdfxDebug=1'
const OUT_DIR = path.resolve('artifacts', 'phase0')
const STORAGE_KEY = 'mistyos.tuning.current.v1'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function setViewMode(page, mode) {
  await page.evaluate(
    ({ storageKey, viewMode }) => {
      const raw = localStorage.getItem(storageKey)
      const cfg = raw ? JSON.parse(raw) : {}
      cfg.debug = cfg.debug || {}
      cfg.debug.viewMode = viewMode
      cfg.debug.splitCompareEnabled = viewMode === 'split-compare'
      localStorage.setItem(storageKey, JSON.stringify(cfg))
    },
    { storageKey: STORAGE_KEY, viewMode: mode },
  )
}

async function snap(page, viewMode, filename) {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('.hud .line', { timeout: 30000 })
  await setViewMode(page, viewMode)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.hud .line', { timeout: 30000 })
  await sleep(2000)
  const target = path.join(OUT_DIR, filename)
  await page.screenshot({ path: target, fullPage: true })
  console.log(`Saved ${target}`)
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
    const page = await context.newPage()
    await snap(page, 'renderer-only', 'renderer-only.png')
    await snap(page, 'fog-only', 'fog-only.png')
    await snap(page, 'combined', 'combined-reference.png')
  } finally {
    await browser.close()
  }
}

run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
