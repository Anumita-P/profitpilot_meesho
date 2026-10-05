/**
 * A tiny dependency-free router.
 *
 * Why no Express? The prototype has to run anywhere a judge opens it - a
 * laptop, a phone served over a hotspot, a locked-down container with no npm
 * access - so the service has zero runtime dependencies. Swapping this file for
 * Express or Fastify is a contained change; every route handler is a plain
 * async function.
 */

export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler, meta = {}) => {
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/:[A-Za-z0-9_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; })}$`);
    routes.push({ method, pattern, keys, regex, handler, meta });
  };

  const router = {
    get: (p, h, m) => add('GET', p, h, m),
    post: (p, h, m) => add('POST', p, h, m),
    patch: (p, h, m) => add('PATCH', p, h, m),
    put: (p, h, m) => add('PUT', p, h, m),
    delete: (p, h, m) => add('DELETE', p, h, m),
    /** Self-documenting index, served at GET /api/routes. */
    list: () => routes.map((r) => ({ method: r.method, path: r.pattern, ...r.meta })),
    find(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.regex.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { route: r, params };
      }
      return null;
    },
  };
  return router;
}

export async function readBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const e = new Error('request body too large');
      e.status = 413;
      throw e;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error(`invalid JSON body: ${e.message}`);
    err.status = 400;
    throw err;
  }
}

/** Build the handler context once per request. */
export function context(req, res, url, params, body) {
  const query = Object.fromEntries(url.searchParams.entries());
  return {
    req, res, url,
    method: req.method,
    pathname: url.pathname,
    params, query, body,
    now: new Date(),
    /** query values arrive as strings: "false" must not be truthy */
    flag(name, dflt = false) {
      if (!(name in query)) return dflt;
      const v = String(query[name]).toLowerCase();
      return v === '' || v === '1' || v === 'true' || v === 'yes' || v === 'on';
    },
    num(name, dflt = null) {
      if (!(name in query) || query[name] === '') return dflt;
      const n = Number(query[name]);
      return Number.isFinite(n) ? n : dflt;
    },
  };
}
