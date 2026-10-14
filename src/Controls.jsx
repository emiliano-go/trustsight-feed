// Masthead controls, ported from trustsight-web so the look and behaviour
// match: a sun/moon theme pill and the accessibility menu. Both are driven by
// src/main.jsx through the same `data-*` attributes.

export function ThemeSwitch() {
  return (
    <button className="theme-switch is-dark" type="button" data-theme-toggle role="switch" aria-checked="true" aria-label="Toggle color theme">
      <span className="theme-option theme-sun" data-theme-sun aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg></span>
      <span className="theme-option theme-moon is-active" data-theme-moon aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg></span>
    </button>
  )
}

export function AccessibilityMenu() {
  return (
    <div className="a11y-wrap" data-a11y-wrap>
      <button className="a11y-button" type="button" data-a11y-toggle aria-controls="accessibility-settings" aria-expanded="false" aria-label="Accessibility settings">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="7" r="1.6" /><path d="M12 9.8v4.4" /><path d="M12 11.5 7.8 8.5" /><path d="M12 11.5l4.2-3" /><path d="M12 14.2 9.2 18.2" /><path d="M12 14.2l2.8 4" /></svg>
      </button>
      <div className="a11y-panel" id="accessibility-settings" role="group" aria-label="Accessibility settings" hidden>
        <div className="a11y-row"><span className="a11y-label">Font size</span><div className="a11y-seg" role="group" aria-label="Font size"><button type="button" className="is-on" data-font-size="normal" aria-pressed="true">A</button><button type="button" data-font-size="large" aria-pressed="false"><span className="a11y-big">A</span></button></div></div>
        <div className="a11y-row"><span className="a11y-label">High contrast</span><div className="a11y-seg" role="group" aria-label="High contrast"><button type="button" className="is-on" data-contrast="normal" aria-pressed="true">Off</button><button type="button" data-contrast="high" aria-pressed="false">On</button></div></div>
      </div>
    </div>
  )
}

export function Wordmark({ href = '/' }) {
  return (
    <a className="wordmark" href={href} data-route aria-label="TrustSight Watcher">
      TRUST<span>SIGHT</span>
    </a>
  )
}
