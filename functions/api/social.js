// functions/api/social.js
// Generates a Social Media Intelligence report using Xpoz directly (no Claude for data fetching)
// Flow: Xpoz REST API → raw posts → Claude for analysis & HTML report

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = request.headers.get('X-Admin-Password');
  if (auth !== env.ADMIN_PASSWORD) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { clientId, clientName, keywords, timeframeDays = 30, xpozToken } = body;
  if (!clientId || !clientName) return json({ error: 'Missing clientId or clientName' }, 400);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'No Anthropic API key' }, 400);

  const kwList = (keywords || clientName).split(',').map(k => k.trim()).filter(Boolean);
  const primaryKw = kwList[0];

  // ── Step 1: Fetch social data directly from Xpoz REST API ─────────────────
  // We call Xpoz's REST endpoints directly — no Claude MCP involved
  const token = xpozToken || (await getStoredXpozToken(env));
  const socialData = await fetchXpozData(token, kwList, timeframeDays);

  // ── Step 2: Build structured data summary for Claude ─────────────────────
  const dataSummary = buildDataSummary(socialData, kwList, timeframeDays);

  // ── Step 3: Claude writes the HTML report from the data ───────────────────
  const reportHtml = await generateSocialReport(env, clientName, primaryKw, dataSummary, timeframeDays);
  if (!reportHtml) return json({ error: 'Report generation failed' }, 500);

  // ── Step 4: Save report ───────────────────────────────────────────────────
  const reportId = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const shareToken = genTok();
  const meta = {
    id: reportId,
    clientId,
    clientName,
    type: 'social',
    typeName: 'Social Media Intelligence',
    keywords: kwList.join(', '),
    createdAt: new Date().toISOString(),
    shareToken,
    status: 'draft',
  };

  await env.CITADEL_KV.put(`report-html:${reportId}`, reportHtml, { expirationTtl: 31536000 });
  await env.CITADEL_KV.put(`report:${reportId}`, JSON.stringify(meta), { expirationTtl: 31536000 });

  let idx = [];
  try { const e = await env.CITADEL_KV.get('reports-index'); if (e) idx = JSON.parse(e); } catch {}
  idx.unshift(meta);
  await env.CITADEL_KV.put('reports-index', JSON.stringify(idx.slice(0, 200)));
  await env.CITADEL_KV.put(`share:${shareToken}`, reportId, { expirationTtl: 31536000 });

  return json({ success: true, report: meta });
}

// ── Xpoz direct API calls ──────────────────────────────────────────────────

async function getStoredXpozToken(env) {
  try {
    const stored = await env.CITADEL_KV.get('xpoz-token');
    if (stored) return JSON.parse(stored).access_token || null;
  } catch {}
  return null;
}

async function fetchXpozData(token, keywords, timeframeDays) {
  if (!token) {
    return { error: 'No Xpoz token available — connect Xpoz in Settings first', platforms: {} };
  }

  const results = { platforms: {}, total: 0, error: null };
  const query = keywords.join(' OR ');
  const since = new Date(Date.now() - timeframeDays * 86400000).toISOString().split('T')[0];

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Fetch Twitter/X posts
  try {
    const twitterResp = await fetch(`https://mcp.xpoz.ai/api/twitter/search?q=${encodeURIComponent(query)}&since=${since}&limit=50`, { headers });
    if (twitterResp.ok) {
      const data = await twitterResp.json();
      const posts = data.posts || data.data || data.results || [];
      results.platforms.twitter = summarisePosts(posts, 'Twitter/X');
      results.total += results.platforms.twitter.count;
    } else {
      // Try alternate endpoint format
      const alt = await fetchXpozMCPTool(token, 'getTwitterPostsByKeywords', {
        query, limit: 50,
      });
      if (alt) {
        results.platforms.twitter = summarisePosts(alt.posts || alt || [], 'Twitter/X');
        results.total += results.platforms.twitter.count;
      }
    }
  } catch (e) {
    results.platforms.twitter = { error: e.message, count: 0 };
  }

  // Fetch Reddit posts
  try {
    const redditData = await fetchXpozMCPTool(token, 'getRedditPostsByKeywords', {
      query, limit: 30,
    });
    if (redditData) {
      const posts = redditData.posts || redditData || [];
      results.platforms.reddit = summarisePosts(posts, 'Reddit');
      results.total += results.platforms.reddit.count;
    }
  } catch (e) {
    results.platforms.reddit = { error: e.message, count: 0 };
  }

  // Fetch Instagram posts
  try {
    const igData = await fetchXpozMCPTool(token, 'getInstagramPostsByKeywords', {
      query, limit: 30,
    });
    if (igData) {
      const posts = igData.posts || igData || [];
      results.platforms.instagram = summarisePosts(posts, 'Instagram');
      results.total += results.platforms.instagram.count;
    }
  } catch (e) {
    results.platforms.instagram = { error: e.message, count: 0 };
  }

  return results;
}

async function fetchXpozMCPTool(token, toolName, params) {
  // Call Xpoz MCP endpoint directly as a REST call
  // Xpoz MCP uses SSE protocol but we can call the underlying REST API
  try {
    const resp = await fetch(`https://mcp.xpoz.ai/api/${toolToEndpoint(toolName)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
    if (resp.ok) return await resp.json();

    // Try the MCP JSON-RPC format
    const mcpResp = await fetch('https://mcp.xpoz.ai/mcp', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: params },
      }),
    });
    if (mcpResp.ok) {
      const d = await mcpResp.json();
      const text = d.result?.content?.[0]?.text;
      if (text) return JSON.parse(text);
    }
  } catch {}
  return null;
}

function toolToEndpoint(toolName) {
  const map = {
    getTwitterPostsByKeywords: 'twitter/search',
    getRedditPostsByKeywords: 'reddit/search',
    getInstagramPostsByKeywords: 'instagram/search',
  };
  return map[toolName] || toolName;
}

function summarisePosts(posts, platform) {
  if (!Array.isArray(posts)) return { count: 0, platform, topPosts: [], totalEngagement: 0, sentiment: {} };

  const topPosts = posts.slice(0, 10).map(p => ({
    text: (p.text || p.content || p.title || p.body || '').slice(0, 200),
    author: p.author?.username || p.author || p.user?.username || 'unknown',
    likes: p.likeCount || p.likes || p.score || 0,
    comments: p.replyCount || p.comments || p.numComments || 0,
    shares: p.retweetCount || p.shares || 0,
    url: p.url || p.permalink || '',
    date: p.createdAt || p.created_at || p.publishedAt || '',
    platform,
  }));

  const totalEngagement = topPosts.reduce((sum, p) => sum + p.likes + p.comments + p.shares, 0);

  return {
    count: posts.length,
    platform,
    topPosts,
    totalEngagement,
  };
}

function buildDataSummary(socialData, keywords, timeframeDays) {
  if (socialData.error) return `ERROR: ${socialData.error}\nNo social data available.`;

  let out = `SOCIAL MEDIA DATA SUMMARY\n`;
  out += `Keywords searched: ${keywords.join(', ')}\n`;
  out += `Timeframe: last ${timeframeDays} days\n`;
  out += `Total mentions found: ${socialData.total}\n\n`;

  for (const [platform, data] of Object.entries(socialData.platforms || {})) {
    out += `═══ ${data.platform || platform.toUpperCase()} ═══\n`;
    if (data.error) { out += `Error fetching data: ${data.error}\n\n`; continue; }
    out += `Total posts found: ${data.count}\n`;
    out += `Total engagement (likes + comments + shares): ${data.totalEngagement}\n`;

    if (data.topPosts && data.topPosts.length > 0) {
      out += `\nTop posts:\n`;
      data.topPosts.forEach((p, i) => {
        out += `  ${i + 1}. [${p.author}] "${p.text.slice(0, 150)}${p.text.length > 150 ? '...' : ''}"\n`;
        out += `     Likes: ${p.likes} | Comments: ${p.comments} | Shares: ${p.shares}\n`;
        if (p.url) out += `     URL: ${p.url}\n`;
      });
    } else {
      out += `No posts found on this platform.\n`;
    }
    out += '\n';
  }

  return out;
}

// ── Claude: report writing only ───────────────────────────────────────────

async function generateSocialReport(env, clientName, keyword, dataSummary, timeframeDays) {
  const LOGO = 'https://citadel-dashboard.pages.dev/logo.png';

  const systemPrompt = `You are a senior ORM analyst at Reputation Citadel. Write a Social Media Intelligence report in HTML using the data provided. You are ONLY writing the report — the data has already been collected for you.

TONE: Client-facing, professional, direct. No em dashes. No bullet points in narrative prose. Be specific about numbers.

If there is no data or 0 mentions, say so clearly and explain it could mean: (1) no significant social conversation exists, (2) the search window was too narrow, or (3) Xpoz data is pending. Do NOT fabricate data.

CSS AND HTML: Output ONLY complete HTML. No markdown. No preamble.

USE THIS CSS:
<style>
:root{--bg:#fff;--surface:#f4f6f9;--border:#d4dae6;--navy:#1b2a4a;--gold:#b8860b;--green:#1e8449;--red:#c0392b;--text:#1e293b;--muted:#5a6a85}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Georgia',serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.7}
.wrap{max-width:860px;margin:0 auto;padding:48px 32px 80px}
.header{display:flex;align-items:center;gap:20px;padding-bottom:24px;border-bottom:2px solid var(--navy);margin-bottom:36px}
.header img{height:48px;width:auto}
.header h1{font-size:1.4rem;color:var(--navy);margin-bottom:4px}
.header .sub{font-size:.85rem;color:var(--muted)}
.sec{margin-bottom:36px}
.sec-title{font-size:1rem;font-weight:700;color:var(--navy);border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:16px;text-transform:uppercase;letter-spacing:.08em;font-family:sans-serif}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:16px}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.st{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;text-align:center}
.n{font-size:2rem;font-weight:700;margin-bottom:6px;font-family:sans-serif}
.l{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-family:sans-serif}
.n-gr{color:var(--green)}.n-rd{color:var(--red)}.n-bl{color:var(--navy)}.n-am{color:var(--gold)}
.platform-section{border-left:4px solid var(--navy);padding-left:16px;margin-bottom:24px}
.platform-title{font-size:1rem;font-weight:600;color:var(--navy);margin-bottom:12px;font-family:sans-serif}
.post-card{background:#fff;border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:10px}
.post-meta{font-size:.78rem;color:var(--muted);margin-top:6px;font-family:sans-serif}
.post-text{font-size:.88rem;line-height:1.6}
.eng{display:inline-flex;gap:12px;font-size:.78rem;color:var(--muted);margin-top:6px;font-family:sans-serif}
.no-data{color:var(--muted);font-style:italic;padding:12px 0;font-size:.9rem}
.ft{margin-top:48px;padding-top:16px;border-top:1px solid var(--border);font-size:.78rem;color:var(--muted);font-family:sans-serif;display:flex;justify-content:space-between}
.conf{font-size:.72rem;letter-spacing:.06em;text-transform:uppercase}
</style>`;

  const userPrompt = `Client: ${clientName}
Primary keyword: ${keyword}
Timeframe: last ${timeframeDays} days

SOCIAL MEDIA DATA:
${dataSummary}

Write the Social Media Intelligence Report in HTML. Structure:

1. Header: <div class="header"><img src="${LOGO}" alt="Reputation Citadel"><div><h1>Social Media Intelligence Report</h1><div class="sub">${clientName} · Last ${timeframeDays} days · ${new Date().toLocaleDateString('en-GB', {day:'numeric',month:'long',year:'numeric'})}</div></div></div>

2. Key Metrics: 4-stat grid (g4 of st): Total mentions, Total engagement, Platforms monitored, Most active platform

3. For each platform with data: a platform-section showing the platform name, mention count, total engagement, and the top 3-5 posts as post-cards showing: post text, author, engagement stats (likes/comments/shares). If a platform has 0 posts say so clearly.

4. Narrative Summary: 2-3 paragraphs analysing tone, volume, notable accounts or posts, what this means for the client's reputation.

5. Recommendations: 3-4 specific actions.

Output ONLY the complete HTML starting with <!DOCTYPE html>.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!resp.ok) { const e = await resp.text(); throw new Error(`Claude ${resp.status}: ${e.slice(0, 200)}`); }
    const data = await resp.json();
    let html = data.content?.[0]?.text || '';
    if (html.startsWith('```')) html = html.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '');
    return html;
  } catch (err) {
    return `<html><body><h1>Report generation error</h1><p>${err.message}</p></body></html>`;
  }
}

function genTok() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
