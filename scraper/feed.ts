import type { Company, Incident, IncidentSeverity } from './types'
import { fetchText, calcDuration } from './http'
import { routeByTitle, isTitleRouted } from './routing'

// Scraper for status pages that only expose incident history as an Atom feed
// (e.g. DeepSeek, Perplexity). Atlassian/Instatus-style feeds are emitted at
// {status_page_url}/history.atom — one <entry> per incident, newest first.

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&') // must run last
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? m[1].trim() : null
}

function linkHref(block: string): string | null {
  // Prefer an alternate text/html link; fall back to the first <link href>.
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
  if (alt) return alt[1]
  const any = block.match(/<link[^>]*href=["']([^"']+)["']/i)
  return any ? any[1] : null
}

// Status pages render the incident's update log inside <content>, newest first.
// A resolved incident's log contains a "Resolved" / "Completed" update.
function isResolved(content: string): boolean {
  return /<strong>\s*(resolved|completed)\s*<\/strong>/i.test(content)
}

function inferSeverity(text: string): IncidentSeverity {
  const t = text.toLowerCase()
  if (/major outage|major service outage/.test(t)) return 'major_outage'
  if (/partial outage/.test(t)) return 'partial_outage'
  if (/degraded|performance|elevated|latency|error/.test(t)) return 'degraded_performance'
  return 'degraded_performance'
}

// Scheduled maintenance entries aren't outages — skip them.
function isMaintenance(title: string, content: string): boolean {
  return /scheduled maintenance|maintenance/i.test(title) || /<strong>\s*scheduled\s*<\/strong>/i.test(content)
}

export function parseAtom(xml: string, company: Company): Incident[] {
  const incidents: Incident[] = []
  const titleRouted = isTitleRouted(company)
  const entries = xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? []

  for (const entry of entries) {
    const rawTitle = tag(entry, 'title') ?? ''
    const title = decodeEntities(rawTitle).trim()
    if (!title) continue

    const published = tag(entry, 'published') ?? tag(entry, 'updated')
    const updated = tag(entry, 'updated') ?? published
    if (!published) continue

    const rawContent = tag(entry, 'content') ?? ''
    const content = decodeEntities(rawContent)
    if (isMaintenance(title, content)) continue

    const resolved = isResolved(content)
    const opened_at = new Date(published).toISOString()
    const resolved_at = resolved && updated ? new Date(updated).toISOString() : null

    // Stable id from the entry <id> (e.g. tag:host,2005:Incident/12345).
    const idTag = tag(entry, 'id') ?? `${company.id}-${published}`
    const incidentId = idTag.split('/').pop() || idTag

    const product = titleRouted ? routeByTitle(company, title) : company.products[0]
    if (!product) continue

    incidents.push({
      id: `${incidentId}-${product.id}`,
      product_id: product.id,
      component_id: product.id,
      component_name: product.name,
      title,
      opened_at,
      resolved_at,
      duration_minutes: calcDuration(opened_at, resolved_at),
      raw_severity: inferSeverity(title + ' ' + content),
      status_page_incident_url: linkHref(entry) ?? `${company.status_page_url.replace(/\/$/, '')}/`,
    })
  }

  return incidents
}

export async function scrapeFeed(company: Company, _backfill = false): Promise<Incident[]> {
  const base = company.status_page_url.replace(/\/$/, '')
  const xml = await fetchText(`${base}/history.atom`)
  const incidents = parseAtom(xml, company)
  if (incidents.length === 0) {
    throw new Error('history.atom returned no parseable incidents')
  }
  return incidents
}
