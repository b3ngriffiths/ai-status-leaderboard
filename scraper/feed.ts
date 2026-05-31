import type { Company, Incident, IncidentSeverity } from './types'
import { fetchText, calcDuration } from './http'
import { routeByTitle, isTitleRouted } from './routing'

// Scraper for status pages that only expose incident history as an Atom feed
// (e.g. DeepSeek, Perplexity). Atlassian/Instatus-style feeds are emitted at
// {status_page_url}/history.atom — one <entry> per incident, newest first.

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') // strip CDATA wrapper first
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&') // must run last
}

// Some feeds (e.g. Cohere/incident.io) emit double-slash paths: https://host//path
function normalizeUrl(url: string): string {
  return url.replace(/^(https?:\/\/[^/]+)\/\/+/, '$1/')
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
// DeepSeek also prefixes titles with [已恢复] / [已解决] / [Resolved].
function isResolved(title: string, content: string): boolean {
  // Bold/strong status label (Atlassian, DeepSeek, incident.io)
  if (/<(?:strong|b)>\s*(resolved|completed)\s*<\/(?:strong|b)>/i.test(content)) return true
  // incident.io: plain-text resolution phrases
  if (/this incident (?:has been|is now) resolved/i.test(content)) return true
  if (/we have (?:fully )?resolved/i.test(content)) return true
  // Status field: `"status":"resolved"` in JSON-in-HTML or feed metadata
  if (/"status"\s*:\s*"resolved"/i.test(content)) return true
  // Chinese: 已恢复 = recovered, 已解决 = solved; also plain [Resolved]
  if (/[【\[](已恢复|已解决|resolved)[】\]]/i.test(title)) return true
  return false
}

// Strip resolution status prefixes so we can match start and resolved entries by title.
// DeepSeek uses [已恢复]/[已解决]; most English feeds use [Resolved]/[Completed].
function stripStatusPrefix(title: string): string {
  return title
    .replace(/^\s*[【\[](已恢复|已解决|resolved|completed)[】\]]\s*/gi, '')
    .trim()
    .toLowerCase()
}

// Some feeds (e.g. DeepSeek, Perplexity) emit a separate entry for each status
// update: one when the incident opens (unresolved) and another when it closes
// (title prefixed with [Resolved]).  The resolved entry's <published> is the
// resolution time, not the start time — so pairing them gives us the real duration.
function pairEntries(incidents: Incident[]): Incident[] {
  const unresolved = incidents.filter(i => !i.resolved_at)
  const resolved = incidents.filter(i => i.resolved_at)

  if (unresolved.length === 0) return incidents

  const matchedUnresolved = new Set<string>()
  const result: Incident[] = []

  for (const resolvedInc of resolved) {
    const base = stripStatusPrefix(resolvedInc.title)
    // Find the earliest unresolved entry whose title matches and that started
    // before this resolution timestamp.
    const match = unresolved
      .filter(u =>
        !matchedUnresolved.has(u.id) &&
        stripStatusPrefix(u.title) === base &&
        new Date(u.opened_at) <= new Date(resolvedInc.resolved_at!),
      )
      .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime())[0]

    if (match) {
      matchedUnresolved.add(match.id)
      result.push({
        ...resolvedInc,
        opened_at: match.opened_at,
        duration_minutes: calcDuration(match.opened_at, resolvedInc.resolved_at),
      })
    } else {
      result.push(resolvedInc)
    }
  }

  // Keep unmatched unresolved entries (genuinely ongoing incidents)
  for (const inc of unresolved) {
    if (!matchedUnresolved.has(inc.id)) result.push(inc)
  }

  return result
}

function inferSeverity(text: string): IncidentSeverity {
  const t = text.toLowerCase()
  if (/major outage|major service outage/.test(t)) return 'major_outage'
  if (/partial outage|unavailable|not available|service not available|\boutage\b/.test(t)) return 'partial_outage'
  if (/degraded|performance|elevated|latency|error|abnormal/.test(t)) return 'degraded_performance'
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

    const resolved = isResolved(title, content)
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
      status_page_incident_url: normalizeUrl(linkHref(entry) ?? `${company.status_page_url.replace(/\/$/, '')}/`),
    })
  }

  return pairEntries(incidents)
}

export async function scrapeFeed(company: Company, _backfill = false): Promise<Incident[]> {
  const base = company.status_page_url.replace(/\/$/, '')
  const xml = await fetchText(`${base}/history.atom`)
  const incidents = parseAtom(xml, company)
  // Only error when entries exist but failed to parse — a service with no
  // incidents yet produces a valid empty feed and should not fail the scrape.
  const entryCount = (xml.match(/<entry[\s>]/gi) ?? []).length
  if (incidents.length === 0 && entryCount > 0) {
    throw new Error(`history.atom has ${entryCount} entries but none parsed — check feed format`)
  }
  return incidents
}
