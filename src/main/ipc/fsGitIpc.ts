/**
 * Sandboxed filesystem and git IPC for the Files / Git / IDE views.
 */
import { ipcMain, shell } from 'electron';
import { listDir, readFileText, readFileBinary, writeFileText, statAbs } from '../fs';
import { getBranch, getStatus, getLog, getBranches, getAheadBehind, isRepo, getDiff, mainRepoRoot, getLogGraph, getCommitFiles, getFileAtRev, compareRefs, listWorktrees, checkoutRef } from '../git';
import { ptyManager } from '../services';


/** Registers this module's IPC handlers and load-time wiring. Called once from index.ts. */
export function registerFsGitIpc(): void {
  // ─── IPC: filesystem (sandboxed to a root) ──────────────────────────────────
  ipcMain.handle('fs:listDir', (_evt, root: unknown, rel: unknown) => {
    if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
    return listDir(root, rel);
  });
  ipcMain.handle('fs:readFile', (_evt, root: unknown, rel: unknown) => {
    if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
    return readFileText(root, rel);
  });
  // Raw bytes for files the text reader refuses (images). The renderer cannot
  // load them off disk itself — the CSP has no `file:` source and no file
  // protocol is registered — so the bytes come through here and become a `blob:`
  // URL on the other side. Same root confinement as every other fs handler.
  ipcMain.handle('fs:readBinary', (_evt, root: unknown, rel: unknown) => {
    if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
    return readFileBinary(root, rel);
  });
  ipcMain.handle('fs:writeFile', (_evt, root: unknown, rel: unknown, content: unknown) => {
    if (typeof root !== 'string' || typeof rel !== 'string' || typeof content !== 'string') {
      return { ok: false, error: 'invalid args' };
    }
    return writeFileText(root, rel, content);
  });
  // v0.3.4: existence check for the terminal ⌘-click markdown flow (metadata only).
  ipcMain.handle('fs:statAbs', (_evt, p: unknown) => {
    if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) {
      return { exists: false, isFile: false, path: '' };
    }
    return statAbs(p);
  });

  /** Reveal a path in the OS file browser — Finder, Explorer, or whatever the
   *  Linux desktop registers. Backs ⌘-click on a terminal path we cannot open
   *  ourselves (an image, an archive, an unknown extension).
   *
   *  `showItemInFolder`, NEVER `shell.openPath`, for a file. The path arrives
   *  from agent output, and openPath hands an arbitrary file to its default
   *  application: a printed `installer.dmg` or `.desktop` would be one click from
   *  executing. Revealing only ever opens a file browser, so the worst an agent
   *  can achieve by printing a path is a window at a folder the user could
   *  already open themselves.
   *
   *  openPath IS used for a directory, and only after statAbs has confirmed it is
   *  one — a directory has no default application to launch, so the execution
   *  argument above does not apply, and revealing a folder inside its parent is
   *  not what "open this folder" means to anyone. */
  ipcMain.handle('fs:revealPath', async (_evt, p: unknown) => {
    if (typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0')) {
      return { ok: false, error: 'bad request' };
    }
    const st = await statAbs(p);
    if (!st.exists) return { ok: false, error: 'not found' };
    if (st.isFile) { shell.showItemInFolder(st.path); return { ok: true }; }
    const err = await shell.openPath(st.path);
    return err ? { ok: false, error: err } : { ok: true };
  });

  // ─── IPC: git ───────────────────────────────────────────────────────────────
  ipcMain.handle('git:isRepo', (_evt, cwd: unknown) => {
    if (typeof cwd !== 'string') return false;
    return isRepo(cwd);
  });

  // The repo a cwd belongs to, following a linked worktree back to its main
  // checkout — the renderer groups the agent roster by this.
  ipcMain.handle('git:mainRepo', (_evt, cwd: unknown) => {
    if (typeof cwd !== 'string' || !cwd) return null;
    return mainRepoRoot(cwd);
  });
  ipcMain.handle('git:branch', (_evt, cwd: unknown) => {
    if (typeof cwd !== 'string') return { error: 'invalid cwd' };
    return getBranch(cwd);
  });
  ipcMain.handle('git:status', (_evt, cwd: unknown) => {
    if (typeof cwd !== 'string') return { error: 'invalid cwd' };
    return getStatus(cwd);
  });
  ipcMain.handle('git:log', (_evt, cwd: unknown, n: unknown) => {
    if (typeof cwd !== 'string') return { error: 'invalid cwd' };
    const count = typeof n === 'number' ? Math.min(500, Math.max(1, n)) : 50;
    return getLog(cwd, count);
  });
  ipcMain.handle('git:branches', (_evt, cwd: unknown) => {
    if (typeof cwd !== 'string') return { error: 'invalid cwd' };
    return getBranches(cwd);
  });
  ipcMain.handle('git:aheadBehind', (_evt, cwd: unknown) => {
    if (typeof cwd !== 'string') return { error: 'invalid cwd' };
    return getAheadBehind(cwd);
  });
  ipcMain.handle('git:diff', (_evt, cwd: unknown, relPath: unknown) => {
    if (typeof cwd !== 'string' || typeof relPath !== 'string') {
      return { ok: false, error: 'invalid args' };
    }
    return getDiff(cwd, relPath);
  });
  // ─── v0.3.4: history / compare / checkout (git visualization) ───────────────
  ipcMain.handle('git:logGraph', (_evt, cwd: unknown, n: unknown, skip: unknown) => {
    if (typeof cwd !== 'string') return { error: 'invalid args' };
    const count = Math.min(500, Math.max(1, typeof n === 'number' ? n : 200));
    const off = Math.max(0, typeof skip === 'number' ? skip : 0);
    return getLogGraph(cwd, count, off);
  });
  ipcMain.handle('git:commitFiles', (_evt, cwd: unknown, sha: unknown) => {
    if (typeof cwd !== 'string' || typeof sha !== 'string') return { error: 'invalid args' };
    return getCommitFiles(cwd, sha);
  });
  ipcMain.handle('git:showFile', (_evt, cwd: unknown, rev: unknown, relPath: unknown) => {
    if (typeof cwd !== 'string' || typeof rev !== 'string' || typeof relPath !== 'string') {
      return { ok: false, error: 'invalid args' };
    }
    return getFileAtRev(cwd, rev, relPath);
  });
  ipcMain.handle('git:compareRefs', (_evt, cwd: unknown, base: unknown, head: unknown, mode: unknown) => {
    if (typeof cwd !== 'string' || typeof base !== 'string' || typeof head !== 'string') {
      return { error: 'invalid args' };
    }
    return compareRefs(cwd, base, head, mode === 'two' ? 'two' : 'three');
  });
  ipcMain.handle('git:worktrees', (_evt, cwd: unknown) => {
    if (typeof cwd !== 'string') return { error: 'invalid args' };
    return listWorktrees(cwd);
  });
  ipcMain.handle('git:checkout', async (_evt, cwd: unknown, ref: unknown, detach: unknown) => {
    if (typeof cwd !== 'string' || typeof ref !== 'string') return { ok: false, error: 'invalid args' };
    // Guard: never swap files under an actively-working agent. Objective signal
    // owned by main — any live pty whose cwd sits in this tree and emitted output
    // in the last 10s is treated as mid-run. (Idle-but-open terminals are fine:
    // checkoutRef additionally requires a clean tree, and TUIs redraw on fs
    // changes gracefully.)
    const busy = ptyManager.list().find((p) =>
      (p.cwd === cwd || p.cwd.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)) &&
      Date.now() - p.lastOutputAt < 10_000
    );
    if (busy) {
      return { ok: false, error: `an agent is actively working in this repo (${busy.id}) — try again when it goes quiet` };
    }
    return checkoutRef(cwd, ref, detach === true);
  });
}
