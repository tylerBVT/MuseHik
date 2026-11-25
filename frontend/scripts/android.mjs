// `npm run android`: builds the Angular app, then installs and starts it on the phone plugged in by USB
// (Capacitor would otherwise stop to ask which device to use when an emulator also exists).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const adb = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
if (!existsSync(adb)) {
  console.error(`adb not found at ${adb}. Install the Android SDK (Android Studio) or set ANDROID_HOME.`);
  process.exit(1);
}

// "RFGL21NC13M	device" lines; emulators are named "emulator-5554".
const phones = execFileSync(adb, ['devices'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .map((line) => line.split('\t'))
  .filter(([id, state]) => state === 'device' && !id.startsWith('emulator-'))
  .map(([id]) => id);

if (phones.length === 0) {
  console.error('No phone found. Plug it in by USB, unlock it and accept "Allow USB debugging".');
  process.exit(1);
}

const env = { ...process.env, ANDROID_HOME: sdk };
const npx = (args) => execFileSync('npx', args, { stdio: 'inherit', shell: true, env });
const androidDir = join(import.meta.dirname, '..', 'android');

npx(['ng', 'build']);
npx(['cap', 'sync', 'android']);
// Gradle by full path: `cap run` calls a bare "gradlew", which some Windows setups refuse to find in the current folder.
const gradlew = join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
execFileSync(gradlew, ['assembleDebug', '--console=plain', '-q'], { cwd: androidDir, stdio: 'inherit', shell: process.platform === 'win32', env });
const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
execFileSync(adb, ['-s', phones[0], 'install', '-r', apk], { stdio: 'inherit' });
execFileSync(adb, ['-s', phones[0], 'shell', 'am', 'start', '-n', 'com.musehik.app/.MainActivity'], { stdio: 'inherit' });
console.log(`MuseHik is running on ${phones[0]}.`);
