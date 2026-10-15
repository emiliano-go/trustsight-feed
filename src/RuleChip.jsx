import catalog from './rule-catalog.generated.json'
import { renderMarkdown } from './markdown.jsx'

export const DOCS_RULES = 'https://docs.trustsight.org/reference/rules/'

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

export function openRuleExplanation(id) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('ts-rule-open', { detail: { id } }))
}

function RuleBody({ id }) {
  const rule = ruleInfo(id)
  const sev = rule && rule.severity ? rule.severity.toUpperCase() : ''
  return (
    <span className="rule-pop__head">
      <strong>{rule ? rule.name : `Rule ${id}`}</strong>
      {sev ? <span className={`sev ${severityClass(sev)}`}>{sev}</span> : null}
    </span>
  )
}

/**
 * A rule id that explains itself. On a mouse it shows the full description in
 * a popover on hover or focus; on a touch screen (or a narrow viewport) it
 * opens a modal instead, so the explanation never floats off a phone screen.
 * The chip is a span, not a link, so the docs link can live inside without
 * nesting anchors.
 */
export function RuleChip({ id }) {
  const rule = ruleInfo(id)

  function activate(event) {
    if (!isCoarse()) return
    event.preventDefault()
    event.stopPropagation()
    openRuleExplanation(id)
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
        <RuleBody id={id} />
        {rule ? (
          <>
            <span className="rule-pop__cat">{rule.categoryTitle}</span>
            {rule.description ? <span className="rule-pop__desc">{renderMarkdown(rule.description, rule.docsUrl)}</span> : null}
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

/**
 * The full explanation as a card. On a wide pointer it shows the whole
 * description inline; on touch or a narrow viewport it collapses to a compact
 * card that opens the modal, so a phone never gets a wall of text.
 */
export function RuleCard({ id }) {
  const rule = ruleInfo(id)
  const sev = rule && rule.severity ? rule.severity.toUpperCase() : ''

  if (isCoarse()) {
    return (
      <button
        type="button"
        className="rule-card rule-card--compact"
        onClick={() => openRuleExplanation(id)}
        aria-label={`Rule ${id}${rule ? `: ${rule.name}` : ''}. Tap for the full explanation.`}
      >
        <span className="rule-card__head">
          <span className="rule-card__id">{id}</span>
          <span className="rule-card__name">{rule ? rule.name : 'Unknown rule'}</span>
          {sev ? <span className={`sev ${severityClass(sev)}`}>{sev}</span> : null}
        </span>
        <span className="rule-card__tap">Tap for the full explanation</span>
      </button>
    )
  }

  return (
    <article className="rule-card">
      <header className="rule-card__head">
        <span className="rule-card__id">{id}</span>
        <span className="rule-card__name">{rule ? rule.name : 'Unknown rule'}</span>
        {sev ? <span className={`sev ${severityClass(sev)}`}>{sev}</span> : null}
      </header>
      <p className="rule-card__desc">
        {rule && rule.description
          ? renderMarkdown(rule.description, rule.docsUrl)
          : 'This rule is not in the catalog. It may be reserved or added since the catalog was generated.'}
      </p>
      <a className="rule-card__link" href={rule ? rule.docsUrl : DOCS_RULES} target="_blank" rel="noreferrer">
        rules reference ↗
      </a>
    </article>
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
