// functions/api/sheet-dates.js
// POST /api/sheet-dates — fetch available snapshot dates from SERP_Archive

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("X-Admin-Password");
  if (auth !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { sheetUrl } = body;
  if (!sheetUrl) return json({ error: "Missing sheetUrl" }, 400);

  try {
    const csv = await fetchArchiveTab(sheetUrl);
    if (!csv) return json({ error: "Could not fetch archive tab. Ensure sheet is shared publicly." }, 400);

    const lines = csv.split("\n");
    const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
    const snapIdx = headers.findIndex(h => h.includes("snapshot") || h.includes("fetched"));
    const kwIdx = headers.findIndex(h => h === "keyword");

    if (snapIdx < 0) return json({ error: "No snapshot date column found in archive." }, 400);

    // Collect unique dates and keywords
    const dateSet = new Set();
    const kwSet = new Set();

    function rawToDateStr(raw) {
      if (!raw) return null;
      raw = raw.trim();
      let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
      const d = new Date(raw);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      return null;
    }

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols = parseCSVLine(lines[i]);
      const rawDate = (cols[snapIdx] || "").trim();
      if (!rawDate) continue;
      const ds = rawToDateStr(rawDate);
      if (!ds) continue;
      dateSet.add(ds);
      if (kwIdx >= 0) {
        const kw = (cols[kwIdx] || "").trim();
        if (kw) kwSet.add(kw);
      }
    }

    const dates = Array.from(dateSet).sort();
    const keywords = Array.from(kwSet).sort();

    return json({ success: true, dates, keywords });

  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function fetchArchiveTab(sheetUrl) {
  const m = sheetUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const id = m[1];

  const knownGids = ["697017722"];
  for (const gid of knownGids) {
    const csv = await fetchCsvByGid(id, gid);
    if (csv) {
      const firstLine = csv.split("\n")[0].toLowerCase();
      if (firstLine.includes("snapshot") || (firstLine.includes("rank") && firstLine.includes("url"))) return csv;
    }
  }

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
    }
  } catch {}

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
      if (csv.split("\n")[0].split(",").length < 3) continue;
      return csv;
    } catch {}
  }
  return null;
}

function parseCSVLine(line) {
  const result = [];
  let current = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function json(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
