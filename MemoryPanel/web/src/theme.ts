export type StudioTheme = 'light' | 'dark' | 'system';

const KEY = 'tencentdb-agent-memory-theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

export function readTheme(): StudioTheme {
  const value = localStorage.getItem(KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function applyTheme(preference: StudioTheme): void {
  const resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export function writeTheme(preference: StudioTheme): void {
  if (preference === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, preference);
  applyTheme(preference);
}

export function subscribeTheme(preference: StudioTheme): () => void {
  const handler = () => preference === 'system' && applyTheme(preference);
  media.addEventListener('change', handler);
  applyTheme(preference);
  return () => media.removeEventListener('change', handler);
}
