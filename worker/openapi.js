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
    rules: { type: 'array', items: { type: 'string' }, description: 'Unique rule ids that fired.' },
  },
}

const NOTIFICATION = {
  allOf: [
    NOTIFICATION_SUMMARY,
    {
      type: 'object',
      properties: {
        payload: { type: 'object', description: 'The full TrustSight document as published to ntfy.', additionalProperties: true },
        message_raw: { type: 'string', description: 'The raw ntfy message body.' },
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
      + 'The API is public and CORS-open. Each client is limited to 120 requests a minute; a '
      + 'response over the cap is HTTP 429 with a Retry-After header.',
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
    '/api/stats': {
      get: {
        tags: ['Meta'],
        summary: 'Aggregate counts',
        description: 'Totals over alert documents.',
        responses: {
          200: {
            description: 'Aggregates.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    total: { type: 'integer' },
                    first: { type: ['integer', 'null'], description: 'Unix seconds.' },
                    last: { type: ['integer', 'null'] },
                    alerts: { type: 'integer' },
                    over_threshold: { type: 'integer' },
                    ioc: { type: 'integer' },
                    impersonation: { type: 'integer' },
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
  },
  components: {
    schemas: {
      NotificationSummary: NOTIFICATION_SUMMARY,
      Notification: NOTIFICATION,
    },
  },
}
