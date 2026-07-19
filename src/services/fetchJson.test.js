'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fetchJson } = require('./fetchJson');

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const bad = (status) => ({ ok: false, status });
const noSleep = async () => {};

test('fetchJson returns parsed JSON on a first-try 200 (no retry)', async () => {
  let calls = 0;
  const body = { items: [1, 2, 3] };
  const res = await fetchJson('http://x', {
    fetchFn: async () => {
      calls += 1;
      return ok(body);
    },
    sleepFn: noSleep,
  });
  assert.deepStrictEqual(res, body);
  assert.strictEqual(calls, 1);
});

test('fetchJson retries a transient 520 and succeeds on the retry', async () => {
  let calls = 0;
  let slept = 0;
  const res = await fetchJson('http://x', {
    fetchFn: async () => {
      calls += 1;
      return calls === 1 ? bad(520) : ok({ done: true });
    },
    sleepFn: async () => { slept += 1; },
    delayMs: 1,
  });
  assert.deepStrictEqual(res, { done: true });
  assert.strictEqual(calls, 2);
  assert.strictEqual(slept, 1);
});

test('fetchJson retries a network error (fetch throws) then succeeds', async () => {
  let calls = 0;
  const res = await fetchJson('http://x', {
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return ok({ ok: 1 });
    },
    sleepFn: noSleep,
    delayMs: 1,
  });
  assert.deepStrictEqual(res, { ok: 1 });
  assert.strictEqual(calls, 2);
});

test('fetchJson does NOT retry a non-retryable status (404) — throws immediately', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      fetchJson('http://x', {
        fetchFn: async () => {
          calls += 1;
          return bad(404);
        },
        sleepFn: noSleep,
      }),
    /HTTP 404/
  );
  assert.strictEqual(calls, 1);
});

test('fetchJson gives up after `retries` transient failures and throws', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      fetchJson('http://x', {
        fetchFn: async () => {
          calls += 1;
          return bad(520);
        },
        retries: 3,
        sleepFn: noSleep,
      }),
    /HTTP 520/
  );
  assert.strictEqual(calls, 4); // 1 initial + 3 retries
});
