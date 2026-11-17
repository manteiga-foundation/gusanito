const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  left: svg('<path d="M15 5l-7 7 7 7"/>'),
  right: svg('<path d="M9 5l7 7-7 7"/>'),
  jump: svg('<path d="M12 19V7"/><path d="M7 11l5-5 5 5"/><path d="M5 21h14"/>'),
  rocket: svg('<path d="M5 19l3-3"/><path d="M14.5 4.5c2.5-1 4.5-1 5-.5s.5 2.5-.5 5L13 16l-5-5 6.5-6.5z"/><path d="M8 11l-3 .5L4 14l3 1"/><path d="M13 16l-.5 3L10 20l-1-3"/><circle cx="15.5" cy="8.5" r="1.3"/>'),
  grenade: svg('<circle cx="11" cy="14" r="6"/><path d="M13 8V6h-3v2"/><path d="M13 6c2-2 4-2 6 0"/>'),
  cluster: svg('<circle cx="12" cy="13" r="4.5"/><circle cx="5" cy="7" r="1.6"/><circle cx="19" cy="7" r="1.6"/><circle cx="4.5" cy="18" r="1.6"/><circle cx="19.5" cy="18" r="1.6"/>'),
  shotgun: svg('<path d="M3 10h13l2 2h3v2h-6l-2 3H8l1-3H3z"/><path d="M6 10V8"/>'),
  soundOn: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/>'),
  soundOff: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>'),
  crown: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>`,
  fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
};
