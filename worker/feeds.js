// Syndication projections of the existing alert feed.  Both are pure functions
// over the same item list `/api/feed` returns, so a subscription cannot drift
// from the page.  Every value is untrusted; XML is escaped and JSON is built
// as data, never as an HTML string.

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function entryUrl(baseUrl, item) {
  return `${baseUrl}/${String(item.slug || '').replace(/^\/+/, '')}/`
}

function entrySummary(item) {
  const parts = []
  if (item.headline || item.title) parts.push(item.headline || item.title)
  if ((item.packages || []).length) parts.push(`Packages: ${item.packages.join(', ')}`)
  if ((item.rules || []).length) parts.push(`Rules: ${item.rules.join(', ')}`)
  return parts.join(' | ')
}

export function atomFeed(items, options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '')
  const feedUrl = `${baseUrl}/api/feed.atom`
  const updated = items.length && items[0].time
    ? new Date(items[0].time * 1000).toISOString()
    : new Date().toISOString()
  const entries = items.map((item) => {
    const url = entryUrl(baseUrl, item)
    const summary = escapeXml(entrySummary(item))
    const categories = [
      ...(item.rules || []).map((id) => `    <category term="${escapeXml(id)}"/>\n`),
      ...(item.packages || []).map((name) => `    <category term="package:${escapeXml(name)}"/>\n`),
    ].join('')
    return [
      '  <entry>',
      `    <id>${escapeXml(url)}</id>`,
      `    <title>${escapeXml(item.headline || item.title || 'Untitled notification')}</title>`,
      `    <link href="${escapeXml(url)}"/>`,
      `    <updated>${new Date((item.time || 0) * 1000).toISOString()}</updated>`,
      categories ? categories.trimEnd() : '',
      `    <summary type="text">${summary}</summary>`,
      '  </entry>',
    ].filter(Boolean).join('\n')
  }).join('\n')
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeXml(feedUrl)}</id>`,
    `  <title>${escapeXml(options.title || 'TrustSight AUR watcher')}</title>`,
    `  <link rel="self" href="${escapeXml(feedUrl)}"/>`,
    `  <link rel="alternate" href="${escapeXml(`${baseUrl}/`)}"/>`,
    `  <updated>${updated}</updated>`,
    '  <author><name>TrustSight</name></author>',
    entries,
    '</feed>',
    '',
  ].filter(Boolean).join('\n')
}

export function jsonFeed(items, options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '')
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: options.title || 'TrustSight AUR watcher',
    home_page_url: `${baseUrl}/`,
    feed_url: `${baseUrl}/api/feed.json`,
    description: 'Alerts from the TrustSight AUR watcher. Evidence, not a verdict.',
    items: items.map((item) => ({
      id: entryUrl(baseUrl, item),
      url: entryUrl(baseUrl, item),
      title: item.headline || item.title || 'Untitled notification',
      content_text: entrySummary(item),
      date_published: new Date((item.time || 0) * 1000).toISOString(),
      tags: [...(item.rules || []), ...(item.packages || [])],
    })),
  }
}
