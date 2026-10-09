// node test.js — checks recurrence expansion against the cases that usually go wrong
const assert = require('assert');
const { expand } = require('./server');

const TZ = `BEGIN:VTIMEZONE
TZID:America/Vancouver
BEGIN:DAYLIGHT
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
DTSTART:20070311T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
DTSTART:20071104T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;
const wrap = body => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\n${TZ}\n${body}\nEND:VCALENDAR`;

// 1. weekly class keeps 9:00 local across the Nov 1 clock change, honours EXDATE, flagged as a class
let r = expand(wrap(`BEGIN:VEVENT
UID:a
DTSTART;TZID=America/Vancouver:20260901T090000
DTEND;TZID=America/Vancouver:20260901T103000
RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261210T000000Z
EXDATE;TZID=America/Vancouver:20261029T090000
SUMMARY:CPSC 221
LOCATION:DMP 110
END:VEVENT`), '2026-10-26', '2026-11-06').timed;
assert.deepStrictEqual(Object.keys(r), ['2026-10-27', '2026-11-03', '2026-11-05']);
assert.deepStrictEqual(r['2026-11-03'][0], { start: '09:00', end: '10:30', title: 'CPSC 221', where: 'DMP 110', ubc: true });

// 2. one-off in UTC (Z) is converted to Vancouver wall-clock; not a class
r = expand(wrap(`BEGIN:VEVENT
UID:b
DTSTART:20261110T023000Z
DTEND:20261110T040000Z
SUMMARY:Movie night
END:VEVENT`), '2026-11-09', '2026-11-10').timed;
assert.strictEqual(r['2026-11-09'][0].start, '18:30');          // 02:30Z = 18:30 PST the day before
assert.strictEqual(r['2026-11-09'][0].ubc, undefined);

// 3. a moved instance shows at its new time and the original slot is gone
r = expand(wrap(`BEGIN:VEVENT
UID:c
DTSTART;TZID=America/Vancouver:20260914T130000
DTEND;TZID=America/Vancouver:20260914T140000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4
SUMMARY:Shift
END:VEVENT
BEGIN:VEVENT
UID:c
RECURRENCE-ID;TZID=America/Vancouver:20260921T130000
DTSTART;TZID=America/Vancouver:20260921T150000
DTEND;TZID=America/Vancouver:20260921T160000
SUMMARY:Shift
END:VEVENT`), '2026-09-14', '2026-10-05').timed;
assert.deepStrictEqual(Object.keys(r).map(k => k + ' ' + r[k][0].start), ['2026-09-14 13:00', '2026-09-21 15:00', '2026-09-28 13:00', '2026-10-05 13:00']);

// 4. all-day events come back as plain dates; events crossing midnight are split
r = expand(wrap(`BEGIN:VEVENT
UID:d
DTSTART;VALUE=DATE:20260930
DTEND;VALUE=DATE:20261001
SUMMARY:Truth and Reconciliation Day
END:VEVENT
BEGIN:VEVENT
UID:e
DTSTART;TZID=America/Vancouver:20261003T220000
DTEND;TZID=America/Vancouver:20261004T020000
SUMMARY:Party
END:VEVENT`), '2026-09-29', '2026-10-05');
assert.deepStrictEqual(r.allDay, [{ date: '2026-09-30', name: 'Truth and Reconciliation Day' }]);
assert.deepStrictEqual([r.timed['2026-10-03'][0].end, r.timed['2026-10-04'][0].start, r.timed['2026-10-04'][0].end], ['24:00', '00:00', '02:00']);

console.log('all expansion tests passed (server tz: ' + Intl.DateTimeFormat().resolvedOptions().timeZone + ')');

// ---- hand-entered events ----
const { validateEvent, manualByDay, hashPassword, checkPassword } = require('./server');
const ok = b => validateEvent(b).ev, bad = b => validateEvent(b).error;
assert.deepStrictEqual(ok({ title: ' Gym ', start: '15:30', end: '17:00', days: [2, 2, 1], junk: 1 }), { title: 'Gym', where: '', start: '15:30', end: '17:00', days: [1, 2] });
assert.ok(ok({ title: 'Late', start: '20:00', end: '24:00', days: [5] }));
assert.ok(bad({ title: 'x', start: '10:00', end: '09:00', days: [1] }));       // ends before it starts
assert.ok(bad({ title: 'x', start: '09:00', end: '10:00' }));                  // no day and no date
assert.ok(bad({ title: 'x', start: '09:00', end: '10:00', date: '2026-02-31' }));   // Date() would silently roll this into March
assert.ok(bad({ title: 'x'.repeat(61), start: '09:00', end: '10:00', days: [1] }));
const week = manualByDay([{ title: 'A', start: '09:00', end: '10:00', days: [2] }, { title: 'B', start: '11:00', end: '12:00', date: '2026-09-30', ubc: true }], '2026-09-29', '2026-10-06');
assert.deepStrictEqual(Object.keys(week), ['2026-09-29', '2026-09-30', '2026-10-06']);   // Tuesdays + the one-off
assert.strictEqual(week['2026-09-30'][0].ubc, true);

// ---- multi-day events ----
const trip = validateEvent({ title: 'Trip', start: '18:00', end: '12:00', date: '2026-10-09', endDate: '2026-10-11' });
assert.ok(trip.ev && trip.ev.endDate === '2026-10-11', 'end time may be earlier than start when the dates differ');
assert.ok(bad({ title: 'Trip', start: '09:00', end: '10:00', date: '2026-10-09', endDate: '2026-10-08' }), 'end date before start date is rejected');
assert.ok(bad({ title: 'Trip', start: '09:00', end: '10:00', date: '2026-10-09', endDate: '2026-02-31' }), 'impossible end date is rejected');
assert.ok(bad({ title: 'Trip', start: '10:00', end: '09:00', date: '2026-10-09' }), 'single day still needs end after start');
assert.strictEqual(validateEvent({ title: 'X', start: '09:00', end: '10:00', date: '2026-10-09', endDate: '2026-10-09' }).ev.endDate, undefined, 'same end date is a one-day event');
const span = manualByDay([trip.ev], '2026-10-08', '2026-10-12');
assert.deepStrictEqual(Object.keys(span), ['2026-10-09', '2026-10-10', '2026-10-11']);
assert.deepStrictEqual([span['2026-10-09'][0].start, span['2026-10-09'][0].end], ['18:00', '24:00']);
assert.deepStrictEqual([span['2026-10-10'][0].start, span['2026-10-10'][0].end], ['00:00', '24:00']);
assert.deepStrictEqual([span['2026-10-11'][0].start, span['2026-10-11'][0].end], ['00:00', '12:00']);

// ---- passwords ----
const h = hashPassword('shared-pass');
assert.ok(checkPassword('shared-pass', h) && !checkPassword('Shared-pass', h) && !checkPassword('x', undefined));
assert.notStrictEqual(h, hashPassword('shared-pass'));   // salted
console.log('event + password tests passed');

// ---- house settings ----
const { validateHouse } = require('./server');
let hv = validateHouse({ notices: [{ text: 'Free BBQ', tag: 'food', date: '2026-10-01', from: '16:00', to: '19:00', ahead: 2, extra: 'x' }, { text: 'Oat milk' }],
  chores: [{ text: 'Garbage out', days: [3, 3] }], closures: [{ date: '2026-11-09', name: 'Reading break', ubc: 1 }] }).house;
assert.deepStrictEqual([hv.notices[0].tag, hv.notices[0].ahead, hv.notices[1].tag, hv.chores[0].days, hv.closures[0].ubc], ['FOOD', 2, 'INFO', [3], true]);
assert.ok(hv.notices[0].id && !('extra' in hv.notices[0]));
for (const b of [{ notices: [{ text: '' }] }, { notices: [{ text: 'x', tag: 'toolongtag' }] }, { notices: [{ text: 'x', date: '2026-13-01' }] },
  { notices: [{ text: 'x', date: '2026-10-01', from: '16:00' }] }, { notices: [{ text: 'x', date: '2026-10-01', from: '19:00', to: '16:00' }] },
  { chores: [{ text: 'x', days: [] }] }, { closures: [{ date: '2026-02-30', name: 'x' }] }, { closures: [{ date: '2026-02-01', name: '' }] }])
  assert.ok(validateHouse(b).error, JSON.stringify(b));
console.log('house tests passed');
