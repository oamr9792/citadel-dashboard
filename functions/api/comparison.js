// functions/api/comparison.js
// POST /api/comparison — Generate a SERP Comparison Report from two dates in a Google Sheet

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("X-Admin-Password");
  if (auth !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const { clientId, clientName, sheetUrl, keywords, dateA, dateB, topN } = body;
  if (!clientId || !clientName || !sheetUrl || !dateA || !dateB) {
    return json({ error: "Missing required fields: clientId, clientName, sheetUrl, dateA, dateB" }, 400);
  }

  const resultLimit = Math.min(Math.max(parseInt(topN) || 20, 1), 30);

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
    const { snapshotA, snapshotB, foundKeywords, dateAActual, dateBActual, dateAByKw, dateBByKw, baselineByUrlKw, firstDate, lastDate } =
      extractSnapshots(archiveData, dateA, dateB, kwFilter, resultLimit);

    if (!snapshotA.length && !snapshotB.length) {
      return json({ error: `No data found near ${dateA} or ${dateB} in the archive. Check the sheet has data and try different dates.` }, 400);
    }

    // If one snapshot is empty, warn but continue — the nearest-date fallback should have resolved this
    // but if a keyword genuinely has no data near one date, we note it in the payload

    // Build prompt data
    const dataPayload = buildComparisonPayload(snapshotA, snapshotB, dateAActual, dateBActual, foundKeywords, resultLimit, dateAByKw, dateBByKw, baselineByUrlKw, firstDate, lastDate);

    const systemPrompt = buildComparisonSystemPrompt();
    const userPrompt = `Client: ${clientName}
Keywords analysed: ${foundKeywords.join(", ")}
Date A (requested): ${dateA} → resolved to nearest available: ${dateAActual}
Date B (requested): ${dateB} → resolved to nearest available: ${dateBActual}
Results compared: Top ${resultLimit} per keyword
Note: dates shown are the actual snapshot dates used. If a requested date had no data, the nearest available date was substituted automatically.

${dataPayload}

CRITICAL: Output ONLY complete HTML. No markdown. No commentary.`;

    let html = await callClaudeStream(env.ANTHROPIC_API_KEY, systemPrompt, userPrompt);
    html = html.trim();
    if (html.startsWith("```")) html = html.replace(/^```(?:html)?\n?/, "").replace(/\n?```$/, "");

    // DEBUG: include sample of what we actually parsed — helps diagnose sentiment/owned issues
    const debugInfo = {
      firstDate,
      lastDate,
      totalRows: (() => { const { rows } = parseCSV(archiveData); return rows.length; })(),
      headers: (() => { const { headers } = parseCSV(archiveData); return headers; })(),
      sampleRow: (() => { const { rows } = parseCSV(archiveData); return rows[0] || {}; })(),
      foundKeywords,
      snapshotACounts: foundKeywords.map(kw => ({ kw, count: snapshotA.filter(r => r.keyword === kw).length, negCount: snapshotA.filter(r => r.keyword === kw && r.sentiment.toLowerCase() === 'negative').length, ownedCount: snapshotA.filter(r => r.keyword === kw && r.owned === '★').length })),
      snapshotBCounts: foundKeywords.map(kw => ({ kw, count: snapshotB.filter(r => r.keyword === kw).length, negCount: snapshotB.filter(r => r.keyword === kw && r.sentiment.toLowerCase() === 'negative').length, ownedCount: snapshotB.filter(r => r.keyword === kw && r.owned === '★').length })),
    };

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

    return json({ success: true, report: meta, debug: debugInfo });

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

function extractSnapshots(csv, dateA, dateB, kwFilter, resultLimit = 20) {
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

  // Index all rows by (keyword, date) for fast lookup
  // Also track which dates have data for each keyword
  const byKwDate = new Map(); // "kw|date" -> rows[]
  const kwDates = new Map();  // keyword -> Set<dateStr>
  const allDates = new Set();

  rows.forEach(r => {
    const ds = rawToDateStr(r[dateKey] || "");
    if (!ds) return;
    allDates.add(ds);
    const kw = (r[kwKey] || "").trim();
    if (!kw) return;
    const key = `${kw}|${ds}`;
    if (!byKwDate.has(key)) byKwDate.set(key, []);
    byKwDate.get(key).push(r);
    if (!kwDates.has(kw)) kwDates.set(kw, new Set());
    kwDates.get(kw).add(ds);
  });

  const sortedDates = Array.from(allDates).sort();

  // Find closest date to target that has data for a specific keyword.
  // Falls back to global allDates if keyword has no data near target.
  const findClosestForKw = (target, kw) => {
    if (!target) return null;

    // Try keyword-specific dates first
    const available = kwDates.get(kw);
    const searchSet = (available && available.size) ? available : allDates;
    if (!searchSet.size) return null;

    // Exact match
    if (searchSet.has(target)) return target;

    // Find nearest available date
    const targetTs = new Date(target).getTime();
    if (isNaN(targetTs)) return Array.from(searchSet).sort()[0];

    let closest = null, closestDiff = Infinity;
    searchSet.forEach(ds => {
      const diff = Math.abs(new Date(ds).getTime() - targetTs);
      if (diff < closestDiff) { closestDiff = diff; closest = ds; }
    });
    return closest;
  };

  // Determine which keywords we're working with
  const allKeywords = Array.from(kwDates.keys());
  const activeKeywords = kwFilter.length
    ? allKeywords.filter(kw => kwFilter.some(f => kw.toLowerCase().includes(f)))
    : allKeywords;

  // For each keyword, find the best matching date for A and B
  const snapshotA = [];
  const snapshotB = [];
  const dateAByKw = new Map();
  const dateBByKw = new Map();

  activeKeywords.forEach(kw => {
    const bestA = findClosestForKw(dateA, kw);
    const bestB = findClosestForKw(dateB, kw);

    dateAByKw.set(kw, bestA);
    dateBByKw.set(kw, bestB);

    if (bestA) {
      const rowsA = (byKwDate.get(`${kw}|${bestA}`) || [])
        .map(r => mapRow(r, rankKey, urlKey, kwKey, titleKey, sentKey, ownedKey, movKey, dispKey, descKey))
        .filter(r => r.rank > 0).sort((a, b) => a.rank - b.rank).slice(0, resultLimit);
      snapshotA.push(...rowsA);
    }

    if (bestB) {
      const rowsB = (byKwDate.get(`${kw}|${bestB}`) || [])
        .map(r => mapRow(r, rankKey, urlKey, kwKey, titleKey, sentKey, ownedKey, movKey, dispKey, descKey))
        .filter(r => r.rank > 0).sort((a, b) => a.rank - b.rank).slice(0, resultLimit);
      snapshotB.push(...rowsB);
    }
  });

  // Overall "actual" dates — use the most common resolved date across keywords
  const dateAActual = mostCommon(Array.from(dateAByKw.values()).filter(Boolean)) || dateA;
  const dateBActual = mostCommon(Array.from(dateBByKw.values()).filter(Boolean)) || dateB;

  const foundKeywords = activeKeywords.filter(kw => dateAByKw.get(kw) || dateBByKw.get(kw));

  // ── Baseline tracker: earliest rank for EVERY URL per keyword across the FULL archive ──
  // This answers "where did this result start?" regardless of which two dates were selected
  const baselineByUrlKw = new Map(); // "url|kw" -> { rank, date, title }
  const sortedDatesList = Array.from(allDates).sort();
  const firstDate = sortedDatesList[0] || null;
  const lastDate = sortedDatesList[sortedDatesList.length - 1] || null;

  rows.forEach(r => {
    const ds = rawToDateStr(r[dateKey] || "");
    if (!ds) return;
    const kw = (r[kwKey] || "").trim();
    const url = (r[urlKey] || "").trim();
    const rank = parseInt(r[rankKey]);
    if (!kw || !url || isNaN(rank) || rank <= 0) return;

    const key = `${url}|${kw}`;
    const existing = baselineByUrlKw.get(key);
    if (!existing || ds < existing.date) {
      baselineByUrlKw.set(key, {
        rank,
        date: ds,
        title: (r[titleKey] || "").trim(),
        sentiment: (r[sentKey] || "").trim(),
      });
    }
  });

  return { snapshotA, snapshotB, foundKeywords, dateAActual, dateBActual, dateAByKw, dateBByKw, baselineByUrlKw, firstDate, lastDate };
}

function mapRow(r, rankKey, urlKey, kwKey, titleKey, sentKey, ownedKey, movKey, dispKey, descKey) {
  return {
    rank: parseInt(r[rankKey]) || 0,
    url: r[urlKey] || "",
    keyword: r[kwKey] || "",
    title: r[titleKey] || "",
    sentiment: r[sentKey] || "",
    owned: r[ownedKey] || "",
    movement: r[movKey] || "",
    displayUrl: r[dispKey] || "",
    description: r[descKey] || "",
  };
}

function mostCommon(arr) {
  if (!arr.length) return null;
  const counts = {};
  arr.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// ── Build comparison data payload for Claude ──────────────────────────────────
function buildComparisonPayload(snapshotA, snapshotB, dateA, dateB, keywords, resultLimit = 20, dateAByKw = null, dateBByKw = null, baselineByUrlKw = null, firstDate = null, lastDate = null) {
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
    const kwDateA = (dateAByKw && dateAByKw.get(kw)) || dateA;
    const kwDateB = (dateBByKw && dateBByKw.get(kw)) || dateB;
    out += `\n=== KEYWORD: ${kw} ===\n`;
    out += `Comparing top ${resultLimit} results. Date A: ${kwDateA}${kwDateA !== dateA ? ` (nearest with data to requested ${dateA})` : ''}. Date B: ${kwDateB}${kwDateB !== dateB ? ` (nearest with data to requested ${dateB})` : ''}.\n`;
    out += `Sentiment % uses ${resultLimit} as denominator for BOTH dates.\n`;

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

    out += `\nSNAPSHOT A (${dateA}) — ${a.length} results shown (top ${resultLimit}):\n`;
    a.forEach(r => {
      out += `  #${r.rank} | ${r.sentiment || "unlabelled"} | ${r.owned ? "★" : " "} | ${r.title.slice(0, 60)} | ${r.url}\n`;
    });

    out += `\nSNAPSHOT B (${dateB}) — ${b.length} results shown (top ${resultLimit}):\n`;
    b.forEach(r => {
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

    // Sentiment — secondary metric, use resultLimit as fixed denominator
    const countSent = (arr, val) => arr.filter(r => (r.sentiment || "").toLowerCase() === val.toLowerCase()).length;
    const posA = countSent(a, "Positive"), negA = countSent(a, "Negative"), neuA = countSent(a, "Neutral"), unlA = a.filter(r => !r.sentiment).length;
    const posB = countSent(b, "Positive"), negB = countSent(b, "Negative"), neuB = countSent(b, "Neutral"), unlB = b.filter(r => !r.sentiment).length;

    out += `\nSENTIMENT (secondary — denominator = ${resultLimit}):\n`;
    out += `  Date A: Pos=${posA} (${Math.round(posA/resultLimit*100)}%) Neg=${negA} (${Math.round(negA/resultLimit*100)}%) Neu=${neuA} (${Math.round(neuA/resultLimit*100)}%) Unl=${unlA}\n`;
    out += `  Date B: Pos=${posB} (${Math.round(posB/resultLimit*100)}%) Neg=${negB} (${Math.round(negB/resultLimit*100)}%) Neu=${neuB} (${Math.round(neuB/resultLimit*100)}%) Unl=${unlB}\n`;

    // Displacement analysis — the core ORM story
    const negInA = a.filter(r => (r.sentiment||"").toLowerCase() === "negative");
    const negInB = b.filter(r => (r.sentiment||"").toLowerCase() === "negative");
    const negUrlsA = new Map(negInA.map(r => [r.url, r]));
    const negUrlsB = new Map(negInB.map(r => [r.url, r]));

    const pushed = []; // negative results that improved rank (higher number = further down)
    const risen  = []; // negative results that got worse
    const dropped = []; // negative results that fell off entirely
    const newNeg = []; // new negative results that appeared

    negUrlsA.forEach((rA, url) => {
      const rB = negUrlsB.get(url);
      if (!rB) { dropped.push({ ...rA, wasRank: rA.rank }); }
      else {
        const delta = rB.rank - rA.rank; // positive = moved DOWN (good for ORM)
        if (delta > 0) pushed.push({ ...rB, delta, wasRank: rA.rank });
        else if (delta < 0) risen.push({ ...rB, delta, wasRank: rA.rank });
      }
    });
    negUrlsB.forEach((rB, url) => {
      if (!negUrlsA.has(url)) newNeg.push(rB);
    });

    const ownedA = a.filter(r => r.owned === "★");
    const ownedB = b.filter(r => r.owned === "★");
    const ownedRisen = ownedB.filter(rB => {
      const rA = a.find(r => r.url === rB.url);
      return rA && rB.rank < rA.rank;
    });

    out += `\nDISPLACEMENT SUMMARY — ${kw} (${dateA} vs ${dateB}):\n`;
    out += `  Negative results pushed DOWN (further from top): ${pushed.length}\n`;
    pushed.forEach(r => out += `    "${r.title.slice(0,50)}" moved from #${r.wasRank} to #${r.rank} (down ${r.delta} positions)\n`);
    out += `  Negative results that FELL OFF page entirely: ${dropped.length}\n`;
    dropped.forEach(r => out += `    "${r.title.slice(0,50)}" was at #${r.wasRank}, now gone\n`);
    out += `  Negative results that ROSE (closer to top — bad): ${risen.length}\n`;
    risen.forEach(r => out += `    "${r.title.slice(0,50)}" moved from #${r.wasRank} to #${r.rank} (up ${Math.abs(r.delta)} positions)\n`);
    out += `  New negative results that appeared: ${newNeg.length}\n`;
    newNeg.forEach(r => out += `    "${r.title.slice(0,50)}" at #${r.rank}\n`);
    out += `  Owned content that ROSE: ${ownedRisen.length}\n`;
    ownedRisen.forEach(rB => {
      const rA = a.find(r => r.url === rB.url);
      out += `    "${rB.title.slice(0,50)}" from #${rA.rank} to #${rB.rank}\n`;
    });
    out += `  Owned count: ${ownedA.length} → ${ownedB.length} in top ${resultLimit}\n`;

    // ── PROGRAMME-START BASELINE: where did each negative result START vs where is it NOW ──
    // This answers the key question: have negative results generally dropped since we started?
    if (baselineByUrlKw && firstDate) {
      out += `\nPROGRAMME-START BASELINE — ${kw} (first data: ${firstDate}, latest: ${lastDate || dateB}):\n`;
      out += `This shows where each current or recent negative result was when we FIRST saw it in the archive.\n`;

      // All negative URLs seen in either snapshot
      const allNegUrls = new Set([...negUrlsA.keys(), ...negUrlsB.keys()]);

      let totalDelta = 0, countWithBaseline = 0, improved = 0, worsened = 0, unchanged = 0;

      allNegUrls.forEach(url => {
        const baseline = baselineByUrlKw ? baselineByUrlKw.get(`${url}|${kw}`) : null;
        const currentRow = negUrlsB.get(url) || negUrlsA.get(url);
        const currentRank = negUrlsB.has(url) ? negUrlsB.get(url).rank : null;
        const title = (currentRow?.title || "").slice(0, 50);

        if (baseline) {
          const delta = currentRank !== null
            ? currentRank - baseline.rank  // positive = moved down (good)
            : resultLimit + 5 - baseline.rank; // fell off page — treat as pushed past the limit

          countWithBaseline++;
          totalDelta += delta;

          const status = currentRank === null
            ? `GONE (was #${baseline.rank} on ${baseline.date})`
            : delta > 0
              ? `DOWN ${delta} positions: #${baseline.rank} → #${currentRank} (started ${baseline.date})`
              : delta < 0
                ? `UP ${Math.abs(delta)} positions: #${baseline.rank} → #${currentRank} (started ${baseline.date}) ← CONCERN`
                : `UNCHANGED at #${currentRank} (since ${baseline.date})`;

          if (currentRank === null || delta > 0) improved++;
          else if (delta < 0) worsened++;
          else unchanged++;

          out += `  "${title}": ${status}\n`;
        } else {
          out += `  "${title}": current #${currentRank || "off page"} — no baseline found (may predate archive)\n`;
        }
      });

      if (countWithBaseline > 0) {
        const avgDelta = (totalDelta / countWithBaseline).toFixed(1);
        // avgDelta positive = moved down (good). Show as plain positive number.
        const avgDisplay = Math.abs(parseFloat(avgDelta)).toFixed(1);
        out += `  OVERALL: ${improved}/${countWithBaseline} negative results improved since programme start. `;
        out += `Average movement: ${avgDisplay} positions down (plain number, no + sign). `;
        out += `${worsened} results moved up (concern), ${unchanged} unchanged.\n`;
      }
    }

    // Owned narrative percentages — denominator is ALWAYS resultLimit, never actual row count
    const ownedPctA = Math.round((ownedA.length / resultLimit) * 100);
    const ownedPctB = Math.round((ownedB.length / resultLimit) * 100);
    out += `\nOWNED NARRATIVE — ${kw} (denominator MUST be ${resultLimit} for both dates, always):\n`;
    out += `  Date A (${dateA}): ${ownedA.length} owned of ${resultLimit} results = ${ownedPctA}%\n`;
    out += `  Date B (${dateB}): ${ownedB.length} owned of ${resultLimit} results = ${ownedPctB}%\n`;
    out += `  Change: ${ownedB.length - ownedA.length >= 0 ? '+' : ''}${ownedB.length - ownedA.length} owned results (${ownedPctB - ownedPctA >= 0 ? '+' : ''}${ownedPctB - ownedPctA}pp)\n`;
    out += `  IMPORTANT: Both bars must say "of ${resultLimit} results" — do not use the actual number of rows returned.\n`;
    out += `  Secondary sentiment: Pos A=${posA} Neg A=${negA} Neu A=${neuA} / Pos B=${posB} Neg B=${negB} Neu B=${neuB}\n`;
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
.dt a{color:var(--navy);text-decoration:none;border-bottom:1px dotted var(--navy);word-break:break-all}
.dt a:hover{color:var(--navy-light);border-bottom-style:solid}
.tg{display:inline-block;padding:3px 10px;border-radius:4px;font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.tg-gr{background:rgba(30,132,73,.12);color:var(--green)}
.tg-rd{background:rgba(192,57,43,.12);color:var(--red)}
.tg-am{background:rgba(212,136,15,.12);color:var(--amber)}
.tg-bl{background:rgba(27,42,74,.12);color:var(--navy)}
.tg-gd{background:rgba(184,134,11,.12);color:var(--owned-gold)}
.tg-gy{background:#e8e8e8;color:#666}
.own-row{border-left:4px solid var(--owned-gold)}
.neg-row{background:rgba(192,57,43,.05)}
.pos-row{background:rgba(30,132,73,.05)}
.own-row.pos-row{background:rgba(30,132,73,.05)}
.own-row.neg-row{background:rgba(192,57,43,.05)}
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
.bar-c{display:flex;height:28px;border-radius:6px;overflow:hidden;margin:6px 0;background:#e8e8e8}
.bar-s{display:flex;align-items:center;justify-content:center;color:#fff;font-size:.72rem;font-weight:700;white-space:nowrap;overflow:hidden;min-width:0;transition:flex .3s}
.bar-s.bar-pos{background:#1e8449}.bar-s.bar-neu{background:#7f8c8d}.bar-s.bar-neg{background:#c0392b}.bar-s.bar-unl{background:#ddd;color:#999}
.bar-label-ext{display:inline-flex;align-items:center;gap:6px;font-size:.75rem;font-weight:600;margin-right:10px}
.bar-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.ft{text-align:center;padding:32px 24px;border-top:3px solid var(--navy);margin-top:48px;color:var(--muted);font-size:.85rem}
.conf{color:var(--red);font-weight:700;text-transform:uppercase;letter-spacing:2px;font-size:.8rem;margin-top:12px}
@media(max-width:700px){.g2,.g3,.g4{grid-template-columns:1fr}.header{flex-direction:column;text-align:center;padding:24px}}`;

  return `You are a senior ORM analyst for Reputation Citadel. Generate a SERP Comparison Report focused on one thing above all else: the displacement of negative results and the advancement of positive and owned content.

THE CORE NARRATIVE: This report exists to show progress in an ORM programme. The most important metrics are (1) negative results being pushed down or off the page, (2) positive and owned results rising, and (3) the overall sentiment balance improving. Lead every section with this story. If negative results have dropped in rank or fallen off the page — that is the headline. If owned content has risen — celebrate it. Frame everything through the lens of: is the search landscape becoming safer for this person or brand?

TONE: Client-facing, confident, professional. Speak in plain language. "Negative results" not "exposure areas". "Pushed down" not "demonstrated downward movement". Be direct about wins and honest about what still needs work. If a negative result is at position 2, say so clearly and explain what that means. Never be clinical or neutral when the data shows meaningful change — if negative results dropped, that is a win worth saying so.

LANGUAGE RULES:
- Never say "it's worth noting" or "it should be noted"
- Never use em dashes
- Refer to negative results as "negative results", not "exposure areas" or "challenging content"
- Refer to the programme as "the programme" not "the engagement"
- Use plain numbers: "dropped from position 4 to position 9" not "demonstrated a downward positional shift of 5"

USE THIS EXACT CSS AND STRUCTURE:

<style>${CSS}</style>

STRUCTURE:

<div class="header"><img src="${LOGO}" alt="Reputation Citadel"><div class="divider"></div><div class="title"><h1>SERP Comparison Report</h1><div class="sub"><strong>[CLIENT]</strong> · [DATE A] vs [DATE B]</div></div></div>

<div class="wrap">

SEC 1 — Headline Result: div.sec > h2.sec-title("What Changed") + div.card
ONE short paragraph. Lead with the single most important displacement win since the programme started — not just since Date A. If a negative result has dropped 8 positions since the programme began, say so. Then note what happened in the specific comparison period. 2-3 sentences total. Do not list metrics — that comes next.

SEC 2 — Displacement Scoreboard: div.sec > h2.sec-title("Displacement Scoreboard") + div.g4 of div.st
Use the PROGRAMME-START BASELINE data for stats 1 and 2 — not just A vs B:
1. Negative results displaced since programme start (pushed down or off page entirely, count) — n-gr if > 0, n-rd if 0. Label: "Negatives displaced (since start)"
2. Average positions dropped per negative result since programme start — show as a plain number e.g. "3.3" with no + sign (dropping is always good here, the label explains direction). n-gr always. Label: "Avg. positions dropped"
3. Negative results still in top N today (current count) — n-rd if any remain. Label: "Negatives remaining in top [N]"
4. Owned results today vs programme start (e.g. "2 → 4") — n-am. Label: "Owned results (start → now)"
Each stat: <div class="st"><div class="n [COLOR]">[VALUE]</div><div class="l">[LABEL]</div></div>

SEC 3 — Per Keyword sections: for EACH keyword, a div.kw-section with:
  - div.kw-header showing the keyword
  - div.kw-body containing:

    a) Since Programme Start (COMES FIRST): div.card with h3 "Since Programme Start"
       A table (table.dt) with columns: Sentiment | Title | URL | First seen at | Now at | Total movement
       - Every row gets class neg-row since this section only shows negative results
       - Sentiment column: span.tg.tg-rd "Negative" on every row
       - Title: full title, truncate only if over 80 chars
       - URL: always <a href="[url]" target="_blank" rel="noopener">[url]</a> — never plain text
       - "First seen at": e.g. "#4" in grey
       - "Now at": green if rank number is higher (dropped = good), red if rank number is lower (risen = bad), grey italic "off page" if eliminated
       - "Total movement": for NEGATIVE results, dropping is GOOD — use class delta-pos (green) for dropped, delta-neg (red) for risen. Show "eliminated" in bold green if off page.
       One summary sentence below: "X of Y negative results have dropped since the programme began. Average movement: N positions down."

    b) This period (Date A vs Date B): div.card with h3 showing the two dates.
       Short paragraph on what moved in just this period. 2-3 sentences.

    c) Owned Narrative: two rows comparing Date A and Date B.
       CRITICAL: always use the fixed top-N number from the data as the denominator for both dates — never the actual number of rows returned for that snapshot. The data will tell you "X owned of [N] results" — use exactly those numbers.
       Show: "Owned results: X of [N] ([Y]%)" for each date with a bar:
       <div style="margin:8px 0"><span class="date-badge date-a">[DATE A]</span> <strong>X owned</strong> of [N] results ([Y]%)</div>
       <div style="background:#e8e8e8;height:16px;border-radius:4px;overflow:hidden;margin:4px 0 12px"><div style="height:100%;background:var(--owned-gold);width:[Y]%"></div></div>
       Repeat identically for Date B with date-b badge and its own numbers.
       Below both bars, one compact line: "Sentiment: [posA] pos / [negA] neg / [neuA] neu → [posB] pos / [negB] neg / [neuB] neu"

    d) Full results table: table.dt columns: Rank | Sentiment | Since Start | Change (A→B) | Owned | Title | URL
       CRITICAL COLOUR RULE — movement colours are CONTEXT-AWARE:
       - For NEGATIVE rows: dropping in rank = GOOD = use span.mv-up (green) even though rank number went up. Rising in rank = BAD = use span.mv-dn (red).
       - For POSITIVE/NEUTRAL rows: dropping in rank = BAD = use span.mv-dn (red). Rising = GOOD = use span.mv-up (green).
       - "new" = span.mv-nw (navy italic), "off page" = span.mv-dr (grey italic)
       - Row classes: neg-row for negative, pos-row for positive, own-row ADDED to whatever sentiment class applies (not instead of it) — e.g. class="pos-row own-row"
       - Sentiment: span.tg with tg-rd/tg-gr/tg-am/tg-gy
       - "Since Start": "was #N" grey for no change, green text if improved since start, red if worsened
       - URL: always <a href="[url]" target="_blank" rel="noopener">[url]</a>
       - Sort: current results by rank, dropped off at bottom greyed out

SEC 4 — What Still Needs Work: div.sec > h2.sec-title("What Still Needs Work") + div.card
Name the specific negative results still prominent. State their current rank and how long they have been in the results. What will it take to move them. Be direct.

SEC 5 — Next Steps: div.sec > h2.sec-title("Next Steps") + ol style="padding-left:20px;margin-top:12px" > li style="margin-bottom:8px"
3-5 specific actions using "We will..." framing, tied to what the data actually shows.

</div>
<div class="ft">Reputation Citadel · SERP Comparison Report · [DATE A] vs [DATE B]<br><div class="conf">Confidential — Prepared for Client Use Only</div></div>

Output ONLY the completed HTML. No markdown. No preamble.`;
}
