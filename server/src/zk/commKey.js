/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  COMM KEY — the ZKTeco terminal's connection password
 * ─────────────────────────────────────────────────────────────────────────────
 *  A ZKTeco terminal has a **Comm Key** (some firmware: "Password",
 *  Menu → COMM → Comm Key). With the key set to 0 the device answers ANY
 *  client on the LAN — ZKTime, a second ATT install, a laptop running a
 *  demo — and because it serves only ONE management session, whoever connects
 *  second kills whoever connected first. That is the "ATT collides with
 *  itself / another device is connecting" failure this school kept hitting.
 *
 *  Setting a non-zero Comm Key (1 is fine) makes the terminal demand proof
 *  before it answers a single command:
 *
 *      client → CMD_CONNECT            (1000)
 *      device → CMD_ACK_UNAUTH         (2005)  "prove you know the key"
 *      client → CMD_AUTH + scrambled(key, sessionId)   (1102)
 *      device → CMD_ACK_OK             (2000)  session is live
 *
 *  Every client that does not know the key now dies at step 2 — which is
 *  exactly how you evict other software from the terminal without touching
 *  the network.
 *
 *  `node-zklib` (the library ATT uses) has NO idea this handshake exists: its
 *  `connect()` only checks that *some* reply arrived, so against a keyed
 *  device it reports "connected" and then every command times out with
 *  TIMEOUT_ON_WRITING_MESSAGE. This module implements the handshake, the key
 *  scrambling and the option read/write on top of the library's socket, so
 *  ATT can both USE a key and SET one on the terminal.
 *
 *  Key scrambling is the vendor algorithm (commpro.c `MakeKey`), the same one
 *  pyzk / every other ZK client uses, so a key set here works with any tool.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { ZKConnectionError, ZKDeviceError } = require('./deviceContract');

/* Protocol constants — part of the ZK wire format, not of any one library. */
const CMD = {
  CONNECT: 1000,
  EXIT: 1001,
  AUTH: 1102,
  OPTIONS_RRQ: 11,
  OPTIONS_WRQ: 12,
  GET_FREE_SIZES: 50,
};

const ACK = {
  OK: 2000,
  ERROR: 2001,
  DATA: 2002,
  RETRY: 2003,
  REPEAT: 2004,
  UNAUTH: 2005,
  UNKNOWN: 65535,
  ERROR_CMD: 65533,
  ERROR_INIT: 65532,
  ERROR_DATA: 65531,
};

const ACK_NAMES = new Map(Object.entries(ACK).map(([name, code]) => [code, `CMD_ACK_${name}`]));

/** Human name for a reply code, e.g. 2005 → "CMD_ACK_UNAUTH (2005)". */
function describeAck(code) {
  if (code == null) return 'no reply';
  const name = ACK_NAMES.get(code);
  return name ? `${name} (${code})` : `code ${code}`;
}

/** Read the reply code out of a node-zklib `executeCmd` result. */
function replyCode(reply) {
  if (!reply || typeof reply.readUInt16LE !== 'function' || reply.length < 2) return null;
  return reply.readUInt16LE(0);
}

/**
 * Vendor Comm-Key scramble (commpro.c `MakeKey`, as used by pyzk).
 *
 *   1. bit-reverse the 32-bit key
 *   2. add the session id the device just handed us
 *   3. XOR the four bytes with 'Z','K','S','O'
 *   4. swap the two 16-bit halves
 *   5. XOR bytes 0,1,3 with a `ticks` byte and put that byte in position 2
 *
 * @param {number} key        the Comm Key configured on the terminal (0..65535+)
 * @param {number} sessionId  session id from the CMD_CONNECT reply
 * @param {number} [ticks=50] the free byte; any value works, 50 is the reference default
 * @returns {Buffer} 4-byte CMD_AUTH payload
 */
function makeCommKey(key, sessionId, ticks = 50) {
  const keyBig = BigInt(Number(key) >>> 0);
  let k = 0n;
  for (let i = 0n; i < 32n; i++) {
    k = keyBig & (1n << i) ? (k << 1n) | 1n : k << 1n;
  }
  k = (k + BigInt(Number(sessionId) >>> 0)) & 0xffffffffn;

  const le = Buffer.alloc(4);
  le.writeUInt32LE(Number(k), 0);

  // XOR with 'Z','K','S','O' …
  const xored = [le[0] ^ 0x5a, le[1] ^ 0x4b, le[2] ^ 0x53, le[3] ^ 0x4f];
  // … swap the two 16-bit halves (little-endian) …
  const swapped = [xored[2], xored[3], xored[0], xored[1]];
  // … then fold in the `ticks` byte, which travels un-xored in position 2.
  const b = Number(ticks) & 0xff;
  return Buffer.from([swapped[0] ^ b, swapped[1] ^ b, b, swapped[3] ^ b]);
}

/** A Comm Key is a small non-negative integer on every ZKTeco firmware. */
function normalizeCommKey(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ZKDeviceError(`Comm Key must be a number ≥ 0 (got "${value}")`);
  }
  if (n > 4294967295) throw new ZKDeviceError('Comm Key is far too large (max 4294967295)');
  return Math.trunc(n);
}

/* ── session handshake ───────────────────────────────────────────────────── */

/**
 * node-zklib keeps its transport objects on the wrapper instance. We only use
 * them when they look exactly like the published 1.x shape; anything else and
 * we fall back to the library's own createSocket().
 */
function transportOf(zk) {
  const tcp = zk && zk.zklibTcp;
  if (tcp && typeof tcp.createSocket === 'function' && typeof tcp.executeCmd === 'function') {
    return { kind: 'tcp', transport: tcp };
  }
  return null;
}

/**
 * Open a session on an already-constructed node-zklib instance and complete the
 * Comm Key handshake when the terminal asks for one.
 *
 * @param {object} zk   a `new ZKLib(ip, port, timeout, inport)` instance
 * @param {object} [opts]
 * @param {number} [opts.commKey=0]  the key configured on the terminal
 * @param {string} [opts.ip]         for error text
 * @param {number} [opts.port]
 * @returns {Promise<{path:'explicit'|'library', sessionId:number|null,
 *                    commKeyRequired:boolean|null, authenticated:boolean,
 *                    connectCode:number|null}>}
 */
async function openSession(zk, { commKey = 0, ip = '', port = 0 } = {}) {
  const where = ip ? `${ip}:${port}` : 'the terminal';
  const found = transportOf(zk);

  if (!found) {
    // Unknown library shape — behave exactly like ATT always did.
    await zk.createSocket();
    return { path: 'library', sessionId: null, commKeyRequired: null, authenticated: false, connectCode: null };
  }

  const { transport } = found;
  await transport.createSocket(); // raw TCP connect, no protocol yet

  const connectReply = await transport.executeCmd(CMD.CONNECT, '');
  const connectCode = replyCode(connectReply);
  // node-zklib stores the session id from the CMD_CONNECT reply itself.
  const sessionId =
    typeof transport.sessionId === 'number' && transport.sessionId
      ? transport.sessionId
      : connectReply && connectReply.length >= 6
        ? connectReply.readUInt16LE(4)
        : 0;

  let commKeyRequired = false;
  let authenticated = false;

  if (connectCode === ACK.UNAUTH) {
    commKeyRequired = true;
    const key = normalizeCommKey(commKey);
    if (!key) {
      throw new ZKDeviceError(
        `The ZKTeco terminal at ${where} requires a Comm Key (connection password) but ATT has none configured, ` +
          'so every command would be refused. Either save the key in ATT (Device & Sync → Comm Key, or ' +
          'ZK_COMM_KEY / device.commKey) or clear it on the keypad: Menu → COMM → Comm Key = 0.'
      );
    }
    const authReply = await transport.executeCmd(CMD.AUTH, makeCommKey(key, sessionId));
    const authCode = replyCode(authReply);
    if (authCode === ACK.UNAUTH) {
      throw new ZKDeviceError(
        `The ZKTeco terminal at ${where} REJECTED Comm Key ${key}. The key saved in ATT does not match the one on ` +
          'the device (Menu → COMM → Comm Key). Fix either side, then test the link again.'
      );
    }
    if (authCode !== ACK.OK) {
      throw new ZKConnectionError(
        `Comm Key authentication with ${where} failed — the terminal answered ${describeAck(authCode)}`
      );
    }
    authenticated = true;
  } else if (connectCode !== ACK.OK) {
    // Reachable but unwilling: busy with another client, or firmware oddity.
    throw new ZKConnectionError(
      `The ZKTeco terminal at ${where} refused the session handshake (${describeAck(connectCode)}). ` +
        'This usually means it is still serving another client — close ZKTime/other ATT copies, or reboot the terminal.'
    );
  }

  // Tell the node-zklib wrapper which transport to route commands through.
  zk.connectionType = found.kind;
  return { path: 'explicit', sessionId, commKeyRequired, authenticated, connectCode };
}

/* ── device options (read/write the Comm Key ON the terminal) ─────────────── */

/**
 * Firmware spellings of the Comm Key option, most common first. ZKTeco's own
 * SDK vocabulary uses `COMKey`; older/other builds answer to `COMMKEY`.
 */
const COMM_KEY_OPTION_NAMES = ['COMKey', 'COMMKEY', 'CommKey', 'COMMKey'];

/** Reply payload of a node-zklib executeCmd call (skips the 8-byte header). */
function replyPayload(reply) {
  if (!reply || typeof reply.subarray !== 'function') return '';
  return reply.subarray(Math.min(8, reply.length)).toString('ascii');
}

/** Read one device option → its string value ('' when the device says nothing). */
async function readOption(zk, name) {
  const reply = await zk.executeCmd(CMD.OPTIONS_RRQ, name);
  const code = replyCode(reply);
  if (code !== ACK.OK && code !== ACK.DATA) {
    throw new ZKDeviceError(`The terminal did not return option "${name}" (${describeAck(code)})`);
  }
  const payload = replyPayload(reply).replace(/\0+$/g, '');
  const eq = payload.indexOf('=');
  return eq === -1 ? payload.trim() : payload.slice(eq + 1).trim();
}

/** Write one device option. Returns true when the terminal acknowledged. */
async function writeOption(zk, name, value) {
  const reply = await zk.executeCmd(CMD.OPTIONS_WRQ, `${name}=${value}\x00`);
  const code = replyCode(reply);
  if (code === ACK.OK) return true;
  throw new ZKDeviceError(
    `The terminal refused to save option "${name}" (${describeAck(code)}). ` +
      'Some firmware only accepts option writes from an administrator session — set the Comm Key on the keypad instead.'
  );
}

/**
 * Discover which spelling this firmware uses and what the key currently is.
 * Returns {supported, name, value} — `supported:false` when no spelling
 * answers, which means "change it on the keypad".
 */
async function readCommKeyOption(zk) {
  const tried = [];
  for (const name of COMM_KEY_OPTION_NAMES) {
    try {
      const value = await readOption(zk, name);
      if (value === '' ) { tried.push({ name, error: 'empty reply' }); continue; }
      return { supported: true, name, value, tried };
    } catch (err) {
      tried.push({ name, error: err.message });
    }
  }
  return { supported: false, name: null, value: null, tried };
}

/** Write the Comm Key using `name` (or the first spelling that accepts it). */
async function writeCommKeyOption(zk, key, { name = null } = {}) {
  const names = name ? [name] : COMM_KEY_OPTION_NAMES;
  const tried = [];
  for (const candidate of names) {
    try {
      await writeOption(zk, candidate, key);
      return { ok: true, name: candidate, tried };
    } catch (err) {
      tried.push({ name: candidate, error: err.message });
    }
  }
  const last = tried.length ? tried[tried.length - 1].error : 'no reply';
  throw new ZKDeviceError(`Could not write the Comm Key to the terminal (${last})`);
}

module.exports = {
  CMD,
  ACK,
  describeAck,
  replyCode,
  replyPayload,
  makeCommKey,
  normalizeCommKey,
  openSession,
  transportOf,
  readOption,
  writeOption,
  readCommKeyOption,
  writeCommKeyOption,
  COMM_KEY_OPTION_NAMES,
};
