/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.API_ORIGIN || "http://127.0.0.1:3001";

const nextConfig = {
  // Everything the browser touches is served from ONE origin.
  //
  // The API runs as a separate process (apps/web), but proxying it under /api
  // means the browser never sees a second origin — so there is no CORS to
  // configure and, more importantly, the session cookie is a plain same-origin
  // cookie rather than a third-party one that browsers increasingly refuse.
  // In production Caddy does exactly this in front of both processes.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_ORIGIN}/:path*` },
      // /auth/* is proxied under its own name as well, so the link we email is
      // `https://host/auth/callback?token=…` rather than `…/api/auth/callback`.
      // People look at links before clicking them; one that reads like an API
      // call is one more reason not to.
      { source: "/auth/:path*", destination: `${API_ORIGIN}/auth/:path*` },
    ];
  },
};

export default nextConfig;
