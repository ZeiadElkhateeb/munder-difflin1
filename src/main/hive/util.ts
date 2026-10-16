/**
 * Small hive helpers: timing, ids, secret redaction, outbox JSON repair, crash-log and
 * mempalace-ignore housekeeping.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Filesystem- and sort-safe timestamp, e.g. 2026-05-30T14-03-11-123Z. */
export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function shortRand(): string {
  return randomBytes(3).toString('hex');
}

/** True when `id` is one plain path segment, so `join(dir, id)` stays inside `dir`.
 *  Agents author message ids and recipients, and the router turns them into paths. */
export function isPathSegment(id: unknown): id is string {
  return typeof id === 'string' && id !== '' && id !== '.' && id !== '..' && !/[\\/\0]/.test(id);
}

export const MINE_IGNORE_LINES = ['settings.json', 'cursor.json', 'inbox/', 'outbox/', '.codex/'];

/** Idempotently ensure `<agentDir>/.gitignore` excludes the non-memory files.
 *  Append-only: writes only the missing lines, leaving any existing entries. */
export function ensureMineIgnore(agentDir: string): void {
  const path = join(agentDir, '.gitignore');
  let existing = '';
  try { if (existsSync(path)) existing = readFileSync(path, 'utf8'); } catch { return; }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = MINE_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  try { writeFileSync(path, prefix + missing.join('\n') + '\n', 'utf8'); } catch { /* best-effort */ }
}

/**
 * Strip secret-shaped substrings out of free text before it leaves the main
 * process toward the voice / renderer layer. This is the MAIN-SIDE privacy gate
 * for the voice read-layer's message-content path (`hive:messages`): a message
 * body can quote a key, paste a token, or echo a credential, so every body and
 * subject is run through this before it crosses IPC. The renderer holds ZERO
 * redaction policy — it only ever receives the already-cleaned string.
 *
 * Deliberately CONSERVATIVE: it matches known credential SHAPES (provider key
 * prefixes, JWTs, PEM private keys, bearer tokens) and sensitive key=value /
 * key: value assignments, then replaces the secret with `[redacted]`. It does
 * NOT blanket-redact on entropy, so operator-meaningful content the briefing
 * needs — git SHAs, agent ids, file paths, ordinary prose — survives intact.
 * Over-redaction (e.g. a non-secret `apikey:openai` ref) is acceptable; leaking
 * a real secret is not.
 *
 * LOCKSTEP: the regex battery below is mirrored character-identically in
 * test/voice-messages.test.cjs (a .cjs test cannot import this TS module). If
 * you change a pattern here, mirror it there — the test is what PROVES a
 * secret-shaped value is stripped.
 */
export function redactSecrets(text: unknown): string {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  let s = text;
  // 1. PEM private-key blocks (RSA/EC/OPENSSH/PGP — header through footer).
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted]');
  // 2. JSON Web Tokens — three base64url segments separated by dots.
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[redacted]');
  // 3. Known credential prefixes: OpenAI/Anthropic (sk-, sk-ant-), Slack
  //    (xoxb/xoxp/xoxa/xoxr/xoxs-, xapp-), GitHub (ghp_/gho_/ghu_/ghs_/ghr_,
  //    github_pat_), AWS access-key ids (AKIA…), Google API keys (AIza…).
  s = s.replace(
    /(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[bpaors]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})/g,
    '[redacted]'
  );
  // 4. Bearer tokens — keep the label, drop the credential.
  s = s.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
  // 5. Sensitive key = value / key: value — keep the key name, drop the value.
  //    An optional namespace prefix (aws_, gcp_, …) is folded into the captured
  //    key so a LABELED secret survives the \b boundary: `aws_secret_access_key`
  //    is all word chars, so a bare `\b(secret)\b` never sees it. Listing
  //    secret_access_key / private_key alone is not enough — the prefix run is
  //    what lets `aws_secret_access_key=…` (no AKIA shape on the value) redact.
  s = s.replace(
    /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|secret[_-]?access[_-]?key|secret|token|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|auth[_-]?token|bot[_-]?token|private[_-]?key))(\s*[:=]\s*)(["']?)[^\s"',}]{6,}\3/gi,
    (_m, k) => `${k}=[redacted]`
  );
  return s;
}

// ─── HiveManager ────────────────────────────────────────────────────────────

/**
 * Repair only literal CR/LF characters that occur inside JSON strings.
 *
 * Agents normally publish outbox messages through JSON.stringify, but a manual
 * shell write can put real line-break bytes in a multi-line body. JSON rejects
 * those bytes inside a string even though the intended value is unambiguous.
 * Keep this lexical and deliberately narrow: JSON.parse remains the acceptance
 * gate, and every other malformed shape is left for quarantine.
 */
export function repairLiteralLineBreaksInJsonStrings(raw: string): { text: string; changed: boolean } {
  let text = '';
  let inString = false;
  let escaped = false;
  let changed = false;

  for (const ch of raw) {
    if (!inString) {
      text += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      text += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      text += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      text += ch;
      inString = false;
      continue;
    }

    if (ch === '\n') {
      text += '\\n';
      changed = true;
      continue;
    }

    if (ch === '\r') {
      text += '\\r';
      changed = true;
      continue;
    }

    text += ch;
  }

  return { text, changed };
}

/** Keep the crash directory bounded.
 *
 *  One file per abnormal exit, 8 KB each, is fine until the failure being
 *  diagnosed is a crash loop -- which is the case this exists for. A provider
 *  that dies during startup and gets relaunched writes a file per attempt, so
 *  the scenario that most needs the diagnostic also produces the most files.
 *
 *  Filenames begin with an ISO timestamp, so a lexicographic sort is already
 *  chronological and no stat() is needed to find the oldest.
 *
 *  Best-effort throughout: a diagnostic that breaks teardown is worse than one
 *  that keeps a few extra files. */
export const MAX_CRASH_LOGS = 50;

export function pruneCrashLogs(dir: string): void {
  try {
    const logs = readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
    for (const stale of logs.slice(0, Math.max(0, logs.length - MAX_CRASH_LOGS))) {
      try { unlinkSync(join(dir, stale)); } catch { /* already gone, or not ours */ }
    }
  } catch { /* unreadable directory is not worth failing an exit path over */ }
}
