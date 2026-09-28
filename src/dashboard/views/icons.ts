import { trusted, type SafeHtml } from './html.js';

/** Stroke icons (24×24, currentColor). Static markup only — never user input. */
const PATHS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8Z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  alert: '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, cls = 'icon'): SafeHtml {
  return trusted(
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`,
  );
}

/**
 * The WP Fleet mark: four chevrons flying in formation — the lead ship in pink, the
 * fleet in cyan. `uid` keeps gradient ids unique when the mark appears twice on a page.
 */
export function logoMark(uid: string, cls = 'logo-mark'): SafeHtml {
  return trusted(`<svg class="${cls}" viewBox="0 0 40 40" aria-hidden="true">
  <defs><linearGradient id="edge-${uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00FFED"/><stop offset="1" stop-color="#FF005E"/></linearGradient></defs>
  <rect class="hull" x="1.5" y="1.5" width="37" height="37" rx="11" fill="#1D1D1B" stroke="url(#edge-${uid})" stroke-width="1.5"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="3.2">
    <path class="ship s1" d="M14 15.5 20 10l6 5.5" stroke="#FF005E"/>
    <path class="ship s2" d="M7 24.5 13 19l6 5.5" stroke="#00FFED"/>
    <path class="ship s3" d="M21 24.5 27 19l6 5.5" stroke="#00FFED"/>
    <path class="ship s4" d="M14 33.5 20 28l6 5.5" stroke="#00FFED" stroke-opacity=".45"/>
  </g>
</svg>`);
}

/** Mark + wordmark. */
export function logo(uid: string): SafeHtml {
  return trusted(
    `${logoMark(uid).value}<span class="wordmark"><span class="wm-wp">WP</span><span class="wm-fleet">FLEET</span></span>`,
  );
}

/** Standalone SVG for the favicon (no animation classes needed). */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect x="1.5" y="1.5" width="37" height="37" rx="11" fill="#1D1D1B" stroke="#00FFED" stroke-width="1.5"/><g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="3.2"><path d="M14 15.5 20 10l6 5.5" stroke="#FF005E"/><path d="M7 24.5 13 19l6 5.5" stroke="#00FFED"/><path d="M21 24.5 27 19l6 5.5" stroke="#00FFED"/><path d="M14 33.5 20 28l6 5.5" stroke="#00FFED" stroke-opacity=".45"/></g></svg>`;
