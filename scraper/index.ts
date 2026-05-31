import fs from 'fs'
import path from 'path'
import type { Company, CompanyIncidentFile, Incident, ScrapeResult } from './types'
import { scrapeAtlassian } from './atlassian'
import { scrapeIncidentIo } from './incident-io'
import { scrapeBetterstack } from './betterstack'

const DATA_DIR = path.join(__dirname, '..', 'site', 'data')
const INCIDENTS_DIR = path.join(DATA_DIR, 'incidents')
const COMPANIES_FILE = path.join(DATA_DIR, 'companies.json')

const DRY_RUN = process.argv.includes('--dry-run')
const BACKFILL = process.argv.includes('--backfill')

function loadCompanies(): Company[] {
  const raw = fs.readFileSync(COMPANIES_FILE, 'utf8')
  return JSON.parse(raw).companies as Company[]
}

function loadExisting(companyId: string): CompanyIncidentFile {
  const file = path.join(INCIDENTS_DIR, `${companyId}.json`)
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CompanyIncidentFile
  }
  return {
    company_id: companyId,
    last_scraped: new Date().toISOString(),
    scrape_success: false,
    incidents: [],
  }
}

function mergeIncidents(
  existing: Incident[],
  fresh: Incident[],
): { merged: Incident[]; newCount: number; resolvedCount: number } {
  const byId = new Map(existing.map((i) => [i.id, { ...i }]))
  let newCount = 0
  let resolvedCount = 0

  for (const inc of fresh) {
    const prev = byId.get(inc.id)
    if (!prev) {
      byId.set(inc.id, inc)
      newCount++
    } else {
      if (!prev.resolved_at && inc.resolved_at) {
        prev.resolved_at = inc.resolved_at
        prev.duration_minutes = inc.duration_minutes
        resolvedCount++
      }
    }
  }

  const merged = [...byId.values()].sort(
    (a, b) => new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime(),
  )

  return { merged, newCount, resolvedCount }
}

function writeIncidents(data: CompanyIncidentFile): void {
  const file = path.join(INCIDENTS_DIR, `${data.company_id}.json`)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

async function scrapeCompany(company: Company): Promise<ScrapeResult> {
  const { page_type } = company

  if (page_type === 'custom') {
    console.log(`⏭️  ${company.name}: skipped (page_type=custom, no scraper implemented)`)
    return { company_id: company.id, success: false, new_incidents: 0, resolved_incidents: 0, error: `no scraper for page_type=${page_type}` }
  }

  try {
    if (BACKFILL) console.log(`  📦 Backfilling ${company.name}…`)

    let fresh: Incident[]
    if (page_type === 'atlassian') {
      fresh = await scrapeAtlassian(company, BACKFILL)
    } else if (page_type === 'incident_io') {
      fresh = await scrapeIncidentIo(company, BACKFILL)
    } else if (page_type === 'betterstack') {
      fresh = await scrapeBetterstack(company, BACKFILL)
    } else {
      throw new Error(`Unknown page_type: ${page_type}`)
    }
    const existing = loadExisting(company.id)
    const { merged, newCount, resolvedCount } = mergeIncidents(
      existing.incidents,
      fresh,
    )

    const updated: CompanyIncidentFile = {
      company_id: company.id,
      last_scraped: new Date().toISOString(),
      scrape_success: true,
      incidents: merged,
    }

    if (!DRY_RUN) writeIncidents(updated)

    return {
      company_id: company.id,
      success: true,
      new_incidents: newCount,
      resolved_incidents: resolvedCount,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const existing = loadExisting(company.id)
    if (existing.incidents.length > 0 && !DRY_RUN) {
      writeIncidents({
        ...existing,
        last_scraped: new Date().toISOString(),
        scrape_success: false,
      })
    }
    return {
      company_id: company.id,
      success: false,
      new_incidents: 0,
      resolved_incidents: 0,
      error: message,
    }
  }
}

async function main(): Promise<void> {
  if (DRY_RUN) console.log('🔍 Dry run mode — no files will be written\n')
  if (BACKFILL) console.log('📦 Backfill mode — paginating full incident history\n')

  const companies = loadCompanies()
  const results: ScrapeResult[] = []

  for (const company of companies) {
    const result = await scrapeCompany(company)
    results.push(result)

    if (result.success) {
      const parts: string[] = []
      if (result.new_incidents > 0)
        parts.push(`${result.new_incidents} new incident${result.new_incidents !== 1 ? 's' : ''}`)
      if (result.resolved_incidents > 0)
        parts.push(`${result.resolved_incidents} resolved`)
      const summary = parts.length > 0 ? parts.join(', ') : 'no changes'
      console.log(`✅ ${company.name}: ${summary}`)
    } else {
      console.log(
        `❌ ${company.name}: fetch failed (${result.error}) -- existing data preserved`,
      )
    }
  }

  const allFailed = results.every((r) => !r.success)
  if (allFailed) {
    console.error('\nAll companies failed to scrape')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
