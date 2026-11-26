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
              <Card label="Scans in 30 days" value={count(totals.scans)} hint="Packages attempted across the cycles in the window." />
              <Card label="Upstream findings" value={count(totals.findings)} hint="Rule firings over the extracted manifests, not distinct packages." />
              <Card label="Rules fired" value={count(totals.rules_fired)} hint="Distinct U or W rules with at least one finding." />
              <Card label="Refusals" value={count(totals.refusals)} hint="W014/W015: the lane could not read the archive or its structure was ambiguous." />
            </div>

            <p className="upstream-meta">
              {observed.first
                ? <>Observed from <time dateTime={new Date(observed.first * 1000).toISOString()}>{formatTime(observed.first)}</time>
                  {' '}to <time dateTime={new Date(observed.last * 1000).toISOString()}>{relative(observed.last)}</time>.</>
                : 'No upstream finding in this window.'}
              {' '}Counts are rule firings: one package can fire the same rule for several
              manifests, and U001/U002 are weight-0 ledger entries rather than verdicts.
            </p>

            {fired.length ? (
              <section className="upstream-section" aria-labelledby="upstream-rules">
                <h2 id="upstream-rules">Rules</h2>
                <table className="api-params upstream-table">
                  <thead>
                    <tr><th>Rule</th><th>Name</th><th>Severity</th><th className="upstream-num">Findings</th></tr>
                  </thead>
                  <tbody>
                    {rules.map((row) => {
                      const info = ruleInfo(row.rule_id)
                      return (
                        <tr key={row.rule_id}>
                          <th><RuleChip id={row.rule_id} /></th>
                          <td>
                            {info && info.docsUrl
                              ? <a href={info.docsUrl} target="_blank" rel="noreferrer">{info.name}</a>
                              : (info && info.name) || (String(row.rule_id).startsWith('W') ? 'Refusal boundary' : 'Upstream rule')}
                          </td>
                          <td>{row.severity || (info && info.severity) || ''}</td>
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
                  {recent.map((row) => (
                    <li key={`${row.package}-${row.rule_id}`}>
                      <a href={packageHref(row.package)} data-route>{row.package}</a>{' '}
                      <RuleChip id={row.rule_id} />{' '}
                      <span className="history-row__time">{relative(row.time)}</span>
                    </li>
                  ))}
                </ul>
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
