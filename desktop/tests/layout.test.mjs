// Where the desktop app finds the backend, Node, Python and the built app, and where it keeps the user's data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { layout } from '../layout.mjs';

const base = {
  resourcesPath: 'C:\Apps\MuseHik\resources', repoRoot: 'C:\code\MuseHik',
  appData: 'C:\Users\M\AppData\Roaming', localAppData: 'C:\Users\M\AppData\Local', music: 'C:\Users\M\Music',
  version: '1.2.3', devNode: 'C:\node\node.exe',
};

test('packaged layout points into resources and sets installed env', () => {
  const l = layout({ ...base, packaged: true });
  assert.equal(l.node, join(base.resourcesPath, 'node', 'node.exe'));
  assert.equal(l.backendDir, join(base.resourcesPath, 'backend'));
  assert.equal(l.pythonTemplate, join(base.resourcesPath, 'python'));
  assert.equal(l.pythonDir, join(base.localAppData, 'MuseHik', 'python'));
  assert.equal(l.logFile, join(base.localAppData, 'MuseHik', 'logs', 'server.log'));
  assert.deepEqual(
    { ...l.env },
    {
      PORT: '38517',
      MUSEHIK_VERSION: '1.2.3',
      MUSEHIK_INSTALLED: '1',
      MUSEHIK_DATA_DIR: join(base.appData, 'MuseHik'),
      MUSEHIK_DEFAULT_MUSIC_DIR: join(base.music, 'MuseHik'),
      MUSEHIK_WEB_ROOT: join(base.resourcesPath, 'web'),
      CLOUD_CACHE_DIR: join(base.localAppData, 'MuseHik', 'cloudCache'),
      PYTHON_BIN: join(base.localAppData, 'MuseHik', 'python', 'python.exe'),
    },
  );
});

test('dev layout uses the repo and no data dir override', () => {
  const l = layout({ ...base, packaged: false });
  assert.equal(l.node, base.devNode);
  assert.equal(l.backendDir, join(base.repoRoot, 'backend'));
  assert.equal(l.pythonTemplate, null);
  assert.equal(l.logFile, join(base.repoRoot, 'desktop', 'server.log'));
  assert.deepEqual({ ...l.env }, { PORT: '38517', MUSEHIK_VERSION: '1.2.3' });
});
