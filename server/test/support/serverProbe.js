/**
 * Child process used by terminalSurvives.test.js. It behaves like the ATT server
 * does with the device: one slow log download that times out, while a user
 * action is queued on the same terminal, and then the process must keep running.
 * Any stray rejection that takes the process down will show up as a non-zero exit.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ATT_HOME = process.env.ATT_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'att-probe-'));
process.env.ZK_MODE = 'real';

const { RealZKDevice } = require('../../src/zk/realDevice');
const { DeviceLock } = require('../../src/zk/deviceLock');

const port = Number(process.env.FAKE_TERMINAL_PORT);
const lock = new DeviceLock({ name: 'probe', gapMs: 0, staleMs: 20_000 });
const make = (extra) =>
  new RealZKDevice({ ip: '127.0.0.1', port, inPort: 0, commKey: 0, deviceLock: lock, ...extra });

(async () => {
  const download = make({ timeoutMs: 300 });
  const userAction = make({ timeoutMs: 4000, lockWaitMs: 8000 });

  const [dump, users] = await Promise.allSettled([download.getAttendance(), userAction.getUsers()]);
  // Give any stray asynchronous failure a chance to happen before we report.
  await new Promise((r) => setTimeout(r, 500));

  const dumpResult = dump.status === 'rejected' ? `failed (${dump.reason.message})` : 'ok';
  const usersResult = users.status === 'fulfilled' ? 'ok' : `failed (${users.reason.message})`;
  console.log(`PROBE_DONE download=${dumpResult} userAction=${usersResult}`);
})();
