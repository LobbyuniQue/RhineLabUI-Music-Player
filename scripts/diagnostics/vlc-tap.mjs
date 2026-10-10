// Probe: does VLC expose decoded PCM on a loopback stream for the visualiser?
// Reads ~2 s of s16le stereo 44.1 kHz audio over HTTP, then reports RMS and the
// dominant frequency so we can prove it is the real decoded signal.
const PORT = Number(process.argv[2] ?? 8033);
const RATE = 44100;

const response = await fetch(`http://127.0.0.1:${PORT}/`, {
  signal: AbortSignal.timeout(15000),
});
console.log(
  `tap http ${response.status} ${response.headers.get("content-type") ?? ""}`,
);

const samples = [];
const target = RATE * 2 * 2; // 2 seconds of mono-mixed samples
for await (const chunk of response.body) {
  const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  for (let i = 0; i + 3 < buffer.length; i += 4) {
    const left = buffer.readInt16LE(i) / 32768;
    const right = buffer.readInt16LE(i + 2) / 32768;
    samples.push((left + right) / 2);
  }
  if (samples.length >= target) break;
}
if (samples.length < 4096) {
  console.log(`insufficient PCM: ${samples.length} samples`);
  process.exit(1);
}

const window = 8192;
const slice = samples.slice(
  Math.floor(samples.length / 2),
  Math.floor(samples.length / 2) + window,
);
let rms = 0;
for (const value of slice) rms += value * value;
rms = Math.sqrt(rms / slice.length);

let bestHz = 0;
let bestMag = 0;
for (let hz = 40; hz <= 8000; hz += 1) {
  let real = 0;
  let imaginary = 0;
  const step = (2 * Math.PI * hz) / RATE;
  for (let i = 0; i < window; i++) {
    real += slice[i] * Math.cos(step * i);
    imaginary += slice[i] * Math.sin(step * i);
  }
  const magnitude = Math.hypot(real, imaginary);
  if (magnitude > bestMag) {
    bestMag = magnitude;
    bestHz = hz;
  }
}
console.log(
  `PCM ok: ${samples.length} samples (~${(samples.length / RATE).toFixed(1)}s), rms ${rms.toFixed(4)}, dominant ≈ ${bestHz} Hz`,
);
