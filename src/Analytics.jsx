import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { compactNumber, percent, seriesFromRows } from './analytics.js'
import './analytics.css'

const WINDOWS = [
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
]

async function getJson(path) {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
  return response.json()
}

function Stat({ label, value, note }) {
  return (
    <div className="analytic-stat">
      <span>{label}</span>
      <b>{value}</b>
      {note ? <small>{note}</small> : null}
    </div>
  )
}

function Channel({ title, children }) {
  return (
    <section className="analytic-panel">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function UplotChart({ rows, field, label }) {
  const ref = useRef(null)
  const data = useMemo(() => seriesFromRows(rows, field), [rows, field])
  useEffect(() => {
    if (!ref.current || !data.length) return undefined
    const chart = new uPlot({
      width: ref.current.clientWidth || 720,
      height: 260,
      legend: { show: false },
      scales: { x: { time: true } },
      axes: [
        { stroke: '#8b8b8b', grid: { stroke: '#2d2d2d' } },
        { stroke: '#8b8b8b', grid: { stroke: '#2d2d2d' } },
      ],
      series: [
        {},
        { label, stroke: '#d98e5c', width: 2, fill: 'rgba(217,142,92,.12)' },
      ],
    }, [data.map(([time]) => time), data.map(([, value]) => value)], ref.current)
    const resize = () => chart.setSize({ width: ref.current.clientWidth || 720, height: 260 })
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      chart.destroy()
    }
  }, [data, label])
  if (!data.length) return <p className="analytic-empty">No data in this window.</p>
  return <div className="analytic-chart" ref={ref} />
}

function BarList({ rows, total }) {
  if (!rows.length) return <p className="analytic-empty">No alerts in this window.</p>
  return (
    <ul className="analytic-bars">
      {rows.map((row) => (
        <li key={row.key}>
          <span>{row.key || 'unknown'}</span>
          <i style={{ width: `${Math.max(2, percent(row.count, total))}%` }} />
          <b>{compactNumber(row.count)}</b>
        </li>
      ))}
    </ul>
  )
}

export function Analytics() {
  const [windowName, setWindowName] = useState('7d')
  const [summary, setSummary] = useState(null)
  const [series, setSeries] = useState([])
  const [rules, setRules] = useState([])
  const [scans, setScans] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    setError('')
    Promise.all([
      getJson(`/api/analytics/summary?window=${windowName}`),
      getJson(`/api/analytics/timeseries?window=${windowName}&bucket=day`),
      getJson(`/api/analytics/breakdown?window=${windowName}&dimension=rule`),
      getJson(`/api/scan-stats?window=${windowName}`).catch(() => null),
    ]).then(([nextSummary, nextSeries, nextRules, nextScans]) => {
      if (!live) return
      setSummary(nextSummary)
      setSeries(nextSeries.rows || [])
      setRules(nextRules.rows || [])
      setScans(nextScans)
    }).catch((exc) => live && setError(String(exc.message || exc)))
    return () => { live = false }
  }, [windowName])

  const totals = summary?.totals || {}
  const scanTotals = scans?.totals || {}
  const hasScans = Number(scanTotals.attempted || 0) > 0
  const totalRules = rules.reduce((sum, row) => sum + Number(row.count || 0), 0)
  const scanRules = (scans?.rules || []).map((row) => ({ key: row.rule_id, count: row.count }))

  return (
    <main className="analytics">
      <header className="analytics-head">
        <div>
          <a className="back-link" href="/" data-route>← all alerts</a>
          <h1>Watcher analytics</h1>
          <p>
            What the watcher examined, what changed and what was detected.
            {hasScans ? ' Package analysis counts are live.' : ' All-scan data is not deployed yet; these figures are alert-derived.'}
          </p>
        </div>
        <div className="analytics-window" role="group" aria-label="Time window">
          {WINDOWS.map(([value, label]) => (
            <button key={value} type="button" className={value === windowName ? 'is-active' : ''} onClick={() => setWindowName(value)}>{label}</button>
          ))}
        </div>
      </header>

      {error ? <p className="feed-error">Couldn’t load analytics ({error}).</p> : null}

      <section className="analytic-stats">
        <Stat label="Notifications" value={compactNumber(totals.notifications)} note="alert and heartbeat documents" />
        <Stat label="Alerts" value={compactNumber(totals.alerts)} note="notification documents with alerts" />
        <Stat label="Reported processed" value={compactNumber(totals.processed)} note="cycle.processed, reported by the watcher" />
        <Stat label="Added / changed" value={`${compactNumber(totals.added)} / ${compactNumber(totals.changed)}`} note="metadata delta" />
        <Stat label="Over threshold" value={compactNumber(totals.over_threshold)} note="packages in an alert document" />
        {hasScans ? <Stat label="Package analyses" value={compactNumber(scanTotals.attempted)} note={`${compactNumber(scanTotals.succeeded)} succeeded`} /> : null}
      </section>

      <div className="analytic-grid">
        <Channel title="Activity">
          <UplotChart rows={series} field="processed" label="reported processed" />
          <p className="analytic-note">Phase 1 uses the watcher’s reported cycle counts. Clean package scans appear after the scan stream is deployed.</p>
        </Channel>
        <Channel title="Detections">
          <BarList rows={rules} total={totalRules} />
        </Channel>
      </div>

      {hasScans ? (
        <div className="analytic-grid">
          <Channel title="All-scan rule frequency">
            <BarList rows={scanRules} total={scanTotals.attempted || 0} />
          </Channel>
          <Channel title="All-scan health">
            <dl className="analytic-facts">
              <div><dt>Attempted</dt><dd>{compactNumber(scanTotals.attempted)}</dd></div>
              <div><dt>Succeeded</dt><dd>{compactNumber(scanTotals.succeeded)}</dd></div>
              <div><dt>Failures</dt><dd>{compactNumber(scanTotals.failure)}</dd></div>
              <div><dt>With diff</dt><dd>{compactNumber(scanTotals.with_diff)}</dd></div>
            </dl>
          </Channel>
        </div>
      ) : null}

      <div className="analytic-grid">
        <Channel title="Health">
          <dl className="analytic-facts">
            <div><dt>Last notification</dt><dd>{summary?.last ? new Date(summary.last * 1000).toLocaleString() : 'none'}</dd></div>
            <div><dt>Window</dt><dd>{summary?.window || windowName}</dd></div>
            <div><dt>Source</dt><dd>{hasScans ? 'all scans + alerts' : 'alerts and heartbeats only'}</dd></div>
            <div><dt>Raw scan retention</dt><dd>{scans?.raw_since ? new Date(scans.raw_since * 1000).toLocaleDateString() : 'n/a'}</dd></div>
          </dl>
        </Channel>
        <Channel title="What this page does not show">
          <p className="analytic-note">
            Phase 1 has no clean-scan denominator: the feed only sees alert and heartbeat documents.
            Once <code>trustsight.scans</code> is live, this page switches the workload charts to
            package analyses and keeps alerts as a separate series.
          </p>
        </Channel>
      </div>
    </main>
  )
}
