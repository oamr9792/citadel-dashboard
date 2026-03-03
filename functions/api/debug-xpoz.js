export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("X-Admin-Password");
  if (auth !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);
  const body = await request.json().catch(() => ({}));

  let token = body.xpozToken || env.XPOZ_API_KEY;
  if (!token) {
    try { const s = await env.CITADEL_KV.get("xpoz-oauth-token"); if (s) token = JSON.parse(s).access_token; } catch {}
  }
  if (!token) return json({ error: "No token available" });

  const results = { token_preview: token.substring(0, 30) + "..." };
  const hdrs = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": `Bearer ${token}` };

  // Step 1: Init
  try {
    const r = await fetch("https://mcp.xpoz.ai/mcp", {
      method: "POST", headers: hdrs,
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "citadel", version: "1.0" } }
      })
    });
    // Parse SSE to get session ID
    const allHeaders = {};
    r.headers.forEach((v, k) => allHeaders[k] = v);
    const text = await r.text();
    results.init_status = r.status;
    results.init_headers = allHeaders;
    results.init_response_preview = text.substring(0, 300);
    
    // Try to find session ID in response
    let sessionId = r.headers.get("mcp-session-id") || r.headers.get("Mcp-Session-Id");
    
    // Also check if it's in the SSE data
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.sessionId) sessionId = parsed.sessionId;
          if (parsed.result && parsed.result.sessionId) sessionId = parsed.result.sessionId;
        } catch {}
      }
    }
    results.session_id = sessionId || "NOT_FOUND";

    // Step 2: Send initialized notification (try with and without session)
    const notifHdrs = { ...hdrs };
    if (sessionId) notifHdrs["Mcp-Session-Id"] = sessionId;
    await fetch("https://mcp.xpoz.ai/mcp", {
      method: "POST", headers: notifHdrs,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    });

    // Step 3: Call Twitter search (try WITHOUT session ID first since Xpoz may not require it)
    const searchHdrs = { ...hdrs };
    if (sessionId) searchHdrs["Mcp-Session-Id"] = sessionId;
    
    const r2 = await fetch("https://mcp.xpoz.ai/mcp", {
      method: "POST", headers: searchHdrs,
      body: JSON.stringify({
        jsonrpc: "2.0", id: "2", method: "tools/call",
        params: {
          name: "getTwitterPostsByKeywords",
          arguments: { query: "Murry Gunty", fields: ["id", "text", "authorUsername", "createdAtDate"], userPrompt: "Find tweets about Murry Gunty" }
        }
      })
    });
    const r2Headers = {};
    r2.headers.forEach((v, k) => r2Headers[k] = v);
    const r2Text = await r2.text();
    results.search_status = r2.status;
    results.search_headers = r2Headers;
    results.search_response = r2Text.substring(0, 1500);
  } catch (e) {
    results.error = e.message;
  }

  return json(results);
}

function json(d, s = 200) {
  return new Response(JSON.stringify(d, null, 2), {
    status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
