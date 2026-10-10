// Isolation test: does page-like polling/SSE prevent VLC from starting playback?
// Usage: node scripts/diagnostics/bridge-isolate.mjs <port> <token> <mode>
//   mode "quiet"  → play immediately, no polling, no SSE
//   mode "page"   → open the spectrum SSE and poll /api/status twice a second first
const PORT = Number(process.argv[2] ?? 8795);
const TOKEN = process.argv[3] ?? "iso";
const MODE = process.argv[4] ?? "quiet";
const BASE = `http://127.0.0.1:${PORT}`;
const auth = { authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const status = async () =>
  (await fetch(`${BASE}/api/status`, { headers: auth })).json();
const library = await (
  await fetch(`${BASE}/api/library`, { headers: auth })
).json();
const track =
  library.tracks.find((t) => /60Hz/.test(t.name)) ?? library.tracks[0];
console.log(`mode=${MODE} track=${track.name}`);

let sseFrames = 0;
let pollTimer = null;
if (MODE === "page") {
  const response = await fetch(`${BASE}/api/spectrum?token=${TOKEN}`, {
    headers: auth,
  });
  const reader = response.body.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      sseFrames += decoder.decode(value).split("data: ").length - 1;
    }
  })();
  pollTimer = setInterval(() => void status(), 500);
  await sleep(5000);
  console.log(`pre-play: sse frames ${sseFrames}`);
}

const playResponse = await fetch(
  `${BASE}/api/play?id=${encodeURIComponent(track.id)}`,
  { headers: auth },
);
console.log("play http", playResponse.status);

for (let i = 0; i < 20; i++) {
  await sleep(1000);
  const state = await status();
  if (i % 3 === 0 || state.state === "playing")
    console.log(
      `  ${i}s ${state.state} ${state.time}/${state.length} sse=${sseFrames}`,
    );
  if (state.state === "playing" && state.time > 0.5) break;
}
if (pollTimer) clearInterval(pollTimer);
const final = await status();
console.log(
  `result: ${final.state} ${final.time}/${final.length} sseFrames=${sseFrames}`,
);
process.exit(final.state === "playing" ? 0 : 1);
