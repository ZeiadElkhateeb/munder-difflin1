/**
 * Catalog IPC: the Settings hero payload, model catalog, skills (local + catalog) and
 * the external tool status list.
 */
import { app, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { resolveCommand as resolveCliCommand } from '../shellEnv';
import { readConfig } from '../config';
import { toolCatalog, type ToolStatus } from '../../shared/toolCatalog';
import { listLocalSkills, loadCatalog, installSkill, uninstallSkill, type LocalSkill } from '../skills';
import { loadHero } from '../hero';
import { loadModelCatalog } from '../modelCatalog';
import { memory } from '../services';
import { skillsResourceDir } from '../slackService';

// ─── IPC: model catalog (remote data, cached) ───────────────────────────────
/** The agent model presets, fetched from docs/model-catalog.json on main so a
 *  new model reaches installed copies without a release. Validated in
 *  shared/modelCatalogPayload; a null catalog means "keep the baked one". */
export const MODEL_CATALOG_CACHE = () => join(app.getPath('userData'), 'model-catalog.json');

/** Registers this module's IPC handlers and load-time wiring. Called once from index.ts. */
export function registerCatalogIpc(): void {
  // ─── IPC: Settings hero payload (remote data, cached) ───────────────────────
  /** Plan copy and sponsor, fetched from the repo so they can change without a
   *  release. Validated in shared/heroPayload before it reaches the renderer. */
  ipcMain.handle('hero:payload', async (_evt, force: unknown) =>
    loadHero(join(app.getPath('userData'), 'hero.json'), { force: force === true }));
  ipcMain.handle('models:catalog', async (_evt, force: unknown) =>
    loadModelCatalog(MODEL_CATALOG_CACHE(), { force: force === true }));

  // ─── IPC: skills (installed locally, and the browsable catalog) ─────────────
  /** Skills the CLIs on this machine can already use. Scans the registered repos
   *  plus the agent's own cwd, so a project-scoped skill shows up where it applies. */
  ipcMain.handle('skills:local', (_evt, cwd: unknown): LocalSkill[] => {
    const cfg = readConfig();
    const cwds = [
      ...(typeof cwd === 'string' && cwd ? [cwd] : []),
      ...(cfg.registeredRepos ?? [])
    ];
    try {
      return listLocalSkills({ cwds, bundledDir: skillsResourceDir() });
    } catch (e) {
      console.error('[skills] local scan failed:', e);
      return [];
    }
  });
  /** The skills catalog, parsed from its README and cached in userData.
   *  `force` is the explicit refresh button; everything else is served from a
   *  day-old cache so opening the tab never waits on the network. */
  ipcMain.handle('skills:catalog', async (_evt, force: unknown) => {
    const cachePath = join(app.getPath('userData'), 'skill-catalog.json');
    return loadCatalog(cachePath, { force: force === true });
  });

  /** Install one catalog skill into ~/.claude/skills. Structured refusals, never a
   *  throw: the UI distinguishes "not installable" from "install failed". */
  ipcMain.handle('skills:install', async (_evt, url: unknown, name: unknown) => {
    if (typeof url !== 'string' || typeof name !== 'string') {
      return { ok: false as const, error: 'bad request' };
    }
    return installSkill(url, name);
  });
  /** Delete an installed skill. The guard rails live in uninstallSkill — it refuses
   *  any path it cannot prove is a skill folder inside a skills root. */
  ipcMain.handle('skills:uninstall', (_evt, path: unknown) => {
    if (typeof path !== 'string') return { ok: false as const, error: 'bad request' };
    const cfg = readConfig();
    return uninstallSkill(path, { cwds: cfg.registeredRepos ?? [] });
  });
  /** Reveal a skill on disk. `openExternal` is deliberately https-only, so a
   *  file:// URL cannot (and should not) be smuggled through it. */
  ipcMain.handle('skills:reveal', (_evt, path: unknown) => {
    if (typeof path !== 'string' || !path.trim()) return { ok: false, error: 'bad request' };
    const skillRoots = [join(homedir(), '.claude', 'skills'), join(homedir(), '.config', 'opencode')];
    const target = resolve(path);
    const inRoot = skillRoots.some((r) => target.startsWith(resolve(r) + sep))
      || (readConfig().registeredRepos ?? []).some((c) => target.startsWith(resolve(c) + sep));
    if (!inRoot) return { ok: false, error: 'outside a managed skills directory' };
    shell.showItemInFolder(target);
    return { ok: true };
  });

  // ─── IPC: setup catalog (which external tools are actually here) ────────────
  /**
   * Probe every catalog row against THIS machine.
   *
   * Presence is a PATH resolution, not a spawn: running each candidate to read a
   * --version would be a dozen process launches on every panel open, and several of
   * these CLIs boot a TUI when invoked bare. `resolveCommand` returns its input
   * unchanged when it finds nothing, so "resolved to a real, existing path that is
   * not just the bare name" is the found test.
   *
   * mempalace is the one row that does NOT come from PATH: the memory subsystem
   * already resolves it (including uv/pip locations PATH may not carry for a
   * Finder-launched app) and knows whether the palace is initialised, so it is
   * authoritative and reused rather than re-probed differently here.
   */
  ipcMain.handle('tools:status', (): ToolStatus[] => {
    const win = process.platform === 'win32';
    const mem = (() => { try { memory.resetBinCache(); return memory.status(); } catch { return null; } })();
    return toolCatalog().map((spec): ToolStatus => {
      const installCommand = win ? spec.install.win32 : spec.install.posix;
      if (spec.id === 'mempalace') {
        return {
          ...spec,
          installCommand,
          found: !!mem?.available,
          path: mem?.bin ?? null,
          detail: mem?.available
            ? (mem.initialized ? 'palace initialised' : 'installed — palace not built yet')
            : undefined
        };
      }
      if (!spec.bin) return { ...spec, installCommand, found: false, path: null };
      let path: string | null = null;
      try {
        const resolved = resolveCliCommand(spec.bin);
        if (resolved !== spec.bin && existsSync(resolved)) path = resolved;
      } catch { /* a probe must never take the panel down */ }
      return { ...spec, installCommand, found: !!path, path };
    });
  });
}
