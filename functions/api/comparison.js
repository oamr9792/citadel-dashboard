// functions/api/comparison.js
// POST /api/comparison — Generate a SERP Comparison Report from two dates in a Google Sheet

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("X-Admin-Password");
  if (auth !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const { clientId, clientName, sheetUrl, keywords, dateA, dateB } = body;
  if (!clientId || !clientName || !sheetUrl || !dateA || !dateB) {
    return json({ error: "Missing required fields: clientId, clientName, sheetUrl, dateA, dateB" }, 400);
  }

  if (!env.ANTHROPIC_API_KEY) return json({ error: "No API key" }, 400);

  try {
    // Fetch SERP_Archive from Google Sheet (gid=1 is typically the second tab)
    const archiveData = await fetchArchiveTab(sheetUrl);
    if (!archiveData) return json({ error: "Could not fetch SERP_Archive from Google Sheet. Ensure sheet is shared publicly." }, 400);

    // Parse keywords filter
    const kwFilter = keywords
      ? keywords.split(",").map(k => k.trim().toLowerCase()).filter(Boolean)
      : [];

    // Parse the archive CSV into snapshot rows
    const { snapshotA, snapshotB, foundKeywords, dateAActual, dateBActual } =
      extractSnapshots(archiveData, dateA, dateB, kwFilter);

    if (!snapshotA.length && !snapshotB.length) {
      return json({ error: `No data found for the selected dates. Check that ${dateA} and ${dateB} exist in the archive.` }, 400);
    }

    // Build prompt data
    const dataPayload = buildComparisonPayload(snapshotA, snapshotB, dateAActual, dateBActual, foundKeywords);

    const systemPrompt = buildComparisonSystemPrompt();
    const userPrompt = `Client: ${clientName}
Keywords analysed: ${foundKeywords.join(", ")}
Date A (baseline): ${dateAActual || dateA}
Date B (latest): ${dateBActual || dateB}

${dataPayload}

CRITICAL: Output ONLY complete HTML. No markdown. No commentary.`;

    let html = await callClaudeStream(env.ANTHROPIC_API_KEY, systemPrompt, userPrompt);
    html = html.trim();
    if (html.startsWith("```")) html = html.replace(/^```(?:html)?\n?/, "").replace(/\n?```$/, "");

    const shareToken = genTok();
    const reportId = `r_${Date.now()}`;
    const meta = {
      id: reportId,
      clientId,
      clientName,
      type: "comparison",
      typeName: "SERP Comparison Report",
      keywords: keywords || foundKeywords.join(", "),
      sheetUrl,
      dateA: dateAActual || dateA,
      dateB: dateBActual || dateB,
      createdAt: new Date().toISOString(),
      shareToken,
      status: "complete"
    };

    await env.CITADEL_KV.put(`report-html:${reportId}`, html, { expirationTtl: 31536000 });
    await env.CITADEL_KV.put(`report:${reportId}`, JSON.stringify(meta), { expirationTtl: 31536000 });
    await env.CITADEL_KV.put(`share:${shareToken}`, reportId, { expirationTtl: 31536000 });

    let idx = [];
    try { const e = await env.CITADEL_KV.get("reports-index"); if (e) idx = JSON.parse(e); } catch {}
    idx.unshift(meta);
    await env.CITADEL_KV.put("reports-index", JSON.stringify(idx));

    return json({ success: true, report: meta });

  } catch (err) {
    return json({ error: `Comparison failed: ${err.message}` }, 500);
  }
}

// ── Fetch SERP_Archive tab from Google Sheet ──────────────────────────────────
async function fetchArchiveTab(sheetUrl) {
  const m = sheetUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const id = m[1];

  // Step 1: try the known SERP_Archive gid (697017722) first — most common
  const knownGids = ["697017722"];
  for (const gid of knownGids) {
    const csv = await fetchCsvByGid(id, gid);
    if (csv) {
      const firstLine = csv.split("\n")[0].toLowerCase();
      if (firstLine.includes("snapshot") || (firstLine.includes("rank") && firstLine.includes("url"))) {
        return csv;
      }
    }
  }

  // Step 2: try the feeds API to find the archive tab by name
  try {
    const feedUrl = `https://spreadsheets.google.com/feeds/worksheets/${id}/public/basic?alt=json`;
    const feedResp = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
    if (feedResp.ok) {
      const feedData = await feedResp.json();
      const entries = feedData?.feed?.entry || [];
      for (const entry of entries) {
        const title = (entry?.title?.$t || "").toLowerCase();
        if (title.includes("archive")) {
          const selfLink = entry?.link?.find(l => l.rel === "self")?.href || "";
          const gidMatch = selfLink.match(/\/(\d+)$/);
          if (gidMatch) {
            const csv = await fetchCsvByGid(id, gidMatch[1]);
            if (csv) return csv;
          }
        }
      }
      // Try all tabs, pick the one with "snapshot" in header or most rows
      const candidates = [];
      for (const entry of entries) {
        const selfLink = entry?.link?.find(l => l.rel === "self")?.href || "";
        const gidMatch = selfLink.match(/\/(\d+)$/);
        if (!gidMatch) continue;
        const csv = await fetchCsvByGid(id, gidMatch[1]);
        if (!csv) continue;
        const firstLine = csv.split("\n")[0].toLowerCase();
        const rowCount = csv.split("\n").length;
        if (firstLine.includes("snapshot")) return csv;
        if (firstLine.includes("rank") && firstLine.includes("url") && firstLine.includes("keyword") && rowCount > 5) {
          candidates.push({ csv, rowCount });
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => b.rowCount - a.rowCount);
        return candidates[0].csv;
      }
    }
  } catch {}

  // Step 3: brute force gids 0-30 using export format
  const candidates = [];
  for (let gid = 0; gid <= 30; gid++) {
    const csv = await fetchCsvByGid(id, String(gid));
    if (!csv) continue;
    const firstLine = csv.split("\n")[0].toLowerCase();
    const rowCount = csv.split("\n").length;
    if (firstLine.includes("snapshot")) return csv;
    if (firstLine.includes("rank") && firstLine.includes("url") && firstLine.includes("keyword") && rowCount > 5) {
      candidates.push({ csv, rowCount });
    }
  }
  if (candidates.length) {
    candidates.sort((a, b) => b.rowCount - a.rowCount);
    return candidates[0].csv;
  }

  return null;
}

async function fetchCsvByGid(sheetId, gid) {
  // The export format is more reliable than gviz/tq for specific gids
  const urls = [
    `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&id=${sheetId}&gid=${gid}`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
      if (!r.ok) continue;
      const csv = await r.text();
      if (!csv || csv.length < 30) continue;
      if (csv.includes("<!DOCTYPE") || csv.includes("<html")) continue;
      const firstLine = csv.split("\n")[0];
      if (firstLine.split(",").length < 3) continue;
      return csv;
    } catch {}
  }
  return null;
}

// ── Parse CSV into rows ───────────────────────────────────────────────────────
function parseCSV(csv) {
  const lines = csv.split("\n");
  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase().replace(/[★\s]+/g, " ").trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (vals[idx] || "").trim(); });
    rows.push(obj);
  }
  return { headers, rows };
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ── Extract two snapshots from the archive ────────────────────────────────────

// Parse a raw date string to YYYY-MM-DD without timezone conversion
function rawToDateStr(raw) {
  if (!raw) return null;
  raw = raw.trim();
  // Try ISO format first: 2026-03-30 or 2026-03-30T06:00:00
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Try M/D/YYYY or MM/DD/YYYY (Google Sheets US locale)
  m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  // Try D/M/YYYY (UK locale)
  m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // Fallback to Date parse but use local date parts
  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    // Use UTC date parts to avoid timezone shift
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function extractSnapshots(csv, dateA, dateB, kwFilter) {
  const { rows } = parseCSV(csv);

  // Find column keys
  const sampleRow = rows[0] || {};
  const dateKey = Object.keys(sampleRow).find(k =>
    k.includes("snapshot") || k.includes("fetched")
  ) || "snapshot date";

  const rankKey = Object.keys(sampleRow).find(k => k === "rank") || "rank";
  const urlKey = Object.keys(sampleRow).find(k => k === "url") || "url";
  const kwKey = Object.keys(sampleRow).find(k => k === "keyword") || "keyword";
  const titleKey = Object.keys(sampleRow).find(k => k === "title") || "title";
  const sentKey = Object.keys(sampleRow).find(k => k.includes("sentiment")) || "sentiment";
  const ownedKey = Object.keys(sampleRow).find(k => k.includes("owned")) || "owned";
  const movKey = Object.keys(sampleRow).find(k => k.includes("movement")) || "movement";
  const dispKey = Object.keys(sampleRow).find(k => k.includes("display")) || "display url";
  const descKey = Object.keys(sampleRow).find(k => k.includes("meta") || k.includes("description") || k.includes("snippet")) || "meta description";

  // Collect all available date strings (YYYY-MM-DD) from the archive
  const allDates = new Set();
  rows.forEach(r => {
    const ds = rawToDateStr(r[dateKey] || "");
    if (ds) allDates.add(ds);
  });

  // Find closest available date to the requested date
  const findClosest = (target) => {
    if (!target) return null;
    // Exact match first
    if (allDates.has(target)) return target;
    // Find nearest
    const targetTs = new Date(target).getTime();
    if (isNaN(targetTs)) return null;
    let closest = null, closestDiff = Infinity;
    allDates.forEach(ds => {
      const diff = Math.abs(new Date(ds).getTime() - targetTs);
      if (diff < closestDiff) { closestDiff = diff; closest = ds; }
    });
    return closest;
  };

  const dateAActual = findClosest(dateA);
  const dateBActual = findClosest(dateB);

  // Filter rows by date using the same timezone-safe parser
  const filterRows = (dateStr) => {
    if (!dateStr) return [];
    let filtered = rows.filter(r => rawToDateStr(r[dateKey] || "") === dateStr);
    if (kwFilter.length) {
      filtered = filtered.filter(r =>
        kwFilter.some(kw => (r[kwKey] || "").toLowerCase().includes(kw))
      );
    }
    return filtered.map(r => ({
      rank: parseInt(r[rankKey]) || 0,
      url: r[urlKey] || "",
      keyword: r[kwKey] || "",
      title: r[titleKey] || "",
      sentiment: r[sentKey] || "",
      owned: r[ownedKey] || "",
      movement: r[movKey] || "",
      displayUrl: r[dispKey] || "",
      description: r[descKey] || "",
    })).filter(r => r.rank > 0).sort((a, b) => a.rank - b.rank);
  };

  const snapshotA = filterRows(dateAActual);
  const snapshotB = filterRows(dateBActual);

  // Collect keywords found
  const kwSet = new Set();
  [...snapshotA, ...snapshotB].forEach(r => { if (r.keyword) kwSet.add(r.keyword); });
  const foundKeywords = Array.from(kwSet);

  return { snapshotA, snapshotB, foundKeywords, dateAActual, dateBActual };
}

// ── Build comparison data payload for Claude ──────────────────────────────────
function buildComparisonPayload(snapshotA, snapshotB, dateA, dateB, keywords) {
  const kwGroups = {};
  keywords.forEach(kw => {
    kwGroups[kw] = {
      a: snapshotA.filter(r => r.keyword === kw),
      b: snapshotB.filter(r => r.keyword === kw),
    };
  });

  let out = "";

  keywords.forEach(kw => {
    const { a, b } = kwGroups[kw];
    out += `\n=== KEYWORD: ${kw} ===\n`;

    // Build URL-level diff
    const urlsA = new Map(a.map(r => [r.url, r]));
    const urlsB = new Map(b.map(r => [r.url, r]));
    const allUrls = new Set([...urlsA.keys(), ...urlsB.keys()]);

    const diff = [];
    allUrls.forEach(url => {
      const rA = urlsA.get(url);
      const rB = urlsB.get(url);
      if (rA && rB) {
        const delta = rA.rank - rB.rank;
        diff.push({
          url, title: rB.title || rA.title,
          rankA: rA.rank, rankB: rB.rank, delta,
          movement: delta > 0 ? `↑${delta}` : delta < 0 ? `↓${Math.abs(delta)}` : "–",
          sentimentA: rA.sentiment, sentimentB: rB.sentiment,
          ownedA: rA.owned, ownedB: rB.owned,
          status: "moved",
        });
      } else if (rA && !rB) {
        diff.push({ url, title: rA.title, rankA: rA.rank, rankB: null, delta: null, movement: "dropped off", sentimentA: rA.sentiment, sentimentB: "", ownedA: rA.owned, ownedB: "", status: "dropped" });
      } else if (!rA && rB) {
        diff.push({ url, title: rB.title, rankA: null, rankB: rB.rank, delta: null, movement: "new entry", sentimentA: "", sentimentB: rB.sentiment, ownedA: "", ownedB: rB.owned, status: "new" });
      }
    });

    diff.sort((a, b) => {
      const rankSort = (a.rankB || a.rankA || 999) - (b.rankB || b.rankA || 999);
      return rankSort;
    });

    out += `\nSNAPSHOT A (${dateA}) — ${a.length} results:\n`;
    a.slice(0, 30).forEach(r => {
      out += `  #${r.rank} | ${r.sentiment || "unlabelled"} | ${r.owned ? "★" : " "} | ${r.title.slice(0, 60)} | ${r.url}\n`;
    });

    out += `\nSNAPSHOT B (${dateB}) — ${b.length} results:\n`;
    b.slice(0, 30).forEach(r => {
      out += `  #${r.rank} | ${r.sentiment || "unlabelled"} | ${r.owned ? "★" : " "} | ${r.title.slice(0, 60)} | ${r.url}\n`;
    });

    out += `\nURL-LEVEL DIFF (A→B):\n`;
    diff.forEach(d => {
      const rankStr = d.rankA != null && d.rankB != null
        ? `#${d.rankA} → #${d.rankB} (${d.movement})`
        : d.rankA != null ? `#${d.rankA} → dropped off`
        : `new → #${d.rankB}`;
      const sentChange = d.sentimentA !== d.sentimentB && (d.sentimentA || d.sentimentB)
        ? ` | sentiment: ${d.sentimentA || "?"} → ${d.sentimentB || "?"}`
        : "";
      const ownedChange = d.ownedA !== d.ownedB
        ? ` | owned: ${d.ownedA || "–"} → ${d.ownedB || "–"}`
        : (d.ownedB === "★" ? " | ★" : "");
      out += `  ${rankStr}${sentChange}${ownedChange} | ${d.title.slice(0, 50)} | ${d.url}\n`;
    });

    // Sentiment summary
    const countSent = (arr, val) => arr.filter(r => (r.sentiment || "").toLowerCase() === val.toLowerCase()).length;
    out += `\nSENTIMENT SUMMARY:\n`;
    out += `  Date A: Positive=${countSent(a,"Positive")} Negative=${countSent(a,"Negative")} Neutral=${countSent(a,"Neutral")} Unlabelled=${a.filter(r=>!r.sentiment).length}\n`;
    out += `  Date B: Positive=${countSent(b,"Positive")} Negative=${countSent(b,"Negative")} Neutral=${countSent(b,"Neutral")} Unlabelled=${b.filter(r=>!r.sentiment).length}\n`;

    // Owned summary
    out += `\nOWNED CONTENT SUMMARY:\n`;
    out += `  Date A: ${a.filter(r=>r.owned==="★").length} owned results in top ${a.length}\n`;
    out += `  Date B: ${b.filter(r=>r.owned==="★").length} owned results in top ${b.length}\n`;
  });

  return out;
}

// ── Claude API ────────────────────────────────────────────────────────────────
async function callClaudeStream(apiKey, system, user) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 64000,
      stream: true,
      system,
      messages: [{ role: "user", content: user }]
    })
  });
  if (!r.ok) { const e = await r.text(); throw new Error(`Claude ${r.status}: ${e.substring(0, 200)}`); }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
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

function genTok() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}

function json(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildComparisonSystemPrompt() {
  const LOGO = "https://citadel-dashboard.pages.dev/logo.png";

  const CSS = `:root{--bg:#fff;--card:#f0f3f8;--card-border:#d4dae6;--navy:#1b2a4a;--navy-light:#2c4170;--red:#c0392b;--amber:#d4880f;--green:#1e8449;--text:#1e293b;--muted:#5a6a85;--border:#d4dae6;--header-bg:#000;--owned-gold:#b8860b}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;color:var(--text);background:var(--bg);line-height:1.6}
h1,h2,h3{font-family:Georgia,serif;color:var(--navy)}
.header{background:var(--header-bg);padding:32px 48px;display:flex;align-items:center;gap:24px}
.header img{height:50px}.header .divider{width:1px;height:60px;background:rgba(255,255,255,.3)}
.header .title{color:#fff}.header h1{font-size:1.6rem;color:#fff;margin-bottom:4px}
.header .sub{color:#8899b4;font-size:.9rem}
.wrap{max-width:1100px;margin:0 auto;padding:32px 24px}
.sec{margin-bottom:40px}
.sec-title{font-size:1.3rem;color:var(--navy);border-bottom:3px solid var(--navy);padding-bottom:8px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--card-border);border-radius:10px;padding:24px;margin-bottom:16px}
.g2{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
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
.tg-gy{background:#e8e8e8;color:#666}
.own-row{border-left:3px solid var(--owned-gold);background:#fdf8ef}
.neg-row{background:rgba(192,57,43,.05)}
.pos-row{background:rgba(30,132,73,.05)}
.mv-up{color:var(--green);font-weight:700}
.mv-dn{color:var(--red);font-weight:700}
.mv-st{color:var(--muted)}
.mv-nw{color:var(--navy);font-style:italic}
.mv-dr{color:#999;font-style:italic}
.star{color:var(--owned-gold)}
.delta-pos{color:var(--green);font-weight:700}
.delta-neg{color:var(--red);font-weight:700}
.date-badge{display:inline-block;padding:4px 12px;border-radius:4px;font-size:.8rem;font-weight:600;font-family:monospace}
.date-a{background:#e8eef8;color:#1b2a4a}
.date-b{background:#eaf4ee;color:#1e8449}
.kw-section{margin-bottom:48px;border:1px solid var(--card-border);border-radius:12px;overflow:hidden}
.kw-header{background:var(--navy);color:#fff;padding:16px 24px;font-family:Georgia,serif;font-size:1.1rem}
.kw-body{padding:24px}
.comparison-row-new{background:rgba(30,132,73,.08)}
.comparison-row-dropped{background:rgba(192,57,43,.06);opacity:.7}
.bar-c{display:flex;height:24px;border-radius:6px;overflow:hidden;margin:8px 0}
.bar-s{display:flex;align-items:center;justify-content:center;color:#fff;font-size:.75rem;font-weight:600}
.ft{text-align:center;padding:32px 24px;border-top:3px solid var(--navy);margin-top:48px;color:var(--muted);font-size:.85rem}
.conf{color:var(--red);font-weight:700;text-transform:uppercase;letter-spacing:2px;font-size:.8rem;margin-top:12px}
@media(max-width:700px){.g2,.g3,.g4{grid-template-columns:1fr}.header{flex-direction:column;text-align:center;padding:24px}}`;

  return `You are an ORM analyst for Reputation Citadel. Generate a SERP Comparison Report comparing two date snapshots in HTML.

TONE: Client-facing, professional. Use "Mr./Ms. [Last Name]" if name is a person. Positives are opportunities. Negatives are "exposure areas". Encouraging but honest.

USE THIS EXACT CSS AND STRUCTURE:

<style>${CSS}</style>

STRUCTURE:

<div class="header"><img src="${LOGO}" alt="Reputation Citadel"><div class="divider"></div><div class="title"><h1>SERP Comparison Report</h1><div class="sub"><strong>[CLIENT]</strong> · [DATE A] vs [DATE B]</div></div></div>

<div class="wrap">

SEC 1 — Executive Summary: div.sec > h2.sec-title + div.card > p
Summarise the overall picture: what improved, what declined, what changed in sentiment, owned content performance.

SEC 2 — Overall Metrics (across all keywords combined): div.sec > h2.sec-title + div.g4 of div.st
Show: Total results compared (n-bl) | Positive sentiment change Δ (n-gr or n-rd) | Negative sentiment change Δ (n-rd or n-gr) | Owned results change Δ (n-am)
Each stat: <div class="st"><div class="n [COLOR]">[VALUE]</div><div class="l">[LABEL]</div></div>

SEC 3 — Per Keyword sections: for EACH keyword, a div.kw-section with:
  - div.kw-header showing the keyword
  - div.kw-body containing:
    a) Sentiment bar comparison: two rows of div.bar-c showing A and B distributions (green=Positive, muted=Neutral, red=Negative), labelled with span.date-badge date-a and date-b
    b) Full comparison table: table.dt with columns: Rank (Date B) | Change | Sentiment A→B | Owned | Title | URL
       - Rows with class pos-row for positive, neg-row for negative, own-row for owned, comparison-row-new for new entries, comparison-row-dropped for dropped results
       - Movement: span.mv-up for improved, span.mv-dn for declined, span.mv-st for unchanged, span.mv-nw for new, span.mv-dr for dropped
       - Show ALL results from Date B plus dropped results at the bottom
    c) Key changes callout: div.card summarising the 2-3 most significant movements for this keyword

SEC 4 — Action Items: div.sec > h2.sec-title + ol.al > li (use "We will..." framing). 4-6 items based on what the data shows.

</div>
<div class="ft">Reputation Citadel · SERP Comparison Report · [DATE A] vs [DATE B]<br><div class="conf">Confidential — Prepared for Client Use Only</div></div>

Output ONLY the completed HTML. No markdown. No preamble.`;
}
