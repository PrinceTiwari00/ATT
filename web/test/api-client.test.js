import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api/client.js';

const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const calls = [];

test.before(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => '',
      removeItem: () => {},
      setItem: () => {},
    },
  });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { ok: true } }),
    };
  };
});

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    delete globalThis.localStorage;
  }
});

test('Comm Key status stays settings-only until the user asks to check the terminal', async () => {
  calls.length = 0;

  await api.commKey();
  await api.commKey({ device: true });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/device/comm-key?device=false');
  assert.equal(calls[1].url, '/api/device/comm-key?device=true');
});

test('Comm Key changes POST the selected value and terminal-write choice', async () => {
  calls.length = 0;

  await api.setCommKey(4721, false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/device/comm-key');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    key: 4721,
    writeToDevice: false,
  });
});
