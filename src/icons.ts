/**
 * SVG Icons for Vectrola Player
 * Apple Music style icons - NO emoji
 */

export const ICONS = {
  // Playback controls
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,

  pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`,

  previous: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>`,

  next: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>`,

  // Shuffle - crossed arrows
  shuffle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="16 3 21 3 21 8"/>
    <line x1="4" y1="20" x2="21" y2="3"/>
    <polyline points="21 16 21 21 16 21"/>
    <line x1="15" y1="15" x2="21" y2="21"/>
    <line x1="4" y1="4" x2="9" y2="9"/>
  </svg>`,

  // Repeat - circular arrows
  repeat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="17 1 21 5 17 9"/>
    <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
    <polyline points="7 23 3 19 7 15"/>
    <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
  </svg>`,

  // Repeat one - with "1" indicator
  repeatOne: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="17 1 21 5 17 9"/>
    <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
    <polyline points="7 23 3 19 7 15"/>
    <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
    <text x="12" y="14" font-size="8" fill="currentColor" stroke="none" text-anchor="middle" dominant-baseline="middle" font-weight="bold">1</text>
  </svg>`,

  // Volume - Apple Music style: speaker pointing left + 2 curved arcs
  volume: `<svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M3 9v6h4l5 5V4L7 9H3z"/>
    <path d="M14 9.5c1 .7 1.5 1.7 1.5 2.5s-.5 1.8-1.5 2.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    <path d="M17 7c1.5 1.2 2.5 3 2.5 5s-1 3.8-2.5 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  </svg>`,

  // Volume mute - speaker with X
  volumeMute: `<svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M3 9v6h4l5 5V4L7 9H3z"/>
    <line x1="16" y1="9" x2="22" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <line x1="22" y1="9" x2="16" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`,

  // Music note - fallback for missing artwork
  music: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 18V5l12-2v13"/>
    <circle cx="6" cy="18" r="3"/>
    <circle cx="18" cy="16" r="3"/>
  </svg>`,

  // More options - horizontal dots
  more: `<svg viewBox="0 0 24 24" fill="currentColor">
    <circle cx="5" cy="12" r="2"/>
    <circle cx="12" cy="12" r="2"/>
    <circle cx="19" cy="12" r="2"/>
  </svg>`,
};

/**
 * Create an icon element from the ICONS object
 */
export function createIcon(name: keyof typeof ICONS): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `vectrola-icon vectrola-icon-${name}`;
  span.innerHTML = ICONS[name];
  return span;
}

/**
 * Get raw SVG string for an icon
 */
export function getIconSvg(name: keyof typeof ICONS): string {
  return ICONS[name];
}
