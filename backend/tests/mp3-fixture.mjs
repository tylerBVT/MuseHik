// A small valid MP3 for tests: ID3v2.3 tags (title, artist) + silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz).
// Not a test file itself (node --test only picks *.test.mjs here).
const FRAME_BYTES = 417; // 144 * 128000 / 44100, no padding
const SECONDS_PER_FRAME = 1152 / 44100;

function textFrame(id, text) {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]); // 0 = ISO-8859-1
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

const syncsafe = n => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

/** An MP3 of about `seconds`, tagged with `title` and `artist`. */
export function makeMp3({ title = 'Test Title', artist = 'Test Artist', seconds = 3 } = {}) {
  const frames = Buffer.concat([textFrame('TIT2', title), textFrame('TPE1', artist)]);
  const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), syncsafe(frames.length), frames]);
  const count = Math.round(seconds / SECONDS_PER_FRAME);
  const audio = Buffer.alloc(count * FRAME_BYTES);
  for (let i = 0; i < count; i++) audio.writeUInt32BE(0xfffb9000, i * FRAME_BYTES); // MPEG-1 L3, 128k, 44.1k, no CRC
  return Buffer.concat([id3, audio]);
}
