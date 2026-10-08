import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRebalance } from "../lib/discipline.mjs";
const current = { cash: 100, bonds: 200, equities: 600, gold: 100 },
  target = { cash: 200, bonds: 300, equities: 400, gold: 100 };
test("rebalance measures percentage-point deviation against all liquid assets", () => {
  const r = compareRebalance({ current, target, tolerancePct: 5 });
  assert.equal(r.triggered, true);
  assert.equal(r.rows.find((x) => x.asset === "equities").deviationPct, 20);
  assert.equal(
    r.rows.reduce((s, x) => s + x.difference, 0),
    0,
  );
});
test("new funds fill fixed target gaps once, excess remains cash", () => {
  const r = compareRebalance({ current, target, newCash: 250 });
  assert.equal(r.newCashUsed, 200);
  assert.equal(r.unallocatedCash, 50);
  assert.equal(r.rows.find((x) => x.asset === "equities").newCashAllocation, 0);
});
test("invalid target totals and invalid input cannot generate adjustments", () => {
  assert.throws(
    () => compareRebalance({ current, target: { ...target, cash: 201 } }),
    RangeError,
  );
  assert.throws(
    () => compareRebalance({ current, target, newCash: NaN }),
    TypeError,
  );
});
test("threshold equality and zero portfolio behave explicitly", () => {
  assert.equal(
    compareRebalance({ current, target, tolerancePct: 20 }).triggered,
    false,
  );
  const zero = { cash: 0, bonds: 0, equities: 0, gold: 0 };
  assert.equal(
    compareRebalance({ current: zero, target: zero, newCash: 12 })
      .unallocatedCash,
    12,
  );
});
test("aggregated cash target may exceed an individual asset input limit", () => {
  const huge = { cash: 1e10, bonds: 1e10, equities: 1e10, gold: 1e10 };
  const allocation = { cash: 4e10, bonds: 0, equities: 0, gold: 0 };
  const r = compareRebalance({ current: huge, target: allocation });
  assert.equal(r.rows.find((x) => x.asset === "cash").difference, 3e10);
});
