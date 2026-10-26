import { useEffect, useRef, useState } from 'preact/hooks'
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
const DEFAULT_EVENT = 'trustsight.alerts'

const FILTERS = [
  [DEFAULT_EVENT, 'Alerts'],
  ['trustsight.heartbeat', 'Heartbeats'],
  ['all', 'All'],
]

const EMPTY_FILTERS = {
  q: '',
  event: DEFAULT_EVENT,
  campaign: '',
  maintainer: '',
  rule: '',
  over: false,
  ioc: false,
  campaigns: false,
  refusals: false,
}

function filtersFromUrl() {
  const params = new URLSearchParams(window.location.search)
  return {
    q: params.get('q') || '',
    event: FILTERS.some(([value]) => value === params.get('event')) ? params.get('event') : DEFAULT_EVENT,
    campaign: params.get('campaign') || '',
    maintainer: params.get('maintainer') || '',
    rule: params.get('rule') || '',
    over: params.get('over') === '1',
    ioc: params.get('ioc') === '1',
    campaigns: params.get('campaigns') === '1',
    refusals: params.get('refusals') === '1',
  }
}

function filtersToParams(filters) {
  const params = new URLSearchParams()
  for (const key of ['q', 'campaign', 'maintainer', 'rule']) {
    const value = String(filters[key] || '').trim()
    if (value) params.set(key, value)
  }
  if (filters.event && filters.event !== DEFAULT_EVENT) params.set('event', filters.event)
  for (const key of ['over', 'ioc', 'campaigns', 'refusals']) {
    if (filters[key]) params.set(key, '1')
  }
  return params
}

function activeFilterCount(filters) {
  let count = 0
  for (const key of ['q', 'campaign', 'maintainer', 'rule']) {
    if (String(filters[key] || '').trim()) count += 1
  }
  if (filters.event !== DEFAULT_EVENT) count += 1
  for (const key of ['over', 'ioc', 'campaigns', 'refusals']) {
    if (filters[key]) count += 1
  }
  return count
}

function mergeItems(current, incoming) {
  const seen = new Set(current.map((item) => item.slug))
  return [...incoming.filter((item) => !seen.has(item.slug)), ...current]
}

export function FeedItem({ item, onRule }) {
  const [copied, setCopied] = useState(false)
  const href = `/${item.slug}/`
  const iocPackages = new Set(item.ioc_packages || [])
  const counts = item.counts || {}
  const isIoc = iocPackages.size > 0 || Boolean(counts.ioc)
  const isCampaign = (item.rules || []).some((id) => /^G\d{3}$/.test(String(id)))

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${href}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <article className={`feed-item${isIoc ? ' feed-item--ioc' : ''}`}>
      <div className="feed-item__head">
        <a className="feed-item__time" href={href} data-route>{formatTime(item.time)}</a>
        <span className={eventBadgeClass(item.event)}>{eventLabel(item.event)}</span>
        {counts.over_threshold ? <span className="badge badge--alerts">{counts.over_threshold} over threshold</span> : null}
        {isIoc ? <span className="badge badge--ioc">IOC match</span> : null}
        {isCampaign ? <span className="badge">campaign</span> : null}
      </div>
      <h3 className="feed-item__title">
        <a href={href} data-route>{item.headline || item.title || 'Untitled notification'}</a>
      </h3>
      <div className="feed-item__tags">
        {item.packages.map((name) => (
          <a className={`chip${iocPackages.has(name) ? ' chip--ioc' : ''}`} key={`p-${name}`} href={`/pkg/${encodeURIComponent(name)}`} data-route>{name}</a>
        ))}
        {item.rules.map((id) => <RuleChip key={`r-${id}`} id={id} onFilter={onRule} />)}
        <button type="button" className="feed-item__copy" onClick={copyLink} aria-label={`Copy link to ${item.headline || item.slug}`}>
          {copied ? 'copied' : 'copy link'}
        </button>
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
  const [filters, setFilters] = useState(filtersFromUrl)
  const [items, setItems] = useState([])
  const [next, setNext] = useState(null)
  const [newItems, setNewItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stats, setStats] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const [paused, setPaused] = useState(false)
  const loadSeq = useRef(0)
  const loadAbort = useRef(null)
  const loadingRef = useRef(false)
  const itemsRef = useRef([])
  const filtersRef = useRef(filters)
  const pausedRef = useRef(false)
  const active = activeFilterCount(filters)
  const subscribeParams = filtersToParams(filters).toString()
  const subscribeSuffix = subscribeParams ? `?${subscribeParams}` : ''

  useEffect(() => { itemsRef.current = items }, [items])
  useEffect(() => { pausedRef.current = paused }, [paused])

  function setFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  function toggleFilter(key) {
    setFilters((current) => ({ ...current, [key]: !current[key] }))
  }

  function clearFilters() {
    setFilters({ ...EMPTY_FILTERS })
  }

  async function load({ append = false, background = false, before, beforeRow, nextFilters } = {}) {
    if (background && loadingRef.current) return
    const seq = ++loadSeq.current
    loadAbort.current?.abort()
    const controller = new AbortController()
    loadAbort.current = controller
    const current = nextFilters || filtersRef.current
    const params = filtersToParams(current)
    params.set('limit', '30')
    if (before) { params.set('before', before); params.set('beforeRow', beforeRow) }
    if (!background) {
      loadingRef.current = true
      setLoading(true)
      setError('')
    }
    try {
      const res = await fetch(`/api/feed?${params.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (seq !== loadSeq.current) return
      if (background) {
        const fresh = data.items.filter(
          (item) => !itemsRef.current.some((currentItem) => currentItem.slug === item.slug),
        )
        if (fresh.length) {
          setNewItems((currentItems) => mergeItems(currentItems, fresh))
        }
        return
      }
      setItems((currentItems) => (append ? [...currentItems, ...data.items] : data.items))
      setNext(data.next)
      setNewItems([])
    } catch (err) {
      if (err && err.name === 'AbortError') return
      if (seq !== loadSeq.current) return
      if (!background) setError(String(err && err.message ? err.message : err))
    } finally {
      if (seq === loadSeq.current && !background) {
        loadingRef.current = false
        setLoading(false)
      }
    }
  }

  // Filters live in the URL so a filtered view is shareable, survives a
  // navigation to an alert and back, and works with browser history.
  useEffect(() => {
    filtersRef.current = filters
    const params = filtersToParams(filters)
    const query = params.toString()
    const target = query ? `${window.location.pathname}?${query}` : window.location.pathname
    window.history.replaceState(window.history.state, '', target)
    setNewItems([])
    const timer = setTimeout(() => load({ nextFilters: filters }), 250)
    return () => clearTimeout(timer)
    // load reads the refs above; it does not need to be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters])

  useEffect(() => {
    const onPop = () => setFilters(filtersFromUrl())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Stats are cheap and the watcher keeps pushing; refresh them separately
  // from the feed so the list is never replaced by a periodic tick.
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

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
      if (!pausedRef.current) load({ background: true })
    }, 60000)
    return () => clearInterval(timer)
    // The first load closure reads itemsRef/filtersRef; it stays valid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const tag = String((event.target && event.target.tagName) || '').toLowerCase()
      const editing = tag === 'input' || tag === 'textarea' || tag === 'select'
      if (event.key === '/' && !editing) {
        event.preventDefault()
        document.getElementById('feed-search')?.focus()
      } else if (event.key === 'Escape' && document.activeElement?.id === 'feed-search') {
        document.activeElement.blur()
      } else if (event.key === 'Home' && !editing) {
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function showNewItems() {
    setItems((current) => mergeItems(current, newItems))
    setNewItems([])
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function manualRefresh() {
    setNow(Date.now())
    fetch(STATS_URL).then((r) => r.json()).then(setStats).catch(() => {})
    load({ background: itemsRef.current.length > 0 })
  }

  const emptyMessage = active
    ? 'No alerts match these filters.'
    : 'No alerts yet. New ones appear here as the watcher raises them.'

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
          <a href="/deps" data-route>Dependencies</a>
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
                id="feed-search"
                type="search"
                value={filters.q}
                placeholder="Search by package, rule, version or day"
                onInput={(e) => setFilter('q', e.target.value)}
              />
            </label>
            <div className="filters" role="group" aria-label="Filter by event">
              {FILTERS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`filter${filters.event === value ? ' is-on' : ''}`}
                  aria-pressed={filters.event === value}
                  onClick={() => setFilter('event', value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`filter live-toggle${paused ? ' is-paused' : ''}`}
              aria-pressed={!paused}
              onClick={() => setPaused((value) => !value)}
              title={paused ? 'Auto-refresh is paused' : 'Auto-refresh is live'}
            >
              {paused ? 'Paused' : 'Live'}
            </button>
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

          <details className="filter-panel">
            <summary>
              Filters{active ? <span className="count">{active}</span> : null}
            </summary>
            <div className="filter-panel__grid">
              <label className="search">
                <span className="visually-hidden">Filter by campaign id</span>
                <input
                  type="search"
                  value={filters.campaign}
                  placeholder="Campaign id"
                  onInput={(e) => setFilter('campaign', e.target.value)}
                />
              </label>
              <label className="search">
                <span className="visually-hidden">Filter by maintainer</span>
                <input
                  type="search"
                  value={filters.maintainer}
                  placeholder="Maintainer"
                  onInput={(e) => setFilter('maintainer', e.target.value)}
                />
              </label>
              <label className="search">
                <span className="visually-hidden">Filter by rule id</span>
                <input
                  type="search"
                  value={filters.rule}
                  placeholder="Rule id"
                  onInput={(e) => setFilter('rule', e.target.value)}
                />
              </label>
            </div>
            <div className="filters filter-panel__quick" role="group" aria-label="Quick filters">
              {[
                ['over', 'Over threshold'],
                ['ioc', 'IOC match'],
                ['campaigns', 'Campaigns'],
                ['refusals', 'Partial reads'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`filter${filters[key] ? ' is-on' : ''}`}
                  aria-pressed={filters[key]}
                  onClick={() => toggleFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="filter-panel__actions">
              <button type="button" className="filter" onClick={clearFilters} disabled={!active}>
                Clear filters
              </button>
              <a className="filter-panel__subscribe" href={`/api/feed.atom${subscribeSuffix}`}>Atom for this search</a>
              <a className="filter-panel__subscribe" href={`/api/feed.json${subscribeSuffix}`}>JSON for this search</a>
            </div>
          </details>

          {newItems.length ? (
            <button type="button" className="new-items" onClick={showNewItems} aria-live="polite">
              {newItems.length} new alert{newItems.length === 1 ? '' : 's'} — show
            </button>
          ) : null}

          {error ? <p className="feed-error">Couldn&rsquo;t load the feed ({error}). Try Refresh.</p> : null}
          {!loading && !error && !items.length ? (
            <p className="feed-empty">
              {emptyMessage}{' '}
              {active ? <button type="button" className="feed-empty__clear" onClick={clearFilters}>Clear filters</button> : null}
            </p>
          ) : null}
          {items.length ? (
            <p className="feed-result-count">
              {items.length} shown{next ? '+' : ''}{newItems.length ? ` · ${newItems.length} new` : ''}
            </p>
          ) : null}

          <div className="feed">
            {loading && !items.length
              ? [0, 1, 2, 3].map((i) => <FeedSkeleton key={i} />)
              : items.map((item) => <FeedItem key={item.slug} item={item} onRule={(id) => setFilter('rule', id)} />)}
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
          {items.length ? (
            <button type="button" className="back-to-top" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
              ↑ Back to top
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
            <li><a href={`/api/feed.atom${subscribeSuffix}`}>Atom feed</a></li>
            <li><a href={`/api/feed.json${subscribeSuffix}`}>JSON feed</a></li>
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
