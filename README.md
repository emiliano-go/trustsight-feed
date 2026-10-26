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
- The feed renders untrusted text inertly: Preact escapes it, Atom escapes XML,
  CSV neutralises formula prefixes, and a notification's analysed diff is
  sanitised of escapes, controls and bidi overrides before it is stored.
- Ingest verifies an Ed25519 signature over the raw document. The signature,
  key id and body hash are stored so `/api/messages/{slug}` can be checked
  later; `/api/keys` exposes only the public keys.
- A daily checkpoint signs a Merkle root over a batch of notifications and
  chains to the previous root, so deletion or reordering is detectable. Its
  private key is a separate feed secret, never exposed by the API.

The full model is at
[docs.trustsight.org/security](https://docs.trustsight.org/security/). The rule
definitions shown on hover come from the TrustSight repository, so the feed
cannot quote an explanation the tool does not hold.

## Architecture

Everything runs on Cloudflare free tiers. If a step ever requires a paid
resource, stop.

- **Cloudflare Worker** receives the watcher's signed POST at `/api/ingest`,
  verifies the Ed25519 signature over the raw body, and stores one row per
  notification in D1. The ntfy-shaped parser is kept as a parity path, not as
  a poller.
- **D1 (SQLite)** stores the notifications, the derived campaign/maintainer/
  IOC event indexes, and the signed checkpoints. FTS5 indexes package names,
  rule ids, versions, titles and days.
- **A daily Cron Trigger** builds a signed Merkle checkpoint over the
  notifications stored since the previous checkpoint.
- **Static Assets** serve the Preact frontend from the same Worker. The
  detail routes (`/<YYYY-MM-DD>/<HHMMSS>/`) fall back to the app shell.

```
watcher --signed POST--> Worker --verify--> D1 --/api--> Preact feed
                              |
                              +--daily cron--> signed checkpoint
```

## Performance

Same shape as trustsight.org: the single stylesheet is inlined at build time
(no render-blocking request, hash pinned in the CSP), the Inter font is
preloaded, and a small static shell paints before the app mounts. The feed
page is one compressed HTML response; the app then fetches `/api/feed`.

The D1 schema is shaped for the free-tier read budget: `/api/stats` reads a
one-row rollup maintained by triggers instead of scanning every alert, list
queries filter through `(event, time)` and `(day, time)` indexes, and read
responses are held in the edge cache for 30 to 3600 seconds. A typo fallback
scans only a bounded newest window and fetches payloads only for the rows that
survive the match.

## URLs

- `/` the feed, newest first, with search and event filters.
- `/deps` and `/deps/{package}` the dependency check: it reads the package's
  current PKGBUILD dependency arrays and cross-references them with H044/H045/
  H026 ownership signals and H046 dependency-impact alerts from the last 30
  days. The landing page lists recent H046 packages; a missing dependency name
  is never guessed.
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
- `/api/feed` search, with `q`, `event`, `day`, `from`, `to`, `campaign`,
  `maintainer`, `rule`, `over`, `ioc`, `campaigns`, `refusals`, `limit` and a
  keyset cursor.
- `/api/latest` and `/api/latest/{n}` the most recent notifications.
- `/api/date/{YYYY-MM-DD}` and `/api/date/{YYYY-MM-DD}/{timeframe}` a UTC day
  or a window in it (`HH`, `HH-HH`, or `HHMM-HHMM`).
- `/api/package/{name}` and `/api/rule/{id}` everything mentioning a package or
  fired by a rule.
- `/api/triggers` every normalized rule firing (`rule`, `campaign`, `package`,
  `maintainer`, `severity`, `source`, `day`, `since`, `until`), as JSON, CSV or
  NDJSON. `include=evidence` adds file/line/reason; `include=summary` adds
  per-rule, per-package and per-campaign counts. `/api/rule/{id}/triggers` is
  the same extraction pinned to one rule, and `/api/rules` lists firing counts.
- `/api/campaign/{id}` also returns `triggered_rules` and the newest 100
  `triggers`, so a campaign drill-down is one request.
- `/api/package/{name}/history` every stored alert that names a package, with
  its version transitions, scores, rules, findings, maintainer-change signals
  and the upstream URLs those analyses record. The page at `/pkg/{name}` renders
  it beside the live AUR maintainer and current PKGBUILD.
- `/api/messages/{slug}`, `/api/stats`.
- `/api/feed.atom` and `/api/feed.json` the same alerts as Atom 1.0 and
  JSON Feed 1.1, with the same filters and a 100-item cap.
- `/api/campaigns` and `/api/campaign/{id}` campaign summaries and a durable
  timeline. `campaign_id` is published by the watcher for corroborated
  G-series clusters; older documents get a deterministic `legacy:` id.
- `/api/maintainer/{name}` packages, ownership transitions, campaigns and
  IOC packages for one maintainer. Names are matched by email identity when
  the display string carries one.
- `/api/iocs?format=json|ndjson|csv|stix` deduplicated IOC matches. CSV cells
  are quoted and formula-prefixed so a value cannot execute in a spreadsheet.
- `/api/keys` the public Ed25519 keys for ingest and archive checkpoints.
  `/api/messages/{slug}` carries the stored `verification` object.
  `node scripts/verify-feed.mjs <slug>` checks the Ed25519 signature and the
  body hash against the published key without trusting the store.
- `/api/checkpoints`, `/api/checkpoints/{id}` and
  `/api/checkpoints/{id}/proof?slug=...` the signed archive checkpoints and a
  Merkle inclusion proof. `node scripts/verify-checkpoint.mjs <id> <slug>`
  verifies the checkpoint signature and the notification's inclusion.
- `/api/source/{package}?file=PKGBUILD` the analysed AUR file, unmodified, so a
  client can show the flagged lines. Only AUR repository files resolve; the
  host is fixed and the path is validated, so a finding cannot make the Worker
  fetch an arbitrary URL. When a finding names a file the repository holds under
  another name (for example `<pkgname>.install` against an actual `.install`) the
  same-extension file is served, and on a miss the repository's file list is
  returned so the client can offer it.
- `/api/diff/{package}` the latest AUR commit as a unified diff, so the page can
  show what changed, including the removed lines.

Source and diff are fetched from the AUR at most once per day per file and then
served from the `source_cache` table, so a page view never reaches the AUR. The
exact revision the watcher analysed is not stored; the current repository file
is served, and the newest diff, which is usually the change that triggered the
alert.
- `/health` (and `/healthz`) liveness and readiness: `ok` with the schema
  version and the time of the most recent notification, or `503` when the
  database is unreachable. Not rate limited.
Every endpoint is CORS open. A client is limited to 120 requests a minute by
the Cloudflare rate limiting binding; past the cap the API answers HTTP 429
with a `Retry-After` header. Search routes (`/api/feed?q=`, `/api/package/*`
and `/api/rule/*`) have a second 60-a-minute cap because they can trigger the
bounded typo scan. The spec is the single source of truth: the Worker serves
it and the reference page renders from it.

The root spellings `/feed`, `/latest`, `/date/*`, `/package/*`, `/rule/*`,
`/stats` and `/messages/*` redirect (308) to their `/api` equivalent, so a
shortened URL never falls through to the app shell.

## Layout

```
worker/          poller, API, parsing helpers, Worker entry
migrations/      D1 schema (notifications, FTS5, stats rollup, indexes)
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
npm run backfill:events -- --require-complete   # required once after 0008/0009
npm run build
npx wrangler deploy
```

The backfill is mandatory before the Worker that reads the event indexes is
deployed. CI runs it after migrations and before `wrangler deploy`; a failure
stops the deployment. It is idempotent and can be re-run.

The signed-checkpoint cron needs feed-owned secrets, set with `wrangler secret
put`: `FEED_CHECKPOINT_PRIVATE_KEY` (Ed25519 PKCS#8, base64) and
`FEED_CHECKPOINT_KEY_ID`; the public half is
`FEED_CHECKPOINT_PUBLIC_KEY` (and optional `..._PREVIOUS_*` during rotation).
The private key is never exposed by the API.

Then attach the `watcher.trustsight.org` custom domain to the Worker.

Configuration is `vars` in `wrangler.jsonc`: `NTFY_SERVER`, `NTFY_TOPIC`, and
an optional `NTFY_TOKEN` secret when the topic is read protected.

Once deployed, the cron keeps the store current. The ntfy cache is about
twelve hours, so anything published before the first deploy and older than the
cache cannot be recovered; from the first cycle on, nothing is missed.
