import { useEffect, useState } from 'preact/hooks'
import { AccessibilityMenu, ThemeSwitch, Wordmark } from './Controls.jsx'
import { RuleChip } from './RuleChip.jsx'
import { eventBadgeClass, eventLabel, formatTime, relative } from './util.js'

const DOCS = 'https://docs.trustsight.org'
const SECURITY = `${DOCS}/security/`
const STATS_URL = '/api/stats?v=2'
const GITHUB = 'https://github.com/emiliano-go/trustsight'
const ISSUES = `${GITHUB}/issues`
const FP_DOCS = `${DOCS}/guides/tuning-false-positives/`
const FP_ISSUE = `${GITHUB}/issues/new?template=false_positive.yml`
const FEED_REPO = 'https://github.com/emiliano-go/trustsight-feed'
const NTFY = 'https://ntfy.sh/trustsight-aur-1d8a3fd2'
const SITE = 'https://trustsight.org'

const FILTERS = [
  ['trustsight.alerts', 'Alerts'],
  ['trustsight.heartbeat', 'Heartbeats'],
  ['all', 'All'],
]

export function FeedItem({ item }) {
  const href = `/${item.slug}/`
  const iocPackages = new Set(item.ioc_packages || [])
  const isIoc = iocPackages.size > 0 || Boolean(item.counts && item.counts.ioc)
  return (
    <article className={`feed-item${isIoc ? ' feed-item--ioc' : ''}`}>
      <div className="feed-item__head">
        <a className="feed-item__time" href={href} data-route>{formatTime(item.time)}</a>
        <span className={eventBadgeClass(item.event)}>{eventLabel(item.event)}</span>
        {isIoc ? <span className="badge badge--ioc">IOC match</span> : null}
      </div>
      <h3 className="feed-item__title">
        <a href={href} data-route>{item.headline || item.title || 'Untitled notification'}</a>
      </h3>
      <div className="feed-item__tags">
        {item.packages.map((name) => (
          <a className={`chip${iocPackages.has(name) ? ' chip--ioc' : ''}`} key={`p-${name}`} href={`/pkg/${encodeURIComponent(name)}`} data-route>{name}</a>
        ))}
        {item.rules.map((id) => <RuleChip key={`r-${id}`} id={id} />)}
      </div>
    </article>
  )
}

export function FeedSkeleton() {
  return (
    <div className="feed-skeleton" aria-hidden="true">
      <i /><i /><i />
    </div>
  )
}

export function App() {
  const [query, setQuery] = useState('')
  const [event, setEvent] = useState('trustsight.alerts')
  const [campaign, setCampaign] = useState(() => new URLSearchParams(window.location.search).get('campaign') || '')
  const [maintainer, setMaintainer] = useState(() => new URLSearchParams(window.location.search).get('maintainer') || '')
  const [items, setItems] = useState([])
  const [next, setNext] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stats, setStats] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const [refreshTick, setRefreshTick] = useState(0)

  async function load({ append = false, q, ev, before, beforeRow } = {}) {
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    const term = (q ?? query).trim()
    if (term) params.set('q', term)
    if (campaign.trim()) params.set('campaign', campaign.trim())
    if (maintainer.trim()) params.set('maintainer', maintainer.trim())
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

  // Stats are cheap and the watcher keeps pushing: refresh them, and the
  // relative "last refreshed" clock, so neither freezes on a stale first paint.
  useEffect(() => {
    let live = true
    const refresh = () => fetch(STATS_URL)
      .then((r) => r.json())
      .then((d) => { if (live) setStats(d) })
      .catch(() => {})
    refresh()
    const timer = setInterval(refresh, 30000)
    return () => { live = false; clearInterval(timer) }
  }, [])

  // A live feed: reload the first page and re-tick the clock every minute, so
  // a notification stored since the page opened appears without a manual reload.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
      setRefreshTick((t) => t + 1)
    }, 60000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => load({ q: query, ev: event }), 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, event, refreshTick])

  // Reload the list and the stats without reloading the page.
  function manualRefresh() {
    setNow(Date.now())
    setRefreshTick((t) => t + 1)
    fetch(STATS_URL).then((r) => r.json()).then(setStats).catch(() => {})
  }

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
        <p className="masthead-note">
          TrustSight reports evidence, not verdicts. It never runs a PKGBUILD or changes your
          system, and a clean result only means no published rule matched. It is not a reason to
          install. Read the <a href={SECURITY} target="_blank" rel="noreferrer">security model</a>.
          The rules are calibrated against a locked corpus, but false-positive tuning is ongoing.
          A hit on a genuine bad practice is a real finding, not a rule bug. If a rule fired with
          no bad practice or malicious behavior behind it,{' '}
          <a href={FP_ISSUE} target="_blank" rel="noreferrer">report the bad rule trigger</a>.
          Read <a href={FP_DOCS} target="_blank" rel="noreferrer">the distinction</a>.
        </p>
        <div className="masthead-stats">
          <div title={stats ? `${stats.total} alerts + ${stats.alive || 0} alive` : undefined}>
            <b>{stats ? stats.total + (stats.alive || 0) : '…'}</b>Total scans
          </div>
          <div><b>{stats ? stats.total : '…'}</b>Alerts</div>
          {stats && Number.isFinite(stats.last_alive) ? (
            <div title={`last alive: ${formatTime(stats.last_alive)}; last alert: ${formatTime(stats.last_alert)}`}>
              <b>{relative(stats.last_alive, now)}</b>Last refreshed
            </div>
          ) : null}
          {stats ? <div className="stat--warn"><b>{stats.over_threshold}</b>Packages over threshold</div> : null}
          {stats ? <div className="stat--ioc"><b>{stats.ioc}</b>IOC matches</div> : null}
          {stats && stats.tool_version ? (
            <div className="stat--version" title="TrustSight version that produced these analyses">
              <b>{stats.tool_version}</b>Analyzer
            </div>
          ) : null}
        </div>
        <nav className="masthead-links" aria-label="Primary">
          <a href={DOCS} target="_blank" rel="noreferrer">Docs ↗</a>
          <a href="/api" data-route>/api</a>
          <a href={SECURITY} target="_blank" rel="noreferrer">Security model ↗</a>
          <a href={NTFY} target="_blank" rel="noreferrer">ntfy channel ↗</a>
          <a href={SITE} target="_blank" rel="noreferrer">trustsight.org ↗</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">Tool source ↗</a>
          <a href={ISSUES} target="_blank" rel="noreferrer">Issues ↗</a>
          <a href={FEED_REPO} target="_blank" rel="noreferrer">Feed source ↗</a>
        </nav>
      </header>

      <main id="content">
        <section className="section feed-section" aria-labelledby="feed">
          <h2 id="feed" className="visually-hidden">Search the alerts</h2>

          <div className="feed-controls">
            <label className="search">
              <span className="visually-hidden">Search alerts by package, rule, version or day</span>
              <input
                type="search"
                value={query}
                placeholder="Search by package, rule, version or day"
                onInput={(e) => setQuery(e.target.value)}
              />
            </label>
            <label className="search">
              <span className="visually-hidden">Filter by campaign id</span>
              <input
                type="search"
                value={campaign}
                placeholder="Campaign id (optional)"
                onInput={(e) => setCampaign(e.target.value)}
              />
            </label>
            <label className="search">
              <span className="visually-hidden">Filter by maintainer</span>
              <input
                type="search"
                value={maintainer}
                placeholder="Maintainer (optional)"
                onInput={(e) => setMaintainer(e.target.value)}
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
            <button
              type="button"
              className="filter refresh-button"
              onClick={manualRefresh}
              disabled={loading}
              aria-label="Reload the list"
            >
              {loading ? 'Refreshing…' : '⟳ Refresh'}
            </button>
          </div>
          {error ? <p className="feed-error">Couldn&rsquo;t load the feed ({error}). Try Refresh.</p> : null}
          {!loading && !error && !items.length ? (
            <p className="feed-empty">
              {query.trim()
                ? `Nothing matches “${query.trim()}”. Try a package name, rule ID or version.`
                : 'No alerts yet. New ones appear here as the watcher raises them.'}
            </p>
          ) : null}

          <div className="feed">
            {loading && !items.length
              ? [0, 1, 2, 3].map((i) => <FeedSkeleton key={i} />)
              : items.map((item) => <FeedItem key={item.slug} item={item} />)}
          </div>

          {next ? (
            <button
              type="button"
              className="load-more"
              disabled={loading}
              onClick={() => load({ append: true, before: next.before, beforeRow: next.beforeRow })}
            >
              {loading ? 'Loading…' : 'Load older'}
            </button>
          ) : null}
        </section>
      </main>

      <footer className="colophon" aria-label="Colophon">
        <div>
          <h2>TrustSight Watcher</h2>
          <p>Alerts arrive from the watcher&rsquo;s ntfy topic and are stored here so you can search them. Served at watcher.trustsight.org.</p>
          <p>Built by <strong>Emiliano Gandini</strong>. MIT licensed.</p>
        </div>
        <div>
          <h2>Sources</h2>
          <ul>
            <li><a href={SITE} target="_blank" rel="noreferrer">trustsight.org ↗</a></li>
            <li><a href={DOCS} target="_blank" rel="noreferrer">Documentation ↗</a></li>
            <li><a href={`${DOCS}/reference/rules/`} target="_blank" rel="noreferrer">Rules reference ↗</a></li>
            <li><a href="/api/feed.atom">Atom feed</a></li>
            <li><a href="/api/feed.json">JSON feed</a></li>
            <li><a href="/api/iocs?format=json">IOC export</a></li>
            <li><a href={NTFY} target="_blank" rel="noreferrer">ntfy channel ↗</a></li>
            <li><a href={GITHUB} target="_blank" rel="noreferrer">Tool source on GitHub ↗</a></li>
            <li><a href={FEED_REPO} target="_blank" rel="noreferrer">Feed source on GitHub ↗</a></li>
          </ul>
        </div>
        <p className="colophon-note">
          An alert means a rule matched the change under review. It informs your decision and does
          not make it. No alert only means no rule matched, not that the update is safe. Read the{' '}
          <a href={SECURITY} target="_blank" rel="noreferrer">security model</a>.
        </p>
      </footer>
    </div>
  )
}
