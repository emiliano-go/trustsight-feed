import { useEffect, useState } from 'preact/hooks'
import { AccessibilityMenu, ThemeSwitch, Wordmark } from './Controls.jsx'
import { RuleChip } from './RuleChip.jsx'
import { campaignCommon } from '../worker/lib.js'
import { AUR_PACKAGE, formatTime, relative } from './util.js'
import { packageHref } from './Message.jsx'

function MessageLink({ slug, children }) {
  return <a href={`/${slug}/`} data-route>{children}</a>
}

export function Campaign({ id }) {
  const [campaign, setCampaign] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    fetch(`/api/campaign/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Campaign not found.' : `HTTP ${res.status}`)
        return res.json()
      })
      .then((body) => { if (live) setCampaign(body) })
      .catch((err) => { if (live) setError(String(err && err.message ? err.message : err)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [id])

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
        {loading ? <p className="feed-empty">Loading campaign…</p> : null}
        {error ? <p className="feed-error">{error}</p> : null}
        {campaign ? (
          <>
            <div className="detail__meta">
              <RuleChip id={campaign.rule_id} />
              {campaign.legacy ? <span className="badge">legacy id</span> : null}
              <span>{campaign.members.length} package{campaign.members.length === 1 ? '' : 's'}</span>
              <span>first seen {relative(campaign.first)}</span>
              <span>last seen {relative(campaign.last)}</span>
            </div>
            <h1>Campaign {campaign.id}</h1>
            {(() => {
              const common = campaignCommon(campaign)
              return common ? (
                <p className="pkg__meta campaign__common">
                  {common.label}: <code className="md-code">{common.value}</code>
                </p>
              ) : null
            })()}
            <p className="detail__explain">
              A campaign is packages changing together in one window. Membership is evidence,
              not a verdict; read each package&rsquo;s alert before acting.
            </p>

            <section className="detail__section">
              <h2>Members <span className="count">{campaign.members.length}</span></h2>
              <ul className="history-list">
                {campaign.members.map((member) => (
                  <li className="history-row" key={member.package}>
                    <a className="history-row__main" href={packageHref(member.package)} data-route>{member.package}</a>
                    {member.maintainer ? (
                      <span className="history-row__time">
                        maintainer {member.previous_maintainer && member.previous_maintainer !== member.maintainer
                          ? `${member.previous_maintainer} -> ${member.maintainer}`
                          : member.maintainer}
                      </span>
                    ) : null}
                    {member.version ? <span className="history-row__time">{member.version}</span> : null}
                    <a className="history-row__time" href={`https://aur.archlinux.org/packages/${encodeURIComponent(member.package)}`} target="_blank" rel="noreferrer">AUR ↗</a>
                  </li>
                ))}
              </ul>
            </section>

            <section className="detail__section">
              <h2>Timeline <span className="count">{campaign.timeline.length}</span></h2>
              <ul className="history-list">
                {campaign.timeline.map((event) => (
                  <li className="history-row" key={event.slug}>
                    <span className="history-row__time" title={formatTime(event.time)}>{relative(event.time)}</span>
                    <span className="history-row__main">
                      {event.packages.map((name, i) => (
                        <span key={name}>
                          {i ? ', ' : ''}
                          <a href={packageHref(name)} data-route>{name}</a>
                        </span>
                      ))}
                    </span>
                    {event.ownership.length ? (
                      <span className="history-row__time">
                        {event.ownership.map((owner, i) => (
                          <span key={`${owner.package}-${i}`}>
                            {i ? '; ' : ''}{owner.package}: {owner.previous_maintainer || 'orphan'} -&gt; {owner.maintainer || 'orphan'}
                          </span>
                        ))}
                      </span>
                    ) : null}
                    <MessageLink slug={event.slug}>Open alert ↗</MessageLink>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
      </main>
    </div>
  )
}
