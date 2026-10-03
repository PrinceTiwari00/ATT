const test = require('node:test');
const assert = require('node:assert/strict');

// Exercise the broker in bridge mode without starting the API or a real agent.
process.env.ZK_MODE = 'bridge';
process.env.DEVICE_BRIDGE_TOKEN = 'unit-test-bridge-secret';

const {
  heartbeatAgent,
  getAgentStatus,
  requestDeviceCommand,
  claimNextCommand,
  completeDeviceCommand,
} = require('../src/services/deviceBridge');
const { ZKConnectionError } = require('../src/zk/deviceContract');

test('LAN bridge brokers cloud device commands and only accepts the claiming agent result', async () => {
  await assert.rejects(requestDeviceCommand('getUsers'), ZKConnectionError);
  assert.equal(getAgentStatus().online, false);

  heartbeatAgent('test-agent');
  assert.equal(getAgentStatus().online, true);

  const pending = requestDeviceCommand('getUsers');
  const command = claimNextCommand('test-agent');
  assert.equal(command.action, 'getUsers');
  assert.deepEqual(command.payload, {});

  assert.equal(
    completeDeviceCommand({
      agentId: 'different-agent',
      commandId: command.id,
      ok: true,
      result: [],
    }),
    false
  );

  const users = [{ userId: '101', name: 'Ayesha Khan' }];
  assert.equal(
    completeDeviceCommand({
      agentId: 'test-agent',
      commandId: command.id,
      ok: true,
      result: users,
    }),
    true
  );
  assert.deepEqual(await pending, users);
});

test('bridge device failures preserve retryability', async () => {
  heartbeatAgent('test-agent');
  const pending = requestDeviceCommand('testConnection');
  const command = claimNextCommand('test-agent');
  assert.equal(command.action, 'testConnection');

  assert.equal(
    completeDeviceCommand({
      agentId: 'test-agent',
      commandId: command.id,
      ok: false,
      error: 'TCP timeout',
      retryable: true,
    }),
    true
  );
  await assert.rejects(pending, (error) => error instanceof ZKConnectionError && /TCP timeout/.test(error.message));
});
