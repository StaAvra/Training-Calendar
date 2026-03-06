const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    onStravaAuth: (callback) => {
        ipcRenderer.on('strava-auth-success', (event, data) => callback(data));
    }
});
