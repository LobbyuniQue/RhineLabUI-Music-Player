import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_ROOT, resetLocalDirectory } from "./workspace-paths.mjs";

export const FIXTURE_ARTIST = "Rhine Lab";
export const FIXTURE_PATHS = [
  "观测室/01 Business Test Music.mp3",
  "观测室/02 测试正弦 440Hz.wav",
  "观测室/03 测试正弦 6kHz.wav",
  "观测室/04 测试正弦 60Hz.wav",
  "测试录音/05 测试录音.wav",
];

export function sineWav(seconds, hz, sampleRate = 44100) {
  const frames = seconds * sampleRate;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(
      Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.85 * 32767,
    );
    data.writeInt16LE(value, i * 4);
    data.writeInt16LE(value, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function textFrame(id, text) {
  const payload = Buffer.concat([Buffer.from([3]), Buffer.from(text, "utf8")]);
  const header = Buffer.alloc(10);
  header.write(id, 0, "ascii");
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

export async function taggedMusic() {
  // Reuse the project's original score instead of personal recordings.
  let audio = await readFile(
    join(PROJECT_ROOT, "public", "audio", "observatory-preview.mp3"),
  );
  if (audio.subarray(0, 3).toString("ascii") === "ID3") {
    const size =
      ((audio[6] & 127) << 21) |
      ((audio[7] & 127) << 14) |
      ((audio[8] & 127) << 7) |
      (audio[9] & 127);
    audio = audio.subarray(10 + size + (audio[5] & 16 ? 10 : 0));
  }
  if (audio.subarray(-128, -125).toString("ascii") === "TAG")
    audio = audio.subarray(0, -128);
  const frames = Buffer.concat([
    textFrame("TIT2", "Business Test Music"),
    textFrame("TPE1", FIXTURE_ARTIST),
    textFrame("TALB", "观测室"),
    textFrame("TRCK", "1"),
  ]);
  const header = Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 4; i++)
    header[6 + i] = (frames.length >>> (7 * (3 - i))) & 127;
  return Buffer.concat([header, frames, audio]);
}

export async function buildMusicFixtures(target) {
  // target must be an owned folder inside .local; old samples stay in music-legacy.
  await resetLocalDirectory(target);
  const files = [
    await taggedMusic(),
    sineWav(6, 440),
    sineWav(6, 6000),
    sineWav(6, 60),
    sineWav(6, 220),
  ];
  for (let i = 0; i < FIXTURE_PATHS.length; i++) {
    const destination = join(target, FIXTURE_PATHS[i]);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, files[i]);
  }
}
