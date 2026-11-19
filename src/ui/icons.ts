/** Small, local UI icons: no font or network dependency. */
const paths = {
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6Z"/>',
  user: '<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  medal: '<circle cx="12" cy="9" r="5"/><path d="m8 13-1 8 5-3 5 3-1-8"/>',
  book: '<path d="M12 5v16M3 4c4-1 6 0 9 1 3-1 5-2 9-1v15c-4-1-6 0-9 2-3-2-5-3-9-2Z"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  logout: '<path d="M9 4H4v16h5M9 12h12m-4-4 4 4-4 4"/>',
  swords: '<path d="m4 3 6 3 10 12-2 2L6 10Zm16 0-6 3-3 4M7 14l-3 4 2 2 4-3M3 14l7 7m4-18 7 7"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
} as const;

export function uiIcon(name: keyof typeof paths): string {
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
