# trustsight-feed

A live, searchable feed of the alerts the TrustSight AUR watcher raises,
hosted at [watcher.trustsight.org](https://watcher.trustsight.org).

The TrustSight container keeps running wherever it runs and pushing one JSON
document per alert cycle to an ntfy topic. Nothing about the container changes.
This project subscribes to that topic, preserves every notification in SQLite,
and serves a feed where each notification has its own page with the full
evidence document and hover explanations for every rule it fired.

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
  `message` event, and upserts it into D1 keyed by the ntfy message id.
- **D1 (SQLite)** stores the notifications, with an FTS5 index over package
  names, rule ids, versions, titles and days for search.
- **Static Assets** serve the Preact frontend from the same Worker. The
  detail routes (`/<YYYY-MM-DD>/<HHMMSS>/`) fall back to the app shell.

```
ntfy topic  ->  Worker cron  ->  D1  ->  Worker /api  ->  Preact feed
```

## URLs

- `/` the feed, newest first, with search and event filters.
- `/<YYYY-MM-DD>/<HHMMSS>/` one notification, full JSON, rule hover boxes.
  A same-second collision appends the ntfy id to keep the slug unique.

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
