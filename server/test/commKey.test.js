/**
 * COMM KEY — the terminal's connection password.
 *
 * Two things are pinned down here:
 *   1. `makeCommKey` matches the vendor algorithm (commpro.c `MakeKey`, the one
 *      pyzk ships) byte for byte. The fixtures below were produced by running
 *      pyzk's own `make_commkey` in CPython — if this ever drifts, a keyed
 *      terminal silently refuses every command.
 *   2. The CMD_CONNECT → CMD_ACK_UNAUTH → CMD_AUTH handshake that node-zklib
 *      does NOT implement, so a keyed device used to look "connected" and then
 *      time out on every command.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CMD,
  ACK,
  describeAck,
  replyCode,
  makeCommKey,
  normalizeCommKey,
  openSession,
  transportOf,
  readOption,
  writeOption,
  readCommKeyOption,
  writeCommKeyOption,
  COMM_KEY_OPTION_NAMES,
} = require('../src/zk/commKey');
const { ZKConnectionError, ZKDeviceError } = require('../src/zk/deviceContract');

/* ── fixtures straight out of pyzk's make_commkey ─────────────────────────── */
const PYZK_VECTORS = [
  // [commKey, sessionId, ticks, expected hex]
  [1, 0, 50, '61fd3279'],
  [1, 43981, 50, '61fd32d2'],
  [0, 0, 50, '617d3279'],
  [12345, 1, 50, '6de13279'],
  [65535, 65535, 50, '9e823286'],
  [7, 2, 200, '9b67c883'],
  [1, 1, 0, '53cf004b'],
  [999999, 77, 50, '23813289'],
  [2147483648, 3, 50, '617d3279'],
  [4294967295, 65535, 50, '617d3286'],
];

test('makeCommKey reproduces the vendor algorithm exactly', () => {
  for (const [key, sessionId, ticks, expected] of PYZK_VECTORS) {
    assert.equal(
      makeCommKey(key, sessionId, ticks).toString('hex'),
      expected,
      `key=${key} sessionId=${sessionId} ticks=${ticks}`
    );
  }
});

test('makeCommKey always returns the 4-byte CMD_AUTH payload, ticks byte in position 2', () => {
  for (const [key, sessionId, ticks] of PYZK_VECTORS) {
    const buf = makeCommKey(key, sessionId, ticks);
    assert.equal(buf.length, 4);
    assert.equal(buf[2], ticks & 0xff);
  }
});

test('the scrambled key tracks the session id (beyond the byte `ticks` overwrites)', () => {
  // Vendor quirk, reproduced faithfully: the LOW byte of (bit-reversed key +
  // session id) lands in the position that the `ticks` byte overwrites, so
  // session ids below 256 produce the same payload. Real devices hand out
  // session ids in the tens of thousands, where the key does change.
  assert.deepEqual(makeCommKey(1, 1), makeCommKey(1, 2));
  assert.notDeepEqual(makeCommKey(1, 1), makeCommKey(1, 43981));
  assert.notDeepEqual(makeCommKey(1, 43981), makeCommKey(2, 43981));
});

test('normalizeCommKey accepts numbers and rejects nonsense', () => {
  assert.equal(normalizeCommKey(undefined), 0);
  assert.equal(normalizeCommKey(null), 0);
  assert.equal(normalizeCommKey(''), 0);
  assert.equal(normalizeCommKey('1'), 1);
  assert.equal(normalizeCommKey(7.9), 7);
  assert.throws(() => normalizeCommKey(-1), ZKDeviceError);
  assert.throws(() => normalizeCommKey('abc'), ZKDeviceError);
});

test('describeAck names the wire codes', () => {
  assert.equal(describeAck(ACK.OK), 'CMD_ACK_OK (2000)');
  assert.equal(describeAck(ACK.UNAUTH), 'CMD_ACK_UNAUTH (2005)');
  assert.equal(describeAck(null), 'no reply');
  assert.equal(describeAck(4242), 'code 4242');
});

/* ── a stand-in for node-zklib's instance shape ───────────────────────────── */

/** Build a reply buffer the way node-zklib hands one back (prefix removed). */
function reply(code, { sessionId = 0, replyId = 0, payload = '' } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'ascii');
  const buf = Buffer.alloc(8 + body.length);
  buf.writeUInt16LE(code, 0);
  buf.writeUInt16LE(0, 2);
  buf.writeUInt16LE(sessionId, 4);
  buf.writeUInt16LE(replyId, 6);
  body.copy(buf, 8);
  return buf;
}

/**
 * @param {object} opts
 * @param {number} opts.connectCode   what CMD_CONNECT answers
 * @param {number} opts.authCode      what CMD_AUTH answers
 * @param {number} opts.sessionId     the session id the device assigns
 * @param {(command:number, data:any) => Buffer|null} [opts.onCommand] option replies
 * @param {boolean} [opts.noInternals] hide zklibTcp (unknown library shape)
 */
function makeFakeZk({ connectCode = ACK.OK, authCode = ACK.OK, sessionId = 43981, onCommand = null, noInternals = false } = {}) {
  const sent = [];
  const zk = {
    connectionType: null,
    createSocketCalls: 0,
    sent,
    disconnectCalls: 0,
    async createSocket() {
      zk.createSocketCalls++;
      zk.connectionType = 'tcp';
    },
    async disconnect() {
      zk.disconnectCalls++;
    },
  };

  if (!noInternals) {
    zk.zklibTcp = {
      sessionId: 0,
      socket: {},
      async createSocket() {
        sent.push({ command: 'tcp-connect' });
      },
      async executeCmd(command, data) {
        sent.push({ command, data });
        if (command === CMD.CONNECT) {
          // node-zklib adopts the session id from the connect reply itself.
          zk.zklibTcp.sessionId = sessionId;
          return reply(connectCode, { sessionId });
        }
        if (command === CMD.AUTH) return reply(authCode, { sessionId });
        if (typeof onCommand === 'function') return onCommand(command, data);
        return reply(ACK.OK, { sessionId });
      },
    };
    // The ZKLib wrapper routes raw commands to the live transport.
    zk.executeCmd = (command, data) => zk.zklibTcp.executeCmd(command, data);
  }
  return zk;
}

/* ── the handshake ────────────────────────────────────────────────────────── */

test('a terminal with no Comm Key connects straight through', async () => {
  const zk = makeFakeZk({ connectCode: ACK.OK });
  const session = await openSession(zk, { commKey: 0, ip: '192.168.1.110', port: 4370 });

  assert.equal(session.path, 'explicit');
  assert.equal(session.commKeyRequired, false);
  assert.equal(session.authenticated, false);
  assert.equal(session.sessionId, 43981);
  assert.equal(zk.connectionType, 'tcp', 'commands must be routed to the TCP transport');
  assert.ok(!zk.sent.some((c) => c.command === CMD.AUTH), 'no key → no CMD_AUTH');
});

test('a keyed terminal is detected and ATT authenticates with the scrambled key', async () => {
  const zk = makeFakeZk({ connectCode: ACK.UNAUTH, authCode: ACK.OK });
  const session = await openSession(zk, { commKey: 1, ip: '192.168.1.110', port: 4370 });

  assert.equal(session.commKeyRequired, true, 'the device told us it wants a key');
  assert.equal(session.authenticated, true);

  const auth = zk.sent.find((c) => c.command === CMD.AUTH);
  assert.ok(auth, 'CMD_AUTH must have been sent');
  assert.deepEqual(
    Buffer.from(auth.data),
    makeCommKey(1, 43981),
    'CMD_AUTH must carry the vendor scramble of (key, sessionId)'
  );
});

test('a keyed terminal with NO key in ATT explains itself instead of timing out later', async () => {
  const zk = makeFakeZk({ connectCode: ACK.UNAUTH });
  const err = await openSession(zk, { commKey: 0, ip: '192.168.1.110', port: 4370 }).then(
    () => null,
    (e) => e
  );
  assert.ok(err instanceof ZKDeviceError);
  assert.equal(err.retryable, false, 'retrying a missing password cannot help');
  assert.match(err.message, /requires a Comm Key/);
  assert.match(err.message, /ZK_COMM_KEY/);
  assert.match(err.message, /Menu → COMM → Comm Key = 0/);
});

test('the WRONG key is reported as rejected, not as an unreachable device', async () => {
  const zk = makeFakeZk({ connectCode: ACK.UNAUTH, authCode: ACK.UNAUTH });
  const err = await openSession(zk, { commKey: 2, ip: '10.0.0.9', port: 4370 }).then(
    () => null,
    (e) => e
  );
  assert.ok(err instanceof ZKDeviceError);
  assert.match(err.message, /REJECTED Comm Key 2/);
  assert.match(err.message, /10\.0\.0\.9:4370/);
});

test('a terminal that answers the handshake with anything else is retryable', async () => {
  const zk = makeFakeZk({ connectCode: ACK.RETRY });
  const err = await openSession(zk, { commKey: 0 }).then(() => null, (e) => e);
  assert.ok(err instanceof ZKConnectionError);
  assert.match(err.message, /refused the session handshake/);
  assert.match(err.message, /CMD_ACK_RETRY \(2003\)/);
  assert.match(err.message, /another client/, 'the usual cause must be named');
});

test('an unknown library shape falls back to the library connect (no regression)', async () => {
  const zk = makeFakeZk({ noInternals: true });
  assert.equal(transportOf(zk), null);
  const session = await openSession(zk, { commKey: 0 });
  assert.equal(session.path, 'library');
  assert.equal(zk.createSocketCalls, 1, 'node-zklib did the connecting');
});

test('replyCode reads the wire code out of a node-zklib reply', () => {
  assert.equal(replyCode(reply(ACK.OK)), ACK.OK);
  assert.equal(replyCode(null), null);
  assert.equal(replyCode(Buffer.from([])), null);
  assert.equal(replyCode({ nope: true }), null);
});

/* ── reading / writing the key ON the terminal ────────────────────────────── */

test('readOption parses "NAME=value" payloads', async () => {
  const zk = makeFakeZk({
    onCommand: (command, data) =>
      command === CMD.OPTIONS_RRQ ? reply(ACK.OK, { payload: `${data}=1\x00\x00` }) : reply(ACK.OK),
  });
  assert.equal(await readOption(zk, 'COMKey'), '1');
});

test('readOption surfaces a firmware that will not answer', async () => {
  const zk = makeFakeZk({ onCommand: () => reply(ACK.ERROR) });
  await assert.rejects(() => readOption(zk, 'COMKey'), /did not return option "COMKey"/);
});

test('readCommKeyOption finds the spelling this firmware uses', async () => {
  const zk = makeFakeZk({
    onCommand: (command, data) => {
      if (command !== CMD.OPTIONS_RRQ) return reply(ACK.OK);
      // Only the SECOND spelling answers on this firmware.
      return data === COMM_KEY_OPTION_NAMES[1]
        ? reply(ACK.OK, { payload: `${data}=7\x00` })
        : reply(ACK.ERROR);
    },
  });
  const found = await readCommKeyOption(zk);
  assert.equal(found.supported, true);
  assert.equal(found.name, COMM_KEY_OPTION_NAMES[1]);
  assert.equal(found.value, '7');
  assert.equal(found.tried.length, 1, 'it should stop at the first spelling that works');
});

test('readCommKeyOption reports unsupported firmware instead of guessing', async () => {
  const zk = makeFakeZk({ onCommand: () => reply(ACK.ERROR_CMD) });
  const found = await readCommKeyOption(zk);
  assert.equal(found.supported, false);
  assert.equal(found.name, null);
  assert.equal(found.tried.length, COMM_KEY_OPTION_NAMES.length);
});

test('writeCommKeyOption sends "NAME=key\\0" and needs an ACK_OK', async () => {
  const writes = [];
  const zk = makeFakeZk({
    onCommand: (command, data) => {
      if (command !== CMD.OPTIONS_WRQ) return reply(ACK.OK);
      writes.push(data);
      return reply(ACK.OK);
    },
  });
  const out = await writeCommKeyOption(zk, 1);
  assert.equal(out.ok, true);
  assert.equal(out.name, 'COMKey');
  assert.equal(writes[0], 'COMKey=1\x00');
});

test('writeCommKeyOption explains a firmware that refuses option writes', async () => {
  const zk = makeFakeZk({ onCommand: () => reply(ACK.ERROR) });
  const err = await writeCommKeyOption(zk, 1).then(() => null, (e) => e);
  assert.ok(err instanceof ZKDeviceError);
  assert.match(err.message, /Could not write the Comm Key/);
  assert.match(err.message, /keypad/, 'the operator must be given the manual route');
});

test('writeOption accepts a preferred spelling when one is known', async () => {
  const writes = [];
  const zk = makeFakeZk({
    onCommand: (command, data) => {
      if (command === CMD.OPTIONS_WRQ) writes.push(data);
      return reply(ACK.OK);
    },
  });
  const out = await writeCommKeyOption(zk, 0, { name: 'COMMKEY' });
  assert.equal(out.name, 'COMMKEY');
  assert.deepEqual(writes, ['COMMKEY=0\x00']);
});
