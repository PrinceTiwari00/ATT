/**
 * DEVICE SESSION LOCK — the guard that stops ATT colliding with itself.
 *
 * The field failure this file pins down: the background poller and a UI action
 * (or two UI actions, or a LAN sweep) opened two TCP sessions to a terminal
 * that only serves one, and the device answered with
 *     TIMEOUT_ON_WRITING_MESSAGE
 *     ECONNRESET — "Another device is connecting to the device so the
 *                   connection is interrupted"
 * Every assertion here is one property of the fix.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { DeviceLock, DeviceBusyError, isBusyError } = require('../src/zk/deviceLock');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const makeLock = (opts = {}) => new DeviceLock({ name: 'test', gapMs: 0, staleMs: 5000, ...opts });

test('grants immediately when the device is free', async () => {
  const lock = makeLock();
  const ticket = await lock.acquire('getAttendance');
  assert.equal(lock.locked, true);
  assert.equal(ticket.label, 'getAttendance');
  assert.equal(lock.status().owner.label, 'getAttendance');
  lock.release(ticket);
  assert.equal(lock.locked, false);
});

test('refuses a second operation while the terminal is held (the reported bug)', async () => {
  const lock = makeLock();
  const first = await lock.acquire('poller:getAttendance');

  const err = await lock.acquire('route:sync-now', { timeoutMs: 0 }).then(
    () => null,
    (e) => e
  );
  assert.ok(err instanceof DeviceBusyError, 'expected a DeviceBusyError');
  assert.equal(err.code, 'DEVICE_BUSY');
  assert.equal(err.status, 409);
  assert.equal(err.retryable, false, 'a busy device must never feed the circuit breaker');
  assert.match(err.message, /poller:getAttendance/);
  assert.match(err.message, /only one device session at a time/);
  assert.equal(isBusyError(err), true);
  assert.equal(lock.status().owner.label, 'poller:getAttendance');

  lock.release(first);
});

test('release is idempotent and a stale ticket cannot unlock the next holder', async () => {
  const lock = makeLock();
  const first = await lock.acquire('a');
  assert.equal(lock.release(first), true);
  assert.equal(lock.release(first), false, 'second release must be a no-op');

  const second = await lock.acquire('b');
  assert.equal(lock.release(first), false, 'an old ticket must not release the new holder');
  assert.equal(lock.locked, true);
  lock.release(second);
});

test('queues in FIFO order when the caller is willing to wait', async () => {
  const lock = makeLock();
  const order = [];
  const first = await lock.acquire('first');

  const waiters = ['second', 'third', 'fourth'].map((label) =>
    lock.acquire(label, { timeoutMs: 2000 }).then((t) => {
      order.push(label);
      lock.release(t);
    })
  );
  await sleep(20);
  assert.equal(lock.waitingCount, 3);
  assert.deepEqual(
    lock.status().waiting.map((w) => w.label),
    ['second', 'third', 'fourth']
  );

  order.push('first');
  lock.release(first);
  await Promise.all(waiters);
  assert.deepEqual(order, ['first', 'second', 'third', 'fourth']);
  assert.equal(lock.locked, false);
  assert.equal(lock.stats.acquired, 4);
});

test('a waiter that runs out of patience is refused with what it waited for', async () => {
  const lock = makeLock();
  const holder = await lock.acquire('long-sync');
  const started = Date.now();

  const err = await lock.acquire('impatient', { timeoutMs: 60 }).then(
    () => null,
    (e) => e
  );
  assert.ok(err instanceof DeviceBusyError);
  assert.ok(Date.now() - started >= 55, 'it must actually wait the requested time');
  assert.match(err.message, /after waiting \d+ms/);
  assert.match(err.message, /long-sync/);
  assert.equal(lock.stats.timedOut, 1);

  lock.release(holder);
});

test('re-entrant ticket: a nested device call never deadlocks on itself', async () => {
  const lock = makeLock();
  let innerRan = false;

  await lock.runExclusive('push-all', async (ticket) => {
    // The manager hands this ticket to every adapter call inside the batch.
    await lock.runExclusive('setUser 7', () => { innerRan = true; }, { ticket });
    assert.equal(lock.locked, true, 'the batch still owns the device');
  });

  assert.equal(innerRan, true);
  assert.equal(lock.locked, false, 'the outermost holder released it');
});

test('runExclusive releases the lock even when the operation throws', async () => {
  const lock = makeLock();
  await assert.rejects(
    () => lock.runExclusive('boom', () => { throw new Error('device exploded'); }),
    /device exploded/
  );
  assert.equal(lock.locked, false);
  assert.equal(lock.status().history.at(-1).outcome, 'released');
});

test('the cool-down gap keeps two sessions from touching each other', async () => {
  const lock = makeLock({ gapMs: 80 });
  const first = await lock.acquire('session-1');
  lock.release(first);

  const err = await lock.acquire('session-2').then(() => null, (e) => e);
  assert.ok(err instanceof DeviceBusyError, 'immediately after a session the lock must stay shut');
  assert.match(err.message, /cool-down/);
  assert.ok(lock.status().cooldownRemainingMs > 0);

  await sleep(110);
  const second = await lock.acquire('session-2');
  assert.ok(second, 'after the gap the terminal is free again');
  lock.release(second);
});

test('a queued waiter is granted once the cool-down expires', async () => {
  // Generous wait: the whole suite runs in parallel, and this asserts an
  // ordering property, not a timing one.
  const lock = makeLock({ gapMs: 30 });
  const first = await lock.acquire('session-1');
  const waiting = lock.acquire('session-2', { timeoutMs: 5000 });
  lock.release(first);

  const ticket = await waiting;
  assert.equal(ticket.label, 'session-2');
  lock.release(ticket);
});

test('a pump that fires while the cool-down clock still runs re-arms instead of stranding the waiter', async () => {
  // Regression: `cooldownUntil` is read from Date.now() while timers run on a
  // monotonic clock. When the pump fired a hair early it used to return
  // silently and nothing ever re-checked the queue, so a caller was refused
  // after its full wait budget even though the terminal was free. Under a
  // loaded machine (the full suite in parallel) that showed up as a flake.
  let skew = 0;
  const lock = new DeviceLock({
    name: 'clock-skew',
    gapMs: 30,
    staleMs: 5000,
    now: () => Date.now() + skew,
  });

  const first = await lock.acquire('holder');
  const waiting = lock.acquire('waiter', { timeoutMs: 4000 });
  lock.release(first);
  skew = -200; // the lock's clock now trails the timer that will wake it

  const ticket = await waiting; // would time out before the fix
  assert.equal(ticket.label, 'waiter');
  assert.equal(lock.status().locked, true);

  skew = 0;
  lock.release(ticket);
  assert.equal(lock.status().locked, false);
});

test('a wedged operation is force-released so the device is never lost for good', async () => {
  const lock = makeLock({ staleMs: 1000 });
  const wedged = await lock.acquire('hung-getAttendance');

  // Somebody else asks while the holder is stuck: refused at first …
  assert.ok(await lock.acquire('later').then(() => false, () => true));

  await sleep(1150); // … then the watchdog kicks the holder out
  assert.equal(lock.locked, false);
  assert.equal(lock.stats.forcedReleases, 1);
  assert.equal(wedged.forced, true);

  const after = await lock.acquire('later', { timeoutMs: 2000 });
  assert.ok(after, 'device access recovers by itself');
  lock.release(after);
  // The wedged holder's own late release must not unlock the new one.
  assert.equal(lock.release(wedged), false);
  lock.release(after);
});

test('abortWaiters rejects everybody queued (link reconfigured / shutdown)', async () => {
  const lock = makeLock();
  const holder = await lock.acquire('holder');
  const queued = [
    lock.acquire('w1', { timeoutMs: 5000 }).then(() => 'granted', (e) => e),
    lock.acquire('w2', { timeoutMs: 5000 }).then(() => 'granted', (e) => e),
  ];
  await sleep(10);

  assert.equal(lock.abortWaiters('device link reconfigured'), 2);
  const results = await Promise.all(queued);
  for (const r of results) {
    assert.ok(r instanceof DeviceBusyError, 'queued waiters must be told, not left hanging');
  }
  assert.equal(lock.waitingCount, 0);
  lock.release(holder);
});

test('status() is the shape /api/device/status publishes', async () => {
  const lock = makeLock({ gapMs: 10, staleMs: 30000 });
  const ticket = await lock.acquire('getAttendance', { origin: 'poller:poll' });
  lock.acquire('queued-op', { timeoutMs: 500 }).catch(() => {});
  await sleep(5);

  const status = lock.status();
  assert.equal(status.locked, true);
  assert.equal(status.owner.label, 'getAttendance');
  assert.equal(status.owner.origin, 'poller:poll');
  assert.ok(status.owner.heldMs >= 0);
  assert.equal(status.waiting.length, 1);
  assert.deepEqual(status.policy, { staleMs: 30000, gapMs: 10 });
  assert.equal(status.stats.acquired, 1);
  assert.equal(status.stats.rejected, 0);

  lock.release(ticket);
  await sleep(40); // cool-down (10ms) expires → the queued operation is granted
  assert.equal(status.locked, true, 'the snapshot above is not mutated by later changes');
  assert.equal(lock.status().owner.label, 'queued-op', 'the waiter inherits the terminal');
  assert.equal(lock.status().history.length, 1);
  assert.equal(lock.status().stats.acquired, 2);

  lock.forceRelease('end of test');
  assert.equal(lock.status().locked, false);
  assert.equal(lock.status().history.at(-1).outcome, 'forced');
});

test('stats record refusals separately from device failures', async () => {
  const lock = makeLock();
  const holder = await lock.acquire('sync');
  for (const label of ['a', 'b', 'c']) {
    await lock.acquire(label).then(() => null, () => null);
  }
  assert.equal(lock.stats.rejected, 3);
  assert.equal(lock.stats.forcedReleases, 0);
  lock.release(holder);
  assert.ok(lock.stats.totalHoldMs >= 0);
});
