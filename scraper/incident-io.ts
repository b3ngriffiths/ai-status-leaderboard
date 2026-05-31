import type { Company, Incident, IncidentSeverity } from './types'

// ── incident.io status page public API types ────────────────────────────────

interface IioComponent {
  id: string
  name: string
  status?: string
  parent_component?: {
    id: string
    name: string
  }
}

interface IioIncident {
  id: string
  name: string
  status: string
  created_at: string
  resolved_at?: string | null
  affected_components: IioComponent[]
}

interface IioWidgetResponse {
  ongoing_incidents: IioIncident[]
}

interface IioPaginatedResponse {
  incidents: IioIncident[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Map incident status or component status → our severity enum.
// incident.io doesn't expose a severity field on public APIs; infer from
// component status when available, otherwise from incident lifecycle status.
function mapSeverity(incidentStatus: string, componentStatus?: string): IncidentSeverity {
  if (componentStatus) {
    const map: Record<string, IncidentSeverity> = {
      partial_outage: 'partial_outage',
      degraded_performance: 'degraded_performance',
      degraded: 'degraded_performance',
      full_outage: 'major_outage',
      major_outage: 'major_outage',
    }
    if (map[componentStatus]) return map[componentStatus]
  }
  if (incidentStatus === 'monitoring') return 'degraded_performance'
  return 'partial_outage'
}

function calcDuration(openedAt: string, resolvedAt: string | null | undefined): number | null {
  if (!resolvedAt) return null
  const ms = new Date(resolvedAt).getTime() - new Date(openedAt).getTime()
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

// ── Incident building ─────────────────────────────────────────────────────────

function buildIncidents(raw: IioIncident[], company: Company): Incident[] {
  const incidents: Incident[] = []
  const fallbackProduct = company.products[0]
  const base = company.status_page_url.replace(/\/$/, '')

  for (const inc of raw) {
    const resolvedAt = inc.resolved_at ?? null
    const incidentUrl = `${base}/incidents/${inc.id}`

    if (inc.affected_components.length === 0) {
      incidents.push({
        id: `${inc.id}-uncategorised`,
        product_id: fallbackProduct.id,
        component_id: 'uncategorised',
        component_name: 'Uncategorised',
        title: inc.name,
        opened_at: inc.created_at,
        resolved_at: resolvedAt,
        duration_minutes: calcDuration(inc.created_at, resolvedAt),
        raw_severity: mapSeverity(inc.status),
        status_page_incident_url: incidentUrl,
      })
      continue
    }

    // Group affected components by product (matched via parent group name)
    const byProduct = new Map<string, { product: typeof fallbackProduct; components: IioComponent[] }>()
    for (const component of inc.affected_components) {
      const groupName = component.parent_component?.name
      const product = groupName
        ? (company.products.find((p) => p.group_name === groupName) ?? fallbackProduct)
        : fallbackProduct
      const entry = byProduct.get(product.id)
      if (entry) entry.components.push(component)
      else byProduct.set(product.id, { product, components: [component] })
    }

    for (const { product, components } of byProduct.values()) {
      if (product.rollup) {
        incidents.push({
          id: `${inc.id}-${product.id}`,
          product_id: product.id,
          component_id: product.id,
          component_name: product.name,
          title: inc.name,
          opened_at: inc.created_at,
          resolved_at: resolvedAt,
          duration_minutes: calcDuration(inc.created_at, resolvedAt),
          raw_severity: mapSeverity(inc.status, components[0]?.status),
          status_page_incident_url: incidentUrl,
        })
      } else {
        for (const component of components) {
          incidents.push({
            id: `${inc.id}-${component.id}`,
            product_id: product.id,
            component_id: component.id,
            component_name: component.name,
            title: inc.name,
            opened_at: inc.created_at,
            resolved_at: resolvedAt,
            duration_minutes: calcDuration(inc.created_at, resolvedAt),
            raw_severity: mapSeverity(inc.status, component.status),
            status_page_incident_url: incidentUrl,
          })
        }
      }
    }
  }

  return incidents
}

// ── Public scrape entry point ─────────────────────────────────────────────────

export async function scrapeIncidentIo(company: Company, backfill = false): Promise<Incident[]> {
  const base = company.status_page_url.replace(/\/$/, '')
  const all: IioIncident[] = []
  const seen = new Set<string>()

  function add(incidents: IioIncident[]) {
    for (const inc of incidents) {
      if (!seen.has(inc.id)) {
        seen.add(inc.id)
        all.push(inc)
      }
    }
  }

  // Widget endpoint — returns ongoing incidents; always try this
  try {
    const widget = await fetchJson<IioWidgetResponse>(`${base}/api/widget`)
    add(widget.ongoing_incidents ?? [])
  } catch (e) {
    console.warn(`  ⚠ Widget fetch failed: ${e instanceof Error ? e.message : e}`)
  }

  // Paginated history endpoint
  if (backfill) {
    let page = 1
    while (true) {
      try {
        const data = await fetchJson<IioPaginatedResponse>(
          `${base}/api/v1/incidents?per_page=100&page=${page}`,
        )
        const items = data.incidents ?? []
        if (items.length === 0) break
        add(items)
        console.log(`    page ${page}: ${items.length} incidents`)
        if (items.length < 100) break
        page++
      } catch (e) {
        if (page === 1) {
          console.warn(`  ⚠ History endpoint not available: ${e instanceof Error ? e.message : e}`)
        }
        break
      }
    }
  } else {
    try {
      const data = await fetchJson<IioPaginatedResponse>(`${base}/api/v1/incidents?per_page=100`)
      add(data.incidents ?? [])
    } catch {
      // History unavailable; widget-only is acceptable for regular scrapes
    }
  }

  if (all.length === 0 && seen.size === 0) {
    throw new Error('No data returned from any incident.io endpoint')
  }

  return buildIncidents(all, company)
}
