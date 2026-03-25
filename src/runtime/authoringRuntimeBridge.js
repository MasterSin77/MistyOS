const STORAGE_KEYS = {
  projectRegistry: 'mistyos.authoring.projects.v1',
  activeProjectId: 'mistyos.authoring.activeProjectId.v1',
  legacySaved: 'mistyos.authoring.saved.v1',
  legacyPublished: 'mistyos.runtime.published.v1',
}

const PROJECT_STORAGE_PREFIX = 'mistyos.authoring.project.v1.'

const SYNC_CHANNEL = 'mistyos.runtime.sync.v1'
const SYNC_EVENT = 'mistyos:runtime-sync'

function isDevRuntime() {
  try {
    return Boolean(import.meta?.env?.DEV)
  } catch {
    return false
  }
}

function devLog(event, details) {
  if (!isDevRuntime()) {
    return
  }

  console.info('[MistyOS][AuthoringBridge]', {
    event,
    ...details,
  })
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function nowIso() {
  return new Date().toISOString()
}

function createProjectId() {
  return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function buildProjectStorageKey(projectId) {
  return `${PROJECT_STORAGE_PREFIX}${projectId}`
}

function normalizeProjectMetadata(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return null
  }

  const projectId = String(candidate.projectId || '').trim()
  if (!projectId) {
    return null
  }

  return {
    projectId,
    name: String(candidate.name || 'Untitled Project').trim() || 'Untitled Project',
    createdAt: candidate.createdAt || nowIso(),
    updatedAt: candidate.updatedAt || nowIso(),
    lastPublishedAt: candidate.lastPublishedAt || null,
  }
}

function normalizeProjectRegistry(candidate) {
  const fallback = {
    schemaVersion: 1,
    projects: [],
  }
  if (!candidate || typeof candidate !== 'object') {
    return fallback
  }

  const projects = Array.isArray(candidate.projects)
    ? candidate.projects.map((item) => normalizeProjectMetadata(item)).filter(Boolean)
    : []

  return {
    schemaVersion: 1,
    projects,
  }
}

function normalizeProjectDocument(candidate, fallbackMetadata = null) {
  if (!candidate || typeof candidate !== 'object') {
    return null
  }

  const metadata = normalizeProjectMetadata(candidate.metadata || fallbackMetadata)
  if (!metadata) {
    return null
  }

  const savedDocument = normalizeSavedDocument(candidate.savedDocument)
  const publishedDocument = normalizePublishedDocument(candidate.publishedDocument)

  return {
    schemaVersion: 1,
    metadata,
    savedDocument,
    publishedDocument,
  }
}

function persistProjectRegistry(registry) {
  const normalized = normalizeProjectRegistry(registry)
  localStorage.setItem(STORAGE_KEYS.projectRegistry, JSON.stringify(normalized))
  notifyKeyChange(STORAGE_KEYS.projectRegistry, normalized)
  return normalized
}

function persistActiveProjectId(projectId) {
  localStorage.setItem(STORAGE_KEYS.activeProjectId, JSON.stringify({ projectId }))
  notifyKeyChange(STORAGE_KEYS.activeProjectId, { projectId })
  return projectId
}

function readActiveProjectId() {
  const parsed = getParsedStorageItem(STORAGE_KEYS.activeProjectId)
  const projectId = String(parsed?.projectId || '').trim()
  return projectId || null
}

function readProjectRegistry() {
  return normalizeProjectRegistry(getParsedStorageItem(STORAGE_KEYS.projectRegistry))
}

function readProjectDocument(projectId) {
  if (!projectId) {
    return null
  }
  return normalizeProjectDocument(getParsedStorageItem(buildProjectStorageKey(projectId)), {
    projectId,
    name: 'Untitled Project',
  })
}

function persistProjectDocument(projectDocument) {
  const normalized = normalizeProjectDocument(projectDocument)
  if (!normalized) {
    return null
  }

  const key = buildProjectStorageKey(normalized.metadata.projectId)
  localStorage.setItem(key, JSON.stringify(normalized))
  notifyKeyChange(key, normalized)
  return normalized
}

function upsertRegistryMetadata(metadataUpdater) {
  const registry = readProjectRegistry()
  const nextProjects = [...registry.projects]
  const metadata = metadataUpdater(nextProjects)
  const nextRegistry = {
    ...registry,
    projects: nextProjects,
  }
  persistProjectRegistry(nextRegistry)
  return metadata
}

function ensureDefaultProject({ preferredName = 'Untitled Project', runtimePayload = null, savedDocument = null, publishedDocument = null } = {}) {
  const createdAt = nowIso()
  const projectId = createProjectId()
  const metadata = normalizeProjectMetadata({
    projectId,
    name: preferredName,
    createdAt,
    updatedAt: createdAt,
    lastPublishedAt: publishedDocument?.publishedAt || null,
  })

  const initialSaved = savedDocument || (runtimePayload
    ? normalizeSavedDocument({
      schemaVersion: 1,
      savedRevision: 1,
      savedAt: createdAt,
      runtimePayload,
    })
    : null)

  const nextProjectDocument = normalizeProjectDocument({
    schemaVersion: 1,
    metadata,
    savedDocument: initialSaved,
    publishedDocument,
  })

  persistProjectDocument(nextProjectDocument)
  persistProjectRegistry({
    schemaVersion: 1,
    projects: [metadata],
  })
  persistActiveProjectId(projectId)

  return nextProjectDocument
}

function ensureProjectSystemInitialized() {
  const registry = readProjectRegistry()
  const activeProjectId = readActiveProjectId()
  if (registry.projects.length > 0 && activeProjectId && registry.projects.some((project) => project.projectId === activeProjectId)) {
    return
  }

  // Migrate legacy single-session documents into a first project if available.
  const legacySaved = normalizeSavedDocument(getParsedStorageItem(STORAGE_KEYS.legacySaved))
  const legacyPublished = normalizePublishedDocument(getParsedStorageItem(STORAGE_KEYS.legacyPublished))
  const seedPayload = legacySaved?.runtimePayload || legacyPublished?.runtimePayload || null
  ensureDefaultProject({
    preferredName: 'Project 1',
    runtimePayload: seedPayload,
    savedDocument: legacySaved,
    publishedDocument: legacyPublished,
  })
}

function getActiveProjectIdInternal() {
  ensureProjectSystemInitialized()
  const registry = readProjectRegistry()
  const activeProjectId = readActiveProjectId()
  if (activeProjectId && registry.projects.some((project) => project.projectId === activeProjectId)) {
    return activeProjectId
  }

  const fallbackProjectId = registry.projects[0]?.projectId || null
  if (fallbackProjectId) {
    persistActiveProjectId(fallbackProjectId)
  }
  return fallbackProjectId
}

function getActiveProjectDocument() {
  const projectId = getActiveProjectIdInternal()
  if (!projectId) {
    return null
  }
  return readProjectDocument(projectId)
}

function touchProjectMetadata(projectId, patch) {
  upsertRegistryMetadata((projects) => {
    const index = projects.findIndex((project) => project.projectId === projectId)
    if (index < 0) {
      return null
    }
    const updated = normalizeProjectMetadata({
      ...projects[index],
      ...patch,
    })
    projects[index] = updated
    return updated
  })
}

function writeActiveProjectDocument(mutator) {
  const current = getActiveProjectDocument()
  if (!current) {
    return null
  }

  const projectId = current.metadata.projectId
  const next = normalizeProjectDocument(mutator(deepClone(current)))
  if (!next) {
    return null
  }

  const persisted = persistProjectDocument(next)
  touchProjectMetadata(projectId, {
    name: persisted.metadata.name,
    updatedAt: persisted.metadata.updatedAt,
    lastPublishedAt: persisted.metadata.lastPublishedAt,
  })
  return persisted
}

function getParsedStorageItem(key) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) {
      return null
    }
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function notifyKeyChange(key, value) {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new CustomEvent(SYNC_EVENT, {
    detail: {
      key,
      value,
    },
  }))

  if ('BroadcastChannel' in window) {
    const channel = new BroadcastChannel(SYNC_CHANNEL)
    channel.postMessage({ key, value })
    channel.close()
  }
}

function persistDocument(key, document) {
  localStorage.setItem(key, JSON.stringify(document))
  notifyKeyChange(key, document)
  return document
}

function createRestartToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function normalizeSavedDocument(candidate) {
  if (!candidate || typeof candidate !== 'object' || !candidate.runtimePayload) {
    return null
  }

  return {
    schemaVersion: 1,
    savedRevision: Number(candidate.savedRevision) || 1,
    savedAt: candidate.savedAt || new Date().toISOString(),
    runtimePayload: deepClone(candidate.runtimePayload),
  }
}

function normalizePublishedDocument(candidate) {
  if (!candidate || typeof candidate !== 'object' || !candidate.runtimePayload) {
    return null
  }

  return {
    schemaVersion: 1,
    publishRevision: Number(candidate.publishRevision) || 1,
    publishedAt: candidate.publishedAt || new Date().toISOString(),
    restartToken: String(candidate.restartToken || createRestartToken()),
    fromSavedRevision: Number(candidate.fromSavedRevision) || 1,
    runtimePayload: deepClone(candidate.runtimePayload),
  }
}

function subscribeToStorageKey(key, callback) {
  if (typeof window === 'undefined') {
    return () => {}
  }

  const onStorage = (event) => {
    if (event.key !== key) {
      return
    }
    callback(getParsedStorageItem(key))
  }

  const onSyncEvent = (event) => {
    if (event.detail?.key !== key) {
      return
    }
    callback(event.detail.value || getParsedStorageItem(key))
  }

  window.addEventListener('storage', onStorage)
  window.addEventListener(SYNC_EVENT, onSyncEvent)

  let channel = null
  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel(SYNC_CHANNEL)
    channel.onmessage = (event) => {
      if (event.data?.key !== key) {
        return
      }
      callback(event.data.value || getParsedStorageItem(key))
    }
  }

  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(SYNC_EVENT, onSyncEvent)
    channel?.close()
  }
}

function stableSerialize(value) {
  if (value === null || value === undefined) {
    return String(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    return `{${parts.join(',')}}`
  }

  return JSON.stringify(value)
}

export function runtimePayloadFingerprint(runtimePayload) {
  return stableSerialize(runtimePayload)
}

export function buildWorkingRuntimePayload({
  selectedSceneId,
  selectedPresetId,
  selectedTimelineId,
  startupMode,
  timelineDurationSec,
  normalizedClips,
  authoredTimeline,
  loopPlayback,
  settingsSnapshot,
}) {
  return {
    schemaVersion: 1,
    selectedSceneId,
    selectedPresetId,
    selectedTimelineId,
    startupMode,
    timelineDurationSec,
    loopPlayback: loopPlayback !== false,
    normalizedClips: deepClone(normalizedClips || []),
    authoredTimeline: deepClone(authoredTimeline || null),
    settingsSnapshot: deepClone(settingsSnapshot || {}),
  }
}

export function getSavedAuthoringDocument() {
  return getActiveProjectDocument()?.savedDocument || null
}

export function saveSavedAuthoringDocument(runtimePayload) {
  const persistedProject = writeActiveProjectDocument((project) => {
    const previousSaved = normalizeSavedDocument(project.savedDocument)
    const updatedAt = nowIso()
    project.metadata.updatedAt = updatedAt
    project.savedDocument = {
      schemaVersion: 1,
      savedRevision: (previousSaved?.savedRevision || 0) + 1,
      savedAt: updatedAt,
      runtimePayload: deepClone(runtimePayload),
    }
    return project
  })

  const nextDocument = persistedProject?.savedDocument || null
  if (nextDocument) {
    devLog('save', {
      projectId: persistedProject.metadata.projectId,
      savedRevision: nextDocument.savedRevision,
      sceneId: nextDocument.runtimePayload?.selectedSceneId || 'unknown',
      timelineId: nextDocument.runtimePayload?.selectedTimelineId || 'unknown',
      startupMode: nextDocument.runtimePayload?.startupMode || 'unknown',
    })
  }
  return nextDocument
}

export function getPublishedRuntimeDocument() {
  return getActiveProjectDocument()?.publishedDocument || null
}

export function publishSavedAuthoringDocument(savedDocument) {
  const normalizedSaved = normalizeSavedDocument(savedDocument)
  if (!normalizedSaved) {
    devLog('publish-skipped', { reason: 'missing-saved-document' })
    return null
  }

  const persistedProject = writeActiveProjectDocument((project) => {
    const current = normalizePublishedDocument(project.publishedDocument)
    const publishedAt = nowIso()
    project.metadata.updatedAt = publishedAt
    project.metadata.lastPublishedAt = publishedAt
    project.publishedDocument = {
      schemaVersion: 1,
      publishRevision: (current?.publishRevision || 0) + 1,
      publishedAt,
      restartToken: createRestartToken(),
      fromSavedRevision: normalizedSaved.savedRevision,
      runtimePayload: deepClone(normalizedSaved.runtimePayload),
    }
    return project
  })

  const nextDocument = persistedProject?.publishedDocument || null
  if (nextDocument) {
    devLog('publish', {
      projectId: persistedProject.metadata.projectId,
      publishRevision: nextDocument.publishRevision,
      fromSavedRevision: nextDocument.fromSavedRevision,
      restartToken: nextDocument.restartToken,
      sceneId: nextDocument.runtimePayload?.selectedSceneId || 'unknown',
      timelineId: nextDocument.runtimePayload?.selectedTimelineId || 'unknown',
    })
  }

  return nextDocument
}

export function subscribeSavedAuthoringDocument(callback) {
  ensureProjectSystemInitialized()
  let unsubscribeProjectKey = null

  const notify = () => callback(getSavedAuthoringDocument())

  const bindProjectSubscription = () => {
    unsubscribeProjectKey?.()
    unsubscribeProjectKey = null
    const activeProjectId = getActiveProjectIdInternal()
    if (activeProjectId) {
      unsubscribeProjectKey = subscribeToStorageKey(buildProjectStorageKey(activeProjectId), notify)
    }
  }

  bindProjectSubscription()
  notify()

  const unsubscribeActive = subscribeToStorageKey(STORAGE_KEYS.activeProjectId, () => {
    bindProjectSubscription()
    notify()
  })

  return () => {
    unsubscribeProjectKey?.()
    unsubscribeActive()
  }
}

export function subscribePublishedRuntimeDocument(callback) {
  ensureProjectSystemInitialized()
  let unsubscribeProjectKey = null

  const notify = () => callback(getPublishedRuntimeDocument())

  const bindProjectSubscription = () => {
    unsubscribeProjectKey?.()
    unsubscribeProjectKey = null
    const activeProjectId = getActiveProjectIdInternal()
    if (activeProjectId) {
      unsubscribeProjectKey = subscribeToStorageKey(buildProjectStorageKey(activeProjectId), notify)
    }
  }

  bindProjectSubscription()
  notify()

  const unsubscribeActive = subscribeToStorageKey(STORAGE_KEYS.activeProjectId, () => {
    bindProjectSubscription()
    notify()
  })

  return () => {
    unsubscribeProjectKey?.()
    unsubscribeActive()
  }
}

export function getProjectRegistry() {
  ensureProjectSystemInitialized()
  const registry = readProjectRegistry()
  return {
    activeProjectId: getActiveProjectIdInternal(),
    projects: registry.projects,
  }
}

export function subscribeProjectRegistry(callback) {
  ensureProjectSystemInitialized()
  const notify = () => {
    callback(getProjectRegistry())
  }
  notify()

  const unsubscribeRegistry = subscribeToStorageKey(STORAGE_KEYS.projectRegistry, notify)
  const unsubscribeActive = subscribeToStorageKey(STORAGE_KEYS.activeProjectId, notify)
  return () => {
    unsubscribeRegistry()
    unsubscribeActive()
  }
}

export function subscribeActiveProjectId(callback) {
  ensureProjectSystemInitialized()
  const notify = () => {
    callback(getActiveProjectIdInternal())
  }
  notify()
  return subscribeToStorageKey(STORAGE_KEYS.activeProjectId, notify)
}

export function createProject({
  name,
  runtimePayload = null,
  savedDocument = null,
  publishedDocument = null,
  setActive = true,
} = {}) {
  ensureProjectSystemInitialized()

  const createdAt = nowIso()
  const projectId = createProjectId()
  const metadata = normalizeProjectMetadata({
    projectId,
    name: name || `Project ${readProjectRegistry().projects.length + 1}`,
    createdAt,
    updatedAt: createdAt,
    lastPublishedAt: publishedDocument?.publishedAt || null,
  })

  const nextSaved = savedDocument || (runtimePayload ? {
    schemaVersion: 1,
    savedRevision: 1,
    savedAt: createdAt,
    runtimePayload: deepClone(runtimePayload),
  } : null)

  const projectDocument = normalizeProjectDocument({
    schemaVersion: 1,
    metadata,
    savedDocument: nextSaved,
    publishedDocument,
  })

  persistProjectDocument(projectDocument)
  upsertRegistryMetadata((projects) => {
    projects.push(metadata)
    return metadata
  })

  if (setActive) {
    persistActiveProjectId(projectId)
  }

  devLog('project-create', {
    projectId,
    name: metadata.name,
    setActive,
  })

  return projectDocument
}

export function cloneActiveProjectAs({ name, runtimePayload }) {
  const sourceProject = getActiveProjectDocument()
  const payload = runtimePayload || sourceProject?.savedDocument?.runtimePayload || null
  return createProject({
    name,
    runtimePayload: payload,
    publishedDocument: null,
    setActive: true,
  })
}

export function switchActiveProject(projectId) {
  ensureProjectSystemInitialized()
  const registry = readProjectRegistry()
  const targetId = String(projectId || '').trim()
  if (!targetId || !registry.projects.some((project) => project.projectId === targetId)) {
    return null
  }

  persistActiveProjectId(targetId)
  const document = readProjectDocument(targetId)
  devLog('project-switch', {
    projectId: targetId,
    name: document?.metadata?.name || 'unknown',
  })
  return document
}

export function deleteProject(projectId) {
  ensureProjectSystemInitialized()
  const targetId = String(projectId || '').trim()
  if (!targetId) {
    return false
  }

  const registry = readProjectRegistry()
  const nextProjects = registry.projects.filter((project) => project.projectId !== targetId)
  if (nextProjects.length === registry.projects.length) {
    return false
  }

  localStorage.removeItem(buildProjectStorageKey(targetId))
  notifyKeyChange(buildProjectStorageKey(targetId), null)
  persistProjectRegistry({ schemaVersion: 1, projects: nextProjects })

  const activeProjectId = getActiveProjectIdInternal()
  if (activeProjectId === targetId) {
    const fallbackId = nextProjects[0]?.projectId || null
    if (fallbackId) {
      persistActiveProjectId(fallbackId)
    } else {
      ensureDefaultProject({ preferredName: 'Project 1' })
    }
  }

  return true
}

export function importProjectDocument(candidateProject, { name } = {}) {
  const runtimePayload = candidateProject?.runtimePayload || null
  if (!runtimePayload) {
    return null
  }

  const imported = createProject({
    name: name || candidateProject?.metadata?.name || 'Imported Project',
    runtimePayload,
    setActive: true,
  })
  return imported
}

export function exportActiveProjectDocument({ workingRuntimePayload = null } = {}) {
  const activeProject = getActiveProjectDocument()
  if (!activeProject) {
    return null
  }

  return {
    schemaVersion: 1,
    type: 'mistyos-project',
    exportedAt: nowIso(),
    metadata: deepClone(activeProject.metadata),
    workingRuntimePayload: deepClone(workingRuntimePayload || activeProject.savedDocument?.runtimePayload || null),
    savedDocument: deepClone(activeProject.savedDocument),
    publishedDocument: deepClone(activeProject.publishedDocument),
    runtimePayload: deepClone(workingRuntimePayload || activeProject.savedDocument?.runtimePayload || null),
  }
}

export function getActiveProjectSummary() {
  const registry = getProjectRegistry()
  const metadata = registry.projects.find((project) => project.projectId === registry.activeProjectId) || null
  return {
    activeProjectId: registry.activeProjectId,
    metadata,
  }
}
