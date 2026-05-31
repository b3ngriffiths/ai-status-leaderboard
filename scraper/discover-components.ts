/**
 * Probe a status page to learn which API it actually serves, then dump the
 * component / section structure for whichever platform responds.
 *
 * Usage: ts-node scraper/discover-components.ts <status_page_url>
 *
 * Examples:
 *   ts-node scraper/discover-components.ts https://status.openai.com
 *   ts-node scraper/discover-components.ts https://status.deepseek.com
 */

const url = process.argv[2]

if (!url) {
  console.error('Usage: ts-node scraper/discover-components.ts <status_page_url>')
  process.exit(1)
}

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

type Component = { id: string; name: string; status: string; group: boolean; group_id: string | null }
type Incident = { id: string; name: string; impact: string; created_at: string; resolved_at: string | null; components: Array<{ id: string; name: string }> }

// Raw probe: returns status + parsed JSON (or raw text snippet). Never throws.
async function probe(
  url: string,
): Promise<{ ok: boolean; status: number; ctype: string; json?: any; isHtml: boolean; snippet: string }> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    const ctype = res.headers.get('content-type') ?? ''
    return {
      ok: res.ok,
      status: res.status,
      ctype,
      json,
      isHtml: /<!doctype|<html/i.test(text.slice(0, 200)),
      snippet: text.slice(0, 160).replace(/\s+/g, ' '),
    }
  } catch (e) {
    return { ok: false, status: 0, ctype: '', isHtml: false, snippet: e instanceof Error ? e.message : String(e) }
  }
}

const CANDIDATES = [
  { name: 'Atlassian summary', path: '/api/v2/summary.json' },
  { name: 'Atlassian incidents', path: '/api/v2/incidents.json?limit=5' },
  { name: 'Instatus summary', path: '/summary.json' },
  { name: 'BetterStack index', path: '/index.json' },
  { name: 'BetterStack history', path: '/history.json' },
  { name: 'BetterStack public-api', path: '/public-api/v1/incidents' },
  { name: 'public-api root', path: '/public-api' },
  { name: 'incident.io widget', path: '/api/widget' },
  { name: 'API v1 incidents', path: '/api/v1/incidents' },
  { name: 'RSS history', path: '/history.rss' },
  { name: 'Atom history', path: '/history.atom' },
]

function dumpAtlassian(summary: { components: Component[]; incidents: Incident[] | null }, history: { incidents: Incident[] | null }) {
  console.log(`\n${'='.repeat(60)}\nAtlassian components\n${'='.repeat(60)}`)
  const groups = summary.components.filter((c) => c.group)
  const members = summary.components.filter((c) => !c.group)
  for (const g of groups) {
    console.log(`\n[GROUP] ${g.name}  id: ${g.id}`)
    for (const child of members.filter((m) => m.group_id === g.id)) {
      console.log(`  ├─ ${child.name.padEnd(40)} id: ${child.id}  status: ${child.status}`)
    }
  }
  const ungrouped = members.filter((m) => !m.group_id)
  if (ungrouped.length) {
    console.log('\n[UNGROUPED]')
    for (const c of ungrouped) console.log(`  ├─ ${c.name.padEnd(40)} id: ${c.id}`)
  }
  const historical = history.incidents ?? []
  console.log(`\nMost recent incidents (${historical.length}):`)
  for (const inc of historical.slice(0, 10)) {
    const comps = (inc.components ?? []).map((c) => `${c.name}[${c.id}]`).join(', ') || '(no components listed)'
    console.log(`  [${inc.created_at.slice(0, 10)}] ${inc.name}\n    components: ${comps}`)
  }
}

function dumpBetterstack(page: any) {
  console.log(`\n${'='.repeat(60)}\nBetterStack structure\n${'='.repeat(60)}`)
  const included: Array<{ type: string; id: string; attributes: any }> = page.included ?? []
  const sections = included.filter((i) => i.type === 'section')
  const resources = included.filter((i) => i.type === 'resource')
  const reports = included.filter((i) => i.type === 'status_report')
  console.log(`\nSections (use these names as group_name):`)
  for (const s of sections) console.log(`  [SECTION] "${s.attributes?.name}"  id: ${s.id}`)
  console.log(`\nResources (${resources.length}):`)
  for (const r of resources.slice(0, 30)) {
    console.log(`  ├─ ${String(r.attributes?.public_name ?? r.attributes?.name).padEnd(40)} id: ${r.id}  section_id: ${r.attributes?.section_id}`)
  }
  console.log(`\nStatus reports (${reports.length}):`)
  for (const rep of reports.slice(0, 10)) {
    const a = rep.attributes ?? {}
    console.log(`  [${String(a.starts_at).slice(0, 10)}] type=${a.report_type} state=${a.aggregate_state} affected=${JSON.stringify(a.affected_resources)}  "${a.title}"`)
  }
}

async function main() {
  const base = url.replace(/\/$/, '')

  console.log(`\n${'#'.repeat(60)}\n# Probing: ${base}\n${'#'.repeat(60)}`)
  const results: Record<string, Awaited<ReturnType<typeof probe>>> = {}
  for (const c of CANDIDATES) {
    const r = await probe(`${base}${c.path}`)
    results[c.path] = r
    const tag = r.ok && r.json ? '✅JSON' : r.ok && r.isHtml ? '⚠️ HTML' : r.ok ? '⚠️ 200 ' : '❌'
    const detail = r.json
      ? `keys: ${Object.keys(r.json).slice(0, 8).join(',')}`
      : `${r.ctype.split(';')[0]} — ${r.snippet}`
    console.log(`${tag} ${c.name.padEnd(22)} HTTP ${r.status}  ${detail}`)
  }

  // Detailed dump for whichever platform actually responded.
  const summary = results['/api/v2/summary.json']
  const incidents = results['/api/v2/incidents.json?limit=5']
  if (summary?.ok && summary.json?.components) {
    const history = await probe(`${base}/api/v2/incidents.json?limit=100`)
    dumpAtlassian(summary.json, history.json ?? { incidents: [] })
    void incidents
  }

  const bsIndex = results['/index.json']
  if (bsIndex?.ok && bsIndex.json?.data?.type === 'status_page') {
    dumpBetterstack(bsIndex.json)
  }

  const widget = results['/api/widget']
  if (widget?.ok && widget.json) {
    console.log(`\n${'='.repeat(60)}\nincident.io widget keys: ${Object.keys(widget.json).join(', ')}\n${'='.repeat(60)}`)
  }

  console.log()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
