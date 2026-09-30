/**
 * Unit tests for the attendance status algorithm (spec § C) — run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateDay, humanizeMinutes } = require('../src/utils/attendanceLogic');

const SHIFT = { start_time: '08:00', end_time: '15:30', grace_period_minutes: 10 };
const D = '2026-09-29';
const at = (t) => `${D}T${t}:00`;

test('absent when no punches', () => {
  const r = evaluateDay({ punches: [], shift: SHIFT, workDate: D });
  assert.equal(r.status, 'absent');
  assert.equal(r.checkIn, null);
});

test('on-time: inside grace, out after end', () => {
  const r = evaluateDay({ punches: [at('08:10'), at('15:35')], shift: SHIFT, workDate: D });
  assert.equal(r.status, 'on_time');
  assert.equal(r.lateMinutes, 0);
  assert.equal(r.earlyMinutes, 0);
  assert.equal(r.workMinutes, 445);
});

test('early arrival is on-time', () => {
  const r = evaluateDay({ punches: [at('07:50'), at('16:00')], shift: SHIFT, workDate: D });
  assert.equal(r.status, 'on_time');
});

test('exactly at grace boundary is on-time (inclusive)', () => {
  const r = evaluateDay({ punches: [at('08:10'), at('15:30')], shift: SHIFT, workDate: D });
  assert.equal(r.status, 'on_time');
  assert.equal(r.lateMinutes, 0);
});

test('late by minutes from shift start once past grace', () => {
  const r = evaluateDay({ punches: [at('08:25'), at('16:00')], shift: SHIFT, workDate: D });
  assert.equal(r.status, 'late');
  assert.equal(r.lateMinutes, 25); // 08:25 vs 08:00
  assert.equal(r.earlyMinutes, 0);
});

test('early departure counts minutes before shift end', () => {
  const r = evaluateDay({ punches: [at('07:55'), at('15:05')], shift: SHIFT, workDate: D });
  assert.equal(r.status, 'early');
  assert.equal(r.earlyMinutes, 25); // 15:30 - 15:05
});

test('late AND early → late_early with both metrics', () => {
  const r = evaluateDay({ punches: [at('08:30'), at('14:45')], shift: SHIFT, workDate: D });
  assert.equal(r.status, 'late_early');
  assert.equal(r.lateMinutes, 30);
  assert.equal(r.earlyMinutes, 45);
});

test('first punch = check-in, last punch = check-out (stray mid punches ignored)', () => {
  const r = evaluateDay({
    punches: [at('08:05'), at('12:30'), at('13:10'), at('15:40')],
    shift: SHIFT,
    workDate: D,
  });
  assert.equal(r.checkIn, at('08:05'));
  assert.equal(r.checkOut, at('15:40'));
  assert.equal(r.punchCount, 4);
  assert.equal(r.status, 'on_time');
});

test('single punch → check-in only, no early-departure verdict', () => {
  const r = evaluateDay({ punches: [at('08:12')], shift: SHIFT, workDate: D });
  assert.equal(r.status, 'late');
  assert.equal(r.checkOut, null);
  assert.equal(r.earlyMinutes, 0);
});

test('unsorted punches are normalized', () => {
  const r = evaluateDay({ punches: [at('15:40'), at('08:00')], shift: SHIFT, workDate: D });
  assert.equal(r.checkIn, at('08:00'));
  assert.equal(r.checkOut, at('15:40'));
});

test('no-shift teacher is never penalised', () => {
  const r = evaluateDay({ punches: [at('11:00'), at('12:00')], shift: null, workDate: D });
  assert.equal(r.status, 'on_time');
  assert.equal(r.lateMinutes, 0);
});

test('overnight shift: out next morning is not early', () => {
  const night = { start_time: '22:00', end_time: '06:00', grace_period_minutes: 10 };
  const r = evaluateDay({
    punches: [at('22:05'), `2026-09-30T06:05:00`],
    shift: night,
    workDate: D,
  });
  assert.equal(r.status, 'on_time');
  assert.equal(r.earlyMinutes, 0);
});

test('humanizeMinutes', () => {
  assert.equal(humanizeMinutes(25), '25m');
  assert.equal(humanizeMinutes(75), '1h 15m');
  assert.equal(humanizeMinutes(120), '2h');
  assert.equal(humanizeMinutes(0), '0m');
});
