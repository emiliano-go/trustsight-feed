import { useEffect, useState } from 'preact/hooks'
import { AccessibilityMenu, ThemeSwitch, Wordmark } from './Controls.jsx'
import { RuleChip, RuleHighlight, RuleSection, ruleInfo, sortRuleIds } from './RuleChip.jsx'
import { AUR_PACKAGE, AUR_PKGBUILD, chunk, eventBadgeClass, eventLabel, flattenProse, formatTime, locationLabel, relative } from './util.js'
import { alertingClusters, campaignCommon, campaignEvents } from '../worker/lib.js'
import { renderMarkdown, renderInlineCode } from './markdown.jsx'

const SECURITY = 'https://docs.trustsight.org/security/'
const FP_DOCS = 'https://docs.trustsight.org/guides/tuning-false-positives/'
const FP_ISSUE = 'https://github.com/emiliano-go/trustsight/issues/new?template=false_positive.yml'
const NTFY = 'https://ntfy.sh/trustsight-aur-1d8a3fd2'

function fpIssueUrl(packageName, ruleIds = []) {
  const suffix = ruleIds.length ? ` ${ruleIds.join(' ')}` : ''
  const title = encodeURIComponent(`[False positive]: ${packageName}${suffix}`)
  return `${FP_ISSUE}&title=${title}`
}

/** A ready-to-paste body for the false-positive issue form. */
function fpIssueBody({ slug, packages, ruleIds, payload, toolVersion }) {
  const field = (label, value) => `### ${label}\n\n${value}\n`
  const report = JSON.stringify(payload, null, 2)
  return [
    field('What kind of report is this?', 'Bad rule trigger (malicious false positive)'),
    field('TrustSight version', toolVersion ? `trustsight ${toolVersion}` : '_No response_'),
    field('AUR package', packages.join(', ') || '_No response_'),
    field('Feed alert URL', `https://watcher.trustsight.org/${slug}/`),
    field('Rule id', ruleIds.join(', ') || '_No response_'),
    field('What TrustSight reported', '```json\n' + report + '\n```'),
    field('Why this is a bad rule trigger',
      '<!-- What did the rule misread? Why is there no bad practice or malicious behavior? -->'),
    field('PKGBUILD or diff', '<!-- Paste the PKGBUILD or the diff here. -->'),
    field('Command or mode', 'watcher feed'),
    field('Config fingerprint', payload.config_fingerprint || '_No response_'),
  ].join('\n')
}

/** The SPA route for a package's stored history. */
export const packageHref = (name) => `/pkg/${encodeURIComponent(name)}`

/** The inline jump from any package mention to its history page. */
function PackageHistoryLink({ name }) {
  return <a className="pkg__history" href={packageHref(name)} data-route>see package history</a>
}

// One-line explanations of the kinds of entry a document can carry, so a
// reader knows what they are looking at before the list.
export const ENTRY_TYPES = {
  alert: 'A rule firing: one published pattern matched one package change. A firing is a reason to look, not a verdict.',
  over_threshold: 'A package whose weighted score crossed the alerting bar (default 35, the benign corpus 95th percentile). It carries the version transition and every rule that fired.',
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
 * True when *text* contains *name* as a whole shell token, not as a
 * substring: an unresolved `owner` must not match `ownership`.
 */
function containsToken(text, name) {
  if (!text || !name) return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`).test(text)
}

/** The maintainer and upstream URLs a PKGBUILD declares. */
export function parsePkgbuild(text) {
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
    const m = line.match(/^diff --git a\/.+ b\/(.+)$/) || line.match(/^\+\+\+ b\/(.+)$/)
    if (m && m[1] !== '/dev/null' && !seen.has(m[1])) { seen.add(m[1]); files.push(m[1]) }
  }
  return files
}

/** The removed and added lines of a diff that mention any keyword. */
export function diffValues(diffText, keywords) {
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

/**
 * The source URLs a diff adds and removes. Only `source=` declarations are
 * read, and only the URL in each is kept, so a card shows the old and new
 * upstream rather than every line that merely mentions the word "source".
 */
const SOURCE_DECL = /^\s*source(?:_[a-z0-9_]+)?\s*=/
export function sourceUrlsFromDiff(diffText) {
  const removed = []
  const added = []
  const seen = { '-': new Set(), '+': new Set() }
  for (const raw of String(diffText || '').split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---')) continue
    const sign = raw[0]
    if (sign !== '+' && sign !== '-') continue
    const body = raw.slice(1)
    if (!SOURCE_DECL.test(body)) continue
    for (const m of body.matchAll(/https?:\/\/[^\s'")]+/g)) {
      if (seen[sign].has(m[0])) continue
      seen[sign].add(m[0])
      ;(sign === '-' ? removed : added).push(m[0])
    }
  }
  return { removed, added }
}

/** A line with its version numbers and checksums blanked, for comparison. */
function withoutVersions(line) {  return line
    .replace(/\$\{?pkgver\}?/g, 'V')
    .replace(/\bv?\d+(?:\.\d+)+(?:[-._][0-9A-Za-z]+)*/g, 'V')
    .replace(/\b[0-9a-f]{32,}\b/gi, 'H')
}

/**
 * True when the change is more than a version bump. A source line whose only
 * difference is the version (or a checksum) did not really change, and the
 * card must not say it did.
 */
export function changedBeyondVersion(removed, added) {
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
      const u = sourceUrlsFromDiff(diff)
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
    const batches = chunk(packages, 100)
    Promise.all(batches.map((batch) => (
      fetch(`/api/maintainers?packages=${encodeURIComponent(batch.join(','))}`)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))
    )))
      .then((results) => {
        if (live) setMaintainers(Object.assign({}, ...results.map((body) => body.maintainers || {})))
      })
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
      <h2>Maintainers <span className="count">{ordered.length}</span></h2>
      <ul className="maintainers">
        {ordered.map(([who, pkgs]) => (
          <li className="maintainer" key={who}>
            <span className="maintainer__name">{who}</span>
            <span className="maintainer__count">{pkgs.length} package{pkgs.length === 1 ? '' : 's'}</span>
            <span className="maintainer__pkgs">
              {pkgs.map((p) => (
                <span className="maintainer__pkg" key={p}>
                  <a href={AUR_PACKAGE(p)} target="_blank" rel="noreferrer">{p}</a>
                  <PackageHistoryLink name={p} />
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Packages the analysis could not fully read.
 *
 * Plain-language on purpose: a refusal is a limitation of the static check,
 * not an accusation.  Say what could not be followed, where it is used, and
 * what the reader should do - without the rule-name jargon the payload
 * carries for the catalog pages.
 */
function Refusals({ refusals, diffs }) {
  if (!refusals.length) return null
  return (
    <section className="detail__section">
      <h2>Not fully checked <span className="count">{refusals.length}</span></h2>
      {refusals.map((refusal, i) => {
        const findings = refusal.findings || []
        // X026/X027 both describe the same names; keep each once.
        const seen = new Set()
        const unresolved = findings
          .flatMap((f) => parseUnresolved(f.reason))
          .filter((entry) => {
            const key = `${entry.name}|${entry.func}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
        const names = unresolved.map((entry) => entry.name)
        const funcs = [...new Set(unresolved.map((entry) => entry.func).filter(Boolean))]
        return (
          <article className="pkg" key={`${refusal.package}-${i}`}>
            <header className="pkg__head">
              <a className="pkg__name" href={AUR_PACKAGE(refusal.package)} target="_blank" rel="noreferrer">{refusal.package}</a>
              <PackageHistoryLink name={refusal.package} />
            </header>
            <PartialBanner />
            {unresolved.length && !(findings.length && findings.every(isPartialFinding)) ? (
              <>
                <p className="pkg__meta">
                  TrustSight reads recipes without running them, and this one
                  computes {names.length === 1 ? 'one value' : `${names.length} values`}
                  {' '}in a way the analyser could not follow
                  {funcs.length ? ` (used in ${funcs.map((fn) => `${fn}()`).join(', ')})` : ''}:
                  {' '}{names.map((name, j) => (
                    <span key={name}>
                      {j ? ', ' : ''}<code className="md-code">{name}</code>
                    </span>
                  ))}.
                  Part of the build script was not checked.
                </p>
                <p className="pkg__meta">
                  This is a gap in the check, not a sign of a problem — but it
                  also means a problem in that part would not have been seen.
                  Before installing, open the PKGBUILD and read
                  {funcs.length ? ` ${funcs.map((fn) => `${fn}()`).join(', ')}` : ' the build functions'}
                  {' '}yourself.
                </p>
              </>
            ) : null}
            {findings.length ? (
              <ChangeViews
                packageName={refusal.package}
                findings={findings}
                diff={(diffs && diffs.get(refusal.package)) || undefined}
              />
            ) : null}
            {!unresolved.length && !findings.length ? (
              <>
                <p className="pkg__meta">
                  TrustSight reads recipes without running them, and part of
                  this one could not be read by the automatic check. That is a
                  gap in the check, not a sign of a problem — but a problem in
                  the unread part would not have been seen either.
                </p>
                {refusal.reason ? <p className="pkg__meta">Technical detail: {flattenProse(refusal.reason)}</p> : null}
              </>
            ) : null}
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
function MemberList({ names, details = [], iocPackages }) {
  if (!names.length) return <p className="pkg__meta">No member packages named.</p>
  const byName = new Map(details.map((d) => [d.package, d]))
  return (
    <ul className="campaign-members">
      {names.map((name) => {
        const detail = byName.get(name) || null
        return (
          <li key={name}>
            <a className="member__name" href={AUR_PACKAGE(name)} target="_blank" rel="noreferrer">{name}</a>
            {iocPackages && iocPackages.has(name) ? <span className="badge badge--ioc">IOC match</span> : null}
            <a className="member__pkgbuild" href={AUR_PKGBUILD(name)} target="_blank" rel="noreferrer" title={`PKGBUILD for ${name}`}>PKGBUILD ↗</a>
            <PackageHistoryLink name={name} />
            {detail ? <MemberOwnership detail={detail} /> : null}
          </li>
        )
      })}
    </ul>
  )
}

/** The ownership and version context a campaign member carries, when known. */
function MemberOwnership({ detail }) {
  const current = detail.maintainer || ''
  const previous = detail.previous_maintainer || ''
  const changed = Boolean(previous && current && previous !== current)
  return (
    <span className="member__ownership">
      {current || previous ? (
        <>
          <span className="member__label">maintainer</span>
          {changed ? <MaintainerLink name={previous} /> : null}
          {changed ? ' -> ' : null}
          {current ? <MaintainerLink name={current} /> : null}
          {!current ? <span>orphan</span> : null}
        </>
      ) : null}
      {detail.version ? <span className="member__version">{detail.version}</span> : null}
    </span>
  )
}

/**
 * True for correlation rules (G001–G007): they aggregate across packages, so
 * their alert groups are campaigns and rank ahead of per-package rules.
 */
function isCampaignRule(id) {
  return /^G\d{3}$/.test(String(id || '').toUpperCase())
}

/**
 * Group a flat alert list by rule, so each fired rule owns an alert section
 * and the packages it flagged are listed inside it. A campaign fires the same
 * rule on many packages; grouping by rule keeps that campaign one section.
 * Campaign groups sort before per-package groups; within each tier, severity
 * desc then rule id.
 */
function groupAlerts(alerts) {
  const byRule = new Map()
  const bare = []
  for (const entry of alerts) {
    if (!entry.package) continue
    if (!entry.rule_id) {
      bare.push(entry)
      continue
    }
    if (!byRule.has(entry.rule_id)) byRule.set(entry.rule_id, { rule: entry.rule_id, entries: [] })
    byRule.get(entry.rule_id).entries.push(entry)
  }
  const order = sortRuleIds([...byRule.keys()])
  const rank = (id) => (isCampaignRule(id) ? 0 : 1)
  const rules = [...byRule.values()]
    .map((group) => ({ ...group, packages: [...new Set(group.entries.map((e) => e.package))].sort() }))
    .sort((a, b) => rank(a.rule) - rank(b.rule) || order.indexOf(a.rule) - order.indexOf(b.rule))
  return { rules, bare }
}

/** A maintainer name links to the account's recorded history. */
function MaintainerLink({ name }) {
  if (!name) return null
  return (
    <a className="md-code" href={`/maintainer/${encodeURIComponent(name)}`} data-route>{name}</a>
  )
}

/** The maintainer facts one alert carries, when the watcher recorded them. */
function MaintainerChange({ entry }) {
  const current = entry.new || entry.maintainer || ''
  const previous = typeof entry.old === 'string' ? entry.old : ''
  if (!current && !previous) return null
  const changed = Boolean(previous && current && previous !== current)
  return (
    <p className="pkg__meta pkg__meta--owner">
      Maintainer{' '}
      {changed ? <MaintainerLink name={previous} /> : null}
      {changed ? ' -> ' : null}
      {current ? <MaintainerLink name={current} /> : null}
      {!current ? <span>orphan</span> : null}
      {previous && !current ? <span> (was <code className="md-code">{previous}</code>)</span> : null}
    </p>
  )
}

/** The arithmetic behind an over-threshold package, without hiding the inputs. */
function ScoreBreakdown({ pkg }) {
  const findings = Array.isArray(pkg.findings) ? pkg.findings : []
  if (!findings.length) return null
  const sum = findings.reduce((total, finding) => total + (Number(finding.weight) || 0), 0)
  return (
    <details className="history-item__findings">
      <summary>Why this score</summary>
      <p className="pkg__meta">
        The weighted findings sum to <strong>{sum}</strong>. A zero-weight finding is context,
        not arithmetic. The alerting bar is a review threshold, not a safety verdict.
      </p>
      <ul className="findings">
        {findings.map((finding, i) => (
          <li className="finding" key={`${finding.rule_id}-${i}`}>
            <div className="finding__head">
              <RuleChip id={finding.rule_id} />
              <span className="finding__loc">weight {Number(finding.weight) || 0}</span>
            </div>
            {finding.reason ? <p className="finding__reason">{renderInlineCode(flattenProse(finding.reason))}</p> : null}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** The boundary every page repeats: evidence, not a certificate. */
export function LimitsNote() {
  return (
    <section className="detail__section">
      <h2>What this does not prove</h2>
      <p className="detail__explain">
        TrustSight reads recipes; it never runs them and never fetches a URL a package declares.
        A notification means a published rule matched the change that was examined. It is not a
        verdict, and no notification is permission to install. A clean result means no rule
        matched, not that the package is safe.
      </p>
    </section>
  )
}

/** One bare-alert package, with the ownership detail the entry records. */
function AlertPackage({ entry, iocPackages }) {
  return (
    <article className={`pkg alert-package${iocPackages.has(entry.package) ? ' pkg--ioc' : ''}`}>
      <header className="pkg__head">
        <a className="pkg__name" href={AUR_PACKAGE(entry.package)} target="_blank" rel="noreferrer">{entry.package}</a>
        {iocPackages.has(entry.package) ? <span className="badge badge--ioc">IOC match</span> : null}
        <PackageHistoryLink name={entry.package} />
        <a className="pkg__action" href={AUR_PKGBUILD(entry.package)} target="_blank" rel="noreferrer">See PKGBUILD ↗</a>
      </header>
      <MaintainerChange entry={entry} />
      {entry.dependency ? (
        <p className="pkg__meta">
          depends on <a className="md-code" href={packageHref(entry.dependency)} data-route>{entry.dependency}</a>,
          which was adopted or orphaned this cycle
        </p>
      ) : null}
      <ChangeViews
        packageName={entry.package}
        findings={[]}
        diff={entry.diff}
        diffSha={entry.pkgbuild_sha256 || entry.diff_sha256}
        diffTruncated={entry.diff_truncated}
        defaultView="diff"
      />
    </article>
  )
}

function AlertList({ alerts, overPackages, iocPackages, campaigns = [] }) {
  if (!alerts.length) return null
  // A package that also crossed the threshold is rendered once, in full, by
  // the over-threshold section below - so it is not repeated here.  Its rule
  // firings are still named there through the located findings.
  const { rules: allRules, bare } = groupAlerts(alerts)
  const hidden = new Set()
  const groups = allRules
    .map((group) => ({
      ...group,
      entries: group.entries.filter((e) => (overPackages.has(e.package) ? (hidden.add(e.package), false) : true)),
    }))
    .map((group) => ({ ...group, packages: [...new Set(group.entries.map((e) => e.package))].sort() }))
    .filter((group) => group.entries.length)
  const bareVisible = bare.filter((entry) => {
    if (overPackages.has(entry.package)) {
      hidden.add(entry.package)
      return false
    }
    return true
  })
  const alsoOver = hidden.size
  return (
    <section className="detail__section">
      <h2>New alerts <span className="count">{alerts.length}</span></h2>
      {alsoOver ? (
        <p className="detail__explain">
          {alsoOver === 1 ? '1 package is' : `${alsoOver} packages are`} also over threshold, shown in full below.
        </p>
      ) : null}
      {groups.map((group) => (
        <article className="pkg" key={group.rule}>
          <header className="pkg__head">
            <RuleChip id={group.rule} />
            <span className="pkg__version">{group.packages.length} package{group.packages.length === 1 ? '' : 's'}</span>
          </header>
          {(() => {
            const common = campaignCommon(campaigns.find((cluster) => cluster.rule_id === group.rule))
            return common ? (
              <p className="pkg__meta campaign__common">
                {common.label}: <code className="md-code">{common.value}</code>
              </p>
            ) : null
          })()}
          <div className="alert__rules">
            <RuleSection id={group.rule} />
          </div>
          {group.entries.some((e) => e.old || e.new) ? (
            <div className="alert__packages">
              {group.entries.map((entry, i) => (
                <AlertPackage entry={entry} iocPackages={iocPackages} key={`${entry.package}-${i}`} />
              ))}
            </div>
          ) : (
            <MemberList names={group.packages} iocPackages={iocPackages} />
          )}
        </article>
      ))}
      {bareVisible.map((entry, i) => (
        <AlertPackage entry={entry} iocPackages={iocPackages} key={`${entry.package}-${i}`} />
      ))}
    </section>
  )
}

/** Every finding the watcher sent, each with the file and line it fired on. */
/**
 * Split a finding reason into its prose and a trailing diff line. Many reasons
 * end in the matched source line, e.g.
 * `... Outside Package Root: + chmod 4755 /opt/Haven/chrome-sandbox`; that line
 * belongs in a code block colored like the diff it came from, not in the prose.
 */
function splitReason(reason) {
  if (!reason) return { text: '', diff: '' }
  const m = reason.match(/(?:^|:\s)([+-]\s*\S[^\n]*)$/)
  if (!m) return { text: flattenProse(reason), diff: '' }
  return { text: flattenProse(reason.slice(0, m.index).replace(/:\s*$/, '')), diff: m[1].trim() }
}

function diffLineClass(diff) {
  if (diff.startsWith('+++') || diff.startsWith('---')) return 'finding__diff--meta'
  if (diff.startsWith('+')) return 'finding__diff--add'
  if (diff.startsWith('-')) return 'finding__diff--del'
  return ''
}

// The rules that report the same fact three ways: some assignments could not
// be traced, so part of the recipe was not read.
const PARTIAL_RULES = new Set(['X026', 'X027', 'W008'])

function isPartialFinding(f) {
  if (PARTIAL_RULES.has(String(f.rule_id || '').toUpperCase())) return true
  return /unresolved assignment/i.test(String(f.reason || ''))
}

/**
 * The unresolved variables of the partial-analysis family: names with the
 * function that references them, parsed from the `name <- func` pairs an
 * X026 reason carries.
 */
function parsePartialVars(findings) {
  const byName = new Map()
  for (const f of findings) {
    for (const entry of parseUnresolved(f.reason)) {
      if (!entry.name) continue
      if (!byName.has(entry.name) || (!byName.get(entry.name) && entry.func)) {
        byName.set(entry.name, entry.func || '')
      }
    }
  }
  return [...byName.entries()].map(([name, func]) => ({ name, func }))
}

/** Plain-language banner for an alert whose analysis was inconclusive. */
function PartialBanner() {
  return (
    <p className="partial-banner">
      Inconclusive analysis: TrustSight&rsquo;s static analysis could not fully resolve this package.
      This is not a malware verdict; it means a human review is needed.
    </p>
  )
}

/**
 * One plain-language card for every partial-analysis finding (X026/X027/W008)
 * in a package: they describe the same unresolved set, so they merge into a
 * single summary with the raw analyzer strings behind a details toggle.
 */
function PartialAnalysisCard({ findings }) {
  const vars = parsePartialVars(findings)
  const funcs = [...new Set(vars.map((v) => v.func).filter(Boolean))]
  return (
    <div className="partial">
      <p className="partial__head">
        <strong>
          {vars.length
            ? `Partial analysis: ${vars.length} variable${vars.length === 1 ? '' : 's'} could not be traced`
            : 'Partial analysis: part of this recipe could not be read'}
        </strong>
      </p>
      {vars.length ? (
        <p className="partial__body">
          The analyzer could not determine where{' '}
          {vars.map((v, i) => (
            <span key={v.name}>
              {i ? ', ' : ''}<code className="md-code">{v.name}</code>
            </span>
          ))}{' '}
          {vars.length === 1 ? 'is' : 'are'} set
          {funcs.length ? (
            <>
              {'; '}{vars.length === 1 ? 'it is' : 'they are'} referenced from{' '}
              {funcs.map((fn, i) => (
                <span key={fn}>
                  {i ? ', ' : ''}<code className="md-code">{fn}()</code>
                </span>
              ))}{' '}
              in the PKGBUILD
            </>
          ) : null}
          . This usually means indirect or dynamic assignment (often terminal color helpers).{' '}
          <strong>Not a verdict</strong>: a human should look at the PKGBUILD.
        </p>
      ) : null}
      <details className="partial__details">
        <summary>Technical details</summary>
        <ul className="partial__raw">
          {findings.map((f, i) => (
            <li key={`${f.rule_id}-${i}`}>
              <RuleChip id={f.rule_id} /> <span className="partial__rawreason">{flattenProse(f.reason)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}

export function Findings({ findings }) {
  if (!findings || !findings.length) return null
  // The partial-analysis family (X026/X027/W008) is one fact said three ways;
  // merge it into a single card and render the remaining findings as usual.
  const partial = findings.filter(isPartialFinding)
  const rest = findings.filter((f) => !isPartialFinding(f))
  return (
    <>
      {partial.length ? <PartialAnalysisCard findings={partial} /> : null}
      {rest.length ? (
    <ul className="findings">
      {rest.map((f, i) => {
        const loc = locationLabel(f)
        const rule = ruleInfo(f.rule_id)
        const unresolved = parseUnresolved(f.reason)
        const sev = String(f.severity || 'info').toLowerCase()
        const { text: reasonText, diff } = splitReason(f.reason)
        return (
          <li className={`finding finding--${sev}`} key={`${f.rule_id}-${i}`}>
            <div className="finding__head">
              <RuleChip id={f.rule_id} />
              {loc
                ? <span className="finding__loc">{loc}</span>
                : <span className="finding__loc finding__loc--none" title="This signal names a fact about the change, not a line">no line</span>}
            </div>
            {reasonText ? <p className="finding__reason">{renderInlineCode(reasonText)}</p> : null}
            {diff ? <pre className={`finding__diff ${diffLineClass(diff)}`}>{diff}</pre> : null}
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
      ) : null}
    </>
  )
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A host or file name is flagged as the whole URL or path it sits in
// (`git+https://host/x.git`), not the bare host.
const tokenPattern = (t) => (/\./.test(t) && !/\s/.test(t)
  ? `[^\\s'"()]*${escapeRe(t)}[^\\s'"()]*`
  : escapeRe(t))

/**
 * The exact strings a finding names in its reason (a host, a quoted token), so
 * the source view can mark just those instead of the whole line.
 */
function flagTokens(f) {
  const { text } = splitReason(f.reason)
  const tokens = new Set()
  for (const m of text.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)) tokens.add(m[1] || m[2] || m[3])
  for (const m of text.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi)) tokens.add(m[0])
  return [...tokens].filter((t) => t.length >= 3)
}

/** Split *text* into plain strings and <mark> spans for every *re* match. */
function markText(text, re) {
  if (!re) return text
  const out = []
  let last = 0
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) { re.lastIndex++; continue }
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(<mark className="source__mark" key={m.index}>{m[0]}</mark>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * Map each 1-based line to the logical shell statement that holds it, so a
 * finding on `source=(...` highlights every line of the array, not just the
 * first. A statement continues across lines while a quote or `(` is open, or
 * after a trailing backslash.
 */
function statementSpans(lines) {
  const spans = new Map()
  let start = 0
  let depth = 0
  let quote = ''
  lines.forEach((text, i) => {
    if (!depth && !quote && start === 0) start = i + 1
    let cont = false
    for (let c = 0; c < text.length; c++) {
      const ch = text[c]
      if (quote) {
        if (ch === '\\' && quote === '"') c++
        else if (ch === quote) quote = ''
      } else if (ch === '\\') {
        if (c === text.length - 1) cont = true
        else c++
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '#' && (c === 0 || /\s/.test(text[c - 1]))) break
      else if (ch === '(') depth++
      else if (ch === ')' && depth) depth--
    }
    if (depth || quote || cont) return
    for (let n = start; n <= i + 1; n++) spans.set(n, [start, i + 1])
    start = 0
  })
  if (start) for (let n = start; n <= lines.length; n++) spans.set(n, [start, lines.length])
  return spans
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
  const spans = statementSpans(lines)
  const spanOf = (n) => spans.get(n) || [n, n]
  const byLine = new Map()
  for (const f of findings) {
    if (f.file !== file || !f.line) continue
    const key = spanOf(f.line)[0]
    if (!byLine.has(key)) byLine.set(key, [])
    byLine.get(key).push(f)
  }
  // An unresolved construct has no line in the finding, so find it by name in
  // the source and flag the line that references it.
  const names = unresolvedNames(findings)
  const unresolvedLines = new Set()
  if (names.size) {
    const carriers = findings.filter((f) => parseUnresolved(f.reason).length)
    lines.forEach((text, i) => {
      if (!text || ![...names].some((name) => containsToken(text, name))) return
      const key = spanOf(i + 1)[0]
      unresolvedLines.add(key)
      if (!byLine.has(key)) byLine.set(key, [])
      for (const f of carriers) {
        if (!byLine.get(key).some((h) => h.rule_id === f.rule_id)) byLine.get(key).push(f)
      }
    })
  }

  // Per flagged statement: a regex over the strings its findings name, and
  // whether any of them actually appears in its lines. Without a match the
  // whole row stays tinted, since the finding names no narrower text.
  const marks = new Map()
  for (const [key, hits] of byLine) {
    const tokens = new Set(hits.flatMap(flagTokens))
    if (unresolvedLines.has(key)) names.forEach((n) => tokens.add(n))
    const re = tokens.size
      ? new RegExp(`(?<![A-Za-z0-9_])(?:${[...tokens].sort((a, b) => b.length - a.length).map(tokenPattern).join('|')})(?![A-Za-z0-9_])`, 'gi')
      : null
    const [first, last] = spanOf(key)
    let found = false
    if (re) for (let n = first; n <= last && !found; n++) { re.lastIndex = 0; found = re.test(lines[n - 1] || '') }
    marks.set(key, { re: found ? re : null, found })
  }

  // Findings on this file with no line to point at (a missing checksum, an
  // unread construct): named here, since the code cannot highlight them.
  const fileNoLine = findings.filter((f) => f.file === file && !f.line)

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
            {lines.map((text, i) => {
              const lineNo = i + 1
              const [first] = spanOf(lineNo)
              const hits = byLine.get(first)
              const mark = marks.get(first)
              const tint = hits && !(mark && mark.found)
              const cls = `source__line${hits ? ' source__line--hit' : ''}${tint ? ' source__line--tint' : ''}${tint && unresolvedLines.has(first) ? ' source__line--unresolved' : ''}`
              return (
                <div className={cls} key={lineNo} title={hits ? hits.map((h) => h.reason).filter(Boolean).join(' | ') : undefined}>
                  <span className="source__no">{lineNo}</span>
                  <span className="source__text">
                    {text ? markText(text, mark && mark.re) : ' '}
                    {hits && first === lineNo ? (
                      <span className="source__hits">
                        {hits.map((h, j) => <RuleChip key={`${h.rule_id}-${j}`} id={h.rule_id} />)}
                      </span>
                    ) : null}
                  </span>
                </div>
              )
            })}
          </div>
          {fileNoLine.length ? (
            <p className="source__note">
              Flagged in this file, with no single line to point at:
              {' '}<span className="source__hits">{fileNoLine.map((f, i) => <RuleChip key={`${f.rule_id}-${i}`} id={f.rule_id} />)}</span>
            </p>
          ) : null}
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
 * A unified diff as files of rows with old and new line numbers. Header lines
 * (index, ---, +++) are dropped; rename, new-file and mode lines become a note
 * on the file.
 */
export function parseDiff(text) {
  const files = []
  let file = null
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0
  let newLeft = 0
  const begin = (name = '', oldName = '') => {
    file = { name, oldName, add: 0, del: 0, note: '', rows: [] }
    files.push(file)
  }
  for (const line of text.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) continue
      if (line.startsWith('+')) {
        file.rows.push({ type: 'add', new: newNo++, text: line.slice(1) })
        file.add++
        newLeft--
        continue
      }
      if (line.startsWith('-')) {
        file.rows.push({ type: 'del', old: oldNo++, text: line.slice(1) })
        file.del++
        oldLeft--
        continue
      }
      if (line.startsWith(' ')) {
        file.rows.push({ type: 'ctx', old: oldNo++, new: newNo++, text: line.slice(1) })
        oldLeft--
        newLeft--
        continue
      }
      oldLeft = 0
      newLeft = 0
    }
    const head = line.match(/^diff --git a\/.+ b\/(.+)$/)
    if (head) {
      begin(head[1], head[1])
      continue
    }
    // Stored notification diffs may be a plain unified diff with no
    // `diff --git` line; the `---`/`+++` pair still names the file.
    const oldHead = line.match(/^--- (?:a\/)?(.+)$/)
    if (oldHead) {
      if (!(file && file.name && !file.rows.length)) begin('', oldHead[1])
      continue
    }
    const newHead = line.match(/^\+\+\+ (?:b\/)?(.+)$/)
    if (newHead) {
      if (file && !file.name) {
        file.name = newHead[1] === '/dev/null' ? (file.oldName || 'file') : newHead[1]
      }
      continue
    }
    if (!file) continue
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s*(.*)$/)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[3])
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
      file.rows.push({ type: 'hunk', text: hunk[5] || '' })
      continue
    }
    if (/^index /.test(line)) continue
    const note = line.match(/^(new file|deleted file|rename (?:from|to)|similarity|old mode|new mode)\b(.*)$/)
    if (note) {
      file.note = file.note || (note[1] === 'new file' ? 'new file' : note[1] === 'deleted file' ? 'deleted' : 'renamed')
      continue
    }
  }
  return files
    .filter((f) => f.rows.length)
    .map((f) => (f.name ? f : { ...f, name: f.oldName || 'file' }))
}

/**
 * The latest AUR commit as a unified diff. This is where a removed construct
 * shows: the deleted lines are rendered red and the added ones green, so what
 * disappeared from the recipe is visible even when the current file no longer
 * contains it.
 */
function DiffView({ packageName, diff, diffSha, diffTruncated }) {
  const stored = diff !== undefined || Boolean(diffTruncated) || Boolean(diffSha)
  const [state, setState] = useState(() => stored ? { diff: String(diff || '') } : { loading: true })

  useEffect(() => {
    if (stored) {
      setState({ diff: String(diff || '') })
      return undefined
    }
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
  }, [packageName, diff, stored])

  const files = parseDiff(state.diff || '')
  const added = files.reduce((n, f) => n + f.add, 0)
  const removed = files.reduce((n, f) => n + f.del, 0)

  return (
    <div className="diff">
      {stored ? (
        <p className="pkg__meta diff__source">
          The change the watcher analysed
          {diffSha ? <> &middot; <code className="md-code">{String(diffSha).slice(0, 12)}</code></> : null}
          {diffTruncated ? '. The diff was too large to include.' : null}
        </p>
      ) : null}
      {state.loading ? <p className="pkg__meta">Loading diff…</p> : null}
      {state.error ? <p className="feed-error">Could not load the diff: {state.error}</p> : null}
      {state.diff !== undefined && !files.length && !diffTruncated ? (
        <p className="pkg__meta">{stored ? 'The analysed change recorded no diff.' : 'No diff for the latest commit.'}</p>
      ) : null}
      {files.length ? (
        <>
          <p className="diff__summary">
            {files.length} file{files.length === 1 ? '' : 's'} changed
            <span className="diff__stat diff__stat--add">+{added}</span>
            <span className="diff__stat diff__stat--del">&minus;{removed}</span>
          </p>
          {files.map((file) => (
            <section className="diff__file" key={file.name}>
              <header className="diff__file-head">
                <span className="diff__file-name">{file.name}</span>
                {file.note ? <span className="diff__file-note">{file.note}</span> : null}
                <span className="diff__stat diff__stat--add">+{file.add}</span>
                <span className="diff__stat diff__stat--del">&minus;{file.del}</span>
              </header>
              <div className="diff__code">
                {file.rows.map((row, i) => (
                  row.type === 'hunk' ? (
                    <div className="diff__row diff__row--hunk" key={i}>
                      <span className="diff__no" /><span className="diff__no" /><span className="diff__sign" />
                      <span className="diff__text">{row.text}</span>
                    </div>
                  ) : (
                    <div className={`diff__row diff__row--${row.type}`} key={i}>
                      <span className="diff__no">{row.old ?? ''}</span>
                      <span className="diff__no">{row.new ?? ''}</span>
                      <span className="diff__sign">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}</span>
                      <span className="diff__text">{row.text || ' '}</span>
                    </div>
                  )
                ))}
              </div>
            </section>
          ))}
        </>
      ) : null}
    </div>
  )
}

/** One package's change: Findings, Source and Diff, in one tabbed view. */
export function ChangeViews({
  packageName, findings = [], diff, diffSha, diffTruncated, defaultView,
}) {
  const [view, setView] = useState(defaultView || (findings.length ? 'findings' : 'diff'))
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
          ? <DiffView packageName={packageName} diff={diff} diffSha={diffSha} diffTruncated={diffTruncated} />
          : findings.length
            ? <Findings findings={findings} />
            : <p className="pkg__meta">This entry carries no line-located finding. Open the Diff tab to read the change.</p>}
    </>
  )
}

function CalibrationNote() {
  return (
    <p className="detail__explain">
      TrustSight is calibrated, but false-positive tuning is ongoing. A hit on a genuine bad
      practice is a real finding, not a rule bug. If a rule fired with no bad practice or
      malicious behavior behind it,{' '}
      <a href={FP_ISSUE} target="_blank" rel="noreferrer">report the bad rule trigger</a>.
      Read <a href={FP_DOCS} target="_blank" rel="noreferrer">the distinction</a>.
    </p>
  )
}

function PackageSections({ packages, iocPackages }) {
  if (!packages.length) return null
  return (
    <section className="detail__section">
      <h2>Packages over threshold <span className="count">{packages.length}</span></h2>
      {packages.map((pkg) => {
        const findings = pkg.findings || []
        // A rule that has a located finding is already named and explained by
        // its finding row (the chip explains the rule on hover, or on tap on a
        // phone).  Only rules with no located finding need a card, so a rule is
        // never rendered twice.
        const foundRules = new Set(findings.map((f) => f.rule_id))
        const rules = [...new Set(pkg.rules || [])].filter((id) => !foundRules.has(id))
        return (
          <article className={`pkg${iocPackages.has(pkg.package) ? ' pkg--ioc' : ''}`} key={pkg.package}>
            <header className="pkg__head">
              <a className="pkg__name" href={AUR_PACKAGE(pkg.package)} target="_blank" rel="noreferrer">{pkg.package}</a>
              {pkg.version ? <span className="pkg__version">{pkg.version}</span> : null}
              {iocPackages.has(pkg.package) ? <span className="badge badge--ioc">IOC match</span> : null}
              {pkg.score !== undefined && pkg.score !== null ? <span className="badge badge--alerts">score {pkg.score}</span> : null}
              <PackageHistoryLink name={pkg.package} />
              <a className="pkg__action" href={AUR_PKGBUILD(pkg.package)} target="_blank" rel="noreferrer">See PKGBUILD ↗</a>
              <a className="pkg__action" href={fpIssueUrl(pkg.package, [...(pkg.rules || []), ...findings.map((f) => f.rule_id)])} target="_blank" rel="noreferrer">Report bad rule trigger ↗</a>
            </header>
            {pkg.last_modified ? <p className="pkg__meta">AUR change: {pkg.last_modified}</p> : null}
            {findings.some(isPartialFinding) ? <PartialBanner /> : null}
            <ContextBlock packageName={pkg.package} findings={findings} />
            {findings.length ? (
              <ChangeViews
                packageName={pkg.package}
                findings={findings}
                diff={pkg.diff}
                diffSha={pkg.pkgbuild_sha256 || pkg.diff_sha256}
                diffTruncated={pkg.diff_truncated}
              />
            ) : (
              <ChangeViews
                packageName={pkg.package}
                findings={[]}
                diff={pkg.diff}
                diffSha={pkg.pkgbuild_sha256 || pkg.diff_sha256}
                diffTruncated={pkg.diff_truncated}
                defaultView="diff"
              />
            )}
            <ScoreBreakdown pkg={pkg} />
            {rules.length ? (
              <div className="rule-sections">
                {sortRuleIds(rules).map((id) => <RuleSection key={id} id={id} />)}
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
    <section className="detail__section detail__section--ioc">
      <h2>Indicators of compromise <span className="count">{matches.length}</span></h2>
      <p className="pkg__meta">
        Export: <a href="/api/iocs?format=json">JSON</a>, <a href="/api/iocs?format=csv">CSV</a>,
        {' '}<a href="/api/iocs?format=stix">STIX 2.1</a>.
      </p>
      <div className="ioc-list">
        {matches.map((m, i) => (
          <div className="ioc-row" key={`${m.package}-${i}`}>
            <span className="badge badge--ioc">IOC match</span>
            <a className="pkg__name" href={AUR_PACKAGE(m.package)} target="_blank" rel="noreferrer">{m.package}</a>
            <PackageHistoryLink name={m.package} />
            {m.indicator ? <code className="ioc-row__indicator">{m.indicator}</code> : null}
          </div>
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
      <h2>Campaigns <span className="count">{total}</span></h2>
      {impersonation.map((camp, i) => {
        const members = camp.members || []
        return (
          <article className="pkg campaign" key={`imp-${i}`}>
            <header className="pkg__head">
              <span className="badge badge--imp">impersonation campaign</span>
              <span className="pkg__version">Submitted by {camp.maintainer || 'one account'}</span>
            </header>
            {camp.targets && camp.targets.length
              ? (
                <div className="impersonates">
                  <span className="impersonates__label">Impersonating</span>
                  {camp.targets.map((t) => (
                    <span className="impersonates__pkg" key={t}>
                      <a className="impersonates__target" href={`https://aur.archlinux.org/packages?K=${encodeURIComponent(t)}&SeB=n`} target="_blank" rel="noreferrer">{t}</a>
                      <PackageHistoryLink name={t} />
                    </span>
                  ))}
                </div>
              )
              : null}
            <h3 className="campaign__subhead">Flagged packages <span className="count">{members.length}</span></h3>
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
              {(() => {
                const id = cluster.campaign_id || campaignEvents({ campaign_cluster: [cluster] })[0]?.campaign_id
                return id ? <a className="pkg__history" href={`/campaign/${encodeURIComponent(id)}`} data-route>campaign page</a> : null
              })()}
            </header>
            {(() => {
              const common = campaignCommon(cluster)
              return common ? (
                <p className="pkg__meta campaign__common">
                  {common.label}: <code className="md-code">{common.value}</code>
                </p>
              ) : null
            })()}
            <h3 className="campaign__subhead">Flagged packages <span className="count">{members.length}</span></h3>
            <MemberList names={members} details={cluster.members_detail || []} />
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
  const [fpCopied, setFpCopied] = useState(false)

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
  // The document may carry the analysed diff on a bare alert or an over-threshold
  // package; keep whichever record has one so every tab can show the same revision.
  const diffs = new Map()
  for (const entry of [...alerts, ...packages]) {
    if (entry && entry.package && entry.diff !== undefined) diffs.set(entry.package, entry.diff)
  }
  const ioc = payload.ioc_matches || []
  const iocPackages = new Set(ioc.map((m) => m.package))
  const allPackages = [...new Set([
    ...alerts.map((a) => a.package),
    ...packages.map((p) => p.package),
    ...ioc.map((m) => m.package),
    ...alertingClusters(payload).flatMap((c) => c.members || []),
    ...(payload.impersonation || []).flatMap((c) => c.members || []),
    ...(payload.refusals || []).map((r) => r.package),
  ].filter(Boolean))]
  // H046 names a dependency the package did not change; it is exposure, not an
  // update.  Keep those dependents out of the maintainer roll-up (and out of
  // its RPC fan-out) unless the same package also changed or is in a cluster.
  const dependencyOnly = new Set(
    alerts.filter((a) => a.rule_id === 'H046').map((a) => a.package),
  )
  const changedPackages = new Set([
    ...overPackages,
    ...iocPackages,
    ...alerts.filter((a) => a.rule_id !== 'H046').map((a) => a.package),
    ...alertingClusters(payload).flatMap((c) => c.members || []),
    ...(payload.impersonation || []).flatMap((c) => c.members || []),
  ])
  for (const name of changedPackages) dependencyOnly.delete(name)
  const maintainerPackages = allPackages.filter((name) => !dependencyOnly.has(name))
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

  const fpRuleIds = [...new Set([
    ...alerts.map((a) => a.rule_id).filter(Boolean),
    ...packages.flatMap((p) => [
      ...(p.rules || []),
      ...(p.findings || []).map((f) => f.rule_id),
    ]),
  ].filter(Boolean))]

  async function copyFpReport() {
    try {
      await navigator.clipboard.writeText(fpIssueBody({
        slug,
        packages: allPackages,
        ruleIds: fpRuleIds,
        payload,
        toolVersion: data ? data.tool_version : '',
      }))
      setFpCopied(true)
      setTimeout(() => setFpCopied(false), 2000)
    } catch {
      setFpCopied(false)
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
            <h1>{flattenProse(data.headline || data.title || '(untitled notification)')}</h1>
            <div className="detail__meta">
              <span title="Your local time with its offset, then UTC">{formatTime(data.time)}</span>
              <span>{relative(data.time)}</span>
              <span className={eventBadgeClass(data.event)}>{eventLabel(data.event)}</span>
              {data.tool_version
                ? <span className="badge badge--version" title="TrustSight version that produced this analysis">TrustSight {data.tool_version}</span>
                : null}
              {ioc.length ? <span className="badge badge--ioc">IOC match</span> : null}
              <a href={NTFY} target="_blank" rel="noreferrer">ntfy channel ↗</a>
              <button type="button" className="pkg__action" onClick={() => navigator.clipboard?.writeText(window.location.href)}>Copy permalink</button>
            </div>

            {payload.cycle ? (
              <div className="masthead-stats detail__stats">
                <div><b>{payload.cycle.added}</b>Added</div>
                <div><b>{payload.cycle.changed}</b>Changed</div>
                <div><b>{payload.cycle.removed}</b>Removed</div>
                <div><b>{payload.cycle.processed}</b>Processed</div>
              </div>
            ) : null}

            {data.event === 'trustsight.alerts' ? <CalibrationNote /> : null}
            <MaintainersSection packages={maintainerPackages} />
            <Refusals refusals={payload.refusals || []} diffs={diffs} />
            <IocSection matches={ioc} />
            <Campaigns payload={payload} />
            <AlertList alerts={alerts} overPackages={overPackages} iocPackages={iocPackages} campaigns={alertingClusters(payload)} />
            <PackageSections packages={packages} iocPackages={iocPackages} />

            {!alerts.length && !packages.length && !ioc.length && !alertingClusters(payload).length && !(payload.impersonation || []).length && !(payload.refusals || []).length ? (
              <p className="feed-empty">This document carries no alerts, packages, indicators or campaigns.</p>
            ) : null}

            <LimitsNote />

            <section className="detail__section">
              <h2>Raw document</h2>
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
                <button
                  type="button"
                  className="load-more"
                  onClick={copyFpReport}
                  aria-label="Copy a false-positive issue body for this alert"
                >
                  {fpCopied ? 'Copied ✓' : 'Copy FP report'}
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
