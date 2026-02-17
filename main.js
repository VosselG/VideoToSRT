const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let pythonProcess;
let lastImportDir = null;      // Remembers last used import directory
let settingsFilePath = null;   // Path to small JSON settings file in userData

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 960,
        backgroundColor: '#0f0f0f',
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#0f0f0f',
            symbolColor: '#ffffff',
            height: 40
        },
        icon: path.join(__dirname, 'icon.ico'), // <--- ADD THIS LINE
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    
    mainWindow.setMenu(null); // Removes File/Edit/View toolbar
    
    // ... rest of function

    mainWindow.loadFile('src/index.html');
    
    // Open DevTools so we can see console logs
    // mainWindow.webContents.openDevTools(); 
}

function startPythonBackend() {
    let pythonPath;
    let args = [];

    if (app.isPackaged) {
        // --- PRODUCTION MODE (Inside the installed app) ---
        // Since we used --onedir, the executable is inside an 'engine' folder.
        // Path: resources/backend/engine/engine.exe
        const backendPath = path.join(process.resourcesPath, 'backend', 'engine', 'engine.exe');
        pythonPath = backendPath;
        args = []; 
        console.log("Production Mode: Launching", pythonPath);
    } else {
        // --- DEVELOPMENT MODE ---
        pythonPath = path.join(__dirname, 'venv', 'Scripts', 'python.exe');
        const scriptPath = path.join(__dirname, 'backend', 'engine.py');
        args = [scriptPath];
        console.log("Dev Mode: Launching", pythonPath);
    }

    // Spawn the process (hide console window on Windows)
    pythonProcess = spawn(pythonPath, args, {
        windowsHide: true
    });

    pythonProcess.stdout.on('data', (data) => {
        // Convert buffer to string
        const str = data.toString();
        
        // Python might send multiple JSON objects in one chunk, or mix in noise.
        // We split by newlines to handle them one by one.
        const lines = str.split('\n');

        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return; // Skip empty lines

            try {
                // Try to parse this specific line
                const msg = JSON.parse(trimmed);
                
                // If successful, send to UI
                if (mainWindow) {
                    mainWindow.webContents.send('python-output', JSON.stringify(msg));
                }
            } catch (e) {
                // If it fails, it's likely a TQDM progress bar or warning noise. 
                // We ignore it so it doesn't break the app.
                console.log("Python Non-JSON output:", trimmed);
            }
        });
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`Python Error: ${data}`);
    });
}

// Listen for data from the Frontend (Renderer)
ipcMain.on('to-python', (event, args) => {
    if (pythonProcess) {
        // Convert the object to a JSON string and send to Python
        pythonProcess.stdin.write(JSON.stringify(args) + "\n");
    }
});

app.whenReady().then(() => {
    // Initialize settings storage path and try to load lastImportDir from previous sessions
    settingsFilePath = path.join(app.getPath('userData'), 'videotosrt_settings.json');

    try {
        if (fs.existsSync(settingsFilePath)) {
            const raw = fs.readFileSync(settingsFilePath, 'utf-8');
            const data = JSON.parse(raw);
            if (data && typeof data.lastImportDir === 'string' && fs.existsSync(data.lastImportDir)) {
                lastImportDir = data.lastImportDir;
            }
        }
    } catch (e) {
        console.log('Failed to load settings file:', e);
    }

    createWindow();
    startPythonBackend();
});

app.on('window-all-closed', () => {
    if (pythonProcess) pythonProcess.kill();
    app.quit();
});

// --- NEW: Folder Selection Handler ---
const { dialog } = require('electron');

ipcMain.handle('select-folder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (result.canceled) return null;
    return result.filePaths[0]; // Return the selected path
});

// --- NEW: File Selection Handler ---
ipcMain.handle('select-files', async () => {
    if (!mainWindow) return [];

    // Determine starting folder:
    // - If we have a previously used import directory and it still exists, use it.
    // - Otherwise, default to Desktop.
    let defaultPath;
    if (lastImportDir && fs.existsSync(lastImportDir)) {
        defaultPath = lastImportDir;
    } else {
        defaultPath = app.getPath('desktop');
    }

    const result = await dialog.showOpenDialog(mainWindow, {
        defaultPath,
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Media Files', extensions: ['mp4', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'm4a'] }
        ]
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return [];
    }

    // Remember the directory of the first selected file for next time
    lastImportDir = path.dirname(result.filePaths[0]);

    // Persist lastImportDir across sessions in a small JSON file
    if (settingsFilePath) {
        try {
            const data = { lastImportDir };
            fs.writeFileSync(settingsFilePath, JSON.stringify(data), 'utf-8');
        } catch (e) {
            console.log('Failed to save settings file:', e);
        }
    }

    // Return array of objects to match the Drop format { path, name }
    return result.filePaths.map(p => ({
        path: p,
        name: path.basename(p)
    }));
});

// --- THEME & MODAL HANDLER ---
let currentTheme = 'dark';
let isModalOpen = false; // <--- NEW: Track state globally

function updateTitleBar() {
    if (!mainWindow) return;

    if (isModalOpen) {
        // DIMMED STATE
        if (currentTheme === 'dark') {
            mainWindow.setTitleBarOverlay({ color: '#030303', symbolColor: '#555555' });
        } else {
            mainWindow.setTitleBarOverlay({ color: '#303031', symbolColor: '#999999' });
        }
    } else {
        // ACTIVE STATE
        if (currentTheme === 'dark') {
            mainWindow.setTitleBarOverlay({ color: '#0f0f0f', symbolColor: '#ffffff' });
        } else {
            mainWindow.setTitleBarOverlay({ color: '#f0f2f5', symbolColor: '#000000' });
        }
    }
}

ipcMain.on('update-theme', (event, mode) => {
    currentTheme = mode;
    updateTitleBar(); // Uses the stored isModalOpen state
});

ipcMain.on('modal-toggle', (event, isOpen) => {
    isModalOpen = isOpen;
    updateTitleBar();
});