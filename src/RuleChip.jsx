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
export function RuleChip({ id, onFilter }) {
  const rule = ruleInfo(id)

  function activate(event) {
    if (!isCoarse()) {
      if (!onFilter) return
      event.preventDefault()
      event.stopPropagation()
      onFilter(id)
      return
    }
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
      aria-label={onFilter
        ? `Filter the feed by rule ${id}${rule ? `: ${rule.name}` : ''}.`
        : `Rule ${id}${rule ? `: ${rule.name}` : ''}. Open the explanation.`}
    >
      {id}
      <span className="rule-pop" role="tooltip">
        <RuleBody id={id} />
        {rule ? (
          <>
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

const SEVERITY_RANK = { FATAL: 0, CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4, INFO: 5 }

export function ruleSeverityRank(id) {
  const rule = ruleInfo(id)
  const sev = rule && rule.severity ? rule.severity.toUpperCase() : ''
  return sev in SEVERITY_RANK ? SEVERITY_RANK[sev] : SEVERITY_RANK.INFO + 1
}

export function sortRuleIds(ids) {
  return [...ids].sort((a, b) => ruleSeverityRank(a) - ruleSeverityRank(b) || a.localeCompare(b))
}

/**
 * The full explanation as a plain section. On a wide pointer it shows the
 * whole description inline; on touch or a narrow viewport it collapses to a
 * borderless button that opens the modal, so a phone never gets a wall of
 * text.
 */
export function RuleSection({ id }) {
  const rule = ruleInfo(id)
  const sev = rule && rule.severity ? rule.severity.toUpperCase() : ''

  if (isCoarse()) {
    return (
      <button
        type="button"
        className="rule-section__tap"
        onClick={() => openRuleExplanation(id)}
        aria-label={`Rule ${id}${rule ? `: ${rule.name}` : ''}. Tap for the full explanation.`}
      >
        <span className="rule-section__id">{id}</span>
        <span className="rule-section__name">{rule ? rule.name : 'Unknown rule'}</span>
        {sev ? <span className={`sev ${severityClass(sev)}`}>{sev}</span> : null}
      </button>
    )
  }

  return (
    <section className="rule-section">
      <h3 className="rule-section__head">
        <span className="rule-section__id">{id}</span>
        <span className="rule-section__name">{rule ? rule.name : 'Unknown rule'}</span>
        {sev ? <span className={`sev ${severityClass(sev)}`}>{sev}</span> : null}
      </h3>
      <p className="rule-section__desc">
        {rule && rule.description
          ? renderMarkdown(rule.description, rule.docsUrl)
          : 'This rule is not in the catalog. It may be reserved or added since the catalog was generated.'}
      </p>
      <a className="rule-section__link" href={rule ? rule.docsUrl : DOCS_RULES} target="_blank" rel="noreferrer">
        rules reference ↗
      </a>
    </section>
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
