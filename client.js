/**
 * Client half of dsh-restart-client.
 *
 * One control at the sidebar foot, beside Settings (`sidebar.footer.action`).
 * A single click asks the Host half to restart the client: no arm step, no confirmation dialog.
 *
 * Seat choice:
 * - `sidebar.footer.action` is the shell's additive list slot rendered inside the sidebar's foot
 *   (`.footerActions`, a flex row that centers its children when the sidebar is collapsed to a rail),
 *   so the control follows the sidebar's own layout instead of measuring anything at runtime.
 * - The button keeps the shell's ghost-button look (transparent → hover fill, label-secondary →
 *   label-primary) so it reads as native sidebar chrome next to the Settings entry.
 */
window.__ModuleLoader__.load({
  id: 'dsh-restart-client',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useRef, useEffect, useCallback } = React;

    const NS = 'dshRestartClient';
    const SLOT = 'sidebar.footer.action';
    const ENDPOINT = '/api/dsh-restart/restart';
    // Give the response time to reach the browser before the app is killed.
    const RESTART_DELAY_MS = 1200;
    // If the shell has not reloaded this page by then, the restart did not happen: reload ourselves.
    const SELF_RELOAD_MS = 15000;
    // How long a failure face stays before the chip fades back to its idle face.
    const ERROR_RESET_MS = 6000;

    const zh = {
      action: '重启客户端',
      short: '重启',
      busy: '重启中',
      failed: '重启失败',
      retry: '重试',
      reload: '重启超时，正在刷新页面…',
    };
    const en = {
      action: 'Restart client',
      short: 'Restart',
      busy: 'Restarting',
      failed: 'Restart failed',
      retry: 'Retry',
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

    const CSS = `
.dshc-anchor {
  display: flex;
  flex: none;
  min-width: 0;
  pointer-events: auto;
}
.dshc-btn {
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  margin: 0;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12.5px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 130ms ease, color 130ms ease, border-color 130ms ease, transform 80ms ease;
}
.dshc-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dshc-btn:active:not([aria-busy="true"]) {
  transform: scale(0.97);
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
  width: 13px;
  height: 13px;
  opacity: 0.85;
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
.dshc-btn[data-state="busy"] .dshc-label {
  animation: dshc-pulse 1400ms ease-in-out infinite;
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
@keyframes dshc-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
@media (prefers-reduced-motion: reduce) {
  .dshc-icon { transition: none; }
  .dshc-btn:hover .dshc-icon { transform: none; }
  .dshc-btn[data-state="busy"] .dshc-icon { animation: none; opacity: 0.6; }
  .dshc-btn[data-state="busy"] .dshc-label { animation: none; }
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
      const reloadTimer = useRef(null);
      const resetTimer = useRef(null);
      const running = useRef(false);

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
          // time the shell would normally reload us, reload in place so the chip cannot stay stuck.
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
      const label = busy ? t('busy') : state === 'error' ? t('retry') : t('short');
      const title = detail !== '' ? `${t('action')} - ${detail}` : t('action');

      return h(
        'div',
        { className: 'dshc-anchor' },
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
          h('span', { className: 'dshc-label', key: 'label' }, label),
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
