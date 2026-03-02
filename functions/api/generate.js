// ============================================================================
// REPUTATION CITADEL — generate.js
// Cloudflare Pages Function: /functions/api/generate.js
// Handles: SERP, LLM, Social Media, Executive Summary report generation
// ============================================================================

// ─── SHARED HTML TEMPLATE ────────────────────────────────────────────────────
// All 4 report types use this identical structure with [PLACEHOLDERS]

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>[REPORT_TITLE] — [CLIENT_NAME] | Reputation Citadel</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=DM+Serif+Display&display=swap');
  :root {
    --rc-ink: #0f1419;
    --rc-paper: #ffffff;
    --rc-slate: #536471;
    --rc-border: #e1e4e8;
    --rc-accent: #1d4ed8;
    --rc-accent-light: #eff6ff;
    --rc-green: #059669;
    --rc-green-light: #ecfdf5;
    --rc-amber: #d97706;
    --rc-amber-light: #fffbeb;
    --rc-red: #dc2626;
    --rc-red-light: #fef2f2;
    --rc-surface: #f8fafc;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'DM Sans', -apple-system, sans-serif;
    color: var(--rc-ink);
    background: var(--rc-surface);
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }
  .rc-report { max-width: 900px; margin: 0 auto; padding: 40px 24px 80px; }
  /* Header */
  .rc-header {
    display: flex; align-items: center; gap: 20px;
    padding-bottom: 32px; margin-bottom: 40px;
    border-bottom: 2px solid var(--rc-ink);
  }
  .rc-logo { height: 48px; width: auto; }
  .rc-header-text h1 {
    font-family: 'DM Serif Display', serif;
    font-size: 28px; font-weight: 400; line-height: 1.2;
  }
  .rc-header-text .rc-subtitle {
    font-size: 14px; color: var(--rc-slate); margin-top: 4px;
  }
  /* Metadata strip */
  .rc-meta {
    display: flex; flex-wrap: wrap; gap: 24px;
    padding: 16px 0; margin-bottom: 32px;
    border-bottom: 1px solid var(--rc-border);
    font-size: 13px; color: var(--rc-slate);
  }
  .rc-meta strong { color: var(--rc-ink); font-weight: 500; }
  /* Section blocks */
  .rc-section { margin-bottom: 36px; }
  .rc-section-title {
    font-family: 'DM Serif Display', serif;
    font-size: 22px; font-weight: 400;
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--rc-border);
  }
  .rc-section p { margin-bottom: 12px; color: #1a1a1a; }
  /* Risk levels — plain language badges */
  .rc-risk {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 14px; border-radius: 6px;
    font-size: 13px; font-weight: 600; letter-spacing: 0.02em;
  }
  .rc-risk::before {
    content: ''; width: 8px; height: 8px; border-radius: 50%;
  }
  .rc-risk--low { background: var(--rc-green-light); color: var(--rc-green); }
  .rc-risk--low::before { background: var(--rc-green); }
  .rc-risk--moderate { background: var(--rc-amber-light); color: var(--rc-amber); }
  .rc-risk--moderate::before { background: var(--rc-amber); }
  .rc-risk--elevated { background: var(--rc-red-light); color: var(--rc-red); }
  .rc-risk--elevated::before { background: var(--rc-red); }
  /* Data tables */
  .rc-table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
  .rc-table th {
    text-align: left; padding: 10px 12px;
    background: var(--rc-surface); border-bottom: 2px solid var(--rc-border);
    font-weight: 600; font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--rc-slate);
  }
  .rc-table td {
    padding: 10px 12px; border-bottom: 1px solid var(--rc-border);
    vertical-align: top;
  }
  .rc-table tr:last-child td { border-bottom: none; }
  /* Action items — "We will..." framing */
  .rc-actions {
    background: var(--rc-accent-light);
    border-left: 4px solid var(--rc-accent);
    padding: 20px 24px; border-radius: 0 8px 8px 0;
    margin: 24px 0;
  }
  .rc-actions h3 {
    font-size: 15px; font-weight: 700; color: var(--rc-accent);
    margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.03em;
  }
  .rc-actions ol {
    padding-left: 20px; counter-reset: action;
    list-style: none;
  }
  .rc-actions li {
    position: relative; padding: 6px 0 6px 8px;
    counter-increment: action;
    font-size: 14px; line-height: 1.6;
  }
  .rc-actions li::before {
    content: counter(action) '.';
    position: absolute; left: -20px;
    font-weight: 700; color: var(--rc-accent);
  }
  /* Trend indicators */
  .rc-trend-up { color: var(--rc-green); }
  .rc-trend-down { color: var(--rc-red); }
  .rc-trend-flat { color: var(--rc-slate); }
  /* Cross-links */
  .rc-crosslinks {
    display: flex; flex-wrap: wrap; gap: 12px;
    padding-top: 24px; margin-top: 40px;
    border-top: 1px solid var(--rc-border);
  }
  .rc-crosslink {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 16px; border-radius: 6px;
    background: var(--rc-surface); border: 1px solid var(--rc-border);
    color: var(--rc-accent); text-decoration: none;
    font-size: 13px; font-weight: 500;
    transition: border-color 0.15s, background 0.15s;
  }
  .rc-crosslink:hover { background: var(--rc-accent-light); border-color: var(--rc-accent); }
  /* Footer */
  .rc-footer {
    margin-top: 48px; padding-top: 24px;
    border-top: 2px solid var(--rc-ink);
    font-size: 12px; color: var(--rc-slate);
    display: flex; justify-content: space-between;
  }
  /* Responsive */
  @media (max-width: 640px) {
    .rc-header { flex-direction: column; align-items: flex-start; }
    .rc-header-text h1 { font-size: 22px; }
    .rc-meta { flex-direction: column; gap: 8px; }
    .rc-table { font-size: 12px; }
    .rc-table th, .rc-table td { padding: 8px 6px; }
  }
  @media print {
    body { background: white; }
    .rc-report { padding: 0; }
    .rc-crosslinks { display: none; }
  }
</style>
</head>
<body>
<div class="rc-report">
  <header class="rc-header">
    <img src="https://citadel-dashboard.pages.dev/logo.png" alt="Reputation Citadel" class="rc-logo" />
    <div class="rc-header-text">
      <h1>[REPORT_TITLE]</h1>
      <div class="rc-subtitle">[CLIENT_NAME] — [REPORT_PERIOD]</div>
    </div>
  </header>
  <div class="rc-meta">
    <span><strong>Client:</strong> [CLIENT_NAME]</span>
    <span><strong>Period:</strong> [REPORT_PERIOD]</span>
    <span><strong>Generated:</strong> [GENERATED_DATE]</span>
    <span><strong>Report Type:</strong> [REPORT_TYPE_LABEL]</span>
  </div>
  [REPORT_BODY]
  [CROSS_LINKS]
  <footer class="rc-footer">
    <span>Reputation Citadel — Confidential</span>
    <span>Generated [GENERATED_DATE]</span>
  </footer>
</div>
</body>
</html>`;


// ─── UTILITY HELPERS ─────────────────────────────────────────────────────────

function getReportPeriod() {
  const now = new Date();
  const currentMonth = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return currentMonth;
}

function getPreviousMonth() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return prev.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function getMonthKey(dateStr) {
  // Returns YYYY-MM from various date formats
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  } catch { return null; }
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function previousMonthKey() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
}

function riskBadge(level) {
  // Plain language risk — not "10/15" weighted scores
  const map = {
    low: '<span class="rc-risk rc-risk--low">Low Risk — Stable</span>',
    moderate: '<span class="rc-risk rc-risk--moderate">Moderate Risk — Monitor Closely</span>',
    elevated: '<span class="rc-risk rc-risk--elevated">Elevated Risk — Immediate Action Needed</span>',
  };
  return map[level] || map.moderate;
}

function buildCrossLinks(reportType, clientName, baseUrl) {
  const types = [
    { key: 'serp', label: 'SERP & ORM Report', icon: '🔍' },
    { key: 'llm', label: 'LLM Intelligence Report', icon: '🤖' },
    { key: 'social', label: 'Social Media Report', icon: '📱' },
    { key: 'executive', label: 'Executive Summary', icon: '📊' },
  ];
  const links = types
    .filter(t => t.key !== reportType)
    .map(t => {
      const slug = clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const dateSlug = new Date().toISOString().slice(0, 7);
      return `<a class="rc-crosslink" href="${baseUrl}/reports/${slug}/${dateSlug}-${t.key}.html">${t.icon} ${t.label}</a>`;
    })
    .join('\n    ');
  return `<div class="rc-crosslinks">\n    ${links}\n  </div>`;
}

function fillTemplate(replacements) {
  let html = HTML_TEMPLATE;
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(`[${key}]`, value);
  }
  return html;
}


// ─── GOOGLE SHEETS (gviz/tq CSV) ────────────────────────────────────────────

async function fetchSheetData(sheetUrl) {
  // Convert share URL → gviz CSV export
  let sheetId;
  const match = sheetUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) sheetId = match[1];
  else throw new Error('Invalid Google Sheet URL');

  const gvizUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
  const resp = await fetch(gvizUrl);
  if (!resp.ok) throw new Error(`Sheet fetch failed: ${resp.status}`);
  const csvText = await resp.text();
  return parseCSV(csvText);
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [], latest: [], previous: [] };

  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(parseCSVLine);

  // Filter to latest month and previous month
  const dateColIdx = headers.findIndex(h =>
    /date|timestamp|month|period/i.test(h)
  );

  const curKey = currentMonthKey();
  const prevKey = previousMonthKey();

  let latest = rows;
  let previous = [];

  if (dateColIdx >= 0) {
    latest = rows.filter(r => {
      const mk = getMonthKey(r[dateColIdx]);
      return mk === curKey;
    });
    previous = rows.filter(r => {
      const mk = getMonthKey(r[dateColIdx]);
      return mk === prevKey;
    });
    // If no current month data, use most recent available
    if (latest.length === 0) {
      const allMonths = [...new Set(rows.map(r => getMonthKey(r[dateColIdx])).filter(Boolean))].sort().reverse();
      if (allMonths.length >= 1) {
        latest = rows.filter(r => getMonthKey(r[dateColIdx]) === allMonths[0]);
        previous = allMonths.length >= 2
          ? rows.filter(r => getMonthKey(r[dateColIdx]) === allMonths[1])
          : [];
      }
    }
  }

  return { headers, rows, latest, previous };
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { result.push(current.trim()); current = ''; }
      else current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function sheetDataToMarkdown(headers, rows) {
  if (!rows.length) return '_No data available for this period._';
  let md = '| ' + headers.join(' | ') + ' |\n';
  md += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
  for (const row of rows.slice(0, 50)) { // cap at 50 rows
    md += '| ' + row.join(' | ') + ' |\n';
  }
  return md;
}


// ─── DATAFORSEO: LLM RESPONSES ──────────────────────────────────────────────

async function fetchDataForSEO_LLM(keywords, dfLogin, dfPassword) {
  const auth = btoa(`${dfLogin}:${dfPassword}`);
  const llms = ['chat_gpt', 'gemini', 'perplexity'];
  const results = {};

  for (const llm of llms) {
    const prompt = `What do you know about ${keywords}? Provide a comprehensive overview including reputation, reviews, controversies, and public perception.`;
    const payload = [{
      user_prompt: prompt,
      model_name: llm === 'chat_gpt' ? 'gpt-4.1-mini' : llm === 'gemini' ? 'gemini-2.5-flash' : 'sonar-reasoning',
      web_search: true,
      temperature: 0.3,
      max_output_tokens: 1024
    }];

    try {
      const resp = await fetch(
        `https://api.dataforseo.com/v3/ai_optimization/${llm}/llm_responses/live`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        }
      );
      const data = await resp.json();

      // Parse items → sections → text
      let fullText = '';
      const task = data?.tasks?.[0];
      if (task?.status_code === 20000 && task?.result?.[0]?.items) {
        for (const item of task.result[0].items) {
          if (item.sections) {
            for (const section of item.sections) {
              if (section.type === 'text' && section.text) {
                fullText += section.text + '\n\n';
              }
            }
          }
        }
      }
      const modelUsed = task?.result?.[0]?.model_name || llm;
      results[llm] = { text: fullText.trim(), model: modelUsed };
    } catch (err) {
      results[llm] = { text: `Error querying ${llm}: ${err.message}`, model: llm };
    }
  }
  return results;
}


// ─── XPOZ: SOCIAL MEDIA DATA ────────────────────────────────────────────────

async function fetchXpozSocialData(clientName, xpozApiKey) {
  const baseUrl = 'https://mcp.xpoz.ai';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${xpozApiKey}`
  };

  const socialData = { twitter: null, reddit: null, instagram: null };

  // Twitter — search posts by keywords
  try {
    const twitterResp = await fetch(`${baseUrl}/api/twitter/posts/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: clientName,
        responseType: 'fast',
        fields: ['id', 'text', 'authorUsername', 'createdAtDate', 'likeCount', 'retweetCount', 'replyCount']
      })
    });
    if (twitterResp.ok) {
      socialData.twitter = await twitterResp.json();
    }
  } catch (e) {
    socialData.twitter = { error: e.message };
  }

  // Reddit — search posts by keywords
  try {
    const redditResp = await fetch(`${baseUrl}/api/reddit/posts/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: clientName,
        responseType: 'fast',
        fields: ['id', 'title', 'selftext', 'authorUsername', 'subredditName', 'createdAtDate', 'score', 'commentsCount']
      })
    });
    if (redditResp.ok) {
      socialData.reddit = await redditResp.json();
    }
  } catch (e) {
    socialData.reddit = { error: e.message };
  }

  // Instagram — search posts by keywords
  try {
    const igResp = await fetch(`${baseUrl}/api/instagram/posts/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: clientName,
        responseType: 'fast',
        fields: ['id', 'caption', 'username', 'createdAtDate', 'likeCount', 'commentCount']
      })
    });
    if (igResp.ok) {
      socialData.instagram = await igResp.json();
    }
  } catch (e) {
    socialData.instagram = { error: e.message };
  }

  return socialData;
}

// Alternative: Use Xpoz MCP tools directly (for Claude-in-the-loop)
function formatSocialDataForPrompt(socialData) {
  let prompt = '';

  if (socialData.twitter?.results?.length) {
    prompt += '\n\n### Twitter/X Data:\n';
    for (const t of socialData.twitter.results.slice(0, 30)) {
      prompt += `- @${t.authorUsername} (${t.createdAtDate}): "${t.text?.slice(0, 200)}..." [❤️${t.likeCount || 0} 🔁${t.retweetCount || 0} 💬${t.replyCount || 0}]\n`;
    }
  } else {
    prompt += '\n\n### Twitter/X Data:\nNo recent Twitter posts found for this entity.\n';
  }

  if (socialData.reddit?.results?.length) {
    prompt += '\n\n### Reddit Data:\n';
    for (const r of socialData.reddit.results.slice(0, 20)) {
      prompt += `- r/${r.subredditName} by u/${r.authorUsername} (${r.createdAtDate}): "${r.title}" [⬆️${r.score || 0} 💬${r.commentsCount || 0}]\n`;
      if (r.selftext) prompt += `  Content preview: "${r.selftext?.slice(0, 150)}..."\n`;
    }
  } else {
    prompt += '\n\n### Reddit Data:\nNo recent Reddit posts found for this entity.\n';
  }

  if (socialData.instagram?.results?.length) {
    prompt += '\n\n### Instagram Data:\n';
    for (const ig of socialData.instagram.results.slice(0, 20)) {
      prompt += `- @${ig.username} (${ig.createdAtDate}): "${ig.caption?.slice(0, 200)}..." [❤️${ig.likeCount || 0} 💬${ig.commentCount || 0}]\n`;
    }
  } else {
    prompt += '\n\n### Instagram Data:\nNo recent Instagram posts found for this entity.\n';
  }

  return prompt;
}


// ─── CLAUDE STREAMING (SONNET, 64K) ─────────────────────────────────────────

async function streamClaude(systemPrompt, userPrompt, anthropicKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 64000,
      stream: true,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${errText}`);
  }

  return resp.body; // Return ReadableStream for SSE forwarding
}

// Non-streaming variant for when we need full text
async function callClaude(systemPrompt, userPrompt, anthropicKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 64000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  return data.content.map(b => b.text || '').join('');
}


// ─── REPORT SYSTEM PROMPTS ──────────────────────────────────────────────────

const SYSTEM_PROMPTS = {
  serp: `You are the Reputation Citadel report engine generating a SERP & ORM Analysis report.

OUTPUT FORMAT: Return ONLY the HTML body content (no <html>, <head>, <body> tags). Use these CSS classes:
- .rc-section wrapping each section, .rc-section-title for headings
- .rc-table, th, td for data tables
- .rc-risk .rc-risk--low / .rc-risk--moderate / .rc-risk--elevated for risk badges (plain language: "Low Risk — Stable", "Moderate Risk — Monitor Closely", "Elevated Risk — Immediate Action Needed"). NEVER use weighted numeric scores like "10/15".
- .rc-actions with <ol> for action items. Each <li> MUST start with "We will..." (not recommendations — commitments)
- .rc-trend-up, .rc-trend-down, .rc-trend-flat for directional indicators

REPORT STRUCTURE:
1. Executive Overview (2-3 paragraphs)
2. SERP Landscape Analysis (table of keyword rankings with trends)
3. Search Engine Results Composition (owned vs third-party vs negative)
4. Reputation Risk Assessment (plain language risk level + explanation)
5. Month-over-Month Changes (if previous data exists, compare; if baseline, state "Baseline month — future reports will track changes")
6. Action Items (5-7 items, each starting with "We will...")

Be data-driven. Reference specific numbers from the Google Sheets data. Be direct and professional.`,

  llm: `You are the Reputation Citadel report engine generating an LLM Reputation Intelligence report.

OUTPUT FORMAT: Return ONLY the HTML body content. Use the same CSS classes as all Citadel reports:
- .rc-section, .rc-section-title, .rc-table, .rc-risk, .rc-actions
- Risk levels in plain language only (Low/Moderate/Elevated + description). NO numeric scores.
- Action items with "We will..." framing

REPORT STRUCTURE:
1. Executive Overview — How LLMs currently represent this entity
2. LLM Response Analysis by Platform (ChatGPT, Gemini, Perplexity) — summarize what each says, noting tone, accuracy, and any concerns
3. Sentiment & Accuracy Assessment — Are the LLM responses accurate? Favorable? Concerning?
4. Key Themes & Narratives — What themes dominate LLM responses?
5. Risk Assessment — Plain language (not numeric)
6. Month-over-Month Changes (or "Baseline month" if first report)
7. Action Items (5-7 "We will..." commitments for improving LLM representation)

Analyze the actual LLM response data provided. Be specific about what each LLM says.`,

  social: `You are the Reputation Citadel report engine generating a Social Media Intelligence report.

OUTPUT FORMAT: Return ONLY the HTML body content. Use identical CSS classes:
- .rc-section, .rc-section-title, .rc-table, .rc-risk, .rc-actions
- Plain language risk only. "We will..." action items only.

REPORT STRUCTURE:
1. Executive Overview — Social media reputation snapshot
2. Twitter/X Analysis — Volume, sentiment, key voices, trending discussions
3. Reddit Analysis — Subreddit presence, discussion themes, sentiment
4. Instagram Analysis — Brand mentions, visual content, engagement patterns
5. Cross-Platform Sentiment Summary (table comparing platforms)
6. Notable Mentions & Conversations (highlight specific impactful posts)
7. Risk Assessment — Plain language
8. Month-over-Month Changes (or "Baseline month")
9. Action Items (5-7 "We will..." commitments)

Use the REAL social media data provided. Reference actual usernames, post content, engagement metrics. This is an intelligence report, not speculation.`,

  executive: `You are the Reputation Citadel report engine generating an Executive Summary.

OUTPUT FORMAT: Return ONLY the HTML body content. Same CSS classes as all Citadel reports.

This report SYNTHESIZES findings from all three other reports (SERP, LLM, Social). You will receive summaries of each.

REPORT STRUCTURE:
1. Executive Overview — 3-paragraph synthesis of overall reputation health
2. Reputation Health Dashboard (table with: Category | Status | Risk Level | Key Finding)
   Categories: Search Presence, LLM Representation, Social Sentiment, Overall
3. Critical Findings — Top 3-5 most important discoveries across all reports
4. Opportunity Matrix — Where the biggest reputation gains can be made
5. Consolidated Risk Assessment — Overall plain language risk
6. 90-Day Action Plan — 10 prioritized "We will..." commitments, pulling from all three reports
7. Next Steps — What happens before next month's report

Be strategic and executive-level. This is for C-suite consumption. Concise but comprehensive.`
};


// ─── REPORT GENERATORS ──────────────────────────────────────────────────────

async function generateSERPReport(clientName, keywords, sheetUrl, previousReport, anthropicKey) {
  // 1. Fetch Google Sheets data
  let sheetData = { headers: [], latest: [], previous: [] };
  let sheetSummary = 'No Google Sheet data available.';
  if (sheetUrl) {
    try {
      sheetData = await fetchSheetData(sheetUrl);
      const latestMD = sheetDataToMarkdown(sheetData.headers, sheetData.latest);
      const prevMD = sheetData.previous.length
        ? sheetDataToMarkdown(sheetData.headers, sheetData.previous)
        : 'No previous month data available.';
      sheetSummary = `## Current Month Data (${getReportPeriod()}):\n${latestMD}\n\n## Previous Month Data (${getPreviousMonth()}):\n${prevMD}`;
    } catch (e) {
      sheetSummary = `Error fetching sheet: ${e.message}`;
    }
  }

  // 2. Build prompt
  const userPrompt = `Generate the SERP & ORM Analysis report for:

**Client:** ${clientName}
**Keywords:** ${keywords}
**Report Period:** ${getReportPeriod()}
**Reporting Context:** ${previousReport ? 'Month-over-month comparison available' : 'Baseline month — this is the first report. State that future reports will track month-over-month changes.'}

## Google Sheets SERP Tracker Data:
${sheetSummary}

${previousReport ? `## Previous Report Summary:\n${previousReport}` : ''}

Generate the complete report HTML body now.`;

  return { systemPrompt: SYSTEM_PROMPTS.serp, userPrompt, sheetData };
}

async function generateLLMReport(clientName, keywords, dfLogin, dfPassword, previousReport, anthropicKey) {
  // 1. Fetch DataForSEO LLM responses
  let llmData = {};
  let llmSummary = 'No DataForSEO data available.';
  if (dfLogin && dfPassword) {
    try {
      llmData = await fetchDataForSEO_LLM(keywords, dfLogin, dfPassword);
      llmSummary = '';
      for (const [platform, data] of Object.entries(llmData)) {
        const label = platform === 'chat_gpt' ? 'ChatGPT' : platform === 'gemini' ? 'Gemini' : 'Perplexity';
        llmSummary += `\n### ${label} (${data.model}) Response:\n${data.text || 'No response received.'}\n\n---\n`;
      }
    } catch (e) {
      llmSummary = `Error fetching LLM data: ${e.message}`;
    }
  }

  const userPrompt = `Generate the LLM Reputation Intelligence report for:

**Client:** ${clientName}
**Keywords:** ${keywords}
**Report Period:** ${getReportPeriod()}
**Reporting Context:** ${previousReport ? 'Month-over-month comparison available' : 'Baseline month — first report.'}

## DataForSEO LLM Response Data:
${llmSummary}

${previousReport ? `## Previous Report Summary:\n${previousReport}` : ''}

Generate the complete report HTML body now.`;

  return { systemPrompt: SYSTEM_PROMPTS.llm, userPrompt, llmData };
}

async function generateSocialReport(clientName, keywords, xpozApiKey, previousReport, anthropicKey) {
  // 1. Fetch Xpoz social media data
  let socialData = { twitter: null, reddit: null, instagram: null };
  let socialSummary = 'No social media data available.';

  if (xpozApiKey) {
    try {
      socialData = await fetchXpozSocialData(clientName, xpozApiKey);
      socialSummary = formatSocialDataForPrompt(socialData);
    } catch (e) {
      socialSummary = `Error fetching social data: ${e.message}`;
    }
  }

  const userPrompt = `Generate the Social Media Intelligence report for:

**Client:** ${clientName}
**Keywords:** ${keywords}
**Report Period:** ${getReportPeriod()}
**Reporting Context:** ${previousReport ? 'Month-over-month comparison available' : 'Baseline month — first report.'}

## Real Social Media Data (collected via Xpoz API):
${socialSummary}

${previousReport ? `## Previous Report Summary:\n${previousReport}` : ''}

Generate the complete report HTML body now. Reference the REAL data provided above — actual usernames, actual post content, actual engagement numbers.`;

  return { systemPrompt: SYSTEM_PROMPTS.social, userPrompt, socialData };
}

async function generateExecutiveReport(clientName, keywords, serpSummary, llmSummary, socialSummary, previousReport, anthropicKey) {
  const userPrompt = `Generate the Executive Summary report for:

**Client:** ${clientName}
**Keywords:** ${keywords}
**Report Period:** ${getReportPeriod()}
**Reporting Context:** ${previousReport ? 'Month-over-month comparison available' : 'Baseline month — first report.'}

## SERP & ORM Report Findings:
${serpSummary || 'SERP report not yet generated.'}

## LLM Intelligence Report Findings:
${llmSummary || 'LLM report not yet generated.'}

## Social Media Intelligence Report Findings:
${socialSummary || 'Social media report not yet generated.'}

${previousReport ? `## Previous Executive Summary:\n${previousReport}` : ''}

Synthesize all findings into a comprehensive executive summary.`;

  return { systemPrompt: SYSTEM_PROMPTS.executive, userPrompt };
}


// ─── MAIN REQUEST HANDLER ───────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;

  // CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await request.json();
    const {
      reportType, // 'serp' | 'llm' | 'social' | 'executive' | 'all'
      clientName,
      keywords,
      sheetUrl,
      previousReport,
      anthropicKey,
      dfLogin,
      dfPassword,
      xpozApiKey,
      // For executive: pre-generated summaries
      serpSummary,
      llmSummary,
      socialSummary,
      stream = true  // Default to streaming
    } = body;

    if (!clientName || !anthropicKey) {
      return new Response(JSON.stringify({ error: 'clientName and anthropicKey required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const baseUrl = 'https://citadel-dashboard.pages.dev';

    // ── GENERATE ALL FLOW ──
    if (reportType === 'all') {
      return handleGenerateAll(body, baseUrl);
    }

    // ── SINGLE REPORT ──
    let reportConfig;

    switch (reportType) {
      case 'serp':
        reportConfig = await generateSERPReport(clientName, keywords, sheetUrl, previousReport, anthropicKey);
        break;
      case 'llm':
        reportConfig = await generateLLMReport(clientName, keywords, dfLogin, dfPassword, previousReport, anthropicKey);
        break;
      case 'social':
        reportConfig = await generateSocialReport(clientName, keywords, xpozApiKey, previousReport, anthropicKey);
        break;
      case 'executive':
        reportConfig = await generateExecutiveReport(clientName, keywords, serpSummary, llmSummary, socialSummary, previousReport, anthropicKey);
        break;
      default:
        return new Response(JSON.stringify({ error: `Invalid reportType: ${reportType}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
    }

    if (stream) {
      // Stream Claude response as SSE
      return handleStreamedReport(reportConfig, reportType, clientName, anthropicKey, baseUrl);
    } else {
      // Non-streaming: return complete HTML
      return handleCompleteReport(reportConfig, reportType, clientName, anthropicKey, baseUrl);
    }

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// ── STREAMED REPORT (SSE) ────────────────────────────────────────────────────

async function handleStreamedReport(config, reportType, clientName, anthropicKey, baseUrl) {
  const claudeStream = await streamClaude(config.systemPrompt, config.userPrompt, anthropicKey);

  const reportLabels = {
    serp: 'SERP & ORM Analysis',
    llm: 'LLM Reputation Intelligence',
    social: 'Social Media Intelligence',
    executive: 'Executive Summary'
  };

  // Transform Claude's SSE into our own SSE with template wrapping
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Process Claude stream in background
  (async () => {
    const reader = claudeStream.getReader();
    const decoder = new TextDecoder();
    let fullBody = '';
    let buffer = '';

    try {
      // Send initial metadata
      await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'meta', reportType, clientName })}\n\n`));

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                fullBody += parsed.delta.text;
                await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: parsed.delta.text })}\n\n`));
              }
            } catch { /* skip non-JSON lines */ }
          }
        }
      }

      // Send complete HTML
      const crossLinks = buildCrossLinks(reportType, clientName, baseUrl);
      const finalHtml = fillTemplate({
        REPORT_TITLE: reportLabels[reportType],
        CLIENT_NAME: clientName,
        REPORT_PERIOD: getReportPeriod(),
        GENERATED_DATE: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
        REPORT_TYPE_LABEL: reportLabels[reportType],
        REPORT_BODY: fullBody,
        CROSS_LINKS: crossLinks
      });

      await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'complete', html: finalHtml, body: fullBody })}\n\n`));
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (err) {
      await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ── COMPLETE REPORT (NON-STREAMING) ──────────────────────────────────────────

async function handleCompleteReport(config, reportType, clientName, anthropicKey, baseUrl) {
  const reportLabels = {
    serp: 'SERP & ORM Analysis',
    llm: 'LLM Reputation Intelligence',
    social: 'Social Media Intelligence',
    executive: 'Executive Summary'
  };

  const body = await callClaude(config.systemPrompt, config.userPrompt, anthropicKey);
  const crossLinks = buildCrossLinks(reportType, clientName, baseUrl);

  const html = fillTemplate({
    REPORT_TITLE: reportLabels[reportType],
    CLIENT_NAME: clientName,
    REPORT_PERIOD: getReportPeriod(),
    GENERATED_DATE: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    REPORT_TYPE_LABEL: reportLabels[reportType],
    REPORT_BODY: body,
    CROSS_LINKS: crossLinks
  });

  return new Response(JSON.stringify({ html, body, reportType }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ── GENERATE ALL FLOW: SERP → LLM → SOCIAL → EXECUTIVE ─────────────────────

async function handleGenerateAll(params, baseUrl) {
  const { clientName, keywords, sheetUrl, previousReport, anthropicKey, dfLogin, dfPassword, xpozApiKey } = params;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = async (data) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  const reportLabels = {
    serp: 'SERP & ORM Analysis',
    llm: 'LLM Reputation Intelligence',
    social: 'Social Media Intelligence',
    executive: 'Executive Summary'
  };

  (async () => {
    const reports = {};
    const order = ['serp', 'llm', 'social', 'executive'];

    try {
      for (const type of order) {
        await send({ type: 'status', report: type, status: 'generating', label: reportLabels[type] });

        let config;
        switch (type) {
          case 'serp':
            config = await generateSERPReport(clientName, keywords, sheetUrl, previousReport, anthropicKey);
            break;
          case 'llm':
            config = await generateLLMReport(clientName, keywords, dfLogin, dfPassword, previousReport, anthropicKey);
            break;
          case 'social':
            config = await generateSocialReport(clientName, keywords, xpozApiKey, previousReport, anthropicKey);
            break;
          case 'executive':
            config = await generateExecutiveReport(
              clientName, keywords,
              reports.serp?.body || '',
              reports.llm?.body || '',
              reports.social?.body || '',
              previousReport, anthropicKey
            );
            break;
        }

        // Generate report (non-streaming for sequential flow)
        const body = await callClaude(config.systemPrompt, config.userPrompt, anthropicKey);
        const crossLinks = buildCrossLinks(type, clientName, baseUrl);
        const html = fillTemplate({
          REPORT_TITLE: reportLabels[type],
          CLIENT_NAME: clientName,
          REPORT_PERIOD: getReportPeriod(),
          GENERATED_DATE: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
          REPORT_TYPE_LABEL: reportLabels[type],
          REPORT_BODY: body,
          CROSS_LINKS: crossLinks
        });

        reports[type] = { html, body };

        await send({
          type: 'report_complete',
          report: type,
          label: reportLabels[type],
          html,
          bodyPreview: body.slice(0, 500)
        });
      }

      await send({ type: 'all_complete', reports: Object.keys(reports) });
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (err) {
      await send({ type: 'error', message: err.message });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
