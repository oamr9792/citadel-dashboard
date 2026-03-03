// functions/api/debug-xpoz.js — Diagnostic endpoint
export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("X-Admin-Password");
  if (auth !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);

  const body = await request.json().catch(() => ({}));
  const results = {
    step1_token_sources: {
      body_token: body.xpozToken ? body.xpozToken.substring(0, 30) + "..." : null,
      env_XPOZ_API_KEY: env.XPOZ_API_KEY ? env.XPOZ_API_KEY.substring(0, 30) + "..." : null,
      kv_token: null
    },
    step2_resolved_token: null,
    step3_mcp_init: null,
    step4_twitter_search: null
  };

  // Check KV
  try {
    const stored = await env.CITADEL_KV.get("xpoz-oauth-token");
    if (stored) {
      const parsed = JSON.parse(stored);
      results.step1_token_sources.kv_token = {
        stored_at: parsed.stored_at,
        preview: parsed.access_token ? parsed.access_token.substring(0, 30) + "..." : null
      };
    }
  } catch (e) { results.step1_token_sources.kv_token = { error: e.message }; }

  // Resolve token
  let token = body.xpozToken || env.XPOZ_API_KEY;
  if (!token) {
    try {
      const stored = await env.CITADEL_KV.get("xpoz-oauth-token");
      if (stored) token = JSON.parse(stored).access_token;
    } catch {}
  }
  results.step2_resolved_token = token ? token.substring(0, 30) + "..." : "NONE - no token available";

  if (!token) return json(results);

  // Test MCP init
  try {
    const hdrs = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": `Bearer ${token}`
    };
    const r = await fetch("https://mcp.xpoz.ai/mcp", {
      method: "POST", headers: hdrs,
      body: JSON.stringify({
        jsonrpc: "2.0", id: "1", method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "citadel-debug", version: "1.0" } }
      })
    });
    const sid = r.headers.get("Mcp-Session-Id");
    const responseText = await r.text();
    results.step3_mcp_init = {
      status: r.status,
      session_id: sid,
      response: responseText.substring(0, 500)
    };

    // If init succeeded, try a Twitter search
    if (r.ok && sid) {
      // Send initialized notification
      await fetch("https://mcp.xpoz.ai/mcp", {
        method: "POST",
        headers: { ...hdrs, "Mcp-Session-Id": sid },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
      });

      // Call Twitter search
      const r2 = await fetch("https://mcp.xpoz.ai/mcp", {
        method: "POST",
        headers: { ...hdrs, "Mcp-Session-Id": sid },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "2", method: "tools/call",
          params: {
            name: "getTwitterPostsByKeywords",
            arguments: {
              query: "Murry Gunty",
              fields: ["id", "text", "authorUsername", "createdAtDate"],
              userPrompt: "Find tweets about Murry Gunty"
            }
          }
        })
      });
      const r2Text = await r2.text();
      results.step4_twitter_search = {
        status: r2.status,
        response: r2Text.substring(0, 1000)
      };
    }
  } catch (e) {
    results.step3_mcp_init = { error: e.message };
  }

  return json(results);
}

function json(d, s = 200) {
  return new Response(JSON.stringify(d, null, 2), {
    status: s,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
