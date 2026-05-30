import type {
  Company,
  Incident,
  IncidentSeverity,
  AtlassianIncident,
  AtlassianSummaryResponse,
  AtlassianIncidentsResponse,
} from './types'

const IMPACT_TO_SEVERITY: Record<string, IncidentSeverity> = {
  none: 'operational',
  minor: 'degraded_performance',
  major: 'partial_outage',
  critical: 'major_outage',
}

function mapSeverity(impact: string): IncidentSeverity {
  return IMPACT_TO_SEVERITY[impact] ?? 'degraded_performance'
}

function calcDuration(openedAt: string, resolvedAt: string | null): number | null {
  if (!resolvedAt) return null
  const ms = new Date(resolvedAt).getTime() - new Date(openedAt).getTime()
  return Math.round(ms / 60_000)
}

function buildIncidents(
  raw: AtlassianIncident[],
  company: Company,
): Incident[] {
  const allComponentIds = new Set(
    company.products.flatMap((p) => p.component_ids),
  )

  const incidents: Incident[] = []

  for (const raw_inc of raw) {
    const matchedComponents = raw_inc.components.filter((c) =>
      allComponentIds.has(c.id),
    )

    if (matchedComponents.length === 0) continue

    // One Incident record per matched component so per-product stats work
    for (const component of matchedComponents) {
      const product = company.products.find((p) =>
        p.component_ids.includes(component.id),
      )
      if (!product) continue

      incidents.push({
        id: `${raw_inc.id}-${component.id}`,
        product_id: product.id,
        component_id: component.id,
        component_name: component.name,
        title: raw_inc.name,
        opened_at: raw_inc.created_at,
        resolved_at: raw_inc.resolved_at,
        duration_minutes: calcDuration(raw_inc.created_at, raw_inc.resolved_at),
        raw_severity: mapSeverity(raw_inc.impact),
        status_page_incident_url: raw_inc.shortlink,
      })
    }
  }

  return incidents
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.json() as Promise<T>
}

export async function scrapeAtlassian(company: Company): Promise<Incident[]> {
  const base = company.status_page_url.replace(/\/$/, '')

  const [summary, history] = await Promise.all([
    fetchJson<AtlassianSummaryResponse>(`${base}/api/v2/summary.json`),
    fetchJson<AtlassianIncidentsResponse>(
      `${base}/api/v2/incidents.json?limit=100`,
    ),
  ])

  // Merge: history is authoritative for older incidents, summary catches
  // any in-progress incidents not yet in the paginated history endpoint
  const seen = new Set<string>()
  const merged: AtlassianIncident[] = []

  for (const inc of [...(summary.incidents ?? []), ...(history.incidents ?? [])]) {
    if (!seen.has(inc.id)) {
      seen.add(inc.id)
      merged.push(inc)
    }
  }

  return buildIncidents(merged, company)
}
