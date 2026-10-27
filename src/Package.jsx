import { useEffect, useState } from 'preact/hooks'
import { AccessibilityMenu, ThemeSwitch, Wordmark } from './Controls.jsx'
import { ChangeViews, LimitsNote, diffValues, parsePkgbuild, sourceUrlsFromDiff } from './Message.jsx'
import { RuleChip } from './RuleChip.jsx'
import { AUR_PACKAGE, AUR_PKGBUILD, eventBadgeClass, eventLabel, flattenProse, formatTime, relative } from './util.js'

const FP_DOCS = 'https://docs.trustsight.org/guides/tuning-false-positives/'
const FP_ISSUE = 'https://github.com/emiliano-go/trustsight/issues/new?template=false_positive.yml'

function fpIssueUrl(name) {
  const title = encodeURIComponent(`[False positive]: ${name}`)
  return `${FP_ISSUE}&title=${title}`
}

/** Every stored alert that names one package, and everything they record about it. */
export function Package({ name }) {
  const [history, setHistory] = useState(null)
  const [error, setError] = useState('')
  const [live, setLive] = useState({
    maintainer: '', url: '', sources: [],
    maintainerRemoved: [], maintainerAdded: [],
    upstreamRemoved: [], upstreamAdded: [],
  })

  useEffect(() => {
    let alive = true
    setHistory(null)
    setError('')

    fetch(`/api/package/${encodeURIComponent(name)}/history`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((body) => { if (alive) setHistory(body) })
      .catch((err) => { if (alive) setError(String(err && err.message ? err.message : err)) })

    // The live AUR record is fetched beside the stored history: it is the only
    // source for the current maintainer, and the newest PKGBUILD/diff for the
    // current upstream. All three are cached by the Worker.
    Promise.all([
      fetch(`/api/maintainers?packages=${encodeURIComponent(name)}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch(`/api/source/${encodeURIComponent(name)}?file=PKGBUILD`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch(`/api/diff/${encodeURIComponent(name)}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]).then(([maint, src, diffBody]) => {
      if (!alive) return
      const parsed = parsePkgbuild(String(src.content || ''))
      const diff = String(diffBody.diff || '')
      const m = diffValues(diff, ['Maintainer'])
      const u = sourceUrlsFromDiff(diff)
      setLive({
        maintainer: (maint.maintainers || {})[name] || parsed.maintainer,
        url: parsed.url,
        sources: parsed.sources,
        maintainerRemoved: m.removed, maintainerAdded: m.added,
        upstreamRemoved: u.removed, upstreamAdded: u.added,
      })
    })

    return () => { alive = false }
  }, [name])

  const maxScore = history && history.max_score !== null && history.max_score !== undefined ? history.max_score : null
  const latest = history && history.timeline.length ? history.timeline[0] : null
  const currentUrls = [...new Set([live.url, ...live.sources].filter(Boolean))]
  const currentUrlSet = new Set(currentUrls)
  const pastByUrl = new Map()
  for (const u of history ? history.upstreams : []) {
    if (!currentUrlSet.has(u.url)) pastByUrl.set(u.url, u)
  }
  for (const url of live.upstreamRemoved) {
    if (!currentUrlSet.has(url) && !pastByUrl.has(url)) {
      pastByUrl.set(url, { url, rule_id: '', last_seen: null, reason: 'removed in the latest AUR change' })
    }
  }
  const pastUrls = [...pastByUrl.values()]
  const upstreamCount = currentUrls.length + pastUrls.length

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

        <h1>{name}</h1>
        <div className="detail__meta">
          <a href={AUR_PACKAGE(name)} target="_blank" rel="noreferrer">AUR package ↗</a>
          <a href={AUR_PKGBUILD(name)} target="_blank" rel="noreferrer">PKGBUILD ↗</a>
          <a href={`/deps/${encodeURIComponent(name)}`} data-route>Check dependencies</a>
          <button type="button" className="pkg__action" onClick={() => navigator.clipboard?.writeText(window.location.href)}>Copy permalink</button>
          {history && history.first ? <span title={formatTime(history.first)}>first seen {relative(history.first)}</span> : null}
          {history && history.last ? <span title={formatTime(history.last)}>last seen {relative(history.last)}</span> : null}
        </div>

        {error ? <p className="feed-error">Couldn&rsquo;t load this package&rsquo;s history ({error}).</p> : null}
        {!history && !error ? <p className="feed-empty">Loading package history…</p> : null}

        {history ? (
          <>
            <div className="masthead-stats detail__stats">
              <div><b>{history.count}</b>Analyses</div>
              {maxScore !== null ? <div className="stat--warn"><b>{maxScore}</b>Highest score</div> : null}
              <div><b>{history.rules.length}</b>Rules seen</div>
              <div><b>{upstreamCount}</b>Upstream URLs</div>
              {latest && latest.version ? <div><b>{latest.version}</b>Latest change</div> : null}
            </div>

            <p className="detail__explain">
              Scores are calibrated, but false-positive tuning is ongoing. If a rule fired with
              no bad practice or malicious behavior behind it,{' '}
              <a href={fpIssueUrl(name)} target="_blank" rel="noreferrer">report the bad rule trigger for {name}</a>.
              Read <a href={FP_DOCS} target="_blank" rel="noreferrer">the distinction</a>.
            </p>

            {!history.count ? (
              <p className="feed-empty">No stored alerts name {name}.</p>
            ) : null}

            <section className="detail__section">
              <h2>Current record</h2>
              <div className="context__cards">
                <article className="context__card">
                  <span className="context__title">Maintainer</span>
                  <span className="context__value">{live.maintainer || 'unknown'}</span>
                  {live.maintainerRemoved.length || live.maintainerAdded.length ? (
                    <div className="context__diff">
                      {live.maintainerRemoved.map((l, i) => <div className="context__diff-line context__diff-line--del" key={`mr${i}`}>- {l}</div>)}
                      {live.maintainerAdded.map((l, i) => <div className="context__diff-line context__diff-line--add" key={`ma${i}`}>+ {l}</div>)}
                    </div>
                  ) : null}
                </article>
                <article className="context__card">
                  <span className="context__title">Upstream</span>
                  {live.url
                    ? <a className="context__value" href={live.url} target="_blank" rel="noreferrer">{live.url}</a>
                    : <span className="context__value">unknown</span>}
                  {live.sources.length ? (
                    <ul className="context__list">
                      {live.sources.slice(0, 6).map((u) => <li key={u}><a href={u} target="_blank" rel="noreferrer">{u}</a></li>)}
                    </ul>
                  ) : null}
                </article>
                <article className="context__card">
                  <span className="context__title">Latest analysis</span>
                  {latest ? (
                    <>
                      <span className="context__value">{latest.version || 'no version transition recorded'}</span>
                      <span className="context__note">
                        <a href={`/${latest.slug}/`} data-route>{formatTime(latest.time)}</a>
                      </span>
                    </>
                  ) : <span className="context__value">none</span>}
                </article>
                {live.upstreamRemoved.length || live.upstreamAdded.length || live.maintainerRemoved.length || live.maintainerAdded.length ? (
                  <article className="context__card context__card--wide">
                    <span className="context__title">Latest AUR change</span>
                    <div className="context__diff">
                      {live.maintainerRemoved.map((l, i) => <div className="context__diff-line context__diff-line--del" key={`ur${i}`}>- {l}</div>)}
                      {live.maintainerAdded.map((l, i) => <div className="context__diff-line context__diff-line--add" key={`ua${i}`}>+ {l}</div>)}
                      {live.upstreamRemoved.map((l, i) => <div className="context__diff-line context__diff-line--del" key={`upr${i}`}>- {l}</div>)}
                      {live.upstreamAdded.map((l, i) => <div className="context__diff-line context__diff-line--add" key={`upa${i}`}>+ {l}</div>)}
                    </div>
                  </article>
                ) : null}
              </div>
            </section>

            <section className="detail__section">
              <h2>Maintainers <span className="count">{history.maintainers.length}</span></h2>
              {history.maintainers.length ? (
                <ul className="history-list">
                  {history.maintainers.map((m, i) => (
                    <li className="history-row" key={`${m.time}-${m.rule_id}-${i}`}>
                      <RuleChip id={m.rule_id} />
                      <span className="history-row__main">{flattenProse(m.reason || 'maintainer-change rule fired')}</span>
                      <a className="history-row__time" href={`/${m.slug}/`} data-route>{relative(m.time)}</a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pkg__meta">No maintainer-change signal is recorded in the stored alerts.</p>
              )}
            </section>

            <section className="detail__section">
              <h2>Upstreams <span className="count">{upstreamCount}</span></h2>
              {upstreamCount ? (
                <ul className="history-list">
                  {currentUrls.map((url) => (
                    <li className="history-row" key={url}>
                      <span className="badge badge--version">current</span>
                      <a className="history-row__url" href={url} target="_blank" rel="noreferrer">{url}</a>
                      <span className="history-row__time">declared in the PKGBUILD</span>
                    </li>
                  ))}
                  {pastUrls.map((u) => (
                    <li className="history-row" key={u.url}>
                      {u.rule_id ? <RuleChip id={u.rule_id} /> : <span className="badge">removed</span>}
                      <a className="history-row__url" href={u.url} target="_blank" rel="noreferrer">{u.url}</a>
                      <span className="history-row__time" title={u.reason}>
                        {u.last_seen ? `last seen ${relative(u.last_seen)}` : 'removed in the latest AUR change'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pkg__meta">No upstream URL is recorded for this package.</p>
              )}
              {!pastUrls.length && currentUrls.length ? (
                <p className="pkg__meta">No earlier upstream URL is recorded in the stored alerts.</p>
              ) : null}
            </section>

            <section className="detail__section">
              <h2>Rules seen <span className="count">{history.rules.length}</span></h2>
              <ul className="history-rules">
                {history.rules.map((r) => (
                  <li className="history-rule" key={r.id}>
                    <RuleChip id={r.id} />
                    <span className="history-rule__count">{r.count}×</span>
                    <span className="history-rule__last">last {relative(r.last_seen)}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="detail__section">
              <h2>Alert history <span className="count">{history.count}</span></h2>
              {history.timeline.map((item) => (
                <article className="pkg history-item" key={item.slug}>
                  <header className="pkg__head">
                    <a className="pkg__name" href={`/${item.slug}/`} data-route>{formatTime(item.time)}</a>
                    <span className={eventBadgeClass(item.event)}>{eventLabel(item.event)}</span>
                    {item.score !== null ? <span className="badge badge--alerts">score {item.score}</span> : null}
                    {item.version ? <span className="pkg__version">{item.version}</span> : null}
                    {item.last_modified ? <span className="pkg__meta">{item.last_modified}</span> : null}
                    {item.refusal ? <span className="badge">partial read</span> : null}
                    {item.ioc.length ? <span className="badge badge--ioc">IOC match</span> : null}
                    {item.impersonation.length ? <span className="badge badge--imp">impersonation</span> : null}
                    <a className="pkg__action" href={`/${item.slug}/`} data-route>Open alert ↗</a>
                  </header>
                  <h3 className="history-item__title">
                    <a href={`/${item.slug}/`} data-route>{flattenProse(item.headline)}</a>
                  </h3>
                  {item.ioc.length ? (
                    <p className="pkg__meta">Indicators: {item.ioc.map((indicator) => <code className="md-code" key={indicator}>{indicator}</code>)}</p>
                  ) : null}
                  {item.alerts.length ? <p className="pkg__meta">New alerts: {item.alerts.join(', ')}</p> : null}
                  {item.campaign_ids && item.campaign_ids.length ? (
                    <p className="pkg__meta">
                      Campaigns:{' '}
                      {item.campaign_ids.map((id, i) => (
                        <span key={id}>
                          {i ? ', ' : ''}
                          <a href={`/campaign/${encodeURIComponent(id)}`} data-route>{id}</a>
                        </span>
                      ))}
                    </p>
                  ) : item.campaigns.length ? (
                    <p className="pkg__meta">Campaigns: {item.campaigns.join(', ')}</p>
                  ) : null}
                  {item.rules.length ? (
                    <div className="feed-item__tags">
                      {item.rules.map((id) => <RuleChip key={`${item.slug}-${id}`} id={id} />)}
                    </div>
                  ) : null}
                  <ChangeViews
                    packageName={name}
                    findings={item.findings || []}
                    diff={item.diff || undefined}
                    diffSha={item.pkgbuild_sha256 || item.diff_sha256}
                    diffTruncated={item.diff_truncated}
                  />
                </article>
              ))}
            </section>
            <LimitsNote />
          </>
        ) : null}
      </main>
    </div>
  )
}
