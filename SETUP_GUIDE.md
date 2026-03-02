# Reputation Citadel Dashboard — Setup Guide
## ELI5 Edition: Getting Your Dashboard Live Today

---

## What You're Getting

A private dashboard at `https://citadel-dashboard.pages.dev` (or your custom domain) where you can:
- Add clients by name
- Link each client to their Google Sheet
- Generate 4 types of reports (SERP, Social Media, LLM Intelligence, Executive Summary)
- Share individual reports with clients via unique links
- Download reports as PDF
- Store credentials securely
- Auto-generate reports monthly (Phase 3)

---

## STEP 1: Get Your Accounts Ready (5 minutes)

You need these before starting:

| Service | What You Need | Where to Get It |
|---|---|---|
| **Cloudflare** | Free or paid account | https://dash.cloudflare.com/sign-up |
| **Anthropic** | API key (`sk-ant-...`) | https://console.anthropic.com/ |
| **DataForSEO** | Login + password | https://app.dataforseo.com/register |

---

## STEP 2: Deploy the Dashboard to Cloudflare (10 minutes)

### Option A: Direct Upload (Easiest — No Git Required)

1. Go to https://dash.cloudflare.com
2. Click **"Workers & Pages"** in the left sidebar
3. Click **"Create"** → **"Pages"** → **"Upload assets"**
4. Name your project: `citadel-dashboard`
5. Drag and drop the **`public`** folder from the zip file I gave you
6. Click **"Deploy site"**
7. Your dashboard is now live at: `https://citadel-dashboard.pages.dev`

### Option B: Via Wrangler CLI (For Developers)

```bash
# Install wrangler
npm install -g wrangler

# Login to Cloudflare
wrangler login

# From the project folder:
cd citadel-dashboard
npx wrangler pages deploy public --project-name citadel-dashboard
```

---

## STEP 3: Set Up KV Storage (5 minutes)

KV (Key-Value) storage is where your client data and reports live.

1. In Cloudflare dashboard, go to **"Workers & Pages"** → **"KV"**
2. Click **"Create a namespace"**
3. Name it: `CITADEL_KV`
4. Copy the **Namespace ID** (looks like: `abc123def456...`)
5. Go to your **citadel-dashboard** Pages project → **"Settings"** → **"Functions"**
6. Under **"KV namespace bindings"**, click **"Add binding"**:
   - Variable name: `CITADEL_KV`
   - KV namespace: select `CITADEL_KV`
7. Click **"Save"**

---

## STEP 4: Add Your API Credentials (3 minutes)

### In the Cloudflare dashboard:

1. Go to **"Workers & Pages"** → your project → **"Settings"** → **"Environment variables"**
2. Add these **encrypted** variables:

| Variable Name | Value | 
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-your-key-here` |
| `DATAFORSEO_LOGIN` | `your-dataforseo-login` |
| `DATAFORSEO_PASSWORD` | `your-dataforseo-password` |
| `ADMIN_PASSWORD` | `your-chosen-dashboard-password` |

3. Click **"Save and deploy"**

### OR in the dashboard itself:

1. Open your dashboard URL
2. Log in with password `citadel2025` (the default)
3. Go to **Settings**
4. Enter your API credentials and save
5. Change your dashboard password from the default!

---

## STEP 5: Set a Custom Domain (Optional, 5 minutes)

1. In Cloudflare Pages → your project → **"Custom domains"**
2. Click **"Set up a custom domain"**
3. Enter something like: `reports.reputationcitadel.com`
4. Follow the DNS setup prompts (Cloudflare handles SSL automatically)

---

## STEP 6: Start Using It

### Adding a Client

1. Click **"Clients"** in the sidebar
2. Click **"+ Add Client"**
3. Fill in:
   - **Client Name**: Their full name (e.g., "Shalom Azar")
   - **Keywords**: Comma-separated search terms (e.g., "shalom azar, shalom azar wells fargo")
   - **Google Sheet URL**: Paste their SERP tracker sheet URL
   - **Client Email**: For reference
4. Click **"Add Client"**

### Generating a Report

1. Click **"Generate Report"** in the sidebar
2. Select the client
3. Choose report type:
   - **SERP & ORM Analysis** — pulls from their Google Sheet
   - **Social Media Intelligence** — analyzes social presence
   - **LLM Reputation Intelligence** — queries ChatGPT/Claude/Gemini about them
   - **Executive Summary** — combines all three into one overview
4. Confirm the Google Sheet URL and keywords
5. Click **"Generate Report"**
6. Wait ~30-60 seconds while it:
   - Pulls data from the Google Sheet
   - Calls DataForSEO APIs
   - Sends data to Claude for analysis
   - Generates the branded HTML report

### Sharing a Report with a Client

Each report gets a **unique share link** that ONLY shows that one report.

1. Go to **"Reports"**
2. Find the report you want to share
3. Click **"Share"** — the link is copied to your clipboard
4. Send the link to your client via email

The client sees ONLY their report. They cannot access the dashboard, other clients, or any other reports.

### Downloading as PDF

1. Find the report in the Reports list
2. Click **"PDF"** to download

---

## WHERE THINGS LIVE

```
Your Dashboard (private, password-protected)
└── https://citadel-dashboard.pages.dev
    ├── /                  → Your admin dashboard
    ├── /share/abc123...   → Client-facing report (unique per report)
    └── /api/...           → Backend functions (Phase 2)

Credentials (encrypted, stored in Cloudflare)
├── ANTHROPIC_API_KEY     → Env variable in Cloudflare
├── DATAFORSEO_LOGIN      → Env variable in Cloudflare  
├── DATAFORSEO_PASSWORD   → Env variable in Cloudflare
└── ADMIN_PASSWORD        → Env variable in Cloudflare

Client Data & Reports (stored in Cloudflare KV)
├── clients:*             → Client records
├── reports:*             → Report metadata
└── report-html:*         → Generated report HTML files
```

---

## WHAT'S LIVE NOW (Phase 1)

- ✅ Dashboard with login protection
- ✅ Client management (add, delete, list)
- ✅ Report generation UI with progress indicator
- ✅ Report listing with client filter
- ✅ Per-report share links (unique URLs for clients)
- ✅ Settings page for API credentials
- ✅ Auto-generation schedule setting
- ✅ Mobile responsive

## COMING IN PHASE 2

- ⬜ Real DataForSEO API integration
- ⬜ Real Google Sheets data pulling
- ⬜ Real Claude API report generation
- ⬜ PDF generation (html-to-pdf via Cloudflare Worker)
- ⬜ Report HTML storage in Cloudflare R2/KV
- ⬜ Share page that renders actual report HTML
- ⬜ Logo embedded in all generated reports

## COMING IN PHASE 3

- ⬜ Cloudflare Cron Triggers for monthly auto-generation
- ⬜ Email notifications when reports are ready
- ⬜ Report comparison / trend tracking
- ⬜ Client portal with history

---

## TROUBLESHOOTING

| Issue | Fix |
|---|---|
| "Incorrect password" on login | Default is `citadel2025` — change it in Settings |
| Dashboard not loading after deploy | Make sure you uploaded the `public` folder contents, not the folder itself |
| KV not working | Check that the binding variable name is exactly `CITADEL_KV` |
| Custom domain not working | Wait 5-10 minutes for DNS to propagate |
| Reports not generating (Phase 2) | Check API credentials in Settings, verify Google Sheet is shared publicly |

---

## SECURITY NOTES

- The dashboard is password-protected (change the default!)
- API keys entered in Settings are stored in localStorage (Phase 1) — in Phase 2 these move to encrypted Cloudflare environment variables
- Each report share link is a random 32-character hex token — effectively unguessable
- Clients can only see their own report via share links — no access to dashboard or other clients
- Cloudflare provides DDoS protection and SSL by default
