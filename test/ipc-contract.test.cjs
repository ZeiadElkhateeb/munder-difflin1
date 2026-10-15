'use strict';

/**
 * src/shared/ipcChannels.ts is the single list of IPC channel names. The typed
 * ipcMain / ipcRenderer views make an unknown channel a compile error; this test
 * pins what types cannot see:
 *   - every request channel has exactly ONE handler in main and is called by the
 *     preload bridge (a second ipcMain.handle for a channel throws at startup);
 *   - every push channel the renderer subscribes to is actually sent by main,
 *     and main sends nothing the contract does not name.
 * Known exceptions are listed explicitly, and the test fails if one stops being
 * an exception, so the lists cannot rot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { INVOKE_CHANNELS, SYNC_CHANNELS, EVENT_CHANNELS } = loadTs('src/shared/ipcChannels.ts');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

function tsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

const mainSources = tsFiles(path.join(ROOT, 'src', 'main')).map(read);
const mainText = mainSources.join('\n');
const preload = read(path.join(ROOT, 'src', 'preload', 'index.ts'));

const literals = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
const count = (list, x) => list.filter((y) => y === x).length;

const handled = literals(mainText, /ipcMain\.handle\(\s*'([^']+)'/g);
const syncHandled = literals(mainText, /ipcMain\.on\(\s*'([^']+)'/g);
const invoked = new Set(literals(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g));
const sentSync = new Set(literals(preload, /ipcRenderer\.sendSync\(\s*'([^']+)'/g));
const subscribed = new Set(literals(preload, /ipcRenderer\.on\(\s*'([^']+)'/g));

// Deliberate exceptions, each with the reason it is one. Empty is the goal; an
// entry that stops being an exception fails the test so these lists cannot rot.
/** Registered in main, never called by the bridge. */
const KNOWN_UNCALLED = [];
/** Subscribed by the bridge, never sent by main. */
const KNOWN_UNSENT = [];
/** Sent by main, never subscribed by the bridge. */
const KNOWN_UNSUBSCRIBED = [];

test('the contract lists have no duplicates and no channel in two lists', () => {
  const all = [...INVOKE_CHANNELS, ...SYNC_CHANNELS, ...EVENT_CHANNELS];
  assert.deepEqual(all.filter((c, i) => all.indexOf(c) !== i), []);
});

test('every request channel has exactly one handler in main', () => {
  for (const c of INVOKE_CHANNELS) assert.equal(count(handled, c), 1, `ipcMain.handle('${c}') count`);
  for (const c of handled) assert.ok(INVOKE_CHANNELS.includes(c), `main handles '${c}', which is not in the contract`);
});

test('every request channel is called by the preload bridge', () => {
  for (const c of INVOKE_CHANNELS) {
    if (KNOWN_UNCALLED.includes(c)) continue;
    assert.ok(invoked.has(c), `nothing in preload invokes '${c}'`);
  }
  for (const c of KNOWN_UNCALLED) assert.ok(!invoked.has(c), `'${c}' is called now — remove it from KNOWN_UNCALLED`);
});

test('every sync channel has one main listener and a preload caller', () => {
  for (const c of SYNC_CHANNELS) {
    assert.equal(count(syncHandled, c), 1, `ipcMain.on('${c}') count`);
    assert.ok(sentSync.has(c), `nothing in preload sendSyncs '${c}'`);
  }
  for (const c of syncHandled) assert.ok(SYNC_CHANNELS.includes(c), `main listens on '${c}', which is not in the contract`);
});

test('every push channel the renderer subscribes to is sent by main', () => {
  for (const c of EVENT_CHANNELS) {
    assert.ok(subscribed.has(c), `preload never subscribes to '${c}'`);
    const sent = mainText.includes(`'${c}'`);
    if (KNOWN_UNSENT.includes(c)) {
      assert.ok(!sent, `'${c}' is sent now — remove it from KNOWN_UNSENT`);
      continue;
    }
    assert.ok(sent, `main never sends '${c}'`);
  }
});

test('main only pushes channels the contract names', () => {
  // Any 'prefix:name' literal on a line that sends to a renderer.
  const sendLines = mainText.split('\n').filter((l) => /\.send\(|\bemit\??\.?\(|safeSend\(/.test(l));
  const pushed = new Set(sendLines.flatMap((l) => literals(l, /'([a-z][a-zA-Z]*:[a-zA-Z]+)'/g)));
  for (const c of pushed) {
    if (KNOWN_UNSUBSCRIBED.includes(c)) continue;
    assert.ok(EVENT_CHANNELS.includes(c), `main sends '${c}', which is not in EVENT_CHANNELS`);
  }
  for (const c of KNOWN_UNSUBSCRIBED) {
    assert.ok(pushed.has(c), `'${c}' is no longer sent — remove it from KNOWN_UNSUBSCRIBED`);
    assert.ok(!subscribed.has(c), `'${c}' is subscribed now — add it to EVENT_CHANNELS instead`);
  }
  assert.ok(pushed.size >= 20, 'the scan should find the push channels');
});
