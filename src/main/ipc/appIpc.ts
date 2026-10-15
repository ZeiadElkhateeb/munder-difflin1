/**
 * App-level IPC: clipboard, dialogs, attachments, external links, login item,
 * notifications, analytics, app info and voice transcription (freeflow).
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { readConfig, writeConfig, type HarnessConfig } from '../config';
import { resolveSessionCwd } from '../transcript';
import { transcribeWithGroq, DEFAULT_GROQ_MODEL } from '../freeflow';
import { analytics, isRendererMessageSurface } from '../analytics';


/** Registers this module's IPC handlers and load-time wiring. Called once from index.ts. */
export function registerAppIpc(): void {
  // ─── IPC: analytics (the ONE renderer-facing seam) ──────────────────────────
  /** Count one human-sent message (TELEMETRY.md → `message_sent`). A COUNT, and
   *  nothing else: this channel takes no text, no length and no id, so there is
   *  no shape in which message content could cross it.
   *
   *  This is the only analytics event the renderer can cause. It exists because
   *  two of the four send surfaces — a line typed into the agent's terminal, and
   *  the queue composer — are submits main cannot observe: the `pty:write` handler
   *  above fires on EVERY KEYSTROKE, so counting there would produce a keystroke
   *  meter, not a message count. `steer` and `hive` are counted at their own IPC
   *  handlers in this file and are rejected here (isRendererMessageSurface) so
   *  they can never be counted twice. The event name is fixed here, not passed
   *  in: the renderer chooses a surface, never an event. */
  ipcMain.handle('analytics:messageSent', (_evt, surface: unknown) => {
    if (!isRendererMessageSurface(surface)) return { ok: false };
    analytics.trackMessageSent(surface);
    return { ok: true };
  });

  // Resolve a pasted Claude session id to the cwd it originally ran in, so the Add
  // Agent dialog can auto-fill the folder for a resume (#2 zero-step resume). Reads
  // the cwd from a transcript record; null when the id is invalid/unknown.
  ipcMain.handle('session:resolveCwd', (_evt, sessionId: unknown) =>
    (typeof sessionId === 'string' ? resolveSessionCwd(sessionId) : null));

  // ─── IPC: clipboard ─────────────────────────────────────────────────────────
  ipcMain.handle('app:copyToClipboard', (_evt, text: unknown) => {
    if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
    try { clipboard.writeText(text); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
  ipcMain.handle('app:readClipboard', () => {
    try { return clipboard.readText(); } catch { return ''; }
  });
  // Same read, SYNCHRONOUS, for the terminal's paste shortcut.
  //
  // Dictation tools (muesli.works, Wispr Flow, …) type by stashing the user's
  // clipboard, writing the transcript, sending the paste key, then restoring the
  // old clipboard immediately. An `invoke` read returns a tick or two later — by
  // which point the restore has already landed and we paste the PREVIOUS text.
  // A `sendSync` read completes inside the keydown handler, before the tool gets
  // a chance to put the old contents back.
  ipcMain.on('app:readClipboardSync', (evt) => {
    try { evt.returnValue = clipboard.readText(); } catch { evt.returnValue = ''; }
  });
  // NOTE: the terminal theme is mirrored into each agent's per-session Claude
  // settings at spawn (hive.ensureAgent theme option) — deliberately NOT via
  // `claude config set -g theme`, which would also restyle the user's own
  // Claude sessions outside the app.

  // ─── IPC: folder picker ─────────────────────────────────────────────────────
  ipcMain.handle('dialog:chooseFolder', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win) return { ok: false as const, error: 'no window' };
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Pick a folder'
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
    return { ok: true as const, path: res.filePaths[0] };
  });

  // ─── IPC: Terminal.app at a folder ──────────────────────────────────────────
  ipcMain.handle('terminal:openAtFolder', async (_evt, cwd: unknown) => {
    if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: 'invalid cwd' };
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const p = spawn('open', ['-a', 'Terminal', cwd]);
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
      p.on('close', (code) => {
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, error: err.trim() || `open exited ${code}` });
      });
    });
  });

  // ─── IPC: composer attachments (images + arbitrary files, attached by PATH) ──
  // The message queue pipes raw text into a Claude CLI PTY, so attachments travel
  // as a file PATH the agent reads with its Read tool (same convention as Slack).
  // Picker offers an Images group + All Files.
  ipcMain.handle('dialog:attachFiles', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win) return { ok: false as const, error: 'no window' };
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: 'Attach images or files',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tiff', 'avif'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
    return { ok: true as const, files: res.filePaths.map((p) => ({ path: p, name: basename(p) })) };
  });

  // Persist the current native clipboard image to a temp PNG so a pasted
  // screenshot can be attached by PATH. Returns an error result when the
  // clipboard holds no image (e.g. a normal text paste).
  ipcMain.handle('clipboard:saveImage', async () => {
    try {
      const img = clipboard.readImage();
      if (img.isEmpty()) return { ok: false as const, error: 'no image in clipboard' };
      const dir = join(app.getPath('temp'), 'cth-pastes');
      mkdirSync(dir, { recursive: true });
      const name = `paste-${Date.now()}.png`;
      const dest = join(dir, name);
      writeFileSync(dest, img.toPNG());
      return { ok: true as const, file: { path: dest, name } };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ─── IPC: desktop notifications toggle ──────────────────────────────────────
  ipcMain.handle('app:setNotifications', (_evt, val) => writeConfig({ notifications: val === true }));

  // ─── IPC: onboarding reliability — open Settings deep-link + login-item toggle ─
  /** Open a System Settings deep-link (or https URL) in the OS default handler.
   *  Restricted to Settings panes / https so the renderer can't shell arbitrary
   *  schemes. macOS uses `x-apple.systempreferences:`, Windows uses `ms-settings:`
   *  (Linux has no universal settings URI, so the renderer never sends one there).
   *  Used by the onboarding "Permissions & reliability" step. */
  ipcMain.handle('app:openExternal', async (_evt, url: unknown) => {
    if (typeof url !== 'string' || !/^(x-apple\.systempreferences:|ms-settings:|https:\/\/)/.test(url)) {
      return { ok: false, error: 'blocked url' };
    }
    await shell.openExternal(url);
    return { ok: true };
  });
  /** Toggle macOS "Open at Login" — fully programmatic, no permission prompt.
   *  Returns the resulting state so the renderer toggle reflects reality. */
  ipcMain.handle('app:setLoginItem', (_evt, enabled: unknown) => {
    app.setLoginItemSettings({ openAtLogin: enabled === true });
    return app.getLoginItemSettings().openAtLogin;
  });

  // ─── IPC: Free Flow (voice dictation → message queue) ────────────────────────
  // Entry point B is hold-Option-to-talk, handled entirely in the renderer
  // (capture-phase key listeners) — no globalShortcut here. macOS doesn't deliver
  // the Fn key to Electron (electron#16714) and a faithful native Fn helper
  // (CGEventTap) is deferred; hold-Option is the human-chosen v1 activation.

  ipcMain.handle('freeflow:setConfig', (_evt, patch: unknown) => {
    const p = (patch ?? {}) as { enabled?: unknown; apiKey?: unknown; model?: unknown };
    const next: Partial<HarnessConfig> = {};
    if (typeof p.enabled === 'boolean') next.freeflowEnabled = p.enabled;
    // Trim string fields; an emptied key clears back to undefined.
    if (typeof p.apiKey === 'string') next.groqApiKey = p.apiKey.trim() || undefined;
    if (typeof p.model === 'string') next.freeflowModel = p.model.trim() || DEFAULT_GROQ_MODEL;
    writeConfig(next);
    return { ok: true };
  });

  /** Transcribe one captured audio clip via Groq. Gated on the flag + a key being
   *  present, so a disabled feature can NEVER reach the network. The Groq key stays
   *  in main — only the audio bytes cross IPC inbound and the transcript outbound. */
  ipcMain.handle('freeflow:transcribe', async (_evt, arg: unknown) => {
    const cfg = readConfig();
    if (!cfg.freeflowEnabled) return { ok: false, error: 'Free Flow is disabled' };
    if (!cfg.groqApiKey) return { ok: false, error: 'no Groq API key set' };
    const a = (arg ?? {}) as { audio?: unknown; mimeType?: unknown; filename?: unknown; language?: unknown };
    if (!(a.audio instanceof ArrayBuffer) && !(a.audio instanceof Uint8Array)) {
      return { ok: false, error: 'no audio' };
    }
    const out = await transcribeWithGroq({
      apiKey: cfg.groqApiKey,
      audio: a.audio,
      mimeType: typeof a.mimeType === 'string' ? a.mimeType : undefined,
      filename: typeof a.filename === 'string' ? a.filename : undefined,
      model: cfg.freeflowModel || DEFAULT_GROQ_MODEL,
      language: typeof a.language === 'string' && a.language ? a.language : undefined
    });
    if (out.ok) analytics.trackFeature('voice_dictation');
    return out;
  });
  // v0.3.4: app self-knowledge for the voice get_app_info tool — version + the
  // newest CHANGELOG sections. Read-only; ships CHANGELOG.md with the app.
  ipcMain.handle('app:info', () => {
    let changelog = '';
    for (const p of [join(app.getAppPath(), 'CHANGELOG.md'), join(process.cwd(), 'CHANGELOG.md')]) {
      try { changelog = readFileSync(p, 'utf8'); if (changelog) break; } catch { /* try next */ }
    }
    const top = changelog
      ? changelog.split(/\n## /).slice(1, 3).map((s) => `## ${s}`).join('\n').slice(0, 8000)
      : '';
    return { version: app.getVersion(), changelog: top };
  });
}
