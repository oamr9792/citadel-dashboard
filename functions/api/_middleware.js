// functions/api/_middleware.js
// ============================
// Handles CORS preflight for all /api/* routes

export async function onRequest(context) {
  // Handle CORS preflight
  if (context.request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Continue to the actual handler
  const response = await context.next();

  // Add CORS headers to all responses
  const newResponse = new Response(response.body, response);
  newResponse.headers.set("Access-Control-Allow-Origin", "*");
  return newResponse;
}
