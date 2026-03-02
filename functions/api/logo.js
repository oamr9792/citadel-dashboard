// functions/api/logo.js
// =====================
// POST /api/logo — upload logo base64 to KV for embedding in reports
// GET /api/logo — check if logo is stored

export async function onRequestPost(context) {
  const { env, request } = context;

  const authHeader = request.headers.get("X-Admin-Password");
  if (authHeader !== env.ADMIN_PASSWORD) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await request.json();
    if (!body.base64) return json({ error: "Missing base64 field" }, 400);

    await env.CITADEL_KV.put("logo-base64", body.base64);
    return json({ success: true, length: body.base64.length });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export async function onRequestGet(context) {
  const { env, request } = context;

  const authHeader = request.headers.get("X-Admin-Password");
  if (authHeader !== env.ADMIN_PASSWORD) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const stored = await env.CITADEL_KV.get("logo-base64");
    return json({ hasLogo: !!stored, length: stored ? stored.length : 0 });
  } catch {
    return json({ hasLogo: false });
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
