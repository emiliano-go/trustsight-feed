import { useEffect, useState } from 'preact/hooks'
import { AccessibilityMenu, ThemeSwitch, Wordmark } from './Controls.jsx'

const METHOD_ORDER = ['get', 'post', 'put', 'delete']

function Parameters({ parameters }) {
  if (!parameters || !parameters.length) return null
  return (
    <div className="table-wrap">
      <table className="api-params">
      <thead>
        <tr><th scope="col">Parameter</th><th scope="col">In</th><th scope="col">Type</th><th scope="col">Description</th></tr>
      </thead>
      <tbody>
        {parameters.map((p) => (
          <tr key={`${p.in}-${p.name}`}>
            <th scope="row"><code>{p.name}</code>{p.required ? ' *' : ''}</th>
            <td>{p.in}</td>
            <td><code>{p.schema && p.schema.type ? p.schema.type : 'string'}</code></td>
            <td>{p.description || ''}{p.schema && p.schema.example !== undefined ? <span className="api-example"> e.g. {String(p.schema.example)}</span> : null}</td>
          </tr>
        ))}
      </tbody>
      </table>
    </div>
  )
}

function Endpoint({ path, method, operation }) {
  return (
    <article className="api-endpoint" id={`op-${operation.operationId || path.replace(/[^\w]+/g, '-')}`}>
      <header className="api-endpoint__head">
        <span className="api-method">{method.toUpperCase()}</span>
        <code className="api-path">{path}</code>
      </header>
      <h3 className="api-endpoint__title">{operation.summary}</h3>
      {operation.description ? <p className="api-endpoint__desc">{operation.description}</p> : null}
      <Parameters parameters={operation.parameters} />
      {path.includes('{') ? null : (
        <a className="api-try" href={`https://watcher.trustsight.org${path}`} target="_blank" rel="noreferrer">
          Open {path} ↗
        </a>
      )}
    </article>
  )
}

export function ApiDocs() {
  const [spec, setSpec] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/openapi.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(setSpec)
      .catch((err) => setError(String(err && err.message ? err.message : err)))
  }, [])

  const grouped = {}
  if (spec) {
    for (const [path, methods] of Object.entries(spec.paths || {})) {
      for (const method of METHOD_ORDER) {
        const operation = methods[method]
        if (!operation) continue
        const tag = (operation.tags && operation.tags[0]) || 'Other'
        if (!grouped[tag]) grouped[tag] = []
        grouped[tag].push({ path, method, operation })
      }
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

        {error ? <p className="feed-error">Could not load the specification: {error}</p> : null}

        {spec ? (
          <>
            <h1>API reference</h1>
            <p className="masthead-definition">{spec.info && spec.info.description}</p>
            <div className="detail__meta">
              <span>{spec.info && spec.info.title} v{spec.info && spec.info.version}</span>
              <span>{(spec.servers && spec.servers[0] && spec.servers[0].url) || ''}</span>
              <a href="/api/openapi.json" target="_blank" rel="noreferrer">openapi.json ↗</a>
            </div>

            <section className="detail__section">
              <h2>Rate limits</h2>
              <p className="detail__explain">
                120 requests a minute per client. Past the cap the API answers HTTP 429 and the
                Retry-After header says how long to wait. Every endpoint is read only and CORS open.
              </p>
            </section>

            {(spec.tags || []).map((tag) => grouped[tag.name] ? (
              <section className="detail__section" key={tag.name}>
                <h2>{tag.name}</h2>
                {tag.description ? <p className="detail__explain">{tag.description}</p> : null}
                {grouped[tag.name].map(({ path, method, operation }) => (
                  <Endpoint key={`${method}-${path}`} path={path} method={method} operation={operation} />
                ))}
              </section>
            ) : null)}

            <p className="masthead-note">
              This API serves the watcher&rsquo;s evidence. A notification means a rule matched a
              change under review; it is not proof of safety and not permission to install. See the{' '}
              <a href="https://docs.trustsight.org/security/" target="_blank" rel="noreferrer">security model</a>.
            </p>
          </>
        ) : null}
      </main>
    </div>
  )
}
