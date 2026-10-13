import assert from "node:assert/strict";
import vm from "node:vm";
import { installHandoffRenderBudget } from "./lib/handoff-render-budget.mjs";

// Inject exactly as CDP does: no imported dependencies inside the browser code.
let source = installHandoffRenderBudget.toString();
const mutation = process.argv.find(value => value.startsWith("--mutation="))?.slice(11);
if (mutation) {
  const replacements = {
    "budget-from-start": ["allowedAt = endedAt + idleMs;", "allowedAt = startedAt + idleMs;"],
    "timestamp": ["entry.callback.call(root, timestamp);", "entry.callback.call(root, now());"],
  };
  assert.ok(replacements[mutation], "Unknown regression mutation");
  const [before, after] = replacements[mutation];
  assert.ok(source.includes(before), "Mutation must match the production function");
  source = source.replace(before, after);
  console.log(`Regression mutation applied: ${before} -> ${after}`);
}

function fixture(idleMs = 750) {
  let time = 0, nextRaf = 0, nextTimer = 0;
  const frames = new Map(), timers = new Map(), nativeCancels = [];
  const originalRequest = callback => { const id = ++nextRaf; frames.set(id, callback); return id; };
  const originalCancel = id => { nativeCancels.push(id); frames.delete(id); };
  const context = vm.createContext({ performance: { now: () => time },
    requestAnimationFrame: originalRequest, cancelAnimationFrame: originalCancel,
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id) });
  const budget = vm.runInContext(`(${source})(${idleMs})`, context);
  const advance = ms => {
    const end = time + ms;
    while (true) {
      const first = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      const [id, timer] = first;
      time = Math.max(time, timer.at); timers.delete(id); timer.callback();
    }
    time = Math.max(time, end);
  };
  const fire = timestamp => {
    const batch = [...frames.keys()];
    for (const id of batch) {
      const callback = frames.get(id);
      if (!callback) continue;
      frames.delete(id); callback(timestamp ?? time);
    }
  };
  return { context, budget, advance, fire, spend: ms => { time += ms; }, now: () => time,
    frames, timers, nativeCancels, originalRequest, originalCancel,
    earlyTimer: () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); } };
}
let passed = 0, failed = 0;
function check(name, work) {
  try { work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}: ${error.message}`); }
}
check("an expensive callback leaves a full idle interval after it finishes", () => {
  const f = fixture(), calls = [];
  const loop = timestamp => { calls.push({ at: f.now(), timestamp }); if (calls.length === 1) {
    f.context.requestAnimationFrame(loop); f.spend(10000);
  } };
  f.context.requestAnimationFrame(loop);
  f.advance(750); f.fire(750);
  assert.equal(f.now(), 10750);
  assert.equal(f.frames.size, 0, "Scheduling from callback start must not consume the post-draw idle interval");
  f.advance(749); f.fire(); assert.equal(calls.length, 1);
  f.advance(1); f.fire(11500); assert.equal(calls.length, 2);
  assert.equal(calls[1].at - (calls[0].at + 10000), 750);
  assert.equal(f.budget.samples[0].idleGapMs, null);
  assert.equal(f.budget.samples[1].idleGapMs, 750);
});
check("queued callbacks are fair when a recurring loop requests another frame", () => {
  const f = fixture(), order = [];
  const a = () => { order.push("A"); if (order.length === 1) f.context.requestAnimationFrame(a); f.spend(10); };
  f.context.requestAnimationFrame(a);
  f.context.requestAnimationFrame(() => order.push("B"));
  f.context.requestAnimationFrame(() => order.push("C"));
  for (let i = 0; i < 4; i++) { f.advance(750); f.fire(); }
  assert.deepEqual(order, ["A", "B", "C", "A"]);
});
check("cancel before the idle timer prevents the callback and clears unused work", () => {
  const f = fixture(); let calls = 0;
  const id = f.context.requestAnimationFrame(() => calls++);
  assert.ok(id < 0);
  f.context.cancelAnimationFrame(id);
  assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0);
  f.advance(2000); f.fire(); assert.equal(calls, 0);
});
check("cancel after the timer but before native RAF prevents execution", () => {
  const f = fixture(); let calls = 0;
  const id = f.context.requestAnimationFrame(() => calls++);
  f.advance(750); assert.equal(f.frames.size, 1);
  f.context.cancelAnimationFrame(id);
  assert.equal(f.frames.size, 0); f.fire(); assert.equal(calls, 0);
});
check("cancelling one queued request preserves the other callback", () => {
  const f = fixture(), calls = [];
  const first = f.context.requestAnimationFrame(() => calls.push("cancelled"));
  f.context.requestAnimationFrame(() => calls.push("retained"));
  f.context.cancelAnimationFrame(first);
  f.advance(750); f.fire(); assert.deepEqual(calls, ["retained"]);
});
check("positive IDs created before installation still reach native cancellation", () => {
  const f = fixture(); let calls = 0;
  const nativeId = f.originalRequest(() => calls++);
  f.context.cancelAnimationFrame(nativeId);
  assert.ok(f.nativeCancels.includes(nativeId)); f.fire(); assert.equal(calls, 0);
});
check("native RAF timestamps are forwarded without replacing or scaling them", () => {
  const f = fixture(); let received;
  f.context.requestAnimationFrame(timestamp => { received = timestamp; });
  f.advance(900); f.fire(897.125);
  assert.equal(received, 897.125);
  assert.equal(f.budget.samples[0].timestamp, 897.125);
  assert.equal(f.budget.samples[0].startedAt, 900);
});
check("an early timer rechecks the idle deadline instead of submitting RAF", () => {
  const f = fixture(); let calls = 0;
  f.context.requestAnimationFrame(() => calls++);
  f.advance(700); f.earlyTimer();
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 1);
  f.advance(49); f.fire(); assert.equal(calls, 0);
  f.advance(1); f.fire(); assert.equal(calls, 1);
});
check("restore drains pending callbacks on native RAF with their original IDs cancellable", () => {
  const f = fixture(), calls = [];
  const cancelled = f.context.requestAnimationFrame(() => calls.push("cancelled"));
  f.context.requestAnimationFrame(timestamp => calls.push(timestamp));
  f.budget.restore();
  assert.equal(f.context.requestAnimationFrame, f.originalRequest);
  assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 2);
  f.context.cancelAnimationFrame(cancelled);
  f.fire(42.25); assert.deepEqual(calls, [42.25]);
  assert.equal(f.context.cancelAnimationFrame, f.originalCancel);
});
check("restore from a callback drains older requests without losing recursive native requests", () => {
  const f = fixture(), order = [];
  f.context.requestAnimationFrame(() => {
    order.push("A"); f.budget.restore(); f.context.requestAnimationFrame(() => order.push("native"));
  });
  f.context.requestAnimationFrame(() => order.push("B"));
  f.advance(750); f.fire(); assert.deepEqual(order, ["A"]);
  f.fire(); assert.deepEqual(order, ["A", "B", "native"]);
  assert.equal(f.context.cancelAnimationFrame, f.originalCancel);
});
check("restore reschedules an admitted native frame once and can be called repeatedly", () => {
  const f = fixture(); let calls = 0;
  f.context.requestAnimationFrame(() => calls++); f.advance(750);
  const oldFrame = [...f.frames.keys()][0];
  f.budget.restore(); f.budget.restore();
  assert.ok(f.nativeCancels.includes(oldFrame)); assert.equal(f.frames.size, 1);
  f.fire(); assert.equal(calls, 1); assert.equal(f.frames.size, 0);
  assert.equal(f.context.requestAnimationFrame, f.originalRequest);
  assert.equal(f.context.cancelAnimationFrame, f.originalCancel);
});
check("cancelling the final synthetic ID after restore releases the cancellation wrapper", () => {
  const f = fixture(); let calls = 0;
  const id = f.context.requestAnimationFrame(() => calls++); f.budget.restore();
  f.context.cancelAnimationFrame(id); f.fire();
  assert.equal(calls, 0); assert.equal(f.frames.size, 0);
  assert.equal(f.context.cancelAnimationFrame, f.originalCancel);
});
check("new positive requests remain cancellable while restoration is draining", () => {
  const f = fixture(); let calls = 0;
  f.context.requestAnimationFrame(() => calls++); f.budget.restore();
  const id = f.context.requestAnimationFrame(() => { calls += 100; });
  assert.ok(id > 0); f.context.cancelAnimationFrame(id); f.fire(); assert.equal(calls, 1);
});
check("throwing callbacks preserve the next request and its post-callback idle budget", () => {
  const f = fixture(); let retained = false;
  f.context.requestAnimationFrame(() => { f.spend(200); throw new Error("fixture error"); });
  f.context.requestAnimationFrame(() => { retained = true; });
  f.advance(750); assert.throws(() => f.fire(), /fixture error/);
  assert.equal(f.frames.size, 0); f.advance(749); f.fire(); assert.equal(retained, false);
  f.advance(1); f.fire(); assert.equal(retained, true);
});
console.log(`${passed}/${passed + failed} handoff render-budget checks passed.`);
if (failed) process.exitCode = 1;
