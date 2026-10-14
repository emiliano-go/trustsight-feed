import { useEffect, useState } from 'preact/hooks'
import { App } from './App.jsx'
import { Message } from './Message.jsx'
import { RuleModal } from './RuleModal.jsx'

const DETAIL_RE = /^\d{4}-\d{2}-\d{2}\/\d{6}/

function parseRoute(pathname) {
  const clean = pathname.replace(/^\/+|\/+$/g, '')
  if (DETAIL_RE.test(clean)) return { view: 'message', slug: clean }
  return { view: 'feed', slug: '' }
}

/**
 * Tiny path router for two views. Internal links carry `data-route`; the
 * click handler pushes history and re-renders, and the SPA fallback serves
 * the shell for a full page load of a detail URL.
 */
export function Router() {
  const [route, setRoute] = useState(parseRoute(window.location.pathname))

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname))
    const onClick = (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = event.target.closest && event.target.closest('a[data-route]')
      if (!link) return
      const href = link.getAttribute('href')
      if (!href || !href.startsWith('/')) return
      event.preventDefault()
      window.history.pushState({}, '', href)
      setRoute(parseRoute(href))
      window.scrollTo(0, 0)
    }
    window.addEventListener('popstate', onPop)
    document.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('popstate', onPop)
      document.removeEventListener('click', onClick)
    }
  }, [])

  return (
    <>
      {route.view === 'message' ? <Message slug={route.slug} /> : <App />}
      <RuleModal />
    </>
  )
}
