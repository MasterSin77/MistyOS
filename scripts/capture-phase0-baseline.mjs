import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5173/?rdfxDebug=1'
const OUT_DIR = path.resolve('artifacts', 'phase0')
const OUT_JSON = process.env.OUT_JSON
  ? path.resolve(process.env.OUT_JSON)
  : path.join(OUT_DIR, 'baseline-metrics.json')
const FORCE_GPU_OVERLAY = process.env.FORCE_GPU_OVERLAY === '1'
const FORCE_OVERLAY_COMPARE = process.env.FORCE_OVERLAY_COMPARE === '1'
const FORCE_GPU_FOG_COMPOSITING = process.env.FORCE_GPU_FOG_COMPOSITING === '1'
const FORCE_GPU_WETNESS_SIMULATION = process.env.FORCE_GPU_WETNESS_SIMULATION === '1'
const FORCE_GPU_WRITING_INTERACTION = process.env.FORCE_GPU_WRITING_INTERACTION === '1'
const FORCE_COMPAT_MODE = process.env.FORCE_COMPAT_MODE || ''
const VIEWPORT_DEFAULT = { width: 1920, height: 1080 }
const VIEWPORT_ULTRAWIDE = { width: 3440, height: 1440 }
const WARMUP_MS = 12000
const STORAGE_KEY = 'mistyos.tuning.current.v1'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseHudLines(lines) {
  const data = {}
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    const pairs = [
      ['avgFrameMs', /Avg frame ms:\s*([\d.]+)/i],
      ['engineMs', /Engine ms:\s*([\d.]+)/i],
      ['rendererMs', /Renderer ms:\s*([\d.]+)/i],
      ['wetnessMs', /Wetness ms:\s*([\d.]+)/i],
      ['wetnessBackend', /Wetness backend:\s*([^\s]+)/i],
      ['interactionBackend', /Interaction backend:\s*([^\s]+)/i],
      ['compatibilityMode', /Compatibility mode:\s*([^\s]+)/i],
      ['gpuWriteQueueDepth', /GPU write queue depth:\s*([\d.]+)/i],
      ['gpuWritesConsumed', /GPU writes consumed:\s*([\d.]+)/i],
      ['gpuWritesDropped', /GPU writes dropped:\s*([\d.]+)/i],
      ['gpuWritesCoalesced', /GPU writes coalesced:\s*([\d.]+)/i],
      ['gpuWritePressure', /GPU write pressure:\s*([^\s]+)/i],
      ['gpuWriteBudget', /GPU write budget:\s*([\d.]+)/i],
      ['gpuSimKernel', /GPU sim kernel:\s*([^\s]+)/i],
      ['gpuSimReadbackMs', /GPU sim readback ms:\s*([\d.]+)/i],
      ['cpuFogAlphaMean', /CPU fog alpha mean:\s*([\d.]+)/i],
      ['gpuFogAlphaMean', /GPU fog alpha mean:\s*([\d.]+)/i],
      ['gpuCpuAlphaDelta', /GPU-CPU alpha delta:\s*([\d.]+)/i],
      ['gpuCpuAlphaMae', /GPU-CPU alpha MAE:\s*([\d.]+)/i],
      ['cpuFogAlphaVariance', /CPU fog alpha var:\s*([\d.]+)/i],
      ['gpuFogAlphaVariance', /GPU fog alpha var:\s*([\d.]+)/i],
      ['gpuCpuVarianceDelta', /GPU-CPU var delta:\s*([\d.]+)/i],
      ['gpuCpuTileMaxMae', /GPU-CPU tile max MAE:\s*([\d.]+)/i],
      ['gpuCpuTileHotspot', /GPU-CPU hotspot tile:\s*([^\s]+)/i],
      ['gpuParityGateStatus', /GPU parity gate:\s*([^\s]+)/i],
      ['gpuParityGateFailures', /GPU parity failures:\s*([^\s]+)/i],
      ['gpuOverlayUvMode', /GPU overlay UV mode:\s*([^\s]+)/i],
      ['gpuOverlayFogAlphaMean', /GPU overlay fog alpha mean:\s*([\d.]+)/i],
      ['gpuOverlayFogAlphaMax', /GPU overlay fog alpha max:\s*([\d.]+)/i],
      ['gpuOverlayPresentTarget', /GPU present target:\s*([^\s]+)/i],
      ['gpuOverlayPresentFramebuffer', /GPU present framebuffer:\s*([^\s]+)/i],
      ['gpuOverlayPresentSamples', /GPU present samples:\s*([^\s]+)/i],
      ['gpuOverlayPresentSceneSource', /GPU present scene source:\s*([^\s]+)/i],
      ['gpuOverlayPresentClearRgba', /GPU present clear RGBA:\s*([^\s]+)/i],
      ['gpuOverlayPresentBlendEnabled', /GPU present blend enabled:\s*([^\s]+)/i],
      ['gpuOverlayPresentBlendMode', /GPU present blend mode:\s*([^\s]+)/i],
      ['gpuOverlayPresentAlphaConvention', /GPU present alpha convention:\s*([^\s]+)/i],
      ['gpuOverlayPresentContextAlpha', /GPU present ctx alpha:\s*([^\s]+)/i],
      ['gpuOverlayPresentContextPremultiplied', /GPU present ctx premultiplied:\s*([^\s]+)/i],
      ['overlayMs', /Overlay ms:\s*([\d.]+)/i],
      ['overlayBackend', /Overlay backend:\s*([^\s]+)/i],
      ['dropletProcessingMs', /Droplet proc ms:\s*([\d.]+)/i],
      ['clearingMs', /Trail\/capsule clear ms:\s*([\d.]+)/i],
      ['diffusionMs', /Diffusion ms:\s*([\d.]+)/i],
      ['imageConvertMs', /Field-to-image ms:\s*([\d.]+)/i],
      ['wetnessTrendMsPerMin', /Wetness trend:\s*([\-\d.]+)/i],
      ['activeCoveragePct', /Active coverage:\s*([\d.]+)%/i],
      ['wetnessResolutionLabel', /Wetness res:\s*([^\s]+)\s*\(/i],
      ['wetnessResolutionPixels', /Wetness res:.*\((\d+)px\)/i],
    ]

    for (const [key, regex] of pairs) {
      const match = line.match(regex)
      if (!match) continue
      if (key === 'wetnessResolutionLabel') {
        data[key] = match[1]
      } else if (key === 'overlayBackend') {
        data[key] = match[1]
      } else if (key === 'wetnessBackend') {
        data[key] = match[1]
      } else if (key === 'interactionBackend') {
        data[key] = match[1]
      } else if (key === 'compatibilityMode') {
        data[key] = match[1]
      } else if (key === 'gpuSimKernel') {
        data[key] = match[1]
      } else if (key === 'gpuCpuTileHotspot') {
        data[key] = match[1]
      } else if (key === 'gpuParityGateStatus') {
        data[key] = match[1]
      } else if (key === 'gpuParityGateFailures') {
        data[key] = match[1]
      } else if (key === 'gpuOverlayUvMode') {
        data[key] = match[1]
      } else if (key === 'gpuOverlayPresentTarget') {
        data[key] = match[1]
      } else if (key === 'gpuOverlayPresentFramebuffer') {
        data[key] = match[1]
      } else if (key === 'gpuOverlayPresentSamples') {
        data[key] = match[1]
      } else if (key === 'gpuOverlayPresentSceneSource') {
        data[key] = match[1]
      } else if (key === 'gpuOverlayPresentClearRgba') {
        data[key] = match[1]
      } else if (key === 'gpuOverlayPresentBlendEnabled') {
        data[key] = match[1]
      } else if (key === 'gpuOverlayPresentBlendMode') {
        data[key] = match[1]
      } else if (key === 'gpuOverlayPresentAlphaConvention') {
        data[key] = match[1]
      } else if (key === 'gpuOverlayPresentContextAlpha') {
        data[key] = match[1]
      } else if (key === 'gpuOverlayPresentContextPremultiplied') {
        data[key] = match[1]
      } else if (key === 'gpuWritePressure') {
        data[key] = match[1]
      } else if (key === 'wetnessResolutionPixels') {
        data[key] = Number(match[1])
      } else {
        data[key] = Number(match[1])
      }
    }
  }
  return data
}

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

async function applyDebugOverrides(page) {
  await page.evaluate(
    ({ storageKey, forceGpuOverlay, forceOverlayCompare, forceGpuFogCompositing, forceGpuWetnessSimulation, forceGpuWritingInteraction, forceCompatMode }) => {
      const raw = localStorage.getItem(storageKey)
      const cfg = raw ? JSON.parse(raw) : {}
      cfg.debug = cfg.debug || {}
      cfg.debug.useGpuOverlayPrototype = Boolean(forceGpuOverlay)
      cfg.debug.overlayBackendCompareEnabled = Boolean(forceOverlayCompare)
      cfg.debug.useGpuFogCompositing = Boolean(forceGpuFogCompositing)
      cfg.debug.useGpuWetnessSimulation = Boolean(forceGpuWetnessSimulation)
      cfg.debug.useGpuWritingInteractionPrototype = Boolean(forceGpuWritingInteraction)
      if (['auto', 'cpu-compat', 'gpu-sim', 'gpu-interaction'].includes(forceCompatMode)) {
        cfg.debug.compatibilityMode = forceCompatMode
      }
      localStorage.setItem(storageKey, JSON.stringify(cfg))
    },
    {
      storageKey: STORAGE_KEY,
      forceGpuOverlay: FORCE_GPU_OVERLAY,
      forceOverlayCompare: FORCE_OVERLAY_COMPARE,
      forceGpuFogCompositing: FORCE_GPU_FOG_COMPOSITING,
      forceGpuWetnessSimulation: FORCE_GPU_WETNESS_SIMULATION,
      forceGpuWritingInteraction: FORCE_GPU_WRITING_INTERACTION,
      forceCompatMode: FORCE_COMPAT_MODE,
    },
  )
}

async function sceneCapture(page, sceneId, { setup, action, viewport }) {
  if (viewport) {
    await page.setViewportSize(viewport)
  }

  await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('.hud .line', { timeout: 30000 })

  if (setup) {
    await setup(page)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('.hud .line', { timeout: 30000 })
  }

  await applyDebugOverrides(page)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.hud .line', { timeout: 30000 })

  await sleep(WARMUP_MS)

  if (action) {
    await action(page)
    await sleep(2500)
  }

  const lines = await page.locator('.hud .line').allTextContents()
  const metrics = parseHudLines(lines)

  const mem = await page.evaluate(() => {
    const p = globalThis.performance
    const m = p && 'memory' in p ? p.memory : null
    if (!m) return null
    return {
      usedJSHeapSize: m.usedJSHeapSize,
      totalJSHeapSize: m.totalJSHeapSize,
      jsHeapSizeLimit: m.jsHeapSizeLimit,
    }
  })

  const screenshotPath = path.join(OUT_DIR, `${sceneId}.png`)
  await page.screenshot({ path: screenshotPath, fullPage: true })

  return {
    scene: sceneId,
    metrics,
    memory: mem,
    screenshot: screenshotPath,
    capturedAt: new Date().toISOString(),
  }
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true })

  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
  })

  try {
    const context = await browser.newContext({ viewport: VIEWPORT_DEFAULT })
    const page = await context.newPage()

    const results = []

    results.push(await sceneCapture(page, 'A-idle-recovery', {}))

    results.push(await sceneCapture(page, 'B-active-rain', {}))

    results.push(
      await sceneCapture(page, 'C-writing-strokes', {
        action: async (p) => {
          const box = await p.locator('canvas.wet-canvas').boundingBox()
          if (!box) return
          const y = Math.floor(box.y + box.height * 0.58)
          const x0 = Math.floor(box.x + box.width * 0.2)
          const x1 = Math.floor(box.x + box.width * 0.8)
          await p.mouse.move(x0, y)
          await p.mouse.down()
          for (let i = 0; i <= 5; i += 1) {
            const t = i / 5
            await p.mouse.move(Math.floor(x0 + (x1 - x0) * t), y + Math.round(Math.sin(t * Math.PI * 3) * 20), {
              steps: 12,
            })
          }
          await p.mouse.up()
        },
      }),
    )

    results.push(
      await sceneCapture(page, 'D-split-compare', {
        setup: async (p) => {
          await setViewMode(p, 'split-compare')
        },
      }),
    )

    results.push(
      await sceneCapture(page, 'E-ultrawide-stress', {
        viewport: VIEWPORT_ULTRAWIDE,
      }),
    )

    fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2), 'utf8')
    console.log(`Saved baseline metrics to ${OUT_JSON}`)
    for (const row of results) {
      const m = row.metrics
      console.log(`${row.scene}: frame=${m.avgFrameMs ?? 'n/a'} wet=${m.wetnessMs ?? 'n/a'} overlay=${m.overlayMs ?? 'n/a'}`)
    }
  } finally {
    await browser.close()
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
