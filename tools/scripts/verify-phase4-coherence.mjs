import { chromium } from 'playwright'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const baseUrl = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5176'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()

try {
  await page.goto(`${baseUrl}/studio`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.studio-footer-status', { timeout: 15000 })

  await page.evaluate(() => localStorage.clear())
  await page.goto(`${baseUrl}/studio`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.studio-footer-status', { timeout: 15000 })

  // Add and select a weather clip in the timeline.
  await page.locator('.tl-track-row--state').first().click({ position: { x: 180, y: 10 } })
  await page.waitForSelector('.tl-clip.selected', { timeout: 8000 })
  await page.waitForFunction(() => {
    const header = Array.from(document.querySelectorAll('.inspector-block h3')).find((item) => item.textContent?.includes('State Clip Inspector'))
    return Boolean(header)
  })

  const selectedClipId = await page.evaluate(() => {
    const block = Array.from(document.querySelectorAll('.inspector-block')).find((item) => item.querySelector('h3')?.textContent?.includes('State Clip Inspector'))
    const clipLine = Array.from(block?.querySelectorAll('p') || []).find((item) => (item.textContent || '').trim().startsWith('Clip:'))
    return (clipLine?.textContent || '').replace('Clip:', '').trim() || null
  })
  assert(selectedClipId, 'Could not resolve selected clip id from State Clip Inspector.')

  // Select region q2 in inspector and verify composition reflects it.
  await page.evaluate(() => {
    const block = Array.from(document.querySelectorAll('.inspector-block')).find((item) => item.querySelector('h3')?.textContent?.includes('State Clip Inspector'))
    const regionSelect = block?.querySelector('select')
    if (!regionSelect) {
      throw new Error('Region select was not found in State Clip Inspector.')
    }
    regionSelect.value = 'q2'
    regionSelect.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expectCompositionRegionHighlight(page, 'q2')

  // Composition interaction should update inspector region on same selected clip.
  await page.getByRole('button', { name: 'Open composition workspace' }).click()
  await page.locator('.scene-overlay--composition.active .quadrant-guide.q3').click()
  await page.waitForFunction(() => {
    const blocks = Array.from(document.querySelectorAll('.inspector-block'))
    const target = blocks.find((block) => block.querySelector('h3')?.textContent?.includes('State Clip Inspector'))
    if (!target) return false
    const regionLabel = Array.from(target.querySelectorAll('label')).find((label) => (label.textContent || '').trim().startsWith('Region'))
    const select = regionLabel?.querySelector('select')
    return select?.value === 'q3'
  })
  await expectCompositionRegionHighlight(page, 'q3')

  // Save + publish should persist same clip model region through authoring runtime path.
  await page.getByRole('button', { name: /^Save$/ }).click()
  await page.waitForFunction(() => /Saved:\s*r\d+/i.test(document.querySelector('.studio-footer-status')?.textContent || ''))

  const updateDesktopButton = page.getByRole('button', { name: 'Update Desktop' })
  await updateDesktopButton.click()
  await page.waitForFunction(() => {
    const text = document.querySelector('.studio-footer-status')?.textContent || ''
    return /Published:\s*Up to date/i.test(text)
  })

  const persistence = await page.evaluate((clipId) => {
    const parse = (key) => {
      try {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      } catch {
        return null
      }
    }

    const registry = parse('mistyos.authoring.projects.v1')
    const active = parse('mistyos.authoring.activeProjectId.v1')
    const activeProjectId = active?.projectId || registry?.activeProjectId || null
    const projectDoc = activeProjectId ? parse(`mistyos.authoring.project.v1.${activeProjectId}`) : null

    const extractClipRegion = (runtimePayload) => {
      const clips = runtimePayload?.normalizedClips || []
      const target = clips.find((clip) => clip?.id === clipId)
      return target?.region || null
    }

    return {
      activeProjectId,
      savedRegion: extractClipRegion(projectDoc?.savedDocument?.runtimePayload),
      publishedRegion: extractClipRegion(projectDoc?.publishedDocument?.runtimePayload),
    }
  }, selectedClipId)

  assert(persistence.activeProjectId, 'Active project id missing in persisted project-state data.')
  assert(persistence.savedRegion === 'q3', `Expected saved clip region q3, got ${String(persistence.savedRegion)}.`)
  assert(persistence.publishedRegion === 'q3', `Expected published clip region q3, got ${String(persistence.publishedRegion)}.`)

  console.log('[Phase4 Verify] PASS')
  console.log(JSON.stringify({ baseUrl, region: 'q3', activeProjectId: persistence.activeProjectId }, null, 2))
} finally {
  await browser.close()
}

async function expectCompositionRegionHighlight(page, regionId) {
  await page.waitForFunction((targetRegion) => {
    const node = document.querySelector(`.quadrant-guide.${targetRegion}`)
    return Boolean(node?.classList?.contains('highlighted'))
  }, regionId)
}
