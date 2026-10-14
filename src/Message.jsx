import { useEffect, useState } from 'preact/hooks'
import { AccessibilityMenu, ThemeSwitch, Wordmark } from './Controls.jsx'
import { RuleCard, RuleChip, RuleHighlight, ruleInfo } from './RuleChip.jsx'
import { AUR_PACKAGE, AUR_PKGBUILD, eventBadgeClass, eventLabel, formatTime, locationLabel, relative } from './util.js'

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

// What each campaign kind means, in one line, so a reader knows the shape
// before scanning the member list.  G005 (impersonation) has its own section.
const CAMPAIGN_TYPES = {
  G001: { label: 'Shared gained host', means: 'Unrelated packages all added the same new host in one window: the signature of a coordinated redirect through a shared endpoint.' },
  G002: { label: 'Shared added literal', means: 'The same large code blob was added to unrelated packages in one window: one payload reused across many recipes.' },
  G003: { label: 'Coordinated adoption', means: 'One account adopted several packages at once, a burst that can precede a mass rewrite.' },
  G004: { label: 'Shared upstream dependency', means: 'Unrelated packages gained the same new upstream dependency and host in one window.' },
  G006: { label: 'Neighborhood under campaign alert', means: 'A package gained a host already in an active campaign scope. Context, never scored.' },
  G007: { label: 'Campaign corroboration', means: 'A package stood in the scope of an active campaign and earned a small corroboration bonus.' },
}

/** The human name and meaning for a campaign rule, from the map or the catalog. */
function campaignType(id) {
  if (CAMPAIGN_TYPES[id]) return CAMPAIGN_TYPES[id]
  const rule = ruleInfo(id)
  return rule
    ? { label: rule.name, means: rule.description }
    : { label: `Rule ${id}`, means: '' }
}

/** The affected packages of a campaign, each linked to its AUR page and PKGBUILD. */
function MemberList({ names }) {
  if (!names.length) return <p className="pkg__meta">No member packages named.</p>
  return (
    <ul className="campaign-members">
      {names.map((name) => (
        <li key={name}>
          <a className="member__name" href={AUR_PACKAGE(name)} target="_blank" rel="noreferrer">{name}</a>
          <a className="member__pkgbuild" href={AUR_PKGBUILD(name)} target="_blank" rel="noreferrer" title={`PKGBUILD for ${name}`}>PKGBUILD ↗</a>
        </li>
      ))}
    </ul>
  )
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

/** Every finding the watcher sent, each with the file and line it fired on. */
function Findings({ findings }) {
  if (!findings || !findings.length) return null
  return (
    <ul className="findings">
      {findings.map((f, i) => {
        const loc = locationLabel(f)
        return (
          <li className="finding" key={`${f.rule_id}-${i}`}>
            <RuleChip id={f.rule_id} />
            {loc
              ? <code className="finding__loc">{loc}</code>
              : <span className="finding__loc finding__loc--none" title="This signal names a fact about the change, not a line">no line</span>}
            {f.reason ? <span className="finding__reason">{f.reason}</span> : null}
          </li>
        )
      })}
    </ul>
  )
}

function PackageSections({ packages }) {
  if (!packages.length) return null
  return (
    <section className="detail__section">
      <h2>Packages over threshold ({packages.length})</h2>
      <p className="detail__explain">{ENTRY_TYPES.over_threshold}</p>
      {packages.map((pkg) => {
        const findings = pkg.findings || []
        const rules = [...new Set(pkg.rules || [])]
        return (
          <article className="pkg" key={pkg.package}>
            <header className="pkg__head">
              <a className="pkg__name" href={AUR_PACKAGE(pkg.package)} target="_blank" rel="noreferrer">{pkg.package}</a>
              {pkg.version ? <span className="pkg__version">{pkg.version}</span> : null}
              {pkg.score !== undefined && pkg.score !== null ? <span className="badge badge--alerts">score {pkg.score}</span> : null}
              <a className="pkg__action" href={AUR_PKGBUILD(pkg.package)} target="_blank" rel="noreferrer">See PKGBUILD ↗</a>
            </header>
            {pkg.last_modified ? <p className="pkg__meta">AUR change: {pkg.last_modified}</p> : null}
            {findings.length ? (
              <>
                <p className="pkg__meta">What fired, and the line that triggered it:</p>
                <Findings findings={findings} />
              </>
            ) : (
              <p className="pkg__meta">No located findings in this entry.</p>
            )}
            <div className="rule-cards">
              {rules.length
                ? rules.map((id) => <RuleCard key={id} id={id} />)
                : <p className="pkg__meta">No named rule in this entry.</p>}
            </div>
          </article>
        )
      })}
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
  const total = clusters.length + impersonation.length
  return (
    <section className="detail__section">
      <h2>Campaigns ({total})</h2>
      <p className="detail__explain">{ENTRY_TYPES.campaign_cluster}</p>
      {impersonation.map((camp, i) => {
        const members = camp.members || []
        return (
          <article className="pkg campaign" key={`imp-${i}`}>
            <header className="pkg__head">
              <span className="badge badge--imp">impersonation campaign</span>
              <span className="pkg__version">{camp.maintainer || 'one submitter'} · {camp.count} name-clones</span>
            </header>
            <p className="detail__explain">{ENTRY_TYPES.impersonation}</p>
            {camp.targets && camp.targets.length
              ? <p className="pkg__meta">Impersonates: {camp.targets.join(', ')}</p>
              : null}
            <h3 className="campaign__subhead">Affected packages ({members.length})</h3>
            <MemberList names={members} />
          </article>
        )
      })}
      {clusters.map((cluster, i) => {
        const type = campaignType(cluster.rule_id)
        const members = cluster.members || []
        return (
          <article className="pkg campaign" key={`cluster-${i}`}>
            <header className="pkg__head">
              <span className="badge">campaign</span>
              <RuleChip id={cluster.rule_id} />
              <span className="pkg__version">{type.label} · {members.length} packages</span>
            </header>
            {type.means ? <p className="detail__explain">{type.means}</p> : null}
            <h3 className="campaign__subhead">Affected packages ({members.length})</h3>
            <MemberList names={members} />
          </article>
        )
      })}
    </section>
  )
}

export function Message({ slug }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [showJson, setShowJson] = useState(false)
  const [copied, setCopied] = useState(false)

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

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(pretty)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

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
              <span title="Your local time with its offset, then UTC">{formatTime(data.time)}</span>
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
              <div className="json-actions">
                <button
                  type="button"
                  className="load-more"
                  aria-expanded={showJson}
                  aria-controls="full-json"
                  onClick={() => setShowJson((v) => !v)}
                >
                  {showJson ? 'Hide JSON' : 'Show JSON'}
                </button>
                <button
                  type="button"
                  className="load-more"
                  onClick={copyJson}
                  aria-label="Copy the full JSON document to the clipboard"
                >
                  {copied ? 'Copied ✓' : 'Copy JSON'}
                </button>
              </div>
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
