import { useEffect, useState } from 'preact/hooks'
import { AccessibilityMenu, ThemeSwitch, Wordmark } from './Controls.jsx'
import { RuleCard, RuleChip, RuleHighlight, ruleInfo } from './RuleChip.jsx'
import { AUR_PACKAGE, AUR_PKGBUILD, eventBadgeClass, eventLabel, formatTime, locationLabel, relative } from './util.js'
import { alertingClusters } from '../worker/lib.js'
import { renderMarkdown } from './markdown.jsx'

const SECURITY = 'https://docs.trustsight.org/security/'
const NTFY = 'https://ntfy.sh/trustsight-aur-1d8a3fd2'

// One-line explanations of the kinds of entry a document can carry, so a
// reader knows what they are looking at before the list.
export const ENTRY_TYPES = {
  alert: 'A rule firing: one published pattern matched one package change. A firing is a reason to look, not a verdict.',
  over_threshold: 'A package whose weighted score crossed the alerting bar (default 30, the benign corpus 95th percentile). It carries the version transition and every rule that fired.',
  ioc: 'A match against signed, federated known-bad indicators. Reported outside the heuristic score, so it is shown whatever the package scored.',
  campaign_cluster: 'A pattern shared across packages in a window (a host, a literal, an adopter). A campaign invisible in any single diff becomes visible in the set.',
  impersonation: 'Many name-clones of a popular package published under one account. The one alert a reviewer must not skim past.',
  refusal: 'A construct the analysis could not resolve, so part of this change was not read. The run is not a clean read; the finding names what was unresolved and where.',
}

/**
 * The unresolved constructs a finding names, e.g. X026's
 * `... functions: _uid <- package` becomes `{ name: '_uid', func: 'package' }`.
 * Empty for a finding that is not about an unresolved construct.
 */
function parseUnresolved(reason) {
  if (!reason || !/unresolved/i.test(reason)) return []
  const tail = reason.slice(reason.lastIndexOf(':') + 1).trim()
  return tail
    .split(/[,;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((pair) => {
      const [name, fn] = pair.split('<-').map((part) => part.trim())
      return { name, func: fn ? fn.replace(/\(\)$/, '') : '' }
    })
    .filter((entry) => entry.name)
}

/** The unresolved names across a set of findings, for the source highlight. */
function unresolvedNames(findings) {
  const names = new Set()
  for (const f of findings) for (const entry of parseUnresolved(f.reason)) names.add(entry.name)
  return names
}

/**
 * Map a unified diff onto the current file: the set of added line numbers, and
 * the removed lines keyed by the line number they precede. This is what lets
 * the source view show the change in place.
 */
function parseFileDiff(diffText, names) {
  const added = new Set()
  const delsBefore = new Map()
  if (!diffText) return { added, delsBefore }
  let inFile = false
  let newLine = 0
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.+)$/)
      inFile = Boolean(m) && names.includes(m[1])
      continue
    }
    if (!inFile) continue
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      newLine = m ? Number(m[1]) : 0
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('\\')) continue
    if (line.startsWith('+')) { added.add(newLine); newLine += 1 }
    else if (line.startsWith('-')) {
      if (!delsBefore.has(newLine)) delsBefore.set(newLine, [])
      delsBefore.get(newLine).push(line.slice(1))
    } else if (line.startsWith(' ')) { newLine += 1 }
  }
  return { added, delsBefore }
}

/** The maintainer and upstream URLs a PKGBUILD declares. */
function parsePkgbuild(text) {
  if (!text) return { maintainer: '', url: '', sources: [] }
  const maintainer = (text.match(/^#\s*Maintainer[^\n:]*:\s*(.+?)\s*$/m) || [])[1] || ''
  const url = (text.match(/^url=(['"]?)([^'"\n]+)\1/m) || [])[2] || ''
  const sources = []
  const block = text.match(/source(?:_[a-z0-9_]+)?=\(([\s\S]*?)\)/m)
  if (block) {
    for (const m of block[1].matchAll(/['"]([^'"]+)['"]/g)) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(m[1])) sources.push(m[1])
    }
  }
  return { maintainer, url, sources }
}

/**
 * The file paths a unified diff touches, in order. The diff is the record of
 * what actually changed, so it names the files a reader may want to open even
 * when no finding happens to point at them (the PKGBUILD, for one).
 */
function diffFiles(diffText) {
  const files = []
  const seen = new Set()
  for (const line of String(diffText || '').split('\n')) {
    const m = line.match(/^diff --git a\/.+ b\/(.+)$/)
    if (m && !seen.has(m[1])) { seen.add(m[1]); files.push(m[1]) }
  }
  return files
}

/** The removed and added lines of a diff that mention any keyword. */
function diffValues(diffText, keywords) {
  const removed = []
  const added = []
  if (!diffText) return { removed, added }
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (!keywords.some((k) => line.includes(k))) continue
    if (line.startsWith('+')) added.push(line.slice(1).trim())
    else if (line.startsWith('-')) removed.push(line.slice(1).trim())
  }
  return { removed, added }
}

/** A line with its version numbers and checksums blanked, for comparison. */
function withoutVersions(line) {
  return line
    .replace(/\$\{?pkgver\}?/g, 'V')
    .replace(/\bv?\d+(?:\.\d+)+(?:[-._][0-9A-Za-z]+)*/g, 'V')
    .replace(/\b[0-9a-f]{32,}\b/gi, 'H')
}

/**
 * True when the change is more than a version bump. A source line whose only
 * difference is the version (or a checksum) did not really change, and the
 * card must not say it did.
 */
function changedBeyondVersion(removed, added) {
  const norm = (arr) => [...new Set(arr.map(withoutVersions))].sort().join('|')
  return norm(removed) !== norm(added)
}

/**
 * The context of a flagged package: who maintains it and where its source
 * comes from. Always shown beside the rule triggers, colored by whether the
 * latest commit changed that line.
 */
function ContextBlock({ packageName, findings }) {
  const manifestFiles = [...new Set(
    findings.filter((f) => /^U\d{3}$/.test(f.rule_id)).map((f) => f.file).filter(Boolean),
  )]
  const [info, setInfo] = useState({
    maintainer: '', url: '', sources: [],
    maintainerRemoved: [], maintainerAdded: [],
    upstreamRemoved: [], upstreamAdded: [],
  })

  useEffect(() => {
    let live = true
    Promise.all([
      fetch(`/api/source/${encodeURIComponent(packageName)}?file=PKGBUILD`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch(`/api/diff/${encodeURIComponent(packageName)}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]).then(([srcBody, diffBody]) => {
      if (!live) return
      const parsed = parsePkgbuild(String(srcBody.content || ''))
      const diff = String(diffBody.diff || '')
      const m = diffValues(diff, ['Maintainer'])
      const u = diffValues(diff, ['source', 'url'])
      setInfo({
        maintainer: parsed.maintainer, url: parsed.url, sources: parsed.sources,
        maintainerRemoved: m.removed, maintainerAdded: m.added,
        upstreamRemoved: u.removed, upstreamAdded: u.added,
      })
    })
    return () => { live = false }
  }, [packageName])

  const maintChanged = info.maintainerRemoved.length || info.maintainerAdded.length
  const upChanged = changedBeyondVersion(info.upstreamRemoved, info.upstreamAdded)
  const maintainerClass = info.maintainerRemoved.length ? ' context__card--del' : info.maintainerAdded.length ? ' context__card--add' : ''
  const upstreamClass = upChanged
    ? (info.upstreamRemoved.length ? ' context__card--del' : ' context__card--add')
    : ''

  return (
    <div className="context">
      <span className="pkg__label">Context</span>
      <div className="context__cards">
        <article className={`context__card${maintainerClass}`}>
          <span className="context__title">Maintainer</span>
          {maintChanged ? (
            <div className="context__diff">
              {info.maintainerRemoved.map((l, i) => <div className="context__diff-line context__diff-line--del" key={`r${i}`}>- {l}</div>)}
              {info.maintainerAdded.map((l, i) => <div className="context__diff-line context__diff-line--add" key={`a${i}`}>+ {l}</div>)}
            </div>
          ) : (
            <span className="context__value">{info.maintainer || 'unknown'}</span>
          )}
        </article>
        <article className={`context__card${upstreamClass}`}>
          <span className="context__title">Upstream</span>
          {upChanged ? (
            <div className="context__diff">
              {info.upstreamRemoved.map((l, i) => <div className="context__diff-line context__diff-line--del" key={`r${i}`}>- {l}</div>)}
              {info.upstreamAdded.map((l, i) => <div className="context__diff-line context__diff-line--add" key={`a${i}`}>+ {l}</div>)}
            </div>
          ) : (
            <>
              {info.url
                ? <a className="context__value" href={info.url} target="_blank" rel="noreferrer">{info.url}</a>
                : <span className="context__value">unknown</span>}
              {info.sources.length ? (
                <ul className="context__list">
                  {info.sources.slice(0, 4).map((u) => <li key={u}><a href={u} target="_blank" rel="noreferrer">{u}</a></li>)}
                </ul>
              ) : null}
            </>
          )}
        </article>
        {manifestFiles.length ? (
          <article className="context__card context__card--wide">
            <span className="context__title">Upstream manifests</span>
            <ul className="context__list">
              {manifestFiles.map((f) => <li key={f}><code className="md-code">{f}</code></li>)}
            </ul>
            <span className="context__note">Open the Source tab to view them.</span>
          </article>
        ) : null}
      </div>
    </div>
  )
}

/** Everyone who updated a package in this document, and how many each touched. */
function MaintainersSection({ packages }) {
  const key = packages.join(',')
  const [maintainers, setMaintainers] = useState(null)

  useEffect(() => {
    let live = true
    if (!packages.length) return undefined
    fetch(`/api/maintainers?packages=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((body) => { if (live) setMaintainers(body.maintainers || {}) })
      .catch(() => {})
    return () => { live = false }
  }, [key])

  if (!maintainers) return null
  const groups = new Map()
  for (const pkg of packages) {
    const who = maintainers[pkg] || 'unknown'
    if (!groups.has(who)) groups.set(who, [])
    groups.get(who).push(pkg)
  }
  if (!groups.size) return null
  const ordered = [...groups.entries()].sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]))

  return (
    <section className="detail__section">
      <h2>Maintainers ({ordered.length})</h2>
      <p className="detail__explain">Who updated the packages in this document, and how many each touched.</p>
      <ul className="maintainers">
        {ordered.map(([who, pkgs]) => (
          <li className="maintainer" key={who}>
            <span className="maintainer__name">{who}</span>
            <span className="maintainer__count">{pkgs.length} package{pkgs.length === 1 ? '' : 's'}</span>
            <span className="maintainer__pkgs">
              {pkgs.map((p) => <a key={p} href={AUR_PACKAGE(p)} target="_blank" rel="noreferrer">{p}</a>)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Packages the analysis could not fully read, with what it could not resolve. */
function Refusals({ refusals }) {
  if (!refusals.length) return null
  return (
    <section className="detail__section">
      <h2>Could not fully read ({refusals.length})</h2>
      <p className="detail__explain">{ENTRY_TYPES.refusal}</p>
      {refusals.map((refusal, i) => {
        const findings = refusal.findings || []
        const unresolved = findings.flatMap((f) => parseUnresolved(f.reason))
        return (
          <article className="pkg" key={`${refusal.package}-${i}`}>
            <header className="pkg__head">
              <a className="pkg__name" href={AUR_PACKAGE(refusal.package)} target="_blank" rel="noreferrer">{refusal.package}</a>
            </header>
            {refusal.reason ? <p className="pkg__meta">{refusal.reason}</p> : null}
            {unresolved.length ? (
              <div className="unresolved">
                <span className="pkg__label">Not resolved</span>
                <ul className="unresolved__list">
                  {unresolved.map((entry, j) => (
                    <li key={`${entry.name}-${j}`}>
                      <code className="md-code">{entry.name}</code>
                      {entry.func
                        ? <span className="unresolved__from">referenced from <code className="md-code">{entry.func}()</code></span>
                        : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {findings.length ? (
              <>
                <p className="pkg__meta">What the analysis could not resolve:</p>
                <FindingsOrSource packageName={refusal.package} findings={findings} />
              </>
            ) : (
              <p className="pkg__meta">A construct in this recipe could not be resolved, so part of the change was not read.</p>
            )}
          </article>
        )
      })}
    </section>
  )
}

// What each campaign kind means, in one line, so a reader knows the shape
// before scanning the member list.  G005 (impersonation) has its own section.
const CAMPAIGN_TYPES = {
  G001: { label: 'Shared gained host', means: 'Unrelated packages all added the same new host in one window: the signature of a coordinated redirect through a shared endpoint.' },
  G002: { label: 'Shared added literal', means: 'The same large code blob was added to unrelated packages in one window: one payload reused across many recipes.' },
  G003: { label: 'Coordinated adoption', means: 'One account adopted several packages at once, a burst that can precede a mass rewrite.' },
  G004: { label: 'Shared upstream dependency', means: 'Unrelated packages gained the same new upstream dependency and host in one window.' },
  G006: { label: 'Neighborhood under campaign alert', means: 'A package gained a host already in an active campaign scope. Context, never scored.' },
  G007: { label: 'Campaign corroboration', means: 'A package stood in the scope of an active campaign and earned a small corroboration bonus.' },
}

/** The human name and meaning for a campaign rule, from the map or the catalog. */
function campaignType(id) {
  if (CAMPAIGN_TYPES[id]) return CAMPAIGN_TYPES[id]
  const rule = ruleInfo(id)
  return rule
    ? { label: rule.name, means: rule.description, docsUrl: rule.docsUrl }
    : { label: `Rule ${id}`, means: '' }
}

/** The affected packages of a campaign, each linked to its AUR page and PKGBUILD. */
function MemberList({ names }) {
  if (!names.length) return <p className="pkg__meta">No member packages named.</p>
  return (
    <ul className="campaign-members">
      {names.map((name) => (
        <li key={name}>
          <a className="member__name" href={AUR_PACKAGE(name)} target="_blank" rel="noreferrer">{name}</a>
          <a className="member__pkgbuild" href={AUR_PKGBUILD(name)} target="_blank" rel="noreferrer" title={`PKGBUILD for ${name}`}>PKGBUILD ↗</a>
        </li>
      ))}
    </ul>
  )
}

/** Group a flat alert list by package, so each flagged package owns a section. */
function groupAlerts(alerts) {
  const byName = new Map()
  for (const entry of alerts) {
    if (!entry.package) continue
    if (!byName.has(entry.package)) byName.set(entry.package, { package: entry.package, rules: [], seen: new Set() })
    const group = byName.get(entry.package)
    if (entry.rule_id && !group.seen.has(entry.rule_id)) {
      group.seen.add(entry.rule_id)
      group.rules.push(entry.rule_id)
    }
  }
  return [...byName.values()]
}

function AlertList({ alerts, overPackages }) {
  if (!alerts.length) return null
  // A package that also crossed the threshold is rendered once, in full, by
  // the over-threshold section below - so it is not repeated here.  Its rule
  // firings are still named there through the located findings.
  const all = groupAlerts(alerts)
  const groups = all.filter((group) => !overPackages.has(group.package))
  const alsoOver = all.length - groups.length
  // Explain each rule once for the whole batch. A campaign fires the same rule
  // on many packages, so a card per package repeated the same text dozens of
  // times; the legend explains it once and the packages stay compact.
  const distinctRules = [...new Set(groups.flatMap((group) => group.rules))].sort()
  return (
    <section className="detail__section">
      <h2>New alerts ({alerts.length})</h2>
      <p className="detail__explain">{ENTRY_TYPES.alert}</p>
      {alsoOver ? (
        <p className="detail__explain">
          {alsoOver} of these package{alsoOver === 1 ? '' : 's'} {alsoOver === 1 ? 'is' : 'are'} also
          over threshold, shown in full below.
        </p>
      ) : null}
      {distinctRules.length ? (
        <>
          <span className="pkg__label">Rules in this batch ({distinctRules.length})</span>
          <div className="rule-cards">
            {distinctRules.map((id) => <RuleCard key={id} id={id} />)}
          </div>
        </>
      ) : null}
      {groups.map((group) => (
        <article className="pkg" key={group.package}>
          <header className="pkg__head">
            <a className="pkg__name" href={AUR_PACKAGE(group.package)} target="_blank" rel="noreferrer">{group.package}</a>
            <span className="pkg__version">{group.rules.length} rule{group.rules.length === 1 ? '' : 's'}</span>
          </header>
          <div className="ref-list">
            {group.rules.map((id) => <RuleChip key={id} id={id} />)}
          </div>
        </article>
      ))}
    </section>
  )
}

/** Every finding the watcher sent, each with the file and line it fired on. */
function Findings({ findings }) {
  if (!findings || !findings.length) return null
  return (
    <ul className="findings">
      {findings.map((f, i) => {
        const loc = locationLabel(f)
        const rule = ruleInfo(f.rule_id)
        const unresolved = parseUnresolved(f.reason)
        const sev = String(f.severity || 'info').toLowerCase()
        return (
          <li className={`finding finding--${sev}`} key={`${f.rule_id}-${i}`}>
            <div className="finding__head">
              <RuleChip id={f.rule_id} />
              {loc
                ? <pre className="finding__loc">{loc}</pre>
                : <span className="finding__loc finding__loc--none" title="This signal names a fact about the change, not a line">no line</span>}
            </div>
            {f.reason ? <p className="finding__reason">{f.reason}</p> : null}
            {unresolved.length ? (
              <p className="finding__unresolved">
                Not resolved:
                {unresolved.map((entry, j) => (
                  <span key={`${entry.name}-${j}`}>
                    {' '}<code className="md-code">{entry.name}</code>
                    {entry.func
                      ? <span className="unresolved__from"> referenced from <code className="md-code">{entry.func}()</code></span>
                      : null}
                  </span>
                ))}
              </p>
            ) : null}
            {rule && rule.description ? <p className="finding__explain">{renderMarkdown(rule.description, rule.docsUrl)}</p> : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The source of the artifact the findings fired on, read from the AUR
 * repository and shown with the flagged lines highlighted. The line numbers
 * are from the analysed revision; a newer revision may have moved them, which
 * the note under the code says.
 */
function SourceView({ packageName, files, findings }) {
  // The PKGBUILD is the artifact a reader wants first, and it always exists in
  // an AUR repository, so it is the default whatever the findings name.
  const [file, setFile] = useState('PKGBUILD')
  const [state, setState] = useState({ loading: true })

  useEffect(() => {
    let live = true
    setState({ loading: true })
    const sourceReq = fetch(`/api/source/${encodeURIComponent(packageName)}?file=${encodeURIComponent(file)}`)
      .then(async (res) => ({ res, body: await res.json().catch(() => ({})) }))
    const diffReq = fetch(`/api/diff/${encodeURIComponent(packageName)}`)
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}))
    Promise.all([sourceReq, diffReq])
      .then(([{ res, body }, diffBody]) => {
        const diff = String((diffBody && diffBody.diff) || '')
        if (!live) return
        if (res.ok) return setState({ content: String(body.content || ''), actualFile: body.file || file, diff })
        if (body.error === 'not_found') return setState({ notFound: true, available: Array.isArray(body.available) ? body.available : [], diff })
        setState({ error: body.error ? `Could not load (${body.error}).` : `HTTP ${res.status}`, diff })
      })
      .catch((err) => { if (live) setState({ error: String(err && err.message ? err.message : err) }) })
    return () => { live = false }
  }, [packageName, file])

  const lines = state.content === undefined ? [] : state.content.split('\n')
  // Offer the PKGBUILD, every file a finding names, every file the diff
  // touches, and (on a miss) the repository's own list. Without this the
  // picker held only the findings' files, so for a package whose findings all
  // point at a `.install` the PKGBUILD never appeared.
  const pickerFiles = [...new Set([
    'PKGBUILD',
    ...files,
    ...diffFiles(state.diff),
    ...(state.available || []),
  ])]

  // Highlight the findings for the requested file name, even when the
  // repository holds the same file under a different name.
  const byLine = new Map()
  for (const f of findings) {
    if (f.file !== file || !f.line) continue
    if (!byLine.has(f.line)) byLine.set(f.line, [])
    byLine.get(f.line).push(f)
  }
  // An unresolved construct has no line in the finding, so find it by name in
  // the source and flag the line that references it.
  const names = unresolvedNames(findings)
  const unresolvedLines = new Set()
  if (names.size) {
    const carriers = findings.filter((f) => parseUnresolved(f.reason).length)
    lines.forEach((text, i) => {
      if (!text || ![...names].some((name) => text.includes(name))) return
      const lineNo = i + 1
      unresolvedLines.add(lineNo)
      if (!byLine.has(lineNo)) byLine.set(lineNo, [])
      for (const f of carriers) {
        if (!byLine.get(lineNo).some((h) => h.rule_id === f.rule_id)) byLine.get(lineNo).push(f)
      }
    })
  }

  // Merge the diff in place: added lines get a green row, removed lines are
  // inserted red before the line they preceded.
  const diffInfo = parseFileDiff(state.diff, [file, state.actualFile].filter(Boolean))
  const rows = []
  lines.forEach((text, i) => {
    const lineNo = i + 1
    for (const removed of diffInfo.delsBefore.get(lineNo) || []) rows.push({ kind: 'del', text: removed, no: null })
    rows.push({ kind: diffInfo.added.has(lineNo) ? 'add' : 'ctx', text, no: lineNo })
  })
  for (const removed of diffInfo.delsBefore.get(lines.length + 1) || []) rows.push({ kind: 'del', text: removed, no: null })

  return (
    <div className="source">
      {pickerFiles.length > 1 ? (
        <div className="source__files">
          {pickerFiles.map((name) => (
            <button
              type="button"
              key={name}
              className={`source__file${name === file ? ' is-on' : ''}`}
              aria-pressed={name === file}
              onClick={() => setFile(name)}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}

      {state.loading ? <p className="pkg__meta">Loading {file}…</p> : null}
      {state.error ? <p className="feed-error">Could not load {file}: {state.error}</p> : null}
      {state.notFound ? (
        <p className="feed-error">
          {file} is not in the AUR repository.
          {pickerFiles.length ? ' Pick another file above.' : ''}
        </p>
      ) : null}

      {state.content !== undefined ? (
        <>
          {state.actualFile && state.actualFile !== file ? (
            <p className="source__note">Showing {state.actualFile}, the matching file in the repository.</p>
          ) : null}
          <div className="source__code">
            {rows.map((row, i) => {
              const hits = row.no ? byLine.get(row.no) : null
              const cls = `source__line${row.kind !== 'ctx' ? ` source__line--${row.kind}` : ''}${hits ? ' source__line--hit' : ''}${row.no && unresolvedLines.has(row.no) ? ' source__line--unresolved' : ''}`
              return (
                <div className={cls} key={i} title={hits ? hits.map((h) => h.reason).filter(Boolean).join(' | ') : undefined}>
                  <span className="source__no">{row.no || ''}</span>
                  <span className="source__text">
                    {row.text || ' '}
                    {hits ? (
                      <span className="source__hits">
                        {hits.map((h, j) => <RuleChip key={`${h.rule_id}-${j}`} id={h.rule_id} />)}
                      </span>
                    ) : null}
                  </span>
                </div>
              )
            })}
          </div>
          <p className="source__note">
            Read from the AUR repository as it is now. The line numbers are from the revision the
            watcher analysed, so a newer revision may have moved them.
          </p>
        </>
      ) : null}
    </div>
  )
}

function ViewToggle({ view, onChange }) {
  const views = [['findings', 'Findings'], ['source', 'Source'], ['diff', 'Diff']]
  return (
    <div className="view-switch" role="group" aria-label="Findings, source or diff">
      {views.map(([value, label]) => (
        <button key={value} type="button" className={view === value ? 'is-on' : ''} aria-pressed={view === value} onClick={() => onChange(value)}>{label}</button>
      ))}
    </div>
  )
}

/**
 * The latest AUR commit as a unified diff. This is where a removed construct
 * shows: the deleted lines are rendered red and the added ones green, so what
 * disappeared from the recipe is visible even when the current file no longer
 * contains it.
 */
function DiffView({ packageName }) {
  const [state, setState] = useState({ loading: true })

  useEffect(() => {
    let live = true
    setState({ loading: true })
    fetch(`/api/diff/${encodeURIComponent(packageName)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error ? `Could not load (${body.error}).` : `HTTP ${res.status}`)
        return body
      })
      .then((body) => { if (live) setState({ diff: String(body.diff || '') }) })
      .catch((err) => { if (live) setState({ error: String(err && err.message ? err.message : err) }) })
    return () => { live = false }
  }, [packageName])

  const text = state.diff || ''
  const start = text.indexOf('diff --git')
  const body = start >= 0 ? text.slice(start) : text
  const lines = body ? body.split('\n') : []

  function lineClass(line) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') ||
        line.startsWith('+++') || line.startsWith('@@') || line.startsWith('new file') ||
        line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename ') ||
        line.startsWith('old mode') || line.startsWith('new mode')) {
      return 'diff__line diff__line--meta'
    }
    if (line.startsWith('+')) return 'diff__line diff__line--add'
    if (line.startsWith('-')) return 'diff__line diff__line--del'
    return 'diff__line'
  }

  return (
    <div className="diff">
      {state.loading ? <p className="pkg__meta">Loading diff…</p> : null}
      {state.error ? <p className="feed-error">Could not load the diff: {state.error}</p> : null}
      {state.diff !== undefined && !lines.length ? <p className="pkg__meta">No diff for the latest commit.</p> : null}
      {lines.length ? (
        <>
          <div className="diff__code">
            {lines.map((line, i) => <div className={lineClass(line)} key={i}>{line || ' '}</div>)}
          </div>
          <p className="source__note">
            Diff of the latest AUR commit, the change the watcher alerted on. Removed lines are red;
            added lines are green.
          </p>
        </>
      ) : null}
    </div>
  )
}

/** The findings list, with a switch to the highlighted source or the diff. */
function FindingsOrSource({ packageName, findings }) {
  const [view, setView] = useState('findings')
  const files = [...new Set(findings.map((f) => f.file).filter(Boolean))]
  // PKGBUILD first: it is the artifact a reader wants by default.
  files.sort((a, b) => (a === 'PKGBUILD' ? -1 : b === 'PKGBUILD' ? 1 : a.localeCompare(b)))
  return (
    <>
      <div className="pkg__viewrow">
        <ViewToggle view={view} onChange={setView} />
      </div>
      {view === 'source'
        ? <SourceView packageName={packageName} files={files.length ? files : ['PKGBUILD']} findings={findings} />
        : view === 'diff'
          ? <DiffView packageName={packageName} />
          : <Findings findings={findings} />}
    </>
  )
}

function PackageSections({ packages }) {
  if (!packages.length) return null
  return (
    <section className="detail__section">
      <h2>Packages over threshold ({packages.length})</h2>
      <p className="detail__explain">{ENTRY_TYPES.over_threshold}</p>
      {packages.map((pkg) => {
        const findings = pkg.findings || []
        // A rule that has a located finding is already named and explained by
        // its finding row (the chip explains the rule on hover, or on tap on a
        // phone).  Only rules with no located finding need a card, so a rule is
        // never rendered twice.
        const foundRules = new Set(findings.map((f) => f.rule_id))
        const rules = [...new Set(pkg.rules || [])].filter((id) => !foundRules.has(id))
        return (
          <article className="pkg" key={pkg.package}>
            <header className="pkg__head">
              <a className="pkg__name" href={AUR_PACKAGE(pkg.package)} target="_blank" rel="noreferrer">{pkg.package}</a>
              {pkg.version ? <span className="pkg__version">{pkg.version}</span> : null}
              {pkg.score !== undefined && pkg.score !== null ? <span className="badge badge--alerts">score {pkg.score}</span> : null}
              <a className="pkg__action" href={AUR_PKGBUILD(pkg.package)} target="_blank" rel="noreferrer">See PKGBUILD ↗</a>
            </header>
            {pkg.last_modified ? <p className="pkg__meta">AUR change: {pkg.last_modified}</p> : null}
            <ContextBlock packageName={pkg.package} findings={findings} />
            {findings.length ? (
              <>
                <p className="pkg__meta">What fired, and the line that triggered it:</p>
                <FindingsOrSource packageName={pkg.package} findings={findings} />
              </>
            ) : (
              <p className="pkg__meta">No located findings in this entry.</p>
            )}
            {rules.length ? (
              <div className="rule-cards">
                {rules.map((id) => <RuleCard key={id} id={id} />)}
              </div>
            ) : findings.length ? null : (
              <p className="pkg__meta">No named rule in this entry.</p>
            )}
          </article>
        )
      })}
    </section>
  )
}

function IocSection({ matches }) {
  if (!matches.length) return null
  return (
    <section className="detail__section">
      <h2>Indicators of compromise ({matches.length})</h2>
      <p className="detail__explain">{ENTRY_TYPES.ioc}</p>
      <div className="ref-list">
        {matches.map((m, i) => (
          <span className="alert-item" key={`${m.package}-${i}`}>
            <a className="pkg__name" href={AUR_PACKAGE(m.package)} target="_blank" rel="noreferrer">{m.package}</a>
            {m.indicator ? <code className="chip">{m.indicator}</code> : null}
          </span>
        ))}
      </div>
    </section>
  )
}

function Campaigns({ payload }) {
  const clusters = alertingClusters(payload)
  const impersonation = payload.impersonation || []
  if (!clusters.length && !impersonation.length) return null
  const total = clusters.length + impersonation.length
  return (
    <section className="detail__section">
      <h2>Campaigns ({total})</h2>
      <p className="detail__explain">{ENTRY_TYPES.campaign_cluster}</p>
      {impersonation.map((camp, i) => {
        const members = camp.members || []
        return (
          <article className="pkg campaign" key={`imp-${i}`}>
            <header className="pkg__head">
              <span className="badge badge--imp">impersonation campaign</span>
              <span className="pkg__version">{camp.maintainer || 'one submitter'} · {camp.count} name-clones</span>
            </header>
            <p className="detail__explain">{ENTRY_TYPES.impersonation}</p>
            {camp.targets && camp.targets.length
              ? <p className="pkg__meta">Impersonates: {camp.targets.join(', ')}</p>
              : null}
            <h3 className="campaign__subhead">Affected packages ({members.length})</h3>
            <MemberList names={members} />
          </article>
        )
      })}
      {clusters.map((cluster, i) => {
        const type = campaignType(cluster.rule_id)
        const members = cluster.members || []
        return (
          <article className="pkg campaign" key={`cluster-${i}`}>
            <header className="pkg__head">
              <span className="badge">campaign</span>
              <RuleChip id={cluster.rule_id} />
              <span className="pkg__version">{type.label} · {members.length} packages</span>
            </header>
            {type.means ? <p className="detail__explain">{renderMarkdown(type.means, type.docsUrl)}</p> : null}
            <h3 className="campaign__subhead">Affected packages ({members.length})</h3>
            <MemberList names={members} />
          </article>
        )
      })}
    </section>
  )
}

export function Message({ slug }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [showJson, setShowJson] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    setData(null)
    setShowJson(false)
    fetch(`/api/messages/${slug}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Notification not found.' : `HTTP ${res.status}`)
        return res.json()
      })
      .then((json) => { if (live) setData(json) })
      .catch((err) => { if (live) setError(String(err && err.message ? err.message : err)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [slug])

  const payload = data ? data.payload : {}
  const alerts = payload.alerts || []
  const packages = payload.over_threshold || []
  const overPackages = new Set(packages.map((p) => p.package))
  const ioc = payload.ioc_matches || []
  const allPackages = [...new Set([
    ...alerts.map((a) => a.package),
    ...packages.map((p) => p.package),
    ...ioc.map((m) => m.package),
    ...alertingClusters(payload).flatMap((c) => c.members || []),
    ...(payload.impersonation || []).flatMap((c) => c.members || []),
    ...(payload.refusals || []).map((r) => r.package),
  ].filter(Boolean))]
  const pretty = data ? JSON.stringify(payload, null, 2) : ''

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(pretty)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
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

        {loading ? <p className="feed-empty">Loading…</p> : null}
        {error ? <p className="feed-error">{error}</p> : null}

        {data ? (
          <>
            <h1>{data.headline || data.title || '(untitled notification)'}</h1>
            <div className="detail__meta">
              <span title="Your local time with its offset, then UTC">{formatTime(data.time)}</span>
              <span>{relative(data.time)}</span>
              <span className={eventBadgeClass(data.event)}>{eventLabel(data.event)}</span>
              {data.day ? <span>day {data.day}</span> : null}
              <a href={NTFY} target="_blank" rel="noreferrer">ntfy channel ↗</a>
            </div>

            {payload.cycle ? (
              <div className="detail__meta">
                <span>cycle: {payload.cycle.added} added · {payload.cycle.changed} changed · {payload.cycle.removed} removed · {payload.cycle.processed} processed</span>
              </div>
            ) : null}

            <MaintainersSection packages={allPackages} />
            <Refusals refusals={payload.refusals || []} />
            <AlertList alerts={alerts} overPackages={overPackages} />
            <PackageSections packages={packages} />
            <IocSection matches={ioc} />
            <Campaigns payload={payload} />

            {!alerts.length && !packages.length && !ioc.length && !alertingClusters(payload).length && !(payload.impersonation || []).length && !(payload.refusals || []).length ? (
              <p className="feed-empty">This document carries no alerts, packages, indicators or campaigns.</p>
            ) : null}

            <section className="detail__section">
              <h2>Full document</h2>
              <div className="json-actions">
                <button
                  type="button"
                  className="load-more"
                  aria-expanded={showJson}
                  aria-controls="full-json"
                  onClick={() => setShowJson((v) => !v)}
                >
                  {showJson ? 'Hide JSON' : 'Show JSON'}
                </button>
                <button
                  type="button"
                  className="load-more"
                  onClick={copyJson}
                  aria-label="Copy the full JSON document to the clipboard"
                >
                  {copied ? 'Copied ✓' : 'Copy JSON'}
                </button>
              </div>
              {showJson ? <div className="json" id="full-json"><RuleHighlight text={pretty} /></div> : null}
              <p className="masthead-note">
                This document is static-analysis evidence, not proof of safety and not permission to
                build. TrustSight never runs the PKGBUILD it reviews. See the{' '}
                <a href={SECURITY} target="_blank" rel="noreferrer">security model</a>.
              </p>
            </section>
          </>
        ) : null}
      </main>
    </div>
  )
}
