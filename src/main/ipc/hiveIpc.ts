/**
 * Hive IPC: registry, board, tasks, messages, memory and knowledge graph, command
 * history, usage/telemetry, operator control, text search and GitHub ingestion.
 */
import { BrowserWindow, dialog } from 'electron';
import { ipcMain } from './typedIpc';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, writeConfig } from '../config';
import type { HiveMessage, HiveTask } from '../hive';
import { readAgentUsage, readContextTokens } from '../transcript';
import { listIssues, listCIRuns } from '../github';
import { analytics } from '../analytics';
import { breaker, control, hive, hookServer, knowledge, memory, persist, reflector, roster, telemetry } from '../services';
import { liveWebContents } from '../windows';


/** Registers this module's IPC handlers and load-time wiring. Called once from index.ts. */
export function registerHiveIpc(): void {
  // ─── IPC: roster mirror (shared between dev and a packaged build) ───────────
  // The renderer's store is built synchronously at module load, before any async
  // IPC could resolve, so the read is `ipcMain.on` + `returnValue` — one blocking
  // round trip at boot, in exchange for the roster being correct on first paint
  // instead of flashing an empty floor and then filling in.
  // (`roster` itself is constructed earlier so HookServer can read standing goals.)
  ipcMain.on('roster:readSync', (evt) => { evt.returnValue = roster.read(); });
  ipcMain.on('config:homeSync', (evt) => { evt.returnValue = readConfig().harnessHome ?? null; });
  ipcMain.handle('roster:write', (_evt, snap: unknown) => roster.write(snap));

  // ─── IPC: hive (multi-agent coordination) ───────────────────────────────────
  ipcMain.handle('hive:registry', () => hive.registry());
  ipcMain.handle('hive:renameAgent', (_evt, id: unknown, name: unknown) => {
    if (typeof id !== 'string' || typeof name !== 'string') {
      return { ok: false, error: 'Invalid rename request' };
    }
    return hive.renameAgent(id, name);
  });
  ipcMain.handle('hive:setAgentHold', (_evt, id: unknown, hold: unknown) => {
    if (typeof id !== 'string' || typeof hold !== 'boolean') {
      return { ok: false, error: 'Invalid hold request' };
    }
    return hive.setAgentHold(id, hold);
  });
  ipcMain.handle('hive:board', () => hive.board());
  ipcMain.handle('hive:tasks', () => hive.tasks());
  ipcMain.handle('hive:log', (_evt, n: unknown) => hive.logTail(typeof n === 'number' ? n : 200));
  ipcMain.handle('hive:memory', (_evt, id: unknown) => (typeof id === 'string' ? hive.memory(id) : ''));
  ipcMain.handle('hive:inbox', (_evt, id: unknown) => (typeof id === 'string' ? hive.inbox(id) : []));
  // Voice read-layer: recent message CONTENT (inbox/outbox bodies), REDACTED
  // main-side by hive.voiceMessages(). The renderer/voice layer never sees a raw
  // body — secrets are stripped here, before the result crosses IPC.
  ipcMain.handle('hive:messages', (_evt, opts: unknown) =>
    hive.voiceMessages(opts && typeof opts === 'object' ? (opts as Parameters<typeof hive.voiceMessages>[0]) : {})
  );
  ipcMain.handle('hive:send', (_evt, partial: Partial<HiveMessage>, from: unknown) => {
    if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
    const sender = typeof from === 'string' ? from : 'system';
    const msg = hive.send(partial ?? {}, sender);
    // Count only what a PERSON sent. Every renderer surface that dispatches on a
    // human's behalf passes 'human' (Command Center dispatch, thread replies, ASK
    // ME answers); agent-to-agent traffic passes the agent id and would swamp the
    // number. Counted AFTER the send so a rejected message is never counted.
    if (sender === 'human') analytics.trackMessageSent('hive');
    return { ok: true, message: msg };
  });
  ipcMain.handle('hive:addTask', (_evt, task: unknown) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)
      || typeof (task as { id?: unknown }).id !== 'string') {
      return { ok: false, error: 'invalid task' };
    }
    if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
    return { ok: hive.addTask(task as HiveTask) };
  });
  ipcMain.handle('hive:patchTask', (_evt, id: unknown, patch: unknown) => {
    if (typeof id !== 'string' || !id || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'invalid task patch' };
    }
    if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
    return { ok: hive.patchTask(id, patch as Partial<Omit<HiveTask, 'id'>>) };
  });
  ipcMain.handle('hive:deleteTask', (_evt, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid task id' };
    if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
    return { ok: hive.deleteTask(id) };
  });
  ipcMain.handle('hive:setArchived', (_evt, id: unknown, archived: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
    if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
    hive.setArchived(id, archived === true);
    return { ok: true };
  });
  ipcMain.handle('hive:patchAgentRole', (_evt, id: unknown, role: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
    if (typeof role !== 'string') return { ok: false, error: 'invalid role' };
    if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
    return hive.patchAgentRole(id, role);
  });

  // ─── IPC: semantic memory (MemPalace CLI) ───────────────────────────────────
  // refresh() = resetBinCache + an idempotent start(). The poll is the one thing
  // that reliably notices mempalace being installed after boot, so it is what arms
  // the mine loop that boot's start() had to skip — otherwise the pill reads
  // "getting ready" until the app is restarted.
  ipcMain.handle('hive:memoryStatus', () => memory.refresh());
  ipcMain.handle('hive:searchMemory', (_evt, query: unknown, wing: unknown) => {
    if (typeof query !== 'string' || !query.trim()) return { ok: false, output: '', error: 'empty query' };
    return memory.search(query, { wing: typeof wing === 'string' ? wing : undefined });
  });
  ipcMain.handle('hive:memoryWakeUp', (_evt, wing: unknown) =>
    memory.wakeUp(typeof wing === 'string' ? wing : undefined));
  ipcMain.handle('hive:mineNow', () => { memory.mineNow(); return { ok: true }; });
  // Condense memory.md on demand: an explicit id condenses that one agent (skips
  // the size trigger — a "condense now" button); no id runs a full threshold scan.
  ipcMain.handle('memory:reflectNow', (_evt, id: unknown) =>
    reflector.reflectNow(typeof id === 'string' && id ? id : undefined));

  // ─── IPC: enterprise Knowledge Graph (multimodal context for agents) ─────────
  ipcMain.handle('kg:status', () => knowledge.status());
  ipcMain.handle('kg:list', () => knowledge.list());
  ipcMain.handle('kg:search', (_evt, query: unknown, limit: unknown) => {
    if (typeof query !== 'string' || !query.trim()) return [];
    return knowledge.search(query, typeof limit === 'number' ? limit : undefined);
  });
  ipcMain.handle('kg:get', (_evt, id: unknown) =>
    (typeof id === 'string' && id ? knowledge.get(id) : null));
  ipcMain.handle('kg:remove', (_evt, id: unknown) =>
    ({ ok: typeof id === 'string' && id ? knowledge.remove(id) : false }));
  // Ingest one or more files from disk. Best-effort per file; returns per-file
  // results so the UI can report partial success.
  ipcMain.handle('kg:ingestFiles', (_evt, payload: unknown) => {
    const p = (payload ?? {}) as { paths?: unknown; tags?: unknown };
    const paths = Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === 'string') : [];
    const tags = Array.isArray(p.tags) ? p.tags.filter((x): x is string => typeof x === 'string') : undefined;
    const results = paths.map((srcPath) => {
      try {
        const r = knowledge.ingestFile(srcPath, { tags });
        return { ok: true as const, srcPath, docId: r.docId, chunkCount: r.chunkCount };
      } catch (e) {
        return { ok: false as const, srcPath, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return { results };
  });
  // Open a multi-file picker and ingest the chosen artifacts in one round-trip.
  ipcMain.handle('kg:addFiles', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win) return { ok: false as const, error: 'no window' };
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: 'Add documents to the Knowledge Graph'
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
    const results = res.filePaths.map((srcPath) => {
      try {
        const r = knowledge.ingestFile(srcPath);
        return { ok: true as const, srcPath, docId: r.docId, chunkCount: r.chunkCount };
      } catch (e) {
        return { ok: false as const, srcPath, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return { ok: true as const, results };
  });

  // ─── IPC: command history (SQLite — every prompt submitted to an agent) ──────
  ipcMain.handle('history:add', (_evt, payload: unknown) => {
    const p = (payload ?? {}) as { agentId?: unknown; cwd?: unknown; text?: unknown };
    if (typeof p.agentId !== 'string' || typeof p.text !== 'string') return { ok: false, error: 'invalid args' };
    try {
      persist.addHistory({ agentId: p.agentId, cwd: typeof p.cwd === 'string' ? p.cwd : null, text: p.text });
      return { ok: true };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
  ipcMain.handle('history:list', (_evt, agentId: unknown, limit: unknown) =>
    persist.listHistory(
      typeof agentId === 'string' && agentId ? agentId : undefined,
      typeof limit === 'number' ? limit : undefined
    ));
  ipcMain.handle('history:search', (_evt, query: unknown, limit: unknown) =>
    persist.searchHistory(typeof query === 'string' ? query : '', typeof limit === 'number' ? limit : undefined));

  // ─── IPC: token telemetry (real usage + est. cost from CC transcripts) ───────
  // Reconciler/fallback path: per-cwd transcript sum, now priced PER MODEL (cost
  // bug #1 fixed in pricing.ts). Kept for back-compat with the existing UsageRow.
  ipcMain.handle('hive:agentUsage', (_evt, cwd: unknown) =>
    typeof cwd === 'string' ? readAgentUsage(cwd) : null);
  // Current context size (tokens) of an agent's LIVE session — the transcript
  // path is learned from the agent's hook payloads (SessionStart fires right at
  // spawn), so this works even when several agents share one cwd. Null until the
  // first hook fires; a known-but-empty transcript reads as 0 so a freshly
  // (re)started session zeroes the gauge instead of leaving a stale value up.
  ipcMain.handle('hive:agentContext', (_evt, agentId: unknown) => {
    if (typeof agentId !== 'string') return null;
    const tp = hookServer.transcriptPath(agentId);
    if (!tp) return null;
    return readContextTokens(tp) ?? 0;
  });

  // A consolidated, NON-SENSITIVE per-agent directory for the voice read-layer
  // (Realtime Michael's get_agent_detail / list_agents). One read that joins
  // everything the office-floor sidebar + telemetry know per agent: the registry
  // record (name/role/provider/cwd/status/archived/isGod/isAssistant/sessionId/
  // cwdValid), live token + breaker + last-tool telemetry, and the current context
  // window fill. Includes ARCHIVED agents (unlike the heartbeat's fleet.json, which
  // is live-only) so Michael can speak to inactive agents — their cwd and memory
  // stay reachable. PII-free: no secrets, env, or API keys ever leave main; cost is
  // carried as tokens (+ a usd field the voice layer deliberately never speaks).
  ipcMain.handle('hive:agentDirectory', () => {
    if (!hive.enabled()) return { godId: null, agents: [] };
    const reg = hive.registry();
    const snap = telemetry.snapshot();
    const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
    const now = Date.now();
    const agents = Object.entries(reg.agents).map(([id, a]) => {
      const u = usageById.get(id);
      const spans = snap.spans[id] ?? [];
      const tokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
      const ctx = hookServer.contextFor(id);
      return {
        id,
        name: a.name,
        role: a.role ?? (a.isGod ? 'orchestrator' : 'agent'),
        provider: a.provider ?? 'claude',
        model: u?.model ?? null,
        status: a.status ?? 'idle',
        cwd: a.cwd ?? null,
        cwdValid: a.cwdValid ?? null,
        archived: !!a.archived,
        isGod: !!a.isGod,
        isAssistant: !!a.isAssistant,
        sessionId: a.sessionId ?? null,
        hasMemory: hive.hasMemory(id),
        inboxBacklog: hive.inboxBacklog(id),
        breaker: breaker.levelFor(id),
        tokens,
        usd: u ? Number(u.usd.toFixed(4)) : 0,
        lastTool: spans.length ? spans[spans.length - 1].tool : null,
        lastActiveSecAgo: u ? Math.round((now - u.ts) / 1000) : null,
        contextTokens: ctx?.tokens ?? null,
        contextLimit: ctx?.limit ?? null,
        contextPct: ctx && ctx.limit > 0 ? Math.round((ctx.tokens / ctx.limit) * 100) : null
      };
    });
    return { godId: reg.godId, agents };
  });

  // ─── IPC: live telemetry (the OTel collector — the locked usage-provider seam) ─
  // The fleet grid + span waterfall (#7B) read these; Lane A's breaker (#6)
  // consumes getAgentUsage in-process via the provider, not over IPC.
  ipcMain.handle('telemetry:usage', (_evt, agentId: unknown) =>
    typeof agentId === 'string' ? telemetry.getAgentUsage(agentId) : null);
  ipcMain.handle('telemetry:spans', (_evt, agentId: unknown) =>
    typeof agentId === 'string' ? telemetry.getSpans(agentId) : []);
  ipcMain.handle('telemetry:snapshot', () => telemetry.snapshot());

  // ─── IPC: circuit-breaker state (Lane A #6 policy → this lane's avatars/meter) ─
  // Lane A's breaker calls this with a BreakerState; we fan it out to the renderer
  // on `control:breakerState`, where the avatar adapter gives it precedence over
  // hook-derived status (#5C looping/zombie). Defined here so the channel exists
  // before Jim's policy lands; he produces, this lane consumes.
  ipcMain.handle('control:setBreakerState', (_evt, state: unknown) => {
    try { liveWebContents()?.send('control:breakerState', state); } catch { /* window tore down */ }
    return { ok: true };
  });

  // ─── IPC: operator control over agents (#7C.1–7C.3) ─────────────────────────
  // All return the agent's fresh control snapshot so the UI can reflect state.
  ipcMain.handle('control:pause', (_evt, agentId: unknown, on: unknown) => {
    if (typeof agentId !== 'string') return null;
    control.pause(agentId, on === true);
    return control.snapshot(agentId);
  });
  ipcMain.handle('control:autoDelivery', (_evt, agentId: unknown, paused: unknown) => {
    if (typeof agentId !== 'string') return null;
    const on = paused === true;
    control.pauseAutoDelivery(agentId, on);
    const current = new Set(readConfig().autoDeliveryPausedAgents ?? []);
    if (on) current.add(agentId); else current.delete(agentId);
    writeConfig({ autoDeliveryPausedAgents: Array.from(current).sort() });
    return control.snapshot(agentId);
  });
  ipcMain.handle('control:resume', (_evt, agentId: unknown) => {
    if (typeof agentId !== 'string') return null;
    control.resume(agentId);
    return control.snapshot(agentId);
  });
  ipcMain.handle('control:gateTool', (_evt, agentId: unknown, tool: unknown, on: unknown) => {
    if (typeof agentId !== 'string' || typeof tool !== 'string') return null;
    control.gateTool(agentId, tool, on === true);
    return control.snapshot(agentId);
  });
  ipcMain.handle('control:steer', (_evt, agentId: unknown, text: unknown) => {
    if (typeof agentId !== 'string' || typeof text !== 'string') return null;
    control.steer(agentId, text);
    // A steer typed into the control strip is a human message. Counted HERE, at
    // the IPC seam, and deliberately not inside control.steer(): closingTime and
    // the voice action layer call that directly, and neither is a person typing.
    analytics.trackMessageSent('steer');
    return control.snapshot(agentId);
  });
  ipcMain.handle('control:halt', (_evt, agentId: unknown) => {
    if (typeof agentId !== 'string') return null;
    control.halt(agentId);
    return control.snapshot(agentId);
  });
  ipcMain.handle('control:snapshot', (_evt, agentId: unknown) =>
    typeof agentId === 'string' ? control.snapshot(agentId) : null);

  // ─── IPC: full-text search across hive files (board, tasks, memory) ──────────
  ipcMain.handle('hive:textSearch', (_evt, query: unknown) => {
    if (typeof query !== 'string' || !query.trim()) return { ok: false, results: [] };
    const root = hive.root();
    if (!root) return { ok: false, results: [] };
    const q = query.toLowerCase();
    const results: Array<{ source: string; excerpt: string }> = [];
    // Each target file is (path, readable label). agents/<id>/memory.md is expanded below.
    const targets: Array<{ path: string; source: string }> = [
      { path: join(root, 'board.md'), source: 'board.md' },
      { path: join(root, 'tasks.json'), source: 'tasks.json' }
    ];
    const agentsDir = join(root, 'agents');
    if (existsSync(agentsDir)) {
      for (const id of readdirSync(agentsDir)) {
        targets.push({ path: join(agentsDir, id, 'memory.md'), source: `${id}/memory.md` });
      }
    }
    for (const { path, source } of targets) {
      if (!existsSync(path)) continue;
      let hits = 0;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (hits >= 3) break;
        const idx = line.toLowerCase().indexOf(q);
        if (idx === -1) continue;
        // ~40 chars of context on either side of the match.
        const excerpt = line.slice(Math.max(0, idx - 40), idx + q.length + 40).trim();
        results.push({ source, excerpt });
        hits++;
      }
    }
    return { ok: true, results };
  });

  // ─── IPC: GitHub issue ingestion (gh CLI) ────────────────────────────────────
  ipcMain.handle('github:issues', (_evt, cwd: unknown) =>
    typeof cwd === 'string' ? listIssues(cwd) : { ok: false, error: 'no cwd' }
  );

  // ─── IPC: GitHub CI status watcher (gh CLI) ──────────────────────────────────
  ipcMain.handle('github:ciRuns', (_evt, cwd: unknown) =>
    typeof cwd === 'string' ? listCIRuns(cwd) : { ok: false, error: 'no cwd' }
  );
}
