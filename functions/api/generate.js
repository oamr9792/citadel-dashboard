// functions/api/generate.js
// ===========================
// POST /api/generate
// Accepts: { clientId, clientName, type, keywords, sheetUrl, systemPrompt }
// Returns: { success, report }
//
// This is the main backend function that:
// 1. Pulls CSV data from a Google Sheet
// 2. Calls DataForSEO LLM Responses API (for LLM reports)
// 3. Sends everything to Claude for analysis
// 4. Stores the generated HTML in KV
// 5. Returns the report metadata

export async function onRequestPost(context) {
  const { request, env } = context;

  // Check auth
  const authHeader = request.headers.get("X-Admin-Password");
  if (authHeader !== env.ADMIN_PASSWORD) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { clientId, clientName, type, keywords, sheetUrl, previousReportId } = body;

  if (!clientId || !clientName || !type) {
    return json({ error: "Missing required fields: clientId, clientName, type" }, 400);
  }

  try {
    let reportHtml = "";
    const typeNames = {
      serp: "SERP & ORM Analysis",
      social: "Social Media Intelligence",
      llm: "LLM Reputation Intelligence",
      executive: "Executive Summary",
    };

    // ── Step 1: Gather data based on report type ──
    let dataPayload = "";
    const reportDate = new Date().toISOString().split("T")[0];

    if (type === "serp" || type === "executive") {
      // Pull Google Sheet data
      if (sheetUrl) {
        const sheetData = await fetchGoogleSheet(sheetUrl);
        if (sheetData) {
          dataPayload += `\n=== GOOGLE SHEET DATA ===\n${sheetData}\n`;
        } else {
          dataPayload += `\n=== GOOGLE SHEET DATA ===\nUnable to fetch sheet. Ensure it is shared publicly.\n`;
        }
      }
    }

    if (type === "llm" || type === "executive") {
      // Call DataForSEO LLM Responses API
      if (env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD && keywords) {
        const llmData = await fetchLLMResponses(
          keywords,
          clientName,
          env.DATAFORSEO_LOGIN,
          env.DATAFORSEO_PASSWORD
        );
        dataPayload += `\n=== LLM RESPONSES DATA ===\n${JSON.stringify(llmData, null, 2)}\n`;
      } else {
        dataPayload += `\n=== LLM RESPONSES DATA ===\nDataForSEO credentials not configured or no keywords provided.\n`;
      }
    }

    if (type === "social" || type === "executive") {
      // For social media, we provide the keywords and let Claude work with available data
      dataPayload += `\n=== SOCIAL MEDIA ANALYSIS REQUEST ===\nClient: ${clientName}\nKeywords: ${keywords || "N/A"}\nAnalyze social media presence and sentiment for this client.\n`;
    }

    // Load previous report for trend analysis if provided
    if (previousReportId) {
      const prevHtml = await env.CITADEL_KV.get(`report-html:${previousReportId}`);
      if (prevHtml) {
        dataPayload += `\n=== PREVIOUS REPORT (for trend comparison) ===\n${prevHtml.substring(0, 30000)}\n`;
      }
    }

    // ── Step 2: Build prompt for Claude ──
    const logoBase64 = await getLogoBase64(env);

    const systemPrompt = buildSystemPrompt(type, logoBase64);
    const userPrompt = buildUserPrompt(type, clientName, keywords, reportDate, dataPayload);

    // ── Step 3: Call Claude API ──
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "Anthropic API key not configured. Go to Cloudflare dashboard → Settings → Environment variables." }, 400);
    }

    reportHtml = await callClaude(env.ANTHROPIC_API_KEY, systemPrompt, userPrompt);

    // Clean up markdown fences if Claude wrapped the output
    reportHtml = reportHtml.trim();
    if (reportHtml.startsWith("```")) {
      reportHtml = reportHtml.replace(/^```(?:html)?\n?/, "").replace(/\n?```$/, "");
    }

    // ── Step 4: Store report ──
    const shareToken = generateToken();
    const reportId = `r_${Date.now()}`;
    const reportMeta = {
      id: reportId,
      clientId,
      clientName,
      type,
      typeName: typeNames[type] || type,
      keywords: keywords || "",
      sheetUrl: sheetUrl || "",
      createdAt: new Date().toISOString(),
      shareToken,
      status: "complete",
    };

    // Store HTML separately (can be large)
    await env.CITADEL_KV.put(`report-html:${reportId}`, reportHtml, {
      expirationTtl: 60 * 60 * 24 * 365, // 1 year
    });

    // Store metadata
    await env.CITADEL_KV.put(`report:${reportId}`, JSON.stringify(reportMeta), {
      expirationTtl: 60 * 60 * 24 * 365,
    });

    // Store share token → report ID mapping
    await env.CITADEL_KV.put(`share:${shareToken}`, reportId, {
      expirationTtl: 60 * 60 * 24 * 365,
    });

    // Update reports index
    let reportsIndex = [];
    try {
      const existing = await env.CITADEL_KV.get("reports-index");
      if (existing) reportsIndex = JSON.parse(existing);
    } catch {}
    reportsIndex.unshift(reportMeta);
    await env.CITADEL_KV.put("reports-index", JSON.stringify(reportsIndex));

    return json({ success: true, report: reportMeta });
  } catch (err) {
    return json({ error: `Generation failed: ${err.message}` }, 500);
  }
}

// ══════════════════════════════════════════
// Google Sheets Fetcher
// ══════════════════════════════════════════
async function fetchGoogleSheet(sheetUrl) {
  // Extract sheet ID
  const match = sheetUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return null;
  const sheetId = match[1];

  const tabs = {};

  // Try fetching multiple gids
  for (const gid of ["0", "1", "2", "3"]) {
    const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    try {
      const resp = await fetch(exportUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        redirect: "follow",
      });
      if (resp.ok) {
        const csv = await resp.text();
        if (csv && csv.trim().length > 10) {
          // Try to identify the tab by first row
          const firstLine = csv.split("\n")[0].toLowerCase();
          let tabName = `Tab_gid${gid}`;
          if (firstLine.includes("rank") || firstLine.includes("serp") || firstLine.includes("keyword")) {
            tabName = `SERP_Tracker_gid${gid}`;
          } else if (firstLine.includes("content") || firstLine.includes("live url") || firstLine.includes("created")) {
            tabName = `Content_Created_gid${gid}`;
          }
          tabs[tabName] = csv;
        }
      }
    } catch {}
  }

  if (Object.keys(tabs).length === 0) return null;

  let output = "";
  for (const [name, csv] of Object.entries(tabs)) {
    const rowCount = csv.split("\n").length;
    output += `\n--- Sheet Tab: ${name} (${rowCount} rows) ---\n${csv}\n`;
  }
  return output;
}

// ══════════════════════════════════════════
// DataForSEO LLM Responses
// ══════════════════════════════════════════
async function fetchLLMResponses(keywords, clientName, login, password) {
  const auth = btoa(`${login}:${password}`);
  const keywordList = keywords.split(",").map((k) => k.trim()).filter(Boolean);

  // Build a set of reputation-relevant queries
  const queries = [];
  for (const kw of keywordList.slice(0, 3)) {
    queries.push(`Who is ${kw}?`);
    queries.push(`What do you know about ${kw}?`);
    queries.push(`${kw} reputation`);
  }

  const results = { chatgpt: [], gemini: [], claude: [], perplexity: [] };
  const platforms = [
    { key: "chatgpt", path: "chat_gpt", model: "gpt-4o-mini" },
    { key: "gemini", path: "gemini", model: "gemini-2.0-flash" },
    { key: "claude", path: "claude", model: "claude-sonnet-4-20250514" },
  ];

  for (const platform of platforms) {
    for (const query of queries.slice(0, 1)) {
      try {
        const resp = await fetch(
          `https://api.dataforseo.com/v3/ai_optimization/${platform.path}/llm_responses/live`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${auth}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify([
              {
                user_prompt: query,
                model_name: platform.model,
                max_output_tokens: 500,
                web_search: true,
              },
            ]),
          }
        );

        if (resp.ok) {
          const data = await resp.json();
          const task = data?.tasks?.[0];
          if (task?.status_code === 20000 && task?.result) {
            for (const r of task.result) {
              results[platform.key].push({
                query,
                response_text: r.response_text || r.text || "",
                fan_out_queries: r.fan_out_queries || [],
                citations: r.citations || r.references || [],
                model: platform.model,
              });
            }
          }
        }
      } catch (err) {
        results[platform.key].push({
          query,
          error: err.message,
        });
      }

      // Small delay to respect rate limits
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}

// ══════════════════════════════════════════
// Claude API
// ══════════════════════════════════════════
async function callClaude(apiKey, systemPrompt, userPrompt) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${errBody}`);
  }

  const data = await resp.json();
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ══════════════════════════════════════════
// System Prompts
// ══════════════════════════════════════════
function buildSystemPrompt(type, logoBase64) {
  const logoSrc = logoBase64
    ? `data:image/jpeg;base64,${logoBase64}`
    : "";

  const baseCSS = `
:root {
  --bg: #ffffff; --card: #f0f3f8; --card-border: #d4dae6;
  --navy: #1b2a4a; --navy-light: #2c4170; --accent: #1b2a4a;
  --red: #c0392b; --amber: #d4880f; --green: #1e8449;
  --text: #1e293b; --muted: #5a6a85; --border: #d4dae6;
  --header-bg: #000000; --owned-gold: #b8860b;
}`;

  const headerHTML = logoSrc
    ? `The logo img src should be exactly: ${logoSrc}`
    : "No logo available.";

  const commonRules = `
TONE: Client-facing, professional, encouraging. Use "Mr./Ms. [Last Name]" for the client.
FORMAT: Single self-contained HTML file. Georgia for headings, 'Segoe UI' for body.
CSS theme: ${baseCSS}
Header: Black background, Reputation Citadel branding. ${headerHTML}
Footer: "Reputation Citadel · [Report Type] · Generated [DATE]" + "CONFIDENTIAL" in red.
No emojis in headings. Tables use uppercase letter-spaced headers. Mobile responsive.
Output ONLY the complete HTML — no markdown fences, no commentary.`;

  if (type === "serp") {
    return `You are an ORM analyst for Reputation Citadel generating a SERP & ORM Analysis Report.
Analyze the provided Google Sheet CSV data containing SERP tracker results and Content Created inventory.
Compute: SERP ownership, sentiment distribution, negative exposure, owned content performance, movement analysis.
Required sections: Executive Summary, Key Metrics Dashboard, SERP Ownership Map, Sentiment Analysis, Owned Content Performance, Negative Exposure Analysis, Unowned Positive Results, Key Observations & Recommendations, Footer.
${commonRules}`;
  }

  if (type === "llm") {
    return `You are an AI Reputation Intelligence analyst for Reputation Citadel generating an LLM Reputation Intelligence Report.
Analyze how ChatGPT, Claude, Gemini, and Perplexity represent the client based on the provided LLM response data.
Compute: Response sentiment per platform, narrative themes, negative content propagation, fan-out query analysis, source citation tracking, AI Reputation Risk Score (1-100).
Required sections: Executive Summary, AI Reputation Risk Score, Key Metrics Dashboard, Cross-Platform Sentiment Matrix, LLM Response Analysis (per query), Fan-Out Query Analysis, Source & Ownership Analysis, Negative Content Propagation Map, Key Observations & Recommendations, Footer.
Note: Source citations are most complete from Perplexity/Gemini. Flag when data is unavailable rather than fabricating.
${commonRules}`;
  }

  if (type === "social") {
    return `You are a Social Media Intelligence analyst for Reputation Citadel generating a Social Media Intelligence Report.
Analyze the client's social media presence, sentiment, and reputation based on available data.
Required sections: Executive Summary, Key Metrics, Platform Analysis, Sentiment Overview, Key Observations & Recommendations, Footer.
${commonRules}`;
  }

  if (type === "executive") {
    return `You are a senior ORM analyst for Reputation Citadel generating an Executive Summary Report.
This report synthesizes findings across SERP analysis, social media intelligence, and LLM reputation data into a concise executive brief.
Required sections: Executive Overview, SERP Snapshot, Social Media Snapshot, AI/LLM Reputation Snapshot, Combined Risk Assessment, Strategic Recommendations, Footer.
Keep it concise — this is a C-suite summary, not the full report.
${commonRules}`;
  }

  return `You are an ORM analyst for Reputation Citadel. Generate a professional report based on the provided data. ${commonRules}`;
}

function buildUserPrompt(type, clientName, keywords, reportDate, dataPayload) {
  return `Client Name: ${clientName}
Report Type: ${type}
Keywords: ${keywords || "N/A"}
Report Date: ${reportDate}

${dataPayload}

Generate the complete HTML report now. Output ONLY the HTML — no markdown fences, no commentary.`;
}

// ══════════════════════════════════════════
// Utilities
// ══════════════════════════════════════════
function generateToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getLogoBase64(env) {
  // Try to get from KV first (you can store it there)
  try {
    const stored = await env.CITADEL_KV.get("logo-base64");
    if (stored) return stored;
  } catch {}
  return "";
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
