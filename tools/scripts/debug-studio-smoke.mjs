import { chromium } from 'playwright'

const baseUrl = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5177'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

page.on('console', (message) => {
  console.log(`[console:${message.type()}] ${message.text()}`)
})

page.on('pageerror', (error) => {
  console.log(`[pageerror] ${error.message}`)
})

try {
  await page.goto(`${baseUrl}/studio`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)
  console.log('timelineRows', await page.locator('.tl-track-row--state').count())
  console.log('statusRows', await page.locator('.studio-footer-status').count())
} finally {
  await browser.close()
}
