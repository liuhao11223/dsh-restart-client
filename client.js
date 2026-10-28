/**
 * Client half of dsh-restart-client.
 *
 * Mounting follows the my-corner-plugin (dsh-power-menu) corner-slot pattern:
 *
 *  1. apply() registers CornerSlot into the root-level slot `shell.overlay`, which
 *     exists even on the sessionless welcome screen, so the component is always mounted.
 *  2. CornerSlot does not render the button directly. It uses a MutationObserver to
 *     track `[data-conversation-header-corner]` — a single-occupant host slot already
 *     taken by the native right-panel toggle, so ctx.slots cannot register into it.
 *  3. Once found, it creates a <span data-dshc-mount> and appends it as the corner's
 *     LAST child (i.e. to the right of the native toggle).
 *  4. react-dom createPortal renders the restart button into that span.
 *
 *  Button position is therefore 100% decided by host layout (the corner is pushed to
 *  the far right of the header row by the host's own margin-left:auto); the plugin
 *  writes no top/left and keeps no fixed-position anchor. The old two-seat design
 *  (header utilities + fixed overlay + :has() dedupe) is fully replaced by this
 *  single seat that shows wherever the host renders the header corner.
 *
 *  The button itself keeps the original behaviour: icon-only 28px square, 16px glyph,
 *  busy spinner, error face, single click restarts via POST /api/dsh-restart/restart.
 */
window.__ModuleLoader__.load({
  id: 'dsh-restart-client',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useRef, useEffect, useCallback, useLayoutEffect } = React;

    let createPortal = null;
    try {
      createPortal = require('react-dom').createPortal;
    } catch {
      createPortal = null;
    }

    const NS = 'dshRestartClient';
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

    const CSS_ID = 'dsh-restart-client-css';
    const CSS = [
      /* mount span inside the host header corner: inline flow, host decides position */
      '.dshc-seat{display:inline-flex;align-items:center;flex:0 0 auto;-webkit-app-region:no-drag}',
      '.dshc-btn{appearance:none;-webkit-appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin:0;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#5f5f66);cursor:pointer;-webkit-app-region:no-drag;transition:background-color 130ms ease,color 130ms ease,transform 80ms ease}',
      '.dshc-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1b1b20)}',
      '.dshc-btn:active:not([aria-busy="true"]){transform:scale(0.94)}',
      '.dshc-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:1px}',
      '.dshc-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px;opacity:0.8;transition:transform 480ms cubic-bezier(0.22,0.61,0.36,1),opacity 130ms ease}',
      '.dshc-btn:hover .dshc-icon{opacity:1;transform:scale(1.08)}',
      '.dshc-btn[data-state="busy"]{cursor:progress}',
      '.dshc-btn[data-state="busy"] .dshc-icon{animation:dshc-spin 900ms linear infinite;transform:none;opacity:1}',
      '.dshc-btn[data-state="error"],.dshc-btn[data-state="error"]:hover{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dshc-btn[data-state="error"]:hover .dshc-icon{transform:none}',
      '@keyframes dshc-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.dshc-icon{transition:none}.dshc-btn:hover .dshc-icon{transform:none}.dshc-btn[data-state="busy"] .dshc-icon{animation:none;opacity:0.6}.dshc-btn:active:not([aria-busy="true"]){transform:none}}',
    ].join('');

    function ensureCss() {
      if (typeof document === 'undefined') return;
      let tag = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`);
      if (tag === null) {
        tag = document.createElement('style');
        tag.dataset.pluginCss = CSS_ID;
        document.head.append(tag);
      }
      if (tag.textContent !== CSS) tag.textContent = CSS;
    }

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

      ensureCss();

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

      return h(
        'div',
        { className: 'dshc-seat', 'data-dshc-seat': 'corner' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshc-btn',
            'data-state': state,
            title,
            'aria-label': title,
            'aria-busy': busy ? 'true' : 'false',
            onClick,
          },
          h('span', { className: 'dshc-icon' }, h(Icon, null)),
        ),
      );
    }

    /**
     * CornerSlot — copied from the my-corner-plugin / dsh-power-menu mounting core.
     * Tracks [data-conversation-header-corner] with a MutationObserver (the welcome
     * screen's corner appears late), appends our mount span as its last child, and
     * portals the button in.
     */
    function CornerSlot(props) {
      const [mount, setMount] = useState(null);

      useLayoutEffect(() => {
        let node = null;
        let observer = null;
        const ensure = () => {
          const corner = document.querySelector('[data-conversation-header-corner]');
          if (corner === null) {
            if (node !== null) {
              node.remove();
              node = null;
              setMount(null);
            }
            return;
          }
          let appended = false;
          if (node === null) {
            node = document.createElement('span');
            node.setAttribute('data-dshc-mount', '');
            node.style.cssText = 'display:inline-flex;align-items:center;margin-left:4px;';
            setMount(node);
            appended = true;
          }
          if (node.parentElement !== corner || corner.lastElementChild !== node) {
            corner.appendChild(node);
            appended = true;
          }
          if (appended) {
            // Force a header reflow + broadcast resize once after appending; fixes the
            // "welcome-screen icon only appears after manually resizing the window"
            // issue (lesson from dsh-power-menu 0.1.16).
            void corner.offsetHeight;
            window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
          }
        };
        ensure();
        observer = new MutationObserver(() => ensure());
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', ensure);
        return () => {
          observer.disconnect();
          window.removeEventListener('resize', ensure);
          if (node !== null) node.remove();
        };
      }, []);

      if (mount === null || createPortal === null) return null;
      return createPortal(h(RestartButton, props), mount);
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

        // Single seat: root-level shell.overlay exists on every page (including the
        // sessionless welcome screen); CornerSlot portals into the host header corner.
        ensureCss();
        ctx.slots.inject(SLOT_OVERLAY, () =>
          ctx.slots.register(
            {
              name: SLOT_OVERLAY,
              id: 'dsh-restart-client',
              order: 90,
              label: labelText,
              locale: NS,
              registrant: 'dsh-restart-client',
            },
            (props) => h(CornerSlot, props),
          ),
        );
      },
    };
  },
});
