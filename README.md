# trustsight-feed

A live, searchable feed of the alerts the TrustSight AUR watcher raises,
hosted at [watcher.trustsight.org](https://watcher.trustsight.org).

The TrustSight container keeps running wherever it runs and pushing one JSON
document per alert cycle to an ntfy topic. Nothing about the container changes.
This project subscribes to that topic, preserves every notification in SQLite,
and serves a feed where each notification has its own page with the full
evidence document and hover explanations for every rule it fired. The
interface is styled from
[trustsight-web](https://github.com/emiliano-go/trustsight-web).

## Security model

TrustSight produces evidence, not proof of safety. This feed is a reader over
that evidence:

- It never runs a PKGBUILD, never executes extracted commands, and never
  modifies a system.
- A notification means a published rule matched the change under review. It is
  not a verdict, and it is not permission to install.
- The absence of a signal is a statement about detection, not about the update.

The full model is at
[docs.trustsight.org/security](https://docs.trustsight.org/security/). The rule
definitions shown on hover come from the TrustSight repository, so the feed
cannot quote an explanation the tool does not hold.

## Architecture

Everything runs on Cloudflare free tiers. If a step ever requires a paid
resource, stop.

- **Cloudflare Worker** on a Cron Trigger polls the ntfy JSON API every five
  minutes (`since=<cursor>`, so a cycle is one small request), parses each
  `message` event, and upserts it into D1 keyed by the ntfy message id. A
  document larger than ntfy's body limit arrives as an attachment (the body
  is "You received a file"), so the poller fetches the attachment JSON before
  parsing; an off-host attachment URL is refused. A cycle that gets a 5xx or a
  network error is retried once, and a miss is harmless because ntfy caches
  the message for the next cycle.
- **D1 (SQLite)** stores the notifications, with an FTS5 index over package
  names, rule ids, versions, titles and days for search.
- **Static Assets** serve the Preact frontend from the same Worker. The
  detail routes (`/<YYYY-MM-DD>/<HHMMSS>/`) fall back to the app shell.

```
ntfy topic  ->  Worker cron  ->  D1  ->  Worker /api  ->  Preact feed
```

## Performance

Same shape as trustsight.org: the single stylesheet is inlined at build time
(no render-blocking request, hash pinned in the CSP), the Inter font is
preloaded, and a small static shell paints before the app mounts. The feed
page is one compressed HTML response; the app then fetches `/api/feed`.

## URLs

- `/` the feed, newest first, with search and event filters.
- `/<YYYY-MM-DD>/<HHMMSS>/` one notification, split into explained sections:
  new alerts, packages over threshold (each with its rule breakdown), IOC
  matches, and campaigns. Each flagged package has a Findings/Source switch:
  Source shows the analysed file from the AUR repository with the flagged lines
  highlighted and the rule named on each one. The full JSON is hidden behind a
  Show JSON button. A same-second collision appends the ntfy id to keep the slug
  unique.

On a phone, a rule explanation opens as a modal (a bottom sheet) rather than a
hover box, and every control is sized for touch.

## API

A read-only JSON API over the same store, with an OpenAPI 3.1 description:

- `/api` the styled reference page (rendered from the spec). `/api/`,
  `/api/docs` and `/api/reference` redirect there; `/api/index.json` is a
  plain endpoint list.
- `/api/openapi.json` the OpenAPI document.
- `/api/feed` search, with `q`, `event`, `day`, `from`, `to`, `limit` and a
  keyset cursor.
- `/api/latest` and `/api/latest/{n}` the most recent notifications.
- `/api/date/{YYYY-MM-DD}` and `/api/date/{YYYY-MM-DD}/{timeframe}` a UTC day
  or a window in it (`HH`, `HH-HH`, or `HHMM-HHMM`).
- `/api/package/{name}` and `/api/rule/{id}` everything mentioning a package or
  fired by a rule.
- `/api/messages/{slug}`, `/api/stats`.
- `/api/source/{package}?file=PKGBUILD` the analysed AUR file, unmodified, so a
  client can show the flagged lines. Only AUR repository files resolve; the
  host is fixed and the path is validated, so a finding cannot make the Worker
  fetch an arbitrary URL. When a finding names a file the repository holds under
  another name (for example `<pkgname>.install` against an actual `.install`) the
  same-extension file is served, and on a miss the repository's file list is
  returned so the client can offer it.
- `/health` (and `/healthz`) liveness and readiness: `ok` with the schema
  version and the time of the most recent notification, or `503` when the
  database is unreachable. Not rate limited.
Every endpoint is CORS open. A client is limited to 120 requests a minute by
the Cloudflare rate limiting binding; past the cap the API answers HTTP 429
with a `Retry-After` header. The spec is the single source of truth: the
Worker serves it and the reference page renders from it.

The root spellings `/feed`, `/latest`, `/date/*`, `/package/*`, `/rule/*`,
`/stats` and `/messages/*` redirect (308) to their `/api` equivalent, so a
shortened URL never falls through to the app shell.

## Layout

```
worker/          poller, API, parsing helpers, Worker entry
migrations/      D1 schema (notifications, FTS5, meta cursor)
src/             Preact frontend (feed, detail, rule chips, styles)
scripts/         rule-catalog generator, CSP check
test/            Worker tests (Miniflare + D1)
public/          favicons, fonts, _headers (CSP)
```

## Develop

Requires Node and Python 3.11+ with the TrustSight checkout as a sibling
(`../trustsight`), or `TRUSTSIGHT_SRC` pointing at its `src/`.

```bash
npm install
python scripts/build_rule_catalog.py    # regenerate rule explanations
npm run build                           # build the frontend into dist/
npm run worker:dev                      # wrangler dev (Worker + D1 + assets)
npm test                                # worker tests
npm run verify:csp                      # inline theme script hash still pinned
```

## Deploy

```bash
npx wrangler d1 create trustsight-feed          # put the id in wrangler.jsonc
npm run db:apply                                # apply migrations (local or remote)
npm run build
npx wrangler deploy
```

Then attach the `watcher.trustsight.org` custom domain to the Worker.

Configuration is `vars` in `wrangler.jsonc`: `NTFY_SERVER`, `NTFY_TOPIC`, and
an optional `NTFY_TOKEN` secret when the topic is read protected.

Once deployed, the cron keeps the store current. The ntfy cache is about
twelve hours, so anything published before the first deploy and older than the
cache cannot be recovered; from the first cycle on, nothing is missed.
