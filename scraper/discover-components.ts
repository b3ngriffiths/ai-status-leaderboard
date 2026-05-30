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

async function main() {
  const base = url.replace(/\/$/, '')
  const res = await fetch(`${base}/api/v2/summary.json`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const data = (await res.json()) as {
    components: Array<{
      id: string
      name: string
      status: string
      group: boolean
      group_id: string | null
    }>
    incidents: Array<{
      id: string
      name: string
      impact: string
      components: Array<{ id: string; name: string }>
    }>
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Components for: ${base}`)
  console.log('='.repeat(60))

  // Print group headers first, then members
  const groups = data.components.filter((c) => c.group)
  const members = data.components.filter((c) => !c.group)

  for (const g of groups) {
    console.log(`\n[GROUP] ${g.name}`)
    console.log(`  id: ${g.id}`)
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

  if ((data.incidents ?? []).length > 0) {
    console.log(`\n${'='.repeat(60)}`)
    console.log('Active incidents:')
    for (const inc of (data.incidents ?? [])) {
      console.log(`  [${inc.impact.toUpperCase()}] ${inc.name}`)
      for (const c of inc.components) {
        console.log(`    component: ${c.id}  ${c.name}`)
      }
    }
  } else {
    console.log('\n(No active incidents)')
  }

  console.log()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
