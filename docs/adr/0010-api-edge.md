# ADR 0010 — The API edge: one origin, routed and protected by nginx

- **Status:** Proposed; implementation basis
- **Date:** 2026-10-26
- **Deciders:** Group 30; approvals tracked in [the ADR index](README.md)
- **Ticket:** [PLT-10 #285](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/285)
- **Built by:** PLT-10 [#285](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/285)

## Context

The execution plan chose a thin gateway in front of the services ("API edge",
`docs/EXECUTION-PLAN.md`), but what was built until now is the browser calling each service on its
own port. Four problems followed from that, all found when the requirements were checked on 22 Oct:

- ports 3000–3004 were published on every interface, so anyone on the same network could reach
  every API over plain HTTP (PL-NFR2.1.2, least exposure);
- no response carried a security header: no Content-Security-Policy, no protection against framing,
  no `nosniff`, no referrer policy;
- the only rate limits were the User Service's, on sign-in and sign-up (US-NFR2); nothing limited
  creating, accepting or disputing errands;
- four origins meant CORS on every call, and a `SameSite=Strict` refresh cookie that works only
  because `localhost` on any port is one site. A web app on a domain of its own would lose it.

## Decision

### 1. One edge, in front of everything the browser reaches

An nginx container ([`edge/nginx.conf`](../../edge/nginx.conf)) is the one origin the browser uses,
`http://localhost:3000`, and the only port published beyond this machine. It routes by path:

| Path             | Goes to                 |
| ---------------- | ----------------------- |
| `/api/user/`     | `user-service:3001`     |
| `/api/supplier/` | `supplier-service:3002` |
| `/api/order/`    | `order-service:3003`    |
| `/api/credit/`   | `credit-service:3004`   |
| anything else    | `web-app:3000`          |

The prefix is taken off on the way, so each service serves the paths its contract names. The web
app is built with `/api/<service>` as each service's address: paths, not hosts, so the same image
works on any host and port. The four services keep a port each on `127.0.0.1`, for the test and
demo scripts on this machine; the web app has none.

### 2. It routes and protects; it never authenticates

The edge adds what is the same for every request, in one place:

- **Security headers on every response**, the edge's own errors included: a Content-Security-Policy
  (scripts, styles, fetches and frames from this origin; images also from any HTTPS address, for
  supplier photos), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a Permissions-Policy and
  `Cross-Origin-Opener-Policy`.
- **A write limit per client address**: 10 a second, with a burst of 30, on every method but `GET`,
  `HEAD` and `OPTIONS`. Over it the edge answers `429 RATE_LIMITED` itself. The User Service's own
  sign-in and sign-up limits stay; they now count each client rather than the edge (point 4).
- **A request size limit** of 1 MB, answered `413 PAYLOAD_TOO_LARGE`.
- **Never `/internal/**` or `/metrics`.** A regex location, matched on nginx's normalised path, so
  `%69nternal` or `//internal` is refused too. Each service also serves `/internal/**` only on its
  unpublished internal port, so this is a second wall, not the only one.

It does **not** check tokens, read roles, or set a header a service would trust about who is
calling. Every service still verifies every request itself, exactly as
[ADR 0004](0004-authentication-and-trust.md) requires: a request that reached a service through the
edge is trusted no more than one that did not.

### 3. The refresh cookie keeps its path, as the browser sees it

The User Service sets the refresh cookie for `Path=/auth`, the path it serves. The browser reaches
that path at `/api/user/auth`, so the edge rewrites the cookie's path on the way out
(`proxy_cookie_path`). The cookie stays `HttpOnly` and `SameSite=Strict`, and on one origin that
holds wherever the stack is served from. The service is unchanged, and still works on its own
(`npm run dev`) with `/auth`.

### 4. The edge alone is believed, for the client's address only

Behind the edge a browser's request comes from the edge. It replaces `X-Forwarded-For` with the
address it saw, ignoring whatever the client sent, and each service believes that header from the
edge alone (`TRUSTED_PROXY=edge`): it looks the name up in Docker's DNS, again every 10 seconds as
the edge does for the services, and takes only the last address, the one the edge wrote. So
`req.ip` is the client's and a per-address limit counts clients. A request from anywhere else, a
process on this machine calling a service's `127.0.0.1` port or another container on the network,
is taken at its own address whatever header it sends, so it cannot spread itself across a limit's
addresses. This is the one thing a service believes from the edge, and it is an address, not an
identity. Until the first lookup succeeds (the edge can start after a service), or for up to 10
seconds after the edge is recreated at a new address, nobody is believed, and the edge's own
address is what a limit counts.

### 5. Recreated containers are found again

nginx asks Docker's DNS for each upstream at most every 10 seconds rather than once at start, so a
service that is recreated, and comes back at a new address, is reached again without restarting
the edge. An upstream that does not answer gives `503 UNAVAILABLE` in the shared error envelope.

### 6. Hardened like the other containers

The image is `nginxinc/nginx-unprivileged`, pinned by version and digest: it runs as an
unprivileged user on port 8080, so the container drops every Linux capability, cannot gain one,
and has a read-only file system with `/tmp` as its only scratch space. It is on three networks: an
ordinary one of its own, for its published port; the internal `gateway` network, to the services'
public ports; and the internal `web` network, to the web app, which is on no other network and so
reaches no service (PLT-13, #289).

## Alternatives considered

- **Keep calling the services directly.** No new container, but every problem in the context stays,
  and each of headers, limits and exposure would have to be solved four times, once per service.
- **A full API gateway or a backend for frontend** that authenticates, aggregates or reshapes
  responses. It would put a second authority in front of the services' own checks, which ADR 0004
  rejects, and it is far more code than routing and headers need.
- **Next.js rewrites** in the web app. They would give one origin, but every API request would then
  pass through the web app's Node process, and the headers and limits would live in application
  code; a broken web app would take the APIs down with it.
- **Another proxy (Caddy, Traefik).** Either would do the routing. nginx is chosen for its built-in
  per-address limits (`limit_req`) and for being the proxy the team and the course material know;
  its configuration is one file, checked by `scripts-smoke.sh`.

## Consequences

- The demo runs through one origin, and only the edge is reachable from another machine.
- CORS stays configured on the services, for a web app run on its own (`bun dev`) against them; on
  the one origin the browser no longer needs it.
- The edge is one more container in the start-up order and one more thing that can fail. A failed
  edge stops the browser but not the services, which the scripts still reach on `127.0.0.1`.
- The services still run with `NODE_ENV=development` in Compose. Production mode, which turns on
  `Secure` cookies, needs a real SMTP relay: since USR-09 (#274) the User Service sends real
  activation email, and refuses production without `SMTP_HOST`.

## Revisit if

- The stack is served over HTTPS: add `Strict-Transport-Security` and turn on `Secure` cookies.
- Next.js can run without inline scripts here (nonces), so the CSP can drop `'unsafe-inline'`.
- Several edge instances run at once: the write limit is per instance, so it would need a shared
  store or a limit per instance divided between them.
