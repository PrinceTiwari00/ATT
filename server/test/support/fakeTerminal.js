/**
 * A fake ZKTeco terminal on a real TCP socket, shared by the device tests.
 *
 * It implements the device side of the protocol — the 0x50 0x50 0x82 0x7d
 * framing, the CMD_CONNECT -> CMD_ACK_UNAUTH -> CMD_AUTH handshake, option
 * reads/writes and the attendance dump — so the stack above it runs for real.
 * Options: commKey, users, records, options, logDelayMs (slow log downloads).
 */
const net = require('node:net');
const { CMD, ACK, makeCommKey } = require('../../src/zk/commKey');

/* ── the fake terminal ───────────────────────────────────────────────────── */

const PREFIX = Buffer.from([0x50, 0x50, 0x82, 0x7d, 0x00, 0x00, 0x00, 0x00]);

/** ZKTeco record time encoding (the inverse of node-zklib's parseTimeToDate). */
function encodeTime(d) {
  const days = ((d.getFullYear() - 2000) * 12 + d.getMonth()) * 31 + (d.getDate() - 1);
  const hours = days * 24 + d.getHours();
  const minutes = hours * 60 + d.getMinutes();
  return minutes * 60 + d.getSeconds();
}

/** One 40-byte attendance record, exactly what decodeRecordData40 expects. */
function record({ userSn, userId, at }) {
  const buf = Buffer.alloc(40);
  buf.writeUIntLE(userSn, 0, 2);
  buf.write(String(userId).padEnd(9, '\0').slice(0, 9), 2, 9, 'ascii');
  buf.writeUInt32LE(encodeTime(at), 27);
  return buf;
}

function send(socket, command, sessionId, replyId, payload = Buffer.alloc(0)) {
  if (socket.destroyed) return; // the client gave up on this socket; nothing to answer
  const inner = Buffer.alloc(8 + payload.length);
  inner.writeUInt16LE(command, 0);
  inner.writeUInt16LE(0, 2); // checksum — node-zklib never verifies it
  inner.writeUInt16LE(sessionId, 4);
  inner.writeUInt16LE(replyId, 6);
  payload.copy(inner, 8);
  const prefix = Buffer.from(PREFIX);
  prefix.writeUInt16LE(inner.length, 4);
  socket.write(Buffer.concat([prefix, inner]));
}

/**
 * @param {{commKey?:number, users?:Array, records?:Array, options?:object}} opts
 */
function startFakeTerminal({ commKey = 0, users = [], records = [], options = {}, logDelayMs = 0 } = {}) {
  const state = {
    logDelayMs,
    commKey,
    options: { COMKey: String(commKey), '~DeviceName': 'ZKTeco K14 (fake)', '~SerialNumber': 'FAKE0001', ...options },
    connections: 0,
    concurrent: 0,
    maxConcurrent: 0,
    authAttempts: 0,
    authFailures: 0,
    unauthenticatedCommands: 0,
    commands: [],
    writes: [],
  };

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    state.connections++;
    state.concurrent++;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
    if (state.concurrent > 1) state.overlaps = (state.overlaps || 0) + 1;

    const session = { id: 0, authed: state.commKey === 0 };
    let buffer = Buffer.alloc(0);
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      state.concurrent--;
    };
    socket.on('close', finish);
    socket.on('error', () => { finish(); socket.destroy(); });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 8) return;
        const innerLength = buffer.readUInt16LE(4);
        if (buffer.length < 8 + innerLength) return;
        const packet = buffer.subarray(8, 8 + innerLength);
        buffer = buffer.subarray(8 + innerLength);
        handle(packet);
      }
    });

    function handle(packet) {
      const command = packet.readUInt16LE(0);
      const replyId = packet.readUInt16LE(6);
      const payload = packet.subarray(8);
      state.commands.push(command);
      const sid = () => session.id;

      if (command === CMD.CONNECT) {
        // A real terminal hands out a fresh session id per connection.
        session.id = (40000 + state.connections) & 0xffff;
        session.authed = state.commKey === 0;
        send(socket, session.authed ? ACK.OK : ACK.UNAUTH, session.id, replyId);
        return;
      }

      if (command === CMD.AUTH) {
        state.authAttempts++;
        const expected = makeCommKey(state.commKey, session.id);
        if (Buffer.compare(Buffer.from(payload.subarray(0, 4)), expected) === 0) {
          session.authed = true;
          send(socket, ACK.OK, sid(), replyId);
        } else {
          state.authFailures++;
          send(socket, ACK.UNAUTH, sid(), replyId);
        }
        return;
      }

      // Everything else needs an authenticated session — exactly like firmware.
      if (!session.authed) {
        state.unauthenticatedCommands++;
        send(socket, ACK.UNAUTH, sid(), replyId);
        return;
      }

      switch (command) {
        case CMD.OPTIONS_RRQ: {
          const name = payload.toString('ascii').replace(/\0+$/g, '');
          const value = state.options[name];
          if (value === undefined) return send(socket, ACK.ERROR, sid(), replyId);
          return send(socket, ACK.OK, sid(), replyId, Buffer.from(`${name}=${value}\0`, 'ascii'));
        }
        case CMD.OPTIONS_WRQ: {
          const text = payload.toString('ascii').replace(/\0+$/g, '');
          const eq = text.indexOf('=');
          const name = text.slice(0, eq);
          const value = text.slice(eq + 1);
          state.writes.push(text);
          if (name !== 'COMKey') return send(socket, ACK.ERROR, sid(), replyId);
          state.commKey = Number(value) || 0;
          state.options.COMKey = String(state.commKey);
          // The session that changed the key stays authenticated (real devices
          // keep it); only NEW connections must prove the new key.
          return send(socket, ACK.OK, sid(), replyId);
        }
        case CMD.GET_FREE_SIZES: {
          const body = Buffer.alloc(96);
          body.writeUIntLE(users.length, 16, 4); // → userCounts
          body.writeUIntLE(records.length, 32, 4); // → logCounts
          body.writeUIntLE(10000, 64, 4); // → logCapacity
          return send(socket, ACK.OK, sid(), replyId, body);
        }
        case 1503 /* CMD_DATA_WRRQ — attendance / user dump */: {
          // REQUEST_DATA.GET_USERS = [0x01, 0x09, …], GET_ATTENDANCE_LOGS = [0x01, 0x0d, …]
          const wantUsers = payload.length > 1 && payload[1] === 0x09;
          const body = wantUsers ? encodeUsers(users) : encodeRecords(records);
          // A large attendance memory takes a while to stream: model that.
          if (!wantUsers && state.logDelayMs > 0) {
            return setTimeout(() => send(socket, CMD_DATA, sid(), replyId, body), state.logDelayMs);
          }
          return send(socket, CMD_DATA, sid(), replyId, body);
        }
        case CMD.EXIT:
          // Firmware releases the management slot as soon as it processes the
          // exit, before the socket finishes closing — model that, otherwise a
          // perfectly serialised client looks like an overlap on the server.
          finish();
          send(socket, ACK.OK, sid(), replyId);
          return setTimeout(() => socket.end(), 5);
        default:
          return send(socket, ACK.OK, sid(), replyId);
      }
    }
  });

  const CMD_DATA = 1501;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        state,
        port: server.address().port,
        // Destroy any socket a client leaked, or server.close() would wait
        // for it forever (and take the test suite with it).
        close: () =>
          new Promise((r) => {
            for (const s of sockets) { try { s.destroy(); } catch (_) {} }
            sockets.clear();
            server.close(() => r());
          }),
      });
    });
  });
}

/** 4-byte header + 72-byte user records (decodeUserData72). */
function encodeUsers(users) {
  const head = Buffer.alloc(4);
  head.writeUIntLE(users.length, 0, 4);
  const body = Buffer.concat(
    users.map((u, i) => {
      const b = Buffer.alloc(72);
      b.writeUIntLE(i + 1, 0, 2); // uid
      b.writeUIntLE(0, 2, 1); // role
      b.write(String(u.name || '').padEnd(8, '\0').slice(0, 8), 11, 8, 'ascii');
      b.writeUIntLE(0, 35, 4); // cardno
      b.write(String(u.userId).padEnd(9, '\0').slice(0, 9), 48, 9, 'ascii');
      return b;
    })
  );
  return Buffer.concat([head, body]);
}

/** 4-byte header + 40-byte attendance records (decodeRecordData40). */
function encodeRecords(records) {
  const head = Buffer.alloc(4);
  head.writeUIntLE(records.length, 0, 4);
  return Buffer.concat([head, ...records.map((r) => record(r))]);
}

module.exports = { startFakeTerminal, encodeRecords, encodeUsers, PREFIX, record };
