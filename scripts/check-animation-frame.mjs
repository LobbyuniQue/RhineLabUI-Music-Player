import assert from "node:assert/strict";
import vm from "node:vm";
import { RenderState } from "../src/render-state.ts";
import { MusicRevealGate } from "../src/music-reveal.ts";
import { DocumentDecryption } from "../src/document-decryption.ts";
import { decryptionFrame, DECRYPTION_END } from "../src/decryption.ts";
import { observeAnimationFrame } from "./lib/observe-animation-frame.mjs";

let passed = 0;
const check = async (name, work) => { await work(); console.log(`PASS ${name}`); passed++; };

function scheduler(requestError) {
  const pending = [];
  const context = vm.createContext({ requestAnimationFrame(callback) {
    if (requestError) throw requestError;
    pending.push(callback);
    return pending.length;
  } });
  const observe = vm.runInContext(`(${observeAnimationFrame.toString()})`, context);
  return { observe, pending, frame(time) {
    const batch = pending.splice(0);
    for (const callback of batch) callback(time);
  } };
}

await check("a real RAF observes reduced loading even when the real RenderState reuses its draw", async () => {
  const clock = scheduler(), renderState = new RenderState(), gate = new MusicRevealGate();
  const doc = new DocumentDecryption(), root = { dataset: {}, querySelectorAll: () => [] };
  gate.begin("selected", "immediate"); doc.reset(root, true);
  let renderedFrames = 23, reusedFrames = 0, appFrames = 0;
  const draw = () => {
    renderState.begin(); renderState.add("detail", "selected"); renderState.floats(1, 0);
    if (renderState.end()) renderedFrames++;
    else reusedFrames++;
  };
  draw();
  const baselineFrames = renderedFrames;
  // Match main.frame's ordering: scene.update may reuse the draw, then document
  // state still updates. The observer samples after that genuine RAF callback.
  clock.pending.push(time => {
    appFrames++; draw();
    doc.update(time / 1000, decryptionFrame(DECRYPTION_END), true, gate.holding);
  });
  let settled = false;
  const observation = clock.observe(() => ({ frames: renderedFrames, reusedFrames,
    access: gate.state(), complete: doc.complete, held: root.dataset.revealHeld, appFrames }));
  observation.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  clock.frame(1234.5);
  const { frameTime, snapshot } = await observation;
  assert.equal(frameTime, 1234.5); assert.equal(snapshot.appFrames, 1);
  assert.equal(snapshot.frames, baselineFrames); assert.equal(snapshot.reusedFrames, 1);
  assert.equal(snapshot.access.phase, "loading"); assert.equal(snapshot.access.strategy, "immediate");
  assert.equal(snapshot.access.startFrame, null); assert.equal(snapshot.complete, true);
  assert.equal(snapshot.held, "false"); assert.equal(gate.blocking, false);
});

await check("the snapshot is read only inside the callback, with the native timestamp", async () => {
  const clock = scheduler(); let reads = 0, value = "before";
  const pending = clock.observe(() => { reads++; return { value }; });
  assert.equal(reads, 0); value = "after"; clock.frame(987.125);
  const result = await pending;
  assert.equal(reads, 1); assert.equal(result.snapshot.value, "after"); assert.equal(result.frameTime, 987.125);
  assert.equal(clock.pending.length, 0);
});

await check("primitive snapshots also resolve without requiring scene counters", async () => {
  const clock = scheduler(), pending = clock.observe(() => "clear");
  clock.frame(16); assert.equal((await pending).snapshot, "clear");
});

await check("snapshot errors reject instead of hanging the evaluation", async () => {
  const clock = scheduler(), expected = new Error("snapshot failed");
  const pending = clock.observe(() => { throw expected; });
  clock.frame(16); await assert.rejects(pending, error => error === expected);
});

await check("scheduler errors reject without inventing a frame observation", async () => {
  const expected = new Error("RAF unavailable"), clock = scheduler(expected);
  await assert.rejects(clock.observe(() => "clear"), error => error === expected);
  assert.equal(clock.pending.length, 0);
});

await check("a missing snapshot reader fails before scheduling", () => {
  const clock = scheduler(); assert.throws(() => clock.observe(null), /readSnapshot must be a function/);
  assert.equal(clock.pending.length, 0);
});

console.log(`Animation frame observation: ${passed}/${passed} passed`);
