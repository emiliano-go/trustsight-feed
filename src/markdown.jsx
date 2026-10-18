// Inline markdown for rule descriptions. The catalog text is a single
// paragraph written for the docs, so only inline constructs appear: `code`,
// **bold**, *italic* and [links](...). Rendering it as plain text left the
// backticks and brackets visible.

const DOCS_RULES_BASE = 'https://docs.trustsight.org/reference/rules/'

/**
 * Resolve a documentation link. The descriptions are authored as MkDocs
 * source, so `.md` targets map to directory URLs and a bare `#anchor` points
 * inside the rule's own page.
 */
function resolveHref(href, docsUrl) {
  if (!href) return href
  if (/^https?:/i.test(href)) return href
  if (href.startsWith('#')) return `${(docsUrl || '').replace(/#.*$/, '')}${href}`
  try {
    const url = new URL(href, DOCS_RULES_BASE)
    url.pathname = url.pathname.replace(/\.md$/, '/')
    return url.toString()
  } catch {
    return href
  }
}

const TOKEN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g

/** Preact nodes for the inline markdown in *text*. */
export function renderMarkdown(text, docsUrl) {
  if (!text) return null
  const out = []
  let last = 0
  let match
  let key = 0
  TOKEN.lastIndex = 0
  while ((match = TOKEN.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('`')) {
      out.push(<code className="md-code" key={key++}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*')) {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>)
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      out.push(
        <a className="md-link" key={key++} href={resolveHref(link[2], docsUrl)} target="_blank" rel="noreferrer">
          {link[1]}
        </a>,
      )
    }
    last = match.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// A finding reason is machine-generated and delimits code with `backticks`
// or 'single quotes' (the same convention flagTokens reads), not prose, so
// both spans become inline code. renderMarkdown above is deliberately left
// alone: rule *descriptions* are authored prose where an apostrophe is just
// an apostrophe.
const REASON_CODE = /`([^`]+)`|'([^']+)'/g

/** Split a reason into `{ code, text }` segments on its quoted spans. */
export function splitInlineCode(text) {
  if (!text) return []
  const out = []
  let last = 0
  let m
  REASON_CODE.lastIndex = 0
  while ((m = REASON_CODE.exec(text)) !== null) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) })
    out.push({ code: true, text: m[1] ?? m[2] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) })
  return out
}

/** Preact nodes for a finding reason, with its quoted spans as inline code. */
export function renderInlineCode(text) {
  const segments = splitInlineCode(text)
  if (!segments.length) return null
  return segments.map((s, i) =>
    s.code ? <code className="md-code" key={i}>{s.text}</code> : s.text,
  )
}
