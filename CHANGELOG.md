# Changelog

All notable changes to `dsh-restart-client`.

## 1.0.0

Initial release of the packaged plugin. One click restarts the whole DSH desktop client.

### Mounting — single seat

The button was reworked from a **two-seat** design (header utilities slot on session
pages + a pinned `shell.overlay` seat on the home page, with `:has()` dedupe) to a
**single seat** that shows on every page:

- `apply()` registers a component into the root-level `shell.overlay` slot, which exists
  even on the sessionless welcome screen, so the component is always mounted.
- The component tracks `[data-conversation-header-corner]` with a `MutationObserver`
  (the host corner appears late), appends a `<span data-dshc-mount>` as the corner's
  **last** child, and portals the button in with `react-dom` `createPortal`.
- Position is left entirely to host layout: the corner is pushed to the far right of the
  header row by the host's own `margin-left:auto`. The plugin writes no `top`/`left` and
  keeps no fixed-position anchor, which also fixes the "welcome-screen icon only appears
  after manually resizing the window" issue seen in `dsh-power-menu` 0.1.16.

### Host half

- `DESKTOP_PATTERN` matches both `deepseek-harness-desktop` and the localized
  `DSH Desktop.exe`; without the second alternative `findDesktop()` misses the shell and
  every client restart silently degrades to a service restart (orphan replacement
  harness + `EADDRINUSE` on ports 43129/8326).
- The windowless helper is launched via a WMI-created `wscript.exe` running a UTF-16LE
  (BOM) `.vbs` launcher; direct WMI creation is kept as a fallback.
- Added `GET /api/dsh-restart/status`, the `restart_dsh_client` agent tool, and `dryRun`
  support on both.
