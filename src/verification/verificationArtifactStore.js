const ARTIFACT_INDEX_KEY = 'mistyos.verification.artifacts.index.v1'
const ARTIFACT_KEY_PREFIX = 'mistyos.verification.artifact.v1.'
const ARTIFACT_EVENT = 'mistyos:verification-artifacts-updated'
const MAX_INDEX_ENTRIES = 80

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function readJson(key, fallback) {
  if (!isBrowser()) {
    return fallback
  }

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return fallback
    }
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  if (!isBrowser()) {
    return
  }

  window.localStorage.setItem(key, JSON.stringify(value))
}

function createArtifactId() {
  return `verify-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function toSafeInteger(value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback
}

function toArtifactSummary(artifact) {
  return {
    artifactId: artifact.artifactId,
    projectId: artifact.projectId ?? null,
    publishRevision: toSafeInteger(artifact.publishRevision, 0),
    restartToken: artifact.restartToken ?? null,
    sceneId: artifact.sceneId ?? null,
    timelineId: artifact.timelineId ?? null,
    scenarioName: artifact.scenarioName || artifact.summary?.scenarioName || 'Unnamed Verification Scenario',
    createdAt: artifact.createdAt || new Date().toISOString(),
    pass: Boolean(artifact.pass ?? artifact.overall?.pass),
    sampleCount: toSafeInteger(artifact.sampleCount, Array.isArray(artifact.samples) ? artifact.samples.length : 0),
  }
}

function normalizeArtifact(candidate) {
  const artifactId = String(candidate?.artifactId || candidate?.packetId || '').trim() || createArtifactId()
  const runtimeSamples = Array.isArray(candidate?.runtimeSamples)
    ? candidate.runtimeSamples.map((sample) => ({ ...sample }))
    : []
  const samples = runtimeSamples.length
    ? runtimeSamples
    : Array.isArray(candidate?.samples)
    ? candidate.samples.map((sample) => ({ ...sample }))
    : []

  const scenarios = Array.isArray(candidate?.scenarios)
    ? candidate.scenarios.map((scenario) => {
      const scenarioSamples = Array.isArray(scenario?.samples)
        ? scenario.samples.map((sample) => ({ ...sample }))
        : Array.isArray(scenario?.runtimeSamples)
        ? scenario.runtimeSamples.map((sample) => ({ ...sample }))
        : []

      return {
        scenarioId: scenario?.scenarioId ?? null,
        scenarioName: scenario?.scenarioName ?? null,
        scenarioKind: scenario?.scenarioKind ?? null,
        pass: Boolean(scenario?.pass),
        assertionResults: Array.isArray(scenario?.assertionResults)
          ? scenario.assertionResults.map((result) => ({ ...result }))
          : [],
        samples: scenarioSamples,
        sampleCount: toSafeInteger(scenario?.sampleCount, scenarioSamples.length),
        fieldCoverage: Array.isArray(scenario?.fieldCoverage)
          ? [...scenario.fieldCoverage]
          : [],
        scenarioWindows: Array.isArray(scenario?.scenarioWindows)
          ? scenario.scenarioWindows.map((win) => ({ ...win }))
          : [],
        runtimeSamplePayload: scenario?.runtimeSamplePayload ? { ...scenario.runtimeSamplePayload } : null,
        authoredClipSubset: Array.isArray(scenario?.authoredClipSubset)
          ? scenario.authoredClipSubset.map((clip) => ({ ...clip }))
          : [],
        compiledRuntimeTrackSubset: Array.isArray(scenario?.compiledRuntimeTrackSubset)
          ? scenario.compiledRuntimeTrackSubset.map((track) => ({ ...track }))
          : [],
        field: scenario?.field || null,
      }
    })
    : []

  const scenarioSampleCount = scenarios.reduce((sum, scenario) => sum + toSafeInteger(scenario.sampleCount, 0), 0)
  const topLevelSampleCount = toSafeInteger(candidate?.sampleCount, samples.length)
  const effectiveSampleCount = topLevelSampleCount > 0 ? topLevelSampleCount : scenarioSampleCount

  const normalized = {
    artifactType: candidate?.artifactType || 'mistyos-runtime-verification-report',
    schemaVersion: toSafeInteger(candidate?.schemaVersion, 1),
    artifactId,
    createdAt: candidate?.createdAt || new Date().toISOString(),
    projectId: candidate?.projectId ?? null,
    projectName: candidate?.projectName ?? null,
    saveRevision: toSafeInteger(candidate?.saveRevision, 0),
    publishRevision: toSafeInteger(candidate?.publishRevision, 0),
    restartToken: candidate?.restartToken ?? null,
    sceneId: candidate?.sceneId ?? null,
    timelineId: candidate?.timelineId ?? null,
    scenarioName: candidate?.scenarioName || 'Unnamed Verification Scenario',
    scenarioId: candidate?.scenarioId ?? null,
    scenarioKind: candidate?.scenarioKind ?? null,
    pass: Boolean(candidate?.pass ?? candidate?.overall?.pass),
    overall: candidate?.overall
      ? {
        ...candidate.overall,
        pass: Boolean(candidate.overall.pass),
      }
      : null,
    summary: candidate?.summary ? { ...candidate.summary } : null,
    lineage: candidate?.lineage ? { ...candidate.lineage } : null,
    field: candidate?.field || null,
    sampleCount: effectiveSampleCount,
    assertionResults: Array.isArray(candidate?.assertionResults)
      ? candidate.assertionResults.map((result) => ({ ...result }))
      : [],
    runtimeSamplePayload: candidate?.runtimeSamplePayload ? { ...candidate.runtimeSamplePayload } : null,
    fieldCoverage: Array.isArray(candidate?.fieldCoverage)
      ? [...candidate.fieldCoverage]
      : [],
    scenarioWindows: Array.isArray(candidate?.scenarioWindows)
      ? candidate.scenarioWindows.map((win) => ({ ...win }))
      : [],
    authoredClipSubset: Array.isArray(candidate?.authoredClipSubset)
      ? candidate.authoredClipSubset.map((clip) => ({ ...clip }))
      : [],
    compiledRuntimeTrackSubset: Array.isArray(candidate?.compiledRuntimeTrackSubset)
      ? candidate.compiledRuntimeTrackSubset.map((track) => ({ ...track }))
      : [],
    scenarios,
    runtimeSamples: samples,
    samples,
  }

  return normalized
}

function readArtifactIndexInternal() {
  const index = readJson(ARTIFACT_INDEX_KEY, [])
  if (!Array.isArray(index)) {
    return []
  }

  return index
    .map((entry) => ({
      artifactId: String(entry?.artifactId || '').trim(),
      projectId: entry?.projectId ?? null,
      publishRevision: toSafeInteger(entry?.publishRevision, 0),
      restartToken: entry?.restartToken ?? null,
      sceneId: entry?.sceneId ?? null,
      timelineId: entry?.timelineId ?? null,
      scenarioName: entry?.scenarioName || 'Unnamed Verification Scenario',
      createdAt: entry?.createdAt || null,
      pass: Boolean(entry?.pass),
      sampleCount: toSafeInteger(entry?.sampleCount, 0),
    }))
    .filter((entry) => Boolean(entry.artifactId))
}

function emitArtifactsChanged() {
  if (!isBrowser()) {
    return
  }

  window.dispatchEvent(new CustomEvent(ARTIFACT_EVENT))
}

function doesMatchFilter(summary, filter = {}) {
  const {
    projectId,
    publishRevision,
    restartToken,
    sceneId,
    timelineId,
  } = filter

  if (projectId && summary.projectId !== projectId) {
    return false
  }

  if (Number.isFinite(Number(publishRevision)) && summary.publishRevision !== Number(publishRevision)) {
    return false
  }

  if (restartToken && summary.restartToken !== restartToken) {
    return false
  }

  if (sceneId && summary.sceneId !== sceneId) {
    return false
  }

  if (timelineId && summary.timelineId !== timelineId) {
    return false
  }

  return true
}

export function persistVerificationArtifact(artifact) {
  if (!isBrowser()) {
    return null
  }

  const normalized = normalizeArtifact(artifact)
  const summary = toArtifactSummary(normalized)

  writeJson(`${ARTIFACT_KEY_PREFIX}${normalized.artifactId}`, normalized)

  const existing = readArtifactIndexInternal().filter((entry) => entry.artifactId !== normalized.artifactId)
  const nextIndex = [summary, ...existing].slice(0, MAX_INDEX_ENTRIES)
  writeJson(ARTIFACT_INDEX_KEY, nextIndex)
  emitArtifactsChanged()

  return normalized
}

export function getVerificationArtifactById(artifactId) {
  const safeId = String(artifactId || '').trim()
  if (!safeId) {
    return null
  }

  return readJson(`${ARTIFACT_KEY_PREFIX}${safeId}`, null)
}

export function getVerificationArtifactIndex(options = {}) {
  const { limit = 20, ...filter } = options
  const safeLimit = Math.max(1, Math.min(200, toSafeInteger(limit, 20)))

  return readArtifactIndexInternal()
    .filter((summary) => doesMatchFilter(summary, filter))
    .slice(0, safeLimit)
}

export function getLatestVerificationArtifact(filter = {}) {
  const [summary] = getVerificationArtifactIndex({ ...filter, limit: 1 })
  if (!summary) {
    return null
  }

  return getVerificationArtifactById(summary.artifactId)
}

export function subscribeVerificationArtifacts(callback) {
  if (!isBrowser()) {
    return () => {}
  }

  const notify = () => {
    callback(getVerificationArtifactIndex({ limit: 20 }))
  }

  window.addEventListener(ARTIFACT_EVENT, notify)
  window.addEventListener('storage', notify)

  return () => {
    window.removeEventListener(ARTIFACT_EVENT, notify)
    window.removeEventListener('storage', notify)
  }
}
