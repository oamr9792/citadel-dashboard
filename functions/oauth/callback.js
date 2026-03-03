// functions/oauth/callback.js — Serve OAuth callback page
export async function onRequestGet(context) {
  const params = new URL(context.request.url).searchParams;
  const code = params.get('code') || '';
  const error = params.get('error') || '';

  return new Response(`<!DOCTYPE html>
<html>
<head><title>Xpoz Connection</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0a0e17;color:#e2e8f0">
<div style="text-align:center">
<h2 style="margin-bottom:12px">${error ? 'Connection Failed' : 'Connecting to Xpoz...'}</h2>
<p id="status">${error ? 'Error: ' + error : 'Processing authentication...'}</p>
</div>
<script>
const code = "${code}";
const error = "${error}";
if (code && window.opener) {
  window.opener.postMessage({ type: 'xpoz_callback', code: code }, '*');
  document.getElementById('status').textContent = 'Connected! You can close this window.';
  setTimeout(() => window.close(), 2000);
} else if (error) {
  document.getElementById('status').textContent = 'Error: ' + error;
} else {
  document.getElementById('status').textContent = 'No authorization code received.';
}
</script>
</body>
</html>`, {
    status: 200,
    headers: { 'Content-Type': 'text/html' }
  });
}
