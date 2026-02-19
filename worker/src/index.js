export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Basic health check so we know the Worker deployed
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true, source: "github-worker" }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
