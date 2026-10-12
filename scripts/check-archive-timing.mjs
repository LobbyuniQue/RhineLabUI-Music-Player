import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as THREE from "three";
import * as motion from "../src/motion.ts";
import { fullMotion } from "../src/motion-preferences.ts";
import { RhythmMotion, rhythmDisplacement, quietBands } from "../src/archive-play-motion.ts";
import { DecryptionController } from "../src/decryption.ts";
import { ThemeWave } from "../src/theme-motion.ts";
import { MusicRevealGate } from "../src/music-reveal.ts";
import { DocumentDecryption } from "../src/document-decryption.ts";

// Execute the production update's motion phase rather than a second animation
// implementation. Only rendering, labels and pointer/visibility work are inert.
// An explicit source override permits isolated mutation checks without editing
// production code; the normal check always loads the real scene implementation.
const sceneText = readFileSync(process.env.RHINE_ARCHIVE_TIMING_SOURCE || new URL("../src/scene.ts", import.meta.url), "utf8");
const sceneAst = ts.createSourceFile("scene.ts", sceneText, ts.ScriptTarget.Latest, true);
const archiveClass = sceneAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ArchiveScene");
assert.ok(archiveClass, "ArchiveScene must exist");
const method = name => {
  const node = archiveClass.members.find(member => member.name?.getText(sceneAst) === name);
  assert.ok(node?.body, `ArchiveScene.${name} must have a body`);
  return node;
};
const update = method("update");
const cameraStart = update.body.statements.find(statement => ts.isVariableStatement(statement) &&
  statement.declarationList.declarations.some(declaration => declaration.name.getText(sceneAst) === "orbit"));
assert.ok(cameraStart, "Motion harness must stop before camera/rendering work");
const updateText = sceneText.slice(update.getStart(sceneAst), update.body.getStart(sceneAst) + 1) +
  sceneText.slice(update.body.getStart(sceneAst) + 1, cameraStart.getStart(sceneAst)) + "\n}";
const methodNames = ["setMode", "select", "resetFrameClock", "rowSpacing", "cellPosition", "modelClarity", "reduced"];
// Keep the boundary regression runnable before its production fix exists.
if (archiveClass.members.some(member => member.name?.getText(sceneAst) === "markMotionChange")) methodNames.push("markMotionChange");
const classText = `class MotionFixture { ${updateText}\n${methodNames.map(name => method(name).getText(sceneAst)).join("\n")} }`;
const loopText = readFileSync(new URL("../src/archive-loop.ts", import.meta.url), "utf8");
const loopAst = ts.createSourceFile("archive-loop.ts", loopText, ts.ScriptTarget.Latest, true);
const loopFunctions = ["sameCell", "cellKey", "selectionCell"].map(name => {
  const node = loopAst.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `Archive loop ${name} must exist`);
  return node.getText(loopAst).replace(/^export\s+/, "");
}).join("\n");
const fixtureDocument = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }) };
let inputClock = 100;
const deps = { THREE, ...motion, RhythmMotion, rhythmDisplacement, quietBands,
  COLUMN_SPACING: 5.2, ROW_SPACING: .62, document: fixtureDocument,
  performance: { now: () => inputClock * 1000 },
  themeEnvironment() {}, ease: value => motion.smooth(value),
  fileLocation: index => ({ lane: 2, row: 12 + index, slot: index }),
  fullMotion, reducedMotion: () => Object.fromEntries(Object.keys(fullMotion()).map(key => [key, false])) };
const js = ts.transpileModule(`${loopFunctions}\n${classText}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const MotionFixture = Function(...Object.keys(deps), `${js}\nreturn MotionFixture;`)(...Object.values(deps));

function fixture() {
  const f = new MotionFixture();
  Object.assign(f, {
    last: 100, clock: 100, motionChangedAt: 0, loaded: true, rowSpacingValue: .62, rowSpacingTarget: .62,
    motion: { ...fullMotion(), idleWave: false, selectionWave: false },
    presence: 1, presenceTarget: 1, renderer: { domElement: { style: {} } },
    theme: new ThemeWave(), scene: new THREE.Scene(), themeAmount: 0,
    reveal: 1, targetReveal: 1, rotation: .8, targetRotation: .8,
    targetDetail: 1, detail: 1, scanTime: 29.1, scanBlend: 0,
    looping: true, holdingArchive: false, archiveMomentum: null,
    hoverCell: null, hoverLifts: new Map(), selectedCell: { lane: 2, row: 12 }, selectedSlot: 0,
    shoulder: { value: 12, velocity: 0 }, laneFocus: { value: 2, velocity: 0 },
    columnCamera: { value: 0, velocity: 0 }, rail: { value: 0, velocity: 0 },
    lift: { value: motion.INSPECTION_LIFT, velocity: 0 }, returnY: null,
    dragTrack: null, pulses: [], pendingPulse: null, lastInteraction: 100,
    idleGain: 0, pulseGain: 0, playfield: { enabled: false, bands: quietBands(), strength: 1, flatten: 0 },
    rhythm: new RhythmMotion(), rhythmStyle: "legacy", flatMix: 0, subduedIndex: { value: 0 },
    selectedIndexOnly: false, relayLifts: new Map(), coordinateOrigin: { lane: 0, row: 0 },
    camera: new THREE.PerspectiveCamera(), model: new THREE.Group(), outgoing: [],
    decryption: new DecryptionController(), deferSelectionPulse: false,
    labelCanvas: {}, disposed: [],
    appearance: { prepare() {}, apply() {}, setClarity() {}, setTheme() {}, dispose(group) { f.disposed.push(group); } },
    cancelPointer() {}, setHover() {}, canBrowse: () => true, rebaseCoordinates() {},
    presentationDrop: () => 0, drawLabel() {}, emitPulse() {},
  });
  f.model.add(new THREE.Mesh());
  f.scene.add(f.model);
  f.update(100 + 1 / 60);
  // Ordinary test input happens at the most recent visual frame. Boundary
  // checks can explicitly place an input after a long render has completed.
  for (const name of ["select", "setMode"]) {
    const production = f[name].bind(f);
    f[name] = (...args) => {
      inputClock = f.inputTime ?? f.clock;
      return production(...args);
    };
  }
  return f;
}

function runReturn(interval, copies = false) {
  const f = fixture();
  if (copies) f.select(1, { cell: { lane: 2, row: 13 } });
  f.setMode("archive");
  const start = f.clock;
  const steps = Math.ceil(4.5 / interval);
  for (let frame = 1; frame <= steps; frame++) f.update(start + frame * interval);
  return { f, elapsed: steps * interval };
}

let passed = 0, failed = 0;
function check(name, work) {
  try { work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
for (const interval of [1 / 60, 1 / 10, 1 / 2, 1, 8]) {
  check(`selected archive returns within elapsed time at ${interval}s/frame`, () => {
    const { f, elapsed } = runReturn(interval);
    const state = JSON.stringify({ elapsed, rotation: f.rotation, returnY: f.returnY, lift: f.lift.value, detail: f.detail });
    assert.equal(f.rotation, 0, state);
    assert.equal(f.returnY, null, state);
    assert.ok(Math.abs(f.lift.value - .4) < .001 && f.detail < .01, state);
  });
  check(`returning copy is recycled within elapsed time at ${interval}s/frame`, () => {
    const { f, elapsed } = runReturn(interval, true);
    assert.equal(f.outgoing.length, 0, JSON.stringify({ elapsed, copies: f.outgoing.map(o => ({ rotation: o.group.rotation.y, lift: o.lift.value, returnY: o.returnY })) }));
    assert.equal(f.disposed.length, 1, "Recycle must dispose the independent copy exactly once");
  });
}
for (const copies of [false, true]) {
  check(`${copies ? "returning copy" : "selected archive"} holds height while aligning, then descends`, () => {
    const f = fixture();
    if (copies) f.select(1, { cell: { lane: 2, row: 13 } });
    f.setMode("archive");
    const object = copies ? f.outgoing[0].group : f.model;
    const height = object.position.y, start = f.clock;
    let aligned = false;
    for (let frame = 1; frame <= 90; frame++) {
      f.update(start + frame / 60);
      const angle = copies ? f.outgoing[0].group.rotation.y : f.rotation;
      if (angle !== 0) assert.ok(Math.abs(object.position.y - height) < 1e-9,
        "A card must not descend into its neighbors while still rotated");
      else { aligned = true; break; }
    }
    assert.ok(aligned, "Alignment must end at an exact zero angle");
    const alignedTime = f.clock;
    f.update(alignedTime + .1);
    assert.ok(object.position.y < height - .005, "The aligned card must descend on subsequent frames");
  });
}
check("reopening detail during return keeps the displayed height and downward velocity", () => {
  const f = fixture(); f.rotation = f.targetRotation = 0; f.model.rotation.y = 0;
  f.setMode("archive"); f.update(f.clock + .1);
  const position = f.model.position.clone(), spring = { ...f.lift };
  assert.ok(spring.velocity < 0, "Fixture must already be descending");
  f.setMode("detail");
  assert.deepEqual(f.lift, spring, "Changing direction must inherit the spring's position and velocity");
  assert.ok(f.model.position.equals(position), "Input must not teleport the displayed card");
  f.update(f.clock + 1 / 600);
  assert.ok(f.lift.velocity < 0, "Rapid reversal must retain momentum before accelerating upward");
  assert.ok(f.model.position.distanceTo(position) < .02, "The first reversed frame must stay continuous");
});
check("reselecting a descending copy inherits that physical card's position and velocity", () => {
  const f = fixture(); f.rotation = f.targetRotation = 0; f.model.rotation.y = 0;
  f.select(1, { cell: { lane: 2, row: 13 } }); f.update(f.clock + .1);
  const copy = f.outgoing.find(o => o.cell.row === 12);
  assert.ok(copy?.lift.velocity < 0, "Fixture must contain a descending physical copy");
  const position = copy.group.position.clone(), spring = { ...copy.lift }, angle = copy.group.rotation.y;
  f.select(0, { cell: { lane: 2, row: 12 } });
  assert.deepEqual(f.lift, spring); assert.equal(f.rotation, angle);
  assert.equal(f.outgoing.some(o => o.cell.row === 12), false, "Reselected card must have only one owner");
  assert.ok(f.disposed.includes(copy.group), "The retired copy must release its independent material resources");
  f.update(f.clock + 1 / 600);
  assert.ok(f.lift.velocity < 0, "Reselection must retain downward momentum before reversing");
  assert.ok(f.model.position.distanceTo(position) < .05, "The displayed physical card must resume continuously");
});
check("resetting the frame clock excludes a long hidden or viewer pause", () => {
  const paused = fixture(), uninterrupted = fixture();
  paused.setMode("archive"); uninterrupted.setMode("archive");
  paused.resetFrameClock();
  paused.update(paused.clock + 600);
  uninterrupted.update(uninterrupted.clock + 1 / 60);
  assert.ok(paused.rotation > .6, "Resuming must not finish ten minutes of hidden animation");
  assert.ok(Math.abs(paused.rotation - uninterrupted.rotation) < 1e-9);
  assert.ok(Math.abs(paused.lift.value - uninterrupted.lift.value) < 1e-9);
  assert.ok(paused.model.position.distanceTo(uninterrupted.model.position) < 1e-9);
});
check("duplicate frame timestamps do not advance motion or decryption", () => {
  const f = fixture(); f.setMode("archive"); f.update(f.clock + .1);
  const state = () => JSON.stringify({ rotation: f.rotation, lift: f.lift, detail: f.detail,
    scanTime: f.scanTime, position: f.model.position.toArray(), decryption: f.decryption.frame });
  const before = state();
  for (let frame = 0; frame < 20; frame++) f.update(f.clock);
  assert.equal(state(), before, "One visual timestamp may only be consumed once");
});
check("alignment duration ends at the documented angle threshold", () => {
  assert.ok(Math.abs(motion.returnDuration(.8) - .9549445330954182) < 1e-9);
  assert.equal(motion.returnDuration(0), 0);
  assert.equal(motion.returnDuration(motion.ALIGNMENT_EPSILON), 0);
  assert.equal(motion.returnStep(.8, .95), .8 * Math.exp(-.95 * 7));
  assert.equal(motion.returnStep(.8, .96), 0);
});
for (const copies of [false, true]) {
  check(`${copies ? "copy" : "selected archive"} uses only the post-alignment remainder of a long frame`, () => {
    const prepare = () => {
      const f = fixture();
      if (copies) {
        f.select(1, { cell: { lane: 2, row: 13 } });
        // Keep the background shoulder static so the observed world-height
        // difference isolates the rotation/insertion transition.
        f.shoulder.value = f.selectedCell.row; f.shoulder.velocity = 0;
      }
      f.setMode("archive");
      return f;
    };
    const coarse = prepare(), fine = prepare();
    const coarseObject = copies ? coarse.outgoing[0].group : coarse.model;
    const fineObject = copies ? fine.outgoing[0].group : fine.model;
    const height = coarseObject.position.y;
    coarse.update(coarse.clock + 1);
    const start = fine.clock;
    for (let frame = 1; frame <= 600; frame++) fine.update(start + frame / 600);
    const drop = height - coarseObject.position.y;
    assert.ok(drop > .003 && drop < .08, `One second contains about .955s alignment, so descent must be slight; drop=${drop}`);
    assert.ok(Math.abs(coarseObject.position.y - fineObject.position.y) < 1e-8,
      "A single long frame and 600 short frames must end at the same physical height");
  });
}
check("coarse scene frames keep music loading held and start only after the real document reveal", () => {
  const f = fixture(), gate = new MusicRevealGate(), doc = new DocumentDecryption();
  const request = gate.begin("fixture-track");
  doc.reset({ dataset: {}, querySelectorAll: () => [] }, false);
  f.setMode("detail");
  const frame = (seconds, number) => {
    f.decryptionHeld = gate.holding;
    f.update(f.clock + seconds);
    doc.update(f.clock, f.decryption.frame, false, gate.holding);
    return gate.completeFrame(doc.complete, number);
  };
  assert.equal(frame(120, 1), null);
  assert.equal(f.decryption.frame.phase, "waiting"); assert.equal(doc.complete, false);
  gate.prepared(request);
  assert.equal(frame(8, 2), null, "Ready begins the existing physical decryption timeline");
  assert.equal(frame(8, 3), null, "The first clear model frame starts the document's reveal tail");
  assert.equal(doc.complete, false);
  assert.equal(frame(.94, 4), null);
  assert.equal(frame(.02, 5), request, "Only the completed document frame may claim playback");
  assert.equal(gate.state().startFrame, 5);
  assert.equal(frame(8, 6), null, "A completed reveal may claim playback only once");
});
check("return input after a long render consumes only its own 10ms", () => {
  const late = fixture(), control = fixture();
  late.clock = late.last = control.clock = control.last = 100;
  late.inputTime = 108.01; late.setMode("archive");
  control.setMode("archive");
  late.update(108.02); control.update(100.01);
  assert.ok(Math.abs(late.rotation - control.rotation) < 1e-9,
    `A return begun at 108.01 must not consume the previous 8s render; angle=${late.rotation}`);
  assert.ok(late.rotation > .7, "The newly requested return must remain near its displayed rotation");
  assert.ok(late.model.position.distanceTo(control.model.position) < 1e-9);
});
check("a new outgoing copy after a long render has only 10ms of return age", () => {
  const f = fixture(); f.clock = f.last = 100;
  f.inputTime = 108.01;
  f.select(1, { cell: { lane: 2, row: 13 } }); f.setMode("archive");
  const copy = f.outgoing[0], height = copy.group.position.y;
  f.update(108.02);
  assert.ok(f.outgoing.includes(copy), "A 10ms-old rotated copy must not be recycled immediately");
  assert.ok(copy.group.rotation.y > .7, `Only 10ms may align the new copy; angle=${copy.group.rotation.y}`);
  assert.ok(Math.abs(copy.group.position.y - height) < 1e-9, "The new copy remains at its displayed height while aligning");
});
check("new input does not reset the already returning copy's elapsed time", () => {
  const f = fixture(); f.clock = f.last = 100;
  f.select(1, { cell: { lane: 2, row: 13 } });
  const old = f.outgoing[0];
  f.update(100.1);
  f.inputTime = 108.01;
  f.select(2, { cell: { lane: 2, row: 14 } }); f.setMode("archive");
  const fresh = f.outgoing.find(copy => copy.cell.row === 13);
  assert.ok(fresh, "The scenario must include both the old and newly created copies");
  f.update(108.02);
  assert.ok(!f.outgoing.includes(old), "The old copy must consume its full elapsed interval and finish");
  assert.ok(f.disposed.includes(old.group));
  assert.ok(f.outgoing.includes(fresh), "The fresh copy must consume only its 10ms interval and remain visible");
});
console.log(`${passed}/${passed + failed} archive timing checks passed.`);
if (failed) process.exitCode = 1;
