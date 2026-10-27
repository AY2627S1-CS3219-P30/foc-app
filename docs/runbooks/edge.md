# The edge (PLT-10, #285)

The edge is the nginx container in front of everything: the one origin the browser uses,
`http://localhost:3000` in Compose. It routes `/api/<service>/` to each service, taking the prefix
off, and everything else to the web app. It sets the security headers, limits writes and request
size, and answers whether the whole stack is ready. Why it exists, and what it must never do, is in
[ADR 0010](../adr/0010-api-edge.md). Its configuration is three files, mounted read-only:

| File                | What it holds                                                                       |
| ------------------- | ----------------------------------------------------------------------------------- |
| `edge/nginx.conf`   | routes, the write limit, the size limit, the error answers, the access log          |
| `edge/headers.conf` | the security headers on every response, including the Content-Security-Policy       |
| `edge/readiness.js` | `GET /edge/ready`: which of the web app and the four services answer (PLT-13, #289) |

Commands below are run from the repository root against the running stack. For a stack started
under another project name, set `COMPOSE_PROJECT_NAME` first.

## Is it up, and is the stack ready?

```bash
curl -s localhost:3000/edge/health      # "ok": the edge itself is running
curl -s localhost:3000/edge/ready       # 200 once every page can work; 503 naming what is down
docker compose ps edge                  # "healthy" means ready: its health check asks /edge/ready
```

An **unhealthy edge is usually not a broken edge**: it means something behind it is down, and
`/edge/ready` names it, for example `{"status":"unavailable","down":["supplier-service"],…}`. Look
at that service (`docker compose ps`, `docker compose logs <service>`) before the edge.

## What an answer from the edge means

The edge's own answers use the shared error envelope, with the request's correlation ID in the body.

| Answer                                        | It means                                                                                                                 | What to do                                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `503 UNAVAILABLE`, `Retry-After: 5`           | the service under that prefix is not answering: stopped, restarting, or just recreated at a new address                  | `/edge/ready` names it. Start or fix the service; the edge looks its name up again every 10 seconds, so it is found without restarting the edge. |
| `429 RATE_LIMITED`, `Retry-After: 1`          | more than 10 writes a second (a burst of 30 allowed) from one address. Reads are not limited                             | Expected for a script that writes in a burst: slow it down. For many people behind one address, raise `rate` or `burst` (see below).             |
| `413 PAYLOAD_TOO_LARGE`                       | a request body over 1 MB                                                                                                 | Nothing the API takes is that large; find what sent it.                                                                                          |
| `404 NOT_FOUND`, no `x-correlation-id` header | the edge's own refusal: an `/internal` or `/metrics` path in any spelling or case, or an `/api/<name>` it does not route | Working as intended. A service's own 404 echoes `x-correlation-id`; the edge's does not.                                                         |

A `502` or `504` never reaches the browser: the edge turns both into the `503` above.

## Following one request

The edge writes one JSON line per request: time, method, URI, status, duration, which upstream
answered, and the correlation ID. It passes that ID to the service, which logs under it and copies
it onto every event the request causes, so one search finds the whole story:

```bash
docker compose logs edge --since 10m               # the edge's access log
docker compose logs --no-log-prefix | grep '<correlation-id>'
```

The ID is the browser's `x-correlation-id` header when it sent a usable one, and the edge's own
otherwise. Every service answer, and the body of every edge error, carries it.

## Problems seen at the edge

- **Signed out on every reload.** The browser sends the refresh cookie back only to the path it was
  set for, which must be `/api/user/auth`; the edge rewrites the User Service's `/auth`
  (`proxy_cookie_path`). Check what a sign-in sets:
  `curl -s -o /dev/null -D - -X POST localhost:3000/api/user/auth/login -H 'content-type: application/json' -H 'Origin: http://localhost:3000' -d '{"email":"…","password":"…"}' | grep -i set-cookie`
  (type the password at a prompt rather than leave it in your shell history). `Path=/auth` means
  the rewrite is missing from `nginx.conf`.
- **Everyone shares one sign-in limit.** A service believes `X-Forwarded-For`, and so counts each
  client separately, only from the edge: `TRUSTED_PROXY=edge` in `compose.yaml`, looked up every
  10 seconds. For up to 10 seconds after the edge is recreated every request counts as the edge's.
  Check a service has it: `docker compose exec user-service printenv TRUSTED_PROXY`.
- **A page is blocked in the browser console by the Content-Security-Policy.** The app may fetch
  only from its own origin and show images from any HTTPS address. Something new from another
  origin goes into the policy in `edge/headers.conf`.
- **Port 3000 is taken.** Set `WEB_APP_PORT` in `.env`; the edge is published on it.

## Changing its configuration

1. Edit `edge/nginx.conf`, `edge/headers.conf` or `edge/readiness.js`.
2. Check it: `docker compose exec edge nginx -t`.
3. Apply it:
   - `docker compose exec edge nginx -s reload` applies it with nothing dropped, **if your editor
     wrote the file in place**. Each file is mounted on its own, and an editor that saves by
     replacing the file leaves the container with the old one: `nginx -t` then passes on the old
     file and the reload changes nothing. Check that the container sees your edit, for example
     `docker compose exec edge grep -c '<something you added>' /etc/nginx/foc/headers.conf`.
   - `docker compose up -d --force-recreate edge` always applies it, with about ten seconds in which
     port 3000 does not answer.
4. Run `./scripts-smoke.sh`: its edge section checks the routes, the headers, the refusals, the
   limits and readiness.

Restarting the edge (`docker compose restart edge`) leaves the web app and the services running;
port 3000 refuses connections until it is back.

## What the edge must never do

- Decide who a caller is. Every service checks every request's token itself (ADR 0004); a request
  that came through the edge is trusted no more than one that did not.
- Route `/internal` or `/metrics`. Services call each other's internal routes over their own
  network, and Prometheus reads `/metrics` there with its token.
