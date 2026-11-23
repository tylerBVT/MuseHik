// The Windows "choose a folder" window, opened by the server (it runs on the same laptop as the app window).
// The desktop app has its own native picker (desktop/preload.cjs); this one is for the browser (MuseHik.bat).
import { spawn } from 'node:child_process';

/** Opens the Windows folder picker, on top of other windows. Resolves with the chosen folder, or null. */
export function pickFolder(description = 'Choose a folder') {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = $env:MUSEHIK_PICK_TEXT',
    'if ($dialog.ShowDialog($owner) -eq "OK") { [Console]::Out.Write($dialog.SelectedPath) }',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      windowsHide: true, env: { ...process.env, MUSEHIK_PICK_TEXT: description },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim() || null));
  });
}
