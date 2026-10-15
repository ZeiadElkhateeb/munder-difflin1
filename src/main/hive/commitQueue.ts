/**
 * Git for the hive: the single committer. HiveCommitQueue runs `git add -A` +
 * `git commit` either inline (sync, the default) or batched in a background child
 * process (async, what the app uses) — see the commit-queue note below.
 */
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { ensureMineIgnore, sleepSync } from './util';

// — hive git commit helpers (see the commit-queue note in HiveManager) —

export interface GitResult { ok: boolean; out: string; err: string }

export interface PendingCommit { root: string; message: string }

export const GIT_BASE_ARGS = ['-c', 'commit.gpgsign=false', '-c', 'gc.autoDetach=false', '-c', 'user.name=Hive', '-c', 'user.email=hive@local'];

export const GIT_TIMEOUT_MS = 8000;

export const COMMIT_ATTEMPTS = 5;

/** Coalescing window for async commits: a router tick that moves a dozen
 *  messages and a task patch become one commit instead of several. */
export const COMMIT_DEBOUNCE_MS = 250;

/** What one add+commit attempt means for the retry loop (shared by sync + async). */
export function commitAttemptOutcome(add: GitResult, commit: GitResult, attempt: number): 'done' | 'retry' | 'give-up' {
  if (commit.ok) return 'done';
  if (/nothing to commit/i.test(commit.out + commit.err)) return 'done';
  if ((!add.ok || /index\.lock/i.test(commit.err)) && attempt < COMMIT_ATTEMPTS - 1) return 'retry';
  console.warn(`[hive] commit gave up after ${attempt + 1} attempts:`, commit.err || commit.out);
  return 'give-up';
}

export function groupCommitsByRoot(batch: PendingCommit[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { root, message } of batch) {
    const list = out.get(root) ?? [];
    list.push(message);
    out.set(root, list);
  }
  return out;
}

/** One commit message for a coalesced batch: the lone message, or a summary line
 *  plus every original message so `git log` still tells the whole story. */
export function batchCommitMessage(messages: string[]): string {
  if (messages.length === 1) return messages[0];
  return [`hive: ${messages.length} changes`, '', ...messages.map((m) => `- ${m}`)].join('\n');
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What HiveCommitQueue needs from its owner. */
export interface CommitQueueHost {
  root(): string | null;
}

export class HiveCommitQueue {
  constructor(private readonly host: CommitQueueHost) {}

  private root(): string | null {
    return this.host.root();
  }

  // — git (single committer, retry + stale-lock recovery) —
  //
  // `gc.autoDetach=false` is what makes this call actually synchronous.
  //
  // A commit runs `gc --auto`, and git detaches that into a BACKGROUND process
  // by default. `spawnSync` returns when `git commit` exits, so the caller
  // believes the hive is quiescent while a gc it cannot see is still writing
  // into `.git/objects/`. Anything that touches the hive directory right after
  // a commit races that process: removing a hive home throws ENOTEMPTY, and a
  // read can catch a half-written pack.
  //
  // It reproduces on its own — create a HiveManager on a fresh temp home, call
  // ensureAgent, then remove the home: ~3.5% of iterations throw ENOTEMPTY,
  // and the leftover is always `.git/objects/`, sometimes still holding a
  // `bitmap-ref-tips_*` temp file that vanishes a fraction of a second later.
  // With this flag, gc runs inline and 200 iterations pass clean.
  //
  // The gc still happens — this only stops it from outliving the command that
  // triggered it, which is what "single committer" was supposed to mean.
  git(args: string[], cwd: string): GitResult {
    const res = spawnSync('git', [...GIT_BASE_ARGS, ...args], {
      cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS
    });
    return { ok: res.status === 0, out: res.stdout ?? '', err: res.stderr ?? '' };
  }

  /** Has the one-time cost-ledger untrack pass run in this process yet? */
  private untrackedCostLedger = false;

  /**
   * Stop versioning the cost ledger.
   *
   * `cost-ledger.jsonl` is append-only and gains a row per usage sample, so a
   * repo that tracks it stores a fresh copy of the WHOLE file on every hive
   * commit — and the hive commits constantly. A quarter-gigabyte ledger with a
   * few thousand commits behind it is several hundred gigabytes of blob that
   * git has to walk, which is what turns a routine `gc` into a multi-gigabyte
   * `pack-objects` run. The ignore line in ensureHive keeps new copies out;
   * this drops the one already in the index, because git keeps recording a
   * file it is already tracking no matter what .gitignore says — so the ignore
   * line alone reads as a fix while the repo goes on growing. The ledger stays
   * on disk, so the cost history the app reads is untouched.
   */
  private untrackCostLedger(root: string): void {
    if (this.untrackedCostLedger) return;
    this.untrackedCostLedger = true;
    // Probe before mutating: `rm --cached` on a repo that never tracked it
    // would still rewrite the index on every launch, inside the retry path.
    const tracked = this.git(['ls-files', '--', 'cost-ledger.jsonl'], root);
    if (!tracked.ok || !tracked.out.trim()) return;
    this.git(['rm', '--cached', '-q', '--ignore-unmatch', '--', 'cost-ledger.jsonl'], root);
    console.warn('[hive] untracked the cost ledger from the hive repo');
  }

  /** Has the one-time Codex-home untrack pass run in this process yet? */
  private untrackedCodexHomes = false;

  /**
   * Stop versioning Codex worker homes that are ALREADY in the index.
   *
   * Adding `.codex/` to each agent's .gitignore only keeps NEW paths out; git
   * happily keeps recording a file it is already tracking, so a hive that
   * predates that ignore line goes on committing every SQLite and transcript
   * revision exactly as before — the .gitignore reads as a fix while the repo
   * keeps growing. This closes that: once per process, refresh every agent's
   * ignore file (agents that are not running never pass through spawn, and the
   * mine loop only reaches them if mempalace is installed) and drop any tracked
   * `.codex` path from the index. The files stay on disk, so `codex --resume`
   * is unaffected; only their history stops.
   */
  private untrackCodexHomes(root: string): void {
    if (this.untrackedCodexHomes) return;
    this.untrackedCodexHomes = true;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return;
    try {
      for (const id of readdirSync(agentsDir)) ensureMineIgnore(join(agentsDir, id));
    } catch { /* best-effort */ }
    // Probe before mutating: `rm --cached` on a clean repo would still rewrite
    // the index on every launch, and this runs inside the commit retry path.
    const tracked = this.git(['ls-files', '--', 'agents/*/.codex'], root);
    if (!tracked.ok || !tracked.out.trim()) return;
    this.git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', 'agents/*/.codex'], root);
    console.warn('[hive] untracked previously-committed Codex homes from the hive repo');
  }

  // — commit queue —
  //
  // A commit runs `git add -A` + `git commit`, and (see git() above) an inline
  // `gc` that can take seconds on a large hive. In 'sync' mode — the default,
  // and what tests and scripts rely on — that happens right here, blocking the
  // caller. The Electron host switches to 'async' (setCommitMode) because there
  // the caller is the main process event loop: a blocked commit stalls every
  // IPC reply and every PTY byte headed for the renderer.
  //
  // In 'async' mode commit() only records the request. A debounced drain folds
  // everything queued into ONE commit per hive root and runs git as a child
  // process, one at a time, so the single-committer rule still holds. Anything
  // that removes or abandons the hive directory must call flushCommitsSync()
  // first — the same race the gc comment above describes, one level up.

  private commitMode: 'sync' | 'async' = 'sync';
  private pendingCommits: PendingCommit[] = [];
  /** The batch the async drain is committing right now (flush re-commits it if overtaken). */
  private inFlightBatch: PendingCommit[] | null = null;
  private commitInFlight = false;
  private inFlightGitPid: number | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by flushCommitsSync so an async drain it overtook stops retrying. */
  private commitEpoch = 0;

  /** 'async' moves commits off the caller's thread (see the commit-queue note). */
  setCommitMode(mode: 'sync' | 'async'): void {
    if (mode === this.commitMode) return;
    if (mode === 'sync') this.flushCommitsSync();
    this.commitMode = mode;
  }

  /** True while an async commit is queued or running. */
  hasPendingCommits(): boolean {
    return this.commitInFlight || this.commitTimer !== null || this.pendingCommits.length > 0;
  }

  /** Commit all hive changes. No-op if there is nothing staged. */
  commit(message: string): void {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git'))) return;
    if (this.commitMode === 'sync') {
      this.commitSync(root, message);
      return;
    }
    this.pendingCommits.push({ root, message });
    this.scheduleCommitDrain();
  }

  /**
   * Settle the hive on disk before it is moved, wiped or abandoned: wait for an
   * in-flight git child to exit, then commit everything still queued inline.
   * Safe to call in either mode; a no-op when nothing is pending.
   */
  flushCommitsSync(): void {
    if (this.commitTimer) { clearTimeout(this.commitTimer); this.commitTimer = null; }
    this.commitEpoch++;
    const pid = this.inFlightGitPid;
    if (pid !== null) {
      const deadline = Date.now() + GIT_TIMEOUT_MS + 2_000;
      while (Date.now() < deadline && processAlive(pid)) sleepSync(25);
    }
    // The overtaken drain may have stopped between `add` and `commit`, so its
    // batch is committed again here; if it did finish, git reports nothing to do.
    const batch = [...(this.inFlightBatch ?? []), ...this.pendingCommits.splice(0)];
    this.inFlightBatch = null;
    for (const [root, messages] of groupCommitsByRoot(batch)) {
      if (existsSync(join(root, '.git'))) this.commitSync(root, batchCommitMessage(messages));
    }
  }

  private scheduleCommitDrain(): void {
    if (this.commitTimer || this.commitInFlight) return;
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      void this.drainCommits();
    }, COMMIT_DEBOUNCE_MS);
    this.commitTimer.unref?.();
  }

  private async drainCommits(): Promise<void> {
    const batch = this.pendingCommits.splice(0);
    if (batch.length === 0) return;
    const epoch = this.commitEpoch;
    this.commitInFlight = true;
    this.inFlightBatch = batch;
    try {
      for (const [root, messages] of groupCommitsByRoot(batch)) {
        if (epoch !== this.commitEpoch) return;
        if (!existsSync(join(root, '.git'))) continue;
        await this.commitAsync(root, batchCommitMessage(messages), epoch);
      }
    } catch (e) {
      console.warn('[hive] async commit failed:', e);
    } finally {
      this.inFlightBatch = null;
      this.commitInFlight = false;
      if (this.pendingCommits.length > 0) this.scheduleCommitDrain();
    }
  }

  private commitSync(root: string, message: string): void {
    this.untrackCostLedger(root);
    this.untrackCodexHomes(root);
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
      this.clearStaleLock(root);
      const add = this.git(['add', '-A'], root);
      const commit = this.git(['commit', '-q', '-m', message], root);
      const next = commitAttemptOutcome(add, commit, attempt);
      if (next === 'done') return;
      if (next === 'give-up') break;
      sleepSync(50 * (attempt + 1));
    }
  }

  private async commitAsync(root: string, message: string, epoch: number): Promise<void> {
    // Both run once per process and are cheap probes after that.
    this.untrackCostLedger(root);
    this.untrackCodexHomes(root);
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
      if (epoch !== this.commitEpoch) return;
      this.clearStaleLock(root);
      const add = await this.gitAsync(['add', '-A'], root);
      if (epoch !== this.commitEpoch) return;
      const commit = await this.gitAsync(['commit', '-q', '-m', message], root);
      const next = commitAttemptOutcome(add, commit, attempt);
      if (next === 'done') return;
      if (next === 'give-up') return;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }

  /** git() without blocking: same flags and timeout, run as a child process. */
  private gitAsync(args: string[], cwd: string): Promise<GitResult> {
    return new Promise((resolveResult) => {
      let settled = false;
      let out = '';
      let err = '';
      let child: ChildProcess;
      try {
        child = spawn('git', [...GIT_BASE_ARGS, ...args], { cwd, windowsHide: true });
      } catch (e) {
        resolveResult({ ok: false, out: '', err: e instanceof Error ? e.message : String(e) });
        return;
      }
      this.inFlightGitPid = child.pid ?? null;
      const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, GIT_TIMEOUT_MS);
      const finish = (ok: boolean, extra = ''): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inFlightGitPid = null;
        resolveResult({ ok, out, err: err + extra });
      };
      child.stdout?.setEncoding('utf8').on('data', (d: string) => { out += d; });
      child.stderr?.setEncoding('utf8').on('data', (d: string) => { err += d; });
      child.once('error', (e) => finish(false, e.message));
      child.once('close', (code) => finish(code === 0));
    });
  }

  private clearStaleLock(root: string): void {
    const STALE_THRESHOLD_MS = 10_000;
    try {
      for (const lock of ['index.lock', 'HEAD.lock']) {
        const path = join(root, '.git', lock);
        if (existsSync(path) && Date.now() - statSync(path).mtimeMs > STALE_THRESHOLD_MS) rmSync(path);
      }
    } catch { /* noop */ }
  }
}
