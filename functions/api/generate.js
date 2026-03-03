// functions/api/generate.js — Reputation Citadel Report Generator
// Shared CSS + HTML templates for consistent reports across all types

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("X-Admin-Password");
  if (auth !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { clientId, clientName, type, keywords, sheetUrl, previousReportId, linkedReports } = body;
  if (!clientId || !clientName || !type) return json({ error: "Missing required fields" }, 400);

  try {
    const typeNames = { serp: "SERP & ORM Analysis", social: "Social Media Intelligence", llm: "LLM Reputation Intelligence", executive: "Executive Summary" };
    let dataPayload = "";
    const reportDate = new Date().toISOString().split("T")[0];
    const kw = keywords || clientName;

    // ── Fetch data based on report type ──
    if ((type === "serp" || type === "executive") && sheetUrl) {
      const sd = await fetchGoogleSheet(sheetUrl);
      dataPayload += sd ? `\n=== GOOGLE SHEET DATA ===\n${sd}\n` : "\n=== GOOGLE SHEET ===\nUnable to fetch.\n";
    }
    if ((type === "llm" || type === "executive") && env.DATAFORSEO_LOGIN) {
      const ld = await fetchLLMResponses(kw, env.DATAFORSEO_LOGIN, env.DATAFORSEO_PASSWORD);
      dataPayload += `\n=== LLM RESPONSES DATA ===\n${JSON.stringify(ld, null, 2)}\n`;
    }
    if (type === "social" || type === "executive") {
      let xpozKey = body.xpozToken || env.XPOZ_API_KEY;
      if (!xpozKey) {
        try {
          const stored = await env.CITADEL_KV.get("xpoz-oauth-token");
          if (stored) xpozKey = JSON.parse(stored).access_token;
        } catch {}
      }
      const tfDays = body.timeframeDays || 30;
      if (xpozKey) {
        // Collect data directly from Xpoz MCP (fast, ~15s)
        try {
          const sd = await fetchXpozDirect(kw, clientName, xpozKey, tfDays);
          const tCount = sd.twitter.filter(p => !p._error).length;
          const rCount = sd.reddit.filter(p => !p._error).length;
          const iCount = sd.instagram.filter(p => !p._error).length;
          dataPayload += `\n=== SOCIAL MEDIA DATA (from Xpoz) ===`;
          dataPayload += `\nQuery: "${sd.meta.query}" | Period: ${sd.meta.startDate} to ${sd.meta.endDate}`;
          dataPayload += `\nTotal posts found: Twitter=${tCount}, Reddit=${rCount}, Instagram=${iCount}`;
          dataPayload += `\n\n--- ALL TWITTER POSTS (${tCount} total — analyze every single one) ---\n${JSON.stringify(sd.twitter, null, 1)}`;
          dataPayload += `\n\n--- ALL REDDIT POSTS (${rCount} total — analyze every single one) ---\n${JSON.stringify(sd.reddit, null, 1)}`;
          dataPayload += `\n\n--- ALL INSTAGRAM POSTS (${iCount} total — analyze every single one) ---\n${JSON.stringify(sd.instagram, null, 1)}\n`;
        } catch (e) {
          dataPayload += `\n=== SOCIAL MEDIA DATA ===\nXpoz collection error: ${e.message}\n`;
          const sd = await fetchSocialDataFallback(kw, clientName);
          dataPayload += JSON.stringify(sd, null, 2) + "\n";
        }
      } else {
        const sd = await fetchSocialDataFallback(kw, clientName);
        dataPayload += `\n=== SOCIAL MEDIA DATA ===\n${JSON.stringify(sd, null, 2)}\n`;
      }
      dataPayload += `\nTimeframe for social analysis: last ${tfDays} days (${new Date(Date.now() - tfDays * 86400000).toISOString().split("T")[0]} to ${new Date().toISOString().split("T")[0]})\n`;
    }
    if (type === "executive" && linkedReports) {
      const base = new URL(request.url).origin;
      let lnk = "\n=== LINKED REPORTS ===\nAdd 'View Full Report' buttons in each section:\n";
      if (linkedReports.serp) lnk += `SERP: ${base}/share/${linkedReports.serp.shareToken}\n`;
      if (linkedReports.llm) lnk += `LLM: ${base}/share/${linkedReports.llm.shareToken}\n`;
      if (linkedReports.social) lnk += `Social: ${base}/share/${linkedReports.social.shareToken}\n`;
      dataPayload += lnk;
    }
    if (previousReportId) {
      try { const p = await env.CITADEL_KV.get(`report-html:${previousReportId}`); if (p) dataPayload += `\n=== PREVIOUS REPORT ===\n${p.substring(0, 15000)}\n`; } catch {}
    }

    const systemPrompt = buildSystemPrompt(type);
    const userPrompt = buildUserPrompt(clientName, type, kw, reportDate, dataPayload);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "No API key" }, 400);

    let html;
    // All reports use streaming — social data is pre-collected above
    html = await callClaudeStream(env.ANTHROPIC_API_KEY, systemPrompt, userPrompt);
    html = html.trim();
    if (html.startsWith("```")) html = html.replace(/^```(?:html)?\n?/, "").replace(/\n?```$/, "");

    const shareToken = genTok();
    const reportId = `r_${Date.now()}`;
    const meta = { id: reportId, clientId, clientName, type, typeName: typeNames[type] || type, keywords: kw, sheetUrl: sheetUrl || "", createdAt: new Date().toISOString(), shareToken, status: "complete" };
    await env.CITADEL_KV.put(`report-html:${reportId}`, html, { expirationTtl: 31536000 });
    await env.CITADEL_KV.put(`report:${reportId}`, JSON.stringify(meta), { expirationTtl: 31536000 });
    await env.CITADEL_KV.put(`share:${shareToken}`, reportId, { expirationTtl: 31536000 });
    let idx = []; try { const e = await env.CITADEL_KV.get("reports-index"); if (e) idx = JSON.parse(e); } catch {}
    idx.unshift(meta);
    await env.CITADEL_KV.put("reports-index", JSON.stringify(idx));
    return json({ success: true, report: meta });
  } catch (err) { return json({ error: `Generation failed: ${err.message}` }, 500); }
}

// ═══════════════════════════════════════
// DATA FETCHERS
// ═══════════════════════════════════════

async function fetchGoogleSheet(sheetUrl) {
  const m = sheetUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const id = m[1], tabs = {};
  const fmts = [
    g => `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${g}`,
    g => `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${g}`,
  ];
  for (const gid of ["0", "1", "2", "3"]) {
    for (const fn of fmts) {
      try {
        const r = await fetch(fn(gid), { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
        if (!r.ok) continue;
        const csv = await r.text();
        if (!csv || csv.length < 50 || csv.includes("<!DOCTYPE")) continue;
        const fl = csv.split("\n")[0].toLowerCase();
        let tn = `Tab_gid${gid}`;
        if (fl.includes("rank") || fl.includes("snapshot") || fl.includes("keyword")) tn = `SERP_gid${gid}`;
        else if (fl.includes("content") || fl.includes("live url")) tn = `Content_gid${gid}`;
        const lines = csv.split("\n");
        if (lines.length > 200) {
          const hdr = lines[0], dateRows = {};
          for (let i = 1; i < lines.length; i++) {
            const d = lines[i].split(",")[0].replace(/"/g, "").trim();
            if (d && d.match(/\d/)) { if (!dateRows[d]) dateRows[d] = []; dateRows[d].push(lines[i]); }
          }
          const sorted = Object.keys(dateRows).sort((a, b) => new Date(b) - new Date(a));
          const latest = sorted[0], lm = new Date(latest).getMonth(), ly = new Date(latest).getFullYear();
          let prev = null;
          for (const d of sorted) { const dt = new Date(d); if (dt.getMonth() !== lm || dt.getFullYear() !== ly) { prev = d; break; } }
          const filt = [hdr, ...(dateRows[latest] || [])];
          if (prev && dateRows[prev]) filt.push(...dateRows[prev]);
          tabs[tn] = filt.join("\n");
        } else { tabs[tn] = csv; }
        break;
      } catch {}
    }
  }
  if (!Object.keys(tabs).length) return null;
  let out = "";
  for (const [n, c] of Object.entries(tabs)) out += `\n--- ${n} (${c.split("\n").length} rows) ---\n${c}\n`;
  return out;
}

async function fetchLLMResponses(keywords, login, password) {
  const auth = btoa(`${login}:${password}`);
  const kws = keywords.split(",").map(k => k.trim()).filter(Boolean);
  const queries = [];
  for (const kw of kws.slice(0, 2)) { queries.push(`Who is ${kw}?`); queries.push(`What do you know about ${kw}?`); queries.push(`${kw} reputation`); }
  const results = { chatgpt: [], gemini: [], claude: [], perplexity: [] };
  const platforms = [
    { key: "chatgpt", path: "chat_gpt", model: "gpt-4o-mini" },
    { key: "gemini", path: "gemini", model: "gemini-2.0-flash" },
    { key: "claude", path: "claude", model: "claude-sonnet-4-20250514" },
  ];
  for (const p of platforms) {
    for (const q of queries.slice(0, 2)) {
      try {
        const r = await fetch(`https://api.dataforseo.com/v3/ai_optimization/${p.path}/llm_responses/live`, {
          method: "POST",
          headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
          body: JSON.stringify([{ user_prompt: q, model_name: p.model, max_output_tokens: 500, web_search: true }])
        });
        if (r.ok) {
          const d = await r.json();
          const t = d?.tasks?.[0];
          if (t?.status_code === 20000 && t?.result) {
            for (const x of t.result) {
              let txt = "", anns = [];
              if (x.items) for (const it of x.items) if (it.sections) for (const s of it.sections) { if (s.text) txt += s.text + "\n"; if (s.annotations) anns.push(...s.annotations); }
              if (!txt) txt = x.response_text || x.text || "";
              results[p.key].push({ query: q, response_text: txt, fan_out_queries: x.fan_out_queries || [], annotations: anns.length ? anns : (x.annotations || []), model: p.model });
            }
          }
        }
      } catch (e) { results[p.key].push({ query: q, error: e.message }); }
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return results;
}

// ═══════════════════════════════════════
// CLAUDE API CALLS
// ═══════════════════════════════════════

async function callClaudeStream(apiKey, system, user) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 64000, stream: true, system, messages: [{ role: "user", content: user }] })
  });
  if (!r.ok) { const e = await r.text(); throw new Error(`Claude ${r.status}: ${e.substring(0, 200)}`); }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let txt = "", buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const ln of lines) {
      if (!ln.startsWith("data: ")) continue;
      const d = ln.slice(6).trim();
      if (d === "[DONE]") continue;
      try { const p = JSON.parse(d); if (p.type === "content_block_delta" && p.delta?.type === "text_delta") txt += p.delta.text; } catch {}
    }
  }
  if (!txt) throw new Error("Empty response from Claude");
  return txt;
}

function genTok() { const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join(""); }

// Claude with web_search tool — agentic loop for social reports
async function callClaudeWithWebSearch(apiKey, system, userContent) {
  const messages = [{ role: "user", content: userContent }];
  let finalText = "";

  for (let turn = 0; turn < 10; turn++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 64000,
        system,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      })
    });
    if (!r.ok) { const e = await r.text(); throw new Error(`Claude ${r.status}: ${e.substring(0, 300)}`); }
    const data = await r.json();

    let turnText = "";
    for (const block of data.content) {
      if (block.type === "text") turnText += block.text;
    }
    finalText += turnText;

    if (data.stop_reason === "end_turn") break;

    // If Claude used web_search, the API handles it server-side and continues
    // We just need to pass the full content back for multi-turn
    messages.push({ role: "assistant", content: data.content });

    // Check if there are tool_use blocks that need results
    const toolUses = data.content.filter(b => b.type === "tool_use");
    if (toolUses.length === 0) break;

    // For server-side tools like web_search, the API handles execution
    // But we still need to continue the conversation
    const toolResults = toolUses.map(t => ({
      type: "tool_result",
      tool_use_id: t.id,
      content: "Search completed"
    }));
    messages.push({ role: "user", content: toolResults });
  }

  if (!finalText) throw new Error("Empty response from Claude");
  return finalText;
}

// ── Direct Xpoz MCP — fast data collection ──
async function xpozRpc(token, method, params = {}) {
  const hdrs = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": `Bearer ${token}` };
  const r = await fetch("https://mcp.xpoz.ai/mcp", {
    method: "POST", headers: hdrs,
    body: JSON.stringify({ jsonrpc: "2.0", id: String(Date.now()), method, params })
  });
  const text = await r.text();
  const ct = r.headers.get("Content-Type") || "";
  if (ct.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          const p = JSON.parse(line.slice(6));
          if (p.result) return p.result;
          if (p.error) return { error: JSON.stringify(p.error) };
        } catch {}
      }
    }
  }
  if (!r.ok) return { error: `HTTP ${r.status}: ${text.substring(0, 200)}` };
  try { const j = JSON.parse(text); return j.result || j; } catch { return { raw: text }; }
}

function extractMcpText(result) {
  if (!result) return "";
  if (result.error) return `Error: ${result.error}`;
  if (result.content && Array.isArray(result.content)) {
    return result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  }
  return JSON.stringify(result);
}

async function fetchXpozDirect(keywords, clientName, xpozToken, timeframeDays = 30) {
  await xpozRpc(xpozToken, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "citadel", version: "1.0" } });
  fetch("https://mcp.xpoz.ai/mcp", { method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${xpozToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  }).catch(() => {});

  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - timeframeDays * 86400000).toISOString().split("T")[0];

  // Convert multi-word keywords to AND query
  const queryTerms = keywords.split(",").map(k => k.trim()).filter(Boolean);
  const xpozQueries = queryTerms.map(term => {
    const words = term.split(/\s+/).filter(Boolean);
    return words.length > 1 ? words.join(" AND ") : term;
  });
  const mainQuery = xpozQueries[0] || keywords;

  const data = { twitter: [], reddit: [], instagram: [], meta: { query: mainQuery, startDate, endDate, timeframeDays } };

  // Twitter
  try {
    const tw = await xpozRpc(xpozToken, "tools/call", { name: "getTwitterPostsByKeywords", arguments: {
      query: mainQuery, startDate, endDate,
      fields: ["id", "text", "authorUsername", "createdAtDate", "likeCount", "retweetCount", "replyCount", "impressionCount"],
      userPrompt: `Find tweets about "${keywords}" for reputation monitoring`
    }});
    const twText = extractMcpText(tw);
    data.twitter = parseXpozCompact(twText).results;
  } catch (e) { data.twitter = [{ _error: e.message }]; }

  // Reddit
  try {
    const rd = await xpozRpc(xpozToken, "tools/call", { name: "getRedditPostsByKeywords", arguments: {
      query: mainQuery, startDate, endDate,
      fields: ["id", "title", "selftext", "authorUsername", "subredditName", "score", "commentsCount", "permalink", "createdAtDate"],
      userPrompt: `Find Reddit posts about "${keywords}" for reputation monitoring`
    }});
    const rdText = extractMcpText(rd);
    data.reddit = parseXpozCompact(rdText).results;
  } catch (e) { data.reddit = [{ _error: e.message }]; }

  // Instagram
  try {
    const ig = await xpozRpc(xpozToken, "tools/call", { name: "getInstagramPostsByKeywords", arguments: {
      query: mainQuery, startDate, endDate,
      fields: ["id", "caption", "username", "createdAtDate", "likeCount", "commentCount", "codeUrl"],
      userPrompt: `Find Instagram posts about "${keywords}" for reputation monitoring`
    }});
    const igText = extractMcpText(ig);
    data.instagram = parseXpozCompact(igText).results;
  } catch (e) { data.instagram = [{ _error: e.message }]; }

  // Add URLs to each post
  for (const p of data.twitter) { if (p.id && p.authorUsername) p.url = `https://x.com/${p.authorUsername}/status/${p.id}`; }
  for (const p of data.reddit) { if (p.permalink) p.url = `https://reddit.com${p.permalink}`; }
  for (const p of data.instagram) { if (p.codeUrl) p.url = `https://instagram.com/p/${p.codeUrl}`; }

  return data;
}

// Parse Xpoz compact text format into structured array
function parseXpozCompact(text) {
  if (!text || typeof text !== "string") return { results: [], count: 0 };
  const lines = text.split("\n");
  let fields = [];
  let count = 0;
  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "success: true" || trimmed === "success: false" || trimmed === "data:") continue;
    const hdr = trimmed.match(/^results\[(\d+)\]\{([^}]+)\}:$/);
    if (hdr) { count = parseInt(hdr[1]); fields = hdr[2].split(","); continue; }
    if (fields.length > 0 && !trimmed.startsWith("results[") && !trimmed.startsWith("guidance:") && !trimmed.startsWith("note:") && !trimmed.startsWith("To get")) {
      const row = {};
      let rem = trimmed;
      for (let i = 0; i < fields.length; i++) {
        rem = rem.trimStart();
        if (rem.startsWith('"')) {
          let end = 1;
          while (end < rem.length) { if (rem[end] === '\\' && end + 1 < rem.length) { end += 2; continue; } if (rem[end] === '"') break; end++; }
          row[fields[i]] = rem.substring(1, end).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
          rem = rem.substring(end + 1).replace(/^,/, "");
        } else {
          const ci = rem.indexOf(",");
          if (ci === -1) { row[fields[i]] = rem; rem = ""; }
          else { row[fields[i]] = rem.substring(0, ci); rem = rem.substring(ci + 1); }
        }
      }
      if (Object.keys(row).length > 0) results.push(row);
    }
  }
  return { count, results, parsed: results.length };
}

// Fallback social data (no Xpoz token) — Reddit public API only
async function fetchSocialDataFallback(keywords, clientName) {
  const data = { reddit_posts: [], reddit_comments: [], twitter_note: "Twitter data requires Xpoz connection. Connect via Settings > Xpoz.", summary: "" };
  const kws = keywords.split(",").map(k => k.trim()).filter(Boolean);
  for (const kw of kws.slice(0, 2)) {
    try {
      const q = encodeURIComponent(kw);
      const r = await fetch(`https://www.reddit.com/search.json?q=${q}&sort=relevance&t=year&limit=25`, {
        headers: { "User-Agent": "ReputationCitadel/1.0" }
      });
      if (r.ok) {
        const d = await r.json();
        for (const p of (d?.data?.children || [])) {
          data.reddit_posts.push({
            title: p.data.title, subreddit: p.data.subreddit_name_prefixed,
            author: p.data.author, score: p.data.score, num_comments: p.data.num_comments,
            created: new Date(p.data.created_utc * 1000).toISOString().split("T")[0],
            url: `https://reddit.com${p.data.permalink}`,
            selftext: (p.data.selftext || "").substring(0, 300),
          });
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  data.summary = `Found ${data.reddit_posts.length} Reddit posts for "${keywords}". Twitter/Instagram data unavailable without Xpoz.`;
  return data;
}
function json(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); }

// ═══════════════════════════════════════
// SHARED CSS (all report types use this)
// ═══════════════════════════════════════

const CSS = `:root{--bg:#fff;--card:#f0f3f8;--card-border:#d4dae6;--navy:#1b2a4a;--navy-light:#2c4170;--red:#c0392b;--amber:#d4880f;--green:#1e8449;--text:#1e293b;--muted:#5a6a85;--border:#d4dae6;--header-bg:#000;--owned-gold:#b8860b;--chatgpt:#10a37f;--claude:#d97706;--gemini:#4285f4;--perplexity:#20808d}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;color:var(--text);background:var(--bg);line-height:1.6}
h1,h2,h3{font-family:Georgia,serif;color:var(--navy)}
.header{background:var(--header-bg);padding:32px 48px;display:flex;align-items:center;gap:24px}
.header img{height:50px}.header .divider{width:1px;height:60px;background:rgba(255,255,255,.3)}
.header .title{color:#fff}.header h1{font-size:1.6rem;color:#fff;margin-bottom:4px}
.header .sub{color:#8899b4;font-size:.9rem;font-family:'Segoe UI',sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:32px 24px}
.sec{margin-bottom:40px}
.sec-title{font-size:1.3rem;color:var(--navy);border-bottom:3px solid var(--navy);padding-bottom:8px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--card-border);border-radius:10px;padding:24px;margin-bottom:16px}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.g2{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.st{background:#fff;border:1px solid var(--card-border);border-radius:8px;padding:20px;text-align:center}
.st .n{font-size:2rem;font-weight:700;font-family:Georgia,serif}
.st .l{font-size:.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-top:4px}
.n-bl{color:var(--navy)}.n-gr{color:var(--green)}.n-rd{color:var(--red)}.n-am{color:var(--amber)}
table.dt{width:100%;border-collapse:collapse}
.dt th{text-align:left;font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted);padding:10px 12px;background:rgba(27,42,74,.04);border-bottom:2px solid var(--border)}
.dt td{padding:10px 12px;border-bottom:1px solid var(--border);font-size:.88rem}
.dt a{color:var(--navy);text-decoration:none;border-bottom:1px dotted var(--navy)}
.tg{display:inline-block;padding:3px 10px;border-radius:4px;font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.tg-gr{background:rgba(30,132,73,.12);color:var(--green)}
.tg-rd{background:rgba(192,57,43,.12);color:var(--red)}
.tg-am{background:rgba(212,136,15,.12);color:var(--amber)}
.tg-bl{background:rgba(27,42,74,.12);color:var(--navy)}
.tg-gd{background:rgba(184,134,11,.12);color:var(--owned-gold)}
.own-row{border-left:3px solid var(--owned-gold);background:#fdf8ef}
.neg-row{background:rgba(192,57,43,.05)}
.pos-row{background:rgba(30,132,73,.05)}
.mv-up{color:var(--green);font-weight:700}
.mv-dn{color:var(--red);font-weight:700}
.mv-st{color:var(--muted)}
.mv-nw{color:var(--navy);font-style:italic}
.star{color:var(--owned-gold)}
.bar-c{display:flex;height:28px;border-radius:6px;overflow:hidden;margin:12px 0}
.bar-s{display:flex;align-items:center;justify-content:center;color:#fff;font-size:.75rem;font-weight:600}
.rg{text-align:center;margin:20px 0}
.rg .sc{font-size:4rem;font-weight:700;font-family:Georgia,serif}
.rg .lv{font-size:1.1rem;font-weight:600;text-transform:uppercase;letter-spacing:2px;margin-top:4px}
.rb{height:12px;border-radius:6px;background:linear-gradient(to right,var(--green),var(--amber),var(--red));position:relative;margin:16px 0}
.rm{width:18px;height:18px;background:var(--navy);border:3px solid #fff;border-radius:50%;position:absolute;top:-3px;transform:translateX(-50%)}
.rt{width:100%;border-collapse:collapse;margin-top:16px}
.rt th{text-align:left;font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted);padding:8px 12px;border-bottom:2px solid var(--border)}
.rt td{padding:10px 12px;border-bottom:1px solid var(--border);font-size:.9rem}
.qc{background:#fff;border:1px solid var(--card-border);border-radius:10px;padding:24px;margin-bottom:20px}
.qc h3{font-size:1rem;color:var(--navy);margin-bottom:16px;padding:10px 16px;background:var(--card);border-radius:6px;font-style:italic}
.pg{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-bottom:16px}
.pb{border:1px solid var(--card-border);border-radius:8px;padding:16px;border-top:3px solid var(--muted)}
.pb.chatgpt{border-top-color:var(--chatgpt)}.pb.claude{border-top-color:var(--claude)}.pb.gemini{border-top-color:var(--gemini)}.pb.perplexity{border-top-color:var(--perplexity)}
.pb .pn{font-weight:700;font-size:.8rem;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.pb .pn.chatgpt{color:var(--chatgpt)}.pb .pn.claude{color:var(--claude)}.pb .pn.gemini{color:var(--gemini)}.pb .pn.perplexity{color:var(--perplexity)}
.pb p{font-size:.88rem;margin-bottom:8px}
.thm{font-size:.85rem;color:var(--muted);margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}
.tl{padding:16px 0 16px 32px;border-left:3px solid var(--navy);position:relative;margin-left:12px}
.tl::before{content:'';width:12px;height:12px;background:var(--navy);border-radius:50%;position:absolute;left:-7.5px;top:20px}
.tl.red::before{background:var(--red)}
.al{list-style:none;counter-reset:a}
.al li{counter-increment:a;padding:12px 16px 12px 48px;position:relative;border-bottom:1px solid var(--border);font-size:.92rem}
.al li::before{content:counter(a);position:absolute;left:12px;top:12px;width:24px;height:24px;background:var(--navy);color:#fff;border-radius:50%;text-align:center;line-height:24px;font-size:.75rem;font-weight:700}
.vr-btn{display:inline-block;margin-top:16px;padding:10px 24px;background:var(--navy);color:#fff;text-decoration:none;border-radius:6px;font-size:.9rem}
.vr-btn:hover{background:var(--navy-light)}
.ft{text-align:center;padding:32px 24px;border-top:3px solid var(--navy);margin-top:48px;color:var(--muted);font-size:.85rem}
.conf{color:var(--red);font-weight:700;text-transform:uppercase;letter-spacing:2px;font-size:.8rem;margin-top:12px}
@media(max-width:700px){.g3,.g2,.pg{grid-template-columns:1fr}.header{flex-direction:column;text-align:center;padding:24px}}`;

// ═══════════════════════════════════════
// PROMPT BUILDERS
// ═══════════════════════════════════════

const LOGO = "https://citadel-dashboard.pages.dev/logo.png";

function buildUserPrompt(clientName, type, kw, date, data) {
  return `Client: ${clientName}
Type: ${type}
Keywords: ${kw}
Date: ${date}

${data}

CRITICAL RULES:
- Output ONLY complete HTML. No markdown fences. No commentary before or after.
- Fill ALL sections with real data analysis. No placeholders or "data unavailable".
- Tables must have actual data rows from the provided data.
- 15,000-40,000 characters minimum for a thorough report.
- PERIOD: If one date snapshot provided = baseline report (label as that date only). If two date snapshots from different months = monthly comparison report.
- Reports are monthly, produced on the 1st of each month.`;
}

function buildSystemPrompt(type) {
  const hdr = `<div class="header"><img src="${LOGO}" alt="Reputation Citadel"><div class="divider"></div><div class="title">`;
  const cssTag = `<style>${CSS}</style>`;

  if (type === "serp") return buildSerpPrompt(cssTag, hdr);
  if (type === "social") return buildSocialPrompt(cssTag, hdr);
  if (type === "llm") return buildLlmPrompt(cssTag, hdr);
  return buildExecPrompt(cssTag, hdr);
}

function buildSerpPrompt(css, hdr) {
  return `You are an ORM analyst for Reputation Citadel. Generate a SERP & ORM Analysis Report in HTML.

Parse the SERP CSV data. Compute ownership %, sentiment distribution, negative exposure, movement.
TONE: Client-facing, professional. Use "Mr./Ms. [Last Name]". Negatives are "exposure areas". Encouraging but honest.

USE THIS EXACT HTML STRUCTURE — same classes, same order, every time:

${css}

STRUCTURE (do not deviate):
${hdr}<h1>SERP &amp; Online Reputation Report</h1><div class="sub"><strong>[CLIENT]</strong> · [KEYWORD] · [DATE]</div></div></div>
<div class="wrap">

SEC 1 — Executive Summary: div.sec > h2.sec-title + div.card > p

SEC 2 — Key Metrics Dashboard: div.sec > h2.sec-title + div.g3 (row 1: SERP Results Analyzed n-bl | Owned in Top 10 n-gr | Negative in Top 10 n-rd) + div.g3 (row 2: Positive % n-gr | Negative % n-rd | Page 1 Control % n-bl/n-am/n-gr)
Each stat: <div class="st"><div class="n [COLOR]">[VALUE]</div><div class="l">[LABEL]</div></div>

SEC 3 — Trend Analysis: ONLY if two snapshots from different months. Use dt table with arrows.

SEC 4 — SERP Ownership Map: table.dt with <tr class="own-row/neg-row/pos-row">. Columns: # | Title | Domain | Sentiment (tg) | Owned (★ or blank) | Movement (mv-up/mv-dn/mv-st/mv-nw)

SEC 5 — Sentiment Analysis: div.bar-c > div.bar-s segments (green/muted/red). Below: table.dt (Sentiment tg | Count | % | Key URLs)

SEC 6 — Owned Content Performance: table.dt with own-row. Below: card "Content Created but Not Ranking"

SEC 7 — Negative Exposure Analysis: table.dt with neg-row. Columns: # | Movement | Title | Domain | Category (tg-rd)

SEC 8 — Unowned Positive Results: table.dt with pos-row

SEC 9 — Action Items: ol.al > li using "We will..." framing. 4-6 items max.

</div>
<div class="ft">Reputation Citadel · SERP & Online Reputation Report · Generated [DATE]<br><div class="conf">Confidential — Prepared for Client Use Only</div></div>

Output ONLY the completed HTML.`;
}

function buildSocialPrompt(css, hdr) {
  return `You are a social media intelligence analyst for Reputation Citadel. Generate a Social Media Intelligence Report in HTML.

DATA PROVIDED: You receive structured JSON arrays of social media posts collected via the Xpoz platform. The data includes Twitter/X posts, Reddit posts, and Instagram posts. Each post has engagement metrics, author info, dates, and direct URLs.

CRITICAL — COMPREHENSIVE ANALYSIS: You are given the COMPLETE dataset. You must analyze EVERY SINGLE POST provided — do not skip, summarize away, or selectively present posts. The report must account for all posts in the data. Your metrics (post counts, sentiment percentages, engagement totals) must reflect the ENTIRE dataset. If there are 15 relevant Twitter posts, the report must reference all 15 — not a "representative sample."

CRITICAL — STRICT RELEVANCE FILTERING: The data may contain false positives — posts matching individual words but NOT about the client. Discard any post that does NOT genuinely reference the specific person/entity. For "Murry Gunty", exclude posts about "Bill Murray", "Murry Christmas", etc. Report FILTERED counts only. Clearly state: "X posts found, Y confirmed relevant after filtering."

CRITICAL — DETERMINISTIC RESULTS: Your analysis must be consistent. Given the same data, produce the same conclusions. Base all metrics strictly on the data provided — do not estimate or approximate. Count exact numbers.

CRITICAL — POST LINKS: Every post referenced must link to its URL. For Twitter: use the url field. For Reddit: use the url field. For Instagram: use the url field. The "Most Engaged Posts" table MUST include clickable links for EVERY row.`;

TIMEFRAME: The data covers a specific date range provided in the metadata. Reference this timeframe in the report header and executive summary (e.g., "Analysis Period: Feb 1 - Mar 1, 2026").

Categorize every mention by sentiment: Positive, Neutral/Mixed, Negative. Identify the top most-engaged posts. Identify key voices. Build a timeline. Assess risk: Low / Medium / Elevated / High / Critical.

TONE: Professional, neutral. "Mr./Ms. [Last Name]". Sanitize profanity with [expletive]. No inflammatory words (firestorm, toxic, slammed). Use: heightened scrutiny, concerns raised, online discussion.

USE THIS EXACT HTML STRUCTURE:

${css}

STRUCTURE:
${hdr}<h1>Social Media Intelligence Report</h1><div class="sub"><strong>[CLIENT]</strong> · [PLATFORMS] · [DATE]</div></div></div>
<div class="wrap">

SEC 1 — Executive Summary: div.card > p

SEC 2 — Key Metrics: two div.g3 rows of div.st
Row 1: Posts Found (n-bl) | Negative Sentiment % (n-rd) | Total Impressions (n-am)
Row 2: Platforms Analyzed (n-bl) | Key Voices Identified (n-bl) | Risk Level (n-gr/n-am/n-rd)

SEC 3 — Sentiment Analysis: div.bar-c + table.dt (Category | Sentiment tg | Volume | Themes)

SEC 4 — Most Engaged Posts: table.dt (Date | Author | Platform | Engagement | Post). The "Post" column MUST be a clickable <a href="[post url]" target="_blank"> link with a short excerpt or title. Every row must link to the actual post.

SEC 5 — Timeline of Key Events: div.tl items (use class="tl red" for crisis moments)

SEC 6 — Risk Analysis: div.rb (gradient bar) with div.rm (marker at left:XX%). Below: div.g2 for Critical/Elevated risks. div.card for Mitigating Factors.

SEC 7 — Key Voices: table.dt (Account | Platform | Sentiment tg | Reach/Followers)

SEC 8 — Platform Breakdown: div.g2 > div.card per platform with stats

SEC 9 — Action Items: ol.al > li with "We will..." framing. 4-6 items.

</div>
<div class="ft">Reputation Citadel · Social Media Intelligence Report · Generated [DATE]<br><div class="conf">Confidential — Prepared for Client Use Only</div></div>

Output ONLY the completed HTML.`;
}

function buildLlmPrompt(css, hdr) {
  return `You are an AI Reputation Intelligence analyst for Reputation Citadel. Generate an LLM Reputation Intelligence Report in HTML.

Analyze how ChatGPT, Claude, Gemini, Perplexity represent the client. Classify sentiment per platform (Positive/Neutral/Mixed/Negative). Analyze fan-out queries. Track sources. Compute AI Risk Score 1-100 (0-25 LOW green, 26-50 MODERATE amber, 51-75 HIGH red, 76-100 CRITICAL red).

Risk Score factors: negative sentiment prevalence (30%), prominence of negative content (25%), dangerous fan-out queries (15%), negative source frequency (15%), cross-platform consistency of negatives (15%).

TONE: Professional. "Mr./Ms. [Last Name]". Negatives = "exposure" or "narrative risk".

USE THIS EXACT HTML STRUCTURE:

${css}

STRUCTURE:
${hdr}<h1>LLM Reputation Intelligence Report</h1><div class="sub"><strong>[CLIENT]</strong> · ChatGPT, Claude, Gemini, Perplexity · [DATE]</div></div></div>
<div class="wrap">

SEC 1 — Executive Summary: div.card > p

SEC 2 — AI Reputation Risk Score: div.card > div.rg (div.sc [SCORE] + div.lv [LEVEL]) + div.rb with div.rm at left:[SCORE]%. Below: table.rt — columns: Risk Factor | Finding (PLAIN LANGUAGE like "2 dangerous queries found", "Negative on 3 of 4 platforms") | Level (tg-gr Low / tg-am Medium / tg-rd High). NEVER show weighted scores like "10/15".

SEC 3 — Key Metrics: two div.g3 rows of div.st
Row 1: Queries Analyzed (n-bl) | Platforms Covered (n-bl) | Overall Sentiment (n-gr/n-am/n-rd)
Row 2: Owned Sources Cited % (n-gr/n-am) | Negative Narratives (n-rd) | Dangerous Fan-Out Queries (n-rd)

SEC 4 — Cross-Platform Sentiment Matrix: table.dt — Query | ChatGPT (tg) | Claude (tg) | Gemini (tg) | Perplexity (tg) | Consistency. Below: "Most Favorable: X · Most Negative: X · Average: X%"

SEC 5 — LLM Response Analysis: FOR EACH QUERY: div.qc > h3 "[query]" + div.pg with 4x div.pb (classes chatgpt/claude/gemini/perplexity) each with div.pn + p + tg. After grid: div.thm with Themes + Sources.

SEC 6 — Fan-Out Query Analysis: table.dt (Query | Platform | Intent | Risk tg). Below: "Content Opportunities: ..."

SEC 7 — Source & Ownership: table.dt (Domain | Frequency | Owned | Sentiment tg) + div.g3 stats (Total / Owned % / Negative)

SEC 8 — Negative Content Propagation: Per source: domain (bold red) + description + "Platforms: X · Prominence: HIGH/MED/LOW". Bottom: Propagation Score.

SEC 9 — Action Items: ol.al > li with "We will..." framing. 4-6 items.

</div>
<div class="ft">Reputation Citadel · LLM Reputation Intelligence Report · Generated [DATE]<br>Platforms: ChatGPT, Claude, Gemini, Perplexity<br><div class="conf">Confidential — Prepared for Client Use Only</div></div>

Output ONLY the completed HTML.`;
}

function buildExecPrompt(css, hdr) {
  return `You are a senior ORM analyst for Reputation Citadel generating an Executive Summary Report.
Synthesize SERP, social media, and LLM findings into a concise C-suite brief. TONE: Professional. "Mr./Ms. [Last Name]".

USE THIS EXACT HTML STRUCTURE:

${css}

STRUCTURE:
${hdr}<h1>Executive Summary Report</h1><div class="sub"><strong>[CLIENT]</strong> · [DATE]</div></div></div>
<div class="wrap">

SEC 1 — Executive Overview: div.card > p (high-level summary)

SEC 2 — SERP Snapshot: div.card with div.g3 stats + analysis paragraph. If SERP URL provided: <a href="[URL]" target="_blank" class="vr-btn">View Full SERP Report &rarr;</a>

SEC 3 — Social Media Snapshot: div.card with stats + analysis. If Social URL provided: vr-btn link.

SEC 4 — AI/LLM Reputation Snapshot: div.card with risk score + analysis. If LLM URL provided: vr-btn link.

SEC 5 — Combined Risk Assessment: div.card with overall assessment

SEC 6 — Action Items: ol.al > li with "We will..." framing. 4-6 items.

</div>
<div class="ft">Reputation Citadel · Executive Summary Report · Generated [DATE]<br><div class="conf">Confidential — Prepared for Client Use Only</div></div>

Output ONLY the completed HTML.`;
}
