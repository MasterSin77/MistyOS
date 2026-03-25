import React from 'react'

export function StudioIcon({ name, className = '', size = 14 }) {
  const commonProps = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }

  let glyph = null

  switch (name) {
    case 'chevron-down':
      glyph = <polyline points="6 9 12 15 18 9" {...commonProps} />
      break
    case 'chevron-right':
      glyph = <polyline points="9 6 15 12 9 18" {...commonProps} />
      break
    case 'maximize':
      glyph = <rect x="5" y="5" width="14" height="14" rx="1.5" {...commonProps} />
      break
    case 'layout-restore':
      glyph = (
        <>
          <rect x="4" y="4" width="16" height="16" rx="1.5" {...commonProps} />
          <line x1="12" y1="4" x2="12" y2="20" {...commonProps} />
          <line x1="4" y1="12" x2="20" y2="12" {...commonProps} />
        </>
      )
      break
    case 'preview':
      glyph = (
        <>
          <rect x="3.5" y="5" width="17" height="12.5" rx="1.8" {...commonProps} />
          <polygon points="10,9 15,11.75 10,14.5" {...commonProps} />
        </>
      )
      break
    case 'composition':
      glyph = (
        <>
          <rect x="4" y="4" width="16" height="16" rx="1.5" {...commonProps} />
          <line x1="12" y1="4" x2="12" y2="20" {...commonProps} />
          <line x1="4" y1="12" x2="20" y2="12" {...commonProps} />
        </>
      )
      break
    case 'spatial':
      glyph = (
        <>
          <circle cx="12" cy="12" r="7" {...commonProps} />
          <line x1="12" y1="5" x2="12" y2="19" {...commonProps} />
          <path d="M5 12h14" {...commonProps} />
        </>
      )
      break
    case 'diagnostics':
      glyph = <polyline points="4 14 8 10 11 13 16 8 20 12" {...commonProps} />
      break
    case 'weather':
      glyph = (
        <>
          <path d="M8 15h8a3.5 3.5 0 0 0 .2-7A4.8 4.8 0 0 0 7 9" {...commonProps} />
          <line x1="9" y1="16.5" x2="8" y2="19" {...commonProps} />
          <line x1="13" y1="16.5" x2="12" y2="19" {...commonProps} />
          <line x1="17" y1="16.5" x2="16" y2="19" {...commonProps} />
        </>
      )
      break
    case 'contain':
      glyph = (
        <>
          <rect x="5" y="5" width="14" height="14" rx="1.5" {...commonProps} />
          <rect x="8" y="8" width="8" height="8" rx="1" {...commonProps} />
        </>
      )
      break
    case 'fill':
      glyph = (
        <>
          <rect x="5" y="5" width="14" height="14" rx="1.5" {...commonProps} />
          <rect x="6.8" y="6.8" width="10.4" height="10.4" rx="1" fill="currentColor" stroke="none" />
        </>
      )
      break
    case 'native':
      glyph = (
        <>
          <line x1="12" y1="4" x2="12" y2="20" {...commonProps} />
          <line x1="4" y1="12" x2="20" y2="12" {...commonProps} />
          <circle cx="12" cy="12" r="2" {...commonProps} />
        </>
      )
      break
    case 'zoom':
      glyph = (
        <>
          <circle cx="10.5" cy="10.5" r="5.5" {...commonProps} />
          <line x1="14.8" y1="14.8" x2="19" y2="19" {...commonProps} />
        </>
      )
      break
    case 'play':
      glyph = <polygon points="9,7 17,12 9,17" {...commonProps} />
      break
    case 'stop':
      glyph = <rect x="8" y="8" width="8" height="8" {...commonProps} />
      break
    case 'pause':
      glyph = (
        <>
          <line x1="10" y1="7" x2="10" y2="17" {...commonProps} />
          <line x1="14" y1="7" x2="14" y2="17" {...commonProps} />
        </>
      )
      break
    case 'rewind':
      glyph = (
        <>
          <polygon points="11,8 6,12 11,16" {...commonProps} />
          <polygon points="18,8 13,12 18,16" {...commonProps} />
        </>
      )
      break
    case 'fast-forward':
      glyph = (
        <>
          <polygon points="6,8 11,12 6,16" {...commonProps} />
          <polygon points="13,8 18,12 13,16" {...commonProps} />
        </>
      )
      break
    case 'skip':
      glyph = (
        <>
          <polygon points="7,8 13,12 7,16" {...commonProps} />
          <line x1="16" y1="8" x2="16" y2="16" {...commonProps} />
        </>
      )
      break
    case 'loop':
      glyph = (
        <>
          <path d="M7 8h9l-2-2" {...commonProps} />
          <path d="M17 16H8l2 2" {...commonProps} />
        </>
      )
      break
    case 'tuning':
      glyph = (
        <>
          <line x1="6" y1="7" x2="6" y2="17" {...commonProps} />
          <line x1="12" y1="5" x2="12" y2="19" {...commonProps} />
          <line x1="18" y1="8" x2="18" y2="16" {...commonProps} />
          <circle cx="6" cy="10" r="1.5" {...commonProps} />
          <circle cx="12" cy="14" r="1.5" {...commonProps} />
          <circle cx="18" cy="11" r="1.5" {...commonProps} />
        </>
      )
      break
    case 'plus':
      glyph = (
        <>
          <line x1="12" y1="6" x2="12" y2="18" {...commonProps} />
          <line x1="6" y1="12" x2="18" y2="12" {...commonProps} />
        </>
      )
      break
    case 'minus':
      glyph = <line x1="6" y1="12" x2="18" y2="12" {...commonProps} />
      break
    case 'reset':
      glyph = (
        <>
          <path d="M8 9H4v-4" {...commonProps} />
          <path d="M5 9a7 7 0 1 1 .8 8.3" {...commonProps} />
        </>
      )
      break
    case 'file-menu':
      glyph = (
        <>
          <path d="M7 4h7l3 3v13H7z" {...commonProps} />
          <line x1="14" y1="4" x2="14" y2="7" {...commonProps} />
          <line x1="9" y1="11" x2="15" y2="11" {...commonProps} />
        </>
      )
      break
    case 'edit-menu':
      glyph = (
        <>
          <path d="M6 16l1.5-4.5L15.8 3.2a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L10.5 14.5z" {...commonProps} />
          <line x1="6" y1="16" x2="10.5" y2="14.5" {...commonProps} />
        </>
      )
      break
    case 'view-menu':
      glyph = (
        <>
          <path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5z" {...commonProps} />
          <circle cx="12" cy="12" r="2.2" {...commonProps} />
        </>
      )
      break
    case 'layout-menu':
      glyph = (
        <>
          <rect x="4" y="5" width="16" height="14" rx="1.4" {...commonProps} />
          <line x1="10" y1="5" x2="10" y2="19" {...commonProps} />
          <line x1="4" y1="12" x2="20" y2="12" {...commonProps} />
        </>
      )
      break
    case 'tools-menu':
      glyph = (
        <>
          <path d="M14 5.5a3 3 0 0 0 4 4L13 14.5l-3-3z" {...commonProps} />
          <path d="M4 18l5-5" {...commonProps} />
          <circle cx="4" cy="18" r="1.6" {...commonProps} />
        </>
      )
      break
    case 'help-menu':
      glyph = (
        <>
          <circle cx="12" cy="12" r="8" {...commonProps} />
          <path d="M9.8 9.5a2.2 2.2 0 1 1 3.6 1.7c-.8.6-1.4 1-1.4 2" {...commonProps} />
          <circle cx="12" cy="16.8" r="0.9" {...commonProps} />
        </>
      )
      break
    case 'type':
      glyph = (
        <>
          <line x1="6" y1="7" x2="18" y2="7" {...commonProps} />
          <line x1="12" y1="7" x2="12" y2="17" {...commonProps} />
          <line x1="9" y1="17" x2="15" y2="17" {...commonProps} />
        </>
      )
      break
    default:
      glyph = <circle cx="12" cy="12" r="3" {...commonProps} />
  }

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {glyph}
    </svg>
  )
}
