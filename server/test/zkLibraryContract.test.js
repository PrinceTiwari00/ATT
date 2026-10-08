/**
 * REGRESSION GUARD — RealZKDevice vs. the node-zklib that is actually installed.
 *
 * The bug this file exists to catch: node-zklib 1.x ships `getAttendances`
 * (PLURAL). Every real-device sync failed with
 *     TypeError: zk.getAttendance is not a function
 * *after* a successful connect — so it only ever appeared against physical
 * hardware, while mock mode and the whole test-suite stayed green.
 *
 * The second bug it pins down: node-zklib 1.x has no user-writing API at all
 * (`setUser`/`createUser` do not exist), so "push teachers to device" could
 * never work and had to fail with an explanation instead of a TypeError.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RealZKDevice,
  ZK_METHODS,
  resolveMethodOn,
  capabilitiesFrom,
  normalizeAttendanceRecords,
  withoutZlklibBanner,
  describeError,
  classifyNetworkError,
} = require('../src/zk/realDevice');
const { ZKDeviceError, ZKConnectionError } = require('../src/zk/deviceContract');
const { ZKError } = require('node-zklib/zkerror');

const installed = require('node-zklib');
const installedProto = installed.prototype;
const installedVersion = require('node-zklib/package.json').version;

/** Swap the node-zklib module for the duration of one test. */
async function withStubLibrary(stubExports, fn) {
  const resolved = require.resolve('node-zklib');
  const saved = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: stubExports };
  try {
    return await fn();
  } finally {
    if (saved) require.cache[resolved] = saved;
    else delete require.cache[resolved];
  }
}

/**
 * Stand-in for a real terminal library. `records` are shaped exactly like
 * node-zklib's 40-byte attendance decode:
 *   { userSn, deviceUserId, recordTime: Date }
 * (note: no punch type — 40-byte records do not carry one).
 */
function makeStubLibrary({ records = [], users = [], connectBanner = 'ok tcp', extraLog } = {}) {
  const calls = [];
  function StubZKLib(ip, port, timeoutMs, inPort) {
    this.ip = ip;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.inPort = inPort;
  }
  StubZKLib.prototype.createSocket = async function createSocket() {
    calls.push('createSocket');
    if (connectBanner) console.log(connectBanner); // the library's real banner
    if (extraLog) console.log(extraLog);
  };
  StubZKLib.prototype.getAttendances = async function getAttendances() {
    calls.push('getAttendances');
    return { data: records, err: null };
  };
  StubZKLib.prototype.getUsers = async function getUsers() {
    calls.push('getUsers');
    return { data: users, err: null };
  };
  StubZKLib.prototype.getInfo = async function getInfo() {
    calls.push('getInfo');
    return { data: { deviceName: 'ZKTeco Test', firmware: '6.60' } };
  };
  StubZKLib.prototype.disconnect = async function disconnect() {
    calls.push('disconnect');
  };
  return { StubZKLib, calls };
}

const makeDevice = () =>
  new RealZKDevice({ ip: '192.168.1.110', port: 4370, timeoutMs: 1500, inPort: 0 });

/* ── the contract itself ────────────────────────────────────────────────── */

test('the INSTALLED node-zklib resolves every method the adapter needs', () => {
  for (const key of ['connect', 'getUsers', 'getLogs', 'getInfo', 'clearLogs']) {
    const resolved = resolveMethodOn(installedProto, key);
    assert.ok(
      resolved,
      `installed node-zklib v${installedVersion} has none of ${JSON.stringify(ZK_METHODS[key])} ` +
        '— every real-device operation of this kind would fail at runtime'
    );
    assert.equal(typeof resolved.fn, 'function');
  }
});

test('the attendance log is read through the name the library really ships', () => {
  const resolved = resolveMethodOn(installedProto, 'getLogs');
  assert.ok(
    ['getAttendances', 'getAttendance'].includes(resolved.name),
    `unexpected log method spelling: ${resolved.name}`
  );
  // Documents the rename that broke production: 1.x is plural.
  if (installedVersion.startsWith('1.')) {
    assert.equal(resolved.name, 'getAttendances');
    assert.equal(installedProto.getAttendance, undefined);
  }
});

test('capabilities describe the installed library without opening a socket', () => {
  const caps = RealZKDevice.capabilities();
  assert.equal(caps.library, 'node-zklib');
  assert.equal(caps.installed, true);
  assert.equal(caps.libraryVersion, installedVersion);
  assert.equal(caps.canFetchAttendance, true);
  assert.equal(caps.canFetchUsers, true);
  assert.equal(caps.canClearAttendance, true);
  // consistency: the flag must mirror the prototype, whatever the version does
  assert.equal(caps.canWriteUsers, resolveMethodOn(installedProto, 'writeUser') !== null);
  if (installedVersion.startsWith('1.')) {
    assert.equal(caps.canWriteUsers, false, 'node-zklib 1.x cannot create users');
    assert.match(caps.writeUsersHint, /Menu → User Mgt/);
  }
});

test('an instance reports the same capabilities as the class', () => {
  assert.deepEqual(makeDevice().capabilities(), RealZKDevice.capabilities());
});

/* ── the documented failure, reproduced against a stubbed library ───────── */

test('pulling the log works against the real 40-byte record shape (the reported TypeError)', async () => {
  const records = [
    { userSn: 1, deviceUserId: '12', recordTime: new Date('2026-10-08T07:55:00') },
    { userSn: 2, deviceUserId: '12', recordTime: new Date('2026-10-08T16:05:00') },
    { userSn: 3, deviceUserId: '34', recordTime: new Date('2026-10-08T08:40:00') },
  ];
  const { StubZKLib, calls } = makeStubLibrary({ records });

  await withStubLibrary(StubZKLib, async () => {
    const log = await makeDevice().getAttendance();
    assert.deepEqual(
      calls.filter((c) => c !== 'disconnect'),
      ['createSocket', 'getAttendances'],
      'the adapter must call getAttendances — the plural the library exposes'
    );
    assert.equal(calls.at(-1), 'disconnect', 'the terminal session must always be released');
    assert.equal(log.length, 3);
    assert.deepEqual(log[0], {
      userId: '12',
      timestamp: '2026-10-08T07:55:00',
      punchType: 0, // 40-byte records carry no punch type
      deviceSn: null,
    });
  });
});

test('a library exposing only the singular getAttendance still works (alias list)', async () => {
  const { StubZKLib, calls } = makeStubLibrary({
    records: [{ userSn: 1, deviceUserId: '7', recordTime: new Date('2026-10-08T09:00:00') }],
  });
  StubZKLib.prototype.getAttendance = async function getAttendance() {
    calls.push('getAttendance');
    return { data: [{ userSn: 1, deviceUserId: '7', recordTime: new Date('2026-10-08T09:00:00') }], err: null };
  };
  delete StubZKLib.prototype.getAttendances;

  await withStubLibrary(StubZKLib, async () => {
    const log = await makeDevice().getAttendance();
    assert.equal(log.length, 1);
    assert.equal(log[0].userId, '7');
    assert.ok(calls.includes('getAttendance'));
  });
});

test('a library with NO log method fails as an actionable ZKDeviceError, not a TypeError', async () => {
  const { StubZKLib, calls } = makeStubLibrary();
  delete StubZKLib.prototype.getAttendances;

  await withStubLibrary(StubZKLib, async () => {
    await assert.rejects(
      () => makeDevice().getAttendance(),
      (err) => {
        assert.ok(err instanceof ZKDeviceError, `expected ZKDeviceError, got ${err.name}`);
        assert.equal(err.retryable, false);
        assert.match(err.message, /getAttendances/);
        assert.doesNotMatch(err.message, /is not a function/);
        assert.doesNotMatch(err.message, /undefined/);
        return true;
      }
    );
    assert.deepEqual(calls, [], 'must fail before opening a TCP session');
  });
});

test('getUsers reports the device spelling and normalizes rows', async () => {
  const users = [
    { uid: 1, role: 0, name: 'Ram Bahadur', cardno: 0, userId: '12' },
    { uid: 2, role: 0, name: 'Sita Kumari', cardno: 1234, userId: '34' },
  ];
  const { StubZKLib } = makeStubLibrary({ users });
  await withStubLibrary(StubZKLib, async () => {
    const out = await makeDevice().getUsers();
    assert.deepEqual(out, [
      { userId: '12', name: 'Ram Bahadur', role: 0, cardno: 0 },
      { userId: '34', name: 'Sita Kumari', role: 0, cardno: 1234 },
    ]);
  });
});

/* ── enrollment (write) capability ──────────────────────────────────────── */

test('setUser refuses with the terminal-side workaround when the library cannot write users', async () => {
  const { StubZKLib, calls } = makeStubLibrary();
  await withStubLibrary(StubZKLib, async () => {
    await assert.rejects(
      () => makeDevice().setUser({ userId: '12', name: 'Ram Bahadur' }),
      (err) => {
        assert.ok(err instanceof ZKDeviceError);
        assert.match(err.message, /no `setUser`/);
        assert.match(err.message, /Menu → User Mgt → New User/);
        return true;
      }
    );
    assert.deepEqual(calls, [], 'must refuse before opening a TCP session');
  });
});

test('setUser works when a library does provide a writer', async () => {
  const { StubZKLib, calls } = makeStubLibrary();
  StubZKLib.prototype.setUser = async function setUser(...args) {
    calls.push(['setUser', ...args]);
    return { ok: true };
  };
  await withStubLibrary(StubZKLib, async () => {
    const res = await makeDevice().setUser({ userId: '12', name: 'Ram' });
    assert.equal(res.ok, true);
    const call = calls.find((c) => Array.isArray(c));
    assert.deepEqual(call, ['setUser', 12, '12', 'Ram', '', 0, 0]);
  });
});

/* ── log hygiene ────────────────────────────────────────────────────────── */

test('the library\'s "ok tcp" connect banner is filtered; other output passes through', async () => {
  const { StubZKLib } = makeStubLibrary({
    records: [],
    connectBanner: 'ok tcp',
    extraLog: 'real library output',
  });

  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await withStubLibrary(StubZKLib, () => makeDevice().getAttendance());
  } finally {
    console.log = original;
  }

  assert.ok(!lines.includes('ok tcp'), `banner leaked into the log: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('real library output'), 'the filter must not swallow real output');
});

test('withoutZlklibBanner restores console.log even when the operation throws', async () => {
  const original = console.log;
  await assert.rejects(() =>
    withoutZlklibBanner(async () => {
      console.log('ok udp');
      throw new Error('boom');
    })
  );
  assert.equal(console.log, original);
});

/* ── pure helpers ───────────────────────────────────────────────────────── */

test('normalizeAttendanceRecords skips corrupt rows but keeps pulling', () => {
  const out = normalizeAttendanceRecords([
    { deviceUserId: '12', recordTime: new Date('2026-10-08T07:55:00') },
    { deviceUserId: '12', recordTime: null }, // unreadable clock — skip
    { deviceUserId: '', recordTime: new Date('2026-10-08T09:00:00') }, // no id — skip
    { user_id: 34, record_time: '2026-10-08 08:40:00' }, // alternate firmware spelling
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].userId, '12');
  assert.equal(out[1].userId, '34');
  assert.equal(out[1].timestamp, '2026-10-08T08:40:00');
});

/* ── error classification (node-zklib's ZKError is not an Error) ────────── */

test('an unreachable device is reported in words, not as "[object Object]"', () => {
  // exactly what node-zklib rejects with: a ZKError wrapping the socket error
  const socketErr = new Error('connect ECONNREFUSED 192.168.1.110:4370');
  socketErr.code = 'ECONNREFUSED';
  const zkError = new ZKError(socketErr, 'TCP CONNECT', '192.168.1.110');

  assert.equal(zkError.message, undefined, 'ZKError really has no .message — it is not an Error');
  assert.ok(zkError instanceof Error === false);

  const described = describeError(zkError);
  // the library's own human phrasing wins over the raw socket text
  assert.equal(described.message, 'IP of the device is refused');
  assert.equal(described.code, 'ECONNREFUSED');
  assert.equal(described.command, 'TCP CONNECT');

  const classified = classifyNetworkError(zkError, '192.168.1.110', 4370);
  assert.ok(classified instanceof ZKConnectionError, 'socket faults must stay retryable');
  assert.equal(classified.retryable, true);
  assert.match(classified.message, /Cannot reach ZKTeco device at 192\.168\.1\.110:4370/);
  assert.match(classified.message, /IP of the device is refused/);
  assert.match(classified.message, /ECONNREFUSED/);
  assert.doesNotMatch(classified.message, /\[object Object\]/);
});

test('a socket timeout deep in the chain stays retryable too', () => {
  const timedOut = new Error('TIMEOUT_ON_WRITING_MESSAGE');
  timedOut.code = 'TIMEOUT_ON_WRITING_MESSAGE';
  const classified = classifyNetworkError(new ZKError(timedOut, '[TCP]', '10.0.0.9'), '10.0.0.9', 4370);
  assert.ok(classified instanceof ZKConnectionError);
  assert.match(classified.message, /TIMEOUT_ON_WRITING_MESSAGE/);
});

test('a genuine protocol oddity is non-retryable and still readable', () => {
  const classified = classifyNetworkError(new Error('unexpected reply 0xdead'), '10.0.0.9', 4370);
  assert.ok(classified instanceof ZKDeviceError);
  assert.equal(classified.retryable, false);
  assert.match(classified.message, /unexpected reply 0xdead/);
});

test('describeError survives shapes that are not errors at all', () => {
  assert.equal(describeError(null).message, 'unknown error');
  assert.equal(describeError('plain string').message, 'plain string');
  assert.equal(describeError({ code: 'EHOSTUNREACH' }).message, 'EHOSTUNREACH');
  // a broken toast() must not explode the classification
  assert.equal(describeError({ err: undefined, toast: () => { throw new Error('nope'); } }).message, 'unknown error');
});

test('capabilitiesFrom tolerates a missing library', () => {
  const caps = capabilitiesFrom(null, null);
  assert.equal(caps.installed, false);
  assert.equal(caps.canFetchAttendance, false);
  assert.equal(caps.canWriteUsers, false);
  assert.match(caps.fetchHint, /node-zklib is not installed/);
});
