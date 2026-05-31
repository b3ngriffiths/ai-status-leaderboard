# AI Status Leaderboard

A static, open-source leaderboard tracking the reliability of AI services. Incident data is scraped from public status pages every 6 hours via GitHub Actions, stored as JSON in this repo, and rendered as a GitHub Pages site. No backend, no database.

**Live site:** `https://b3ngriffiths.github.io/ai-status-leaderboard`

> **Self-reporting caveat:** All data comes from companies' own status pages. Incidents that aren't publicly reported won't appear here. Uptime figures reflect what each company acknowledges, not independently verified availability.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  GitHub Actions (every 6 hours)                                 │
│                                                                 │
│   scraper/index.ts                                              │
│     ├── atlassian.ts   → /api/v2/summary.json + incidents.json  │
│     ├── incident-io.ts → /api/widget + /api/v1/incidents        │
│     ├── betterstack.ts → BetterStack Status API                 │
│     └── feed.ts        → /history.atom (Atom/RSS feed)          │
│                                                                 │
│   Merges fresh incidents into existing JSON, commits & deploys  │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│  site/data/                 │
│    companies.json           │  Company + product definitions
│    incidents/               │
│      openai.json            │  One file per company
│      anthropic.json         │
│      ...                    │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│  site/ (GitHub Pages)       │
│    index.html  → leaderboard│
│    company.html → detail    │
│    app.js  ← all logic      │  Fetches JSON at runtime, renders
└─────────────────────────────┘
```

## Data flow

1. **Scrape** — each company's status page is fetched; raw incidents are normalised into a common `Incident` shape with `opened_at`, `resolved_at`, `raw_severity`, and `product_id`.
2. **Merge** — fresh incidents are merged into the existing file: new ones are appended, resolved ones get their `resolved_at` stamped, mutable fields (`title`, `raw_severity`) are refreshed.
3. **Commit** — changed JSON files are committed directly to `main` with `[skip ci]` to avoid triggering a TypeScript build.
4. **Deploy** — GitHub Pages serves the `site/` directory. `app.js` fetches all JSON at page load and computes uptime, MTTR, and downtime entirely in the browser.

Uptime is calculated as:

```
uptime % = (1 − total_downtime_minutes / period_minutes) × 100
```

Concurrent incidents are merged into non-overlapping intervals before summing to avoid double-counting. For "all time", the window is anchored to the oldest known incident, floored at 30 days.

---

## Supported status page types

| `page_type` | Platform | How scraped |
|---|---|---|
| `atlassian` | Atlassian Statuspage | REST API v2 |
| `incident_io` | incident.io | Widget API + paginated history |
| `betterstack` | BetterStack | Status API with pagination |
| `feed` | Atom feed | `/history.atom` parsed with regex |
| `custom` | Anything else | Tracked in UI as "No data"; no scraper |

---

## Running locally

```bash
npm install

# Probe a status page to find component IDs
npm run discover -- https://status.openai.com

# Scrape all companies (writes to site/data/incidents/)
npm run scrape

# Dry run — no files written
npm run scrape:dry

# Full backfill — paginate entire incident history
npm run scrape:backfill

# Validate all data files
npm run validate

# Serve the site
npm run dev   # → http://localhost:3000
```

---

## Adding a company

**1.** Add an entry to `site/data/companies.json`:

```json
{
  "id": "company-slug",
  "name": "Company Name",
  "slug": "company-slug",
  "status_page_url": "https://status.company.com",
  "page_type": "atlassian",
  "logo_url": "https://logo.clearbit.com/company.com",
  "products": [
    {
      "id": "company-api",
      "name": "API",
      "category": "ai-api",
      "component_ids": ["abc123"]
    }
  ]
}
```

Run `npm run discover -- https://status.company.com` to find real component IDs.

For companies where the whole status page maps to one product, use `"component_ids": [], "title_keywords": [], "rollup": true` — all incidents roll up to that product.

For pages covering many services where you only want specific incidents (e.g. GitHub → Copilot only), set `"title_keywords": ["Copilot"]` on that product — unmatched incidents are dropped.

**2.** Create a stub incidents file:

```bash
echo '{"company_id":"company-slug","last_scraped":null,"scrape_success":false,"incidents":[]}' \
  > site/data/incidents/company-slug.json
```

**3.** Run `npm run validate` — all checks must pass before opening a PR.

---

## Data schema

### `companies.json` — product config

| Field | Description |
|---|---|
| `id` / `slug` | Unique identifier used in URLs and file names |
| `page_type` | See table above |
| `products[].category` | `ai-api` · `ai-chat` · `ai-code` · `ai-image` · `ai-other` |
| `products[].component_ids` | Status page component IDs that belong to this product |
| `products[].title_keywords` | Match incident titles (case-insensitive); empty array = catch-all |
| `products[].rollup` | `true` → one record per incident regardless of component count |
| `title_skip` | Incident title substrings to drop entirely (e.g. `"FedRAMP"`) |

### `incidents/[company].json` — scraped data

| Field | Description |
|---|---|
| `incidents[].id` | `{incident_id}-{product_id}` — stable across scrapes |
| `incidents[].opened_at` | ISO 8601 start time |
| `incidents[].resolved_at` | ISO 8601 end time, or `null` if ongoing |
| `incidents[].duration_minutes` | `null` if ongoing or timestamps are malformed |
| `incidents[].raw_severity` | `degraded_performance` · `partial_outage` · `major_outage` · `operational` |

---

## Contributing

PRs welcome. Run `npm run validate` before submitting. Please only add companies with publicly accessible status pages.
