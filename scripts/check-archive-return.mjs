import assert from "node:assert/strict";
import { archiveReturned, CdpTimeoutError, waitForArchiveReturn } from "./lib/archive-return.mjs";

const returned = { mode: "archive", cameraDetail: 0, extraction: .4,
  returningFiles: 0, modal: false, motion: { preset: "full" } };
const moving = { ...returned, cameraDetail: .018, extraction: .439, returningFiles: 1 };
let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}: ${error.message}`); }
}
function clock() {
  let time = 0;
  return { now: () => time, advance: ms => { time += ms; }, sleep: async ms => { time += ms; } };
}
await check("requires all original coordinates, no modal and full motion", () => {
  assert.equal(archiveReturned(returned), true);
  for (const change of [{ mode: "detail" }, { cameraDetail: .01 }, { extraction: .42 },
    { returningFiles: 1 }, { modal: true }, { motion: { preset: "reduced" } }])
    assert.equal(archiveReturned({ ...returned, ...change }), false);
});
await check("a fresh settled read succeeds", async () => {
  const c = clock();
  const result = await waitForArchiveReturn({ ...c, read: async () => returned });
  assert.deepEqual(result, { state: returned, elapsedMs: 0, timeoutCount: 0 });
});
await check("one CDP timeout does not abort before the overall deadline", async () => {
  const c = clock(); let calls = 0;
  const result = await waitForArchiveReturn({ ...c, read: async timeout => {
    calls++;
    if (calls === 1) return moving;
    if (calls === 2) { c.advance(timeout); throw new CdpTimeoutError("Runtime.evaluate"); }
    return returned;
  }});
  assert.equal(calls, 3);
  assert.equal(result.state, returned);
  assert.equal(result.timeoutCount, 1);
  assert.ok(result.elapsedMs < 240000);
});
await check("persistent CDP timeouts exhaust the same budget", async () => {
  const c = clock(), budgets = [];
  await assert.rejects(waitForArchiveReturn({ ...c, budgetMs: 45, readBudgetMs: 20, pollMs: 1,
    read: async timeout => { budgets.push(timeout); c.advance(timeout); throw new CdpTimeoutError("Runtime.evaluate"); }
  }), error => {
    assert.equal(error.name, "ArchiveReturnTimeoutError");
    assert.equal(error.observation.elapsedMs, 45);
    assert.equal(error.observation.timeoutCount, 3);
    assert.equal(error.observation.state, null);
    return true;
  });
  assert.deepEqual(budgets, [20, 20, 3]);
});
await check("moving samples cannot pass when the deadline expires", async () => {
  const c = clock();
  await assert.rejects(waitForArchiveReturn({ ...c, budgetMs: 25, readBudgetMs: 20, pollMs: 10,
    read: async () => moving }), error => {
    assert.equal(error.name, "ArchiveReturnTimeoutError");
    assert.equal(error.observation.elapsedMs, 25);
    assert.equal(error.observation.state, moving);
    return true;
  });
});
await check("late settled response cannot pass after the deadline", async () => {
  const c = clock();
  await assert.rejects(waitForArchiveReturn({ ...c, budgetMs: 20, read: async () => {
    c.advance(21); return returned;
  }}), { name: "ArchiveReturnTimeoutError" });
});
await check("JavaScript and protocol failures are not retried", async () => {
  for (const failure of [new Error("Runtime.evaluate timed out"), new TypeError("bad stats"),
    new CdpTimeoutError("Page.navigate")]) {
    const c = clock(); let calls = 0;
    await assert.rejects(waitForArchiveReturn({ ...c, read: async () => { calls++; throw failure; } }),
      error => error === failure);
    assert.equal(calls, 1);
  }
});
await check("timeout diagnostics keep the last real sample", async () => {
  const c = clock(), progress = []; let calls = 0;
  await assert.rejects(waitForArchiveReturn({ ...c, budgetMs: 45, readBudgetMs: 20, pollMs: 1,
    onProgress: sample => progress.push(sample), read: async timeout => {
      if (++calls === 1) return moving;
      c.advance(timeout); throw new CdpTimeoutError("Runtime.evaluate");
    }
  }), error => {
    assert.equal(error.observation.state, moving);
    assert.equal(error.observation.timeoutCount, 3);
    return true;
  });
  assert.ok(progress.some(sample => sample.state === moving && sample.timeoutCount > 0));
});
console.log(`${passed}/${passed + failed} archive return checks passed.`);
process.exitCode = failed ? 1 : 0;
