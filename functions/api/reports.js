// functions/api/reports.js
// ========================
// GET /api/reports — list all reports
// DELETE /api/reports?id=xxx — delete a report

export async function onRequestGet(context) {
  const { env, request } = context;

  const authHeader = request.headers.get("X-Admin-Password");
  if (authHeader !== env.ADMIN_PASSWORD) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const index = await env.CITADEL_KV.get("reports-index");
    const reports = index ? JSON.parse(index) : [];
    return json({ reports });
  } catch {
    return json({ reports: [] });
  }
}

export async function onRequestDelete(context) {
  const { env, request } = context;

  const authHeader = request.headers.get("X-Admin-Password");
  if (authHeader !== env.ADMIN_PASSWORD) {
    return json({ error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing report id" }, 400);

  try {
    // Get report meta to find share token
    const metaStr = await env.CITADEL_KV.get(`report:${id}`);
    if (metaStr) {
      const meta = JSON.parse(metaStr);
      if (meta.shareToken) {
        await env.CITADEL_KV.delete(`share:${meta.shareToken}`);
      }
    }

    // Delete report data
    await env.CITADEL_KV.delete(`report:${id}`);
    await env.CITADEL_KV.delete(`report-html:${id}`);

    // Update index
    const index = await env.CITADEL_KV.get("reports-index");
    let reports = index ? JSON.parse(index) : [];
    reports = reports.filter((r) => r.id !== id);
    await env.CITADEL_KV.put("reports-index", JSON.stringify(reports));

    return json({ success: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
