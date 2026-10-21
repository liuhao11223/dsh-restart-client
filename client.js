/**
 * Client half of dsh-restart-client.
 *
 * One icon-only control at the top-right of the page, placed just LEFT of the
 * conversation header's own button cluster so it never overlaps them.
 * A single click asks the Host half to restart the client: no arm step, no confirmation dialog.
 *
 * Seat choice:
 * - `shell.overlay` is the shell's frame-wide floating layer (`.overlayLayer`, z-index 20,
 *   `position: absolute; inset: 0`, `pointer-events: none` with `> * { pointer-events: auto }`),
 *   so an entry here floats above every column and can pin itself to any viewport corner.
 * - The anchor uses `position: fixed` with `no-drag` so a click restarts instead of dragging.
 * - The page's top-right corner is occupied by the conversation header toolbar
 *   (open-right-sidebar, context diagnostics, bottom panel, more-actions, …), so the icon
 *   measures that cluster at runtime and docks to its LEFT edge. When no header buttons
 *   exist (blank page, exotic build) it falls back to the corner itself.
 * - The button is icon-only (no text label); the tooltip carries the accessible name.
 */
window.__ModuleLoader__.load({
  id: 'dsh-restart-client',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useRef, useEffect, useCallback } = React;

    const NS = 'dshRestartClient';
    const SLOT = 'shell.overlay';
    const ENDPOINT = '/api/dsh-restart/restart';
    // Give the response time to reach the browser before the app is killed.
    const RESTART_DELAY_MS = 1200;
    // If the shell has not reloaded this page by then, the restart did not happen: reload ourselves.
    const SELF_RELOAD_MS = 15000;
    // How long a failure face stays before the icon resets to its idle face.
    const ERROR_RESET_MS = 6000;
    // Vertical band (CSS px from the viewport top) that counts as the "header row".
    const HEADER_STRIP = 60;
    // Only buttons in the right 45% of the viewport are treated as the header cluster.
    const RIGHT_ZONE = 0.55;
    // Gap between our icon and the leftmost header button.
    const CLUSTER_GAP = 8;
    // Icon size (CSS px); used to convert a measured left edge into a `right` offset.
    const ICON_SIZE = 28;

    const zh = {
      action: '重启客户端',
      reload: '重启超时，正在刷新页面…',
    };
    const en = {
      action: 'Restart client',
      reload: 'Restart timed out, reloading the page…',
    };

    function isZh() {
      const lang = typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : 'en';
      return lang.toLowerCase().startsWith('zh');
    }

    function fallbackTranslate() {
      const dict = isZh() ? zh : en;
      return (key) => (dict[key] !== undefined ? dict[key] : key);
    }

    /**
     * The left edge (CSS px) of the conversation header's right-side button cluster, or null
     * when the page has no such cluster. Our icon docks to the left of this value.
     */
    function measureHeaderCluster() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
      const zone = window.innerWidth * RIGHT_ZONE;
      let minLeft = null;
      const nodes = document.querySelectorAll('button, [role="button"]');
      for (let i = 0; i < nodes.length; i += 1) {
        const rect = nodes[i].getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.bottom <= 0 || rect.top > HEADER_STRIP) continue;
        if (rect.left < zone) continue;
        if (minLeft === null || rect.left < minLeft) minLeft = rect.left;
      }
      return minLeft;
    }

    const CSS = `
.dshc-anchor {
  position: fixed;
  top: 8px;
  right: 12px;
  z-index: 31;
  display: flex;
  align-items: center;
  pointer-events: auto;
  -webkit-app-region: no-drag;
}
.dshc-btn {
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: ${ICON_SIZE}px;
  height: ${ICON_SIZE}px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color 130ms ease, color 130ms ease, transform 80ms ease;
}
.dshc-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dshc-btn:active:not([aria-busy="true"]) {
  transform: scale(0.94);
}
.dshc-btn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dshc-icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  opacity: 0.8;
  transition: transform 480ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity 130ms ease;
}
.dshc-btn:hover .dshc-icon {
  opacity: 1;
  transform: rotate(180deg);
}
.dshc-btn[data-state="busy"] {
  cursor: progress;
}
.dshc-btn[data-state="busy"] .dshc-icon {
  animation: dshc-spin 900ms linear infinite;
  transform: none;
  opacity: 1;
}
.dshc-btn[data-state="error"],
.dshc-btn[data-state="error"]:hover {
  color: var(--dsw-alias-state-error-primary);
}
.dshc-btn[data-state="error"]:hover .dshc-icon {
  transform: none;
}
@keyframes dshc-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .dshc-icon { transition: none; }
  .dshc-btn:hover .dshc-icon { transform: none; }
  .dshc-btn[data-state="busy"] .dshc-icon { animation: none; opacity: 0.6; }
  .dshc-btn:active:not([aria-busy="true"]) { transform: none; }
}
`;

    function Icon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          width: '100%',
          height: '100%',
        },
        h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
        h('path', { d: 'M20 4.5v4.6h-4.6' }),
      );
    }

    function RestartButton(props) {
      const translate = typeof props.t === 'function' ? props.t : fallbackTranslate();
      const t = useCallback(
        (key) => {
          const value = translate(key);
          return typeof value === 'string' && value !== '' ? value : key;
        },
        [translate],
      );

      const [state, setState] = useState('idle');
      const [detail, setDetail] = useState('');
      const [offset, setOffset] = useState(null);
      const reloadTimer = useRef(null);
      const resetTimer = useRef(null);
      const running = useRef(false);

      // Dock left of the header button cluster; re-measure on resize and layout changes.
      useEffect(() => {
        let frame = 0;
        const sync = () => {
          frame = 0;
          const clusterLeft = measureHeaderCluster();
          if (clusterLeft === null) {
            setOffset((previous) => (previous === null ? previous : null));
            return;
          }
          const next = Math.round(window.innerWidth - clusterLeft + CLUSTER_GAP);
          setOffset((previous) => (previous === next ? previous : next));
        };
        const schedule = () => {
          if (frame !== 0) return;
          frame = requestAnimationFrame(sync);
        };
        sync();
        window.addEventListener('resize', schedule);
        let observer = null;
        if (typeof MutationObserver === 'function') {
          observer = new MutationObserver(schedule);
          observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
        }
        const tick = setInterval(schedule, 2000);
        return () => {
          if (frame !== 0) cancelAnimationFrame(frame);
          window.removeEventListener('resize', schedule);
          if (observer !== null) observer.disconnect();
          clearInterval(tick);
        };
      }, []);

      useEffect(
        () => () => {
          if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
          if (resetTimer.current !== null) clearTimeout(resetTimer.current);
        },
        [],
      );

      const fail = useCallback((reason) => {
        running.current = false;
        setState('error');
        setDetail(reason);
        if (resetTimer.current !== null) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => {
          resetTimer.current = null;
          setState('idle');
          setDetail('');
        }, ERROR_RESET_MS);
      }, []);

      const run = useCallback(async () => {
        if (running.current) return;
        running.current = true;
        if (resetTimer.current !== null) {
          clearTimeout(resetTimer.current);
          resetTimer.current = null;
        }
        setState('busy');
        setDetail('');
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'client', delayMs: RESTART_DELAY_MS }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!payload || payload.ok !== true) {
            fail(payload && payload.error ? String(payload.error) : `HTTP ${response.status}`);
            return;
          }
          // The app (and with it this page) is about to be killed. If that has not happened by the
          // time the shell would normally reload us, reload in place so the icon cannot stay stuck.
          reloadTimer.current = setTimeout(() => {
            reloadTimer.current = null;
            setDetail(t('reload'));
            if (typeof location !== 'undefined' && typeof location.reload === 'function') location.reload();
          }, SELF_RELOAD_MS);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      }, [fail, t]);

      const onClick = useCallback(() => {
        if (running.current) return;
        void run();
      }, [run]);

      const busy = state === 'busy';
      const title = detail !== '' ? `${t('action')} - ${detail}` : t('action');
      const style = offset === null ? undefined : { right: `${offset}px` };

      return h(
        'div',
        { className: 'dshc-anchor', style },
        h('style', { key: 'style' }, CSS),
        h(
          'button',
          {
            key: 'button',
            type: 'button',
            className: 'dshc-btn',
            'data-state': state,
            title,
            'aria-label': title,
            'aria-busy': busy ? 'true' : 'false',
            onClick,
          },
          h('span', { className: 'dshc-icon', key: 'icon' }, h(Icon, null)),
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        const labelText = () => {
          if (locale !== undefined && typeof locale.bind === 'function') {
            try {
              const text = locale.bind(NS)('action');
              if (typeof text === 'string' && text !== '' && text !== 'action') return text;
            } catch {
              /* fall through to the language sniff */
            }
          }
          return fallbackTranslate()('action');
        };
        ctx.effect(() => {
          if (locale === undefined || typeof locale.register !== 'function') return () => {};
          const dispose = locale.register(NS, { zh, en });
          return () => {
            try {
              if (typeof dispose === 'function') dispose();
            } catch {
              /* locale teardown is best effort */
            }
          };
        }, 'dsh-restart-client: dictionaries');

        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'dsh-restart-client',
              order: 90,
              label: labelText,
              locale: NS,
            },
            RestartButton,
          ),
        );
      },
    };
  },
});
