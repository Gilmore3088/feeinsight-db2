import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db1LiveFees, db1PracticeKey, db1Price, db1Unit, type Db1KeyFee } from './db1.ts';
import { validateKey } from '../deming/key-file.ts';

test('DB1 frequencies map to DB2 units', () => {
  assert.equal(db1Unit('monthly'), 'per_month');
  assert.equal(db1Unit('per_transaction'), 'per_item');
  assert.equal(db1Unit(null), 'other');
  assert.equal(db1Unit('per_half_hour'), 'other');
});

test('a DB1 price of zero is free', () => {
  assert.deepEqual(db1Price('fixed', 0), { priceKind: 'free', amountUsd: null });
  assert.deepEqual(db1Price('varies', 5), { priceKind: 'varies', amountUsd: null });
  assert.deepEqual(db1Price('fixed', 30), { priceKind: 'flat', amountUsd: 30 });
});

test('the practice key keeps only what a person confirmed, and is valid', () => {
  const insts = [
    { akid: 1, inst: 100, status: 'confirmed', url: 'u', hash: null, name: 'A', charter: 'bank' as const, confirmed_at: '2026-10-01', prefilled_at: null },
    { akid: 2, inst: 200, status: 'prefilled', url: 'u', hash: null, name: 'B', charter: 'bank' as const, confirmed_at: null, prefilled_at: null },
  ];
  const fees: Db1KeyFee[] = [
    [1, 100, 'confirmed', 'confirmed', 'nsf_fee', 30, 'fixed', 'per_item', null, 'NSF fee $30.00', false],
    [2, 100, 'confirmed', 'prefilled', 'wire_out', 25, 'fixed', null, null, 'Wire $25.00', false],
    [3, 200, 'prefilled', 'prefilled', 'nsf_fee', 30, 'fixed', null, null, 'NSF $30.00', false],
  ];
  const { key } = db1PracticeKey(insts, fees);
  assert.equal(key.kind, 'dev');
  assert.equal(key.lines.length, 1);
  assert.equal(key.lines[0].feeName, 'nsf fee');
  assert.deepEqual(validateKey(key), []);
});

test('DB1 live fees become reader fees with the name standing in for the quote', () => {
  const [f] = db1LiveFees([[7, 'Stop Payment', 30, 'per_item', 'consumer', null, 'stop_payment']]);
  assert.deepEqual(f, { institutionId: 7, feeName: 'Stop Payment', quote: 'Stop Payment', priceKind: 'flat', amountUsd: 30, amountMaxUsd: null, ratePct: null, unit: 'per_item', product: null, audience: 'consumer' });
});
