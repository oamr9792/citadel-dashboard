// functions/api/revise.js
// POST /api/revise — rewrite a single report section based on an annotation

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("X-Admin-Password");
  if (auth !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const { sectionHtml, annotation, reportContext } = body;
  if (!sectionHtml || !annotation) return json({ error: "Missing sectionHtml or annotation" }, 400);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "No API key" }, 400);

  try {
    const system = `You are an ORM report editor for Reputation Citadel. You receive a section of an HTML report and an annotation (instruction from the analyst). Rewrite ONLY the section HTML according to the instruction. Preserve all CSS classes, structure, and styling exactly. Change only the text content as directed. Output ONLY the revised HTML for that section — no preamble, no markdown, no explanation.`;

    const user = `Report context: ${reportContext || "ORM report"}

ORIGINAL SECTION HTML:
${sectionHtml}

ANNOTATION / INSTRUCTION:
${annotation}

Rewrite the section HTML according to the instruction. Preserve all classes and structure. Output only the revised HTML.`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        system,
        messages: [{ role: "user", content: user }]
      })
    });

    if (!resp.ok) { const e = await resp.text(); throw new Error(`Claude ${resp.status}: ${e.substring(0, 200)}`); }
    const data = await resp.json();
    let revised = data.content?.[0]?.text || "";
    revised = revised.trim();
    if (revised.startsWith("```")) revised = revised.replace(/^```(?:html)?\n?/, "").replace(/\n?```$/, "");

    return json({ success: true, revised });
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
