'use strict';

/**
 * The drain (useHive.ts effect #4) is the ONLY thing that types automatic
 * messages into an agent's terminal (docs/message-queue.md). Its gates used to
 * be inline in a React effect and were pinned only by reading the source. These
 * tests exercise the extracted gate as behaviour: which conditions hold a
 * message, in which order, and what "send now" is and is not allowed to bypass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { deliveryBlocker, noteSendFailure } = loadTs('src/renderer/src/hooks/queueDelivery.ts');

const NOW = 1_000_000;
const QUIESCE_MS = 12_000; // mirrors QUIESCE_IDLE_MS in useHive
const COOLDOWN_MS = 4_500; // mirrors FLUSH_COOLDOWN_MS in useHive

/** An agent and message that may be delivered; each test breaks one thing. */
function gate(overrides = {}) {
  return {
    now: NOW,
    status: 'idle',
    ptyQuietMs: 0,
    quiesceMs: QUIESCE_MS,
    autoDeliveryPaused: false,
    manual: false,
    bootGraceUntil: 0,
    terminalSafe: () => true,
    lastFlushAt: 0,
    cooldownMs: COOLDOWN_MS,
    ...overrides
  };
}

test('an idle, unpaused, booted agent with a free prompt is delivered to', () => {
  assert.equal(deliveryBlocker(gate()), null);
});

test('a working agent is never typed into, even for a "send now" message', () => {
  for (const status of ['working', 'thinking', 'waiting', 'blocked']) {
    assert.equal(deliveryBlocker(gate({ status })), 'not-deliverable', status);
    assert.equal(deliveryBlocker(gate({ status, manual: true })), 'not-deliverable', `${status} + manual`);
  }
});

test('a breaker-pinned agent is deliverable only once its terminal is quiet', () => {
  assert.equal(deliveryBlocker(gate({ status: 'looping', ptyQuietMs: QUIESCE_MS - 1 })), 'not-deliverable');
  assert.equal(deliveryBlocker(gate({ status: 'looping', ptyQuietMs: null })), 'not-deliverable');
  assert.equal(deliveryBlocker(gate({ status: 'looping', ptyQuietMs: QUIESCE_MS })), null);
});

test('the auto-delivery pause holds automatic messages but releases "send now"', () => {
  assert.equal(deliveryBlocker(gate({ autoDeliveryPaused: true })), 'paused');
  assert.equal(deliveryBlocker(gate({ autoDeliveryPaused: true, manual: true })), null);
});

test('"send now" bypasses only the pause: boot grace, the user\'s prompt and the cooldown still hold', () => {
  const manualPaused = { autoDeliveryPaused: true, manual: true };
  assert.equal(deliveryBlocker(gate({ ...manualPaused, bootGraceUntil: NOW + 1 })), 'boot-grace');
  assert.equal(deliveryBlocker(gate({ ...manualPaused, terminalSafe: () => false })), 'user-owns-prompt');
  assert.equal(deliveryBlocker(gate({ ...manualPaused, lastFlushAt: NOW - 1 })), 'cooldown');
});

test('boot grace holds through its last millisecond', () => {
  assert.equal(deliveryBlocker(gate({ bootGraceUntil: NOW })), 'boot-grace');
  assert.equal(deliveryBlocker(gate({ bootGraceUntil: NOW - 1 })), null);
});

test('a draft or an open menu in the terminal holds delivery', () => {
  assert.equal(deliveryBlocker(gate({ terminalSafe: () => false })), 'user-owns-prompt');
});

test('back-to-back deliveries are spaced by the cooldown', () => {
  assert.equal(deliveryBlocker(gate({ lastFlushAt: NOW - COOLDOWN_MS + 1 })), 'cooldown');
  assert.equal(deliveryBlocker(gate({ lastFlushAt: NOW - COOLDOWN_MS })), null);
});

test('the terminal is only consulted once every cheaper gate has passed', () => {
  let asked = 0;
  const terminalSafe = () => { asked++; return true; };
  deliveryBlocker(gate({ status: 'working', terminalSafe }));
  deliveryBlocker(gate({ autoDeliveryPaused: true, terminalSafe }));
  deliveryBlocker(gate({ bootGraceUntil: NOW + 1, terminalSafe }));
  assert.equal(asked, 0);
  deliveryBlocker(gate({ terminalSafe }));
  assert.equal(asked, 1);
});

test('gates are reported in order when several hold at once', () => {
  const everything = {
    status: 'working', autoDeliveryPaused: true, bootGraceUntil: NOW + 1,
    terminalSafe: () => false, lastFlushAt: NOW
  };
  assert.equal(deliveryBlocker(gate(everything)), 'not-deliverable');
  assert.equal(deliveryBlocker(gate({ ...everything, status: 'idle' })), 'paused');
  assert.equal(deliveryBlocker(gate({ ...everything, status: 'idle', autoDeliveryPaused: false })), 'boot-grace');
});

test('a message whose PTY writes keep failing is retried, then dropped and forgotten', () => {
  const failures = {};
  assert.deepEqual(noteSendFailure(failures, 'm1', 3), { verdict: 'retry', attempts: 1 });
  assert.deepEqual(noteSendFailure(failures, 'm1', 3), { verdict: 'retry', attempts: 2 });
  assert.deepEqual(noteSendFailure(failures, 'm2', 3), { verdict: 'retry', attempts: 1 }, 'counted per message');
  assert.deepEqual(noteSendFailure(failures, 'm1', 3), { verdict: 'drop', attempts: 3 });
  assert.equal('m1' in failures, false, 'a dropped message leaves no counter behind');
  assert.equal(failures.m2, 1);
});
