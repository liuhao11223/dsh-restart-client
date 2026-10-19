# dsh-restart-client

A DSH (DeepSeek Harness) plugin that adds a **one-click restart** for the desktop client — a sidebar button, an HTTP endpoint, and an agent tool, all backed by the same host capability.

Click once. No confirmation dialog, no second press, no console window.

<!-- 截图占位：把下面的路径替换成仓库里的真实截图 -->
![The restart button at the sidebar foot](docs/screenshot.png)

## Why

The DSH desktop app ships restart only as an official **service-only** extension: it respawns the Harness process and leaves the window running, so host-side changes still need a manual quit-and-relaunch. This plugin restarts the **whole application** while keeping the experience to a single click.

## What it does

| Entry point | Kind | Purpose |
| --- | --- | --- |
| Sidebar footer button | Client slot `sidebar.footer.action` | One click → the desktop app restarts |
| `POST /api/dsh-restart/restart` | HTTP route | Same operation for scripts and other plugins |
| `GET /api/dsh-restart/status` | HTTP route | Reports the resolved desktop process and mode plan |
| `restart_dsh_client` | Agent tool | Lets the model restart the client itself |

Two modes:

- **`client`** (default) — kill the whole desktop process tree, wait for it to disappear, then relaunch the executable. The window really restarts.
- **`service`** — respawn only the Harness service process and exit, leaving the desktop alone.

## Install

The plugin is a regular DSH bundle. Point a profile at it:

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "dsh-restart-client": "link:E:/path/to/dsh-restart-client"
  },
  "dsh": {
    "bundles": ["dsh-restart-client"]
  }
}
```

Then restart the client once (by hand the first time — the button does not exist yet), and refresh the page after any `client.js` edit, since the desktop serves client halves from disk.

Because `package.json` points `exports` at the real files and the profile links the directory, editing `client.js` is picked up on the next page load; editing `index.js` (the host half) needs a real client restart.

## How the no-console restart works

The interesting part, and the reason this plugin exists rather than a five-line shell wrapper.

A helper process has to outlive the app it is about to kill, so it is created through WMI (`Win32_Process.Create`), which reparents it to `WmiPrvSE` and lets it survive `taskkill /T` on the desktop tree. But **WMI-created processes always get a console window**, and none of the usual tricks suppress it — `-WindowStyle Hidden` does not, and a `Win32_ProcessStartup` with `ShowWindow = 0` returns success while the console still appears (measured on Windows 10/11).

So the helper is launched indirectly:

1. Write a tiny `.vbs` launcher (UTF-16LE **with BOM** — WSH accepts only ANSI or UTF-16, and temp paths may contain non-ASCII user names).
2. The launcher runs `shell.Run "<helper command>", 0, False` — window style `0` means no window at all.
3. WMI creates `wscript.exe //nologo <launcher.vbs>`, which starts the helper invisibly.

If WSH is unavailable, the plugin falls back to creating the helper directly, so restarting still works even if a console flashes. A dry run reports which route would be taken:

```jsonc
// POST /api/dsh-restart/restart  {"dryRun": true}
{ "launch": "wscript (windowless)", ... }
```

## The button

It lives in the shell's own `sidebar.footer.action` list slot, next to Settings, and inherits the sidebar's layout — including the centering it does when the sidebar collapses to a rail. Nothing is measured at runtime and no coordinates are hard-coded.

Styled as a ghost button in the shell's token language: 28px tall, 6px radius, transparent until hover, `--dsw-alias-label-secondary` → `--dsw-alias-label-primary`, a 180° icon turn on hover, a spin plus a pulsing label while busy, and `--dsw-alias-state-error-primary` with a **Retry** face for six seconds if the request fails. It honors `prefers-reduced-motion`.

## API

### `GET /api/dsh-restart/status`

```jsonc
{
  "ok": true,
  "host": { "platform": "win32", "selfPid": 26488, "desktopPid": 12724, "desktopOwned": true, "modes": ["client", "service"] }
}
```

### `POST /api/dsh-restart/restart`

```jsonc
{ "mode": "client", "delayMs": 1500, "dryRun": false }
```

`delayMs` is clamped to 120000 and defaults to 1500, giving the HTTP response time to reach the browser before the app dies.

Response:

```jsonc
{
  "ok": true,
  "mode": "client",
  "desktopPid": 12724,
  "helperPid": 26576,
  "launch": "wscript (windowless)",
  "logPath": "C:/Users/…/dsh-restart-client/client-2026-10-19T13-21-28-091Z.log"
}
```

Both routes reject untrusted origins (403) through `ctx.connection.requestRejection`, and reject the wrong method (405).

### Agent tool `restart_dsh_client`

```jsonc
{ "mode": "client", "dryRun": true }
```

The current turn is interrupted by a real restart.

## Layout

```
index.js            host half — routes, WMI/VBS launcher, agent tool
client.js           client half — the sidebar button
cordis.patch.yml    bundle patch: inserts the plugin entry
locale/zh.json      plugin marketplace metadata (Chinese)
locale/en.json      plugin marketplace metadata (English)
icon.svg            plugin icon
```

`index.js` imports nothing but Node built-ins.

## Limitations

- **Windows-centric.** The windowless launcher path is WSH-specific; other platforms fall back to the direct route.
- **Single instance.** The relaunch waits up to 20s for the old pid to disappear, because the app hands a second launch to the dying instance; if the pid outlives that, it relaunches anyway and logs it.
- **A restart interrupts the turn.** Any tool call in flight is killed with the process.

## License

MIT — see [LICENSE](LICENSE).
