import type {
  Company,
  Incident,
  IncidentSeverity,
  AtlassianIncident,
  AtlassianSummaryResponse,
  AtlassianIncidentsResponse,
} from './types'
import { fetchJson, calcDuration } from './http'
import { routeByTitle, isTitleRouted } from './routing'

const IMPACT_TO_SEVERITY: Record<string, IncidentSeverity> = {
  none: 'degraded_performance',
  minor: 'degraded_performance',
  major: 'partial_outage',
  critical: 'major_outage',
}

function mapSeverity(impact: string): IncidentSeverity {
  return IMPACT_TO_SEVERITY[impact] ?? 'degraded_performance'
}

const PLACEHOLDER = 'REPLACE_WITH_REAL_ID'

// A company is "configured" only if at least one product has at least one
// real (non-placeholder) component ID. An all-empty component_ids list would
// vacuously pass every(), so we use some() to require at least one real ID.
function isConfigured(company: Company): boolean {
  return company.products.some((p) =>
    p.component_ids.some((id) => id !== PLACEHOLDER),
  )
}

function buildIncidents(
  raw: AtlassianIncident[],
  company: Company,
): Incident[] {
  const configured = isConfigured(company)
  const allComponentIds = new Set(
    company.products.flatMap((p) => p.component_ids),
  )

  // When a company configures title routing, incidents with no component links
  // are attributed to a product (and rolled up under it) rather than dumped as
  // a generic "Uncategorised" entry.
  const titleRouted = isTitleRouted(company)

  const incidents: Incident[] = []

  // Short-circuit: when no component IDs are configured but title routing is
  // active, route every incident by title regardless of component links. This
  // handles companies like OpenAI (component_ids:[]) and GitHub (status page
  // covers many services; we only want Copilot incidents).
  if (!configured && titleRouted) {
    for (const raw_inc of raw) {
      const product = routeByTitle(company, raw_inc.name)
      if (!product) continue
      incidents.push({
        id: `${raw_inc.id}-${product.id}`,
        product_id: product.id,
        component_id: product.id,
        component_name: product.name,
        title: raw_inc.name,
        opened_at: raw_inc.created_at,
        resolved_at: raw_inc.resolved_at,
        duration_minutes: calcDuration(raw_inc.created_at, raw_inc.resolved_at),
        raw_severity: mapSeverity(raw_inc.impact),
        status_page_incident_url: raw_inc.shortlink,
      })
    }
    return incidents
  }

  for (const raw_inc of raw) {
    const components = raw_inc.components ?? []
    const matchedComponents = configured
      ? components.filter((c) => allComponentIds.has(c.id))
      : components

    const fallbackProduct = company.products[0]

    if (matchedComponents.length === 0) {
      // No components matched — either no components listed, or all reference retired IDs.
      // Always fall back to fallback product so incidents aren't silently dropped.
      if (components.length === 0) {
        // No component links at all — route by title keywords (or drop if the
        // title matches the company's skip list, e.g. FedRAMP).
        const product = routeByTitle(company, raw_inc.name)
        if (!product) continue
        incidents.push({
          id: titleRouted ? `${raw_inc.id}-${product.id}` : `${raw_inc.id}-uncategorised`,
          product_id: product.id,
          component_id: titleRouted ? product.id : 'uncategorised',
          component_name: titleRouted ? product.name : 'Uncategorised',
          title: raw_inc.name,
          opened_at: raw_inc.created_at,
          resolved_at: raw_inc.resolved_at,
          duration_minutes: calcDuration(raw_inc.created_at, raw_inc.resolved_at),
          raw_severity: mapSeverity(raw_inc.impact),
          status_page_incident_url: raw_inc.shortlink,
        })
      } else {
        // Has components but IDs don't match configured list (legacy/retired).
        for (const component of components) {
          incidents.push({
            id: `${raw_inc.id}-${component.id}`,
            product_id: fallbackProduct.id,
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
      continue
    }

    // Group matched components by product
    const byProduct = new Map<string, { product: typeof fallbackProduct; components: typeof matchedComponents }>()
    for (const component of matchedComponents) {
      const product = configured
        ? company.products.find((p) => p.component_ids.includes(component.id))
        : fallbackProduct
      if (!product) continue
      const entry = byProduct.get(product.id)
      if (entry) entry.components.push(component)
      else byProduct.set(product.id, { product, components: [component] })
    }

    for (const { product, components: productComponents } of byProduct.values()) {
      if (product.rollup) {
        // One record per product per incident regardless of how many components were affected
        incidents.push({
          id: `${raw_inc.id}-${product.id}`,
          product_id: product.id,
          component_id: product.id,
          component_name: product.name,
          title: raw_inc.name,
          opened_at: raw_inc.created_at,
          resolved_at: raw_inc.resolved_at,
          duration_minutes: calcDuration(raw_inc.created_at, raw_inc.resolved_at),
          raw_severity: mapSeverity(raw_inc.impact),
          status_page_incident_url: raw_inc.shortlink,
        })
      } else {
        for (const component of productComponents) {
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
    }
  }

  return incidents
}

async function fetchAllIncidentPages(
  base: string,
): Promise<AtlassianIncident[]> {
  const all: AtlassianIncident[] = []
  let page = 1

  while (true) {
    const data = await fetchJson<AtlassianIncidentsResponse>(
      `${base}/api/v2/incidents.json?limit=100&page=${page}`,
    )
    const incidents = data.incidents ?? []
    if (incidents.length === 0) break
    all.push(...incidents)
    console.log(`    page ${page}: ${incidents.length} incidents`)
    if (incidents.length < 100) break  // last page
    page++
  }

  return all
}

export async function scrapeAtlassian(
  company: Company,
  backfill = false,
): Promise<Incident[]> {
  const base = company.status_page_url.replace(/\/$/, '')

  const summaryPromise = fetchJson<AtlassianSummaryResponse>(
    `${base}/api/v2/summary.json`,
  )

  const historyPromise = backfill
    ? fetchAllIncidentPages(base)
    : fetchJson<AtlassianIncidentsResponse>(
        `${base}/api/v2/incidents.json?limit=100`,
      ).then((r) => r.incidents ?? [])

  const [summary, historyIncidents] = await Promise.all([
    summaryPromise,
    historyPromise,
  ])

  // Merge summary (catches active incidents) with history, deduplicating by id
  const seen = new Set<string>()
  const merged: AtlassianIncident[] = []

  for (const inc of [...(summary.incidents ?? []), ...historyIncidents]) {
    if (!seen.has(inc.id)) {
      seen.add(inc.id)
      merged.push(inc)
    }
  }

  return buildIncidents(merged, company)
}
