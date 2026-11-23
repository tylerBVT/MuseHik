// What the app page may ask the desktop app (frontend/src/app/core/desktop.ts describes it).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('musehik', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  onUpdateReady: callback => {
    ipcRenderer.on('update-ready', (_event, version) => callback(version));
    // Downloaded before the page was there: tell it now.
    ipcRenderer.invoke('update-state').then(state => {
      if (state.status === 'ready') callback(state.version);
    });
  },
  restartToUpdate: () => ipcRenderer.send('restart-to-update'),
  checkForUpdates: () => ipcRenderer.invoke('check-updates'),
});
