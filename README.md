# AI Status Leaderboard

A fully static, open-source leaderboard tracking the reliability of AI company products and services. Data is scraped from public status pages via GitHub Actions, stored as JSON in this repo, and visualised as an interactive GitHub Pages site. No backend, no database, no external services — everything lives here.

**Live site:** `https://b3ngriffiths.github.io/ai-status-leaderboard`

---

## How data is collected

A GitHub Actions workflow runs every 6 hours and fetches incident data from each company's public Atlassian Statuspage API (`/api/v2/summary.json` and `/api/v2/incidents.json`). Results are merged into the existing JSON files and committed to the repo. **This is passive collection from self-reported status pages — it is not active uptime monitoring.**

> ⚠️ **Self-reporting caveat:** All data comes from the companies' own status pages. Incidents that a company does not report (or under-reports) will not appear here. Uptime figures reflect what each company publicly acknowledges, not independently verified availability.

---

## How uptime is calculated

```
uptime % = (1 - total_downtime_minutes / period_minutes) × 100

period_minutes:
  7 days  = 10,080
  30 days = 43,200
  90 days = 129,600
```

Only incidents whose `opened_at` falls within the selected period are counted. For ongoing incidents (no `resolved_at`), downtime accrues until the current time. Calculations happen in the browser at render time — no pre-computed uptime values are stored.

---

## Running locally

```bash
# Install dependencies
npm install

# Discover component IDs for a status page (run this before first scrape)
npm run discover -- https://status.openai.com
npm run discover -- https://status.anthropic.com

# Run the scraper
npm run scrape

# Dry run (no files written)
npm run scrape:dry

# Validate data files
npm run validate

# Serve the site locally
npm run dev
# → http://localhost:3000
```

---

## Adding a new company

**1. Discover component IDs**

```bash
npm run discover -- https://status.COMPANY.com
```

This prints all component names and their IDs. Identify which components map to which products.

**2. Add the company to `data/companies.json`**

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
      "component_ids": ["real-component-id-from-step-1"]
    }
  ]
}
```

**3. Create an empty incidents file**

```bash
cat > data/incidents/company-slug.json << 'EOF'
{
  "company_id": "company-slug",
  "last_scraped": "1970-01-01T00:00:00Z",
  "scrape_success": false,
  "incidents": []
}
EOF
```

**4. Run the scraper**

```bash
npm run scrape
```

**5. Validate**

```bash
npm run validate
```

**6. Open a PR** — the site updates automatically when merged to `main`.

---

## Data format

### `data/companies.json`

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier (slug) |
| `name` | string | Display name |
| `status_page_url` | string | Root URL of the Atlassian Statuspage |
| `page_type` | `"atlassian"` | Only Atlassian is supported currently |
| `products[].id` | string | Unique product identifier |
| `products[].category` | string | `ai-api` / `ai-chat` / `ai-code` / `ai-image` / `ai-other` |
| `products[].component_ids` | string[] | Atlassian component IDs that map to this product |

### `data/incidents/[company].json`

| Field | Type | Description |
|---|---|---|
| `company_id` | string | Matches `companies.json` id |
| `last_scraped` | ISO 8601 | Timestamp of last scrape attempt |
| `scrape_success` | boolean | Whether the last scrape succeeded |
| `incidents[].id` | string | `{atlassian_incident_id}-{component_id}` |
| `incidents[].opened_at` | ISO 8601 | When the incident started |
| `incidents[].resolved_at` | ISO 8601 \| null | Null if ongoing |
| `incidents[].duration_minutes` | number \| null | Null if ongoing |
| `incidents[].raw_severity` | string | As reported by the status page |

---

## Contributing

1. Fork the repo
2. Add a company following the steps above
3. Run `npm run validate` — all checks must pass
4. Open a PR with a brief description of what you added

Issues and PRs welcome. Please don't add companies whose status pages aren't public.
