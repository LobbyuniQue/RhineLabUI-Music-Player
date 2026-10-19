import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { buildMusicView } from "../src/music-grouping.ts";
import { rhineView } from "../src/archive-view.ts";
import { escapeHtml } from "../src/html.ts";

// Execute the production coordinator; only its DOM and scene ports are inert.
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = ["memoryFor", "applyView", "select", "refreshFileTicks", "updateSelection", "renderResults", "showMoreArchiveResults"];
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
  .map(node => node.getText(ast)).join("\n");
const js = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const track = (id, album) => ({ id, title: id, name: `${id}.mp3`, path: `${id}.mp3`, artist: "Artist", album,
  track: null, disc: null, duration: 60, codec: "mp3", genre: "", year: "", tagged: true,
  hasCover: false, missing: false, size: 1, modified: 0 });
const button = index => ({ dataset: { select: String(index) }, title: "", labels: {}, pressed: false,
  setAttribute(name, value) { this.labels[name] = value; }, classList: { toggle() {} }, focus() {} });
function fixture(initial) {
  const nodes = new Map();
  let ticks = [];
  const tickHost = { querySelectorAll: () => ticks, set innerHTML(value) {
    ticks = [...value.matchAll(/data-select="(\d+)"/g)].map(match => button(Number(match[1])));
  } };
  const list = { innerHTML: "", scrollTop: 81, focused: null, querySelectorAll() {
    return [...this.innerHTML.matchAll(/data-result="(\d+)"/g)].map(match => ({
      focus: () => { this.focused = Number(match[1]); },
    }));
  } };
  nodes.set("#file-ticks", tickHost); nodes.set("#search-results", list);
  const $ = name => {
    if (!nodes.has(name)) nodes.set(name, { textContent: "", dataset: {}, setAttribute() {} });
    return nodes.get(name);
  };
  const noop = () => {};
  const titlePort = selector => ({ update({ text }) { $(selector).textContent = text; } });
  const deps = { initial, rhineView, $, escapeHtml, applyRowSpacing: noop, scene: null,
    musicReveal: { pending: false, holding: false }, cancelMusicArchive: noop, setMode: noop,
    syncLibraryModeUI: noop, motionActive: () => false, requestLabelCover: noop,
    selectionTitle: titlePort("#selected-title"), songTitle: titlePort("#selected-song-title"),
    clearanceTitle: { update: noop }, categoryTitle: { update: noop },
    selectedCode: { update: noop }, fileCounter: { update: noop }, columnCounter: { update: noop },
    columnTitle: { update: noop }, saved: new Set(), audio: { play: noop } };
  const api = Function(...Object.keys(deps), `
    let active=initial, selected=0, mode='archive', activeTab='overview', filter='全部档案', modal='search', searchQuery='';
    const view=()=>active, setActiveView=value=>active=value;
    const columnMemory={archive:[],music:[]}, memoryViews={archive:null,music:null};
    let fileTicks=[], fileTicksView=null, fileTicksLane=-1;
    const ARCHIVE_RESULT_PAGE_SIZE=240;
    let archiveVisibleResults=240, archiveResultsView=null, archiveResultScope='';
    ${js}
    return { memoryFor, applyView, select, refreshFileTicks, updateSelection, renderResults,
      more: typeof showMoreArchiveResults==='function'?showMoreArchiveResults:undefined,
      get selected(){return selected}, get active(){return active},
      get memory(){return columnMemory.music}, query(value){searchQuery=value;renderResults();},
      mode(value){mode=value;updateSelection();} };
  `)(...Object.values(deps));
  return { api, list, nodes, ticks: () => ticks };
}
let failed = 0;
const check = (name, work) => { try { work(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); } };
check("unified index selects the active library while explicit music access stays available", () => {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "openModal");
  assert.ok(declaration, "production openModal exists");
  const modalJS = ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const fixture = Function("libraryKind", "ready", `
    let modal='settings', modalClosing=true, searchQuery='old query', filter='old filter', archiveResultScope='old scope';
    const view=()=>({kind:libraryKind}), musicReveal={pending:false,holding:false};
    const audio={play(){}}, renderModal=()=>{}, cancelMusicArchive=()=>{};
    ${modalJS}
    return {open:openModal, get kind(){return modal}, get query(){return searchQuery}};
  `);
  const music = fixture("music", true);
  music.open("search"); assert.equal(music.kind, "music"); assert.equal(music.query, "");
  music.open("settings"); assert.equal(music.kind, "settings");
  const archive = fixture("archive", true);
  archive.open("search"); assert.equal(archive.kind, "search");
  archive.open("music"); assert.equal(archive.kind, "music");
  const notReady = fixture("music", false);
  notReady.open("search"); assert.equal(notReady.kind, "settings");
});
check("music callout shows song title above artist, follows selection, and restores archive text", () => {
  const songs = [
    { ...track("track-a", "Album"), title: "一颗方糖悬滞的时间", artist: "测试歌手" },
    { ...track("track-b", "Album"), title: "Another Song", artist: "" },
  ];
  const view = buildMusicView(songs, "album"), f = fixture(view);
  f.api.applyView(view);
  assert.equal(f.nodes.get(".archive-callout").dataset.kind, "music");
  assert.equal(f.nodes.get("#selected-song-title").textContent, songs[0].title);
  assert.equal(f.nodes.get("#selected-title").textContent, songs[0].artist);
  f.api.mode("boot");
  assert.equal(f.nodes.get("#selected-song-title").textContent, "");
  assert.equal(f.nodes.get("#selected-title").textContent, songs[0].title);
  f.api.mode("archive");
  assert.equal(f.nodes.get("#selected-song-title").textContent, songs[0].title);
  assert.equal(f.nodes.get("#selected-title").textContent, songs[0].artist);
  f.api.select(1);
  assert.equal(f.nodes.get("#selected-song-title").textContent, songs[1].title);
  assert.equal(f.nodes.get("#selected-title").textContent, "未知艺术家");
  assert.equal(view.backingId(f.api.selected), "track-b");
  f.api.applyView(rhineView);
  assert.equal(f.nodes.get(".archive-callout").dataset.kind, "archive");
  assert.equal(f.nodes.get("#selected-song-title").textContent, "");
  assert.equal(f.nodes.get("#selected-title").textContent, rhineView.records[f.api.selected].title);
  assert.equal(f.nodes.get("#selected-prefix").textContent, "X-");
});
check("removing the selected song with unchanged group count leaves a valid selection", () => {
  const old = buildMusicView([track("A0", "A"), track("A1", "A"), track("B0", "B"), track("B1", "B"), track("B2", "B")], "album");
  const f = fixture(old); f.api.applyView(old); f.api.select(1); f.api.select(4);
  const next = buildMusicView([track("A0", "A"), track("B0", "B")], "album");
  f.api.applyView(next, "B2");
  assert.equal(next.backingId(f.api.selected), "B0");
  f.api.memory.forEach((index, lane) => assert.ok(next.columnFiles(lane).includes(index)));
});
check("new sort positions preserve remembered songs by group and real track id", () => {
  const old = buildMusicView([track("A1", "A"), track("A2", "A"), track("B1", "B"), track("B2", "B")], "album");
  const f = fixture(old); f.api.applyView(old); f.api.select(1); f.api.select(3);
  const next = buildMusicView([track("A0", "A"), track("A1", "A"), track("A2", "A"), track("B1", "B"), track("B2", "B")], "album");
  f.api.applyView(next, "B2");
  assert.equal(next.backingId(f.api.memory[0]), "A2");
  assert.equal(next.backingId(f.api.selected), "B2");
  f.api.memory.forEach((index, lane) => assert.ok(next.columnFiles(lane).includes(index)));
});
check("removing the current song keeps its named group when earlier groups grow", () => {
  const old = buildMusicView([track("A0", "A"), track("B0", "B"), track("B1", "B")], "album");
  const f = fixture(old); f.api.applyView(old); f.api.select(2);
  const next = buildMusicView([...Array.from({ length: 10 }, (_, i) => track(`A${i}`, "A")), track("B0", "B")], "album");
  f.api.applyView(next, "B1"); assert.equal(next.backingId(f.api.selected), "B0");
});
check("group insertions and removals keep memories on their named group, never its old lane", () => {
  const old = buildMusicView([track("A0", "A"), track("B0", "B"), track("B1", "B"), track("C0", "C"), track("C1", "C")], "album");
  const f = fixture(old); f.api.applyView(old); f.api.select(2); f.api.select(4);
  const next = buildMusicView([track("B0", "B"), track("B1", "B"), track("C0", "C"), track("C1", "C"), track("D0", "D")], "album");
  f.api.applyView(next, "C1");
  assert.deepEqual(f.api.memory.map(index => next.backingId(index)), ["B1", "C1", "D0"]);
});
check("unequal group lengths rebuild tick buttons in both directions without stale targets", () => {
  const view = buildMusicView([track("A0", "A"), track("A1", "A"), track("B0", "B"), track("B1", "B"), track("B2", "B"), track("B3", "B")], "album");
  const f = fixture(view); f.api.applyView(view); f.api.select(2);
  assert.deepEqual(f.ticks().map(item => Number(item.dataset.select)), view.columnFiles(1));
  f.api.select(0);
  assert.deepEqual(f.ticks().map(item => Number(item.dataset.select)), view.columnFiles(0));
});
check("main search pages 1000 matches, keeps source indices, restores scroll and resets on query", () => {
  const view = buildMusicView(Array.from({ length: 1000 }, (_, i) => track(`Track ${i}`, "Album")), "album");
  const f = fixture(view); f.api.renderResults();
  const indices = () => [...f.list.innerHTML.matchAll(/data-result="(\d+)"/g)].map(match => Number(match[1]));
  assert.equal(indices().length, 240); assert.match(f.nodes.get("#result-count").textContent, /1000/);
  f.api.more(); assert.equal(indices().length, 480); assert.equal(f.list.scrollTop, 81);
  assert.equal(f.list.focused, 240);
  f.api.more(); f.api.more(); assert.equal(indices().length, 960);
  f.api.more(); assert.equal(indices().length, 1000); assert.equal(f.list.focused, 960);
  assert.doesNotMatch(f.list.innerHTML, /more-archive-results/);
  f.api.query("Track 999"); assert.deepEqual(indices(), [999]);
  f.api.query(""); assert.equal(indices().length, 240);
});
if (failed) process.exitCode = 1;
