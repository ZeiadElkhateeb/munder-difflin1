'use strict';

// A webhook caller declares `kind` in its JSON body. Trusting a declared
// 'communication' let any directive skip the approval hold in
// `communication-only` mode, so a declaration may only make a message stricter.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readMainSource } = require('./main-source.cjs');

const { classifyInboundKind } = loadTs('src/shared/triggers.ts');

test('the webhook gate lets the classifier decide, not the caller', () => {
  // webhookService imports electron, so pin the call: `msg.kind ?? …` was the bypass.
  assert.match(readMainSource(), /classifyInboundKind\(msg\.message, msg\.kind\)/);
});

test('a declared directive is held even when it reads like a question', () => {
  assert.equal(classifyInboundKind('what is the status?', 'directive'), 'directive');
  assert.equal(classifyInboundKind('what is the status?', 'communication'), 'communication');
  assert.equal(classifyInboundKind('what is the status?'), 'communication');
});
