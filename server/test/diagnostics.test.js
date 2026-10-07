/**
 * Network diagnostics: subnet math, host enumeration and TCP probing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const diag = require('../src/net/diagnostics');

test('cidr math: parse, mask conversion and enumeration', () => {
  const parsed = diag.parseCidr('192.168.1.77/24');
  assert.equal(parsed.network, '192.168.1.0');
  assert.equal(parsed.broadcast, '192.168.1.255');
  assert.equal(parsed.mask, '255.255.255.0');

  const odd = diag.parseCidr('10.10.5.9/255.255.254.0');
  assert.equal(odd.prefix, 23);
  assert.equal(odd.network, '10.10.4.0');

  assert.equal(diag.netmaskToPrefix('255.255.255.0'), 24);
  assert.equal(diag.netmaskToPrefix('255.255.254.0'), 23);
  assert.equal(diag.netmaskToPrefix('255.0.255.0'), null); // holey mask is invalid
  assert.equal(diag.prefixToNetmask(24), '255.255.255.0');

  const hosts = diag.enumerateHosts('192.168.1.0/30');
  assert.deepEqual(hosts, ['192.168.1.1', '192.168.1.2']); // network+broadcast excluded

  // a /24 sweep must never exceed 254 candidates
  assert.equal(diag.enumerateHosts('192.168.7.0/24').length, 254);
  // and anything bigger is capped hard
  assert.ok(diag.enumerateHosts('10.0.0.0/16').length <= diag.MAX_SCAN_HOSTS);

  assert.equal(diag.parseCidr('banana'), null);
  assert.equal(diag.parseCidr('1.2.3.4/99'), null);
});

test('sameSubnet answers the question the wizard shows', () => {
  assert.equal(diag.sameSubnet('192.168.1.23', '192.168.1.110', 24), true);
  assert.equal(diag.sameSubnet('192.168.1.23', '192.168.2.110', 24), false);
  assert.equal(diag.sameSubnet('10.10.5.9', '10.10.4.200', '255.255.254.0'), true);
  assert.equal(diag.sameSubnet('10.10.5.9', '10.11.4.200', '255.255.254.0'), false);
});

test('tcpProbe classifies open, refused and unreachable targets', async () => {
  // open
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const open = await diag.tcpProbe('127.0.0.1', port, 1500);
  assert.equal(open.ok, true);
  assert.ok(open.ms >= 0);

  // refused (nothing listening on that port)
  server.close();
  await new Promise((resolve) => server.once('close', resolve));
  const refused = await diag.tcpProbe('127.0.0.1', port, 1500);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'ECONNREFUSED');
  assert.ok(refused.hints.length > 0, 'a refusal must ship an actionable hint');

  // unroutable address → timeout-ish classification
  const dead = await diag.tcpProbe('10.255.255.1', 4370, 400);
  assert.equal(dead.ok, false);
  assert.notEqual(dead.code, undefined);
});

test('discovery finds a fake terminal on the loopback range', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  let identified = 0;
  const result = await diag.discoverDevices({
    cidrs: ['127.0.0.1/30'],
    port,
    timeoutMs: 500,
    concurrency: 4,
    identify: true,
    identifyFn: async (ip) => {
      identified++;
      return { ok: true, device: { productName: 'FakeK14', serialNumber: 'SN1' } };
    },
  });
  server.close();

  assert.equal(result.scanned, 2);
  assert.ok(result.found >= 1, 'the listening socket must be discovered');
  const hit = result.devices.find((d) => d.ip === '127.0.0.1');
  assert.ok(hit, 'found our listener');
  assert.equal(hit.zk.device.productName, 'FakeK14');
  assert.ok(identified >= 1);
});

test('diagnose() produces an ordered checklist with verdict and hints', async () => {
  const report = await diag.diagnose({ ip: '10.255.255.1', port: 4370, ping: false, timeoutMs: 500 });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.steps.map((s) => s.id),
    ['local-network', 'subnet', 'tcp', 'handshake']
  );
  const tcpStep = report.steps.find((s) => s.id === 'tcp');
  assert.equal(tcpStep.status, 'fail');
  assert.ok(tcpStep.hints.length > 0);
  const handshakeStep = report.steps.find((s) => s.id === 'handshake');
  assert.equal(handshakeStep.status, 'skipped');
  assert.ok(report.verdict.length > 0);
});
