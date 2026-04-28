// functions/api/finalise.js
// POST /api/finalise — save edited/annotated HTML as final version of a report

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("X-Admin-Password");
  if (auth !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const { reportId, html } = body;
  if (!reportId || !html) return json({ error: "Missing reportId or html" }, 400);

  try {
    const metaRaw = await env.CITADEL_KV.get(`report:${reportId}`);
    if (!metaRaw) return json({ error: "Report not found" }, 404);

    const meta = JSON.parse(metaRaw);
    meta.status = "final";
    meta.finalisedAt = new Date().toISOString();

    await env.CITADEL_KV.put(`report-html:${reportId}`, html, { expirationTtl: 31536000 });
    await env.CITADEL_KV.put(`report:${reportId}`, JSON.stringify(meta), { expirationTtl: 31536000 });

    // Update reports index
    let idx = [];
    try { const e = await env.CITADEL_KV.get("reports-index"); if (e) idx = JSON.parse(e); } catch {}
    const i = idx.findIndex(r => r.id === reportId);
    if (i >= 0) { idx[i] = meta; } else { idx.unshift(meta); }
    await env.CITADEL_KV.put("reports-index", JSON.stringify(idx));

    return json({ success: true, report: meta });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function json(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
