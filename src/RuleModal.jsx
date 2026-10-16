import { useEffect, useRef, useState } from 'preact/hooks'
import { DOCS_RULES, ruleInfo, severityClass } from './RuleChip.jsx'
import { renderMarkdown } from './markdown.jsx'

/**
 * The mobile rule explanation. Mounted once by the router and opened by a
 * `ts-rule-open` event from any chip on a touch or narrow screen. It is a
 * bottom-sheet modal: never a floating box, always tappable, with a close
 * button, Escape and a backdrop tap to dismiss.
 */
export function RuleModal() {
  const [id, setId] = useState(null)
  const closeRef = useRef(null)

  useEffect(() => {
    const onOpen = (event) => setId(event.detail && event.detail.id ? event.detail.id : null)
    window.addEventListener('ts-rule-open', onOpen)
    return () => window.removeEventListener('ts-rule-open', onOpen)
  }, [])

  useEffect(() => {
    if (!id) return undefined
    const onKey = (event) => { if (event.key === 'Escape') setId(null) }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    if (closeRef.current) closeRef.current.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [id])

  if (!id) return null

  const rule = ruleInfo(id)
  const sev = rule && rule.severity ? rule.severity.toUpperCase() : ''

  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Rule ${id}`}
      onClick={(event) => { if (event.target === event.currentTarget) setId(null) }}
    >
      <div className="modal__panel">
        <div className="modal__head">
          <span className="rule-chip">{id}</span>
          <button ref={closeRef} className="modal__close" type="button" onClick={() => setId(null)} aria-label="Close rule explanation">Close</button>
        </div>
        {rule ? (
          <>
            <h2 className="modal__title">{rule.name}</h2>
            <div className="modal__meta">
              {sev ? <span className={`sev ${severityClass(sev)}`}>{sev}</span> : null}
            </div>
            <p className="modal__desc">{rule.description ? renderMarkdown(rule.description, rule.docsUrl) : 'This rule has no published description.'}</p>
            <a className="modal__link" href={rule.docsUrl} target="_blank" rel="noreferrer">Open in the rules reference ↗</a>
          </>
        ) : (
          <>
            <h2 className="modal__title">Rule {id}</h2>
            <p className="modal__desc">This rule is not in the catalog. It may be reserved or added since the catalog was generated.</p>
            <a className="modal__link" href={DOCS_RULES} target="_blank" rel="noreferrer">Open the rules reference ↗</a>
          </>
        )}
      </div>
    </div>
  )
}
