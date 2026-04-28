// functions/api/combine.js
// POST /api/combine — Merge multiple existing reports into one combined document

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("X-Admin-Password");
  if (auth !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const { reportIds, clientName, combinedTitle } = body;
  if (!reportIds || !reportIds.length || reportIds.length < 2) {
    return json({ error: "Select at least 2 reports to combine" }, 400);
  }

  if (!env.ANTHROPIC_API_KEY) return json({ error: "No API key" }, 400);

  try {
    // Fetch HTML for each report
    const reportData = [];
    for (const id of reportIds) {
      const meta = await env.CITADEL_KV.get(`report:${id}`);
      const html = await env.CITADEL_KV.get(`report-html:${id}`);
      if (meta && html) {
        const m = JSON.parse(meta);
        // Extract text content from HTML (strip tags for Claude input)
        const textContent = html
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 12000); // cap per report to manage context
        reportData.push({ meta: m, textContent });
      }
    }

    if (!reportData.length) return json({ error: "Could not load any of the selected reports" }, 400);

    const clientNameResolved = clientName || reportData[0].meta.clientName || "Client";
    const title = combinedTitle || `Combined Report — ${clientNameResolved}`;

    const dataPayload = reportData.map((r, i) => `
=== REPORT ${i + 1}: ${r.meta.typeName || r.meta.type} (${r.meta.clientName}) ===
Generated: ${r.meta.createdAt ? new Date(r.meta.createdAt).toDateString() : "unknown"}
${r.meta.dateA ? `Date range: ${r.meta.dateA} to ${r.meta.dateB || "latest"}` : ""}

${r.textContent}
`).join("\n\n");

    const systemPrompt = buildCombineSystemPrompt();
    const userPrompt = `Combined report title: ${title}
Client(s): ${[...new Set(reportData.map(r => r.meta.clientName))].join(", ")}
Number of reports: ${reportData.length}
Report types: ${reportData.map(r => r.meta.typeName || r.meta.type).join(", ")}

${dataPayload}

CRITICAL: Output ONLY complete HTML. No markdown. No commentary.`;

    let html = await callClaudeStream(env.ANTHROPIC_API_KEY, systemPrompt, userPrompt);
    html = html.trim();
    if (html.startsWith("```")) html = html.replace(/^```(?:html)?\n?/, "").replace(/\n?```$/, "");

    const shareToken = genTok();
    const reportId = `r_${Date.now()}`;
    const clientId = reportData[0].meta.clientId || "combined";

    const meta = {
      id: reportId,
      clientId,
      clientName: clientNameResolved,
      type: "combined",
      typeName: title,
      keywords: [...new Set(reportData.map(r => r.meta.keywords).filter(Boolean))].join(", "),
      sourceReportIds: reportIds,
      createdAt: new Date().toISOString(),
      shareToken,
      status: "complete"
    };

    await env.CITADEL_KV.put(`report-html:${reportId}`, html, { expirationTtl: 31536000 });
    await env.CITADEL_KV.put(`report:${reportId}`, JSON.stringify(meta), { expirationTtl: 31536000 });
    await env.CITADEL_KV.put(`share:${shareToken}`, reportId, { expirationTtl: 31536000 });

    let idx = [];
    try { const e = await env.CITADEL_KV.get("reports-index"); if (e) idx = JSON.parse(e); } catch {}
    idx.unshift(meta);
    await env.CITADEL_KV.put("reports-index", JSON.stringify(idx));

    return json({ success: true, report: meta });

  } catch (err) {
    return json({ error: `Combine failed: ${err.message}` }, 500);
  }
}

async function callClaudeStream(apiKey, system, user) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 64000,
      stream: true,
      system,
      messages: [{ role: "user", content: user }]
    })
  });
  if (!r.ok) { const e = await r.text(); throw new Error(`Claude ${r.status}: ${e.substring(0, 200)}`); }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let txt = "", buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const ln of lines) {
      if (!ln.startsWith("data: ")) continue;
      const d = ln.slice(6).trim();
      if (d === "[DONE]") continue;
      try { const p = JSON.parse(d); if (p.type === "content_block_delta" && p.delta?.type === "text_delta") txt += p.delta.text; } catch {}
    }
  }
  if (!txt) throw new Error("Empty response from Claude");
  return txt;
}

function genTok() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}

function json(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

function buildCombineSystemPrompt() {
  const LOGO = "https://citadel-dashboard.pages.dev/logo.png";

  const CSS = `:root{--bg:#fff;--card:#f0f3f8;--card-border:#d4dae6;--navy:#1b2a4a;--navy-light:#2c4170;--red:#c0392b;--amber:#d4880f;--green:#1e8449;--text:#1e293b;--muted:#5a6a85;--border:#d4dae6;--header-bg:#000;--owned-gold:#b8860b}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;color:var(--text);background:var(--bg);line-height:1.6}
h1,h2,h3{font-family:Georgia,serif;color:var(--navy)}
.header{background:var(--header-bg);padding:32px 48px;display:flex;align-items:center;gap:24px}
.header img{height:50px}.header .divider{width:1px;height:60px;background:rgba(255,255,255,.3)}
.header h1{font-size:1.6rem;color:#fff;margin-bottom:4px}.header .sub{color:#8899b4;font-size:.9rem}
.wrap{max-width:1100px;margin:0 auto;padding:32px 24px}
.sec{margin-bottom:40px}
.sec-title{font-size:1.3rem;color:var(--navy);border-bottom:3px solid var(--navy);padding-bottom:8px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--card-border);border-radius:10px;padding:24px;margin-bottom:16px}
.g2{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.st{background:#fff;border:1px solid var(--card-border);border-radius:8px;padding:20px;text-align:center}
.st .n{font-size:2rem;font-weight:700;font-family:Georgia,serif}
.st .l{font-size:.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-top:4px}
.n-bl{color:var(--navy)}.n-gr{color:var(--green)}.n-rd{color:var(--red)}.n-am{color:var(--amber)}
table.dt{width:100%;border-collapse:collapse}
.dt th{text-align:left;font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted);padding:10px 12px;background:rgba(27,42,74,.04);border-bottom:2px solid var(--border)}
.dt td{padding:10px 12px;border-bottom:1px solid var(--border);font-size:.88rem}
.tg{display:inline-block;padding:3px 10px;border-radius:4px;font-size:.75rem;font-weight:600}
.tg-gr{background:rgba(30,132,73,.12);color:var(--green)}
.tg-rd{background:rgba(192,57,43,.12);color:var(--red)}
.tg-am{background:rgba(212,136,15,.12);color:var(--amber)}
.tg-bl{background:rgba(27,42,74,.12);color:var(--navy)}
.report-section{border:1px solid var(--card-border);border-radius:12px;overflow:hidden;margin-bottom:32px}
.report-section-header{background:var(--navy);color:#fff;padding:14px 24px;font-size:1rem;font-family:Georgia,serif}
.report-section-body{padding:24px}
.al{list-style:none;counter-reset:a}
.al li{counter-increment:a;padding:12px 16px 12px 48px;position:relative;border-bottom:1px solid var(--border);font-size:.92rem}
.al li::before{content:counter(a);position:absolute;left:12px;top:12px;width:24px;height:24px;background:var(--navy);color:#fff;border-radius:50%;text-align:center;line-height:24px;font-size:.75rem;font-weight:700}
.ft{text-align:center;padding:32px 24px;border-top:3px solid var(--navy);margin-top:48px;color:var(--muted);font-size:.85rem}
.conf{color:var(--red);font-weight:700;text-transform:uppercase;letter-spacing:2px;font-size:.8rem;margin-top:12px}
@media(max-width:700px){.g2,.g3,.g4{grid-template-columns:1fr}}`;

  return `You are a senior ORM analyst for Reputation Citadel. Synthesise multiple reports into a single coherent Combined Report in HTML.

INSTRUCTIONS:
- Create a unified narrative that weaves findings from all source reports together
- Do not simply concatenate — identify cross-report themes, patterns, and priorities
- Executive summary should reflect the combined picture across all reports/clients
- Each source report gets its own section with key findings extracted and summarised
- End with unified action items that address the highest priorities across all reports
- TONE: Professional, client-facing. Encouraging but honest.

USE THIS EXACT CSS AND STRUCTURE:

<style>${CSS}</style>

STRUCTURE:

<div class="header"><img src="${LOGO}" alt="Reputation Citadel"><div class="divider"></div><div class="title"><h1>[COMBINED TITLE]</h1><div class="sub">[CLIENT(S)] · [DATE]</div></div></div>

<div class="wrap">

SEC 1 — Executive Overview: div.sec > h2.sec-title + div.card > p
High-level narrative of what all the reports show combined.

SEC 2 — Key Metrics Across All Reports: div.sec > h2.sec-title + div.g4 of div.st
Select the 4 most meaningful cross-report metrics.

SEC 3 — Per-Report Sections: for each source report, a div.report-section with:
  - div.report-section-header with report name/type
  - div.report-section-body with key findings, top positives, top concerns, 2-3 bullet points

SEC 4 — Cross-Report Themes: div.sec > h2.sec-title + div.card
What patterns emerge across all reports? What is the overall narrative?

SEC 5 — Unified Action Items: div.sec > h2.sec-title + ol.al > li (use "We will..." framing). 5-8 items.

</div>
<div class="ft">Reputation Citadel · Combined Report · Generated [DATE]<br><div class="conf">Confidential — Prepared for Client Use Only</div></div>

Output ONLY the completed HTML. No markdown. No preamble.`;
}
