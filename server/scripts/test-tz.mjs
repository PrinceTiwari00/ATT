#!/usr/bin/env node
/**
 * Run the whole server suite once per timezone.
 *
 * Date bugs hide in whichever zone the developer happens to be in, so the
 * suite must be green in all of these. Sets TZ itself, so it works the same
 * on Windows (where `TZ=... npm test` is not valid shell syntax).
 *
 *   npm run test:tz
 */
import { spawnSync } from 'node:child_process';

const ZONES = ['UTC', 'Asia/Kathmandu', 'America/Los_Angeles'];

let failed = [];
for (const tz of ZONES) {
  console.log(`\n=== test in TZ=${tz} ===`);
  const res = spawnSync(process.execPath, ['--test', 'test/*.test.js'], {
    stdio: 'inherit',
    env: { ...process.env, TZ: tz },
  });
  if (res.status !== 0) failed.push(tz);
}

if (failed.length) {
  console.error(`\nFAILED in: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\nAll zones passed: ${ZONES.join(', ')}`);
