/** Parse the dependency arrays a PKGBUILD declares.
 *
 * This is deliberately a reader, not a shell: it accepts the literal forms a
 * recipe uses in practice (multiline arrays, quoted or bare names, version
 * constraints and optdepends descriptions) and leaves values built from
 * variables out of the check. Dynamic entries are returned separately so the
 * page can say what it could not resolve instead of silently dropping them.
 */
const DEP_ARRAY = /^\s*(depends|makedepends|checkdepends|optdepends)(?:_[A-Za-z0-9_]+)?\s*=\s*\(([\s\S]*?)\)/gm
const TOKEN = /'([^']*)'|"([^"]*)"|([^\s)]+)/g

function dependencyName(raw) {
  let value = String(raw || '').trim().replace(/^['"]|['"]$/g, '')
  const description = value.indexOf(':')
  if (description >= 0) value = value.slice(0, description)
  if (!value) return { name: '', dynamic: false }
  if (/[$`]/.test(value)) return { name: value, dynamic: true }
  value = value.replace(/[<>=]+.*$/, '').replace(/[;,]$/, '').trim()
  return { name: value, dynamic: false }
}

export function parseDependencies(text) {
  const groups = {
    depends: [],
    makedepends: [],
    checkdepends: [],
    optdepends: [],
  }
  const dynamic = []
  const seen = new Set()
  for (const match of String(text || '').matchAll(DEP_ARRAY)) {
    const group = match[1]
    for (const token of match[2].matchAll(TOKEN)) {
      const parsed = dependencyName(token[1] ?? token[2] ?? token[3] ?? '')
      if (!parsed.name) continue
      if (parsed.dynamic) {
        if (!dynamic.includes(parsed.name)) dynamic.push(parsed.name)
        continue
      }
      const key = `${group}\0${parsed.name}`
      if (seen.has(key)) continue
      seen.add(key)
      groups[group].push(parsed.name)
    }
  }
  return { ...groups, dynamic }
}
