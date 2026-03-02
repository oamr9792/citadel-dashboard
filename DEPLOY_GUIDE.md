# Reputation Citadel Dashboard v2 — Deployment Guide
## Phase 2: Real API Integrations

---

## What Changed from Phase 1

Phase 1 was the UI shell. Phase 2 adds real backend functions:
- "Generate Report" now ACTUALLY calls Google Sheets, DataForSEO, and Claude
- Reports are stored in Cloudflare KV and served via share links
- Share links render real report HTML for clients
- PDF download works via browser print
- Logo is auto-uploaded to KV for embedding in reports

---

## DEPLOYMENT: Two Options

### Option A: Wrangler CLI (Recommended — deploys functions too)

This is the recommended approach because Cloudflare Pages **direct upload doesn't support Functions**.
Functions (the `/api/*` and `/share/*` backend) only deploy via Git or Wrangler CLI.

```bash
# 1. Install Node.js if you don't have it (https://nodejs.org)

# 2. Unzip the project
unzip citadel-dashboard-v2.zip
cd citadel-dashboard-v2

# 3. Install wrangler
npm install

# 4. Log into Cloudflare
npx wrangler login

# 5. Deploy
npx wrangler pages deploy public --project-name citadel-dashboard
```

Wrangler will auto-detect the `functions/` folder and deploy them as Pages Functions.

### Option B: GitHub (Set Once, Auto-Deploys After)

1. Create a GitHub repo (private is fine)
2. Push this entire project folder to it
3. In Cloudflare dashboard: Workers & Pages → Create → Pages → Connect to Git
4. Select the repo
5. Set build output directory to: `public`
6. Deploy

Future changes: just push to GitHub and Cloudflare auto-deploys.

---

## REQUIRED SETUP (Do This After First Deploy)

### Step 1: Create KV Namespace

1. Cloudflare dashboard → **Workers & Pages** → **KV**
2. Click **"Create a namespace"**
3. Name: `CITADEL_KV`
4. Copy the **Namespace ID**

### Step 2: Bind KV to Your Project

1. Go to your **citadel-dashboard** project → **Settings** → **Functions**
2. Scroll to **"KV namespace bindings"**
3. Add binding:
   - Variable name: `CITADEL_KV`
   - KV namespace: select `CITADEL_KV`
4. **Save**

### Step 3: Add Environment Variables (Secrets)

1. Same project → **Settings** → **Environment variables**
2. Click **"Add variable"** for each (select **"Encrypt"** for sensitive ones):

| Variable Name | Value | Encrypt? |
|---|---|---|
| `ADMIN_PASSWORD` | Your dashboard password | Yes |
| `ANTHROPIC_API_KEY` | `sk-ant-api03-...` | Yes |
| `DATAFORSEO_LOGIN` | Your DataForSEO email/login | Yes |
| `DATAFORSEO_PASSWORD` | Your DataForSEO API password | Yes |

3. Click **"Save and deploy"**

**IMPORTANT:** Set these for BOTH "Production" and "Preview" environments, or select "All environments" if that option appears.

### Step 4: Redeploy

After adding bindings and variables, redeploy for them to take effect:

```bash
npx wrangler pages deploy public --project-name citadel-dashboard
```

---

## HOW IT WORKS NOW

### When You Click "Generate Report":

```
Frontend (your browser)
    │
    ├─ POST /api/generate
    │     │
    │     ├─ 1. Fetches Google Sheet CSV (public export URL)
    │     ├─ 2. Calls DataForSEO LLM Responses API (for LLM reports)
    │     ├─ 3. Sends all data to Claude API with system prompt
    │     ├─ 4. Claude returns complete branded HTML report
    │     ├─ 5. HTML stored in Cloudflare KV
    │     └─ 6. Returns report metadata to frontend
    │
    └─ Report appears in your Reports list
```

### When a Client Opens a Share Link:

```
Client visits: https://your-site.pages.dev/share/abc123def456...
    │
    └─ GET /share/:token
          ├─ Looks up token → report ID in KV
          ├─ Fetches report HTML from KV
          └─ Serves it directly — client sees the branded report
```

### PDF Download:

Opens the report HTML in a new tab, then triggers the browser's Print dialog.
The client can "Save as PDF" from there. The report is designed to be print-friendly.

---

## REPORT TYPES & DATA FLOW

| Report Type | Data Source | API Calls |
|---|---|---|
| **SERP & ORM** | Google Sheet CSV | Google Sheets (public export) → Claude |
| **Social Media** | Keywords + Claude analysis | Claude only |
| **LLM Intelligence** | DataForSEO LLM Responses API | DataForSEO (ChatGPT, Gemini, Claude) → Claude |
| **Executive Summary** | All of the above | Google Sheets + DataForSEO + Claude |

---

## GOOGLE SHEET REQUIREMENTS

For SERP reports to pull data correctly:

1. Sheet must be shared as **"Anyone with the link → Viewer"**
2. The script auto-fetches tabs at gid 0, 1, 2, 3
3. It identifies SERP vs Content tabs by column headers
4. Expected columns: Rank, Movement, Sentiment, ★ Owned, Title, URL, Display URL, Meta Description, SERP Feature, Keyword, Fetched At

---

## COST ESTIMATES

| Service | Cost Per Report | Notes |
|---|---|---|
| Claude API | ~$0.10-0.30 | Sonnet 4, ~16K output tokens |
| DataForSEO | ~$0.03-0.10 per LLM query | 3 platforms × 3 queries = ~9 calls |
| Cloudflare KV | Free tier: 100K reads/day | More than enough |
| Cloudflare Pages | Free | Including custom domain + SSL |

**Estimated cost per full report set (all 4 types): ~$1-2**

---

## FILE STRUCTURE

```
citadel-dashboard-v2/
├── public/                    ← Static files (frontend)
│   ├── index.html             ← The dashboard SPA
│   └── logo.png               ← Reputation Citadel logo
├── functions/                 ← Cloudflare Pages Functions (backend)
│   └── api/
│       ├── _middleware.js     ← CORS handler for all /api/* routes
│       ├── generate.js        ← POST /api/generate — main report engine
│       ├── reports.js         ← GET/DELETE /api/reports — list/delete
│       ├── report-html.js     ← GET /api/report-html — fetch report content
│       └── logo.js            ← POST/GET /api/logo — logo management
│   └── share/
│       └── [[token]].js       ← GET /share/:token — serve reports to clients
├── wrangler.toml              ← Cloudflare config
├── package.json               ← Dependencies
└── DEPLOY_GUIDE.md            ← This file
```

---

## TROUBLESHOOTING

| Problem | Cause | Fix |
|---|---|---|
| "Unauthorized" on generate | ADMIN_PASSWORD env var not set | Add it in Cloudflare Settings → Environment variables |
| "Anthropic API key not configured" | Missing env var | Add ANTHROPIC_API_KEY in Cloudflare dashboard |
| Google Sheet data empty | Sheet not shared publicly | Share → Anyone with link → Viewer |
| DataForSEO errors | Wrong credentials or no balance | Check login/password, check account balance |
| Share link shows "Report not found" | KV not bound | Check Settings → Functions → KV bindings |
| Functions not working at all | Deployed via upload instead of wrangler | Redeploy via `npx wrangler pages deploy public` |
| Report HTML looks wrong | Claude output wrapped in markdown | The backend strips fences automatically |

---

## NEXT: Phase 3 (Monthly Auto-Generation)

In a future session we'll add:
- Cloudflare Cron Triggers to auto-generate all client reports monthly
- Email notifications via Cloudflare Email Workers
- Trend tracking (compare this month's report vs last month's)
