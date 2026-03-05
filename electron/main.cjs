const { app, BrowserWindow } = require('electron');
const path = require('path');
const isDev = !app.isPackaged;

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
        title: "Training Calendar V0.1",
        autoHideMenuBar: true
    });

    if (isDev) {
        win.loadURL('http://localhost:5173');
    } else {
        // Use app.getAppPath() for reliable path in packaged app
        const appPath = app.getAppPath();
        const indexPath = path.join(appPath, 'dist', 'index.html');
        console.log('Loading file:', indexPath);
        win.loadFile(indexPath);
    }

    win.webContents.on('crashed', () => {
        console.error('Renderer process crashed');
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
