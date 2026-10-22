/**
 * Client half of dsh-restart-client.
 *
 * One icon-only restart control, placed in two host seats so it is always reachable:
 *  - `conversation.session.header.utilities` — the conversation header, just left of the
 *    right-panel toggle (shown on session pages, including the blank new-session hero page).
 *  - `shell.overlay` — the frame-wide floating layer, pinned to the right end of the home
 *    page's header row (below the titlebar), i.e. the same visual corner as the header seat.
 *
 * The two never show at once: the overlay button hides itself whenever the conversation
 * panel is not mounted (plugins/schedule/settings pages) or the header seat is rendered, so
 * it appears only on the home page. The shell's own header corner control (the right-panel
 * toggle) lives in a separate, single-occupant slot, so it is never displaced. A single
 * click restarts.
 *
 * - The button is icon-only (28px square, 16px glyph, no text); the tooltip carries the
 *   accessible name.
 */
window.__ModuleLoader__.load({
  id: 'dsh-restart-client',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useRef, useEffect, useCallback } = React;

    const NS = 'dshRestartClient';
    const SLOT_HEADER = 'conversation.session.header.utilities';
    const SLOT_OVERLAY = 'shell.overlay';
    const ENDPOINT = '/api/dsh-restart/restart';
    // Give the response time to reach the browser before the app is killed.
    const RESTART_DELAY_MS = 1200;
    // If the shell has not reloaded this page by then, the restart did not happen: reload ourselves.
    const SELF_RELOAD_MS = 15000;
    // How long a failure face stays before the icon resets to its idle face.
    const ERROR_RESET_MS = 6000;

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

    const CSS = `
.dshc-seat {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  margin-left: 6px;
}
.dshc-anchor {
  position: fixed;
  right: 12px;
  /* Below the titlebar, on the home page's header row (the sessionless header). Matches the
     vertical band where session pages show the header seat, so it reads as the same place. */
  top: calc(var(--dsh-windows-titlebar-height, 44px) + 8px);
  z-index: 32;
  display: flex;
  align-items: center;
  justify-content: center;
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
  width: 28px;
  height: 28px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
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
  width: 16px;
  height: 16px;
  opacity: 0.8;
  transition: transform 480ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity 130ms ease;
}
.dshc-btn:hover .dshc-icon {
  opacity: 1;
  transform: scale(1.08);
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
/* Hide the overlay seat whenever the conversation panel is not mounted (plugins / schedule /
   settings pages) or the header seat is actually rendered (session pages). Only the home page
   shows the overlay. The JS probe mirrors this; CSS :has() provides flicker-free fallback. */
html:not(:has([data-conversation-content])) .dshc-anchor,
html:has([data-dshc-seat="header"]) .dshc-anchor {
  display: none;
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
        h('path', { d: 'M15.17 5.2 A 7.5 7.5 0 1 1 8.83 5.2' }),
        h('path', { d: 'M12 3.5 L12 10' }),
      );
    }

    /**
     * True while the overlay seat must stay hidden. Hidden whenever:
     *  - the conversation panel is not mounted (plugins/schedule/settings pages), or
     *  - our header-seat button is actually rendered (session pages, including the blank
     *    new-session hero page, where the header utilities render our button).
     * Only the home page (conversation panel mounted, no session header) shows the overlay.
     * Defaults to true so the overlay stays hidden until the DOM proves otherwise — no flicker.
     */
    function useOverlayHidden() {
      const [hidden, setHidden] = useState(true);
      useEffect(() => {
        if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return () => {};
        const check = () => {
          const inConversation = document.querySelector('[data-conversation-content]') !== null;
          const headerSeat = document.querySelector('[data-dshc-seat="header"] .dshc-btn') !== null;
          setHidden(!inConversation || headerSeat);
        };
        let frame = 0;
        const schedule = () => {
          if (frame !== 0) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            check();
          });
        };
        schedule();
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
          if (frame !== 0) cancelAnimationFrame(frame);
          observer.disconnect();
        };
      }, []);
      return hidden;
    }

    function RestartButton(props) {
      const seat = props.seat === 'overlay' ? 'overlay' : 'header';
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

      // Hooks run unconditionally (Rules of Hooks); results are used per seat.
      const overlayHidden = useOverlayHidden();

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

      // The overlay seat stays hidden while a session header is mounted (the header seat shows).
      if (seat === 'overlay' && overlayHidden) return null;

      const busy = state === 'busy';
      const title = detail !== '' ? `${t('action')} - ${detail}` : t('action');
      const wrapperClass = seat === 'overlay' ? 'dshc-anchor' : 'dshc-seat';
      const wrapperProps =
        seat === 'overlay'
          ? { className: wrapperClass, key: 'wrap' }
          : { className: wrapperClass, key: 'wrap', 'data-dshc-seat': 'header' };

      return h(
        'div',
        wrapperProps,
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

        // Header seat: conversation header utilities, just left of the right-panel toggle.
        ctx.slots.inject(SLOT_HEADER, () =>
          ctx.slots.register(
            { name: SLOT_HEADER, id: 'dsh-restart-client', order: 100, label: labelText, locale: NS },
            (props) => h(RestartButton, { ...props, seat: 'header' }),
          ),
        );
        // Overlay seat: caption top-right, shown only on the home page (hides while a session is open).
        ctx.slots.inject(SLOT_OVERLAY, () =>
          ctx.slots.register(
            { name: SLOT_OVERLAY, id: 'dsh-restart-client', order: 90, label: labelText, locale: NS },
            (props) => h(RestartButton, { ...props, seat: 'overlay' }),
          ),
        );
      },
    };
  },
});
