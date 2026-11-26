import { useEffect, useState } from 'preact/hooks'
import { AccessibilityMenu, ThemeSwitch, Wordmark } from './Controls.jsx'
import { RuleChip } from './RuleChip.jsx'
import catalog from './rule-catalog.generated.json'
import { formatTime, relative } from './util.js'

const API = '/api/upstream?window=30d'
const DOCS = 'https://docs.trustsight.org/rules/upstream-manifests/'

const count = (value) => Number(value || 0).toLocaleString('en')
const packageHref = (name) => `/pkg/${encodeURIComponent(name)}`
const ruleInfo = (id) => catalog[String(id).toLowerCase()] || null
const dayLabel = (time) => new Date(time * 1000)
  .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

const SEVERITY_CLASS = {
  FATAL: 'sev--fatal', CRITICAL: 'sev--critical', HIGH: 'sev--high',
  MEDIUM: 'sev--medium', LOW: 'sev--low', INFO: 'sev--info',
}
const severityClass = (value) => SEVERITY_CLASS[String(value || '').toUpperCase()] || ''

/** One row per package, not one per rule: the lane names a package once. */
function groupRecent(rows) {
  const grouped = new Map()
  for (const row of rows) {
    const entry = grouped.get(row.package) || { package: row.package, rules: [], time: 0 }
    if (!entry.rules.includes(row.rule_id)) entry.rules.push(row.rule_id)
    entry.time = Math.max(entry.time, Number(row.time) || 0)
    grouped.set(row.package, entry)
  }
  return [...grouped.values()].sort((a, b) => b.time - a.time)
}

const RECENT_LIMIT = 12

async function getJson(url) {
  const response = await fetch(url)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}

function Card({ label, value, hint }) {
  return (
    <div className="upstream-card" title={hint}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}

export function Upstream() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    getJson(API)
      .then((body) => { if (live) setData(body) })
      .catch((err) => { if (live) setError(String(err && err.message ? err.message : err)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])

  const totals = (data && data.totals) || {}
  const rules = (data && data.rules) || []
  const recent = (data && data.recent) || []
  const observed = (data && data.observed) || {}
  const fired = rules.filter((row) => !String(row.rule_id).startsWith('W'))
  const recentPackages = groupRecent(recent)
  const findings = Number(totals.findings || 0)
  const refusalShare = findings ? Number(totals.refusals || 0) / findings : 0

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
        <h1>Upstream lane</h1>
        <p className="detail__explain">
          Most AUR packages commit only a <code className="md-code">PKGBUILD</code>, so the
          dependency manifests that matter ship inside the declared source archive. The
          watcher&rsquo;s opt-in upstream lane fetches that archive from an allowlisted forge,
          verifies the declared checksum, extracts the manifests in a sandboxed worker, and runs
          the <a href={DOCS} target="_blank" rel="noreferrer">U-series</a> over them. This page
          reports what it saw; the lane reads declarations and manifests, never a built package.
        </p>

        {error ? <p className="feed-error" role="alert">Could not load the upstream lane: {error}</p> : null}
        {loading && !data ? <p className="upstream-empty">Loading…</p> : null}

        {data ? (
          <>
            <div className="upstream-cards">
              <Card label="Scans" value={count(totals.scans)} hint="Packages attempted across the cycles in the last 30 days." />
              <Card label="Findings" value={count(totals.findings)} hint="Rule firings over the extracted manifests, not distinct packages." />
              <Card label="Rules" value={count(totals.rules_fired)} hint="Distinct U or W rules with at least one finding." />
              <Card label="Refusals" value={count(totals.refusals)} hint="W014/W015: the lane could not read the archive, or its structure was ambiguous." />
            </div>

            <p className="upstream-meta">
              {observed.first ? (
                <>Seen from <time dateTime={new Date(observed.first * 1000).toISOString()}>{dayLabel(observed.first)}</time>
                  {' '}to <time dateTime={new Date(observed.last * 1000).toISOString()}>{relative(observed.last)}</time>.{' '}</>
              ) : null}
              Counts are rule firings, not verdicts: one package can fire the same rule for
              several manifests, and most of the series is a weight-0 ledger.
              {refusalShare > 0.4 ? (
                <> Refusals dominate this window: {count(totals.refusals)} firings name an archive
                  the lane could not read.</>
              ) : null}
            </p>

            {fired.length ? (
              <section className="upstream-section" aria-labelledby="upstream-rules">
                <h2 id="upstream-rules">Rules</h2>
                <table className="api-params upstream-table">
                  <thead>
                    <tr><th>Rule</th><th>Name</th><th className="upstream-num">Findings</th></tr>
                  </thead>
                  <tbody>
                    {rules.map((row) => {
                      const info = ruleInfo(row.rule_id)
                      const severity = String(row.severity || (info && info.severity) || '').toUpperCase()
                      return (
                        <tr key={row.rule_id}>
                          <th><RuleChip id={row.rule_id} /></th>
                          <td className="upstream-name">
                            {info && info.docsUrl
                              ? <a href={info.docsUrl} target="_blank" rel="noreferrer">{info.name}</a>
                              : (info && info.name) || (String(row.rule_id).startsWith('W') ? 'Refusal boundary' : 'Upstream rule')}
                            {severity ? <span className={`sev ${severityClass(severity)}`}>{severity}</span> : null}
                          </td>
                          <td className="upstream-num">{count(row.count)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </section>
            ) : null}

            {recent.length ? (
              <section className="upstream-section" aria-labelledby="upstream-recent">
                <h2 id="upstream-recent">Named in the last week</h2>
                <ul className="upstream-recent">
                  {recentPackages.slice(0, RECENT_LIMIT).map((row) => (
                    <li key={row.package}>
                      <a href={packageHref(row.package)} data-route>{row.package}</a>
                      <span className="upstream-recent__rules">
                        {row.rules.map((id) => <RuleChip id={id} key={id} />)}
                      </span>
                      <span className="history-row__time">{relative(row.time)}</span>
                    </li>
                  ))}
                </ul>
                {recentPackages.length > RECENT_LIMIT ? (
                  <p className="upstream-meta">
                    +{count(recentPackages.length - RECENT_LIMIT)} more packages this week.
                  </p>
                ) : null}
              </section>
            ) : null}

            {!fired.length && !recent.length ? (
              <p className="upstream-empty">
                Nothing from the lane in this window. Either no manifest changed, or the lane is
                not enabled on the watcher.
              </p>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  )
}
