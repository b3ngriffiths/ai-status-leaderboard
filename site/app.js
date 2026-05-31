/* =========================================================
   AI Status Leaderboard — app.js
   Pure vanilla JS. No frameworks. No CDN deps.
   ========================================================= */

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

const DATA_BASE = 'data'

// ---------------------------------------------------------------------------
// Security helpers — incident titles/URLs come from external status pages and
// must never be injected into the DOM as raw HTML.
// ---------------------------------------------------------------------------

const _ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml (value) {
  return String(value ?? '').replace(/[&<>"']/g, c => _ESCAPE_MAP[c])
}

// Only allow http(s) links; anything else (e.g. javascript:) collapses to '#'.
function safeUrl (value) {
  const s = String(value ?? '')
  return /^https?:\/\//i.test(s) ? s : '#'
}

async function loadAll () {
  const companiesRes = await fetch(`${DATA_BASE}/companies.json`)
  const companies = (await companiesRes.json()).companies

  const incidentFiles = await Promise.all(
    companies.map(c =>
      fetch(`${DATA_BASE}/incidents/${c.id}.json`).then(r => r.json())
    )
  )

  return { companies, incidentFiles }
}

// ---------------------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------------------

const PERIODS = { 7: 7 * 1440, 30: 30 * 1440, 90: 90 * 1440, 0: Infinity }

function periodMinutes (days) {
  return days === 0 ? Infinity : days * 1440
}

function incidentsInPeriod (incidents, days) {
  if (days === 0) return incidents
  const cutoff = Date.now() - days * 86_400_000
  return incidents.filter(i => new Date(i.opened_at).getTime() >= cutoff)
}

function downtimeInPeriod (incidents, days) {
  const now = Date.now()
  const cutoff = days === 0 ? 0 : now - days * 86_400_000
  // Build non-overlapping intervals then sum, so concurrent incidents don't double-count.
  const intervals = []
  for (const inc of incidents) {
    const start = Math.max(new Date(inc.opened_at).getTime(), cutoff)
    const end = inc.resolved_at ? new Date(inc.resolved_at).getTime() : now
    if (end > start) intervals.push([start, end])
  }
  // Merge overlapping intervals
  intervals.sort((a, b) => a[0] - b[0])
  let total = 0
  let mergeStart = -1, mergeEnd = -1
  for (const [s, e] of intervals) {
    if (s > mergeEnd) {
      if (mergeEnd > mergeStart) total += mergeEnd - mergeStart
      mergeStart = s; mergeEnd = e
    } else {
      mergeEnd = Math.max(mergeEnd, e)
    }
  }
  if (mergeEnd > mergeStart) total += mergeEnd - mergeStart
  return Math.round(total / 60_000)
}

function uptimePct (downtimeMinutes, days) {
  const period = days === 0 ? null : days * 1440
  if (!period) {
    // All time: need the oldest incident or 90 days
    const fallback = 90 * 1440
    return (1 - downtimeMinutes / fallback) * 100
  }
  return Math.max(0, (1 - downtimeMinutes / period) * 100)
}

function mttr (incidents) {
  const resolved = incidents.filter(i => i.resolved_at && i.duration_minutes !== null)
  if (!resolved.length) return null
  return Math.round(resolved.reduce((s, i) => s + i.duration_minutes, 0) / resolved.length)
}

function longestOutage (incidents) {
  const resolved = incidents.filter(i => i.duration_minutes !== null)
  if (!resolved.length) return null
  return resolved.reduce((best, i) => i.duration_minutes > best.duration_minutes ? i : best)
}

function isCurrentlyAffected (incidents) {
  return incidents.some(i => !i.resolved_at)
}

function lastIncident (incidents) {
  if (!incidents.length) return null
  return incidents.reduce((newest, i) =>
    new Date(i.opened_at) > new Date(newest.opened_at) ? i : newest
  )
}

function computeProductStats (product, allIncidents, days) {
  const productIncidents = allIncidents.filter(i => i.product_id === product.id)
  const inPeriod = incidentsInPeriod(productIncidents, days)
  const dtMins = downtimeInPeriod(productIncidents, days)
  const uptime = uptimePct(dtMins, days)
  return {
    product,
    incidents: inPeriod,
    allIncidents: productIncidents,
    downtimeMinutes: dtMins,
    uptime,
    mttr: mttr(inPeriod),
    longest: longestOutage(inPeriod),
    last: lastIncident(inPeriod),
    affected: isCurrentlyAffected(productIncidents)
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtUptime (pct) {
  return pct.toFixed(3) + '%'
}

function fmtDuration (minutes) {
  if (minutes === null || minutes === undefined) return '—'
  if (minutes < 1) return '<1m'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

function fmtRelative (dateStr) {
  if (!dateStr) return '—'
  const ms = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtDate (dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  })
}

function uptimeClass (pct) {
  if (pct >= 99.9) return 'green'
  if (pct >= 99.0) return 'amber'
  return 'red'
}

function categoryLabel (cat) {
  const map = {
    'ai-api': 'AI API',
    'ai-chat': 'AI Chat',
    'ai-code': 'AI Code',
    'ai-image': 'AI Image',
    'ai-other': 'AI Other'
  }
  return map[cat] || cat
}

// ---------------------------------------------------------------------------
// Sparkline SVG (30 bars, one per day)
// ---------------------------------------------------------------------------

function buildSparkline (allIncidents, width = 62, height = 20) {
  const days = 30
  const barW = Math.floor((width - (days - 1)) / days)
  const gap = 1
  const now = Date.now()

  // Sum downtime per day bucket
  const buckets = new Array(days).fill(0)
  for (const inc of allIncidents) {
    const start = new Date(inc.opened_at).getTime()
    const ageMs = now - start
    const dayIdx = Math.floor(ageMs / 86_400_000)
    if (dayIdx >= 0 && dayIdx < days) {
      const dur = inc.duration_minutes ?? Math.round((now - start) / 60_000)
      buckets[dayIdx] += dur
    }
  }

  const maxVal = Math.max(...buckets, 1)

  const bars = buckets.map((val, i) => {
    const x = (days - 1 - i) * (barW + gap)
    const barH = val === 0 ? 2 : Math.max(2, Math.round((val / maxVal) * height))
    const y = height - barH
    const fill = val === 0 ? '#1c2128' : (val > 60 ? '#f85149' : '#d29922')
    return `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${fill}" rx="1"/>`
  }).join('')

  return `<svg class="sparkline" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`
}

// ---------------------------------------------------------------------------
// Leaderboard page
// ---------------------------------------------------------------------------

let _state = {
  companies: [],
  incidentFiles: [],
  cat: 'all',
  days: 30,
  sortCol: 'uptime',
  sortDir: 'desc'
}

function flatRows () {
  const rows = []
  for (const company of _state.companies) {
    const file = _state.incidentFiles.find(f => f.company_id === company.id)
    if (!file) continue
    // A company that has never been scraped successfully has no basis for an
    // uptime figure — surface "No data" rather than a misleading 100%.
    const noData = !file.last_scraped
    for (const product of company.products) {
      rows.push({
        company,
        noData,
        ...computeProductStats(product, file.incidents, _state.days)
      })
    }
  }
  return rows
}

function filterRows (rows) {
  if (_state.cat === 'all') return rows
  return rows.filter(r => r.product.category === _state.cat ||
    (_state.cat === 'ai-other' && !['ai-api', 'ai-chat', 'ai-code', 'ai-image'].includes(r.product.category)))
}

function sortRows (rows) {
  const col = _state.sortCol
  const dir = _state.sortDir === 'desc' ? -1 : 1

  return [...rows].sort((a, b) => {
    // Always keep "No data" rows at the bottom regardless of sort column/dir.
    if (a.noData !== b.noData) return a.noData ? 1 : -1
    let va, vb
    switch (col) {
      case 'uptime': va = a.uptime; vb = b.uptime; break
      case 'incidents': va = a.incidents.length; vb = b.incidents.length; break
      case 'downtime': va = a.downtimeMinutes; vb = b.downtimeMinutes; break
      case 'mttr': va = a.mttr ?? Infinity; vb = b.mttr ?? Infinity; break
      case 'alpha': return dir * a.product.name.localeCompare(b.product.name)
      default: va = a.uptime; vb = b.uptime
    }
    return dir * (va - vb)
  })
}

function renderLeaderboard () {
  const tbody = document.getElementById('leaderboard-body')
  if (!tbody) return

  const allRows = flatRows()
  const filtered = filterRows(allRows)
  const sorted = sortRows(filtered)

  // Update summary bar
  updateSummary(allRows, _state.days)

  // Update last scraped
  const files = _state.incidentFiles
  if (files.length) {
    const newest = files
      .filter(f => f.scrape_success)
      .map(f => new Date(f.last_scraped).getTime())
    if (newest.length) {
      const maxTs = Math.max(...newest)
      document.getElementById('last-scraped').textContent =
        'Last scraped: ' + fmtRelative(new Date(maxTs).toISOString())
    }
  }

  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--muted);padding:24px">No data available yet. Run the scraper first.</td></tr>'
    return
  }

  tbody.innerHTML = sorted.map((row, idx) => {
    const companyId = encodeURIComponent(row.company.id)
    const logo = escapeHtml(row.company.logo_url)
    const name = escapeHtml(row.company.name)
    const productName = escapeHtml(row.product.name)
    const category = escapeHtml(row.product.category)

    if (row.noData) {
      return `<tr onclick="window.location='company.html?id=${companyId}'">
        <td class="col-rank">${idx + 1}</td>
        <td><div class="col-company">
          <img src="${logo}" alt="${name}" onerror="this.style.display='none'">
          <strong>${name}</strong>
        </div></td>
        <td>${productName}</td>
        <td><span class="badge badge-${category}">${escapeHtml(categoryLabel(row.product.category))}</span></td>
        <td class="col-uptime" style="color:var(--muted)">No data</td>
        <td class="mono-cell">—</td>
        <td class="mono-cell">—</td>
        <td class="mono-cell">—</td>
        <td class="mono-cell">—</td>
        <td class="mono-cell">—</td>
        <td></td>
        <td><span class="status-dot" style="background:var(--muted)" title="Not yet monitored"></span></td>
      </tr>`
    }

    const cls = uptimeClass(row.uptime)
    const longestInc = row.longest
    const longestText = longestInc
      ? `${fmtDuration(longestInc.duration_minutes)} <span style="color:var(--muted);font-size:0.75rem">${fmtDate(longestInc.opened_at)}</span>`
      : '—'
    const lastInc = row.last
    const lastAttr = lastInc ? ` title="${escapeHtml(lastInc.title)}"` : ''
    const spark = buildSparkline(row.allIncidents)
    const dotClass = row.affected ? 'degraded' : 'operational'

    return `<tr onclick="window.location='company.html?id=${companyId}'">
      <td class="col-rank">${idx + 1}</td>
      <td><div class="col-company">
        <img src="${logo}" alt="${name}" onerror="this.style.display='none'">
        <strong>${name}</strong>
      </div></td>
      <td>${productName}</td>
      <td><span class="badge badge-${category}">${escapeHtml(categoryLabel(row.product.category))}</span></td>
      <td class="col-uptime ${cls}">${fmtUptime(row.uptime)}</td>
      <td class="mono-cell">${row.incidents.length}</td>
      <td class="mono-cell">${fmtDuration(row.downtimeMinutes)}</td>
      <td class="mono-cell">${fmtDuration(row.mttr)}</td>
      <td class="mono-cell">${longestText}</td>
      <td class="mono-cell"${lastAttr}>${lastInc ? fmtRelative(lastInc.opened_at) : '—'}</td>
      <td>${spark}</td>
      <td><span class="status-dot ${dotClass}"></span></td>
    </tr>`
  }).join('')

  // Highlight sorted column header
  document.querySelectorAll('thead th[data-col]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc')
    if (th.dataset.col === _state.sortCol) {
      th.classList.add(_state.sortDir === 'desc' ? 'sort-desc' : 'sort-asc')
    }
  })
}

function updateSummary (rows, days) {
  const filtered = filterRows(rows)
  // Exclude never-scraped rows: they have no real incident/uptime figures.
  const withData = filtered.filter(r => !r.noData)
  const totalInc = withData.reduce((s, r) => s + r.incidents.length, 0)
  const totalDt = withData.reduce((s, r) => s + r.downtimeMinutes, 0)
  const byUptime = [...withData].sort((a, b) => b.uptime - a.uptime)

  document.getElementById('stat-total-incidents').textContent = totalInc
  document.getElementById('stat-total-downtime').textContent = fmtDuration(totalDt)

  if (byUptime.length) {
    const best = byUptime[0]
    const worst = byUptime[byUptime.length - 1]
    document.getElementById('stat-most-reliable').innerHTML =
      `<span style="color:var(--green)">${escapeHtml(best.company.name)} ${escapeHtml(best.product.name)}</span> <span class="mono-cell" style="font-size:0.8rem">${fmtUptime(best.uptime)}</span>`
    document.getElementById('stat-least-reliable').innerHTML =
      `<span style="color:var(--red)">${escapeHtml(worst.company.name)} ${escapeHtml(worst.product.name)}</span> <span class="mono-cell" style="font-size:0.8rem">${fmtUptime(worst.uptime)}</span>`
  } else {
    document.getElementById('stat-most-reliable').textContent = '—'
    document.getElementById('stat-least-reliable').textContent = '—'
  }
}

function initLeaderboard () {
  // Category tabs
  document.getElementById('cat-tabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-cat]')
    if (!tab) return
    document.querySelectorAll('#cat-tabs .tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    _state.cat = tab.dataset.cat
    renderLeaderboard()
  })

  // Range tabs
  document.getElementById('range-tabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-range]')
    if (!tab) return
    document.querySelectorAll('#range-tabs .tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    _state.days = parseInt(tab.dataset.range)
    renderLeaderboard()
  })

  // Sort dropdown
  document.getElementById('sort-select').addEventListener('change', e => {
    _state.sortCol = e.target.value
    renderLeaderboard()
  })

  // Column header click to sort
  document.querySelectorAll('thead th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col
      if (_state.sortCol === col) {
        _state.sortDir = _state.sortDir === 'desc' ? 'asc' : 'desc'
      } else {
        _state.sortCol = col
        _state.sortDir = 'desc'
      }
      renderLeaderboard()
    })
  })
}

// ---------------------------------------------------------------------------
// Company detail page
// ---------------------------------------------------------------------------

function getCompanyId () {
  return new URLSearchParams(window.location.search).get('id')
}

function buildCalendar (productIncidents, label) {
  const days = 90
  const now = new Date()

  // day buckets: index 0 = today, 89 = 89 days ago
  const buckets = new Array(days).fill(null).map(() => ({ worst: null, incidents: [] }))

  for (const inc of productIncidents) {
    const start = new Date(inc.opened_at)
    const dayIdx = Math.floor((now - start) / 86_400_000)
    if (dayIdx >= 0 && dayIdx < days) {
      buckets[dayIdx].incidents.push(inc)
      const sev = inc.raw_severity
      const rank = { major_outage: 4, partial_outage: 3, degraded_performance: 2, operational: 1 }
      if (!buckets[dayIdx].worst || rank[sev] > rank[buckets[dayIdx].worst]) {
        buckets[dayIdx].worst = sev
      }
    }
  }

  const cells = buckets.map((b, i) => {
    const date = new Date(now)
    date.setDate(date.getDate() - i)
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    let cls = 'ok'
    let titleText = dateStr + ': No incidents'
    if (b.worst === 'degraded_performance') { cls = 'degraded'; titleText = dateStr + ': Degraded performance' }
    else if (b.worst === 'partial_outage') { cls = 'partial'; titleText = dateStr + ': Partial outage' }
    else if (b.worst === 'major_outage') { cls = 'major'; titleText = dateStr + ': Major outage' }
    if (b.incidents.length) titleText += ` (${b.incidents.length} incident${b.incidents.length > 1 ? 's' : ''})`
    return `<div class="cal-cell ${cls}" title="${titleText}"></div>`
  }).join('')

  return `<div class="calendar-section">
    <div class="calendar-label">${label}</div>
    <div class="calendar-grid">${cells}</div>
  </div>`
}

function buildTimeline (productsData, days, colors) {
  const svgW = 800
  const svgH = 140
  const padL = 45
  const padR = 16
  const padT = 12
  const padB = 28
  const chartW = svgW - padL - padR
  const chartH = svgH - padT - padB

  const now = Date.now()
  const cutoff = days === 0 ? now - 90 * 86_400_000 : now - days * 86_400_000
  const span = now - cutoff

  // Y axis guides
  const yLevels = [100, 99.9, 99, 95]
  const yGuides = yLevels.map(pct => {
    const y = padT + chartH - ((pct - 94) / 6) * chartH
    return `<line x1="${padL}" y1="${y}" x2="${padL + chartW}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>
      <text x="${padL - 4}" y="${y + 4}" text-anchor="end" fill="var(--muted)" font-size="9">${pct}%</text>`
  }).join('')

  // X axis ticks (every 7 days)
  const tickInterval = 7 * 86_400_000
  let xTicks = ''
  for (let t = cutoff; t <= now; t += tickInterval) {
    const x = padL + ((t - cutoff) / span) * chartW
    const d = new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    xTicks += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + chartH}" stroke="var(--border)" stroke-width="0.5"/>
      <text x="${x}" y="${svgH - 6}" text-anchor="middle" fill="var(--muted)" font-size="9">${d}</text>`
  }

  // Lines per product
  const lines = productsData.map(({ product, allIncidents }, i) => {
    const inRange = allIncidents
      .filter(inc => new Date(inc.opened_at).getTime() >= cutoff)
      .sort((a, b) => new Date(a.opened_at) - new Date(b.opened_at))

    const color = colors[i % colors.length]

    // Build path: starts at 100%, drops at each incident start, recovers at resolve
    const events = []
    for (const inc of inRange) {
      events.push({ t: new Date(inc.opened_at).getTime(), type: 'start', dur: inc.duration_minutes })
      if (inc.resolved_at) {
        events.push({ t: new Date(inc.resolved_at).getTime(), type: 'end', dur: inc.duration_minutes })
      }
    }
    events.sort((a, b) => a.t - b.t)

    let cumDowntime = 0
    let pts = [`${padL},${padT}`]
    const totalPeriod = span / 60_000

    for (const ev of events) {
      const x = padL + ((ev.t - cutoff) / span) * chartW
      if (ev.type === 'start') {
        const upPct = Math.max(94, 100 - (cumDowntime / totalPeriod) * 100)
        const y = padT + chartH - ((upPct - 94) / 6) * chartH
        pts.push(`${x},${y}`)
        // drop
        cumDowntime += ev.dur ?? 30
        const newPct = Math.max(94, 100 - (cumDowntime / totalPeriod) * 100)
        const y2 = padT + chartH - ((newPct - 94) / 6) * chartH
        pts.push(`${x},${y2}`)
      } else {
        const upPct = Math.max(94, 100 - (cumDowntime / totalPeriod) * 100)
        const y = padT + chartH - ((upPct - 94) / 6) * chartH
        pts.push(`${x},${y}`)
      }
    }

    // Endpoint
    const finalPct = Math.max(94, 100 - (cumDowntime / totalPeriod) * 100)
    const finalY = padT + chartH - ((finalPct - 94) / 6) * chartH
    pts.push(`${padL + chartW},${finalY}`)

    const polyline = `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5"/>`
    return { polyline, color, name: product.name }
  })

  const legend = lines.map(l =>
    `<span style="color:${l.color}">─ ${l.name}</span>`
  ).join('  ')

  return `<div style="overflow-x:auto">
    <svg viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg" style="min-width:400px">
      ${yGuides}${xTicks}
      ${lines.map(l => l.polyline).join('')}
    </svg>
  </div>
  <div style="padding:6px 16px 12px;font-size:0.78rem;color:var(--muted)">${legend}</div>`
}

const PRODUCT_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#c270e5', '#f78166']

function renderCompanyPage (company, file, days) {
  document.title = `${company.name} — AI Status Leaderboard`

  // Header
  const allIncidents = file.incidents
  const allStats = company.products.map(p => computeProductStats(p, allIncidents, days))
  const totalDt = allStats.reduce((s, r) => s + r.downtimeMinutes, 0)
  const noData = !file.last_scraped
  const overallUptime = uptimePct(totalDt, days)
  const uptimeDisplay = noData
    ? '<span style="color:var(--muted)">No data</span>'
    : `<span class="${uptimeClass(overallUptime)}">${fmtUptime(overallUptime)}</span>`
  const anyAffected = allStats.some(s => s.affected)

  document.getElementById('company-header').innerHTML = `
    <img src="${escapeHtml(company.logo_url)}" alt="${escapeHtml(company.name)}" onerror="this.style.display='none'">
    <div>
      <h1>${escapeHtml(company.name)}</h1>
      <a class="ext" href="${safeUrl(company.status_page_url)}" target="_blank">Official status page ↗</a>
    </div>
    <div style="margin-left:auto;text-align:right">
      <div class="overall-uptime">${uptimeDisplay}</div>
      <div style="color:var(--muted);font-size:0.8rem">overall uptime (${days === 0 ? 'all time' : days + ' days'})</div>
      ${noData
        ? '<div style="margin-top:4px"><span class="status-dot" style="background:var(--muted)"></span> <span style="color:var(--muted)">Not yet monitored</span></div>'
        : `<div style="margin-top:4px"><span class="status-dot ${anyAffected ? 'degraded' : 'operational'}"></span> ${anyAffected ? '<span style="color:var(--red)">Degraded</span>' : '<span style="color:var(--green)">Operational</span>'}</div>`}
    </div>`

  // Product cards
  document.getElementById('product-cards').innerHTML = allStats.map(s => `
    <div class="product-card">
      <div class="card-title">
        ${escapeHtml(s.product.name)}
        <span class="badge badge-${escapeHtml(s.product.category)}">${escapeHtml(categoryLabel(s.product.category))}</span>
        <span class="status-dot ${s.affected ? 'degraded' : 'operational'}" style="margin-left:auto"></span>
      </div>
      <div class="card-uptime ${uptimeClass(s.uptime)}">${fmtUptime(s.uptime)}</div>
      <div class="card-meta">
        <span>${s.incidents.length} incident${s.incidents.length !== 1 ? 's' : ''}</span>
        <span>${fmtDuration(s.downtimeMinutes)} downtime</span>
        <span>MTTR ${fmtDuration(s.mttr)}</span>
      </div>
    </div>`).join('')

  // Calendars (always 90-day window)
  const calSection = document.getElementById('calendars-section')
  calSection.innerHTML = '<div class="section-title">Uptime Calendar (90 days)</div>'
  for (const product of company.products) {
    const productIncidents = allIncidents.filter(i => i.product_id === product.id)
    calSection.innerHTML += buildCalendar(productIncidents, product.name)
  }

  // Timeline
  document.getElementById('timeline-wrap').innerHTML = buildTimeline(
    company.products.map(p => ({
      product: p,
      allIncidents: allIncidents.filter(i => i.product_id === p.id)
    })),
    days,
    PRODUCT_COLORS
  )

  // Incident table
  const inPeriod = allStats.flatMap(s => s.incidents)
    .sort((a, b) => new Date(b.opened_at) - new Date(a.opened_at))

  if (!inPeriod.length) {
    document.getElementById('incident-tbody').innerHTML =
      '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">No incidents in this period</td></tr>'
    return
  }

  document.getElementById('incident-tbody').innerHTML = inPeriod.map(inc => {
    const product = company.products.find(p => p.id === inc.product_id)
    const durText = inc.resolved_at
      ? fmtDuration(inc.duration_minutes)
      : `<span class="ongoing-badge">Ongoing</span>`
    return `<tr>
      <td class="mono-cell">${fmtDate(inc.opened_at)}</td>
      <td>${escapeHtml(product ? product.name : inc.product_id)}</td>
      <td>${escapeHtml(inc.title)}</td>
      <td class="mono-cell">${durText}</td>
      <td><span class="severity-badge sev-${escapeHtml(inc.raw_severity)}">${escapeHtml(inc.raw_severity.replace(/_/g, ' '))}</span></td>
      <td><a href="${safeUrl(inc.status_page_incident_url)}" target="_blank" style="color:var(--muted)">↗</a></td>
    </tr>`
  }).join('')
}

function initCompanyPage (companies, incidentFiles) {
  const companyId = getCompanyId()
  const company = companies.find(c => c.id === companyId)
  if (!company) {
    document.getElementById('company-header').innerHTML =
      '<p style="color:var(--red)">Company not found</p>'
    return
  }

  const file = incidentFiles.find(f => f.company_id === companyId) || {
    company_id: companyId, last_scraped: null, scrape_success: false, incidents: []
  }

  if (file.last_scraped) {
    document.getElementById('last-scraped').textContent =
      'Last scraped: ' + fmtRelative(file.last_scraped)
  }

  let days = 30
  renderCompanyPage(company, file, days)

  document.getElementById('range-tabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-range]')
    if (!tab) return
    document.querySelectorAll('#range-tabs .tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    days = parseInt(tab.dataset.range)
    renderCompanyPage(company, file, days)
  })

  // Incident table sorting
  document.querySelectorAll('#incident-table thead th[data-col]').forEach(th => {
    th.style.cursor = 'pointer'
    th.addEventListener('click', () => {
      const col = th.dataset.col
      const tbody = document.getElementById('incident-tbody')
      const rows = [...tbody.querySelectorAll('tr')]
      const asc = th.classList.toggle('sort-asc')
      document.querySelectorAll('#incident-table thead th').forEach(t => {
        if (t !== th) { t.classList.remove('sort-asc', 'sort-desc') }
      })
      rows.sort((a, b) => {
        const ai = a.cells[['date', 'product', 'title', 'duration', 'severity'].indexOf(col)]?.textContent || ''
        const bi = b.cells[['date', 'product', 'title', 'duration', 'severity'].indexOf(col)]?.textContent || ''
        return asc ? ai.localeCompare(bi) : bi.localeCompare(ai)
      })
      rows.forEach(r => tbody.appendChild(r))
    })
  })
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

(async function () {
  try {
    const { companies, incidentFiles } = await loadAll()
    _state.companies = companies
    _state.incidentFiles = incidentFiles

    const isCompanyPage = document.getElementById('incident-table') !== null

    if (isCompanyPage) {
      initCompanyPage(companies, incidentFiles)
    } else {
      initLeaderboard()
      renderLeaderboard()
    }
  } catch (err) {
    console.error('Failed to load data:', err)
    const body = document.getElementById('leaderboard-body') || document.getElementById('incident-tbody')
    if (body) {
      body.innerHTML = `<tr><td colspan="12" style="text-align:center;color:var(--red);padding:24px">
        Failed to load data. ${err.message}
      </td></tr>`
    }
  }
}())
