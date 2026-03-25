import { useCallback, useEffect, useRef, useState } from 'react'
import { INTENT_KINDS, REGION_IDS } from './model'
import { createDefaultClip, createMistClip, createRainClip, createWindClip } from './clips'
import { StudioIcon } from '../components/StudioIcon'

// ---- Track definitions ----
// State tracks: continuous atmospheric conditions (larger visual)
const STATE_TRACK_DEFS = [
  { id: 'wind',        label: 'Wind',         color: '#5f8fc0' },
  { id: 'rain',        label: 'Rain',         color: '#3a9bd5' },
  { id: 'mist',        label: 'Mist',         color: '#5ec4e0' },
  { id: 'fogBuildup',  label: 'Fog Buildup',  color: '#7898c0' },
  { id: 'fogClearing', label: 'Fog Clearing', color: '#6ab898' },
  { id: 'washdown',    label: 'Washdown',     color: '#5080b0' },
]

// Event track: discrete intent events (authoring blocks by default)
const EVENT_TRACK_DEF = { id: 'intent', label: 'Intent', color: '#c4952a' }

const TRACK_GROUPS = [
  { id: 'atmosphere', label: 'Atmosphere', tracks: ['wind', 'rain', 'mist'] },
  { id: 'fog', label: 'Fog System', tracks: ['fogBuildup', 'fogClearing'] },
  { id: 'surface', label: 'Surface', tracks: ['washdown'] },
  { id: 'events', label: 'Events', tracks: ['intent'] },
]

const LABEL_W = 98        // px — label column width
const STATE_TRACK_H = 36  // px — height of state track row
const EVENT_TRACK_H = 28  // px — height of event track row
const RULER_H = 18        // px — height of time ruler

let _idCounter = 0
function genId() {
  return `clip-${Date.now()}-${(_idCounter += 1)}`
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function formatEventTooltip(clip) {
  return [
    'Intent Event',
    `Type: ${clip.intentKind || 'intent'}`,
    `Region: ${clip.region || 'global'}`,
    `Start: ${clip.startSec.toFixed(1)}s`,
  ].join('\n')
}

function formatStateTooltip(trackLabel, clip) {
  return [
    `${trackLabel} Event`,
    `Intensity: ${(clip.intensity ?? 0.5).toFixed(2)}`,
    `Duration: ${(clip.endSec - clip.startSec).toFixed(1)}s`,
    `Start: ${clip.startSec.toFixed(1)}s`,
  ].join('\n')
}

function formatTimecode(totalSec) {
  const safeSec = Math.max(0, Number(totalSec) || 0)
  const minutes = Math.floor(safeSec / 60)
  const seconds = Math.floor(safeSec % 60)
  const centiseconds = Math.floor((safeSec % 1) * 100)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`
}

/**
 * Compute the new clip state resulting from a drag operation.
 * Uses the original positions captured at drag-start so both mousemove
 * and mouseup produce consistent results from (originals + delta).
 */
function applyDragToClip(clip, drag, dxSec, totalDurationSec) {
  const minDur = 1
  if (drag.type === 'move') {
    const dur = drag.origEndSec - drag.origStartSec
    const newStart = Math.max(0, Math.min(totalDurationSec - dur, drag.origStartSec + dxSec))
    return { ...clip, startSec: newStart, endSec: newStart + dur }
  }
  if (drag.type === 'resizeLeft') {
    const newStart = Math.max(0, Math.min(drag.origStartSec + dxSec, drag.origEndSec - minDur))
    return { ...clip, startSec: newStart }
  }
  if (drag.type === 'resizeRight') {
    const newEnd = Math.min(totalDurationSec, Math.max(drag.origEndSec + dxSec, drag.origStartSec + minDur))
    return { ...clip, endSec: newEnd }
  }
  return clip
}

/**
 * Timeline editor component.
 *
 * Props:
 *   initialClips       — array of clip objects (used as initial state; use component `key` to reset)
 *   onClipsCommit      — called with the final clips array on user commit (mouseup / add / delete / inspector edit)
 *   onClipSelect       — called with { clipId, clip, trackKind, region?, intentKind? } when a clip is selected
 *   playheadSec        — current playback position in seconds (for the playhead overlay)
 *   totalDurationSec   — total timeline duration in seconds
 */
export function TimelineEditor({
  initialClips,
  onClipsCommit,
  onClipSelect,
  selectedClipId,
  authoringRegionContext = 'global',
  playheadSec,
  totalDurationSec,
  playbackMode = 'stopped',
  loopEnabled = true,
  eventLabelDensity = 'detailed',
  defaultSnapSeconds = 1,
  defaultFitToContent = false,
  onSnapChange,
  onFitToContentChange,
  onEventLabelDensityChange,
  onTransportPlay,
  onTransportPause,
  onTransportStop,
  onTransportRewindStart,
  onTransportFastForwardStart,
  onTransportShuttleEnd,
  onTransportSkip,
  onLoopToggle,
  onScrubStart,
  onScrub,
  onScrubEnd,
}) {
  const [localClips, setLocalClips] = useState(initialClips || [])
  const [selectedId, setSelectedId] = useState(null)
  const [snapSeconds, setSnapSeconds] = useState(1)
  const [fitToContent, setFitToContent] = useState(false)
  const [viewportWidthPx, setViewportWidthPx] = useState(0)
  const basePxPerSec = 6

  // Always-current ref for commits after async drag
  const localClipsRef = useRef(localClips)
  localClipsRef.current = localClips

  // Drag state ref: { type, clipId, startX, origStartSec, origEndSec }
  const dragRef = useRef(null)
  const scrubRef = useRef(false)
  // Snapshot of clips at drag-start (for computing from originals + delta)
  const dragSnapshotRef = useRef(null)
  const scrollAreaRef = useRef(null)
  const labelColRef = useRef(null)
  const syncingScrollRef = useRef(false)

  const maxClipEndSec = localClips.reduce((max, clip) => Math.max(max, clip.endSec || 0), 0)
  const fitDurationSec = Math.max(10, Math.min(totalDurationSec, maxClipEndSec || totalDurationSec || 10))
  const sortedDurations = localClips
    .map((clip) => Math.max(0.5, Number(clip.endSec || 0) - Number(clip.startSec || 0)))
    .filter((duration) => Number.isFinite(duration) && duration > 0)
    .sort((a, b) => a - b)
  const representativeDurationSec = sortedDurations.length > 0
    ? sortedDurations[Math.floor(sortedDurations.length / 2)]
    : 8
  const readableLabelWidthPx = eventLabelDensity === 'compact'
    ? 96
    : eventLabelDensity === 'full'
      ? 188
      : 144
  const readablePxPerSec = readableLabelWidthPx / clamp(representativeDurationSec, 2, 14)
  const fitPxPerSec = viewportWidthPx > 0 ? viewportWidthPx / fitDurationSec : basePxPerSec
  const minimumFitPxPerSec = eventLabelDensity === 'compact' ? 3 : 4

  // Authoring mode (default): use readable scale and allow horizontal scrolling.
  // Compact mode: compress to fit the viewport.
  const pxPerSec = fitToContent
    ? Math.max(minimumFitPxPerSec, fitPxPerSec)
    : Math.max(basePxPerSec, readablePxPerSec)
  const visibleDurationSec = fitToContent ? fitDurationSec : totalDurationSec
  const totalWidthPx = Math.max(viewportWidthPx, Math.ceil(visibleDurationSec * pxPerSec))
  const stateTrackById = Object.fromEntries(STATE_TRACK_DEFS.map((track) => [track.id, track]))

  const densityShiftPx = eventLabelDensity === 'compact'
    ? 34
    : eventLabelDensity === 'full'
      ? -24
      : 0

  const buildStateClipLabel = useCallback((trackLabel, clip, widthPx) => {
    const adjustedWidth = widthPx - densityShiftPx
    const intensity = (clip.intensity ?? 0.5).toFixed(2)
    const durationSec = clip.endSec - clip.startSec
    const duration = `${Math.max(1, Math.round(durationSec))}s`
    const range = `${Math.round(clip.startSec)}-${Math.round(clip.endSec)}s`

    if (adjustedWidth <= 22) {
      return '●'
    }
    if (adjustedWidth <= 62) {
      return trackLabel
    }
    if (adjustedWidth <= 92) {
      return `${trackLabel} ${intensity}`
    }
    if (adjustedWidth <= 136) {
      return `${trackLabel} | ${intensity} | ${duration}`
    }
    return `${trackLabel} | ${intensity} intensity | ${duration} | ${range}`
  }, [densityShiftPx])

  const buildEventClipLabel = useCallback((clip, widthPx) => {
    const adjustedWidth = widthPx - densityShiftPx
    const intentLabel = (clip.intentKind || 'Intent').replace(/-/g, ' ')
    const durationSec = Math.max(0.5, clip.endSec - clip.startSec)
    const duration = `${Math.max(1, Math.round(durationSec))}s`
    const range = `${Math.round(clip.startSec)}-${Math.round(clip.endSec)}s`

    if (adjustedWidth <= 22) {
      return '●'
    }
    if (adjustedWidth <= 62) {
      return intentLabel
    }
    if (adjustedWidth <= 92) {
      return `${intentLabel} ${(clip.region || 'global').toUpperCase()}`
    }
    if (adjustedWidth <= 136) {
      return `${intentLabel} | ${duration}`
    }
    return `${intentLabel} | ${(clip.region || 'global')} | ${duration} | ${range}`
  }, [densityShiftPx])

  useEffect(() => {
    const element = scrollAreaRef.current
    if (!element) {
      return undefined
    }

    let frameId = 0

    const updateWidth = () => {
      const nextWidth = Math.max(0, Math.floor(element.clientWidth))
      setViewportWidthPx((prev) => {
        // Ignore 1px monitor/DPI oscillation to prevent scrollbar feedback jitter.
        if (Math.abs(prev - nextWidth) <= 1) {
          return prev
        }
        return nextWidth
      })
    }

    updateWidth()

    const resizeObserver = new window.ResizeObserver(() => {
      window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(updateWidth)
    })
    resizeObserver.observe(element)

    return () => {
      window.cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
    }
  }, [])

  useEffect(() => {
    setLocalClips(initialClips || [])
  }, [initialClips])

  useEffect(() => {
    if (selectedClipId === undefined) {
      return
    }
    setSelectedId(selectedClipId || null)
  }, [selectedClipId])

  useEffect(() => {
    setSnapSeconds(defaultSnapSeconds)
  }, [defaultSnapSeconds])

  useEffect(() => {
    setFitToContent(defaultFitToContent)
  }, [defaultFitToContent])

  useEffect(() => {
    const scrollArea = scrollAreaRef.current
    const labelCol = labelColRef.current
    if (!scrollArea || !labelCol) {
      return undefined
    }

    const syncFromScrollArea = () => {
      if (syncingScrollRef.current) {
        return
      }
      syncingScrollRef.current = true
      labelCol.scrollTop = scrollArea.scrollTop
      syncingScrollRef.current = false
    }

    const syncFromLabelCol = () => {
      if (syncingScrollRef.current) {
        return
      }
      syncingScrollRef.current = true
      scrollArea.scrollTop = labelCol.scrollTop
      syncingScrollRef.current = false
    }

    scrollArea.addEventListener('scroll', syncFromScrollArea)
    labelCol.addEventListener('scroll', syncFromLabelCol)
    return () => {
      scrollArea.removeEventListener('scroll', syncFromScrollArea)
      labelCol.removeEventListener('scroll', syncFromLabelCol)
    }
  }, [])

  useEffect(() => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea || playbackMode !== 'playing') {
      return
    }

    const viewportCenterPx = scrollArea.clientWidth / 2
    const maxScrollLeft = Math.max(0, totalWidthPx - scrollArea.clientWidth)
    const clampedPlayheadPx = clamp((playheadSec || 0) * pxPerSec, 0, totalWidthPx)
    const desiredScrollLeft = clampedPlayheadPx <= viewportCenterPx
      ? 0
      : clamp(clampedPlayheadPx - viewportCenterPx, 0, maxScrollLeft)

    if (Math.abs(scrollArea.scrollLeft - desiredScrollLeft) > 1) {
      scrollArea.scrollLeft = desiredScrollLeft
    }
  }, [playbackMode, playheadSec, pxPerSec, totalWidthPx])

  useEffect(() => {
    if (playbackMode !== 'rewind' && playbackMode !== 'fastForward') {
      return undefined
    }

    const handlePointerRelease = () => onTransportShuttleEnd?.()
    window.addEventListener('pointerup', handlePointerRelease)
    window.addEventListener('pointercancel', handlePointerRelease)
    return () => {
      window.removeEventListener('pointerup', handlePointerRelease)
      window.removeEventListener('pointercancel', handlePointerRelease)
    }
  }, [playbackMode, onTransportShuttleEnd])

  const snapToGrid = useCallback((sec) => {
    if (!snapSeconds || snapSeconds <= 0) {
      return sec
    }
    return Math.round(sec / snapSeconds) * snapSeconds
  }, [snapSeconds])

  const selectedClip = localClips.find((c) => c.id === selectedId) || null

  // Notify parent when clip selection changes (for composition canvas highlighting, etc.)
  useEffect(() => {
    if (selectedId && selectedClip && onClipSelect) {
      onClipSelect({
        clipId: selectedId,
        clip: selectedClip,
        trackKind: selectedClip.trackKind,
        region: selectedClip.region,
        intentKind: selectedClip.intentKind,
      })
    }
  }, [selectedId, selectedClip, onClipSelect])

  // ---- Clip mouse-down: start drag ----
  const handleClipMouseDown = useCallback((event, clip, dragType) => {
    event.preventDefault()
    event.stopPropagation()
    setSelectedId(clip.id)
    dragRef.current = {
      type: dragType,
      clipId: clip.id,
      startX: event.clientX,
      origStartSec: clip.startSec,
      origEndSec: clip.endSec,
    }
    dragSnapshotRef.current = localClipsRef.current
  }, [])

  const clientXToSeconds = useCallback((clientX) => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) {
      return 0
    }
    const rect = scrollArea.getBoundingClientRect()
    const localX = scrollArea.scrollLeft + (clientX - rect.left)
    return clamp(localX / pxPerSec, 0, totalDurationSec)
  }, [pxPerSec, totalDurationSec])

  const beginScrub = useCallback((event) => {
    event.preventDefault()
    event.stopPropagation()
    scrubRef.current = true
    const sec = clientXToSeconds(event.clientX)
    onScrubStart?.(sec)
    onScrub?.(sec)
  }, [clientXToSeconds, onScrubStart, onScrub])

  // ---- Window-level mouse events (drag tracking) ----
  useEffect(() => {
    const handleMouseMove = (event) => {
      if (scrubRef.current) {
        onScrub?.(clientXToSeconds(event.clientX))
        return
      }

      const drag = dragRef.current
      if (!drag || !dragSnapshotRef.current) return
      const dxSec = snapToGrid((event.clientX - drag.startX) / pxPerSec)
      setLocalClips(
        dragSnapshotRef.current.map((c) =>
          c.id === drag.clipId ? applyDragToClip(c, drag, dxSec, totalDurationSec) : c,
        ),
      )
    }

    const handleMouseUp = (event) => {
      if (scrubRef.current) {
        const sec = clientXToSeconds(event.clientX)
        onScrub?.(sec)
        onScrubEnd?.(sec)
        scrubRef.current = false
        return
      }

      const drag = dragRef.current
      if (!drag) return
      const dxSec = snapToGrid((event.clientX - drag.startX) / pxPerSec)
      const committed = dragSnapshotRef.current.map((c) =>
        c.id === drag.clipId ? applyDragToClip(c, drag, dxSec, totalDurationSec) : c,
      )
      dragRef.current = null
      dragSnapshotRef.current = null
      setLocalClips(committed)
      onClipsCommit(committed)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [pxPerSec, totalDurationSec, onClipsCommit, snapToGrid, onScrub, onScrubEnd, clientXToSeconds])

  // ---- Click on empty track area: add clip ----
  const handleTrackClick = useCallback(
    (event, trackId) => {
      if (dragRef.current) return
      const rect = event.currentTarget.getBoundingClientRect()
      const clickSec = snapToGrid((event.clientX - rect.left) / pxPerSec)
      const startSec = Math.max(0, clickSec - 5)
      const endSec = Math.min(totalDurationSec, startSec + 10)
      const seed = {
        id: genId(),
        startSec,
        endSec,
        region: authoringRegionContext || 'global',
      }

      const newClip = trackId === 'wind'
        ? createWindClip(seed, totalDurationSec)
        : trackId === 'rain'
          ? createRainClip(seed, totalDurationSec)
          : trackId === 'mist'
            ? createMistClip(seed, totalDurationSec)
            : createDefaultClip(trackId, seed, totalDurationSec)

      setLocalClips((prev) => {
        const next = [...prev, newClip]
        onClipsCommit(next)
        return next
      })
      setSelectedId(newClip.id)
    },
    [authoringRegionContext, pxPerSec, totalDurationSec, onClipsCommit, snapToGrid],
  )

  // ---- Keyboard delete ----
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!selectedId) return
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      setLocalClips((prev) => {
        const next = prev.filter((c) => c.id !== selectedId)
        onClipsCommit(next)
        return next
      })
      setSelectedId(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedId, onClipsCommit])

  // ---- Ruler tick marks ----
  const majorStep = visibleDurationSec <= 120 ? 10 : 30
  const minorStep = visibleDurationSec <= 120 ? 5 : 10
  const rulerTicks = []
  for (let t = 0; t <= visibleDurationSec; t += minorStep) {
    rulerTicks.push({ timeSec: t, isMajor: t % majorStep === 0 })
  }

  const playheadPx = clamp((playheadSec || 0) * pxPerSec, 0, totalWidthPx)

  return (
    <div className={`tl-editor density-${eventLabelDensity}`}>
      {/* Toolbar */}
      <div className="tl-toolbar">
        <span className="tl-title">Atmosphere Timeline</span>
        <div className="tl-transport" role="toolbar" aria-label="Timeline transport controls">
          <button
            type="button"
            className={`tl-transport-btn${playbackMode === 'rewind' ? ' active' : ''}`}
            title="Rewind: move backward through timeline at accelerated speed while held"
            aria-label="Rewind timeline while button is held"
            onPointerDown={(event) => {
              event.preventDefault()
              onTransportRewindStart?.()
            }}
            onPointerUp={() => onTransportShuttleEnd?.()}
            onPointerLeave={() => onTransportShuttleEnd?.()}
            onPointerCancel={() => onTransportShuttleEnd?.()}
          >
            <StudioIcon name="rewind" className="studio-icon-glyph" />
          </button>
          <button
            type="button"
            className={`tl-transport-btn${playbackMode === 'playing' ? ' active' : ''}`}
            title="Play: begin timeline playback from the current playhead position"
            aria-label="Play timeline from current playhead"
            onClick={() => onTransportPlay?.()}
          >
            <StudioIcon name="play" className="studio-icon-glyph" />
          </button>
          <button
            type="button"
            className={`tl-transport-btn${playbackMode === 'paused' ? ' active' : ''}`}
            title="Pause: freeze playback at the current frame and time"
            aria-label="Pause timeline playback"
            onClick={() => onTransportPause?.()}
          >
            <StudioIcon name="pause" className="studio-icon-glyph" />
          </button>
          <button
            type="button"
            className={`tl-transport-btn${playbackMode === 'stopped' ? ' active' : ''}`}
            title="Stop: halt playback and return the playhead to timeline start"
            aria-label="Stop timeline and return playhead to start"
            onClick={() => onTransportStop?.()}
          >
            <StudioIcon name="stop" className="studio-icon-glyph" />
          </button>
          <button
            type="button"
            className={`tl-transport-btn${playbackMode === 'fastForward' ? ' active' : ''}`}
            title="Fast Forward: move forward through timeline at accelerated speed while held"
            aria-label="Fast forward timeline while button is held"
            onPointerDown={(event) => {
              event.preventDefault()
              onTransportFastForwardStart?.()
            }}
            onPointerUp={() => onTransportShuttleEnd?.()}
            onPointerLeave={() => onTransportShuttleEnd?.()}
            onPointerCancel={() => onTransportShuttleEnd?.()}
          >
            <StudioIcon name="fast-forward" className="studio-icon-glyph" />
          </button>
          <button
            type="button"
            className="tl-transport-btn"
            title="Skip: jump to the next authored event boundary or clip start"
            aria-label="Skip to next event boundary"
            onClick={() => onTransportSkip?.()}
          >
            <StudioIcon name="skip" className="studio-icon-glyph" />
          </button>
        </div>
        <span className="tl-hint">
          Space play/pause · K stop · Shift+Right skip · drag ruler or playhead to scrub
        </span>
        <span className="tl-time-readout" title="Current time / total timeline duration">
          {formatTimecode(playheadSec)} / {formatTimecode(totalDurationSec)}
        </span>
        <label className="tl-snap-control">
          Snap
          <select
            value={snapSeconds}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (onSnapChange) {
                onSnapChange(next)
                return
              }
              setSnapSeconds(next)
            }}
          >
            <option value={1}>1s</option>
            <option value={5}>5s</option>
            <option value={10}>10s</option>
          </select>
        </label>
        <label className="tl-snap-control tl-fit-toggle">
          <input
            type="checkbox"
            checked={fitToContent}
            onChange={(event) => {
              const next = event.target.checked
              if (onFitToContentChange) {
                onFitToContentChange(next)
                return
              }
              setFitToContent(next)
            }}
          />
          Compact
        </label>
        <label className="tl-snap-control">
          Labels
          <select value={eventLabelDensity} onChange={(event) => onEventLabelDensityChange?.(event.target.value)}>
            <option value="compact">Compact</option>
            <option value="detailed">Detailed</option>
            <option value="full">Full</option>
          </select>
        </label>
        <button
          type="button"
          className={`tl-loop-toggle${loopEnabled ? ' active' : ''}`}
          title="Loop playback"
          aria-label={loopEnabled ? 'Disable loop playback' : 'Enable loop playback'}
          aria-pressed={loopEnabled}
          onClick={() => onLoopToggle?.(!loopEnabled)}
        >
          <StudioIcon name="loop" className="studio-icon-glyph" />
        </button>
      </div>

      {/* Main body: fixed label column + scrollable tracks */}
      <div className="tl-body timeline-panel">
        {/* Track label column (non-scrolling) */}
        <div ref={labelColRef} className="tl-label-col label-column">
          <div className="tl-ruler-corner" />
          {TRACK_GROUPS.map((group) => (
            <div key={group.id} className="tl-track-group">
              <div className="tl-track-group-label">{group.label}</div>
              {group.tracks.map((trackId) => {
                if (trackId === 'intent') {
                  return (
                    <div
                      key={EVENT_TRACK_DEF.id}
                      className="tl-track-label tl-track-label--event"
                      style={{ '--track-color': EVENT_TRACK_DEF.color, '--track-height': `${EVENT_TRACK_H}px` }}
                    >
                      {EVENT_TRACK_DEF.label}
                    </div>
                  )
                }
                const track = stateTrackById[trackId]
                if (!track) {
                  return null
                }
                return (
                  <div
                    key={track.id}
                    className="tl-track-label tl-track-label--state"
                    style={{ '--track-color': track.color, '--track-height': `${STATE_TRACK_H}px` }}
                  >
                    {track.label}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* Scrollable clip canvas */}
        <div ref={scrollAreaRef} className="tl-scroll-area scroll-container">
          <div className="tl-inner timeline-canvas" style={{ width: totalWidthPx }}>
            {/* Time ruler */}
            <div className="tl-ruler" onMouseDown={beginScrub} title="Drag to scrub playhead position">
              {rulerTicks.map(({ timeSec, isMajor }) => (
                <div
                  key={timeSec}
                  className={`tl-tick${isMajor ? ' major' : ' minor'}`}
                  style={{ left: timeSec * pxPerSec }}
                >
                  {isMajor && <span>{timeSec}s</span>}
                </div>
              ))}
            </div>

            {TRACK_GROUPS.map((group) => (
              <div key={group.id} className="tl-track-group tl-track-group--rows">
                <div className="tl-track-group-gap" />
                {group.tracks.map((trackId) => {
                  if (trackId === 'intent') {
                    const trackClips = localClips.filter((c) => c.trackKind === 'intent')
                    return (
                      <div
                        key="intent"
                        className="tl-track-row tl-track-row--event"
                        style={{ '--track-height': `${EVENT_TRACK_H}px` }}
                        onClick={(e) => handleTrackClick(e, 'intent')}
                      >
                        {trackClips.map((clip) => {
                          const leftPx = clip.startSec * pxPerSec
                          const widthPx = Math.max(fitToContent ? 26 : 76, (clip.endSec - clip.startSec) * pxPerSec)
                          const isSelected = clip.id === selectedId

                          return (
                            <div
                              key={clip.id}
                              className={`tl-clip tl-clip--event${isSelected ? ' selected' : ''}`}
                              style={{
                                left: leftPx,
                                width: widthPx,
                                '--clip-color': EVENT_TRACK_DEF.color,
                              }}
                              onMouseDown={(e) => handleClipMouseDown(e, clip, 'move')}
                              onClick={(e) => { e.stopPropagation(); setSelectedId(clip.id) }}
                              title={formatEventTooltip(clip)}
                            >
                              <div className="tl-event-marker" />
                              <span className="tl-event-label">{buildEventClipLabel(clip, widthPx)}</span>
                            </div>
                          )
                        })}
                      </div>
                    )
                  }

                  const track = stateTrackById[trackId]
                  if (!track) {
                    return null
                  }
                  const trackClips = localClips.filter((c) => c.trackKind === track.id)

                  return (
                    <div
                      key={track.id}
                      className="tl-track-row tl-track-row--state"
                      style={{ '--track-height': `${STATE_TRACK_H}px` }}
                      onClick={(e) => handleTrackClick(e, track.id)}
                    >
                      {trackClips.map((clip) => {
                        const leftPx = clip.startSec * pxPerSec
                        const widthPx = Math.max(fitToContent ? 8 : 76, (clip.endSec - clip.startSec) * pxPerSec)
                        const intensityOpacity = (clip.intensity ?? 0.5) * 0.7 + 0.3
                        const isSelected = clip.id === selectedId
                        const clipLabel = buildStateClipLabel(track.label, clip, widthPx)

                        return (
                          <div
                            key={clip.id}
                            className={`tl-clip tl-clip--state${isSelected ? ' selected' : ''}`}
                            style={{
                              left: leftPx,
                              width: widthPx,
                              '--clip-color': track.color,
                              opacity: intensityOpacity,
                            }}
                            onMouseDown={(e) => handleClipMouseDown(e, clip, 'move')}
                            onClick={(e) => { e.stopPropagation(); setSelectedId(clip.id) }}
                            title={formatStateTooltip(track.label, clip)}
                          >
                            <div
                              className="tl-resize-handle left"
                              onMouseDown={(e) => handleClipMouseDown(e, clip, 'resizeLeft')}
                            />
                            <div className="tl-clip-content">
                              {clipLabel === '●' ? <span className="tl-clip-dot">●</span> : <span className="tl-clip-line">{clipLabel}</span>}
                            </div>
                            <div
                              className="tl-resize-handle right"
                              onMouseDown={(e) => handleClipMouseDown(e, clip, 'resizeRight')}
                            />
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            ))}

            {/* Playhead spanning full track area height */}
            <div className="tl-playhead" style={{ left: playheadPx }} onMouseDown={beginScrub} />
          </div>
        </div>
      </div>

      {/* Inspector (shown when clip is selected) */}
    </div>
  )
}
