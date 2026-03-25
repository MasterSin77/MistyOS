import { chromium } from 'playwright'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function extractRevision(labelText, prefix) {
  const pattern = new RegExp(`${prefix}\\s*r(\\d+)`, 'i')
  const match = String(labelText || '').match(pattern)
  return match ? Number(match[1]) : null
}

const baseUrl = process.env.MISTYOS_BASE_URL || 'http://localhost:5176'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const studio = await context.newPage()
const presentation = await context.newPage()

try {
  await studio.goto(`${baseUrl}/studio`, { waitUntil: 'domcontentloaded' })
  await studio.evaluate(() => localStorage.clear())

  await Promise.all([
    studio.goto(`${baseUrl}/studio`, { waitUntil: 'domcontentloaded' }),
    presentation.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' }),
  ])

  await studio.waitForSelector('.tl-track-row--state', { timeout: 15000 })
  await studio.waitForSelector('.studio-footer-status', { timeout: 15000 })
  await presentation.waitForSelector('.presentation-runtime-meta', { timeout: 15000 })

  const initialStatus = await studio.locator('.studio-footer-status').innerText()
  assert(/Published:\s*Not published/i.test(initialStatus), 'Initial Studio status did not show not published state.')

  const beforeMetaLines = await presentation.locator('.presentation-runtime-meta > div').allInnerTexts()
  const beforePublishRevision = extractRevision(beforeMetaLines[0], 'Published') || 0

  await studio.locator('.tl-track-row--state').first().click({ position: { x: 90, y: 10 } })

  await studio.waitForFunction(() => {
    const status = document.querySelector('.studio-footer-status')
    return Boolean(status && /Working:\s*Unsaved edits/i.test(status.textContent || ''))
  })

  await studio.getByRole('button', { name: 'Save' }).click()

  await studio.waitForFunction(() => {
    const status = document.querySelector('.studio-footer-status')
    const text = status?.textContent || ''
    return /Working:\s*Saved r\d+/i.test(text)
  })

  const statusTextAfterSave = await studio.locator('.studio-footer-status').innerText()
  const savedRevisionMatch = statusTextAfterSave.match(/Saved:\s*r(\d+)/i)
  assert(savedRevisionMatch, 'Saved revision was not visible in Studio status.')
  const savedRevision = Number(savedRevisionMatch[1])

  const publishButton = studio.getByRole('button', { name: 'Update Desktop' })
  await publishButton.click()

  await presentation.waitForFunction((previous) => {
    const lines = Array.from(document.querySelectorAll('.presentation-runtime-meta > div')).map((el) => el.textContent || '')
    const first = lines[0] || ''
    const revisionMatch = first.match(/Published\s*r(\d+)/i)
    if (!revisionMatch) {
      return false
    }
    const revision = Number(revisionMatch[1])
    if (revision <= previous) {
      return false
    }
    return lines.some((line) => /restartToken:/i.test(line))
      && lines.some((line) => /fromSavedRevision:/i.test(line))
      && lines.some((line) => /sceneId:/i.test(line))
      && lines.some((line) => /timelineId:/i.test(line))
  }, beforePublishRevision)

  const afterMetaLines = await presentation.locator('.presentation-runtime-meta > div').allInnerTexts()
  const publishRevision = extractRevision(afterMetaLines[0], 'Published')
  assert(Number.isFinite(publishRevision), 'Publish revision was not visible in Presentation metadata.')

  const fromSavedLine = afterMetaLines.find((line) => /fromSavedRevision:/i.test(line)) || ''
  const fromSavedMatch = fromSavedLine.match(/fromSavedRevision:\s*(\d+)/i)
  assert(fromSavedMatch, 'fromSavedRevision line missing from Presentation metadata.')
  const fromSavedRevision = Number(fromSavedMatch[1])

  const restartLine = afterMetaLines.find((line) => /restartToken:/i.test(line)) || ''
  const restartToken = restartLine.split(':').slice(1).join(':').trim()
  assert(restartToken && restartToken !== 'local-default', 'restartToken did not update after first publish.')

  assert(fromSavedRevision === savedRevision, `Revision chain mismatch: fromSavedRevision=${fromSavedRevision}, savedRevision=${savedRevision}`)

  const studioStatusAfterPublish = await studio.locator('.studio-footer-status').innerText()
  assert(/Published:\s*Up to date/i.test(studioStatusAfterPublish), 'Studio did not report published up-to-date after publish.')
  assert(!/Working:\s*Unsaved edits/i.test(studioStatusAfterPublish), 'Studio still reports unsaved edits after save+publish.')

  await studio.locator('.tl-track-row--state').nth(1).click({ position: { x: 120, y: 10 } })
  await studio.getByRole('button', { name: 'Save' }).click()
  await studio.waitForFunction(() => {
    const status = document.querySelector('.studio-footer-status')
    return Boolean(status && /Published:\s*Outdated/i.test(status.textContent || ''))
  })

  const statusWithOutdated = await studio.locator('.studio-footer-status').innerText()
  const savedRevisionOutdatedMatch = statusWithOutdated.match(/Saved:\s*r(\d+)/i)
  assert(savedRevisionOutdatedMatch, 'Saved revision missing after second save.')
  const savedRevisionSecond = Number(savedRevisionOutdatedMatch[1])
  assert(savedRevisionSecond > savedRevision, 'Second save did not increment saved revision.')

  await publishButton.click()

  await presentation.waitForFunction((previousPublishRevision, previousRestartToken) => {
    const lines = Array.from(document.querySelectorAll('.presentation-runtime-meta > div')).map((el) => el.textContent || '')
    const first = lines[0] || ''
    const publishMatch = first.match(/Published\s*r(\d+)/i)
    const fromSavedLine = lines.find((line) => /fromSavedRevision:/i.test(line)) || ''
    const fromSavedMatch = fromSavedLine.match(/fromSavedRevision:\s*(\d+)/i)
    const restartLine = lines.find((line) => /restartToken:/i.test(line)) || ''
    const restartValue = restartLine.split(':').slice(1).join(':').trim()
    if (!publishMatch || !fromSavedMatch || !restartValue) {
      return false
    }
    return Number(publishMatch[1]) > previousPublishRevision && restartValue !== previousRestartToken
  }, publishRevision, restartToken)

  const finalMetaLines = await presentation.locator('.presentation-runtime-meta > div').allInnerTexts()
  const finalPublishRevision = extractRevision(finalMetaLines[0], 'Published')
  const finalFromSavedLine = finalMetaLines.find((line) => /fromSavedRevision:/i.test(line)) || ''
  const finalFromSavedMatch = finalFromSavedLine.match(/fromSavedRevision:\s*(\d+)/i)
  const finalRestartLine = finalMetaLines.find((line) => /restartToken:/i.test(line)) || ''
  const finalRestartToken = finalRestartLine.split(':').slice(1).join(':').trim()

  assert(Number.isFinite(finalPublishRevision) && finalPublishRevision > publishRevision, 'Second publish revision did not increment.')
  assert(finalFromSavedMatch && Number(finalFromSavedMatch[1]) === savedRevisionSecond, 'Second publish did not snapshot latest saved revision.')
  assert(finalRestartToken && finalRestartToken !== restartToken, 'restartToken was not regenerated on second publish.')

  const finalStudioStatus = await studio.locator('.studio-footer-status').innerText()
  assert(/Published:\s*Up to date/i.test(finalStudioStatus), 'Studio did not return to published up-to-date after second publish.')

  console.log('[Phase1 Verify] PASS')
  console.log(JSON.stringify({
    baseUrl,
    savedRevision,
    savedRevisionSecond,
    publishRevision,
    finalPublishRevision,
    fromSavedRevision,
    finalFromSavedRevision: finalFromSavedMatch ? Number(finalFromSavedMatch[1]) : null,
    restartToken,
    finalRestartToken,
    metadataLines: finalMetaLines,
  }, null, 2))
} finally {
  await browser.close()
}
