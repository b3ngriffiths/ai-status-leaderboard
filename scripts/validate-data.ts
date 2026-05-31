import fs from 'fs'
import path from 'path'
import type { Company, CompanyIncidentFile, Incident } from '../scraper/types'

const DATA_DIR = path.join(__dirname, '..', 'site', 'data')
let errors = 0
let warnings = 0

function fail(msg: string) {
  console.error(`  ✗ ${msg}`)
  errors++
}

function warn(msg: string) {
  console.warn(`  ⚠ ${msg}`)
  warnings++
}

function ok(msg: string) {
  console.log(`  ✓ ${msg}`)
}

function validateIncident(inc: Incident, idx: number) {
  if (!inc.id) fail(`incident[${idx}]: missing id`)
  if (!inc.product_id) fail(`incident[${idx}]: missing product_id`)
  if (!inc.component_id) fail(`incident[${idx}]: missing component_id`)
  if (!inc.opened_at || isNaN(Date.parse(inc.opened_at)))
    fail(`incident[${idx}]: invalid opened_at: ${inc.opened_at}`)
  if (inc.resolved_at !== null && isNaN(Date.parse(inc.resolved_at)))
    fail(`incident[${idx}]: invalid resolved_at: ${inc.resolved_at}`)
  if (inc.resolved_at && inc.duration_minutes === null)
    fail(`incident[${idx}]: resolved_at set but duration_minutes is null`)
  const validSeverities = [
    'operational',
    'degraded_performance',
    'partial_outage',
    'major_outage',
  ]
  if (!validSeverities.includes(inc.raw_severity))
    fail(`incident[${idx}]: invalid severity: ${inc.raw_severity}`)
}

function validateCompanyFile(file: string, companyIds: Set<string>) {
  console.log(`\nValidating ${path.basename(file)}...`)
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as CompanyIncidentFile

  if (!data.company_id) fail('missing company_id')
  if (!companyIds.has(data.company_id))
    fail(`company_id "${data.company_id}" not found in companies.json`)
  if (data.last_scraped === null) {
    warn(`last_scraped is null (company not yet scraped)`)
  } else if (!data.last_scraped || isNaN(Date.parse(data.last_scraped))) {
    fail(`invalid last_scraped: ${data.last_scraped}`)
  }
  if (typeof data.scrape_success !== 'boolean') fail('scrape_success must be boolean')
  if (!Array.isArray(data.incidents)) fail('incidents must be an array')

  data.incidents.forEach((inc, i) => validateIncident(inc, i))
  ok(`${data.incidents.length} incidents validated`)
}

function main() {
  console.log('Validating data files...')

  const companiesFile = path.join(DATA_DIR, 'companies.json')
  const companiesData = JSON.parse(fs.readFileSync(companiesFile, 'utf8')) as {
    companies: Company[]
  }
  const companyIds = new Set(companiesData.companies.map((c) => c.id))
  ok(`companies.json: ${companiesData.companies.length} companies`)

  for (const company of companiesData.companies) {
    if (!company.id) fail('company missing id')
    if (!company.slug) fail(`${company.id}: missing slug`)
    if (!['atlassian', 'incident_io', 'betterstack', 'custom'].includes(company.page_type))
      fail(`${company.id}: invalid page_type`)
    const titleRouted =
      !!company.title_skip?.length ||
      company.products.some((p) => p.title_keywords?.length)
    for (const product of company.products) {
      if (!product.id) fail(`${company.id}: product missing id`)
      if (
        !product.component_ids.length &&
        !product.group_name &&
        !product.title_keywords &&
        !titleRouted
      )
        fail(`${company.id}/${product.id}: no component_ids, group_name, or title_keywords`)
      if (product.component_ids.includes('REPLACE_WITH_REAL_ID'))
        warn(`${company.id}/${product.id}: contains placeholder component_id (run Discover to get real IDs)`)
    }
  }

  const incidentsDir = path.join(DATA_DIR, 'incidents')
  const incidentFiles = fs.readdirSync(incidentsDir).filter((f) => f.endsWith('.json'))

  for (const f of incidentFiles) {
    validateCompanyFile(path.join(incidentsDir, f), companyIds)
  }

  if (warnings > 0) console.warn(`\n⚠ ${warnings} warning(s) — fix before production`)
  console.log(`\n${errors === 0 ? '✅ All checks passed' : `❌ ${errors} error(s) found`}`)
  process.exit(errors > 0 ? 1 : 0)
}

main()
