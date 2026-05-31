import type { Company, Incident, IncidentSeverity } from './types'

// ── BetterStack public status page JSON:API types ────────────────────────────
// Endpoint: GET {status_page_url}/index.json

interface BsAttributes {
  [key: string]: unknown
}

interface BsResource {
  type: string
  id: string
  attributes: BsAttributes
}

interface BsIndexResponse {
  data: {
    type: 'status_page'
    id: string
    attributes: BsAttributes
    relationships?: {
      sections?: { data: Array<{ type: string; id: string }> }
      resources?: { data: Array<{ type: string; id: string }> }
      status_reports?: { data: Array<{ type: string; id: string }> }
    }
  }
  included: BsResource[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapAggregate(state: string): IncidentSeverity | null {
  const map: Record<string, IncidentSeverity> = {
    degraded: 'degraded_performance',
    down: 'major_outage',
    maintenance: 'degraded_performance',
  }
  return map[state] ?? null  // null = skip (operational / unknown)
}

function calcDuration(startsAt: string, endsAt: string | null): number | null {
  if (!endsAt) return null
  const ms = new Date(endsAt).getTime() - new Date(startsAt).getTime()
  return Math.round(ms / 60_000)
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.json() as Promise<T>
}

// ── Public scrape entry point ─────────────────────────────────────────────────

export async function scrapeBetterstack(company: Company, _backfill = false): Promise<Incident[]> {
  const base = company.status_page_url.replace(/\/$/, '')
  const page = await fetchJson<BsIndexResponse>(`${base}/index.json`)

  // Build lookup maps from included[] resources
  const sections = new Map<string, string>()    // id → name
  const resourceSection = new Map<string, string>()  // resource_id → section_id

  for (const item of page.included) {
    if (item.type === 'section') {
      sections.set(item.id, String(item.attributes.name ?? ''))
    }
    if (item.type === 'resource') {
      const sectionId = String(item.attributes.section_id ?? '')
      if (sectionId) resourceSection.set(item.id, sectionId)
    }
  }

  // Build product lookups
  const productByGroupName = new Map(
    company.products.filter((p) => p.group_name).map((p) => [p.group_name!, p]),
  )
  const productByComponentId = new Map(
    company.products.flatMap((p) => p.component_ids.map((id) => [id, p])),
  )
  const fallbackProduct = company.products[0]

  const incidents: Incident[] = []

  for (const item of page.included) {
    if (item.type !== 'status_report') continue
    const attrs = item.attributes
    if (attrs.report_type !== 'incident') continue

    const severity = mapAggregate(String(attrs.aggregate_state ?? ''))
    if (!severity) continue  // skip operational/unknown entries

    const startsAt = String(attrs.starts_at ?? '')
    const endsAt = (attrs.ends_at as string | null) ?? null
    if (!startsAt) continue

    const affectedIds = (attrs.affected_resources as string[] | undefined) ?? []
    const incidentUrl = `${base}/status-reports/${item.id}`

    if (affectedIds.length === 0) {
      incidents.push({
        id: `${item.id}-uncategorised`,
        product_id: fallbackProduct.id,
        component_id: 'uncategorised',
        component_name: 'Uncategorised',
        title: String(attrs.title ?? 'Incident'),
        opened_at: startsAt,
        resolved_at: endsAt,
        duration_minutes: calcDuration(startsAt, endsAt),
        raw_severity: severity,
        status_page_incident_url: incidentUrl,
      })
      continue
    }

    // Map each affected resource → product via section name or component_id
    const byProduct = new Map<string, typeof fallbackProduct>()
    for (const resourceId of affectedIds) {
      let product: typeof fallbackProduct | undefined

      // Try component_id direct match first
      product = productByComponentId.get(resourceId)

      // Then try section → group_name match
      if (!product) {
        const sectionId = resourceSection.get(resourceId)
        const sectionName = sectionId ? sections.get(sectionId) : undefined
        if (sectionName) product = productByGroupName.get(sectionName)
      }

      const target = product ?? fallbackProduct
      byProduct.set(target.id, target)
    }

    for (const product of byProduct.values()) {
      incidents.push({
        id: `${item.id}-${product.id}`,
        product_id: product.id,
        component_id: product.id,
        component_name: product.name,
        title: String(attrs.title ?? 'Incident'),
        opened_at: startsAt,
        resolved_at: endsAt,
        duration_minutes: calcDuration(startsAt, endsAt),
        raw_severity: severity,
        status_page_incident_url: incidentUrl,
      })
    }
  }

  return incidents
}
