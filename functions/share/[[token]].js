// functions/share/[[token]].js
// =============================
// GET /share/:token
// Serves the generated report HTML to anyone with the share link.
// No password required — the token IS the auth.

export async function onRequestGet(context) {
  const { params, env } = context;
  const token = params.token;

  if (!token) {
    return new Response(errorPage("No report token provided"), {
      status: 400,
      headers: { "Content-Type": "text/html" },
    });
  }

  try {
    // Look up report ID from share token
    const reportId = await env.CITADEL_KV.get(`share:${token}`);
    if (!reportId) {
      return new Response(errorPage("Report not found or link has expired"), {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
    }

    // Fetch the report HTML
    const html = await env.CITADEL_KV.get(`report-html:${reportId}`);
    if (!html) {
      return new Response(errorPage("Report content not found"), {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
    }

    // Serve the report
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    return new Response(errorPage("An error occurred loading this report"), {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}

function errorPage(message) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reputation Citadel</title>
  <style>
    body { font-family: Georgia, serif; background: #0a0e17; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { text-align: center; max-width: 400px; padding: 40px; }
    h1 { color: #b8860b; font-size: 1.4rem; margin-bottom: 12px; }
    p { color: #64748b; font-size: 0.95rem; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Reputation Citadel</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}
