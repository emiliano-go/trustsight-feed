import { useEffect, useState } from 'preact/hooks'
import { apiUrl } from './api.js'
import { RuleChip } from './RuleChip.jsx'
import { flattenProse, formatTime, relative } from './util.js'

const STORAGE_KEY = 'trustsight.show-anergic'

/** The operator's report-only preference, shared by every page. */
export function useAnergic() {
  const [on, setOn] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    const sync = () => {
      try { setOn(localStorage.getItem(STORAGE_KEY) === '1') } catch { setOn(false) }
    }
    window.addEventListener('storage', sync)
    window.addEventListener('trustsight:anergic', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('trustsight:anergic', sync)
    }
  }, [])
  const toggle = () => {
    const next = !on
    setOn(next)
    try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0') } catch { /* storage is optional */ }
    window.dispatchEvent(new Event('trustsight:anergic'))
  }
  return [on, toggle]
}

export function AnergicToggle({ on, onChange }) {
  return (
    <button
      type="button"
      className={`filter anergic-toggle${on ? ' is-on' : ''}`}
      aria-pressed={on}
      onClick={onChange}
      title="Show report-only findings that never change a score"
    >
      {on ? 'Hide anergic' : 'Show anergic'}
    </button>
  )
}

/** Anergic findings from the all-scan stream, never from the alert path. */
export function AnergicObservations({ packageName = '', rule = '', limit = 25 }) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setItems(null)
    setError('')
    const params = new URLSearchParams({ limit: String(limit) })
    if (packageName) params.set('package', packageName)
    if (rule) params.set('rule', rule)
    fetch(apiUrl(`/api/observations?${params}`))
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((body) => { if (alive) setItems(body.items || []) })
      .catch((err) => { if (alive) setError(String(err && err.message ? err.message : err)) })
    return () => { alive = false }
  }, [packageName, rule, limit])

  return (
    <section className="detail__section anergic-section" aria-labelledby="anergic-heading">
      <h2 id="anergic-heading">Anergic observations</h2>
      <p className="detail__explain">
        Report-only findings from the all-scan stream. They carry weight 0 and never change a
        score, so this list is the calibration view, not the alert view.
      </p>
      {error ? <p className="feed-error">Could not load anergic observations ({error}).</p> : null}
      {items && !items.length ? <p className="feed-empty">No anergic findings in this window.</p> : null}
      {items && items.length ? (
        <ul className="anergic-list">
          {items.map((item) => (
            <li className="anergic-item" key={`${item.cycle_id}-${item.package}-${item.rule_id}`}>
              <div className="anergic-item__head">
                <a className="chip" href={`/pkg/${encodeURIComponent(item.package)}`} data-route>{item.package}</a>
                <RuleChip id={item.rule_id} />
                <span className="pkg__meta" title={formatTime(item.time)}>{relative(item.time)}</span>
              </div>
              <p className="pkg__meta">
                {flattenProse(item.severity || 'finding')} at weight {item.weight || 0}
                {item.score === null || item.score === undefined ? '' : ` · package score ${item.score}`}
                {item.risk ? ` · ${flattenProse(item.risk)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
