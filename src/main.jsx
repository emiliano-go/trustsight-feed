import { render } from 'preact'
import './base.css'
import './feed.css'
import { Router } from './Router.jsx'

const root = document.documentElement
const THEME_KEY = 'ts-theme'

function saved(key) {
  try { return localStorage.getItem(key) } catch { return null }
}

function persist(key, value) {
  try { localStorage.setItem(key, value) } catch {}
}

function hasStoredTheme() {
  const v = saved(THEME_KEY)
  return v === 'light' || v === 'dark'
}

function systemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function setTheme(theme, remember = true) {
  root.dataset.theme = theme
  const dark = theme === 'dark'
  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.classList.toggle('is-dark', dark)
    button.setAttribute('aria-checked', String(dark))
    button.querySelector('[data-theme-sun]')?.classList.toggle('is-active', !dark)
    button.querySelector('[data-theme-moon]')?.classList.toggle('is-active', dark)
  })
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = dark ? '#0D1117' : '#FBFBF9'
  if (remember) persist(THEME_KEY, theme)
}

function setPreference(kind, value) {
  if (kind === 'font-size') root.dataset.fontSize = value
  else root.dataset.contrast = value
  persist(`ts-${kind}`, value)
  document.querySelectorAll(`[data-${kind}]`).forEach((button) => {
    const active = button.dataset[kind] === value
    button.classList.toggle('is-on', active)
    button.setAttribute('aria-pressed', String(active))
  })
}

function selectPreference(kind, value) {
  document.querySelectorAll(`[data-${kind}]`).forEach((button) => {
    const active = button.dataset[kind] === value
    button.classList.toggle('is-on', active)
    button.setAttribute('aria-pressed', String(active))
  })
}

function setA11yOpen(open, focus = false) {
  const panel = document.getElementById('accessibility-settings')
  const button = document.querySelector('[data-a11y-toggle]')
  if (!panel || !button) return
  panel.hidden = !open
  button.classList.toggle('is-open', open)
  button.setAttribute('aria-expanded', String(open))
  if (focus) button.focus()
}

render(<Router />, document.getElementById('root'))

// Drop the instant-paint skeleton now that the app is mounted.
const boot = document.getElementById('boot')
if (boot) boot.remove()

// The inline bootstrap already set data-theme before paint; these lines make
// the controls, the stored preference and the system listener agree with it.
setTheme(root.dataset.theme === 'light' ? 'light' : 'dark', false)
setPreference('font-size', saved('ts-font-size') === 'large' ? 'large' : 'normal')
const contrast = saved('ts-contrast')
if (contrast === 'high' || contrast === 'normal') setPreference('contrast', contrast)
else selectPreference('contrast', 'normal')

// Follow the system theme live, but only while the user has not chosen one.
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const onChange = () => { if (!hasStoredTheme()) setTheme(systemTheme(), false) }
  if (mq.addEventListener) mq.addEventListener('change', onChange)
  else if (mq.addListener) mq.addListener(onChange)
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('button')
  if (!target) return
  if (target.matches('[data-theme-toggle]')) {
    setTheme(root.dataset.theme === 'light' ? 'dark' : 'light')
    return
  }
  if (target.matches('[data-a11y-toggle]')) {
    setA11yOpen(target.getAttribute('aria-expanded') !== 'true')
    return
  }
  if (target.matches('[data-font-size]')) return setPreference('font-size', target.dataset.fontSize)
  if (target.matches('[data-contrast]')) return setPreference('contrast', target.dataset.contrast)
})

document.addEventListener('pointerdown', (event) => {
  const wrap = document.querySelector('[data-a11y-wrap]')
  if (wrap && !wrap.contains(event.target)) setA11yOpen(false)
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setA11yOpen(false, true)
})
