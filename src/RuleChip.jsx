import catalog from './rule-catalog.generated.json'

export const DOCS_RULES = 'https://docs.trustsight.org/reference/rules/'
const MAX_DESC = 240

const SEVERITY_CLASS = {
  FATAL: 'sev--fatal',
  CRITICAL: 'sev--critical',
  HIGH: 'sev--high',
  MEDIUM: 'sev--medium',
  LOW: 'sev--low',
  INFO: 'sev--info',
}

export function severityClass(severity) {
  return SEVERITY_CLASS[String(severity || '').toUpperCase()] || ''
}

/** Keep the hover box small: cap a long description at a readable length. */
export function shorten(text) {
  if (!text) return ''
  if (text.length <= MAX_DESC) return text
  return `${text.slice(0, MAX_DESC).trimEnd()}...`
}

export function ruleInfo(id) {
  const key = String(id || '').toLowerCase()
  return catalog[key] || null
}

/** True on touch phones and narrow screens, where a floating box is wrong. */
function isCoarse() {
  if (typeof window === 'undefined') return false
  const touch = window.matchMedia && window.matchMedia('(hover: none)').matches
  return Boolean(touch) || window.innerWidth <= 720
}

/**
 * A rule id that explains itself. On a mouse it shows a small popover on
 * hover or focus; on a touch screen (or a narrow viewport) it opens a modal
 * instead, so the explanation never floats off a phone screen. The chip is a
 * span, not a link, so the docs link can live inside without nesting anchors.
 */
export function RuleChip({ id }) {
  const rule = ruleInfo(id)
  const sev = rule && rule.severity ? rule.severity.toUpperCase() : ''

  function activate(event) {
    if (!isCoarse()) return
    event.preventDefault()
    event.stopPropagation()
    window.dispatchEvent(new CustomEvent('ts-rule-open', { detail: { id } }))
  }

  return (
    <span
      className="rule-chip"
      tabIndex="0"
      role="button"
      onClick={activate}
      aria-label={`Rule ${id}${rule ? `: ${rule.name}` : ''}. Open the explanation.`}
    >
      {id}
      <span className="rule-pop" role="tooltip">
        {rule ? (
          <>
            <span className="rule-pop__head">
              <strong>{rule.name}</strong>
              {sev ? <span className={`sev ${severityClass(sev)}`}>{sev}</span> : null}
            </span>
            <span className="rule-pop__cat">{rule.categoryTitle}</span>
            {rule.description ? <span className="rule-pop__desc">{shorten(rule.description)}</span> : null}
            <a className="rule-pop__link" href={rule.docsUrl} target="_blank" rel="noreferrer">
              rules reference ↗
            </a>
          </>
        ) : (
          <>
            <span className="rule-pop__desc">
              Rule <code>{id}</code> is not in this catalog. It may be reserved or added since the
              catalog was generated.
            </span>
            <a className="rule-pop__link" href={DOCS_RULES} target="_blank" rel="noreferrer">
              rules reference ↗
            </a>
          </>
        )}
      </span>
    </span>
  )
}

const RULE_RE = /\b([A-Z]\d{3})\b/g

/** Wrap every rule id in a JSON string with an explanation chip, preserving layout. */
export function RuleHighlight({ text }) {
  const out = []
  let last = 0
  let match
  RULE_RE.lastIndex = 0
  while ((match = RULE_RE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    out.push(<RuleChip key={`${match.index}-${match[1]}`} id={match[1]} />)
    last = match.index + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
