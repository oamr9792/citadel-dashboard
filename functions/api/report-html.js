// functions/api/report-html.js
// ============================
// GET /api/report-html?id=xxx — fetch the HTML content of a report

export async function onRequestGet(context) {
  const { env, request } = context;

  const authHeader = request.headers.get("X-Admin-Password");
  if (authHeader !== env.ADMIN_PASSWORD) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return new Response("Missing id", { status: 400 });

  try {
    const html = await env.CITADEL_KV.get(`report-html:${id}`);
    if (!html) return new Response("Report not found", { status: 404 });

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
}
