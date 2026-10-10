/**
 * A failed log download must not take the ATT server down, and must never put
 * two sessions on the terminal.
 *
 * node-zklib 1.3.0 throws an internal TypeError after a failed request, which
 * Node reports as an unhandled rejection (default: exit the process). The probe
 * runs in a child process so this is checked the way it happens in production;
 * the node:test runner itself would report that stray error as a test failure.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { startFakeTerminal } = require('./support/fakeTerminal');

test('a timed-out log download leaves the process running and never overlaps the next action', async () => {
  const fake = await startFakeTerminal({ commKey: 0, logDelayMs: 1500 });
  const probe = path.join(__dirname, 'support', 'serverProbe.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'att-survive-'));
  try {
    const child = spawn(process.execPath, [probe], {
      env: { ...process.env, FAKE_TERMINAL_PORT: String(fake.port), ATT_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const code = await new Promise((resolve) => {
      const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('exit', (c, signal) => {
        clearTimeout(killer);
        resolve(signal ? `signal ${signal}` : c);
      });
    });

    assert.equal(code, 0, `the server process died after a failed download:\n${stderr}`);
    assert.match(stdout, /PROBE_DONE download=failed \(.*\) userAction=ok/, stdout + stderr);
    assert.equal(fake.state.maxConcurrent, 1, 'two sessions were open on the terminal at once');
    assert.equal(fake.state.overlaps || 0, 0);
  } finally {
    await fake.close();
  }
});
