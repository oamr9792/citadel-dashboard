// functions/api/xpoz-token.js — Store and retrieve Xpoz OAuth token
// POST: save token to KV after frontend OAuth flow
// GET: retrieve stored token

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("X-Admin-Password");
  if (auth !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);

  const body = await request.json();
  if (!body.access_token) return json({ error: "No access_token" }, 400);

  // Store token with metadata
  const tokenData = {
    access_token: body.access_token,
    refresh_token: body.refresh_token || null,
    token_type: body.token_type || "Bearer",
    expires_in: body.expires_in || null,
    stored_at: new Date().toISOString()
  };

  // Store in KV with 30-day TTL (token may expire sooner but we'll try)
  await env.CITADEL_KV.put("xpoz-oauth-token", JSON.stringify(tokenData), { expirationTtl: 2592000 });

  return json({ ok: true, stored_at: tokenData.stored_at });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = request.headers.get("X-Admin-Password");
  if (auth !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);

  const raw = await env.CITADEL_KV.get("xpoz-oauth-token");
  if (!raw) return json({ has_token: false });

  const tokenData = JSON.parse(raw);
  return json({
    has_token: true,
    stored_at: tokenData.stored_at,
    has_refresh: !!tokenData.refresh_token
  });
}

function json(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
