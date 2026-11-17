import { useEffect, useState } from 'preact/hooks'

function depthLabel(value) {
  return value === -1 ? 'Full closure' : `${value} level${value === 1 ? '' : 's'}`
}

/**
 * A compact dependency-walk card for alert pages.  The package page owns the
 * full history view; an alert needs the latest scan's bounded summary beside
 * the finding it just showed.
 */
export function DependencySummary({ name }) {
  const [scan, setScan] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    setScan(null)
    setError('')
    fetch(`/api/scans?package=${encodeURIComponent(name)}&limit=1`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((body) => { if (live) setScan((body.items || [])[0] || null) })
      .catch((err) => { if (live) setError(String(err && err.message ? err.message : err)) })
    return () => { live = false }
  }, [name])

  if (error || !scan || !scan.dependency_analysis) return null
  const deps = scan.dependency_analysis
  return (
    <section className="dep-summary" aria-label={`Dependency analysis for ${name}`}>
      <header className="dep-summary__head">
        <h3>Dependency analysis</h3>
        <span className="badge badge--version">{depthLabel(deps.requested_depth)}</span>
        {deps.truncated ? <span className="badge badge--warn">truncated</span> : null}
      </header>
      <div className="context__cards">
        <div className="context__card">
          <span className="context__title">Examined</span>
          <span className="context__value">{deps.examined}</span>
        </div>
        <div className="context__card">
          <span className="context__title">Deepest level</span>
          <span className="context__value">{deps.maximum_depth_reached}</span>
        </div>
        <div className={`context__card${deps.flagged_count ? ' context__card--add' : ''}`}>
          <span className="context__title">Independently flagged</span>
          <span className="context__value">{deps.flagged_count}</span>
        </div>
        <div className="context__card">
          <span className="context__title">Unreadable</span>
          <span className="context__value">{deps.failed_count}</span>
        </div>
      </div>
      {deps.flagged.length ? (
        <ul className="history-list dep-summary__list">
          {deps.flagged.map((dep) => (
            <li className="history-row" key={`${dep.depth}-${dep.name}`}>
              <span className="badge badge--version">L{dep.depth}</span>
              <a className="history-row__main" href={`/deps/${encodeURIComponent(dep.name)}`} data-route>{dep.name}</a>
              <span className="history-row__time">
                score {dep.score} · {dep.risk || 'unknown'}
                {dep.finding_count ? ` · ${dep.finding_count} finding${dep.finding_count === 1 ? '' : 's'}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pkg__meta">No dependency cleared the review threshold on its own.</p>
      )}
      {deps.failed.length ? (
        <>
          <p className="pkg__meta">Dependencies that could not be read:</p>
          <ul className="history-list dep-summary__list">
            {deps.failed.map((dep) => (
              <li className="history-row" key={`failed-${dep.depth}-${dep.name}`}>
                <span className="badge badge--failed">not vetted</span>
                <a className="history-row__main" href={`/deps/${encodeURIComponent(dep.name)}`} data-route>{dep.name}</a>
                <span className="history-row__time">L{dep.depth}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="pkg__meta dep-summary__foot">
        From the latest stored scan. Dependency flags do not add to {name}'s score.
      </p>
    </section>
  )
}
