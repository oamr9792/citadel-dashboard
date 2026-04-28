// functions/api/debug-sheet.js
// POST /api/debug-sheet — inspect what tabs are available in a Google Sheet

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("X-Admin-Password");
  if (auth !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { sheetUrl } = body;
  if (!sheetUrl) return json({ error: "Missing sheetUrl" }, 400);

  const m = sheetUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return json({ error: "Invalid sheet URL" }, 400);
  const id = m[1];

  const results = { sheetId: id, tabs: [], feedResult: null };

  // Try feeds API
  try {
    const feedUrl = `https://spreadsheets.google.com/feeds/worksheets/${id}/public/basic?alt=json`;
    const r = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
    results.feedResult = { status: r.status, ok: r.ok };
    if (r.ok) {
      const data = await r.json();
      const entries = data?.feed?.entry || [];
      results.tabs = entries.map(e => {
        const selfLink = e?.link?.find(l => l.rel === "self")?.href || "";
        const gidMatch = selfLink.match(/\/(\d+)$/);
        return {
          title: e?.title?.$t || "unknown",
          gid: gidMatch ? gidMatch[1] : "unknown",
          link: selfLink
        };
      });
    }
  } catch (e) {
    results.feedError = e.message;
  }

  // Try gids 0-10 directly
  results.gidScan = [];
  for (let gid = 0; gid <= 10; gid++) {
    try {
      // Use export format — more reliable for specific gids than gviz/tq
      const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&id=${id}&gid=${gid}`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
      const text = await r.text();
      const isHtml = text.includes("<!DOCTYPE") || text.includes("<html");
      const firstLine = text.split("\n")[0] || "";
      results.gidScan.push({
        gid,
        status: r.status,
        ok: r.ok && !isHtml,
        isHtml,
        firstLine: firstLine.slice(0, 200),
        rowCount: text.split("\n").length,
        hasSnapshot: firstLine.toLowerCase().includes("snapshot"),
        hasRankUrlKw: firstLine.toLowerCase().includes("rank") && firstLine.toLowerCase().includes("url") && firstLine.toLowerCase().includes("keyword"),
      });
    } catch (e) {
      results.gidScan.push({ gid, error: e.message });
    }
  }

  return json(results);
}

function json(d, s = 200) {
  return new Response(JSON.stringify(d, null, 2), {
    status: s,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
