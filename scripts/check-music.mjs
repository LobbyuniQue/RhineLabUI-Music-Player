// Local music core checks: container parsing, search ranking, formatting.
// Runs on synthetic fixtures so it needs no real audio files, and additionally
// parses a real file only when RHINE_MUSIC_SAMPLE explicitly selects one.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {basename} from 'node:path';
import {readTrackMeta, metaFromFileName, isAudioFile, extensionOf} from '../src/music-metadata.ts';
import {MusicSearchIndex, matchSegments, formatDuration, formatLibrarySize, normalizeSearchText} from '../src/music-search.ts';
import {SpectrumEnvelope, RhythmMotion, quietBands, spectrumLoudness, rhythmDisplacement} from '../src/archive-play-motion.ts';
import {musicLabelLines} from '../src/music-label.ts';
import {clampRowSpacing, MUSIC_ROW_SPACING_DEFAULT, ROW_SPACING_MAX, ROW_SPACING_MIN, railFromRow, rowFromRail} from '../src/row-spacing.ts';

// Array.prototype.flat does not descend into TypedArrays, so flatten by hand.
const num = (...parts) => {
  const out = [];
  const push = value => {
    if (value instanceof Uint8Array) for (const byte of value) out.push(byte);
    else if (Array.isArray(value)) value.forEach(push);
    else out.push(value & 255);
  };
  parts.forEach(push);
  return Uint8Array.from(out);
};
const be = (value, width = 4) => Array.from({length: width}, (_, i) => (value >>> (8 * (width - 1 - i))) & 255);
const le = (value, width = 4) => Array.from({length: width}, (_, i) => (value >>> (8 * i)) & 255);
const chars = text => [...text].map(char => char.charCodeAt(0));
const syncsafe = value => [(value >>> 21) & 127, (value >>> 14) & 127, (value >>> 7) & 127, value & 127];
const read = (data, name) => readTrackMeta(new Blob([data]), name);

// ------------------------------------------------------------------ fixtures

function id3Frame(id, payload) {
  return num(chars(id), be(payload.length), [0, 0], payload);
}
const id3Text = (id, text, encoding = 3) =>
  id3Frame(id, num([encoding], encoding === 3 ? new TextEncoder().encode(text) : chars(text)));

function mp3Fixture() {
  const frames = num(
    id3Text('TIT2', '观测室主题'),
    id3Text('TPE1', 'Rhine Lab'),
    id3Text('TALB', '访问记录'),
    id3Text('TRCK', '7/12'),
    id3Text('TCON', '(52)Electronic'),
    id3Text('TYER', '2026'),
  );
  const tag = num(chars('ID3'), [3, 0, 0], syncsafe(frames.length), frames);
  const header = [0xff, 0xfb, 0x90, 0x00]; // MPEG1 L3, 128 kbps, 44.1 kHz, no padding
  const frameLength = Math.floor((144 * 128000) / 44100);
  const audio = num(header, new Uint8Array(frameLength - 4).fill(0x20), new Uint8Array(4000).fill(0x20));
  const id3v1 = num(chars('TAG'), new Uint8Array(125).fill(0));
  return {data: num(tag, audio, id3v1), tagBytes: tag.length, audioBytes: audio.length};
}

function flacFixture() {
  const streamInfo = new Uint8Array(34);
  streamInfo.set(be(4096, 2), 0);
  streamInfo.set(be(4096, 2), 2);
  // sampleRate(20) channels-1(3) bps-1(5) totalSamples(36)
  let packed = (44100n << 44n) | (1n << 41n) | (15n << 36n) | 441000n;
  for (let i = 7; i >= 0; i--) {
    streamInfo[10 + i] = Number(packed & 0xffn);
    packed >>= 8n;
  }
  const vendor = new TextEncoder().encode('reference libFLAC');
  const comments = ['TITLE=午夜观测', 'ARTIST=Rhine Lab', 'ALBUM=访问记录', 'TRACKNUMBER=3', 'DATE=2026-03-01'];
  const entries = comments.flatMap(text => {
    const raw = new TextEncoder().encode(text);
    return [...le(raw.length), ...raw];
  });
  const vorbis = num(le(vendor.length), vendor, le(comments.length), entries);
  return num(
    chars('fLaC'),
    [0x00], be(streamInfo.length, 3), streamInfo, // not last
    [0x84], be(vorbis.length, 3), vorbis, // type 4 + last flag
  );
}

function mp4Fixture() {
  const atom = (type, ...payload) => {
    const body = num(...payload);
    return num(be(body.length + 8), chars(type), body);
  };
  const data = (text, kind = 1) =>
    atom('data', be(kind), [0, 0, 0, 0], typeof text === 'string' ? new TextEncoder().encode(text) : text);
  const mvhd = atom('mvhd', [0, 0, 0, 0], be(0), be(0), be(1000), be(185000), new Uint8Array(80));
  const ilst = atom(
    'ilst',
    atom('\u00a9nam', data('玻璃与正文')),
    atom('\u00a9ART', data('Rhine Lab')),
    atom('\u00a9alb', data('内部档案')),
    atom('trkn', data([0, 0, 0, 5, 0, 12, 0, 0])),
  );
  const meta = atom('meta', [0, 0, 0, 0], atom('ilst', new Uint8Array(0)).slice(8), ilst);
  const moov = atom('moov', mvhd, atom('udta', meta));
  return num(atom('ftyp', chars('M4A '), be(0), chars('M4A mp42isom')), moov);
}

function oggFixture() {
  const page = (headerType, granule, payload) => {
    const segments = [Math.min(255, payload.length)];
    return num(
      chars('OggS'), [0, headerType], le(granule & 0xffffffff, 4), le(Math.floor(granule / 4294967296), 4),
      le(1), le(0), [0, 0, 0, 0], [segments.length], segments, payload,
    );
  };
  const ident = num(chars('\u0001vorbis'), le(0), [2], le(44100), le(0), le(160000), le(0), [0xb8, 1]);
  const vendor = new TextEncoder().encode('Xiph.Org');
  const comments = ['TITLE=解密线', 'ARTIST=Rhine Lab'];
  const entries = comments.flatMap(text => {
    const raw = new TextEncoder().encode(text);
    return [...le(raw.length), ...raw];
  });
  const comment = num(chars('\u0003vorbis'), le(vendor.length), vendor, le(comments.length), entries, [1]);
  return num(
    page(2, 0, ident),
    page(0, 0, comment),
    page(4, 441000, new Uint8Array(8)),
  );
}

function wavFixture() {
  const dataSize = 1764000; // 10 s at 176400 bytes/s
  return num(
    chars('RIFF'), le(dataSize + 36), chars('WAVE'),
    chars('fmt '), le(16), le(1, 2), le(2, 2), le(44100), le(176400), le(4, 2), le(16, 2),
    chars('data'), le(dataSize), new Uint8Array(64),
  );
}

// -------------------------------------------------------------------- checks

const mp3 = mp3Fixture();
const mp3Meta = await read(mp3.data, 'track.mp3');
assert.equal(mp3Meta.title, '观测室主题');
assert.equal(mp3Meta.artist, 'Rhine Lab');
assert.equal(mp3Meta.album, '访问记录');
assert.equal(mp3Meta.track, 7);
assert.equal(mp3Meta.genre, 'Electronic');
assert.equal(mp3Meta.year, '2026');
assert.equal(mp3Meta.codec, 'mp3');
assert.ok(mp3Meta.tagged, 'ID3v2 fields must mark the track as tagged');
assert.ok(mp3Meta.duration > 0.2 && mp3Meta.duration < 1.5, `CBR estimate expected, got ${mp3Meta.duration}`);
console.log(`mp3  : "${mp3Meta.title}" / ${mp3Meta.artist} / track ${mp3Meta.track} / ${mp3Meta.duration.toFixed(2)}s`);

const flacMeta = await read(flacFixture(), 'a.flac');
assert.equal(flacMeta.title, '午夜观测');
assert.equal(flacMeta.artist, 'Rhine Lab');
assert.equal(flacMeta.album, '访问记录');
assert.equal(flacMeta.track, 3);
assert.equal(flacMeta.year, '2026');
assert.equal(flacMeta.codec, 'flac');
assert.ok(Math.abs(flacMeta.duration - 10) < 0.01, `flac duration 10s expected, got ${flacMeta.duration}`);
console.log(`flac : "${flacMeta.title}" / ${flacMeta.artist} / ${flacMeta.duration}s`);

// Extended headers have different length conventions in ID3v2.3 and v2.4.
for (const version of [3, 4]) {
  const frames = id3Text('TIT2', 'Extended Header Song', 0);
  const extended = version === 3 ? num(be(6), [0, 0], be(0)) : num(syncsafe(6), [1, 0]);
  const header = num(chars('ID3'), [version, 0, 0x40], syncsafe(extended.length + frames.length));
  const meta = await read(num(header, extended, frames), 'fallback.mp3');
  assert.equal(meta.title, 'Extended Header Song', `ID3v2.${version} must skip the entire extended header`);
  assert.equal(meta.tagged, true);
  const tooLong = version === 3 ? be(1000) : syncsafe(1000);
  const invalid = num(chars('ID3'), [version, 0, 0x40], syncsafe(extended.length + frames.length), tooLong, extended.slice(4), frames);
  assert.equal((await read(invalid, 'fallback.mp3')).title, 'fallback', 'an out-of-bounds extended header must not expose fake frames');
}
console.log('id3  : extended v2.3/v2.4 headers and bounds');

const m4aMeta = await read(mp4Fixture(), 'b.m4a');
assert.equal(m4aMeta.title, '玻璃与正文');
assert.equal(m4aMeta.artist, 'Rhine Lab');
assert.equal(m4aMeta.album, '内部档案');
assert.equal(m4aMeta.track, 5);
assert.equal(m4aMeta.codec, 'm4a');
assert.ok(Math.abs(m4aMeta.duration - 185) < 0.01, `mvhd duration 185s expected, got ${m4aMeta.duration}`);
console.log(`m4a  : "${m4aMeta.title}" / ${m4aMeta.artist} / ${m4aMeta.duration}s`);

const oggMeta = await read(oggFixture(), 'c.ogg');
assert.equal(oggMeta.title, '解密线');
assert.equal(oggMeta.artist, 'Rhine Lab');
assert.ok(Math.abs(oggMeta.duration - 10) < 0.02, `granule duration 10s expected, got ${oggMeta.duration}`);
console.log(`ogg  : "${oggMeta.title}" / ${oggMeta.artist} / ${oggMeta.duration}s`);

const wavMeta = await read(wavFixture(), 'd.wav');
assert.equal(wavMeta.codec, 'wav');
assert.ok(Math.abs(wavMeta.duration - 10) < 0.01, `wav duration 10s expected, got ${wavMeta.duration}`);
assert.equal(wavMeta.title, 'd');
console.log(`wav  : fallback title "${wavMeta.title}" / ${wavMeta.duration}s`);

// Broken files must degrade to the file name instead of throwing.
const brokenMeta = await read(num(chars('not really audio'), new Uint8Array(300)), '03 - Someone - Broken Song.flac');
assert.equal(brokenMeta.title, 'Broken Song');
assert.equal(brokenMeta.artist, 'Someone');
assert.equal(brokenMeta.track, 3);
assert.equal(brokenMeta.codec, 'flac');
assert.ok(!brokenMeta.tagged);
console.log('broken: falls back to the file name without throwing');

// GBK bytes mislabelled as Latin-1 inside an ID3v2 tag.
const gbkBytes = Uint8Array.from([0xb9, 0xdb, 0xb2, 0xe2, 0xca, 0xd2]); // 观测室 in GBK
const gbkTag = num(
  chars('ID3'), [3, 0, 0], syncsafe(id3Frame('TIT2', num([0], gbkBytes)).length),
  id3Frame('TIT2', num([0], gbkBytes)),
);
const gbkMeta = await read(num(gbkTag, [0xff, 0xfb, 0x90, 0x00], new Uint8Array(600)), 'gbk.mp3');
assert.equal(gbkMeta.title, '观测室', `GBK fallback expected, got "${gbkMeta.title}"`);
console.log(`gbk  : latin1-mislabelled tag decoded as "${gbkMeta.title}"`);

assert.ok(isAudioFile('x.FLAC') && isAudioFile('y.mp3') && !isAudioFile('z.txt'));
assert.equal(extensionOf('a.b.M4A'), 'm4a');
assert.deepEqual(metaFromFileName('07 - Artist - Song.mp3'), {title: 'Song', artist: 'Artist', album: '', track: 7});

// -------------------------------------------------------------------- search

const tracks = [
  {title: '晴天', artist: '周杰伦', album: '叶惠美', name: '07 - 晴天.mp3', path: 'Jay/叶惠美/07 - 晴天.mp3', track: 7},
  {title: 'Observatory', artist: 'Rhine Lab', album: 'Access', name: '01 observatory.flac', path: 'Rhine/Access/01 observatory.flac', track: 1},
  {title: 'Decryption Line', artist: 'Rhine Lab', album: 'Access', name: '02 decryption.flac', path: 'Rhine/Access/02 decryption.flac', track: 2},
  {title: '夜航', artist: '五月天', album: '自传', name: '03 夜航.m4a', path: '五月天/自传/03 夜航.m4a', track: 3},
];
const index = new MusicSearchIndex(tracks);
assert.equal(index.search('周杰伦').length, 1);
assert.equal(index.search('周杰伦')[0].title, '晴天');
assert.equal(index.search('rhine')[0].artist, 'Rhine Lab');
assert.equal(index.search('access').length, 2);
assert.equal(index.search('07')[0].track, 7, 'bare numbers match track numbers');
assert.equal(index.search('夜航', 'artist').length, 0, 'artist filter excludes title matches');
assert.equal(index.search('夜航', 'title').length, 1);
assert.equal(index.search('decryption').length, 1);
assert.ok(index.search('rhine access').length === 2, 'multiple terms are ANDed');
assert.equal(index.search('rhine zzz').length, 0);
assert.equal(normalizeSearchText('  ＲＨＩＮＥ　Lab '), 'rhine lab', 'NFKC + whitespace folding');

const segments = matchSegments('Decryption Line', ['decrypt']);
assert.deepEqual(segments.map(s => [s.text, s.hit]), [['Decrypt', true], ['ion Line', false]]);
assert.deepEqual(matchSegments('晴天', ['晴']), [{text: '晴', hit: true}, {text: '天', hit: false}]);

assert.equal(formatDuration(0), '--:--');
assert.equal(formatDuration(59.4), '0:59');
assert.equal(formatDuration(605), '10:05');
assert.equal(formatDuration(3725), '1:02:05');
assert.equal(formatLibrarySize(0), '0 MB');
assert.equal(formatLibrarySize(2.5 * 1048576), '2.5 MB');
console.log('search: ranking, filters, track numbers, highlighting and formatting passed');

// ------------------------------------------------------ loudness rhythm (pulse)

const silence128 = new Float32Array(128);
const quiet128 = Float32Array.from({length: 128}, () => 0.05);
const loud128 = Float32Array.from({length: 128}, () => 0.5);
assert.equal(spectrumLoudness(silence128), 0, 'silence has zero loudness');
assert.ok(spectrumLoudness(loud128) > spectrumLoudness(quiet128) * 3, 'loudness follows level');
// Same energy in the same number of bins: placement decides perceived loudness.
const bassOnly128 = Float32Array.from({length: 128}, (_, i) => (i % 64 < 8 ? 0.4 : 0));
const topOnly128 = Float32Array.from({length: 128}, (_, i) => (i % 64 >= 56 ? 0.4 : 0));
assert.ok(spectrumLoudness(bassOnly128) > spectrumLoudness(topOnly128), 'low bands carry more perceived loudness');

// Envelope: loudness attacks quickly and releases slowly, and decays once the
// stream stops being fresh (paused playback / killed engine).
const envelope = new SpectrumEnvelope();
envelope.ingest(silence128, 0);
assert.equal(envelope.update(0.05, 0.05, true).loudness, 0);
envelope.ingest(loud128, 0.1);
const rising = envelope.update(0.05, 0.1, true).loudness;
assert.ok(rising > 0.5, `fast attack: loudness should jump on the first frames, got ${rising}`);
envelope.ingest(loud128, 0.15);
const settled = envelope.update(0.5, 0.15, true).loudness;
assert.ok(settled > rising, 'envelope keeps converging on sustained loudness');
const released = envelope.update(0.1, 0.8, true).loudness; // stream went stale → target 0
assert.ok(released > settled * 0.6 && released < settled, `slow release: ${settled} → ${released}`);

// Pulse displacement: silent → 0, loud → rises, centre card above edge card,
// and the strength slider scales it.
const fullFrame = pick => ({style: {legacy: 0, wave: 0, lift: 0, pulse: 0, ripple: 0, groove: 0, shimmer: 0, [pick]: 1}});
const pulseFrame = fullFrame('pulse');
const loudBands = {...quietBands(), loudness: 0.8};
assert.equal(rhythmDisplacement(3, 2, 1, quietBands(), 1, pulseFrame, 0.5), 0, 'pulse is quiet at silence');
const centreLift = rhythmDisplacement(3, 2, 1, loudBands, 1, pulseFrame, 0.5);
const edgeLift = rhythmDisplacement(3, 2, 1, loudBands, 1, pulseFrame, 0);
assert.ok(centreLift > 0.85 && centreLift < 1, `centre pump amplitude, got ${centreLift}`);
assert.ok(edgeLift < centreLift, 'edge cards pump less than the centre');
assert.ok(rhythmDisplacement(3, 2, 1, loudBands, 2, pulseFrame, 0.5) > centreLift, 'strength scales the pump');
const motion = new RhythmMotion();
const frame = motion.update(loudBands, 0, 1 / 30, 'pulse');
assert.ok('pulse' in frame.style && 'ripple' in frame.style, 'RhythmMotion crossfades every style');
for (const style of ['legacy', 'wave', 'lift']) {
  assert.equal(rhythmDisplacement(3, 2, 1, loudBands, 1, fullFrame(style), 0.5),
    rhythmDisplacement(3, 2, 1, {...loudBands, loudness: 0}, 1, fullFrame(style), 0.5),
    `${style} must not respond to loudness`);
}
console.log('pulse : loudness weighting, attack/release envelope and array pump passed');

// Ripple displacement: silent → 0; ring motion follows frequency content at
// equal loudness; rings travel over time; amplitude stays bounded by loudness.
const rippleFrame = fullFrame('ripple');
assert.equal(rhythmDisplacement(3, 2, 1, quietBands(), 1, rippleFrame, 0.5, 0.5), 0, 'ripple is quiet at silence');
const bassRings = {...quietBands(), loudness: 0.8, low: 0.6};
const trebleRings = {...quietBands(), loudness: 0.8, high: 0.6};
const dBass = rhythmDisplacement(3, 2, 1, bassRings, 1, rippleFrame, 0.2, 0.5);
const dTreble = rhythmDisplacement(3, 2, 1, trebleRings, 1, rippleFrame, 0.2, 0.5);
assert.notEqual(dBass.toFixed(4), dTreble.toFixed(4), 'equal loudness, different spectra → different ring motion');
assert.ok(Math.abs(dBass) <= 0.8 + 1e-9 && Math.abs(dTreble) <= 0.8 + 1e-9, 'ripple bounded by loudness');
const ringT0 = rhythmDisplacement(3, 2, 0.2, bassRings, 1, rippleFrame, 0.9, 0.5);
const ringT1 = rhythmDisplacement(3, 2, 0.9, bassRings, 1, rippleFrame, 0.9, 0.5);
assert.notEqual(ringT0.toFixed(4), ringT1.toFixed(4), 'rings travel over time');
console.log('ripple: frequency-shaped rings passed');

// Groove/shimmer and visual smoothing: new styles stay bounded, silent input
// stays silent, and crossfades converge without negative weights.
for (const style of ['groove', 'shimmer']) {
  const styleMotion = new RhythmMotion();
  let styleFrame;
  for (let i = 0; i < 180; i++) styleFrame = styleMotion.update({...quietBands(), low: .7, mid: .45, high: .25, loudness: .65, activity: 1}, i / 60, 1 / 60, style);
  assert.ok(styleFrame.style[style] > .98, `${style} crossfade converges`);
  assert.ok(Object.values(styleFrame.style).every(value => Number.isFinite(value) && value >= 0), `${style} weights remain finite`);
  const displacement = rhythmDisplacement(7, 2, 3, loudBands, 1, styleFrame, .5, .5);
  assert.ok(Number.isFinite(displacement) && displacement >= 0 && displacement <= 1.8, `${style} displacement bounded`);
  let quietFrame = styleFrame;
  for (let i = 0; i < 180; i++) quietFrame = styleMotion.update(quietBands(), 3 + i / 60, 1 / 60, style);
  assert.ok(rhythmDisplacement(7, 2, 3, quietBands(), 1, quietFrame, .5, .5) < 1e-5, `${style} silence decays to quiet`);
}
const smoothMotion = new RhythmMotion();
let previous = 0;
for (let i = 0; i < 40; i++) {
  const frame = smoothMotion.update({...quietBands(), low: .8, loudness: .7, activity: 1}, i / 60, 1 / 60, 'groove');
  const current = frame.bands.low;
  assert.ok(current >= previous - 1e-9, 'visual band attack is monotonic');
  previous = current;
}
for (let i = 0; i < 120; i++) {
  const frame = smoothMotion.update(quietBands(), 1 + i / 60, 1 / 60, 'groove');
  assert.ok(frame.bands.low >= -1e-9 && frame.bands.low <= 1, 'visual band release is bounded');
}
const grooveFrame = fullFrame('groove');
const shimmerFrame = fullFrame('shimmer');
assert.ok(rhythmDisplacement(7, 2, 3, {...quietBands(), low: .7, loudness: .7}, 1, grooveFrame, .5) > rhythmDisplacement(7, 2, 3, {...quietBands(), high: .7, loudness: .7}, 1, grooveFrame, .5), 'groove favors bass');
assert.notEqual(rhythmDisplacement(7, 2, 3, {...quietBands(), mid: .6, loudness: .7}, 1, shimmerFrame, .5).toFixed(4), rhythmDisplacement(7, 2, 3, {...quietBands(), high: .6, loudness: .7}, 1, shimmerFrame, .5).toFixed(4), 'shimmer responds to spectral detail');
console.log('groove/shimmer: bounded styles, crossfade convergence and visual smoothing passed');

// ------------------------------------------------------ music archive view (2.0)

const {buildMusicView, nameInitial} = await import('../src/music-grouping.ts');
const {rhineView} = await import('../src/archive-view.ts');

// Rhine archive view: identical geometry to the original static data wiring.
assert.equal(rhineView.columns.length, 5);
assert.equal(rhineView.records.length, 40);
for (let lane = 0; lane < 5; lane++) assert.equal(rhineView.columnFiles(lane).length, 8, `lane ${lane} keeps 8 records`);
{
  const loc = rhineView.fileLocation(0);
  assert.equal(rhineView.fileAtSlot(loc.slot), 0, 'rhine slot round-trip');
  assert.equal(rhineView.backingId(0), 'X-001');
}

// Pinyin initials via ICU collation: CJK artists land on the right letters.
assert.equal(nameInitial('周杰伦'), 'Z');
assert.equal(nameInitial('陈奕迅'), 'C');
assert.equal(nameInitial('林俊杰'), 'L');
assert.equal(nameInitial('阿杜'), 'A');
assert.equal(nameInitial('Radiohead'), 'R');
assert.equal(nameInitial('塑料3'), 'S');
assert.equal(nameInitial('3 Doors Down'), '#');
assert.equal(nameInitial(''), '#');

// Grouping: albums become columns, disc/track order is preserved inside.
const mk = (id, title, artist, album, track, extra = {}) => ({id, title, artist, album, track, name: id, path: id, duration: 60, codec: 'flac', genre: '', year: '', disc: null, tagged: true, hasCover: false, missing: false, size: 1, modified: 0, ...extra});
const lib = [
  mk('t1', 'B歌曲', 'Beta', 'Gamma', 2),
  mk('t2', 'A歌曲', 'Beta', 'Gamma', 1),
  mk('t3', 'C歌曲', 'Alpha', 'Delta', 1),
  mk('t4', 'D歌曲', 'Alpha', '', 1),
  mk('t5', 'E歌曲', '', 'Delta', 3),
];
const albumView = buildMusicView(lib, 'album');
assert.deepEqual([...albumView.columns], ['Delta', 'Gamma', '未标记专辑'], 'album columns sorted, unknown last');
assert.deepEqual(albumView.columnFiles(1).map(i => albumView.records[i].title), ['A歌曲', 'B歌曲'], 'album members ordered by track number');
assert.equal(albumView.records[0].category, 'Delta');
assert.equal(albumView.musicTracks[0].id, albumView.backingId(0), 'music archive record maps to the real track id');
assert.equal(albumView.musicTracks[0].title, albumView.records[0].title, 'music archive record stays parallel to its track');
assert.equal(albumView.records[0].clearance, 'FLAC');
assert.equal(albumView.backingId(0), 't3', 'backing id tracks the source track');
assert.equal(albumView.musicTracks.length, 5);
{
  const loc = albumView.fileLocation(3);
  assert.deepEqual({lane: loc.lane, row: loc.row}, {lane: 1, row: 13}, 'fileLocation: lane from group, row from in-column order');
}
const artistView = buildMusicView(lib, 'artist');
assert.deepEqual([...artistView.columns], ['Alpha', 'Beta', '未知艺术家']);
assert.deepEqual(artistView.columnFiles(0).map(i => artistView.records[i].department), ['未标记专辑', 'Delta'], 'artist members ordered by album');
const letterView = buildMusicView(lib, 'letter');
assert.deepEqual([...letterView.columns], ['A', 'B', 'E']);
assert.equal(letterView.columnFiles(2).length, 1, 'unknown artist falls back to title initial');
// Detail mapping gives every record a displayable, non-empty shape.
for (const record of albumView.records) {
  assert.ok(record.id.startsWith('M-') && record.title && record.en && record.department && record.category && record.clearance && record.abstract);
  assert.ok(record.findings.length >= 3 && record.source === '');
}
console.log('group : album/artist/letter columns, ordering and view records passed');
const labelLines = musicLabelLines(albumView.records[0]);
assert.equal(labelLines.primary, albumView.records[0].title, 'music label puts song title first');
assert.equal(labelLines.secondary, `${albumView.records[0].en} · ${albumView.records[0].department}`, 'music label puts artist and album second');
const fallbackLabel = musicLabelLines({en: '  ', title: '  ', department: '  '});
assert.equal(fallbackLabel.primary, '未命名曲目');
assert.equal(fallbackLabel.secondary, '');
assert.equal(clampRowSpacing(Number.NaN), MUSIC_ROW_SPACING_DEFAULT);
assert.equal(clampRowSpacing(0), ROW_SPACING_MIN);
assert.equal(clampRowSpacing(99), ROW_SPACING_MAX);
for (const spacing of [ROW_SPACING_MIN, MUSIC_ROW_SPACING_DEFAULT, ROW_SPACING_MAX]) {
  for (const row of [-120, 12, 15.5, 3080]) assert.ok(Math.abs(rowFromRail(railFromRow(row, spacing), spacing) - row) < 1e-9, `row/rail conversion at ${spacing}`);
}
console.log('label/spacing : title-first label order, spacing bounds and drag coordinate round trips passed');

// -------------------------------------------------------------- real samples

const samples = process.env.RHINE_MUSIC_SAMPLE ? [process.env.RHINE_MUSIC_SAMPLE] : [];
let real = 0;
for (const path of samples) {
  if (!existsSync(path)) continue;
  const data = new Uint8Array(await (await import('node:fs/promises')).readFile(path));
  const meta = await read(data, basename(path));
  assert.ok(meta.title, `${path} must resolve a title`);
  assert.ok(meta.duration === null || meta.duration > 0, `${path} duration must be positive`);
  console.log(`real : ${basename(path)} → "${meta.title}" / "${meta.artist}" / ${meta.codec} / ${formatDuration(meta.duration)}`);
  real++;
}
console.log(real ? `${real} real file(s) parsed.` : 'No local sample files found; synthetic fixtures only.');
console.log('Local music core checks passed.');
