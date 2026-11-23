// Releases a new version of the app: npm run release [patch|minor|major]   (default: patch)
// Checks that main is clean and the tests pass, bumps desktop/package.json, commits, tags vX.Y.Z and pushes.
// GitHub Actions (.github/workflows/release.yml) then builds the installer and publishes it; installed apps update.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(desktop, '..');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const fail = message => { console.error(`\n${message}`); process.exit(1); };

const part = process.argv[2] || 'patch';
if (!['patch', 'minor', 'major'].includes(part)) fail('Usage: npm run release [patch|minor|major]');
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('Release from the main branch (git checkout main).');
if (git('status', '--porcelain')) fail('Commit or stash your changes first (git status).');

for (const dir of ['backend', 'desktop']) {
  console.log(`> npm test (${dir})`);
  if (spawnSync('npm', ['test'], { cwd: join(repo, dir), stdio: 'inherit', shell: true }).status !== 0) fail(`Tests failed in ${dir}: nothing was released.`);
}

const file = join(desktop, 'package.json');
const pkg = JSON.parse(readFileSync(file, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
pkg.version = part === 'major' ? `${major + 1}.0.0` : part === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);

const tag = `v${pkg.version}`;
git('add', file);
git('commit', '-m', `release: ${tag}`);
git('tag', tag);
git('push', 'origin', 'main', '--follow-tags');
const remote = git('remote', 'get-url', 'origin').replace(/\.git$/, '');
console.log(`\nReleased ${tag}. The installer is being built: ${remote}/actions`);
console.log('When it is done, installed apps download it and show "A new version of MuseHik is ready."');
