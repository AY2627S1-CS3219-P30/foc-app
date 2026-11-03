// The stack's readiness (PLT-13, #289), for GET /edge/ready, run by nginx's JavaScript module.
//
// 200 only while the web app and all five services answer their health checks, so "ready" means
// every page can work; 503 otherwise, naming each one that does not. It asks them over the
// networks the edge already routes on, so nothing gains a new way in, and it asks each service
// for /health only: never /internal, never /metrics.

/* global ngx */ // njs's own: ngx.fetch asks an upstream, through the resolver nginx.conf sets.

const UPSTREAMS = {
  'web-app': 'http://web-app:3000/',
  'user-service': 'http://user-service:3001/health',
  'supplier-service': 'http://supplier-service:3002/health',
  'order-service': 'http://order-service:3003/health',
  'credit-service': 'http://credit-service:3004/health',
  'chat-service': 'http://chat-service:3006/health',
};

/** Whether one answers 200. Refused, not found, or slower than js_fetch_timeout: it does not. */
function answers(url) {
  return ngx.fetch(url).then(
    (reply) => reply.status === 200,
    () => false,
  );
}

async function check(r) {
  const names = Object.keys(UPSTREAMS);
  const up = await Promise.all(names.map((name) => answers(UPSTREAMS[name])));
  const checks = {};
  names.forEach((name, i) => {
    checks[name] = up[i] ? 'up' : 'down';
  });
  const down = names.filter((name, i) => !up[i]);

  r.headersOut['Content-Type'] = 'application/json';
  r.headersOut['Cache-Control'] = 'no-store';
  r.return(
    down.length ? 503 : 200,
    JSON.stringify({ status: down.length ? 'unavailable' : 'ok', down, checks }),
  );
}

export default { check };
