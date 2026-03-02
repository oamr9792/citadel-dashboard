// functions/api/generate.js — Phase 2 FINAL with complete project prompts

export async function onRequestPost(context) {
  const { request, env } = context;
  const authHeader = request.headers.get("X-Admin-Password");
  if (authHeader !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { clientId, clientName, type, keywords, sheetUrl, previousReportId, linkedReports } = body;
  if (!clientId || !clientName || !type) return json({ error: "Missing required fields" }, 400);

  try {
    const typeNames = { serp: "SERP & ORM Analysis", social: "Social Media Intelligence", llm: "LLM Reputation Intelligence", executive: "Executive Summary" };
    let dataPayload = "";
    const reportDate = new Date().toISOString().split("T")[0];

    if ((type === "serp" || type === "executive") && sheetUrl) {
      const sheetData = await fetchGoogleSheet(sheetUrl);
      dataPayload += sheetData ? `\n=== GOOGLE SHEET DATA ===\n${sheetData}\n` : `\n=== GOOGLE SHEET DATA ===\nUnable to fetch sheet.\n`;
    }
    if ((type === "llm" || type === "executive") && env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD && keywords) {
      const llmData = await fetchLLMResponses(keywords, clientName, env.DATAFORSEO_LOGIN, env.DATAFORSEO_PASSWORD);
      dataPayload += `\n=== LLM RESPONSES DATA ===\n${JSON.stringify(llmData, null, 2)}\n`;
    }
    if (type === "social" || type === "executive") {
      dataPayload += `\n=== SOCIAL MEDIA ANALYSIS REQUEST ===\nClient: ${clientName}\nKeywords: ${keywords || "N/A"}\nAnalyze social media presence and sentiment for this client.\n`;
    }
    
    // Add linked report URLs for executive summary
    if (type === "executive" && linkedReports) {
      const baseUrl = new URL(request.url).origin;
      let links = "\n=== LINKED REPORTS ===\n";
      links += "The following individual reports have been generated for this client. Include clickable links to each in the relevant section of the executive summary.\n";
      if (linkedReports.serp) links += `SERP Report URL: ${baseUrl}/share/${linkedReports.serp.shareToken}\n`;
      if (linkedReports.llm) links += `LLM Report URL: ${baseUrl}/share/${linkedReports.llm.shareToken}\n`;
      if (linkedReports.social) links += `Social Media Report URL: ${baseUrl}/share/${linkedReports.social.shareToken}\n`;
      links += "For each section (SERP Snapshot, LLM Snapshot, Social Media Snapshot), add a styled link/button that says 'View Full Report →' linking to the corresponding URL above.\n";
      dataPayload += links;
    }
    if (previousReportId) {
      try { const p = await env.CITADEL_KV.get(`report-html:${previousReportId}`); if (p) dataPayload += `\n=== PREVIOUS REPORT ===\n${p.substring(0, 20000)}\n`; } catch {}
    }

    // Get logo - use hosted URL (much more reliable than base64 in KV)
    const logoDataUri = "https://citadel-dashboard.pages.dev/logo.png";

    const systemPrompt = getSystemPrompt(type, logoDataUri);
    const userPrompt = `Client Name: ${clientName}\nReport Type: ${type}\nKeywords: ${keywords || "N/A"}\nReport Date: ${reportDate}\n\n${dataPayload}\n\nIMPORTANT INSTRUCTIONS:\n- Generate the COMPLETE, COMPREHENSIVE HTML report with ALL sections fully populated with real data analysis.\n- Every section must contain detailed analysis — NOT placeholder text, NOT "data unavailable" messages.\n- Parse and analyze ALL the CSV/JSON data provided above. Extract real numbers, real URLs, real rankings.\n- The report MUST include real computed metrics: ownership percentages, sentiment distributions, movement analysis.\n- Tables must be fully populated with actual data rows from the sheet.\n- Do NOT abbreviate, summarize briefly, or skip sections. This is a premium client-facing deliverable.\n- The HTML output should be 15,000-40,000 characters minimum for a thorough report.\n- REPORTING PERIOD: If only one date/snapshot of data is provided, this is the FIRST report — present it as a baseline snapshot of the current state of search results. The period should be labeled as the snapshot date only (e.g., "March 1, 2026").\n- If TWO dates/snapshots are provided, this is a MONTHLY report — compare the current snapshot against the previous month's snapshot. Label the period as "Previous Date — Current Date" and include full trend analysis showing what improved, worsened, or stayed the same.\n- Reports are produced monthly, typically on the 1st of each month.\n\nGenerate the complete HTML report now. Output ONLY the HTML — no markdown fences, no commentary.`;

    if (!env.ANTHROPIC_API_KEY) return json({ error: "Anthropic API key not configured." }, 400);

    let reportHtml = await callClaudeStreaming(env.ANTHROPIC_API_KEY, systemPrompt, userPrompt);
    reportHtml = reportHtml.trim();
    if (reportHtml.startsWith("```")) reportHtml = reportHtml.replace(/^```(?:html)?\n?/, "").replace(/\n?```$/, "");

    const shareToken = genToken();
    const reportId = `r_${Date.now()}`;
    const meta = { id: reportId, clientId, clientName, type, typeName: typeNames[type] || type, keywords: keywords || "", sheetUrl: sheetUrl || "", createdAt: new Date().toISOString(), shareToken, status: "complete" };

    await env.CITADEL_KV.put(`report-html:${reportId}`, reportHtml, { expirationTtl: 31536000 });
    await env.CITADEL_KV.put(`report:${reportId}`, JSON.stringify(meta), { expirationTtl: 31536000 });
    await env.CITADEL_KV.put(`share:${shareToken}`, reportId, { expirationTtl: 31536000 });
    let idx = []; try { const e = await env.CITADEL_KV.get("reports-index"); if (e) idx = JSON.parse(e); } catch {}
    idx.unshift(meta);
    await env.CITADEL_KV.put("reports-index", JSON.stringify(idx));

    return json({ success: true, report: meta });
  } catch (err) { return json({ error: `Generation failed: ${err.message}` }, 500); }
}

// ── Google Sheets ──
async function fetchGoogleSheet(sheetUrl) {
  const m = sheetUrl.match(/\/d\/([a-zA-Z0-9_-]+)/); if (!m) return null;
  const id = m[1], tabs = {};
  
  // Try multiple URL formats — different sheets need different approaches
  const urlFormats = [
    (gid) => `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid}`,
    (gid) => `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`,
  ];

  for (const gid of ["0","1","2","3"]) {
    for (const urlFn of urlFormats) {
      try {
        const r = await fetch(urlFn(gid), { headers: {"User-Agent":"Mozilla/5.0"}, redirect:"follow" });
        if (r.ok) {
          const csv = await r.text();
          if (csv && csv.trim().length > 50 && !csv.includes("<!DOCTYPE")) {
            const fl = csv.split("\n")[0].toLowerCase(); let tn = `Tab_gid${gid}`;
            if (fl.includes("rank")||fl.includes("serp")||fl.includes("keyword")||fl.includes("snapshot")) tn = `SERP_Tracker_gid${gid}`;
            else if (fl.includes("content")||fl.includes("live url")||fl.includes("created")) tn = `Content_Created_gid${gid}`;
            
            // If sheet is very large (>200 rows), filter intelligently
            const lines = csv.split("\n");
            if (lines.length > 200) {
              const header = lines[0];
              // Collect all dates
              const dateRows = {};
              for (let i = 1; i < lines.length; i++) {
                const firstCol = lines[i].split(",")[0].replace(/"/g, "").trim();
                if (firstCol && firstCol.match(/\d/)) {
                  if (!dateRows[firstCol]) dateRows[firstCol] = [];
                  dateRows[firstCol].push(lines[i]);
                }
              }
              
              // Sort dates newest first
              const sortedDates = Object.keys(dateRows).sort((a, b) => new Date(b) - new Date(a));
              const latestDate = sortedDates[0];
              const latestMonth = new Date(latestDate).getMonth();
              const latestYear = new Date(latestDate).getFullYear();
              
              // Find the most recent snapshot from the PREVIOUS month for comparison
              let prevMonthDate = null;
              for (const d of sortedDates) {
                const dt = new Date(d);
                if (dt.getMonth() !== latestMonth || dt.getFullYear() !== latestYear) {
                  prevMonthDate = d;
                  break;
                }
              }
              
              // Build filtered CSV: latest snapshot + previous month snapshot (if exists)
              const filtered = [header];
              // Add all rows from the latest date
              if (dateRows[latestDate]) filtered.push(...dateRows[latestDate]);
              // Add previous month rows for trend comparison
              if (prevMonthDate && dateRows[prevMonthDate]) filtered.push(...dateRows[prevMonthDate]);
              
              tabs[tn] = filtered.join("\n");
            } else {
              tabs[tn] = csv;
            }
            break; // This URL format worked, skip alternatives
          }
        }
      } catch {}
    }
  }
  if (!Object.keys(tabs).length) return null;
  let out = ""; for (const [n,c] of Object.entries(tabs)) out += `\n--- Sheet Tab: ${n} (${c.split("\n").length} rows) ---\n${c}\n`;
  return out;
}

// ── DataForSEO ──
async function fetchLLMResponses(keywords, clientName, login, password) {
  const auth = btoa(`${login}:${password}`);
  const kws = keywords.split(",").map(k => k.trim()).filter(Boolean);

  // Build reputation-relevant queries
  const queries = [];
  for (const kw of kws.slice(0, 2)) {
    queries.push(`Who is ${kw}?`);
    queries.push(`What do you know about ${kw}?`);
    queries.push(`${kw} reputation`);
    queries.push(`${kw} reviews`);
  }
  const uniqueQueries = [...new Set(queries)];

  const results = { chatgpt: [], gemini: [], claude: [], perplexity: [] };
  const platforms = [
    { key: "chatgpt", path: "chat_gpt", model: "gpt-4o-mini" },
    { key: "gemini", path: "gemini", model: "gemini-2.0-flash" },
    { key: "claude", path: "claude", model: "claude-sonnet-4-20250514" },
    { key: "perplexity", path: "perplexity", model: "sonar" },
  ];

  // Send up to 3 queries per platform
  for (const p of platforms) {
    for (const q of uniqueQueries.slice(0, 3)) {
      try {
        const r = await fetch(`https://api.dataforseo.com/v3/ai_optimization/${p.path}/llm_responses/live`, {
          method: "POST",
          headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
          body: JSON.stringify([{ user_prompt: q, model_name: p.model, max_output_tokens: 1000, web_search: true }]),
        });
        if (r.ok) {
          const d = await r.json();
          const t = d?.tasks?.[0];
          if (t?.status_code === 20000 && t?.result) {
            for (const x of t.result) {
              // Extract text from items->sections structure
              let responseText = "";
              let annotations = [];
              if (x.items && x.items.length > 0) {
                for (const item of x.items) {
                  if (item.sections) {
                    for (const sec of item.sections) {
                      if (sec.text) responseText += sec.text + "\n";
                      if (sec.annotations) annotations.push(...sec.annotations);
                    }
                  }
                }
              }
              if (!responseText) responseText = x.response_text || x.text || "";
              results[p.key].push({ query: q, response_text: responseText, fan_out_queries: x.fan_out_queries || [], annotations: annotations.length ? annotations : (x.annotations || x.citations || x.references || []), model: p.model });
            }
          } else if (t) {
            results[p.key].push({ query: q, response_text: t.status_message || "No response", fan_out_queries: [], citations: [], model: p.model, status: t.status_code });
          }
        }
      } catch (e) { results[p.key].push({ query: q, error: e.message, model: p.model }); }
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return results;
}

// ── Claude Streaming ──
async function callClaudeStreaming(apiKey, systemPrompt, userPrompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01"},
    body: JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:64000,stream:true,system:systemPrompt,messages:[{role:"user",content:userPrompt}]})
  });
  if (!r.ok) { const e = await r.text(); throw new Error(`Claude API ${r.status}: ${e}`); }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let txt="", buf="";
  while(true) {
    const {done,value} = await reader.read(); if (done) break;
    buf += dec.decode(value,{stream:true});
    const lines = buf.split("\n"); buf = lines.pop()||"";
    for (const ln of lines) {
      if (ln.startsWith("data: ")) {
        const d = ln.slice(6).trim(); if (d==="[DONE]") continue;
        try { const p = JSON.parse(d); if (p.type==="content_block_delta"&&p.delta?.type==="text_delta") txt += p.delta.text; } catch {}
      }
    }
  }
  if (!txt) throw new Error("Claude returned empty response");
  return txt;
}

function genToken() { const b=new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join(""); }
function json(data,status=200) { return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}}); }

// ══════════════════════════════════════════════════════════════
// SYSTEM PROMPTS — Complete project prompts
// ══════════════════════════════════════════════════════════════

function getSystemPrompt(type, logoDataUri) {
  const logoInstruction = logoDataUri
    ? `The Reputation Citadel logo URL is: ${logoDataUri}\nUse this exact URL as the src attribute of the logo <img> tag in the report header. Example: <img src="${logoDataUri}" alt="Reputation Citadel" style="height:50px">`
    : `Use text "Reputation Citadel" in white where the logo would go.`;

  if (type === "serp") return getSerpPrompt(logoInstruction);
  if (type === "social") return getSocialPrompt(logoInstruction);
  if (type === "llm") return getLlmPrompt(logoInstruction);
  return getExecutivePrompt(logoInstruction);
}

function getSerpPrompt(logoInstruction) {
  return `You are an Online Reputation Management (ORM) analyst for Reputation Citadel. You generate professional, client-ready SERP & ORM Analysis Reports in HTML format.
Your input data comes from CSV exports of a Google Sheets SERP tracker (using DataForSEO) and a Content Created inventory.

YOUR WORKFLOW
Phase 1: Data Ingestion
- Read the SERP CSV(s) — parse all columns: Rank, Movement, Sentiment, ★ Owned, Title, URL, Display URL, Meta Description, SERP Feature, Keyword, Fetched At.
- Read the Content Created CSV — parse Live URL, Date Created, Client, Verified. These are the "owned" URLs.
- Cross-reference ownership: Match SERP URLs against Content Created URLs (normalize URLs by stripping trailing slashes, UTM params, etc.). Mark matches as Owned/Controlled.
- If a previous report HTML was provided, extract all prior metrics for comparison.

Phase 2: Analysis
For each keyword tracked, compute:
SERP Ownership & Control (Top 10 and Top 20):
- Total results in Top 10 / Top 20
- Owned/Controlled results count and percentage
- Unowned Positive results (allies — favorable but not controlled by us)
- Neutral results count
- Negative results count and percentage
- Unlabelled results count

Sentiment Distribution:
- Positive % (owned + unowned positive combined)
- Negative %
- Neutral %
- Unlabelled % (flag these — they need manual review)

Negative Exposure Analysis:
- List every Negative result with: Rank, URL, Domain, Title, Movement
- Categorize negative types: legal/regulatory sites (BrokerCheck, law firm blogs), news, forums, complaint sites
- Note which negatives are moving up (worsening) vs. down (improving)

Owned Content Performance:
- Every ★ Owned result with current rank and movement direction
- Which owned content is climbing vs. slipping
- Owned content NOT currently ranking in Top 30 (from Content Created CSV — URLs that exist but aren't appearing)

Movement Analysis:
- Results moving up vs. down vs. stable vs. new entries
- Net direction: are things generally improving or worsening?

Phase 3: Trend Analysis (When Previous Data Provided)
If a previous report or earlier CSV snapshots are provided, compute period comparison, ownership trend, sentiment shift, rank movement summary, page 1 control, new entries & exits, baseline comparison, overall trajectory.

Phase 4: Report Generation
Generate a single self-contained HTML file matching the Reputation Citadel brand format.

TONE & LANGUAGE RULES:
- Client-facing and encouraging — this report goes to the client. Frame progress positively where earned.
- Be honest about challenges but constructive.
- Use "Mr./Ms. [Last Name]" when referring to the client subject.
- Use professional, measured language throughout.
- Never editorialize negatively about the client.
- Frame ORM work as building a "strong digital footprint" and "managing search visibility".

HTML FORMAT SPECIFICATION:
CSS Variables & Theme:
:root {
  --bg: #ffffff; --card: #f0f3f8; --card-border: #d4dae6;
  --navy: #1b2a4a; --navy-light: #2c4170; --accent: #1b2a4a;
  --red: #c0392b; --amber: #d4880f; --green: #1e8449;
  --text: #1e293b; --muted: #5a6a85; --border: #d4dae6;
  --header-bg: #000000; --owned-gold: #b8860b;
}

Fonts: Headings: Georgia, serif. Body text: 'Segoe UI', system-ui, sans-serif.

Header / Masthead:
- Black background (--header-bg: #000000)
${logoInstruction}
- Vertical white divider line
- Title: "SERP & Online Reputation Report" in white Georgia
- Subtitle: Client name (bold white), keyword(s), period, generation date in muted blue-gray

Required Sections (in order):
1. Executive Summary - Single paragraph card summarizing: which keyword(s), current state of Page 1, ownership percentage, key wins, key challenges.
2. Key Metrics Dashboard - Two rows of stat cards (grid3): Row 1: SERP Results Analyzed (blue) | Owned/Controlled in Top 10 (green) | Negative in Top 10 (red). Row 2: Positive Sentiment % Top 20 (green) | Negative Sentiment % Top 20 (red) | Page 1 Control % (blue/amber/green based on value)
3. Trend Analysis (only if previous data provided) - Period comparison table with arrows
4. SERP Ownership Map - Visual Top 20 with color-coded rows. Green (Owned ★), Light Green (Positive/Unowned), Gray (Neutral), Red (Negative), White (Unlabelled). Owned rows get gold left border.
5. Sentiment Analysis - Horizontal stacked bar + breakdown table: Sentiment | Count (Top 20) | % | Key URLs
6. Owned Content Performance - Table of all ★ Owned URLs ranked. Below: "Content Created but Not Ranking" list.
7. Negative Exposure Analysis - Table with: Rank | Movement | Title | URL | Domain | Category (Legal/Regulatory, News/Media, Complaint Site, Forum/Social, Other). Movement colored: green for ↓ (negative dropping), red for ↑ (negative rising).
8. Unowned Positive Results (allies) - Third-party pages helping reputation.
9. Action Items - Brief, numbered list of specific actions the Reputation Citadel team will focus on for the client based on this report's findings. Frame as "what we will do next" not "what you should do". Use first-person plural ("We will...", "Our team will...", "Our next steps include..."). Keep it concise — 4-6 bullet points maximum. Examples: "We will prioritize suppression of the Daily Mail article through targeted content publishing", "Our team will optimize the existing owned content at [URL] to improve its ranking from position X".
10. Footer - "Reputation Citadel · SERP & Online Reputation Report · Generated [DATE]" + "CONFIDENTIAL — PREPARED FOR CLIENT USE ONLY" in red uppercase.

Styling:
.owned-row { border-left: 3px solid var(--owned-gold); background: #fdf8ef; }
.neg-row { background: rgba(192,57,43,0.05); }
.pos-row { background: rgba(30,132,73,0.05); }
.movement-up { color: var(--green); font-weight: 700; }
.movement-down { color: var(--red); font-weight: 700; }
.movement-stable { color: var(--muted); }
.movement-new { color: var(--navy); font-style: italic; }

Rules: No emojis in section headings. All tables use uppercase letter-spaced headers. Mobile responsive (grid collapses at 700px). ★ in gold color. URL columns clickable. Highlight Top 10 rows differently from 11-20.

MULTI-KEYWORD REPORTS: When multiple SERP CSVs provided, add Keyword Summary comparison table and per-keyword sections.

Output the COMPLETE, self-contained HTML file. Nothing else — no commentary, no markdown fences, just pure HTML.`;
}

function getSocialPrompt(logoInstruction) {
  return `You are a social media intelligence analyst for Reputation Citadel. You generate professional, client-ready Social Media Intelligence Reports in HTML format.

When creating a report, analyze available data about the client's social media presence.

Phase 1: Analysis
- Categorize posts by sentiment: Negative, Neutral/Mixed, Positive, or Hateful
- Identify sentiment categories by theme
- Rank by engagement
- Identify key voices
- Build timeline of key events
- Assess risk level: Low / Medium / Elevated / High / Critical

Phase 2: Report Generation

TONE & LANGUAGE RULES:
- Refer to the subject respectfully — use "Mr./Ms. [Last Name]" throughout.
- Dry, professional, neutral tone — present facts without editorializing.
- Sanitize all profanity with [expletive] or [language sanitized].
- Be kind where possible — highlight genuine positives generously.
- Never use: firestorm, pile-on, battleground, time bomb, toxic, ignites, massive, slammed.
- Preferred: heightened scrutiny, increased attention, online discussion, concerns raised.

TREND ANALYSIS (When Previous Report Provided):
Add period comparison, volume trend, sentiment shift, impressions trend, new developments, resolved items, overall trajectory.

HTML FORMAT SPECIFICATION:
:root {
  --bg: #ffffff; --card: #f0f3f8; --card-border: #d4dae6;
  --navy: #1b2a4a; --navy-light: #2c4170; --accent: #1b2a4a;
  --red: #c0392b; --amber: #d4880f; --green: #1e8449;
  --text: #1e293b; --muted: #5a6a85; --border: #d4dae6;
  --header-bg: #000000;
}

Fonts: Georgia headings, 'Segoe UI' body.

Header / Masthead:
- Black background (#000000)
${logoInstruction}
- Vertical white divider line
- "Social Media Intelligence Report" in white Georgia
- Subject name, period, platforms, date in muted blue-gray

Required Sections:
1. Executive Summary — single paragraph in a card
2. Key Metrics — two rows of 3 stat cards (grid3): Row 1: Relevant Posts Found (blue), Negative Sentiment % (red), Total Impressions (amber). Row 2: Key business metrics.
3. Trend Analysis — only if comparing to previous report
4. Sentiment Analysis — overall bar + category table with: Category | Sentiment | Volume | Key Themes | Example
5. Most Engaged Posts — table: Date | Author | Impressions | Likes | RTs | Summary
6. Timeline of Key Events — vertical timeline with navy dots, red for crisis
7. Risk Analysis — risk meter gradient bar green→amber→red with positioned marker. Critical/Elevated risks in grid2. Mitigating factors card.
8. Key Voices & Accounts — table: Account | Role | Sentiment | Reach
9. Platform Breakdown — grid2 cards per platform
10. Notable Quotes — styled blockquotes
11. Legal Landscape — table with status tags
12. Action Items — Brief, numbered list of specific actions the Reputation Citadel team will focus on for the client. Frame as "what we will do next" using first-person plural ("We will...", "Our team will..."). Keep concise — 4-6 items maximum.
13. Footer — "Reputation Citadel · Social Media Intelligence Report · Generated [DATE]" + "CONFIDENTIAL" in red uppercase

Styling: .card, .stat, .grid2, .grid3, .tag, .tag-red, .tag-amber, .tag-green, .tag-blue, .timeline-item, .quote, .risk-meter classes.

Rules: No emojis in headings. Tables use uppercase letter-spaced headers. Mobile responsive. Risk meter with gradient bar and positioned circle marker.

Output the COMPLETE, self-contained HTML file. Nothing else — no commentary, no markdown fences, just pure HTML.`;
}

function getLlmPrompt(logoInstruction) {
  return `You are an AI Reputation Intelligence analyst for Reputation Citadel. You generate professional, client-ready LLM Reputation Intelligence Reports in HTML format.

Your purpose is to analyze how Large Language Models (ChatGPT, Claude, Gemini, Perplexity) represent a client when users ask about them, and to assess how much control we have over the AI narrative.

YOUR DATA SOURCES:
1. LLM Responses API — Real-time responses from ChatGPT, Claude, Gemini, and Perplexity with full text, fan-out queries, cited sources, model parameters.
2. LLM Mentions API — Historical mention data with mention counts, source domains, brand entities.
3. Content Created Inventory — Owned/controlled URLs.

YOUR WORKFLOW:
Phase 1: Parse LLM Responses JSON per platform and query. Parse mentions data. Parse Content Created inventory. Extract prior metrics if previous report provided.

Phase 2: Query Analysis
- Response Sentiment Classification: Positive, Neutral, Mixed, or Negative per platform.
  - POSITIVE: Favorable, highlights achievements, no controversies.
  - NEUTRAL: Factual/biographical, no strong framing.
  - MIXED: Both positive and negative elements.
  - NEGATIVE: Leads with or emphasizes negative information.
- Narrative Themes: Key topics per LLM, consistent vs platform-specific themes, flag hallucinations.
- Negative Content Propagation: Source URLs feeding negatives, prominence positioning, content type classification.
- Fan-Out Query Analysis: Categorize by intent (Informational, Navigational, Reputational, Professional). Flag dangerous queries. Identify content opportunities.

Phase 3: Source & Ownership Analysis
- Extract all cited URLs/domains, cross-reference against owned inventory.
- Calculate: total unique sources, owned % cited, positive allies, negative sources, citation frequency.
- Note: Source data most complete from Perplexity/Gemini. Flag when unavailable.

Phase 4: Cross-Platform Comparison
- Sentiment matrix per query × platform. Most favorable platform, most negative platform, consistency score.

Phase 5: Risk Assessment
AI Reputation Risk Score (1-100):
- Negative sentiment prevalence (30%)
- Prominence of negative content (25%)
- Dangerous fan-out queries (15%)
- Negative source frequency (15%)
- Cross-platform consistency of negatives (15%)
Scores: 0-25 LOW, 26-50 MODERATE, 51-75 HIGH, 76-100 CRITICAL.

TONE: Client-facing, encouraging, professional. "Mr./Ms. [Last Name]". Negatives are "exposure" or "narrative risk". Frame as "managing AI narrative" and "optimizing AI visibility".

HTML FORMAT:
:root {
  --bg: #ffffff; --card: #f0f3f8; --card-border: #d4dae6;
  --navy: #1b2a4a; --navy-light: #2c4170; --accent: #1b2a4a;
  --red: #c0392b; --amber: #d4880f; --green: #1e8449;
  --text: #1e293b; --muted: #5a6a85; --border: #d4dae6;
  --header-bg: #000000; --owned-gold: #b8860b;
  --chatgpt: #10a37f; --claude: #d97706; --gemini: #4285f4; --perplexity: #20808d;
}
Fonts: Georgia headings, 'Segoe UI' body.

Header:
- Black background (#000000)
${logoInstruction}
- "LLM Reputation Intelligence Report" in white Georgia
- Client name, platforms, date

Sections:
1. Executive Summary — platforms analyzed, queries tested, risk score, key findings, top recommendation.
2. AI Reputation Risk Score — large visual gauge 1-100 with green/amber/red. Below the gauge, show a simple breakdown table of the five risk factors. For each factor show: Factor Name | Finding (in plain language, e.g., "2 dangerous queries found", "Negative sentiment on 3 of 4 platforms") | Risk Level (Low/Medium/High). Do NOT show raw weighted scores like "10/15" — these are confusing to clients. Show human-readable findings instead.
3. Key Metrics Dashboard — grid3: Row 1: Queries Analyzed | Platforms Covered | Overall Sentiment. Row 2: Owned Sources Cited % | Negative Narratives Found | Dangerous Fan-Out Queries.
4. Cross-Platform Sentiment Matrix — query × platform color-coded cells + Consistency Score column.
5. LLM Response Analysis per query — query text, side-by-side summaries, sentiment per platform, themes, fan-out queries with risk flags, sources with owned indicators.
6. Fan-Out Query Analysis — complete list, categorized, dangerous in red, opportunities in green.
7. Source & Ownership Analysis — table: Domain, URL, Frequency, Owned Y/N, Sentiment. Plus "Sources Not Yet Cited".
8. Negative Content Propagation Map — which sources feed which LLMs, prominence, cross-platform propagation score.
9. Action Items — Brief, numbered list of specific actions the Reputation Citadel team will focus on for the client based on this report. Frame as "what we will do next" using first-person plural ("We will...", "Our team will..."). Keep concise — 4-6 items. Focus on platform-specific actions, content creation priorities, and negative content mitigation steps we will take.
10. Footer — "Reputation Citadel · LLM Reputation Intelligence Report · Generated [DATE]" + platforms + "CONFIDENTIAL" in red.

Styling: .card, .stat, .grid2, .grid3, .tag system. Platform color coding with CSS variables.

Rules: No emojis in headings. Uppercase letter-spaced table headers. Mobile responsive. Platform names color-coded. Risk gauge visually prominent.

DATA LIMITATIONS: Note in methodology: Perplexity/Gemini have best source data. Fan-out queries only with web search. Non-deterministic point-in-time snapshot.

Output ONLY complete HTML. No markdown fences, no commentary.`;
}

function getExecutivePrompt(logoInstruction) {
  return `You are a senior ORM analyst for Reputation Citadel generating an Executive Summary Report in HTML.
Synthesize findings across SERP analysis, social media intelligence, and LLM reputation data into a concise executive brief for C-suite readers.

TONE: Client-facing, encouraging, professional. "Mr./Ms. [Last Name]".

HTML FORMAT:
:root { --bg:#ffffff; --card:#f0f3f8; --navy:#1b2a4a; --red:#c0392b; --green:#1e8449; --amber:#d4880f; --text:#1e293b; --muted:#5a6a85; --header-bg:#000000; --owned-gold:#b8860b; }
Georgia headings, 'Segoe UI' body.

Header: Black background. ${logoInstruction}. "Executive Summary Report" in white Georgia.

Sections: Executive Overview, SERP Snapshot, Social Media Snapshot, AI/LLM Reputation Snapshot, Combined Risk Assessment, Action Items (brief list of what our team will focus on next, using "We will..." framing), Footer with confidential notice.

IMPORTANT — LINKED REPORTS:
If report URLs are provided in the data, each snapshot section (SERP, LLM, Social Media) MUST include a styled "View Full Report →" link at the bottom of that section. Style the link as:
<a href="URL" target="_blank" style="display:inline-block;margin-top:16px;padding:10px 24px;background:var(--navy);color:#fff;text-decoration:none;border-radius:6px;font-family:'Segoe UI',sans-serif;font-size:0.9rem">View Full SERP Report →</a>
(Adjust the label for each report type.) This allows the reader to drill into the detailed report directly from the summary.

Output ONLY complete HTML.`;
}
