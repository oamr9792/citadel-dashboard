// functions/api/social-monitor.js
// ─────────────────────────────────────────────────────────────────────────────
// Citadel Social Monitor
// Runs on a Cloudflare Cron Trigger (scheduled) AND manually via POST
//
// Cron setup in wrangler.toml:
//   [[triggers.crons]]
//   crons = ["0 7 * * *"]   # runs daily at 7am UTC
//
// Manual trigger: POST /api/social-monitor  (X-Admin-Password required)
//
// What it does:
//   1. Loads all clients from CITADEL_KV
//   2. For each client, searches Twitter + Reddit via Xpoz SDK
//   3. Scores each post for ORM risk (negative sentiment + high velocity)
//   4. Sends email alert via Resend if anything is flagged
//   5. Saves a daily social snapshot to KV for the dashboard
// ─────────────────────────────────────────────────────────────────────────────

const XPOZ_BASE   = 'https://api.xpoz.ai/v1';
const RESEND_URL  = 'https://api.resend.com/emails';
const ALERT_TO    = 'orani@reputationcitadel.com';
const ALERT_FROM  = 'alerts@reputationcitadel.com'; // must be verified in Resend

// ── Entry points ─────────────────────────────────────────────────────────────

// Scheduled cron trigger
export async function scheduled(event, env, ctx) {
  ctx.waitUntil(runMonitor(env));
}

// Manual HTTP trigger
export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get('X-Admin-Password');
  if (auth !== env.ADMIN_PASSWORD) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // Run in background, return immediately
  context.waitUntil(runMonitor(env));
  return json({ success: true, message: 'Social monitor started. Results will be emailed.' });
}

// ── Main monitor loop ─────────────────────────────────────────────────────────

async function runMonitor(env) {
  const xpozKey   = env.XPOZ_API_KEY   || 'K39kOXduVY2tjdGUY77k0WNmGnK3nmAfIXuqTvPTt6SNLnsYDUhIax4LNqmPtGPSgoqrK5I';
  const resendKey = env.RESEND_API_KEY  || 're_XeCtm8Rx_9DPA7aXJNovLUB4oLpaVYkuV';
  const anthropicKey = env.ANTHROPIC_API_KEY;

  // Load all clients
  let clients = [];
  try {
    const idx = await env.CITADEL_KV.get('clients-index');
    if (idx) clients = JSON.parse(idx);
  } catch {}

  // Fallback: scan reports-index for unique clientIds if no clients-index
  if (!clients.length) {
    try {
      const reportsRaw = await env.CITADEL_KV.get('reports-index');
      if (reportsRaw) {
        const reports = JSON.parse(reportsRaw);
        const seen = new Set();
        for (const r of reports) {
          if (r.clientId && r.clientName && !seen.has(r.clientId)) {
            seen.add(r.clientId);
            clients.push({ id: r.clientId, name: r.clientName, keywords: r.keywords || r.clientName });
          }
        }
      }
    } catch {}
  }

  if (!clients.length) {
    console.log('No clients found to monitor');
    return;
  }

  const today     = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const allAlerts = [];

  for (const client of clients) {
    const keywords = Array.isArray(client.keywords)
      ? client.keywords
      : (client.keywords || client.name).split(',').map(k => k.trim()).filter(Boolean);

    const primaryKw = keywords[0];
    if (!primaryKw) continue;

    console.log(`Monitoring: ${client.name} (${primaryKw})`);

    const snapshot = {
      clientId:   client.id,
      clientName: client.name,
      date:       today,
      keyword:    primaryKw,
      twitter:    null,
      reddit:     null,
      flagged:    [],
    };

    // ── Twitter search ────────────────────────────────────────────────────────
    try {
      const twitterData = await xpozSearch(xpozKey, 'twitter', primaryKw, yesterday, today);
      snapshot.twitter = summariseXpoz(twitterData, 'twitter');

      // Score posts for ORM risk
      const risky = scoreForRisk(twitterData.posts || [], 'twitter');
      snapshot.flagged.push(...risky);
    } catch (e) {
      console.error(`Twitter error for ${client.name}:`, e.message);
      snapshot.twitter = { error: e.message };
    }

    // ── Reddit search ─────────────────────────────────────────────────────────
    try {
      const redditData = await xpozSearch(xpozKey, 'reddit', primaryKw, yesterday, today);
      snapshot.reddit = summariseXpoz(redditData, 'reddit');

      const risky = scoreForRisk(redditData.posts || [], 'reddit');
      snapshot.flagged.push(...risky);
    } catch (e) {
      console.error(`Reddit error for ${client.name}:`, e.message);
      snapshot.reddit = { error: e.message };
    }

    // ── Save snapshot to KV ───────────────────────────────────────────────────
    try {
      await env.CITADEL_KV.put(
        `social-snapshot:${client.id}:${today}`,
        JSON.stringify(snapshot),
        { expirationTtl: 60 * 60 * 24 * 90 } // 90 days
      );

      // Update latest pointer
      await env.CITADEL_KV.put(
        `social-snapshot:${client.id}:latest`,
        JSON.stringify(snapshot),
        { expirationTtl: 60 * 60 * 24 * 90 }
      );
    } catch (e) {
      console.error('KV save error:', e.message);
    }

    if (snapshot.flagged.length > 0) {
      allAlerts.push({ client, snapshot });
    }
  }

  // ── Send alert email if anything flagged ──────────────────────────────────
  if (allAlerts.length > 0) {
    await sendAlertEmail(resendKey, allAlerts, today);
  } else {
    console.log('No alerts triggered today.');
  }
}

// ── Xpoz API calls ────────────────────────────────────────────────────────────

async function xpozSearch(apiKey, platform, query, startDate, endDate) {
  // Xpoz TypeScript SDK endpoint — called as REST from Cloudflare
  const endpoint = platform === 'twitter'
    ? `${XPOZ_BASE}/twitter/posts/search`
    : `${XPOZ_BASE}/reddit/posts/search`;

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      startDate,
      endDate,
      limit: 50,
      fields: platform === 'twitter'
        ? ['id', 'text', 'authorUsername', 'createdAtDate', 'likeCount', 'retweetCount', 'replyCount', 'impressionCount']
        : ['id', 'title', 'content', 'author', 'subreddit', 'score', 'numComments', 'createdAtDate', 'url'],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Xpoz ${platform} ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  return {
    posts: data.data || data.results || [],
    total: data.pagination?.totalRows || data.count || 0,
    platform,
  };
}

function summariseXpoz(data, platform) {
  const posts = data.posts || [];
  const totalEngagement = posts.reduce((sum, p) => {
    return sum + (p.likeCount || 0) + (p.retweetCount || p.score || 0) + (p.replyCount || p.numComments || 0);
  }, 0);

  return {
    count: data.total || posts.length,
    fetched: posts.length,
    totalEngagement,
    topPosts: posts.slice(0, 5).map(p => ({
      text: (p.text || p.title || '').slice(0, 200),
      author: p.authorUsername || p.author || 'unknown',
      engagement: (p.likeCount || 0) + (p.retweetCount || p.score || 0),
      url: p.url || `https://twitter.com/i/web/status/${p.id}`,
      date: p.createdAtDate,
      platform,
    })),
  };
}

// ── Risk scoring ──────────────────────────────────────────────────────────────
// Flags posts that are:
// - High engagement (viral threshold)
// - Contain ORM risk keywords
// - Moving fast (high engagement relative to age)

const NEGATIVE_SIGNALS = [
  'lawsuit', 'sued', 'fraud', 'scam', 'complaint', 'criminal', 'arrested',
  'investigation', 'charges', 'alleged', 'misconduct', 'scandal', 'exposed',
  'warning', 'avoid', 'terrible', 'awful', 'horrible', 'worst', 'dangerous',
  'lied', 'liar', 'fake', 'incompetent', 'corrupt', 'illegal', 'fired',
  'resigned', 'controversy', 'controversy', 'troubling', 'shocking'
];

const HIGH_ENGAGEMENT_THRESHOLD = 100; // likes + retweets/upvotes

function scoreForRisk(posts, platform) {
  const flagged = [];

  for (const post of posts) {
    const text = (post.text || post.title || post.content || '').toLowerCase();
    const engagement = (post.likeCount || 0) + (post.retweetCount || post.score || 0) + (post.replyCount || post.numComments || 0);

    const negativeHits = NEGATIVE_SIGNALS.filter(sig => text.includes(sig));
    const isHighEngagement = engagement >= HIGH_ENGAGEMENT_THRESHOLD;
    const isNegative = negativeHits.length > 0;

    if (isNegative || isHighEngagement) {
      flagged.push({
        platform,
        text: (post.text || post.title || '').slice(0, 300),
        author: post.authorUsername || post.author || 'unknown',
        engagement,
        url: post.url || (platform === 'twitter' ? `https://twitter.com/i/web/status/${post.id}` : ''),
        date: post.createdAtDate,
        reason: isNegative
          ? `Negative signals: ${negativeHits.join(', ')}`
          : `High engagement: ${engagement} interactions`,
        severity: (isNegative && isHighEngagement) ? 'HIGH' : isNegative ? 'MEDIUM' : 'LOW',
      });
    }
  }

  return flagged;
}

// ── Resend email alert ────────────────────────────────────────────────────────

async function sendAlertEmail(resendKey, allAlerts, date) {
  const clientSummaries = allAlerts.map(({ client, snapshot }) => {
    const flagged = snapshot.flagged;
    const high   = flagged.filter(f => f.severity === 'HIGH');
    const medium = flagged.filter(f => f.severity === 'MEDIUM');
    const low    = flagged.filter(f => f.severity === 'LOW');

    const postsHtml = flagged.slice(0, 5).map(f => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top">
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;
            background:${f.severity === 'HIGH' ? '#fee2e2' : f.severity === 'MEDIUM' ? '#fef3c7' : '#dbeafe'};
            color:${f.severity === 'HIGH' ? '#dc2626' : f.severity === 'MEDIUM' ? '#d97706' : '#2563eb'}">
            ${f.severity}
          </span>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-size:13px;color:#374151">
          <strong>${f.platform.toUpperCase()}</strong> — @${f.author}<br>
          <span style="color:#6b7280;font-size:12px">${f.date || ''}</span>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#1f2937;max-width:400px">
          ${f.text.slice(0, 200)}${f.text.length > 200 ? '…' : ''}<br>
          <span style="font-size:11px;color:#9ca3af">${f.reason}</span>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#6b7280;white-space:nowrap">
          ${f.engagement} engagements
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0">
          ${f.url ? `<a href="${f.url}" style="color:#1b2a4a;font-size:12px">View →</a>` : ''}
        </td>
      </tr>`).join('');

    return `
      <div style="margin-bottom:32px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
        <div style="background:#1b2a4a;color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:15px">${client.name}</strong>
          <span style="font-size:12px;opacity:0.7">${flagged.length} alert${flagged.length !== 1 ? 's' : ''} · ${high.length} HIGH · ${medium.length} MEDIUM · ${low.length} LOW</span>
        </div>
        <div style="padding:16px 20px">
          <div style="margin-bottom:12px;font-size:13px;color:#6b7280">
            Twitter: ${snapshot.twitter?.count ?? '—'} mentions · Reddit: ${snapshot.reddit?.count ?? '—'} posts
          </div>
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="background:#f1f5f9">
                <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;letter-spacing:.06em">Severity</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;letter-spacing:.06em">Source</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;letter-spacing:.06em">Content</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;letter-spacing:.06em">Engagement</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;letter-spacing:.06em">Link</th>
              </tr>
            </thead>
            <tbody>${postsHtml}</tbody>
          </table>
          ${flagged.length > 5 ? `<p style="font-size:12px;color:#9ca3af;margin-top:8px;padding:0 4px">+ ${flagged.length - 5} more alerts. Log in to the dashboard to view all.</p>` : ''}
        </div>
      </div>`;
  }).join('');

  const totalAlerts = allAlerts.reduce((sum, a) => sum + a.snapshot.flagged.length, 0);
  const highCount   = allAlerts.reduce((sum, a) => sum + a.snapshot.flagged.filter(f => f.severity === 'HIGH').length, 0);

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f2f5;margin:0;padding:0">
<div style="max-width:700px;margin:0 auto;padding:32px 16px">

  <!-- Header -->
  <div style="background:#1b2a4a;border-radius:10px 10px 0 0;padding:24px 28px;margin-bottom:0">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#b8860b;margin-bottom:4px">Reputation Citadel</div>
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600">Social Media Alert</h1>
      </div>
      <div style="text-align:right">
        <div style="font-size:24px;font-weight:700;color:${highCount > 0 ? '#ef4444' : '#f59e0b'}">${totalAlerts}</div>
        <div style="font-size:11px;color:#94a3b8;text-transform:uppercase">Alert${totalAlerts !== 1 ? 's' : ''} Today</div>
      </div>
    </div>
  </div>

  <!-- Summary bar -->
  <div style="background:#0f1b2d;padding:12px 28px;margin-bottom:24px;border-radius:0 0 10px 10px">
    <div style="font-size:13px;color:#94a3b8">
      ${date} &nbsp;·&nbsp; ${allAlerts.length} client${allAlerts.length !== 1 ? 's' : ''} flagged &nbsp;·&nbsp;
      ${highCount > 0 ? `<span style="color:#ef4444;font-weight:600">${highCount} HIGH severity</span>` : 'No HIGH severity alerts'}
    </div>
  </div>

  <!-- Client alerts -->
  ${clientSummaries}

  <!-- Footer -->
  <div style="text-align:center;padding:20px 0;font-size:11px;color:#9ca3af">
    Reputation Citadel · Social Monitoring · Daily Report<br>
    <a href="https://citadel-dashboard.pages.dev" style="color:#1b2a4a">View Dashboard →</a>
  </div>

</div>
</body>
</html>`;

  const resp = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: ALERT_FROM,
      to: [ALERT_TO],
      subject: `🚨 ${totalAlerts} Social Alert${totalAlerts !== 1 ? 's' : ''} — ${allAlerts.map(a => a.client.name).join(', ')} [${date}]`,
      html,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('Resend error:', err);
  } else {
    console.log('Alert email sent successfully');
  }
}

// ── GET endpoint: fetch latest social snapshot for a client ───────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = request.headers.get('X-Admin-Password');
  if (auth !== env.ADMIN_PASSWORD) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const clientId = url.searchParams.get('clientId');
  if (!clientId) return json({ error: 'Missing clientId' }, 400);

  try {
    const raw = await env.CITADEL_KV.get(`social-snapshot:${clientId}:latest`);
    if (!raw) return json({ snapshot: null, message: 'No snapshot yet. Run monitor to generate.' });
    return json({ snapshot: JSON.parse(raw) });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

function json(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
