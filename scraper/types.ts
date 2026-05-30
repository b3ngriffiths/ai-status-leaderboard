export type PageType = 'atlassian' | 'custom'
export type IncidentSeverity =
  | 'operational'
  | 'degraded_performance'
  | 'partial_outage'
  | 'major_outage'
export type ProductCategory =
  | 'ai-api'
  | 'ai-chat'
  | 'ai-code'
  | 'ai-image'
  | 'ai-other'

export interface Product {
  id: string
  name: string
  category: ProductCategory
  component_ids: string[]
  rollup?: boolean
}

export interface Company {
  id: string
  name: string
  slug: string
  status_page_url: string
  page_type: PageType
  logo_url: string
  products: Product[]
}

export interface Incident {
  id: string
  product_id: string
  component_id: string
  component_name: string
  title: string
  opened_at: string
  resolved_at: string | null
  duration_minutes: number | null
  raw_severity: IncidentSeverity
  status_page_incident_url: string
}

export interface CompanyIncidentFile {
  company_id: string
  last_scraped: string
  scrape_success: boolean
  incidents: Incident[]
}

export interface ScrapeResult {
  company_id: string
  success: boolean
  new_incidents: number
  resolved_incidents: number
  error?: string
}

// Atlassian Statuspage API response shapes
export interface AtlassianComponent {
  id: string
  name: string
  status: string
  description?: string
  group_id?: string | null
  group?: boolean
}

export interface AtlassianIncidentUpdate {
  id: string
  status: string
  body: string
  created_at: string
  updated_at: string
}

export interface AtlassianIncident {
  id: string
  name: string
  status: string
  impact: string
  created_at: string
  resolved_at: string | null
  shortlink: string
  incident_updates: AtlassianIncidentUpdate[]
  components: AtlassianComponent[]
}

export interface AtlassianSummaryResponse {
  components: AtlassianComponent[]
  incidents: AtlassianIncident[]
}

export interface AtlassianIncidentsResponse {
  incidents: AtlassianIncident[]
}
