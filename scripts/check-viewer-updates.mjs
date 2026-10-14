import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as THREE from "three";
import { damp } from "../src/motion.ts";
import { fullMotion } from "../src/motion-preferences.ts";
import { RenderState } from "../src/render-state.ts";
import { themeEnvironment } from "../src/theme-material.ts";

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const cameraSource = readFileSync(new URL("../src/viewer-camera.ts", import.meta.url), "utf8");
const ViewerCameraMotion = Function("THREE", `${compile(cameraSource.replace(/^import .*$/m, "").replace("export class", "class"))}\nreturn ViewerCameraMotion;`)(THREE);
const viewerSource = readFileSync(new URL("../src/model-viewer.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("model-viewer.ts", viewerSource, ts.ScriptTarget.Latest, true);
const viewer = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ModelViewer");
const parts = ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => decl.name.getText(ast) === "PARTS"));
const methods = ["update", "resize", "resetFrameClock", "resetView"].map(name => viewer.members.find(member => member.name?.getText(ast) === name).getText(ast)).join("\n");
let inputTime = 100;
const deps = { THREE, damp, themeEnvironment, resizeQuality() {}, matchMedia: () => ({ matches: false }), performance: { now: () => inputTime * 1000 } };
const ViewerFixture = Function(...Object.keys(deps), `${compile(`${parts.getText(ast)}\nclass ViewerFixture { ${methods} }`)}\nreturn ViewerFixture;`)(...Object.values(deps));

function fixture() {
  const f = new ViewerFixture(), scene = new THREE.Scene(), model = new THREE.Group();
  scene.background = new THREE.Color("#eae5e1"); scene.fog = new THREE.Fog("#eae5e1", 13.5, 26.5);
  const material = new THREE.MeshPhysicalMaterial({ color: "white", roughness: .4, transmission: .5 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  const groups = new Map(["fasteners", "cover", "optical-lenses", "optical-core", "substrate", "carrier"].map(id => {
    const group = new THREE.Group(); model.add(group); return [id, group];
  }));
  groups.get("cover").add(mesh); scene.add(model);
  const camera = new THREE.PerspectiveCamera(34, 16 / 9, .3, 120);
  camera.position.set(7.2, 3.8, 12);
  const controlCamera = camera.clone(), target = new THREE.Vector3();
  const cameraMotion = new ViewerCameraMotion(camera); cameraMotion.snap(controlCamera, target);
  let draws = 0;
  const renderer = { toneMappingExposure: 1.05, render() { draws++; } };
  Object.assign(f, { isOpen: true, scene, camera, controlCamera, cameraMotion, groups, renderer,
    source: { model, setClarity(value) { mesh.userData.glassClarity = { value }; } },
    themeAmount: 0, spread: { value: 0, velocity: 0 }, targetSpread: 0,
    clarity: { value: 1, velocity: 0 }, targetClarity: 1, lastTime: 100,
    motion: fullMotion(), reduced: false, superPerformance: false, appliedQuality: "", quality: { antialias: "none" },
    controls: { target, update() {}, getAzimuthalAngle: () => 0, getPolarAngle: () => 0 },
    pipeline: { composer: { render() { draws++; } } },
    root: { dataset: {}, closest: () => null, querySelector: () => ({ innerHTML: "" }) },
    canvasHost: { clientWidth: 1600, clientHeight: 900 }, setStatus() {},
    initialCamera: new THREE.Vector3(7.2, 3.8, 12), loading: false,
    renderState: new RenderState(), renderedFrames: 0, reusedFrames: 0,
  });
  return { f, mesh, material, draws: () => draws };
}
let failed = 0;
const check = (name, work) => { try { work(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); } };
check("settled viewer reuses its image while keeping the simulation alive", () => {
  const { f, draws } = fixture(); f.update(100 + 1 / 60);
  const rendered = draws();
  for (let frame = 2; frame <= 120; frame++) f.update(100 + frame / 60);
  assert.equal(draws(), rendered); assert.ok(f.reusedFrames > 0);
});
check("model and camera motion use elapsed time at 2 fps", () => {
  const { f } = fixture(); f.targetSpread = 1; f.targetClarity = 0;
  const spread = { value: 0, velocity: 0 }, clarity = { value: 1, velocity: 0 };
  damp(spread, 1, 5.5, 1); damp(clarity, 0, 8, 1);
  f.cameraMotion.reset(); f.update(100.5); f.update(101);
  assert.ok(Math.abs(f.spread.value - spread.value) < 1e-10);
  assert.ok(Math.abs(f.clarity.value - clarity.value) < 1e-10);
  assert.equal(f.cameraMotion.resetting, false, "0.56s reset cannot require extra rendered frames");
});
check("material, late textures, theme, camera and resize all repaint a settled viewer", () => {
  const { f, mesh, material, draws } = fixture(); f.update(100.1);
  const change = mutate => { const before = draws(); mutate(); f.update(f.lastTime + .1); assert.equal(draws(), before + 1); };
  change(() => { material.opacity = .6; });
  const texture = new THREE.Texture();
  change(() => { material.map = texture; });
  change(() => { texture.needsUpdate = true; });
  change(() => { f.themeAmount = 1; });
  change(() => { mesh.visible = false; });
  change(() => { f.reduced = true; f.controlCamera.position.x += 2; });
  change(() => { f.resize(); });
  change(() => { f.quality.antialias = "smaa"; f.renderState.invalidate(); });
});
check("an asynchronously attached model repaints an otherwise settled canvas", () => {
  const { f, mesh, draws } = fixture();
  const source = f.source;
  f.scene.remove(source.model); f.source = undefined; f.update(100.1);
  const before = draws(); f.scene.add(source.model); f.source = source; f.update(100.2);
  assert.equal(draws(), before + 1);
  const next = mesh.clone(); f.source.model.add(next); f.update(100.3);
  assert.equal(draws(), before + 2);
  f.source.model.remove(next); f.update(100.4); assert.equal(draws(), before + 3);
});
check("a fresh reset starts at its input event rather than the preceding slow frame", () => {
  const { f } = fixture(); f.controlCamera.position.set(-7, 2, 10); f.cameraMotion.snap(f.controlCamera, f.controls.target);
  inputTime = 101; f.resetView(); f.update(101.1);
  assert.equal(f.cameraMotion.resetting, true, "only 0.1s of the new reset elapsed");
  f.update(101.6); assert.equal(f.cameraMotion.resetting, false);
  inputTime = 100;
});
check("resume discards a hidden interval without clipping visible low-frame-rate time", () => {
  const { f } = fixture(); f.cameraMotion.reset(); f.resetFrameClock(); f.update(120);
  assert.equal(f.cameraMotion.resetting, true, "hidden time must not finish the reset");
  f.update(121); assert.equal(f.cameraMotion.resetting, false, "the next 1fps visible interval advances one second");
});
check("orbit settles at the requested pose and closed viewers never render", () => {
  const { f, draws } = fixture(); f.controlCamera.position.set(-7, 2, 10);
  for (let frame = 1; frame <= 360; frame++) f.update(100 + frame / 60);
  assert.ok(f.camera.position.distanceTo(f.controlCamera.position) < 1e-6);
  const settled = draws(); f.update(106.5); f.update(107); assert.equal(draws(), settled);
  f.isOpen = false; f.update(108); assert.equal(draws(), settled);
});
if (failed) process.exitCode = 1;
