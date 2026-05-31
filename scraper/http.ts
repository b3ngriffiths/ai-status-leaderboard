// Shared HTTP + time helpers for all scraper adapters.

// Several status pages (e.g. status.x.ai) reject requests that don't look like
// a browser, returning 403. Send a realistic User-Agent so public pages serve us.
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.json() as Promise<T>
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// Minutes between two timestamps. Returns null for unresolved incidents and for
// malformed upstream data where resolved_at precedes opened_at (negative span).
export function calcDuration(
  openedAt: string,
  resolvedAt: string | null | undefined,
): number | null {
  if (!resolvedAt) return null
  const ms = new Date(resolvedAt).getTime() - new Date(openedAt).getTime()
  const minutes = Math.round(ms / 60_000)
  return minutes < 0 ? null : minutes
}
