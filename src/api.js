// The page and the API can live on different origins: Cloudflare Pages serves
// the static app, while the API runs on the self-hosted origin. Build with
// `VITE_API_BASE=https://api.watcher.trustsight.org`; an empty base keeps the
// same-origin behaviour used in development and on Cloudflare.
export const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

export function apiUrl(path) {
  return `${API_BASE}${path}`
}
