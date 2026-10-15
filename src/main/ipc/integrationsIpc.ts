/**
 * Integrations IPC: the registry, write-only secrets, per-provider BYOK keys, and
 * connection tests. Secrets never travel back over IPC.
 */
import { ipcMain } from 'electron';
import * as integrations from '../integrations';
import { validateBaseUrl, buildAuthHeaders, resolveUpstreamUrl, secretRefFor, INTEGRATION_TEMPLATES } from '../../shared/integrations';
import { BACKEND_KEY_ENV, providerKeyRef } from '../agentSpawn';


/** Registers this module's IPC handlers and load-time wiring. Called once from index.ts. */
export function registerIntegrationsIpc(): void {
  // ─── IPC: integrations (Phase 2 registry — backend for Ryan's Settings UI) ────
  // Records are metadata only (config-backed); secrets are encrypted at rest and NEVER
  // returned over IPC. `list` redacts secretRef to a `hasSecret` boolean.
  ipcMain.handle('integrations:list', () => integrations.listRecordsRedacted());
  ipcMain.handle('integrations:templates', () => INTEGRATION_TEMPLATES);
  ipcMain.handle('integrations:upsert', (_evt, record: unknown) => integrations.upsertRecord(record));
  ipcMain.handle('integrations:setSecret', (_evt, payload: unknown) => {
    const p = (payload ?? {}) as { id?: unknown; secret?: unknown };
    if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
    if (typeof p.secret !== 'string' || !p.secret) return { ok: false, error: 'secret required' };
    return integrations.setSecret(secretRefFor(p.id), p.secret);
  });
  ipcMain.handle('integrations:remove', (_evt, payload: unknown) => {
    const p = (payload ?? {}) as { id?: unknown };
    if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
    return integrations.removeRecord(p.id);
  });
  // ─── IPC: per-CLI-provider BYOK keys (write-only) ────────────────────────────
  // API keys for the backend model-providers the non-Claude CLIs use are stored
  // WRITE-ONLY under `apikey:<backend>` in the same encrypted broker. The renderer
  // can SET a key and ASK whether one is set (boolean) — it can never read the
  // plaintext back. Keys are materialized MAIN-ONLY at spawn (spawnAgentCore). Base
  // URLs are non-secret and ride HarnessConfig.providerBaseUrls (normal config save).
  ipcMain.handle('providerKey:set', (_evt, payload: unknown) => {
    const p = (payload ?? {}) as { backend?: unknown; key?: unknown };
    if (typeof p.backend !== 'string' || !(p.backend in BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
    if (typeof p.key !== 'string' || !p.key) return { ok: false, error: 'key required' };
    return integrations.setSecret(providerKeyRef(p.backend), p.key);
  });
  ipcMain.handle('providerKey:has', (_evt, backend: unknown) =>
    typeof backend === 'string' ? integrations.hasSecret(providerKeyRef(backend)) : false);
  ipcMain.handle('providerKey:clear', (_evt, backend: unknown) => {
    if (typeof backend !== 'string' || !(backend in BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
    try { integrations.deleteSecret(providerKeyRef(backend)); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
  // Probe an integration's reachability through the broker's own auth path (admin-only;
  // runs in main, so the secret is used but never returned — only the upstream status).
  ipcMain.handle('integrations:test', async (_evt, payload: unknown) => {
    const p = (payload ?? {}) as { id?: unknown; path?: unknown };
    if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
    const rec = integrations.getRecord(p.id);
    if (!rec) return { ok: false, error: 'unknown integration' };
    const probe = validateBaseUrl(rec.baseUrl);
    if (!probe.ok) return { ok: false, error: probe.error };
    // Confine the probe path through the SAME gate as the worker forward() path, so an
    // absolute URL / backslash-host / traversal in p.path can't override the origin and
    // exfiltrate the secret to an attacker host. Resolve (and reject) BEFORE the secret
    // is ever materialized, so a bad path never even decrypts it.
    const target = resolveUpstreamUrl(rec.baseUrl, typeof p.path === 'string' ? p.path : '');
    if (!target) return { ok: false, error: 'path escapes the integration baseUrl', code: 'bad_request' };
    const secret = integrations.getSecret(rec.secretRef);
    const headers = buildAuthHeaders(rec.authType, rec.authHeader, secret);
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15_000);
      const r = await fetch(target, { method: 'GET', headers, redirect: 'manual', signal: ac.signal });
      clearTimeout(timer);
      return { ok: r.ok, status: r.status };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
