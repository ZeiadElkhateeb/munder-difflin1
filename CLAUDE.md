# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Munder Difflin: an Electron desktop app (React + TypeScript + Pixi.js + xterm.js + node-pty) that runs terminal coding-agent CLIs (`claude`, `codex`, `agy`, `grok`, `kimi`, `gemini`, `qwen`, `opencode`, `crush`, `pi`, `copilot`, `cursor`, custom) as real PTY processes, coordinates them through a file-based "hive", and draws them as avatars on an office floor. One agent is the orchestrator ("god", named Michael) that the user briefs.

Design docs: `HIVE.md` (multi-agent layer — source of truth for intent), `docs/ARCHITECTURE.md` (module map), `docs/message-queue.md` (who may type into a PTY and when), `DESIGN.md` (visual system). `SPEC.md` is the original MVP spec and is partly stale (it describes tmux; the code uses node-pty).

## Commands

```bash
npm run dev              # electron-vite dev with live reload
npm run build            # electron-vite build + copy .cjs main assets into out/main
npm run typecheck        # tsc for both tsconfig.node.json (main/preload/shared) and tsconfig.web.json (renderer)
npm run test:focused     # node --test test/*.test.cjs
node --test test/worker-wake.test.cjs                         # one test file
node --test --test-name-pattern="<substring>" test/<file>.test.cjs   # one test
npm run check:links      # release gate: download links / version strings must match package.json
npm run dist:win|dist:mac|dist:linux   # packaged builds via electron-builder
```

CI (`.github/workflows/ci.yml`) runs `typecheck`, `check:links`, `test:focused` (on macOS), and `build`. There is no linter.

Blog (separate Eleventy project): `cd blog && npm ci && npm run build`. The built output in `docs/blog` and `docs/sitemap.xml` must be committed with the source change — the `blog.yml` workflow rebuilds and fails on stale output.

### Install gotchas

`postinstall` runs `electron-rebuild` so `node-pty` and `better-sqlite3` match Electron 32's ABI, then patches node-pty (`tools/patch-node-pty-conpty.cjs`). On Windows with a newer system Node (e.g. 24), plain `npm install` can fail because better-sqlite3 first tries to compile against system Node's headers (which demand the ClangCL toolset). Workaround that works: `npm install --ignore-scripts`, `node node_modules/electron/install.js`, then `npm run postinstall`. If node-pty fails with MSB8040, install the MSVC Spectre-mitigated libs (or set `SpectreMitigation` to `'false'` in node-pty's `binding.gyp` and `deps/winpty/src/winpty.gyp`). If winpty's `GetCommitHash.bat` fails, unset `NoDefaultCurrentDirectoryInExePath` for the rebuild. `npm run dev` will not open a window if `ELECTRON_RUN_AS_NODE=1` is set in the shell (VS Code's extension host sets it). Unpackaged builds use their own profile (`%APPDATA%\munder-difflin-dev`: separate config, hive and hook pipe; see `src/main/devProfile.ts`), so the first `npm run dev` starts at onboarding. Set `MUNDER_DIFFLIN_PROFILE=default` to run a dev build against the installed app's profile.

### Tests

Tests are plain CommonJS (`test/*.test.cjs`) using `node:test`. `test/load-ts.cjs` transpiles `src/**/*.ts` on the fly with the TypeScript compiler (resolving `@shared/` imports), so tests import TS modules directly: `loadTs('src/main/workerWake.ts')`. Modules meant to be tested avoid importing `electron` (e.g. `workerWake.ts`, `control.ts`, `breaker.ts`) — keep that property when adding logic you want covered.

Tests that pin main-process wiring by reading source text use `readMainSource()` from `test/main-source.cjs` (the concatenated, LF-normalized split modules). When you add a module carved out of the main wiring, add it to `MAIN_WIRING_FILES` there. Prefer extracting a pure function and testing behaviour over adding new source-text tests.

Some older tests still assert on renderer source text with regexes that expect `\n` line endings, so they fail on a CRLF checkout (`core.autocrlf=true`). Symlink tests fail on Windows without Developer Mode. Those failures are environmental, not regressions.

## Architecture

### Processes and the IPC seam

- `src/main/` — Electron main process, split by domain. `index.ts` is only the composition root: process guards, single-instance/deep-link setup, `app.whenReady`, quit hooks, and one `registerXxx()` call per domain module.
  - `services.ts` constructs the long-lived singletons (`ptyManager`, `hive`, `hookServer`, `telemetry`, `breaker`, `memory`, `persist`, …); other modules import them from there.
  - Domain modules own their state, helpers and IPC: `agentSpawn.ts` (spawn/teardown, pty:*), `workers.ts` (ephemeral workers), `schedules.ts` (missions, context triggers), `heartbeat.ts` (fleet snapshot, breaker and wake beats), `slackService.ts`, `webhookService.ts`, `windows.ts` (window registry, `liveWebContents`, hire deep links), `lifecycle.ts` (bootstrap, quit, reset, change-home), `realtimeWiring.ts`.
  - `ipc/*.ts` hold handler-only groups (app, config, fs+git, hive, catalog, integrations).
  - Shared mutable state that several modules write lives behind accessors (e.g. `quitState.ts`), because an imported `let` cannot be reassigned.
- `src/preload/index.ts` — exposes the whole typed API as `window.cth` via `contextBridge`. The renderer talks to main **only** through `window.cth`.
- **IPC contract**: every channel name is listed in `src/shared/ipcChannels.ts`. Main imports `ipcMain` from `src/main/ipc/typedIpc.ts` and preload narrows `ipcRenderer` the same way, so an unlisted channel is a compile error. `test/ipc-contract.test.cjs` checks each request channel has exactly one handler and a caller, and that pushed events are subscribed. Adding a capability = add the channel to the contract, a handler in the owning main module, a method in preload.
- `src/renderer/src/` — React UI (zustand store in `store/store.ts`; hive wiring in `hooks/useHive.ts`; Pixi floor in `scene/office/`).
- `src/shared/` — dependency-free code used by both sides (no electron, no UI). Imported as `@shared/...`.

### Two data planes

1. **Terminal plane** — `main/pty.ts` (`PtyManager`) spawns each agent with node-pty and streams bytes to the renderer on per-id channels (`pty:data:<id>`). Renderer terminals are pooled (`components/terminalPool.ts`).
2. **Event plane** — each CLI's lifecycle hooks (PreToolUse/PostToolUse/Stop/Notification/…) are forwarded by a small shim to a local socket served by `main/hooks.ts` (`HookServer`). These events drive avatar state, live status, cost, and inbox delivery.

### The hive (`main/hive.ts`, `HiveManager`)

`hive.ts` holds `HiveManager` (workspace, registry, routing, spawn injection); its supporting code is in `main/hive/` (`types`, `commitQueue`, `providerHooks`, `shims`, `generatedDocs`, `util`) and is re-exported from `hive.ts`, so import from `./hive`.

A local git repo of plain files under `<harnessHome>/hive/`: `registry.json`, `board.md`, `tasks.json`, `log.jsonl`, and per agent `agents/<id>/{identity.md, memory.md, inbox/, outbox/, cursor.json}`. Invariants that the rest of the code relies on:

- **Single committer**: only the main process runs git on the hive. Agents never do.
- **Commits are async in the app**: `HiveManager` commits synchronously by default (tests, scripts), but `services.ts` calls `hive.setCommitMode('async')`, which debounces commits into one batch per root and runs git as a child process so a commit (and its inline `gc`) never blocks the main event loop. Anything that copies, wipes or abandons the hive must call `hive.flushCommitsSync()` first (see `lifecycle.ts` and the `will-quit` hook).
- **Single writer per file**: an agent writes only into its own `outbox/`; the router (`routeOnce`, ~1.5 s interval) moves messages into recipients' `inbox/`. Message files are written atomically (temp + rename), one JSON file per message.
- Messages use speech acts (`request | inform | propose | query | agree | refuse | done`) with a `hops` counter to stop ping-pong loops.
- **Autonomous loop**: when an agent tries to stop, the Stop hook calls `drainForStop`; unread mail returns `{decision:"block", reason}` so the agent keeps working.
- The injected system prompt (`injectedPrompt`) must stay **volatile-free** (no dates, counters, live state) to preserve prompt caching, and must contain **no shell syntax** (`$VAR`, hand-joined `/` paths) — absolute paths via `path.join` so it works in cmd/PowerShell too.

### Providers (`shared/agentProvider.ts`)

Each CLI is an `AgentProviderPreset`: spawn command, model/auto-mode flags, how the initial hive prompt is delivered (flag, positional, or typed into the TUI), and how it joins the event plane:
- `claude` is `hiveAware` — identity via `--append-system-prompt`, hooks via `--settings`.
- Others use a `hookBridge`/`bridge` descriptor: config-file hook shims (agy, codex, grok, pi, opencode, gemini) or a loopback **proxy** sidecar that observes LLM traffic and synthesizes hook payloads (qwen).
- `canReceiveInbox` gates whether the router delivers mail or bounces it to god.

Shared behavior must stay provider-neutral; provider-specific logic goes behind an explicit provider check.

### Writing into an agent's terminal

There is one gate: the renderer's MD-queue drain loop in `useHive.ts`. Composer input, Slack ingress, inbox nudges, and scheduled commands all `enqueueMessage(...)`; the drain delivers only when the agent is idle, auto-delivery isn't paused, it is past boot grace, the user doesn't own the prompt (`isTerminalAutomationSafe`), and a cooldown has passed. That ordered decision is the pure `deliveryBlocker()` in `hooks/queueDelivery.ts` (behaviour-tested in `test/queue-delivery-gate.test.cjs`); "send now" bypasses only the pause. Don't add a second writer. The main-process `workerWake.ts` watchdog is the deliberate backstop for when the renderer's timers are throttled, and mirrors the same guards. See `docs/message-queue.md`.

### Safety and cost

`breaker.ts` is a pure circuit breaker escalating steer → constrain → stop, one level per beat; `control.ts` is the HITL gate / pause / steer registry. Cost comes from `telemetry.ts` (OTel), `transcript.ts` (Claude JSONL transcripts), and `pricing.ts`, recorded to a ledger via `db.ts` (better-sqlite3).

## Conventions

- Must work on macOS, Windows, and Linux, including paths with spaces. Use `path.join`, never hand-built `"a/b"` strings.
- UI derives from design tokens (`DESIGN.md`, `src/renderer/src/design/tokens.ts`). `tokens.ts` and `tokens.css` are mirrored — change both.
- UI strings live in `src/renderer/src/i18n/locales/{en,ar,zh-CN}.json` (react-i18next); keep the three key sets in parity.
- Avatar motion on the floor is still partly fed by a demo loop (`store/mockEvents.ts`, started from `App.tsx`).
- Upstream PRs require before/after evidence under `### Before` / `### After` headings (enforced by the `PR evidence` check), one change per PR, and no unrelated reformatting (see `CONTRIBUTING.md`).
