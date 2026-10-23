import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ARRAY_CARD_SURFACES, setCardInteriorVisible } from "../src/card-structure.ts";
import { LOOP_COLUMNS, LOOP_ROWS, poolCell, sameCell, selectionCell } from "../src/archive-loop.ts";
import { activeView, buildView, rhineView, setActiveView } from "../src/archive-view.ts";
import { drawAlbumLabel } from "../src/album-label.ts";
import { glassRevealGLSL, frostedTransmissionGLSL, FROSTED_ROUGHNESS } from "../src/glass-reveal.ts";
import { configureInternalOptics, internalOpticsFragment } from "../src/internal-optics.ts";
import { themeMaterial } from "../src/theme-material.ts";

const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const appearanceText = await readFile(new URL("../src/appearance.ts", import.meta.url), "utf8");
const appearanceAst = ts.createSourceFile("appearance.ts", appearanceText, ts.ScriptTarget.Latest, true);
const appearanceClass = appearanceAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "CardAppearance");
assert.ok(appearanceClass, "Production CardAppearance must exist");
const appearanceDeps = { THREE, glassRevealGLSL, frostedTransmissionGLSL, FROSTED_ROUGHNESS, internalOpticsFragment, themeMaterial };
const CardAppearance = Function(...Object.keys(appearanceDeps), `${compile(appearanceClass.getText(appearanceAst).replace(/^export\s+/, ""))}\nreturn CardAppearance;`)(...Object.values(appearanceDeps));

// Run the actual scene loading, selection and assembly methods on real GLB
// geometry. Only the file transport, canvas and WebGL renderer are replaced.
const source = await readFile(new URL("../src/scene.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("scene.ts", source, ts.ScriptTarget.Latest, true);
const sceneClass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ArchiveScene");
assert.ok(sceneClass, "Production ArchiveScene must exist");
const members = ["cardInteriorVisible", "setCardInteriorVisible", "load", "select", "createAssemblyModel", "drawLabel", "drawMusicLabel"].map(name => {
  const member = sceneClass.members.find(node => node.name?.getText(ast) === name);
  assert.ok(member, `Production ArchiveScene.${name} must exist`);
  return member.getText(ast);
}).join("\n");
const assets = new Map(await Promise.all(["archive-cassette.glb", "archive-assembly.glb"].map(async name => {
  const bytes = await readFile(new URL(`../public/assets/${name}`, import.meta.url));
  return [name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)];
})));
class LocalGLTFLoader {
  async loadAsync(url) {
    const name = String(url).split("/").at(-1);
    assert.ok(assets.has(name), `Unexpected model request: ${url}`);
    return new GLTFLoader().parseAsync(assets.get(name), "");
  }
}
// Record drawing without a second implementation of the production layout.
// Persistent contexts also catch unbalanced transforms when changing views.
const canvases = [];
function canvas() {
  const element = { width: 0, height: 0 };
  const calls = [];
  let depth = 0;
  const context = {
    canvas: element, calls,
    get depth() { return depth; },
    save() { depth++; },
    restore() { assert.ok(depth > 0, "Canvas restore must match a save"); depth--; },
    setTransform(...args) { calls.push(["setTransform", ...args]); },
    fillRect(...args) { calls.push(["fillRect", ...args]); },
    fillText(...args) { calls.push(["fillText", ...args]); },
    drawImage(...args) { calls.push(["drawImage", ...args]); },
    measureText: text => ({ width: Array.from(text).length * 30 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    beginPath() {}, rect() {}, clip() {}, arc() {}, stroke() {}, fill() {},
  };
  element.getContext = () => context;
  canvases.push(element);
  return element;
}
const deps = { THREE, CardAppearance, ARRAY_CARD_SURFACES, setCardInteriorVisible,
  GLTFLoader: LocalGLTFLoader, LOOP_COLUMNS, LOOP_ROWS, poolCell, sameCell, selectionCell,
  configureInternalOptics, themeMaterial, labelMarkSvg: "<svg/>", activeView, drawAlbumLabel,
  publicAsset: value => value, document: { createElement: canvas },
  fileLocation: index => activeView().fileLocation(index),
  ease: value => THREE.MathUtils.smootherstep(value, 0, 1) };
const SceneFixture = Function(...Object.keys(deps), `${compile(`class SceneFixture { ${members} }`)}\nreturn SceneFixture;`)(...Object.values(deps));
function fixture() {
  const f = new SceneFixture();
  Object.assign(f, {
    scene: new THREE.Scene(), model: new THREE.Group(), appearance: new CardAppearance(),
    instances: [], outgoing: [], cells: [], subduedIndex: { value: 0 },
    lightingLook: "refined", labelMark: { decode: async () => {} }, labelCanvas: canvas(),
    renderer: { capabilities: { getMaxAnisotropy: () => 1 } },
    selectedCell: { lane: 2, row: 12 }, selectedSlot: 0, loaded: false,
    looping: true, lift: { value: 1.4, velocity: .2 }, rotation: .7,
    decryption: { select() {} }, themeAmount: 0,
    cellPosition: () => new THREE.Vector3(), modelClarity: () => .65,
    cancelPointer() {}, setHover() {}, markMotionChange() {}, emitPulse() {},
  });
  return f;
}
const meshes = group => {
  const result = [];
  group.traverse(object => { if (object instanceof THREE.Mesh) result.push(object); });
  return result;
};
const countVisible = group => {
  let triangles = 0, count = 0;
  group.traverseVisible(object => {
    if (!(object instanceof THREE.Mesh)) return;
    count++;
    triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
  });
  return { meshes: count, triangles };
};
const kept = new Set(["Frosted_Polymer", "Ivory_Edges", "Titanium_Fasteners", "Index_Inlay", "Optical_Diffuser", "Printed_Label"]);
function assertStructure(group, interiorsVisible) {
  let interiorCount = 0, labelCount = 0;
  for (const mesh of meshes(group)) {
    const name = mesh.userData.surface;
    const internal = Boolean(name && !kept.has(name));
    if (internal) interiorCount++;
    if (!name || name === "Printed_Label") labelCount++;
    assert.equal(mesh.visible, internal ? interiorsVisible : true, `${name ?? "Canvas label"} visibility`);
  }
  assert.ok(interiorCount > 0, "The real model must exercise internal geometry");
  assert.ok(labelCount > 0, "The real model must retain its printed/dynamic label");
}
let passed = 0, failed = 0;
async function check(name, work) {
  try { await work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
}
const f = fixture();
await check("the default scene loads the complete cassette and retains the existing array surfaces", async () => {
  assert.equal(f.cardInteriorVisible, true);
  await f.load();
  assertStructure(f.model, true);
  assert.deepEqual([...ARRAY_CARD_SURFACES].sort(), [...kept].filter(name => name !== "Printed_Label").sort());
  assert.deepEqual(f.instances.map(mesh => mesh.userData.surface).sort(), [...ARRAY_CARD_SURFACES].sort());
});
const full = countVisible(f.model);
await check("the music structure removes real interior geometry while keeping the cover, base and labels", () => {
  const resources = meshes(f.model).map(mesh => ({ mesh, geometry: mesh.geometry, material: mesh.material }));
  setCardInteriorVisible(f.model, false);
  assertStructure(f.model, false);
  const compact = countVisible(f.model);
  assert.ok(compact.triangles < full.triangles / 10, JSON.stringify({ full, compact }));
  for (const { mesh, geometry, material } of resources) {
    assert.equal(mesh.geometry, geometry, "Visibility switching must retain geometry resources");
    assert.equal(mesh.material, material, "Visibility switching must retain the glass/material implementation");
  }
  console.log(`  Real cassette geometry: ${JSON.stringify({ full, music: compact })}`);
  setCardInteriorVisible(f.model, true);
  assertStructure(f.model, true);
  assert.deepEqual(countVisible(f.model), full);
});
await check("music selected before asynchronous loading is applied to the loaded cassette", async () => {
  const beforeLoad = fixture();
  beforeLoad.setCardInteriorVisible(false);
  await beforeLoad.load();
  assertStructure(beforeLoad.model, false);
});
await check("current and newly returning cards stay compact through prepare, appearance, theme and clarity updates", () => {
  f.setCardInteriorVisible(false);
  f.select(1, { cell: { lane: 2, row: 13 } });
  assert.equal(f.outgoing.length, 1);
  for (const group of [f.model, f.outgoing[0].group]) {
    assertStructure(group, false);
    for (const quality of [0, .5, 1]) {
      f.appearance.apply(group, quality);
      f.appearance.setClarity(group, quality);
      f.appearance.setTheme(group, quality);
      assertStructure(group, false);
    }
  }
  f.setCardInteriorVisible(true);
  assertStructure(f.model, true);
  assertStructure(f.outgoing[0].group, true);
  f.setCardInteriorVisible(false);
  assertStructure(f.model, false);
  assertStructure(f.outgoing[0].group, false);
});
await check("reselecting a returning card keeps a single compact owner without reviving interiors", () => {
  const previous = f.outgoing[0].group;
  f.lift.value = 1;
  f.select(0, { cell: { lane: 2, row: 12 } });
  assert.equal(f.outgoing.length, 1);
  assert.ok(!f.outgoing.some(copy => copy.group === previous));
  assertStructure(f.model, false);
  assertStructure(f.outgoing[0].group, false);
});
await check("the 360-degree assembly follows music structure while archive mode restores all parts", async () => {
  const music = await f.createAssemblyModel();
  assertStructure(music.model, false);
  music.setClarity(.2);
  assertStructure(music.model, false);
  const visibleParts = new Set(meshes(music.model).filter(mesh => mesh.visible).map(mesh => mesh.userData.assemblyPart));
  assert.ok(!visibleParts.has("optical-core") && !visibleParts.has("optical-lenses"));
  f.setCardInteriorVisible(true);
  const archive = await f.createAssemblyModel();
  assertStructure(archive.model, true);
  assert.ok(countVisible(archive.model).triangles > countVisible(music.model).triangles * 10);
  assertStructure(music.model, false);
  music.dispose(); archive.dispose();
});
await check("nested future interior surfaces are excluded without hiding untagged canvas meshes", () => {
  const group = new THREE.Group(), nested = new THREE.Group();
  const interior = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  interior.userData.surface = "Future_Optical_Internal";
  const canvasMesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  nested.add(interior, canvasMesh); group.add(nested);
  setCardInteriorVisible(group, false);
  assert.equal(interior.visible, false); assert.equal(canvasMesh.visible, true);
  setCardInteriorVisible(group, true);
  assert.equal(interior.visible, true); assert.equal(canvasMesh.visible, true);
});

const musicView = buildView("music", ["Synthetic Album"], undefined,
  [0, 1].map(index => ({ ...rhineView.records[0],
    id: `M-00${index + 1}`, title: `Synthetic Song ${index + 1}`,
    en: "Synthetic Artist", department: "Synthetic Album", category: "Synthetic Album", clearance: "FLAC",
  })), () => 0, index => `synthetic-track-${index}`);
const labelOf = model => model.children.at(-1);
const dimensions = canvas => [canvas.width, canvas.height];
const transform = label => ({ position: label.position.toArray(), scale: label.scale.toArray() });
function assertArtwork(label, expected) {
  assert.equal(label.userData.albumArtwork.value, expected);
  const shader = { uniforms: {}, vertexShader: "#include <begin_vertex>", fragmentShader: "#include <opaque_fragment>" };
  label.material.onBeforeCompile(shader);
  assert.equal(shader.uniforms.rhinePreserveArtwork, label.userData.albumArtwork,
    "The compiled printed material must use this label's live artwork flag");
  assert.equal(shader.uniforms.rhineTheme, label.userData.themeAmount);
  assert.match(shader.fragmentShader, /outgoingLight = mix\(outgoingLight,/);
  assert.match(shader.fragmentShader, /rhineTheme \* \(1\.0 - rhinePreserveArtwork\)/,
    "Music art bypasses dark recoloring while archive labels retain it");
}
const albumTransform = { position: [0, 1.85, .255], scale: [4.64 / .99, 3.34 / .46, 1] };
const archiveTransform = { position: [-1.36, 3.04, .255], scale: [1, 1, 1] };
const album = fixture();
setActiveView(musicView);
try {
  await check("music loading paints the full album face with the real title and artist", async () => {
    album.selectedCell = musicView.fileLocation(0);
    await album.load();
    const label = labelOf(album.model);
    assert.deepEqual(transform(label), albumTransform);
    assertArtwork(label, 1);
    assert.deepEqual(dimensions(album.labelCanvas), [1536, 1104]);
    assert.equal(label.material.map, album.labelTexture);
    const context = album.labelCanvas.getContext("2d");
    const texts = context.calls.filter(call => call[0] === "fillText").map(call => call[1]);
    assert.ok(texts.includes("Synthetic Song 1") && texts.some(text => text.includes("Synthetic Artist")));
    assert.ok(texts.includes("NO COVER ART"), "No cover uses the production album placeholder");
    assert.equal(context.depth, 0, "Album drawing restores the canvas transform");
  });
  await check("rapid music selection freezes a full-size independent album texture on the returning card", () => {
    const source = album.labelCanvas;
    const cover = { width: 800, height: 800 };
    album.drawLabel(0, cover);
    const image = source.getContext("2d").calls.findLast(call => call[0] === "drawImage");
    assert.equal(image[1], cover, "Decoded art reaches the actual selected label");
    album.setCardInteriorVisible(false);
    album.select(1, { cell: musicView.fileLocation(1) });
    assert.equal(album.outgoing.length, 1);
    const label = labelOf(album.outgoing[0].group);
    assert.deepEqual(transform(label), albumTransform);
    assertArtwork(label, 1);
    assert.notEqual(label.userData.albumArtwork, labelOf(album.model).userData.albumArtwork,
      "Returning labels must retain an independent artwork flag after the selected view changes");
    assert.notEqual(label.material.map, album.labelTexture);
    assert.notEqual(label.material.map.image, source);
    assert.deepEqual(dimensions(label.material.map.image), dimensions(source));
    assert.deepEqual(label.material.map.image.getContext("2d").calls, [["drawImage", source, 0, 0]],
      "The snapshot copies the full selected canvas before the next title is painted");
    assertStructure(album.outgoing[0].group, false);
  });
  await check("the assembly viewer copies the album transform and owns a disposable texture snapshot", async () => {
    const viewer = await album.createAssemblyModel();
    const label = labelOf(viewer.model);
    assert.deepEqual(transform(label), albumTransform);
    assertArtwork(label, 1);
    assert.notEqual(label.userData.albumArtwork, labelOf(album.model).userData.albumArtwork);
    assert.notEqual(label.userData.albumArtwork, labelOf(album.outgoing[0].group).userData.albumArtwork);
    labelOf(album.model).userData.albumArtwork.value = 0;
    assertArtwork(label, 1);
    labelOf(album.model).userData.albumArtwork.value = 1;
    album.appearance.setTheme(viewer.model, 1);
    assert.equal(label.userData.themeAmount.value, 1);
    assertArtwork(label, 1);
    assert.equal(label.userData.assemblyPart, "cover");
    assert.notEqual(label.material.map, album.labelTexture);
    assert.deepEqual(dimensions(label.material.map.image), dimensions(album.labelCanvas));
    assert.deepEqual(label.material.map.image.getContext("2d").calls, [["drawImage", album.labelCanvas, 0, 0]]);
    assertStructure(viewer.model, false);
    let disposed = 0;
    label.material.map.addEventListener("dispose", () => disposed++);
    viewer.dispose();
    assert.equal(disposed, 1, "The assembly releases its texture when closed");
  });
  await check("switching between album and archive restores label geometry without reallocating textures", async () => {
    const label = labelOf(album.model), texture = album.labelTexture;
    const geometry = label.geometry, material = label.material;
    const canvasCount = canvases.length;
    let disposed = 0;
    texture.addEventListener("dispose", () => disposed++);
    const version = texture.version;
    for (let round = 0; round < 3; round++) {
      setActiveView(rhineView);
      album.drawLabel(0);
      assert.deepEqual(transform(label), archiveTransform);
      assertArtwork(label, 0);
      assertArtwork(labelOf(album.outgoing[0].group), 1);
      const context = album.labelCanvas.getContext("2d");
      assert.deepEqual(context.calls.findLast(call => call[0] === "setTransform"),
        ["setTransform", 1536 / 1024, 0, 0, 1104 / 440, 0, 0]);
      assert.ok(context.calls.some(call => call[0] === "fillText" && call[1] === "RHINE LAB, LLC."));
      assert.equal(context.depth, 0);
      setActiveView(musicView);
      album.drawLabel(1);
      assert.deepEqual(transform(label), albumTransform);
      assertArtwork(label, 1);
      assert.equal(label.geometry, geometry);
      assert.equal(label.material, material);
      assert.equal(label.material.map, texture);
      assert.equal(album.labelTexture, texture);
      assert.equal(context.depth, 0);
    }
    assert.equal(canvases.length, canvasCount, "Library switches reuse the same canvas and texture allocation");
    assert.equal(disposed, 0);
    assert.equal(texture.version, version + 6, "Every new face requests one texture update");
    assert.deepEqual(transform(labelOf(album.outgoing[0].group)), albumTransform,
      "Changing the selected face does not resize its returning snapshot");
    setActiveView(rhineView);
    album.drawLabel(0);
    const archive = await album.createAssemblyModel();
    assert.deepEqual(transform(labelOf(archive.model)), archiveTransform,
      "A newly opened archive viewer restores the small original label");
    assertArtwork(labelOf(archive.model), 0);
    assert.notEqual(labelOf(archive.model).userData.albumArtwork, label.userData.albumArtwork);
    archive.dispose();
  });
} finally {
  setActiveView(rhineView);
}
console.log(`${passed}/${passed + failed} music model structure checks passed.`);
process.exitCode = failed ? 1 : 0;
