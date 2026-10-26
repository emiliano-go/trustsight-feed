import { useEffect, useState } from 'preact/hooks'
import { AccessibilityMenu, ThemeSwitch, Wordmark } from './Controls.jsx'
import { RuleChip } from './RuleChip.jsx'
import { parseDependencies } from './deps.js'
import { formatTime, relative } from './util.js'

const WINDOW_SECONDS = 30 * 86400
const GROUPS = [
  ['depends', 'Runtime dependencies'],
  ['makedepends', 'Build dependencies'],
  ['checkdepends', 'Test dependencies'],
  ['optdepends', 'Optional dependencies'],
]
const OWNERSHIP_RULES = 'H044,H045,H026'

const packageHref = (name) => `/pkg/${encodeURIComponent(name)}`
const depsHref = (name) => `/deps/${encodeURIComponent(name)}`

async function getJson(url) {
  const response = await fetch(url)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}

function groupByPackage(rows) {
  const grouped = new Map()
  for (const row of rows || []) {
    if (!row || !row.package) continue
    const current = grouped.get(row.package) || []
    current.push(row)
    grouped.set(row.package, current)
  }
  return grouped
}

function EventLinks({ events, limit = 3 }) {
  if (!events || !events.length) {
    return <span className="history-row__time">no adoption signal in 30 days</span>
  }
  const shown = events.slice(0, limit)
  return (
    <>
      {shown.map((event) => (
        <span className="history-row__time" key={event.id || `${event.rule_id}-${event.slug}`}>
          <RuleChip id={event.rule_id} />{' '}
          <a href={`/${event.slug}/`} data-route title={formatTime(event.time)}>{relative(event.time)}</a>
        </span>
      ))}
      {events.length > shown.length ? (
        <span className="history-row__time">+{events.length - shown.length} more</span>
      ) : null}
    </>
  )
}

export function Dependencies({ name }) {
  const [query, setQuery] = useState(name || '')
  const [source, setSource] = useState(null)
  const [ownership, setOwnership] = useState(null)
  const [impact, setImpact] = useState(null)
  const [recent, setRecent] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(Boolean(name))

  useEffect(() => { setQuery(name || '') }, [name])

  useEffect(() => {
    let live = true
    const since = Math.floor(Date.now() / 1000) - WINDOW_SECONDS
    getJson(`/api/triggers?rule=H046&since=${since}&limit=100`)
      .then((body) => { if (live) setRecent(body.items || []) })
      .catch(() => { if (live) setRecent([]) })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (!name) {
      setSource(null)
      setOwnership(null)
      setImpact(null)
      setError('')
      setLoading(false)
      return
    }
    let live = true
    const since = Math.floor(Date.now() / 1000) - WINDOW_SECONDS
    setLoading(true)
    setError('')
    setSource(null)
    setOwnership(null)
    setImpact(null)
    Promise.all([
      getJson(`/api/source/${encodeURIComponent(name)}?file=PKGBUILD`),
      getJson(`/api/triggers?rule=${OWNERSHIP_RULES}&since=${since}&limit=1000`),
      getJson(`/api/triggers?rule=H046&package=${encodeURIComponent(name)}&since=${since}&limit=200`),
    ])
      .then(([sourceBody, ownershipBody, impactBody]) => {
        if (!live) return
        setSource(sourceBody)
        setOwnership(ownershipBody)
        setImpact(impactBody)
      })
      .catch((err) => { if (live) setError(String(err && err.message ? err.message : err)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [name])

  function submit(event) {
    event.preventDefault()
    const target = query.trim()
    if (!target) return
    window.history.pushState({}, '', depsHref(target))
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  const parsed = source ? parseDependencies(String(source.content || '')) : null
  const ownershipByPackage = groupByPackage(ownership && ownership.items)
  const recentByPackage = groupByPackage(recent)
  const recentRows = [...recentByPackage.entries()]
    .map(([packageName, rows]) => ({
      package: packageName,
      count: rows.length,
      last: Math.max(...rows.map((row) => Number(row.time) || 0)),
    }))
    .sort((a, b) => b.last - a.last)

  return (
    <div className="page" id="top">
      <a className="skip-link" href="#content">Skip to content</a>
      <header className="topbar">
        <Wordmark />
        <div className="masthead-actions">
          <AccessibilityMenu />
          <ThemeSwitch />
        </div>
      </header>
      <main id="content" className="detail">
        <a className="back-link" href="/" data-route>← all alerts</a>
        <h1>Dependency check</h1>
        <p className="detail__explain">
          Read a package&rsquo;s current <code className="md-code">PKGBUILD</code> dependencies and
          cross-reference them with ownership changes and adoption signals from the last 30 days.
          A signal is evidence, not a verdict: it names a dependency whose maintainer changed or
          that was adopted, not a dependency that is malicious.
        </p>

        <form className="deps-form" onSubmit={submit}>
          <label className="search">
            <span className="visually-hidden">Check dependency signals for an AUR package</span>
            <input
              type="search"
              value={query}
              placeholder="AUR package name, e.g. yay"
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <button className="filter" type="submit">Check</button>
        </form>

        {loading ? <p className="feed-empty">Reading the current PKGBUILD and watcher signals…</p> : null}
        {error ? <p className="feed-error">Could not check {name} ({error}).</p> : null}

        {!name ? (
          <section className="detail__section">
            <h2>Recent dependency-impact alerts <span className="count">{recentRows.length}</span></h2>
            <p className="pkg__meta">
              H046 means the named package depends directly on a package that was orphaned or
              adopted this cycle. Open a package to check its declared dependencies.
            </p>
            {recentRows.length ? (
              <ul className="history-list">
                {recentRows.map((row) => (
                  <li className="history-row" key={row.package}>
                    <a className="history-row__main" href={depsHref(row.package)} data-route>{row.package}</a>
                    <span className="history-row__time">{row.count} dependency signal{row.count === 1 ? '' : 's'}</span>
                    <span className="history-row__time" title={formatTime(row.last)}>last {relative(row.last)}</span>
                    <a className="pkg__history" href={packageHref(row.package)} data-route>package history →</a>
                  </li>
                ))}
              </ul>
            ) : <p className="feed-empty">No dependency-impact alerts in the last 30 days.</p>}
          </section>
        ) : null}

        {name && parsed ? (
          <>
            <div className="detail__meta">
              <a href={`https://aur.archlinux.org/packages/${encodeURIComponent(name)}`} target="_blank" rel="noreferrer">AUR package ↗</a>
              <a href={packageHref(name)} data-route>Package history</a>
              <span>checked {formatTime(Math.floor(Date.now() / 1000))}</span>
            </div>
            <p className="pkg__meta">
              H046 dependency-impact alerts for this package in the last 30 days:{' '}
              <b>{impact && impact.items ? impact.items.length : 0}</b>.
            </p>
            {impact && impact.items && impact.items.length ? (
              <ul className="history-list">
                {impact.items.map((row) => (
                  <li className="history-row" key={row.id || `${row.slug}-${row.package}`}>
                    <span className="history-row__main">{row.package}</span>
                    <RuleChip id={row.rule_id} />
                    <a className="history-row__time" href={`/${row.slug}/`} data-route>{relative(row.time)}</a>
                  </li>
                ))}
              </ul>
            ) : null}

            {parsed.dynamic.length ? (
              <p className="pkg__meta">
                Dynamic dependency entries were not resolved: {parsed.dynamic.map((entry) => <code className="md-code" key={entry}>{entry}</code>)}.
              </p>
            ) : null}

            {GROUPS.map(([key, label]) => {
              const entries = parsed[key]
              if (!entries.length) return null
              return (
                <section className="detail__section" key={key}>
                  <h2>{label} <span className="count">{entries.length}</span></h2>
                  <ul className="history-list">
                    {entries.map((dependency) => (
                      <li className="history-row" key={`${key}-${dependency}`}>
                        <a className="history-row__main" href={packageHref(dependency)} data-route>{dependency}</a>
                        <EventLinks events={ownershipByPackage.get(dependency)} />
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
            {!GROUPS.some(([key]) => parsed[key].length) ? (
              <p className="feed-empty">No literal dependency arrays were found in this PKGBUILD.</p>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  )
}
