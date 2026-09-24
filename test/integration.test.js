'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./helpers/load-app');

const { SyslogLens } = loadApp();
const { parse } = SyslogLens;

const LOG_PATH = path.join(__dirname, '..', 'test-data', 'network-incidents.log');
const EXPECTED_PATH = path.join(__dirname, '..', 'test-data', 'expected-incidents.json');

const logText = fs.readFileSync(LOG_PATH, 'utf8');
const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));

// Extract the eid="Exxx" test-only identifier from a raw log line, mirroring
// HANDOFF.md's note that eid exists only for test verification and must not
// be used by the app's own grouping logic.
function eidOf(rawLine) {
  const m = rawLine.match(/eid="([^"]+)"/);
  if (!m) throw new Error(`no eid found in line: ${rawLine}`);
  return m[1];
}

// Group all incidents (across every severity bucket) by their unique set of
// event ids, so each real incident is counted once even though parse()
// files it under every severity it spans.
function distinctIncidents(parsed) {
  const seen = new Map();
  parsed.by.forEach(bucket => {
    bucket.forEach(inc => {
      const ids = inc.ev.map(e => eidOf(e.raw)).sort();
      const key = ids.join(',');
      if (!seen.has(key)) seen.set(key, { incident: inc, eventIds: ids });
    });
  });
  return [...seen.values()];
}

test('network-incidents.log parses with no unparseable lines and the expected total event count', () => {
  const { ev, bad } = parse(logText);
  assert.equal(bad.length, expected._meta.expected_unparsed_lines);
  assert.equal(ev.length, expected._meta.total_events);
});

test('severity totals across all events match expected-incidents.json', () => {
  const { ev } = parse(logText);
  const totals = [0, 0, 0, 0, 0, 0, 0, 0];
  ev.forEach(e => totals[e.sev]++);
  const expectedTotals = expected.severity_totals;
  for (let sev = 0; sev <= 7; sev++) {
    assert.equal(totals[sev], expectedTotals[String(sev)], `severity ${sev} count`);
  }
});

test('the expected number of distinct incidents are grouped, each with the exact expected event ids and severities', () => {
  const parsed = parse(logText);
  const found = distinctIncidents(parsed);

  for (const exp of expected.incidents) {
    const match = found.find(f => f.eventIds.join(',') === [...exp.event_ids].sort().join(','));
    assert.ok(match, `expected incident ${exp.id} (${exp.title}) with event ids [${exp.event_ids.join(', ')}] was not found as its own group`);

    const actualSevs = [...match.incident.sevs].sort((a, b) => a - b);
    assert.deepEqual(actualSevs, exp.severity_levels, `${exp.id}: severity levels`);

    for (const [sev, ids] of Object.entries(exp.events_by_severity)) {
      // Array.from(...) normalizes away the jsdom-realm Array produced by
      // chaining .filter/.map/.sort on inc.ev (a cross-realm array would
      // otherwise fail deepEqual's prototype check even with equal contents).
      const actualIdsAtSev = Array.from(
        match.incident.ev.filter(e => e.sev === Number(sev)).map(e => eidOf(e.raw))
      ).sort();
      assert.deepEqual(actualIdsAtSev, [...ids].sort(), `${exp.id}: event ids at severity ${sev}`);
    }
  }
});

test('exactly 8 incidents are found, matching expected_incident_count (no unexpected merges or splits)', () => {
  const parsed = parse(logText);
  const found = distinctIncidents(parsed);
  // Only count groups with more than one event as "incidents" the way the
  // background/noise events are all singletons; the 8 expected incidents in
  // expected-incidents.json are exactly the multi-event, non-background groups.
  const expectedGroupKeys = new Set(expected.incidents.map(i => [...i.event_ids].sort().join(',')));
  const backgroundIds = new Set(expected.background.event_ids);

  const matchingExpected = found.filter(f => expectedGroupKeys.has(f.eventIds.join(',')));
  assert.equal(matchingExpected.length, expected.expected_incident_count);

  // None of the background/noise event ids should have been folded into one
  // of the 8 expected incident groups.
  for (const f of found) {
    if (expectedGroupKeys.has(f.eventIds.join(','))) {
      for (const id of f.eventIds) {
        assert.ok(!backgroundIds.has(id), `background event ${id} was unexpectedly grouped into incident ${f.eventIds.join(',')}`);
      }
    }
  }
});

test('deliberate look-alikes stay in separate incidents (must_not_merge pairs)', () => {
  const parsed = parse(logText);
  const found = distinctIncidents(parsed);
  const byIncidentId = new Map(expected.incidents.map(i => [i.id, [...i.event_ids].sort().join(',')]));

  // For each pair that must not merge, find the parsed group containing the
  // FIRST event id of incident A, and assert it does not also contain the
  // first event id of incident B (i.e. they were not merged into one group).
  for (const pair of expected.must_not_merge) {
    const idsA = expected.incidents.find(i => i.id === pair.a).event_ids;
    const idsB = expected.incidents.find(i => i.id === pair.b).event_ids;
    const groupOf = eid => found.find(f => f.eventIds.includes(eid));
    const groupA = groupOf(idsA[0]);
    const groupB = groupOf(idsB[0]);
    assert.ok(groupA, `no group found containing ${idsA[0]} (${pair.a})`);
    assert.ok(groupB, `no group found containing ${idsB[0]} (${pair.b})`);
    assert.notEqual(
      groupA.eventIds.join(','),
      groupB.eventIds.join(','),
      `${pair.a} and ${pair.b} were merged into one incident, but must stay separate: ${pair.reason}`
    );
  }
});
