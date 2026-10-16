'use strict';

/**
 * An agent writes its outbox JSON by hand, so `id` and `to` are untrusted. The
 * router used both as path segments (`agents/<to>/inbox/<id>.json`), and the
 * router runs outside any agent sandbox: `id: "../../../../x"` or a `to` that
 * climbs out of `agents/` wrote a file anywhere an `inbox/` folder exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-path-ids-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  return { home, hive };
}

const outboxOf = (hive, id) => path.join(hive.root(), 'agents', id, 'outbox');

test('an agent-written message id cannot escape the inbox', async (t) => {
  const { hive } = await floor(t);
  const godInbox = path.join(hive.root(), 'agents', 'god-1', 'inbox');
  const escaped = path.resolve(godInbox, '../../../../escaped.json');

  fs.writeFileSync(path.join(outboxOf(hive, 'jim-1'), 'a.json'),
    JSON.stringify({ id: '../../../../escaped', to: 'god-1', act: 'inform', subject: 'hi' }));
  assert.equal(hive.routeOnce(), 1);

  assert.equal(fs.existsSync(escaped), false, 'nothing is written outside the inbox');
  const [got] = hive.inbox('god-1');
  assert.equal(got.subject, 'hi', 'the message is still delivered');
  assert.doesNotMatch(got.id, /[\\/]/, 'under a fresh id');
});

test('an agent-written recipient cannot climb out of agents/', async (t) => {
  const { home, hive } = await floor(t);
  const outside = path.join(home, 'outside');
  fs.mkdirSync(path.join(outside, 'inbox'), { recursive: true });
  const to = path.relative(path.join(hive.root(), 'agents'), outside);

  fs.writeFileSync(path.join(outboxOf(hive, 'jim-1'), 'b.json'),
    JSON.stringify({ to, act: 'inform', subject: 'out' }));
  assert.equal(hive.routeOnce(), 1);

  assert.deepEqual(fs.readdirSync(path.join(outside, 'inbox')), [], 'nothing lands outside the hive');
  const [bounced] = hive.inbox('god-1');
  assert.match(bounced.subject, /^\[undeliverable — no agent/, 'god hears about the bad address');
});
