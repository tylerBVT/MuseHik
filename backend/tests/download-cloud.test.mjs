// "Also send to the cloud" in the downloader.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-dlcloud-'));
mkdirSync(join(tmp, 'music'));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json'); // never written: the cloud is not set up here
const { server } = await import('../server.mjs');
const { cloudSelection } = await import('../modules/musicDownloader/jobs.mjs');

let base;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

test('the songs sent are the new files plus the ones already in the library', () => {
  const job = {
    files: ['C:/music/A - New.mp3', 'C:/music/B - New.mp3'],
    skippedList: [{ match: { id: 7 } }, { match: null }, {}, { match: { id: 9 } }],
  };
  assert.deepEqual(cloudSelection(job), { paths: ['C:/music/A - New.mp3', 'C:/music/B - New.mp3'], trackIds: [7, 9] });
  assert.deepEqual(cloudSelection({ files: [], skippedList: [] }), { paths: [], trackIds: [] });
});

test('sending to the cloud before it is set up is refused with a reason', async () => {
  const response = await fetch(`${base}/download`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/not-a-music-link', toCloud: true }), // never downloads anything
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Set up the cloud in Settings first/);
});
