import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { MusicRevealGate } from "../src/music-reveal.ts";
import { MusicEngineHandoff } from "../src/music-engine.ts";
import { DocumentDecryption } from "../src/document-decryption.ts";
import { decryptionFrame, DECRYPTION_END } from "../src/decryption.ts";

let passed = 0;
const check = async (name, work) => { await work(); console.log(`PASS ${name}`); passed++; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const clear = decryptionFrame(DECRYPTION_END);
const root = () => ({ dataset: {}, querySelectorAll: () => [] });

await check("loading holds text indefinitely, including reduced motion", () => {
  const doc = new DocumentDecryption(), node = root(); doc.reset(node, false);
  for (const now of [0, 1, 60, 3600]) doc.update(now, clear, true, true);
  assert.equal(doc.complete, false); assert.equal(node.dataset.revealHeld, "true");
});
await check("ready starts a fresh reveal clock instead of consuming loading time", () => {
  const doc = new DocumentDecryption(); doc.reset(root(), false);
  doc.update(100, clear, false, true); doc.update(200, clear, false);
  assert.equal(doc.complete, false); doc.update(200.94, clear, false);
  assert.equal(doc.complete, false); doc.update(200.96, clear, false);
  assert.equal(doc.complete, true);
});
await check("only the completed reveal frame claims playback, exactly once", () => {
  const gate = new MusicRevealGate(), id = gate.begin("a");
  assert.equal(gate.completeFrame(true, 1), null);
  gate.prepared(id); assert.equal(gate.completeFrame(false, 2), null);
  assert.equal(gate.completeFrame(true, 3), id);
  assert.equal(gate.completeFrame(true, 4), null);
  gate.started(id, true); assert.deepEqual(gate.state(), {id:"a", phase:"playing", error:"", startFrame:3});
});
await check("back/stop invalidate late readiness and late play resolution", () => {
  const gate = new MusicRevealGate(), id = gate.begin("a"); gate.cancel();
  assert.equal(gate.prepared(id), false); gate.started(id, true);
  assert.equal(gate.state().phase, "idle"); assert.equal(gate.completeFrame(true, 1), null);
});
await check("new selection ignores old errors and readiness", () => {
  const gate = new MusicRevealGate(), a = gate.begin("a"), b = gate.begin("b");
  gate.fail(a, "obsolete"); assert.equal(gate.prepared(a), false);
  assert.equal(gate.holding, true); assert.equal(gate.prepared(b), true);
});
await check("failed start restores black masks and retry gets a new request", () => {
  const gate = new MusicRevealGate(), a = gate.begin("a"), doc = new DocumentDecryption();
  doc.reset(root(), true); gate.prepared(a); gate.completeFrame(true, 1); gate.started(a, false);
  doc.update(3, clear, true, gate.holding); assert.equal(doc.complete, false);
  assert.equal(gate.state().phase, "error"); const b = gate.begin("a");
  assert.notEqual(a, b); assert.equal(gate.state().error, ""); assert.equal(gate.prepared(b), true);
});
function handoffFixture() {
  let engine = "browser", stopping = null; const events = [], errors = [];
  const handoff = new MusicEngineHandoff({current:()=>engine,
    cancelPending:()=>events.push("cancel"), changed:()=>{}, error:e=>errors.push(e.message),
    stop:async old=> {events.push(`stop:${old}`); if(stopping) await stopping.promise;},
    apply:async next=> {events.push(`apply:${next}`); engine=next;}});
  return {handoff, events, errors, engine:()=>engine, block:()=>stopping=deferred()};
}
await check("engine changes only after the previous output acknowledges stop", async () => {
  const f = handoffFixture(), gate = f.block(), work=f.handoff.switchTo("vlc"); await settle();
  assert.equal(f.engine(), "browser"); assert.equal(f.handoff.busy, true);
  gate.resolve(); assert.equal(await work, true); assert.equal(f.engine(), "vlc");
  assert.deepEqual(f.events, ["cancel","stop:browser","apply:vlc"]);
});
await check("latest choice cancels an in-flight handoff back to the current engine", async () => {
  const f=handoffFixture(), gate=f.block(), first=f.handoff.switchTo("vlc"); await settle();
  const second=f.handoff.switchTo("browser"); gate.resolve();
  assert.equal(await first,false); assert.equal(await second,true);
  assert.equal(f.engine(),"browser"); assert.equal(f.events.some(x=>x.startsWith("apply")),false);
  assert.equal(f.handoff.busy,false);
});
await check("failed stop keeps the existing engine and releases the control lock", async () => {
  let changed=false; const failures=[];
  const f=new MusicEngineHandoff({current:()=>"vlc",cancelPending(){},changed(){},
    stop:async()=>{throw Error("offline");},apply:async()=>{changed=true;},error:e=>failures.push(e.message)});
  assert.equal(await f.switchTo("browser"),false); assert.equal(changed,false);
  assert.deepEqual(failures,["offline"]); assert.equal(f.busy,false);
});
await check("an old clear action cannot erase the newly selected engine's library", async () => {
  const main=readFileSync(new URL("../src/main.ts",import.meta.url),"utf8");
  const source=main.slice(main.indexOf("async function runMusicSetting("),main.indexOf("const reviewEntry ="));
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  for (const boundary of ["cancel", "stop"]) {
    const gate=deferred(), prefs={musicEngine:"vlc"}, engineHandoff={busy:false}; let cleared=0;
    const args={prefs,engineHandoff,cancelMusicArchive:()=>boundary==="cancel"?gate.promise:Promise.resolve(),
      musicPanel:{cancelPending(){},refreshLibrary(){}}, musicLibrary:{clear:async()=>cleared++},
      musicBridge:{connected:true,stop:()=>gate.promise}, musicPlayer:{stop(){}},
      refreshMusicSettings(){},onLibraryMayHaveChanged(){},notify(){},audio:{play(){}}};
    const run=Function(...Object.keys(args),`${js}; return runMusicSetting;`)(...Object.values(args));
    const work=run("clear"); await settle(); prefs.musicEngine="browser";
    gate.resolve({state:"stopped"}); await work; assert.equal(cleared,0,boundary);
  }
});
console.log(`${passed}/${passed} music reveal / engine checks passed.`);
