/**
 * Run locally to discover component IDs for any Atlassian Statuspage.
 * Usage: ts-node scraper/discover-components.ts <status_page_url>
 *
 * Example:
 *   ts-node scraper/discover-components.ts https://status.openai.com
 *   ts-node scraper/discover-components.ts https://status.anthropic.com
 */

const url = process.argv[2]

if (!url) {
  console.error('Usage: ts-node scraper/discover-components.ts <status_page_url>')
  process.exit(1)
}

import { fetchJson } from './http'

type Component = { id: string; name: string; status: string; group: boolean; group_id: string | null }
type Incident = { id: string; name: string; impact: string; created_at: string; resolved_at: string | null; components: Array<{ id: string; name: string }> }

async function main() {
  const base = url.replace(/\/$/, '')

  const [summary, history] = await Promise.all([
    fetchJson<{ components: Component[]; incidents: Incident[] | null }>(`${base}/api/v2/summary.json`),
    fetchJson<{ incidents: Incident[] | null }>(`${base}/api/v2/incidents.json?limit=100`),
  ])

  // ── Current components ─────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Components for: ${base}`)
  console.log('='.repeat(60))

  const groups = summary.components.filter((c) => c.group)
  const members = summary.components.filter((c) => !c.group)

  for (const g of groups) {
    console.log(`\n[GROUP] ${g.name}  id: ${g.id}`)
    const children = members.filter((m) => m.group_id === g.id)
    for (const child of children) {
      console.log(`  ├─ ${child.name.padEnd(40)} id: ${child.id}  status: ${child.status}`)
    }
  }

  const ungrouped = members.filter((m) => !m.group_id)
  if (ungrouped.length > 0) {
    console.log('\n[UNGROUPED]')
    for (const c of ungrouped) {
      console.log(`  ├─ ${c.name.padEnd(40)} id: ${c.id}  status: ${c.status}`)
    }
  }

  // ── Active incidents ────────────────────────────────────────────────────
  const active = summary.incidents ?? []
  if (active.length > 0) {
    console.log(`\n${'='.repeat(60)}`)
    console.log('Active incidents:')
    for (const inc of active) {
      console.log(`  [${inc.impact.toUpperCase()}] ${inc.name}`)
      for (const c of (inc.components ?? [])) {
        console.log(`    component: ${c.id}  ${c.name}`)
      }
    }
  } else {
    console.log('\n(No active incidents)')
  }

  // ── Historical incident component IDs ───────────────────────────────────
  const historical = history.incidents ?? []
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Historical incidents (last ${historical.length}):`)
  console.log('='.repeat(60))

  if (historical.length === 0) {
    console.log('  (none)')
  } else {
    // Collect all unique component IDs seen across incidents
    const seen = new Map<string, { name: string; count: number }>()
    for (const inc of historical) {
      for (const c of (inc.components ?? [])) {
        const entry = seen.get(c.id)
        if (entry) entry.count++
        else seen.set(c.id, { name: c.name, count: 1 })
      }
    }

    console.log(`\nComponent IDs seen in incident history (${seen.size} unique):`)
    const sorted = [...seen.entries()].sort((a, b) => b[1].count - a[1].count)
    for (const [id, { name, count }] of sorted) {
      const inCurrent = summary.components.some((c) => c.id === id)
      const flag = inCurrent ? '' : '  ⚠ NOT in current component list'
      console.log(`  ${id}  ${name.padEnd(40)}  (${count} incident${count !== 1 ? 's' : ''})${flag}`)
    }

    console.log('\nMost recent 10 incidents:')
    for (const inc of historical.slice(0, 10)) {
      const date = inc.created_at.slice(0, 10)
      const resolved = inc.resolved_at ? inc.resolved_at.slice(0, 10) : 'ongoing'
      const comps = (inc.components ?? []).map((c) => c.name).join(', ') || '(no components listed)'
      console.log(`  [${date}→${resolved}] [${inc.impact}] ${inc.name}`)
      console.log(`    components: ${comps}`)
    }
  }

  console.log()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
