/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  COMM KEY SERVICE — the terminal's connection password, changed safely
 * ─────────────────────────────────────────────────────────────────────────────
 *  Why a Comm Key matters here: a ZKTeco terminal serves ONE management
 *  session. With Comm Key = 0 anything on the LAN can take it — ZKTime, a
 *  second ATT install, a curious laptop — and whoever arrives second kills
 *  whoever was there first (ECONNRESET / "Another device is connecting to the
 *  device so the connection is interrupted"). A non-zero key makes every
 *  client that does not know it fail the handshake instead.
 *
 *  Changing it is the one device operation that can lock ATT out of its own
 *  terminal, so the sequence is deliberately paranoid — and all of it runs
 *  inside ONE device-lock session, so no poll can slip in halfway:
 *
 *    1. persist the new key in ATT's settings        (fails fast if the host's
 *                                                     environment owns it —
 *                                                     better now than after
 *                                                     the device changed)
 *    2. read the device's current key                (proves the firmware
 *                                                     exposes the option and
 *                                                     gives the spelling)
 *    3. write the new key to the terminal            (session is already
 *                                                     authenticated with the
 *                                                     OLD key)
 *    4. verify with a FRESH session using the NEW key
 *    5a. ok      → ATT switches over (manager.reconfigure)
 *    5b. failed  → write the OLD key back, restore settings, report
 *
 *  Every step is returned to the caller so the UI can show exactly what
 *  happened — and so a support log explains a lockout in one glance.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const config = require('../config');
const settings = require('../settings');
const { getManager, ZKManager } = require('../zk/manager');
const { normalizeCommKey } = require('../zk/commKey');
const { ZKDeviceError } = require('../zk/deviceContract');

/** Practical ceiling: ZKTeco keypads accept up to 6 digits. */
const MAX_COMM_KEY = 999999;

function assertKeyRange(key) {
  const value = normalizeCommKey(key);
  if (value > MAX_COMM_KEY) {
    throw new ZKDeviceError(
      `Comm Key ${value} is too large — the terminal keypad accepts 0..${MAX_COMM_KEY}. ` +
        'Use a short number you can also type on the device if you ever need to recover it.'
    );
  }
  return value;
}

/** Write the key into settings + live config. Returns what happened. */
function persistKey(key) {
  try {
    settings.saveSettings({ 'device.commKey': key });
    config.applySettings({ device: { commKey: key } });
    return { ok: true, key, file: config.paths.settingsFile };
  } catch (err) {
    return { ok: false, key, error: err.message };
  }
}

/**
 * Current Comm Key picture: what ATT is using, and (when the terminal answers)
 * what the device itself has. Never throws — a dead link is a normal answer.
 */
async function getState({ readDevice = true } = {}) {
  const manager = getManager();
  const state = manager.commKeyStatus();
  const out = {
    configured: state.configured,
    set: state.set,
    source: state.source,
    mode: state.mode,
    supportedByLibrary: state.editable,
    // false ⇒ an operator-owned ZK_COMM_KEY env var decides the key on this
    // host; the UI must not pretend it can save over it.
    savable: state.savable !== false,
    device: null,
  };
  if (!readDevice || !state.editable) return out;

  try {
    // One attempt only: this is a status read, not a sync — it must not sit in
    // the retry loop or feed the circuit breaker on a page load.
    out.device = await manager.call('readCommKey', (d, opts) => d.readCommKey(opts), {
      retries: 1,
      origin: 'comm-key-status',
    });
  } catch (err) {
    // Reading the key needs a session, and a session needs the right key — so a
    // mismatch shows up here as a failed read. Say that plainly, because
    // "cannot reach device" would send somebody crawling under a desk.
    const mismatch = /Comm Key/i.test(err.message || '');
    out.device = {
      ok: false,
      error: err.message,
      hint: err.hint || (mismatch
        ? 'ATT could not log in to read the key. That almost always means the terminal has a Comm Key ATT ' +
          'does not know: read it off the keypad (Menu → COMM → Comm Key) and save the same number here with ' +
          '"update ATT only".'
        : null),
      busy: Boolean(err.busy),
      keyMismatchLikely: mismatch,
    };
  }
  return out;
}

/**
 * Change the Comm Key. `writeToDevice:false` only updates what ATT uses (the
 * key was already typed on the device keypad).
 *
 * @param {{key:number|string, writeToDevice?:boolean, origin?:string}} opts
 */
async function changeCommKey({ key, writeToDevice = true, origin = 'ui' } = {}) {
  const manager = getManager();
  const nextKey = assertKeyRange(key);
  const previousKey = config.zk.commKey;
  const steps = [];

  if (writeToDevice && typeof manager.device.readCommKey !== 'function') {
    throw new ZKDeviceError(
      `The ${manager.mode} device link cannot change the Comm Key on the terminal. ` +
        'Set it on the keypad (Menu → COMM → Comm Key) and then save the same value here with ' +
        '"update ATT only".'
    );
  }

  // Held for the whole change: the terminal must never be polled between
  // "key written" and "key verified".
  return manager.withLock(`comm-key → ${nextKey}`, async (ticket) => {
    // 1. Persist first. If this host's environment owns ZK_COMM_KEY we would
    //    otherwise change the device and lose the key on the next restart.
    const persisted = persistKey(nextKey);
    steps.push({ step: 'persist', ...persisted });
    if (!persisted.ok) {
      throw Object.assign(
        new ZKDeviceError(
          `ATT cannot remember the new Comm Key on this host (${persisted.error}). ` +
            'Nothing was written to the terminal. Set ZK_COMM_KEY in the environment/.env to the key the ' +
            'device already uses, or run the installed app (which owns its settings file).'
        ),
        { steps }
      );
    }

    if (!writeToDevice) {
      manager.reconfigure('comm-key');
      steps.push({ step: 'apply', ok: true, note: 'ATT-only change; the terminal was not touched' });
      return { ok: true, key: nextKey, previousKey, writeToDevice: false, steps };
    }

    const device = manager.device; // still speaking the OLD key
    let optionName = null;

    try {
      // 2. What does the terminal have right now?
      const read = await device.readCommKey({ ticket });
      steps.push({ step: 'read-device', supported: read.supported, name: read.name, value: read.value });
      if (!read.supported) {
        throw new ZKDeviceError(
          'This firmware does not expose its Comm Key as a readable option over TCP, so ATT cannot change it ' +
            'remotely. Set it on the keypad — Menu → COMM → Comm Key — then save the same number here with ' +
            '"update ATT only". Nothing was written to the terminal.'
        );
      }
      optionName = read.name;

      // 3. Write the new key (this session authenticated with the old one).
      const wrote = await device.writeCommKey(nextKey, { name: optionName }, { ticket });
      steps.push({ step: 'write-device', ok: true, name: wrote.name });

      // 4. Prove it: a brand-new session must authenticate with the NEW key.
      const probe = ZKManager.buildDevice({ ...config.zk, commKey: nextKey }, manager.rosterProvider);
      const check = await probe.testConnection({ ticket });
      if (!check.ok) {
        steps.push({ step: 'verify', ok: false, error: check.error });
        // 5b. Put the terminal back the way we found it.
        let rollback;
        try {
          rollback = await probe.writeCommKey(previousKey, { name: optionName }, { ticket });
        } catch (err) {
          rollback = { ok: false, error: err.message };
        }
        steps.push({ step: 'rollback', to: previousKey, ...rollback });
        persistKey(previousKey);
        manager.reconfigure('comm-key-rollback');
        throw Object.assign(
          new ZKDeviceError(
            `The terminal accepted Comm Key ${nextKey} but ATT could not reconnect with it (${check.error}). ` +
              `The device was set back to ${previousKey} and ATT was restored — nothing changed.`
          ),
          { steps, rollback }
        );
      }
      steps.push({ step: 'verify', ok: true });

      // 5a. Live from now on.
      manager.reconfigure('comm-key');
      steps.push({ step: 'apply', ok: true });

      return {
        ok: true,
        key: nextKey,
        previousKey,
        writeToDevice: true,
        optionName,
        verified: true,
        steps,
        rebootRecommended: nextKey !== 0,
      };
    } catch (err) {
      // Any failure before the device was written leaves ATT on the new key in
      // settings while the terminal still has the old one → restore.
      const alreadyRolledBack = steps.some((s) => s.step === 'rollback');
      if (!alreadyRolledBack && config.zk.commKey !== previousKey) {
        persistKey(previousKey);
        manager.reconfigure('comm-key-restore');
        steps.push({ step: 'restore', to: previousKey });
      }
      throw Object.assign(err, { steps, key: nextKey, previousKey });
    }
  }, { origin });
}

module.exports = { getState, changeCommKey, assertKeyRange, persistKey, MAX_COMM_KEY };
