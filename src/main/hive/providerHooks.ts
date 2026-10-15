/**
 * Per-provider lifecycle-hook bridges (agy, gemini, codex, pi, opencode, crush, grok):
 * writes each CLI's hook config / plugin so its events reach the HookServer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, lstatSync, realpathSync, rmSync, symlinkSync, unlinkSync, copyFileSync, cpSync } from 'node:fs';
import { join, dirname, basename, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { AGY_HOOK_SHIM, GEMINI_HOOK_SHIM, PI_EXTENSION, OPENCODE_PLUGIN, GROK_HOOK_SHIM } from './shims';

/** What ProviderHooks needs from HiveManager. */
export interface ProviderHookHost {
  root(): string | null;
  shimPath(): string | null;
  nodeRun(script: string, ...args: string[]): string;
  nodeRunUnquoted(script: string, ...args: string[]): string;
}

export class ProviderHooks {
  constructor(private readonly host: ProviderHookHost) {}

  private root(): string | null { return this.host.root(); }
  private shimPath(): string | null { return this.host.shimPath(); }
  private nodeRun(script: string, ...args: string[]): string { return this.host.nodeRun(script, ...args); }
  private nodeRunUnquoted(script: string, ...args: string[]): string { return this.host.nodeRunUnquoted(script, ...args); }

  /** Install the Antigravity (`agy`) lifecycle-hook bridge: write the normalizer
   *  shim and merge a `munder-hive` hook group into agy's global hooks.json so a
   *  Gemini worker reports PreToolUse/PostToolUse/Stop/PreInvocation/PostInvocation
   *  to this HookServer (live status + guarded idle delivery), reusing the Claude pipeline.
   *
   *  Two agy-isms handled: (1) antigravity-cli#49 — agy LOADS hooks from
   *  `~/.gemini/antigravity-cli/hooks.json` but TRIGGERS from `~/.gemini/config/
   *  hooks.json`, so we write BOTH; (2) on Windows commands go to cmd.exe and
   *  agy mangles embedded quotes, so that platform retains the legacy form.
   *  Runtime-scoped by AGENT_ID (the shim no-ops for non-hive agy sessions), so
   *  this global config never disturbs the user's own `agy` usage. Best-effort,
   *  idempotent (only our own group is overwritten). */
  installAgyHooks(): void {
    const root = this.root();
    if (!root) return;
    const shim = join(root, 'bin', 'agy-hook.cjs');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(shim, AGY_HOOK_SHIM, 'utf8');
    // Bundled node, not bare `node` — agy's hooks run with a stripped PATH too.
    const command = (event: string) => process.platform === 'win32'
      ? this.nodeRunUnquoted(shim, event)
      : this.nodeRun(shim, event);
    const tool = (event: string) => ({
      matcher: '*',
      hooks: [{ type: 'command', command: command(event), timeout: 0 }]
    });
    const plain = (event: string) => ({
      hooks: [{ type: 'command', command: command(event), timeout: 0 }]
    });
    const group = {
      PreToolUse: [tool('PreToolUse')],
      PostToolUse: [tool('PostToolUse')],
      PreInvocation: [plain('PreInvocation')],
      PostInvocation: [plain('PostInvocation')],
      Stop: [plain('Stop')]
    };
    const gem = join(homedir(), '.gemini');
    for (const p of [join(gem, 'config', 'hooks.json'), join(gem, 'antigravity-cli', 'hooks.json')]) {
      try {
        mkdirSync(dirname(p), { recursive: true });
        let existing: Record<string, unknown> = {};
        if (existsSync(p)) {
          try { existing = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { existing = {}; }
        }
        existing['munder-hive'] = group;
        writeFileSync(p, JSON.stringify(existing, null, 2), 'utf8');
      } catch { /* best-effort per file */ }
    }
  }

  /** Official Google Gemini CLI lifecycle bridge. Gemini's hook payload is
   *  already snake_case; the shim maps event names into HookServer's common
   *  vocabulary and translates deny/steering replies back to Gemini.
   *
   *  The system settings path is per agent. Gemini merges object and array
   *  settings across layers, so auth and user settings remain in their normal
   *  GEMINI_CLI_HOME while this trusted bridge stays isolated. */
  installGeminiHooks(dir: string): string {
    const home = join(dir, '.gemini-hive');
    const settingsPath = join(home, 'system-settings.json');
    try {
      mkdirSync(home, { recursive: true });
      const shim = join(home, 'gemini-hook.cjs');
      writeFileSync(shim, GEMINI_HOOK_SHIM, 'utf8');
      const hook = (name: string, matcher?: string) => ({
        ...(matcher ? { matcher } : {}),
        sequential: true,
        hooks: [{
          name: `munder-hive-${name}`,
          type: 'command',
          command: process.platform === 'win32'
            ? this.nodeRunUnquoted(shim)
            : this.nodeRun(shim),
          timeout: 30000
        }]
      });
      const settings = {
        hooksConfig: { enabled: true, notifications: false },
        hooks: {
          SessionStart: [hook('session-start')],
          BeforeAgent: [hook('before-agent')],
          BeforeTool: [hook('before-tool', '.*')],
          AfterTool: [hook('after-tool', '.*')],
          AfterAgent: [hook('after-agent')]
        }
      };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    } catch (e) { console.error('[hive] installGeminiHooks failed:', e); }
    return settingsPath;
  }

  /** Codex lifecycle-hook bridge → full hive parity for a `codex` worker (live
   *  status + Stop→inbox-drain), the codex counterpart of installAgyHooks().
   *
   *  Codex's hook contract is already Claude-shaped: snake_case stdin
   *  (hook_event_name/tool_name/tool_input/session_id/cwd) and a matching response
   *  contract, where `Stop` honoring {decision:'block',reason} means "continue,
   *  using reason as the next prompt" — exactly what drainForStop() returns. So we
   *  reuse the Claude `cth-hook` shim VERBATIM (no translator, unlike agy) and let
   *  HookServer handle everything unchanged.
   *
   *  ISOLATION: rather than mutate the user's global Codex configuration (which
   *  also holds their login), we point this worker at a PER-AGENT CODEX_HOME
   *  (`<dir>/.codex`, alongside Claude's settings.json) holding our own config.toml
   *  with `[hooks]` tables — so the hooks fire ONLY for hive workers and a personal
   *  `codex` run is untouched. Rollout directories are linked into that isolated
   *  home from namespaced paths under the standard global scan roots. The user's
   *  ~/.codex/auth.json is linked in and their config.toml is copied + extended
   *  (login + model/provider/trust settings still apply).
   *  Returns the CODEX_HOME path for the caller to put in the worker's env. */
  installCodexHooks(dir: string, agentId: string): string {
    const home = join(dir, '.codex');
    try {
      mkdirSync(home, { recursive: true });
      const userHome = join(homedir(), '.codex');
      // Symlink the user's login so the isolated home authenticates as them.
      // (config.toml is NOT symlinked — we write our own below, seeded from theirs,
      // because it must carry our [hooks] tables.) Fall back to copy where symlinks
      // need privilege (Windows). Idempotent — skip if already linked.
      const authSrc = join(userHome, 'auth.json');
      const authDest = join(home, 'auth.json');
      if (existsSync(authSrc) && !existsSync(authDest)) {
        try { symlinkSync(authSrc, authDest); }
        catch { try { copyFileSync(authSrc, authDest); } catch { /* best-effort */ } }
      }
      // The managed app-server daemon used by Codex Remote Control is launched
      // from the standalone install rooted at $CODEX_HOME/packages. Share the
      // user's installed binaries without duplicating them into every agent.
      const packagesSrc = join(userHome, 'packages');
      const packagesDest = join(home, 'packages');
      if (existsSync(packagesSrc) && !existsSync(packagesDest)) {
        try {
          symlinkSync(packagesSrc, packagesDest, process.platform === 'win32' ? 'junction' : 'dir');
        } catch { /* remote integration falls back to a local TUI if unavailable */ }
      }
      // Wire lifecycle hooks via config.toml `[hooks]` tables — the user-layer
      // discovery surface Codex actually scans. (A bare $CODEX_HOME/hooks.json is
      // plugin-scoped — referenced FROM a plugin manifest — and is NOT discovered
      // for a plain config dir; verified empirically that it never fires.) We seed
      // this config.toml from the user's (their model/provider/trust settings carry
      // over) and append a `[[hooks.<Event>]]` group per event, each pointing at the
      // SAME cth-hook shim — reused verbatim (Codex's hook payload + response are
      // already Claude-shaped, so HookServer/drainForStop run unchanged). Regenerated
      // each spawn (idempotent). Serialize the generated command as a TOML basic
      // string; JSON string escaping is compatible here and, on POSIX, preserves
      // the embedded quotes required when a user-selected hive path has spaces.
      // NOTE: hooks fire in INTERACTIVE codex sessions (how hive workers run),
      // not in headless `codex exec`.
      //
      // `timeout` IS SECONDS HERE — do NOT copy Claude's `timeout: 0` sentinel into
      // this file. Codex parses the key as `timeout_sec` and normalizes it with
      // `timeout_sec.unwrap_or(600).max(1)`, so 0 does not mean "no timeout": it is
      // floored to ONE SECOND, the shortest budget there is. That shipped through
      // v0.3.7 and made every codex worker log `SessionStart hook (failed) — hook
      // timed out after 1s` (same for UserPromptSubmit), because each hook cold-starts
      // the Electron binary via hive-node and then waits on hooks.sock — measured
      // 0.08-0.16s idle but 0.6-0.7s under 8 concurrent spawns, which is exactly what
      // session start and prompt dispatch look like. 30s clears that by two orders of
      // magnitude while still capping a wedged shim well before its own 5s internal
      // cap stops mattering; bare omission (600s) would leave a hang looking like a
      // freeze. Verify any change with codex's own resolver, no model spend:
      // `codex app-server` → initialize → `hooks/list` reports the normalized
      // timeoutSec per event.
      const shim = this.shimPath();
      let config = existsSync(join(userHome, 'config.toml'))
        ? readFileSync(join(userHome, 'config.toml'), 'utf8') : '';
      if (shim) {
        const events = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop',
          'SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact'];
        // Preserve the existing Windows .cmd shape: nested command quotes pass
        // through a different shell stack there (#350). The reported Codex bug
        // is POSIX, where ordinary shell quoting is both necessary and verified.
        const command = process.platform === 'win32'
          ? this.nodeRunUnquoted(shim)
          : this.nodeRun(shim);
        config += '\n# --- munder-hive lifecycle hooks (auto-generated; do not edit) ---\n';
        for (const ev of events) {
          config += `\n[[hooks.${ev}]]\n[[hooks.${ev}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ntimeout = 30\n`;
        }
      }
      writeFileSync(join(home, 'config.toml'), config, 'utf8');

      // Keep each worker's CODEX_HOME isolated while putting its rollout data
      // below Codex's standard scan roots. External usage tools can then discover
      // the sessions without understanding the hive's private directory layout.
      this.exposeCodexDataDirs(home, userHome, agentId);
    } catch (e) { console.error('[hive] installCodexHooks failed:', e); }
    return home;
  }

  exposeCodexDataDirs(home: string, userHome: string, agentId: string): void {
    for (const kind of ['sessions', 'archived_sessions'] as const) {
      try { this.exposeCodexDataDir(home, userHome, agentId, kind); }
      catch (e) { console.error(`[hive] exposeCodexDataDir(${kind}) failed:`, e); }
    }
  }

  moveCodexDataDir(from: string, to: string): void {
    try {
      renameSync(from, to);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
      rmSync(from, { recursive: true, force: true });
    }
  }

  exposeCodexDataDir(
    home: string,
    userHome: string,
    agentId: string,
    kind: 'sessions' | 'archived_sessions'
  ): void {
    const root = this.root();
    if (!root) return;
    if (!agentId || basename(agentId) !== agentId || agentId === '.' || agentId === '..') {
      throw new Error(`invalid agent id: ${agentId}`);
    }
    const source = join(home, kind);
    const scanRoot = join(userHome, kind, 'munder-difflin');
    const hiveId = createHash('sha1').update(root).digest('hex').slice(0, 12);
    const target = join(scanRoot, hiveId, agentId);

    let sourceStat: ReturnType<typeof lstatSync> | null = null;
    try { sourceStat = lstatSync(source); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }

    if (sourceStat?.isSymbolicLink()) {
      let current: string | null = null;
      try { current = realpathSync(source); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        unlinkSync(source);
        sourceStat = null;
      }
      if (current) {
        const rel = relative(realpathSync(scanRoot), current);
        const scope = dirname(rel);
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)
          && dirname(scope) === '.' && basename(rel) === agentId) return;
        throw new Error(`${source} points outside ${scanRoot}`);
      }
    }
    if (sourceStat && !sourceStat.isDirectory()) throw new Error(`${source} is not a directory`);

    mkdirSync(dirname(target), { recursive: true });
    if (sourceStat) {
      if (existsSync(target)) {
        if (readdirSync(target).length > 0) throw new Error(`${source} and ${target} both contain data`);
        rmSync(target, { recursive: true, force: true });
      }
      this.moveCodexDataDir(source, target);
    } else if (!existsSync(target)) {
      mkdirSync(target, { recursive: true });
    }

    try {
      symlinkSync(target, source, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (!existsSync(source) && existsSync(target)) {
        try { this.moveCodexDataDir(target, source); } catch { /* data remains at target */ }
      }
      throw e;
    }
  }

  /** Remove rollout directories moved under the user's standard Codex scan
   *  roots before a full hive reset removes the isolated CODEX_HOME links. */
  removeExposedCodexData(): void {
    const root = this.root();
    if (!root) return;
    const agents = join(root, 'agents');
    if (!existsSync(agents)) return;
    const userHome = join(homedir(), '.codex');

    for (const entry of readdirSync(agents, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const kind of ['sessions', 'archived_sessions'] as const) {
        const source = join(agents, entry.name, '.codex', kind);
        try {
          if (!lstatSync(source).isSymbolicLink()) continue;
          const target = realpathSync(source);
          const scanRoot = realpathSync(join(userHome, kind, 'munder-difflin'));
          const rel = relative(scanRoot, target);
          const scope = dirname(rel);
          if (!rel || rel.startsWith('..') || isAbsolute(rel)
            || dirname(scope) !== '.' || basename(rel) !== entry.name) continue;
          rmSync(target, { recursive: true, force: true });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('[hive] removeExposedCodexData failed:', e);
          }
        }
      }
    }
  }

  /** Pi (earendil-works) bridge. Pi has a rich `pi.on(event, …)` lifecycle but no
   *  Claude-shaped hook file; instead we drop a bundled EXTENSION into a PER-AGENT
   *  PI_CODING_AGENT_DIR (so the user's global ~/.pi is never mutated) that, when Pi
   *  loads it, posts cth-hook-shaped payloads to HIVE_SOCK on tool_call/agent_end and
   *  auto-approves tool calls when the floor is in auto mode (HIVE_AUTO_APPROVE).
   *  Emitting an `agent_end`→`Stop` keeps the harness status in step (→ idle), which
   *  lets the renderer idle inbox-wake nudge deliver mail. Returns the per-agent dir
   *  for PI_CODING_AGENT_DIR.
   *
   *  LIVE-UNVERIFIED: Pi's exact extension-discovery path + event API need BYOK keys
   *  to confirm; this is written best-effort and wrapped so a wrong guess can never
   *  break the spawn. The renderer nudge is the guaranteed drain regardless. */
  installPiHooks(dir: string): string {
    const home = join(dir, '.pi-agent');
    try {
      // Pi discovers extensions under its agent dir; we write to the documented
      // `extensions/` location (and keep it isolated per agent).
      const extDir = join(home, 'extensions');
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, 'hive-bridge.js'), PI_EXTENSION, 'utf8');
      // A manifest so Pi auto-loads the extension on start (best-effort; harmless if
      // Pi ignores it). Kept minimal and hive-authored.
      const manifest = { name: 'munder-hive-bridge', version: '0.3.2', main: 'extensions/hive-bridge.js', auto: true };
      writeFileSync(join(home, 'extensions.json'), JSON.stringify(manifest, null, 2), 'utf8');

      const userPiDir = join(homedir(), '.pi', 'agent');
      for (const fileName of ['models.json', 'models-store.json'] as const) {
        try {
          const data = readFileSync(join(userPiDir, fileName), 'utf8');
          writeFileSync(join(home, fileName), data, 'utf8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[hive] installPiHooks copy ${fileName} failed:`, e);
        }
      }
    } catch (e) { console.error('[hive] installPiHooks failed:', e); }
    return home;
  }

  /** OpenCode (anomalyco/opencode) bridge — god Decision 1 (native plugin, not proxy).
   *  OpenCode has no Claude-shaped Stop hook, but its plugin API exposes a real
   *  `session.idle` lifecycle event. We drop a bundled PLUGIN into a PER-AGENT config
   *  dir's `plugin/` folder (OpenCode auto-loads `*.js` plugins from there) that posts
   *  HIVE_SOCK payloads on tool.execute.before/after + session.idle — the same
   *  Stop→drain semantics as codex's hooks, provider-agnostic, no traffic interception.
   *  Returns the config dir for OPENCODE_CONFIG_DIR (isolates from ~/.config/opencode).
   *
   *  LIVE-UNVERIFIED: plugin auto-load + session.idle firing + the inject path need
   *  BYOK keys to confirm; written best-effort, wrapped so it can't break the spawn.
   *  The renderer idle inbox-wake nudge is the guaranteed drain fallback. */
  installOpenCodePlugin(dir: string, theme?: 'light' | 'dark'): string {
    const home = join(dir, '.opencode');
    try {
      // Theme: OpenCode's `system` theme keeps the terminal's own fg/bg (xterm's,
      // which already follows the app theme) and builds its greys from the
      // detected background, so it reads right on light AND dark. Written to
      // tui.json (current builds) and opencode.json (older builds read `theme`
      // there and migrate it; the migration skips when tui.json already exists).
      // Per-agent dir only, the user's ~/.config/opencode is never touched.
      if (theme) {
        mkdirSync(home, { recursive: true });
        const choice = { theme: 'system' };
        writeFileSync(join(home, 'tui.json'), JSON.stringify({ $schema: 'https://opencode.ai/tui.json', ...choice }, null, 2), 'utf8');
        writeFileSync(join(home, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...choice }, null, 2), 'utf8');
      }
      // BOTH `plugin/` and `plugins/`. OpenCode's current docs specify `plugins/`
      // (plural); older builds — and the shape this bridge was originally written
      // against — auto-load from `plugin/` (singular). Since the whole bridge is
      // LIVE-UNVERIFIED (no BYOK keys to prove which the installed version reads),
      // guessing one of them is a coin flip whose losing side is silent: the plugin
      // simply never loads and the agent's only inbox drain becomes the renderer
      // nudge. Writing the same ~2KB file twice costs nothing, is idempotent, and
      // is correct whichever directory the installed OpenCode actually scans.
      for (const name of ['plugin', 'plugins']) {
        const pluginDir = join(home, name);
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(join(pluginDir, 'hive-bridge.js'), OPENCODE_PLUGIN, 'utf8');
      }
    } catch (e) { console.error('[hive] installOpenCodePlugin failed:', e); }
    return home;
  }

  /** Crush (charmbracelet/crush) proxy routing. Crush has NO base-URL env override, so
   *  the generic proxy env-rewrite is a no-op for it; instead we write a per-agent
   *  CRUSH_GLOBAL_CONFIG whose standard providers' `base_url` all point at the loopback
   *  proxy (so whatever model the worker picks, its LLM traffic routes through the
   *  sidecar → synthesized Status/Stop/cost → status goes idle → the terminal
   *  work-order + renderer nudge deliver mail). A per-agent CRUSH_GLOBAL_DATA isolates
   *  session state from the user's global ~/.config/crush. Keys ride BYOK env vars
   *  (Crush reads ANTHROPIC_API_KEY/OPENAI_API_KEY/… directly), so none are written
   *  here. `api` follows the proxy's wire shape (advisory). Returns the config + data
   *  paths for the spawn env.
   *
   *  LIVE-UNVERIFIED: the single-upstream proxy serves one provider/endpoint shape at a
   *  time — for full synthesized events pick a model whose provider matches the
   *  configured upstream (or a local OpenAI-compatible endpoint). Cross-provider mixing
   *  is humanQA; the renderer nudge still delivers mail regardless. */
  installCrushConfig(dir: string, loopbackUrl: string, api: 'openai' | 'anthropic', theme?: 'light' | 'dark'): { config: string; data: string } {
    const config = join(dir, 'crush.json');
    const data = join(dir, '.crush-data');
    try {
      mkdirSync(data, { recursive: true });
      // Override base_url → loopback for ONLY the provider whose wire-shape matches
      // the proxy (`api`): the single-upstream sidecar forwards bytes unchanged, so
      // routing a different-wire/host provider (e.g. anthropic when api='openai', or
      // openrouter/groq which are openai-wire but different hosts) through it would
      // hit the wrong endpoint and the call would fail. Those are left to their real
      // upstreams (working calls, un-proxied — no synthesized events, but mail still
      // drains via the renderer nudge + the pty-quiescence idle fallback). For the
      // default god (openai-wire) and a local OpenAI-compatible endpoint this routes
      // through the proxy cleanly. Cross-provider Crush-via-proxy is on-device
      // live-verify (Dwight verify-crush MF1; the default god model is openai-wire to
      // match). Literal loopback (Dwight's b1 — no ${VAR} expansion edge cases);
      // Crush merges config so only base_url is rewritten.
      const wireProvider = api === 'anthropic' ? 'anthropic' : 'openai';
      const providers: Record<string, { base_url: string }> = { [wireProvider]: { base_url: loopbackUrl } };
      // Theme: Crush ships one (dark) palette and no light theme, but
      // `options.tui.transparent` stops it painting its own background, so it
      // sits on xterm's, which follows the app theme. Set whenever the app
      // passes a theme, dark included, so both modes look the same way.
      const options = theme ? { tui: { transparent: true } } : undefined;
      writeFileSync(config, JSON.stringify(options ? { providers, options } : { providers }, null, 2), 'utf8');
    } catch (e) { console.error('[hive] installCrushConfig failed:', e); }
    return { config, data };
  }

  /** Grok lifecycle-hook bridge → live hive status, session capture, guarded
   *  inbox delivery, and operator gates for `grok` workers.
   *
   *  Grok supports the same hook events and decision vocabulary as Claude Code,
   *  but its stdin payload uses camelCase keys. A small adapter normalizes those
   *  keys to HookServer's Claude-shaped contract. The hook is installed in the
   *  user's global Grok hook directory because global hooks are trusted and
   *  Grok sessions/resume stay in the user's normal GROK_HOME. The adapter is
   *  strictly scoped by AGENT_ID, so ordinary Grok sessions exit without doing
   *  anything. Best-effort and idempotent. */
  installGrokHooks(): void {
    const root = this.root();
    if (!root) return;
    try {
      const shim = join(root, 'bin', 'grok-hook.cjs');
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(shim, GROK_HOOK_SHIM, 'utf8');
      const tool = (matcher?: string) => ({
        ...(matcher ? { matcher } : {}),
        // Let Grok apply its event-aware defaults (5s normally, 600s for Stop).
        // Grok is a HOOK bridge (not a proxy sidecar), so it is hit by the same
        // `node: command not found` 127 — bundled node here too.
        hooks: [{ type: 'command', command: this.nodeRun(shim) }]
      });
      const hooks = {
        PreToolUse: [tool('.*')],
        PostToolUse: [tool('.*')],
        Stop: [tool()],
        SubagentStop: [tool('.*')],
        SessionStart: [tool('.*')],
        UserPromptSubmit: [tool()],
        PreCompact: [tool('.*')],
        PostCompact: [tool('.*')]
      };
      const hookDir = join(homedir(), '.grok', 'hooks');
      mkdirSync(hookDir, { recursive: true });
      writeFileSync(
        join(hookDir, 'munder-hive.json'),
        JSON.stringify({ hooks }, null, 2),
        'utf8'
      );
    } catch (e) { console.error('[hive] installGrokHooks failed:', e); }
  }
}
