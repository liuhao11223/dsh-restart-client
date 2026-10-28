/**
 * Host half of dsh-restart-client.
 *
 * Implements exactly one operation - "restart the DSH desktop client" - once, as a host
 * capability, and exposes it through the two entry points the harness convention requires:
 * an HTTP route the Client half calls, and an agent tool with the same semantics.
 *
 * Two modes:
 *  - `client`  : restart the whole desktop application (kill the desktop process tree and
 *                relaunch the executable from a detached helper that survives the kill).
 *  - `service` : restart only the Harness service process (spawn a replacement, then exit),
 *                which is what the official extension does.
 *
 * No external packages are imported - only Node built-ins.
 */
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

export const name = 'dsh-restart-client';
export const inject = ['webServer', 'connection', 'tools'];

const STATUS_PATH = '/api/dsh-restart/status';
const RESTART_PATH = '/api/dsh-restart/restart';
// Match both the upstream executable name (deepseek-harness-desktop) and the
// localized desktop shipped here, whose process is literally "DSH Desktop.exe".
// Without the second alternative findDesktop() misses the shell, so every
// client restart silently degrades to a service restart: the replacement
// harness it spawns becomes an orphan (its parent exits), while the desktop
// watchdog relaunches its own harness. The two then fight over ports 43129 and
// 8326 (EADDRINUSE), and the failed boots feed the "plugin recovery detection:
// unresolved" cascade that lands the app in safe mode.
const DESKTOP_PATTERN = /deepseek-harness-desktop|dsh[\s_-]*desktop/i;
const MODES = ['client', 'service'];

/* ------------------------------------------------------------------ utilities */

function writeJson(res, status, value) {
  let body;
  try {
    body = JSON.stringify(value);
  } catch {
    body = JSON.stringify({ ok: false, error: 'unserializable response' });
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return finish({});
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(undefined);
      }
    });
    req.on('error', () => finish(undefined));
  });
}

function powershell(script, timeout = 15000) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, stdout: '', stderr: 'powershell is only available on Windows' });
      return;
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          stdout: String(stdout ?? '').trim(),
          stderr: String(stderr ?? '').trim() || (error ? String(error.message ?? '') : ''),
        });
      },
    );
  });
}

async function queryProcess(pid) {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { '' } else { $p | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress }",
  ].join('; ');
  const result = await powershell(script, 8000);
  if (!result.ok || result.stdout === '') return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

/** Walk up the process tree looking for the desktop shell that owns this Harness process. */
async function findDesktop(limit = 8) {
  let pid = process.ppid;
  const chain = [];
  for (let depth = 0; depth < limit && pid !== undefined && pid !== null && pid > 0; depth += 1) {
    const info = await queryProcess(pid);
    if (info === undefined) break;
    chain.push({
      pid: info.ProcessId,
      parentPid: info.ParentProcessId,
      name: info.Name,
      path: info.ExecutablePath,
    });
    if (typeof info.Name === 'string' && DESKTOP_PATTERN.test(info.Name)) return { desktop: chain[chain.length - 1], chain };
    if (typeof info.ExecutablePath === 'string' && DESKTOP_PATTERN.test(info.ExecutablePath)) {
      return { desktop: chain[chain.length - 1], chain };
    }
    pid = info.ParentProcessId;
  }
  return { desktop: undefined, chain };
}

async function describeHost() {
  const found = await findDesktop();
  const desktop = found.desktop;
  return {
    platform: process.platform,
    selfPid: process.pid,
    parentPid: process.ppid,
    argv: process.argv.slice(0, 3),
    serviceUrl: process.env.DSH_WEB_URL ?? null,
    desktopOwned: desktop !== undefined,
    desktopPid: desktop?.pid ?? null,
    desktopName: desktop?.name ?? null,
    desktopExecutable: desktop?.path ?? null,
    ancestors: found.chain,
    modes: MODES,
  };
}

/* ------------------------------------------------------------------ restarts */

function stampName() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Restart only the Harness service: spawn a replacement, then let this process exit. */
function scheduleServiceRestart() {
  const logDir = join(tmpdir(), 'dsh-restart-client');
  mkdirSync(logDir, { recursive: true });
  const stamp = stampName();
  const outPath = join(logDir, `service-${stamp}.out.log`);
  const errPath = join(logDir, `service-${stamp}.err.log`);
  const outFd = openSync(outPath, 'a');
  const errFd = openSync(errPath, 'a');
  const script = process.argv[1];
  const args = script === undefined ? process.execArgv : [...process.execArgv, script, ...process.argv.slice(2)];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  setTimeout(() => {
    process.exit(0);
  }, 600);
  return { replacementPid: child.pid ?? null, logOut: outPath, logErr: errPath };
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const DEFAULT_DELAY_MS = 1500;
const MAX_DELAY_MS = 120000;

/** Build the detached helper script that kills the app, waits for it to be gone, then relaunches it. */
function buildClientHelperScript(desktop, exePath, workDir, logPath, delayMs) {
  const exe = psQuote(exePath);
  const pid = Number(desktop.pid);
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$log = ${psQuote(logPath)}`,
    'function Write-Log([string]$message) {',
    "  try { Add-Content -LiteralPath $log -Value ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $message) } catch { }",
    '}',
    `$exe = ${exe}`,
    `$targetPid = ${pid}`,
    `Write-Log 'helper started'`,
    `Start-Sleep -Milliseconds ${delayMs}`,
    `Write-Log ('killing process tree {0}' -f $targetPid)`,
    '& taskkill.exe /PID $targetPid /T /F | Out-Null',
    'if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {',
    "  Write-Log 'taskkill left the process alive, using Stop-Process'",
    '  Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue',
    '}',
    '# The app enforces a single instance: relaunching while the old process is still shutting down',
    '# would hand the launch over to the dying instance, so wait for the pid to disappear first.',
    '$gone = $false',
    'for ($i = 0; $i -lt 80; $i++) {',
    '  if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { $gone = $true; break }',
    '  Start-Sleep -Milliseconds 250',
    '}',
    "if ($gone) { Write-Log 'old instance is gone' } else { Write-Log 'old instance still alive after 20s, relaunching anyway' }",
    'Start-Sleep -Milliseconds 400',
    'for ($attempt = 1; $attempt -le 3; $attempt++) {',
    "  Write-Log ('launching {0} (attempt {1})' -f $exe, $attempt)",
    '  # -PassThru is deliberate: comparing ExecutablePath inside Win32_Process needs privileges that',
    '  # are not guaranteed, whereas the returned object proves the launch produced a live process.',
    `  $started = Start-Process -FilePath $exe -WorkingDirectory ${psQuote(workDir)} -PassThru -ErrorAction SilentlyContinue`,
    '  if ($started) {',
    "    Start-Sleep -Milliseconds 2500",
    '    if (-not $started.HasExited) {',
    "      Write-Log ('relaunched, pid: {0}' -f $started.Id)",
    '      break',
    '    }',
    "    Write-Log ('launched pid {0} exited with code {1}' -f $started.Id, $started.ExitCode)",
    '  } else {',
    "    Write-Log 'Start-Process returned no process'",
    '  }',
    "  Write-Log 'launch did not survive, retrying'",
    '  Start-Sleep -Milliseconds 1500',
    '}',
    "Write-Log 'helper done'",
  ].join('\r\n');
}

/**
 * Restart the whole desktop application.
 *
 * A helper PowerShell process is created through WMI so that its parent becomes WmiPrvSE
 * instead of the desktop: it therefore survives `taskkill /T` on the desktop process tree,
 * waits for the app to die, and relaunches the executable.
 *
 * WMI-created processes always get a console window of their own, and neither
 * `-WindowStyle Hidden` nor a Win32_ProcessStartup ShowWindow=0 suppresses it (measured on
 * Windows 10/11), so a black command window would flash over the user's screen. The helper is
 * therefore started by a one-line WScript launcher: WMI creates `wscript.exe`, and
 * `shell.Run command, 0` starts the helper with no window at all. If WSH is unavailable the
 * direct WMI creation is used as a fallback so restarting still works.
 */
async function scheduleClientRestart(desktop, options = {}) {
  const exePath = desktop.path;
  if (typeof exePath !== 'string' || exePath === '') {
    return { ok: false, error: 'DESKTOP_PATH_UNKNOWN: could not resolve the desktop executable' };
  }
  const delayMs = clampDelay(options.delayMs);
  const workDir = dirname(exePath);
  const logDir = join(tmpdir(), 'dsh-restart-client');
  mkdirSync(logDir, { recursive: true });
  const stamp = stampName();
  const logPath = join(logDir, `client-${stamp}.log`);

  const helper = buildClientHelperScript(desktop, exePath, workDir, logPath, delayMs);
  const encoded = Buffer.from(helper, 'utf16le').toString('base64');
  const helperCommand = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;

  const launcherPath = join(logDir, `client-${stamp}.vbs`);
  let launcherWritten = true;
  try {
    // WSH only understands ANSI or UTF-16 scripts, and the path may contain non-ASCII user
    // names, so the launcher is written as UTF-16LE with a BOM.
    writeFileSync(launcherPath, `\ufeff${buildLauncherScript(helperCommand)}`, 'utf16le');
  } catch {
    launcherWritten = false;
  }

  const viaLauncher = launcherWritten
    ? await createViaWmi(`${wscriptPath()} //nologo ${windowsQuote(launcherPath)}`)
    : undefined;
  const usedLauncher = viaLauncher?.returnValue === '0';
  const created = usedLauncher ? viaLauncher : await createViaWmi(helperCommand);
  if (!created.ok) return { ok: false, error: `WMI_HELPER_FAILED: ${created.stderr || 'unknown error'}` };
  if (created.returnValue !== '0') {
    return { ok: false, error: `WMI_HELPER_FAILED: Win32_Process.Create returned ${created.returnValue || 'unknown'}` };
  }
  return {
    ok: true,
    desktopPid: desktop.pid,
    desktopExecutable: exePath,
    helperPid: Number(created.helperPid) || null,
    launch: usedLauncher ? 'wscript (windowless)' : 'powershell (fallback)',
    launcherPath: usedLauncher ? launcherPath : null,
    delayMs,
    logPath,
  };
}

/** Create a detached process through WMI; Windows then reports WmiPrvSE as its parent. */
async function createViaWmi(commandLine) {
  const outer = [
    `$cmd = ${psQuote(commandLine)}`,
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }',
    '"$($r.ReturnValue)|$($r.ProcessId)"',
  ].join('; ');
  const result = await powershell(outer, 20000);
  if (!result.ok) return { ok: false, stderr: result.stderr };
  const [returnValue, helperPid] = result.stdout.split('|');
  return { ok: true, returnValue: returnValue === undefined ? '' : returnValue.trim(), helperPid };
}

/** Quote a value as a VBScript string literal. */
function vbsString(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * WScript launcher: `Run command, 0, False` starts the helper hidden and does not wait.
 * Without it the WMI-created console would be visible for the whole helper lifetime.
 */
function buildLauncherScript(helperCommand) {
  return [
    "' Launcher written by dsh-restart-client: starts the restart helper with no console window.",
    'Dim shell',
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${vbsString(helperCommand)}, 0, False`,
    'Set shell = Nothing',
    '',
  ].join('\r\n');
}

function windowsQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function wscriptPath() {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(root, 'System32', 'wscript.exe');
}

function clampDelay(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return DEFAULT_DELAY_MS;
  return Math.min(Math.round(number), MAX_DELAY_MS);
}

async function restart(options = {}) {
  const requested = typeof options.mode === 'string' ? options.mode : 'client';
  const mode = MODES.includes(requested) ? requested : 'client';
  const dryRun = options.dryRun === true;
  const delayMs = clampDelay(options.delayMs);
  const host = await describeHost();

  if (mode === 'client') {
    if (!host.desktopOwned) {
      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          mode: 'service',
          requested: mode,
          fallback: 'DESKTOP_NOT_OWNED: no desktop shell above this process, would restart the service instead',
          host,
        };
      }
      const service = scheduleServiceRestart();
      return {
        ok: true,
        dryRun: false,
        mode: 'service',
        requested: mode,
        fallback: 'DESKTOP_NOT_OWNED: no desktop shell above this process, restarted the service instead',
        ...service,
      };
    }
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        mode,
        plan: {
          helper:
            'wscript launcher via Win32_Process.Create (windowless, detached from the desktop process tree)',
          kill: `taskkill /PID ${host.desktopPid} /T /F`,
          launch: host.desktopExecutable,
          delayMs,
          logPath: join(tmpdir(), 'dsh-restart-client', `client-<timestamp>.log`),
        },
        host,
      };
    }
    const result = await scheduleClientRestart(
      { pid: host.desktopPid, path: host.desktopExecutable },
      { delayMs },
    );
    return { ok: result.ok === true, dryRun: false, mode, ...result, host };
  }

  if (dryRun) {
    return { ok: true, dryRun: true, mode, plan: { spawnReplacement: process.execPath, thenExit: true }, host };
  }
  const result = scheduleServiceRestart();
  return { ok: true, dryRun: false, mode, ...result, host };
}

/* ------------------------------------------------------------------ plugin */

export function apply(ctx) {
  const fence = (req) => ctx.connection.requestRejection(req) === undefined;

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: async (req, res) => {
        if (!fence(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: untrusted origin' });
          return;
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        try {
          writeJson(res, 200, { ok: true, ...(await describeHost()) });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: RESTART_PATH,
      handler: async (req, res) => {
        if (!fence(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: untrusted origin' });
          return;
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        try {
          const outcome = await restart({ mode: body.mode, dryRun: body.dryRun, delayMs: body.delayMs });
          writeJson(res, outcome.ok ? 200 : 500, outcome);
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'restart_dsh_client',
      description:
        'Restart the DSH desktop client. mode "client" (default) restarts the whole application; mode "service" restarts only the Harness service process. Set dryRun true to inspect the plan without restarting. The current turn is interrupted by the restart.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: {
            type: 'string',
            enum: MODES,
            description: 'client = whole desktop app (default), service = Harness process only.',
          },
          dryRun: {
            type: 'boolean',
            description: 'Report what would happen without restarting anything.',
          },
          delayMs: {
            type: 'number',
            description: 'How long the detached helper waits before killing the app, in milliseconds (default 1500).',
          },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            dryRun: { type: 'boolean' },
            mode: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Restart DSH client',
        kind: 'execute',
        rawInput: args,
      }),
      async execute(args) {
        const input = args !== null && typeof args === 'object' ? args : {};
        return restart({ mode: input.mode, dryRun: input.dryRun, delayMs: input.delayMs });
      },
    }),
  );
}
