import { useEffect, useState } from 'preact/hooks'
import { AccessibilityMenu, ThemeSwitch, Wordmark } from './Controls.jsx'
import { RuleCard, RuleChip, RuleHighlight } from './RuleChip.jsx'
import { AUR_PACKAGE, eventBadgeClass, eventLabel, formatUtc, relative } from './util.js'

const SECURITY = 'https://docs.trustsight.org/security/'
const NTFY = 'https://ntfy.sh/trustsight-aur-1d8a3fd2'

// One-line explanations of the kinds of entry a document can carry, so a
// reader knows what they are looking at before the list.
export const ENTRY_TYPES = {
  alert: 'A rule firing: one published pattern matched one package change. A firing is a reason to look, not a verdict.',
  over_threshold: 'A package whose weighted score crossed the alerting bar (default 30, the benign corpus 95th percentile). It carries the version transition and every rule that fired.',
  ioc: 'A match against signed, federated known-bad indicators. Reported outside the heuristic score, so it is shown whatever the package scored.',
  campaign_cluster: 'A pattern shared across packages in a window (a host, a literal, an adopter). A campaign invisible in any single diff becomes visible in the set.',
  impersonation: 'Many name-clones of a popular package published under one account. The one alert a reviewer must not skim past.',
}

/** Group a flat alert list by package, so each flagged package owns a section. */
function groupAlerts(alerts) {
  const byName = new Map()
  for (const entry of alerts) {
    if (!entry.package) continue
    if (!byName.has(entry.package)) byName.set(entry.package, { package: entry.package, rules: [], seen: new Set() })
    const group = byName.get(entry.package)
    if (entry.rule_id && !group.seen.has(entry.rule_id)) {
      group.seen.add(entry.rule_id)
      group.rules.push(entry.rule_id)
    }
  }
  return [...byName.values()]
}

function AlertList({ alerts }) {
  if (!alerts.length) return null
  const groups = groupAlerts(alerts)
  return (
    <section className="detail__section">
      <h2>New alerts ({alerts.length})</h2>
      <p className="detail__explain">{ENTRY_TYPES.alert}</p>
      {groups.map((group) => (
        <article className="pkg" key={group.package}>
          <header className="pkg__head">
            <a className="pkg__name" href={AUR_PACKAGE(group.package)} target="_blank" rel="noreferrer">{group.package}</a>
            <span className="pkg__version">{group.rules.length} rule{group.rules.length === 1 ? '' : 's'}</span>
          </header>
          <div className="rule-cards">
            {group.rules.map((id) => <RuleCard key={id} id={id} />)}
          </div>
        </article>
      ))}
    </section>
  )
}

function PackageSections({ packages }) {
  if (!packages.length) return null
  return (
    <section className="detail__section">
      <h2>Packages over threshold ({packages.length})</h2>
      <p className="detail__explain">{ENTRY_TYPES.over_threshold}</p>
      {packages.map((pkg) => (
        <article className="pkg" key={pkg.package}>
          <header className="pkg__head">
            <a className="pkg__name" href={AUR_PACKAGE(pkg.package)} target="_blank" rel="noreferrer">{pkg.package}</a>
            {pkg.version ? <span className="pkg__version">{pkg.version}</span> : null}
            {pkg.score !== undefined && pkg.score !== null ? <span className="badge badge--alerts">score {pkg.score}</span> : null}
          </header>
          {pkg.last_modified ? <p className="pkg__meta">AUR change: {pkg.last_modified}</p> : null}
          <div className="rule-cards">
            {(pkg.rules || []).length
              ? pkg.rules.map((id) => <RuleCard key={id} id={id} />)
              : <p className="pkg__meta">No named rule in this entry.</p>}
          </div>
        </article>
      ))}
    </section>
  )
}

function IocSection({ matches }) {
  if (!matches.length) return null
  return (
    <section className="detail__section">
      <h2>Indicators of compromise ({matches.length})</h2>
      <p className="detail__explain">{ENTRY_TYPES.ioc}</p>
      <div className="ref-list">
        {matches.map((m, i) => (
          <span className="alert-item" key={`${m.package}-${i}`}>
            <a className="pkg__name" href={AUR_PACKAGE(m.package)} target="_blank" rel="noreferrer">{m.package}</a>
            {m.indicator ? <code className="chip">{m.indicator}</code> : null}
          </span>
        ))}
      </div>
    </section>
  )
}

function Campaigns({ payload }) {
  const clusters = payload.campaign_cluster || []
  const impersonation = payload.impersonation || []
  if (!clusters.length && !impersonation.length) return null
  return (
    <section className="detail__section">
      <h2>Campaigns</h2>
      {impersonation.length ? <p className="detail__explain">{ENTRY_TYPES.impersonation}</p> : null}
      {impersonation.map((camp, i) => (
        <article className="pkg" key={`imp-${i}`}>
          <header className="pkg__head">
            <span className="badge badge--imp">impersonation</span>
            <span className="pkg__version">{camp.maintainer || 'one submitter'} · {camp.count} name-clones</span>
          </header>
          {camp.targets && camp.targets.length ? <p className="pkg__meta">Impersonates: {camp.targets.join(', ')}</p> : null}
          <div className="ref-list">{(camp.members || []).map((m) => <a className="chip" key={m} href={AUR_PACKAGE(m)} target="_blank" rel="noreferrer">{m}</a>)}</div>
        </article>
      ))}
      {clusters.length ? <p className="detail__explain">{ENTRY_TYPES.campaign_cluster}</p> : null}
      {clusters.map((cluster, i) => (
        <article className="pkg" key={`cluster-${i}`}>
          <header className="pkg__head">
            <span className="badge">cluster</span>
            <RuleChip id={cluster.rule_id} />
            <span className="pkg__version">{cluster.count} members</span>
          </header>
          <div className="ref-list">{(cluster.members || []).map((m) => <a className="chip" key={m} href={AUR_PACKAGE(m)} target="_blank" rel="noreferrer">{m}</a>)}</div>
        </article>
      ))}
    </section>
  )
}

export function Message({ slug }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [showJson, setShowJson] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    setData(null)
    setShowJson(false)
    fetch(`/api/messages/${slug}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Notification not found.' : `HTTP ${res.status}`)
        return res.json()
      })
      .then((json) => { if (live) setData(json) })
      .catch((err) => { if (live) setError(String(err && err.message ? err.message : err)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [slug])

  const payload = data ? data.payload : {}
  const alerts = payload.alerts || []
  const packages = payload.over_threshold || []
  const ioc = payload.ioc_matches || []
  const pretty = data ? JSON.stringify(payload, null, 2) : ''

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

        {loading ? <p className="feed-empty">Loading…</p> : null}
        {error ? <p className="feed-error">{error}</p> : null}

        {data ? (
          <>
            <h1>{data.headline || data.title || '(untitled notification)'}</h1>
            <div className="detail__meta">
              <span>{formatUtc(data.time)}</span>
              <span>{relative(data.time)}</span>
              <span className={eventBadgeClass(data.event)}>{eventLabel(data.event)}</span>
              {data.day ? <span>day {data.day}</span> : null}
              <a href={NTFY} target="_blank" rel="noreferrer">ntfy channel ↗</a>
            </div>

            {payload.cycle ? (
              <div className="detail__meta">
                <span>cycle: {payload.cycle.added} added · {payload.cycle.changed} changed · {payload.cycle.removed} removed · {payload.cycle.processed} processed</span>
              </div>
            ) : null}

            <AlertList alerts={alerts} />
            <PackageSections packages={packages} />
            <IocSection matches={ioc} />
            <Campaigns payload={payload} />

            {!alerts.length && !packages.length && !ioc.length && !(payload.campaign_cluster || []).length && !(payload.impersonation || []).length ? (
              <p className="feed-empty">This document carries no alerts, packages, indicators or campaigns.</p>
            ) : null}

            <section className="detail__section">
              <h2>Full document</h2>
              <button
                type="button"
                className="load-more"
                aria-expanded={showJson}
                aria-controls="full-json"
                onClick={() => setShowJson((v) => !v)}
              >
                {showJson ? 'Hide JSON' : 'Show JSON'}
              </button>
              {showJson ? <div className="json" id="full-json"><RuleHighlight text={pretty} /></div> : null}
              <p className="masthead-note">
                This document is static-analysis evidence, not proof of safety and not permission to
                build. TrustSight never runs the PKGBUILD it reviews. See the{' '}
                <a href={SECURITY} target="_blank" rel="noreferrer">security model</a>.
              </p>
            </section>
          </>
        ) : null}
      </main>
    </div>
  )
}
