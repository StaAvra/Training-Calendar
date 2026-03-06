const { app, BrowserWindow } = require('electron');
const path = require('path');
const isDev = !app.isPackaged;

const PROTOCOL = 'velotrain';
app.setAsDefaultProtocolClient(PROTOCOL);

let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
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
        mainWindow.loadURL('http://localhost:5173');
    } else {
        const appPath = app.getAppPath();
        const indexPath = path.join(appPath, 'dist', 'index.html');
        mainWindow.loadFile(indexPath);
    }

    mainWindow.webContents.on('crashed', () => {
        console.error('Renderer process crashed');
    });
}

// Ensure single instance lock for deep linking to work gracefully on Windows/Linux
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
        
        // The deep link URL is often the last argument
        const url = commandLine.pop();
        handleDeepLink(url);
    });

    app.whenReady().then(() => {
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });

    // Handle deep links on macOS
    app.on('open-url', (event, url) => {
        event.preventDefault();
        handleDeepLink(url);
    });
}

function handleDeepLink(url) {
    if (!url || !url.startsWith(`${PROTOCOL}://`)) return;

    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.hostname === 'auth') {
            const params = Object.fromEntries(parsedUrl.searchParams.entries());
            if (params.access_token && mainWindow) {
                // Wait for the window to be ready
                if (mainWindow.webContents.isLoading()) {
                    mainWindow.webContents.once('did-finish-load', () => {
                        mainWindow.webContents.send('strava-auth-success', params);
                    });
                } else {
                    mainWindow.webContents.send('strava-auth-success', params);
                }
            }
        }
    } catch (e) {
        console.error('Error parsing deep link:', e);
    }
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
