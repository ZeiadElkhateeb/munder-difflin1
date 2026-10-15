'use strict';

/**
 * The hive's git commits used to run inline on the Electron main process. A
 * commit runs `git add -A`, `git commit` and an inline `gc` (gc.autoDetach is off
 * on purpose, see HiveManager.git), so a large hive could freeze every IPC reply
 * and PTY stream for seconds. The app now switches the hive to an async commit
 * queue. These tests pin the contract that change relies on:
 *   1. the default stays synchronous, so scripts and tests see no change;
 *   2. async mode returns at once and folds a burst into ONE commit that still
 *      lists every original message;
 *   3. flushCommitsSync settles everything — queued or mid-flight — so the hive
 *      directory can be copied or removed straight after.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager, batchCommitMessage } = loadTs('src/main/hive.ts');

function freshHive(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-commitq-'));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  t.after(() => {
    hive.flushCommitsSync();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { hive, root: hive.root() };
}

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const commitCount = (root) => Number(git(root, 'rev-list', '--count', 'HEAD').trim());
const isClean = (root) => git(root, 'status', '--porcelain').trim() === '';

async function waitFor(pred, ms = 15_000) {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timed out waiting for the commit queue');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('the default mode commits inline, as before', (t) => {
  const { hive, root } = freshHive(t);
  const before = commitCount(root);
  fs.writeFileSync(path.join(root, 'note.md'), 'one');
  hive.commit('hive: sync one');
  assert.equal(commitCount(root), before + 1);
  assert.equal(git(root, 'log', '-1', '--format=%s').trim(), 'hive: sync one');
  assert.equal(hive.hasPendingCommits(), false);
});

test('async mode returns immediately and folds a burst into one commit', async (t) => {
  const { hive, root } = freshHive(t);
  hive.setCommitMode('async');
  const before = commitCount(root);
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(root, `note-${i}.md`), String(i));
    hive.commit(`hive: change ${i}`);
  }
  assert.equal(commitCount(root), before, 'nothing is committed on the caller thread');
  assert.equal(hive.hasPendingCommits(), true);

  await waitFor(() => !hive.hasPendingCommits());
  assert.equal(commitCount(root), before + 1, 'the burst becomes a single commit');
  const body = git(root, 'log', '-1', '--format=%B');
  assert.match(body, /^hive: 5 changes/);
  for (let i = 0; i < 5; i++) assert.ok(body.includes(`- hive: change ${i}`), `message ${i} is kept`);
  assert.ok(isClean(root));
});

test('flushCommitsSync commits queued work before the hive is removed', (t) => {
  const { hive, root } = freshHive(t);
  hive.setCommitMode('async');
  fs.writeFileSync(path.join(root, 'queued.md'), 'x');
  hive.commit('hive: queued');
  hive.flushCommitsSync();
  assert.equal(hive.hasPendingCommits(), false);
  assert.equal(git(root, 'log', '-1', '--format=%s').trim(), 'hive: queued');
  assert.ok(isClean(root));
});

test('flushCommitsSync overtakes a commit that is already running', async (t) => {
  const { hive, root } = freshHive(t);
  hive.setCommitMode('async');
  fs.writeFileSync(path.join(root, 'first.md'), 'a');
  hive.commit('hive: first');
  // Let the debounce fire so a git child is genuinely in flight…
  await waitFor(() => hive.inFlightGitPid !== null || !hive.hasPendingCommits());
  // …then queue more work and flush while it runs.
  fs.writeFileSync(path.join(root, 'second.md'), 'b');
  hive.commit('hive: second');
  hive.flushCommitsSync();
  assert.ok(isClean(root), 'both changes are committed when flush returns');
  // The overtaken drain must not start another git process afterwards.
  await waitFor(() => !hive.hasPendingCommits());
  assert.ok(isClean(root));
  // Removing the hive straight away is the operation flush exists for.
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false);
});

test('switching back to sync flushes anything still queued', (t) => {
  const { hive, root } = freshHive(t);
  hive.setCommitMode('async');
  fs.writeFileSync(path.join(root, 'late.md'), 'z');
  hive.commit('hive: late');
  hive.setCommitMode('sync');
  assert.equal(git(root, 'log', '-1', '--format=%s').trim(), 'hive: late');
});

test('a batch commit message keeps a lone message as-is and lists a batch', () => {
  assert.equal(batchCommitMessage(['hive: only']), 'hive: only');
  assert.equal(batchCommitMessage(['a', 'b']), 'hive: 2 changes\n\n- a\n- b');
});
