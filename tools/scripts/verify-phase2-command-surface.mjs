import { chromium } from 'playwright'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const baseUrl = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5177'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()

try {
  await page.goto(`${baseUrl}/studio`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.studio-menubar', { timeout: 15000 })

  // Start from a clean local storage state to keep command states deterministic.
  await page.evaluate(() => localStorage.clear())
  await page.goto(`${baseUrl}/studio`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.studio-footer-status', { timeout: 15000 })

  const fileTrigger = page.locator('.studio-menu-trigger', { hasText: 'File' })
  await fileTrigger.focus()
  await page.keyboard.press('Alt+f')
  await page.waitForSelector('.studio-menu-dropdown', { state: 'visible' })

  const saveRow = page.locator('.studio-menu-command-label', { hasText: /^Save/ }).first()
  const updateDesktopRow = page.locator('.studio-menu-command-label', { hasText: 'Update Desktop' }).first()
  const saveAsRow = page.locator('.studio-menu-command-label', { hasText: 'Save As (Staged)' })
  assert((await saveRow.count()) > 0, 'File runtime submenu does not show Save command.')
  assert((await updateDesktopRow.count()) > 0, 'File runtime submenu does not show Update Desktop command.')
  assert((await saveAsRow.count()) > 0, 'File runtime submenu does not show staged Save As command.')

  const saveAsButton = saveAsRow.locator('xpath=ancestor::button[1]')
  assert(await saveAsButton.isDisabled(), 'Save As staged command should be disabled.')

  // Escape should close menu and restore focus to the menu trigger.
  await page.keyboard.press('Escape')
  await page.waitForSelector('.studio-menu-dropdown', { state: 'hidden' })
  const focusedText = await page.evaluate(() => document.activeElement?.textContent || '')
  assert(/file/i.test(focusedText), 'Focus was not restored to File menu trigger after Escape.')

  // Make unsaved changes and verify Update Desktop disabled state is accurate.
  await page.locator('.tl-track-row--state').first().click({ position: { x: 90, y: 10 } })
  await page.waitForFunction(() => {
    const status = document.querySelector('.studio-footer-status')
    return /Working:\s*Unsaved edits/i.test(status?.textContent || '')
  })

  const updateFooterButton = page.getByRole('button', { name: 'Update Desktop' })
  assert(await updateFooterButton.isDisabled(), 'Update Desktop should be disabled while unsaved changes exist.')

  // Ctrl+S should invoke the same save command path as menu/footer and clear unsaved state.
  await page.keyboard.press('Control+s')
  await page.waitForFunction(() => {
    const status = document.querySelector('.studio-footer-status')
    return /Working:\s*Saved r\d+/i.test(status?.textContent || '')
  })
  assert(!(await updateFooterButton.isDisabled()), 'Update Desktop should be enabled after Save clears unsaved changes.')

  // Verify toolbar command path integration by changing preview mode from toolbar and checking menu checked state.
  await page.getByRole('button', { name: /Set preview mode to fill/i }).click()
  await page.keyboard.press('Alt+v')
  await page.waitForSelector('.studio-menu-dropdown', { state: 'visible' })

  const fillMenuButton = page.locator('button[role="menuitemradio"][aria-checked="true"] .studio-menu-command-label', { hasText: 'Preview Mode: Fill' })
  assert((await fillMenuButton.count()) > 0, 'View menu did not reflect toolbar preview mode command state.')

  // Keyboard navigation in open menu: ArrowRight should move into submenu list without closing.
  await page.keyboard.press('ArrowRight')
  const submenuFocusedClass = await page.evaluate(() => {
    const el = document.activeElement
    return el ? String(el.className || '') : ''
  })
  assert(/studio-menu-command|studio-menu-submenu-panel/.test(submenuFocusedClass), 'ArrowRight did not move focus into submenu command area.')

  console.log('[Phase2 Verify] PASS')
  console.log(JSON.stringify({ baseUrl }, null, 2))
} finally {
  await browser.close()
}
