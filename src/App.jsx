import { useEffect, useState } from 'preact/hooks'
import { AccessibilityMenu, ThemeSwitch, Wordmark } from './Controls.jsx'
import { RuleChip } from './RuleChip.jsx'
import { AUR_PACKAGE, eventBadgeClass, eventLabel, formatUtc, relative } from './util.js'

const DOCS = 'https://docs.trustsight.org'
const SECURITY = `${DOCS}/security/`
const GITHUB = 'https://github.com/emiliano-go/trustsight'
const FEED_REPO = 'https://github.com/emiliano-go/trustsight-feed'
const SITE = 'https://trustsight.org'

const FILTERS = [
  ['trustsight.alerts', 'Alerts'],
  ['trustsight.heartbeat', 'Heartbeats'],
  ['all', 'All'],
]

function FeedItem({ item }) {
  const href = `/${item.slug}/`
  return (
    <article className="feed-item">
      <div className="feed-item__head">
        <a className="feed-item__time" href={href} data-route>{formatUtc(item.time)}</a>
        <span className={eventBadgeClass(item.event)}>{eventLabel(item.event)}</span>
        {item.day ? <span className="badge">day {item.day}</span> : null}
      </div>
      <h3 className="feed-item__title">
        <a href={href} data-route>{item.title || '(untitled notification)'}</a>
      </h3>
      <div className="feed-item__tags">
        {item.packages.map((name) => (
          <a className="chip" key={`p-${name}`} href={AUR_PACKAGE(name)} target="_blank" rel="noreferrer">{name}</a>
        ))}
        {item.rules.map((id) => <RuleChip key={`r-${id}`} id={id} />)}
      </div>
    </article>
  )
}

export function App() {
  const [query, setQuery] = useState('')
  const [event, setEvent] = useState('trustsight.alerts')
  const [items, setItems] = useState([])
  const [next, setNext] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stats, setStats] = useState(null)

  async function load({ append = false, q, ev, before, beforeRow } = {}) {
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    const term = (q ?? query).trim()
    if (term) params.set('q', term)
    params.set('event', ev ?? event)
    params.set('limit', '30')
    if (before) { params.set('before', before); params.set('beforeRow', beforeRow) }
    try {
      const res = await fetch(`/api/feed?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems((prev) => (append ? [...prev, ...data.items] : data.items))
      setNext(data.next)
    } catch (err) {
      setError(String(err && err.message ? err.message : err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetch('/api/stats').then((r) => r.json()).then(setStats).catch(() => {})
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => load({ q: query, ev: event }), 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, event])

  return (
    <div className="page" id="top">
      <a className="skip-link" href="#content">Skip to content</a>

      <header className="masthead masthead--feed">
        <div className="masthead-top">
          <Wordmark />
          <div className="masthead-actions">
            <AccessibilityMenu />
            <ThemeSwitch />
          </div>
        </div>
        <h1>AUR watcher feed</h1>
        <p className="masthead-definition">
          Notifications from the TrustSight AUR watcher, stored as the watcher published them.
          Search them by package, rule, version or day. Each entry links to its full evidence
          document.
        </p>
        <p className="masthead-note">
          TrustSight produces evidence, not proof of safety. It never runs a PKGBUILD and never
          modifies your system. A notification is evidence, not a verdict, and nothing here is
          permission to install: a clean signal means no published rule matched, not that the
          update is safe. See the <a href={SECURITY} target="_blank" rel="noreferrer">security model</a>.
        </p>
        <div className="masthead-stats">
          <div><b>{stats ? stats.total : '…'}</b>alert notifications preserved</div>
          {stats && Number.isFinite(stats.last) ? <div><b>{relative(stats.last)}</b>last signal</div> : null}
          {stats ? <div><b>{stats.over_threshold}</b>over threshold</div> : null}
          {stats ? <div><b>{stats.ioc}</b>IOC matches</div> : null}
        </div>
        <nav className="masthead-links" aria-label="Primary">
          <a href={DOCS} target="_blank" rel="noreferrer">Docs ↗</a>
          <a href={SECURITY} target="_blank" rel="noreferrer">Security model ↗</a>
          <a href={SITE} target="_blank" rel="noreferrer">trustsight.org ↗</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">Tool source ↗</a>
          <a href={FEED_REPO} target="_blank" rel="noreferrer">Feed source ↗</a>
        </nav>
      </header>

      <main id="content">
        <section className="section" aria-labelledby="feed">
          <div className="section-label">Feed</div>
          <h2 id="feed">Search the alerts</h2>

          <div className="feed-controls">
            <label className="search">
              <span className="visually-hidden">Search alerts by package, rule, version or day</span>
              <input
                type="search"
                value={query}
                placeholder="package, rule id, version, day…"
                onInput={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="filters" role="group" aria-label="Filter by event">
              {FILTERS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`filter${event === value ? ' is-on' : ''}`}
                  aria-pressed={event === value}
                  onClick={() => setEvent(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="feed-count">
            {loading && !items.length ? 'loading…' : `${items.length} shown${next ? '+' : ''}`}
          </p>

          {error ? <p className="feed-error">Could not load the feed: {error}</p> : null}
          {!loading && !error && !items.length ? (
            <p className="feed-empty">
              {query.trim()
                ? `No notifications match “${query.trim()}”.`
                : 'No notifications yet. The watcher pushes here as it raises alerts.'}
            </p>
          ) : null}

          <div className="feed">
            {items.map((item) => <FeedItem key={item.slug} item={item} />)}
          </div>

          {next ? (
            <button
              type="button"
              className="load-more"
              disabled={loading}
              onClick={() => load({ append: true, before: next.before, beforeRow: next.beforeRow })}
            >
              {loading ? 'loading…' : 'Load older'}
            </button>
          ) : null}
        </section>
      </main>

      <footer className="colophon" aria-label="Colophon">
        <div>
          <h2>TrustSight Watcher</h2>
          <p>Alerts are ingested from the watcher&rsquo;s ntfy topic and preserved in a searchable store. This site is watcher.trustsight.org.</p>
          <p>Built by <strong>Emiliano Gandini</strong>. MIT licensed.</p>
        </div>
        <div>
          <h2>Sources</h2>
          <ul>
            <li><a href={SITE} target="_blank" rel="noreferrer">trustsight.org ↗</a></li>
            <li><a href={DOCS} target="_blank" rel="noreferrer">Documentation ↗</a></li>
            <li><a href={`${DOCS}/reference/rules/`} target="_blank" rel="noreferrer">Rules reference ↗</a></li>
            <li><a href={GITHUB} target="_blank" rel="noreferrer">Tool source on GitHub ↗</a></li>
            <li><a href={FEED_REPO} target="_blank" rel="noreferrer">Feed source on GitHub ↗</a></li>
          </ul>
        </div>
        <p className="colophon-note">
          An alert means a rule matched the change under review. It is input to a decision, not the
          decision: absence of signals is a statement about detection, not about the update. Read
          the <a href={SECURITY} target="_blank" rel="noreferrer">security model</a>.
        </p>
      </footer>
    </div>
  )
}
