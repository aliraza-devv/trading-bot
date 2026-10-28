/**
 * guard.ts - the bridge routes are for this PC only.
 *
 * Two things are checked:
 *  1. the request must be addressed to localhost / 127.0.0.1 / ::1 (judged by the Host header the client really
 *     sent, not by request.url, which Next builds from the server's own address). This also stops "DNS rebinding",
 *     where a hostile website points its own name at 127.0.0.1 to reach local services;
 *  2. a request that comes from a web page (the browser adds `Origin` or `Sec-Fetch-Site`) is refused, unless
 *     the route is one the Live page itself calls and the page is on the same origin.
 * MetaTrader's WebRequest sends neither header, so the EA is unaffected, while another website open in your
 * browser cannot talk to the bridge.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** "localhost:3001" -> "localhost", "[::1]:3001" -> "[::1]" */
function hostnameOf(hostHeader: string): string {
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim().toLowerCase());
  return m ? m[1] : '';
}

export function localOnly(request: Request, opts: { allowSameOrigin?: boolean } = {}): Response | null {
  const deny = (why: string) => new Response(`ERR|${why}`, { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  const host = request.headers.get('host') ?? new URL(request.url).host;
  if (!LOCAL_HOSTS.has(hostnameOf(host))) return deny('the bridge only answers on localhost');

  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (opts.allowSameOrigin) {
    if (origin) {
      try {
        if (new URL(origin).host !== host) return deny('cross-site request refused');
      } catch {
        return deny('bad origin');
      }
    }
    if (site && site !== 'same-origin' && site !== 'none') return deny('cross-site request refused');
    return null;
  }
  if (origin || site) return deny('browser requests are refused here; this endpoint is for the MT5 EA');
  return null;
}
