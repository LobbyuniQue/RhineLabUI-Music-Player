import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { MusicRevealGate, musicAccessStrategy } from "../src/music-reveal.ts";
import { MusicEngineHandoff } from "../src/music-engine.ts";
import { DocumentDecryption } from "../src/document-decryption.ts";
import { decryptionFrame, DECRYPTION_END } from "../src/decryption.ts";

let passed = 0;
const check = async (name, work) => { await work(); console.log(`PASS ${name}`); passed++; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const clear = decryptionFrame(DECRYPTION_END);
const root = () => ({ dataset: {}, querySelectorAll: () => [] });

await check("an explicit loading hold overrides document animation shortcuts", () => {
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
  gate.started(id, true); assert.deepEqual(gate.state(), {id:"a", phase:"playing", error:"", startFrame:3, strategy:"reveal"});
});
await check("playback waits for either enabled reveal effect, otherwise starts immediately", () => {
  for (const modelDecryption of [false, true]) for (const documentReveal of [false, true]) {
    assert.equal(musicAccessStrategy({ modelDecryption, documentReveal }),
      modelDecryption || documentReveal ? "reveal" : "immediate");
  }
});
await check("reduced playback stays unmasked while loading and starts without a reveal frame", () => {
  const gate = new MusicRevealGate(), id = gate.begin("a", "immediate");
  assert.equal(gate.holding, false); assert.equal(gate.blocking, false);
  assert.equal(gate.pending, true); assert.equal(gate.completeFrame(true, 1), null);
  assert.equal(gate.prepared(id), true); assert.equal(gate.state().phase, "starting");
  assert.equal(gate.completeFrame(true, 2), null); assert.equal(gate.state().startFrame, null);
  gate.started(id, true); assert.equal(gate.state().phase, "playing");
});
await check("reduced errors leave text clear and a cancelled request cannot start", () => {
  const gate = new MusicRevealGate(), id = gate.begin("a", "immediate");
  gate.fail(id, "unavailable"); assert.equal(gate.state().phase, "error");
  assert.equal(gate.holding, false); assert.equal(gate.blocking, false);
  const retry = gate.begin("a", "immediate"); gate.cancel();
  assert.equal(gate.prepared(retry), false); gate.started(retry, true);
  assert.equal(gate.state().phase, "idle");
});
await check("reducing motion during loading releases the hold before readiness", () => {
  const gate = new MusicRevealGate(), id = gate.begin("a");
  assert.equal(gate.blocking, true); assert.equal(gate.useImmediatePlayback(), null);
  assert.equal(gate.state().strategy, "immediate"); assert.equal(gate.holding, false);
  assert.equal(gate.state().phase, "loading"); assert.equal(gate.prepared(id), true);
  assert.equal(gate.state().phase, "starting"); assert.equal(gate.state().startFrame, null);
});
await check("reducing motion after preparation claims one immediate start", () => {
  const gate = new MusicRevealGate(), id = gate.begin("a"); gate.prepared(id);
  assert.equal(gate.useImmediatePlayback(), id); assert.equal(gate.useImmediatePlayback(), null);
  assert.equal(gate.completeFrame(true, 1), null); assert.equal(gate.state().startFrame, null);
  gate.started(id, true); assert.equal(gate.state().phase, "playing");
});
await check("reducing motion on an error releases masks without retrying or reviving old work", () => {
  const gate = new MusicRevealGate(), id = gate.begin("a"); gate.fail(id, "unavailable");
  assert.equal(gate.holding, true); assert.equal(gate.useImmediatePlayback(), null);
  assert.equal(gate.holding, false); assert.equal(gate.state().phase, "error");
  assert.equal(gate.state().error, "unavailable"); assert.equal(gate.prepared(id), false);
  gate.cancel(); assert.equal(gate.useImmediatePlayback(), null);
});
await check("live animation synchronization clears the document and starts prepared music only once", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const source = main.slice(main.indexOf("function syncMusicArchiveMotion("), main.indexOf("function openFile("));
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const ready of [false, true]) {
    const gate = new MusicRevealGate(), id = gate.begin("a"), clears = [], starts = [], held = [];
    if (ready) gate.prepared(id);
    const prefs = { motion: { modelDecryption: false, documentReveal: false } }, node = root();
    const args = { prefs, musicAccessStrategy, musicReveal: gate, mode: "detail",
      scene: { setDecryptionHeld: value => held.push(value) },
      documentDecryption: { reset: (target, clear) => clears.push({ target, clear }) },
      $: () => node, syncMusicAccess() {}, startMusicArchive: request => starts.push(request) };
    const sync = Function(...Object.keys(args), `${js}; return syncMusicArchiveMotion;`)(...Object.values(args));
    sync(); sync();
    assert.equal(gate.holding, false); assert.ok(held.every(value => value === false));
    assert.ok(clears.every(value => value.target === node && value.clear === true));
    assert.equal(clears.length, 2); assert.deepEqual(starts, ready ? [id] : []);
    prefs.motion = { modelDecryption: true, documentReveal: true }; sync();
    assert.equal(gate.state().strategy, "immediate"); assert.equal(clears.length, 2);
    assert.deepEqual(starts, ready ? [id] : []);
  }
});
function archivePlaybackFixture(engine, full = false) {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const source = main.slice(main.indexOf("function failMusicReveal("), main.indexOf("function openFile("));
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const gate = new MusicRevealGate(), preparations = [], starts = [], stops = [], resets = [];
  const prefs = { musicEngine: engine, motion: { modelDecryption: full, documentReveal: full } };
  const doc = { complete: false, reset: (target, clear) => { doc.complete = clear; resets.push({ target, clear }); } };
  const scene = { decryptionFrame: { phase: "joining" }, setDecryptionHeld() {} };
  let preparedId = null;
  const transport = name => ({
    connected: true, error: "", queueTracks() {}, isPlaying: () => false, state: () => ({ error: "" }),
    prepare: track => {
      const id = typeof track === "string" ? track : track.id, ready = deferred();
      preparations.push({ engine: name, id, ready });
      return ready.promise.then(ok => { if (ok) preparedId = id; return ok; });
    },
    startPrepared: () => {
      starts.push({ engine: name, id: preparedId, access: gate.state(),
        documentComplete: doc.complete, scenePhase: scene.decryptionFrame.phase });
      return Promise.resolve(true);
    },
    stop: () => { stops.push(name); preparedId = null; return Promise.resolve(); },
  });
  const args = { prefs, musicAccessStrategy, musicReveal: gate, scene, mode: "detail", modal: null, viewer: null,
    musicPlayer: transport("browser"), musicBridge: transport("vlc"), bridgeStatus: null,
    musicLibrary: { tracks: [{ id: "a" }, { id: "b" }] }, musicPlayerTrack: track => track,
    audio: { setLocalMusicActive() {} }, syncMusicAccess() {}, syncSystemMedia() {},
    documentDecryption: doc, $: () => root(),
    requestAnimationFrame: () => { throw Error("immediate playback must not request an animation frame"); } };
  const api = Function(...Object.keys(args), `let musicRevealRequest=0, musicRevealEngine="browser";
    ${js}; return { prepareMusicArchive, cancelMusicArchive, syncMusicArchiveMotion, finishMusicRevealFrame };`)(...Object.values(args));
  return { ...api, gate, prefs, doc, scene, preparations, starts, stops, resets };
}
await check("the real browser and VLC coordinator starts on readiness without any reveal frame", async () => {
  for (const engine of ["browser", "vlc"]) {
    const f = archivePlaybackFixture(engine); f.prepareMusicArchive({ id: "a" }); await settle();
    assert.deepEqual(f.preparations.map(p => [p.engine, p.id]), [[engine, "a"]]);
    assert.equal(f.gate.state().phase, "loading"); assert.equal(f.gate.holding, false); assert.equal(f.starts.length, 0);
    f.preparations[0].ready.resolve(true); await settle();
    assert.equal(f.starts.length, 1); assert.equal(f.starts[0].engine, engine); assert.equal(f.starts[0].id, "a");
    assert.equal(f.starts[0].access.phase, "starting"); assert.equal(f.starts[0].access.startFrame, null);
    assert.equal(f.starts[0].documentComplete, false); assert.equal(f.starts[0].scenePhase, "joining");
    assert.equal(f.gate.state().phase, "playing");
    f.syncMusicArchiveMotion(); f.syncMusicArchiveMotion(); await settle(); assert.equal(f.starts.length, 1);
  }
});
await check("the real coordinator releases a full request when motion reduces before or after readiness", async () => {
  for (const engine of ["browser", "vlc"]) for (const ready of [false, true]) {
    const f = archivePlaybackFixture(engine, true); f.prepareMusicArchive({ id: "a" }); await settle();
    assert.equal(f.gate.holding, true);
    if (ready) { f.preparations[0].ready.resolve(true); await settle(); assert.equal(f.gate.state().phase, "revealing"); }
    assert.equal(f.starts.length, 0);
    f.prefs.motion = { modelDecryption: false, documentReveal: false }; f.syncMusicArchiveMotion();
    assert.equal(f.gate.holding, false); assert.equal(f.doc.complete, true);
    if (!ready) { assert.equal(f.starts.length, 0); f.preparations[0].ready.resolve(true); }
    await settle(); assert.equal(f.starts.length, 1); assert.equal(f.starts[0].engine, engine);
    assert.equal(f.starts[0].access.startFrame, null); assert.equal(f.starts[0].scenePhase, "joining");
    f.syncMusicArchiveMotion(); await settle(); assert.equal(f.starts.length, 1);
  }
});
await check("the real reduced coordinator cancels both transports before delayed readiness can start", async () => {
  for (const engine of ["browser", "vlc"]) {
    const f = archivePlaybackFixture(engine); f.prepareMusicArchive({ id: "a" }); await settle();
    await f.cancelMusicArchive(); f.preparations[0].ready.resolve(true); await settle();
    assert.deepEqual(f.stops, [engine]); assert.equal(f.starts.length, 0); assert.equal(f.gate.state().phase, "idle");
  }
});
await check("the real reduced coordinator ignores old readiness after a rapid new selection", async () => {
  for (const engine of ["browser", "vlc"]) {
    const f = archivePlaybackFixture(engine); f.prepareMusicArchive({ id: "a" }); await settle();
    f.prepareMusicArchive({ id: "b" }); await settle();
    assert.deepEqual(f.preparations.map(p => p.id), ["a", "b"]);
    f.preparations[0].ready.resolve(true); await settle();
    assert.equal(f.starts.length, 0); assert.equal(f.gate.state().id, "b"); assert.equal(f.gate.state().phase, "loading");
    f.preparations[1].ready.resolve(true); await settle();
    assert.equal(f.starts.length, 1); assert.equal(f.starts[0].engine, engine); assert.equal(f.starts[0].id, "b");
    assert.equal(f.gate.state().phase, "playing"); assert.equal(f.gate.state().startFrame, null);
  }
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
