import { useEffect, useState } from 'preact/hooks'
import { AccessibilityMenu, ThemeSwitch, Wordmark } from './Controls.jsx'
import { RuleChip } from './RuleChip.jsx'
import { formatTime, relative } from './util.js'
import { packageHref } from './Message.jsx'

export function Maintainer({ name }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    fetch(`/api/maintainer/${encodeURIComponent(name)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 400 ? 'Invalid maintainer name.' : `HTTP ${res.status}`)
        return res.json()
      })
      .then((body) => { if (live) setData(body) })
      .catch((err) => { if (live) setError(String(err && err.message ? err.message : err)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [name])

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
        {loading ? <p className="feed-empty">Loading maintainer…</p> : null}
        {error ? <p className="feed-error">{error}</p> : null}
        {data ? (
          <>
            <h1>{data.maintainer}</h1>
            <div className="detail__meta">
              <a href={`https://aur.archlinux.org/account/${encodeURIComponent(data.maintainer)}`} target="_blank" rel="noreferrer">AUR account ↗</a>
              {data.available ? <span>first seen {relative(data.first)}</span> : null}
              {data.available ? <span>last seen {relative(data.last)}</span> : null}
            </div>
            {!data.available ? <p className="feed-empty">No stored alert names this maintainer.</p> : null}
            {data.available ? (
              <>
                <section className="detail__section">
                  <h2>Packages <span className="count">{data.packages.length}</span></h2>
                  <ul className="history-list">
                    {data.packages.map((pkg) => (
                      <li className="history-row" key={pkg.package}>
                        <a className="history-row__main" href={packageHref(pkg.package)} data-route>{pkg.package}</a>
                        {pkg.previous_maintainer ? <span className="history-row__time">was {pkg.previous_maintainer}</span> : null}
                        <span className="history-row__time">last {relative(pkg.last)}</span>
                        {pkg.rule_ids.map((rule) => <RuleChip key={`${pkg.package}-${rule}`} id={rule} />)}
                      </li>
                    ))}
                  </ul>
                </section>
                <section className="detail__section">
                  <h2>Ownership timeline <span className="count">{data.transitions.length}</span></h2>
                  <ul className="history-list">
                    {data.transitions.map((row, i) => (
                      <li className="history-row" key={`${row.slug}-${row.package}-${i}`}>
                        <RuleChip id={row.rule_id} />
                        <a className="history-row__main" href={packageHref(row.package)} data-route>{row.package}</a>
                        <span className="history-row__time">
                          {row.previous_maintainer ? `${row.previous_maintainer} -> ` : ''}{data.maintainer}
                        </span>
                        <a className="history-row__time" href={`/${row.slug}/`} data-route>{relative(row.time)}</a>
                      </li>
                    ))}
                  </ul>
                </section>
                {data.campaigns.length ? (
                  <section className="detail__section">
                    <h2>Campaigns <span className="count">{data.campaigns.length}</span></h2>
                    <ul className="history-list">
                      {data.campaigns.map((id) => (
                        <li className="history-row" key={id}>
                          <a className="history-row__main" href={`/campaign/${encodeURIComponent(id)}`} data-route>{id}</a>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {data.ioc_packages.length ? (
                  <section className="detail__section detail__section--ioc">
                    <h2>IOC packages <span className="count">{data.ioc_packages.length}</span></h2>
                    <p className="pkg__meta">{data.ioc_packages.join(', ')}</p>
                  </section>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  )
}
