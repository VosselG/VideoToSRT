const {
    ipcRenderer,
    shell
} = require('electron');
const path = require('path');
const fs = require('fs');

// --- STATE ---
let fileQueue = [];
let isProcessing = false;
let isFileDialogOpen = false;
let draggedItemIndex = null;
let lastSavePath = null; // Track last successfully saved output file
let settingsSnapshot = null; // Stores settings before editing

let userPresets = JSON.parse(localStorage.getItem('userPresets')) || {};
let globalSettings = JSON.parse(localStorage.getItem('globalSettings')) || {
    model: 'enhanced',
    language: 'auto',
    autoOpen: false,
    device: 'auto',
    theme: 'dark',
    outputDir: ''          // Empty string means "Same as source"
};

// --- DOM ELEMENTS ---
const simpleView = document.getElementById('view-simple');
const advancedView = document.getElementById('view-advanced');
const navToAdvanced = document.getElementById('nav-right');
const navToSimple = document.getElementById('nav-left');

// Modal
const modal = document.getElementById('settings-modal');
const btnCancelModal = document.getElementById('btn-cancel-modal');
const btnSaveModal = document.getElementById('btn-save-modal');
const btnCloseX = document.getElementById('btn-close-x');
const globalModelSelect = document.getElementById('global-model');
const globalLangSelect = document.getElementById('global-lang');
const globalDeviceSelect = document.getElementById('global-device');
const globalAutoOpen = document.getElementById('global-auto-open');

// Simple Mode
const queueContainer = document.getElementById('queue-container');
const queueList = document.getElementById('queue-list');
const emptyMsg = document.getElementById('empty-msg');
const simplePresetSelect = document.getElementById('simple-preset-select');
const presetLabel = document.getElementById('preset-label');
const formatSelect = document.getElementById('format-select');
const convertBtn = document.getElementById('convert-btn');

// Advanced Mode
const advBaseLogic = document.getElementById('adv-base-logic');
const advMaxChars = document.getElementById('adv-max-chars');
const advMaxLines = document.getElementById('adv-max-lines');
const advProfanity = document.getElementById('adv-profanity');
const advPresetName = document.getElementById('adv-preset-name');
const btnSavePreset = document.getElementById('btn-save-preset');
const miniPresetList = document.getElementById('mini-preset-list');

// NEW: Overwrite Modal Elements
const overwriteModal = document.getElementById('overwrite-modal');
const btnCancelOverwrite = document.getElementById('btn-cancel-overwrite');
const btnConfirmOverwrite = document.getElementById('btn-confirm-overwrite');
let pendingPresetData = null; // Stores data while waiting for confirmation

// --- THEME LOGIC ---
const globalThemeToggle = document.getElementById('global-theme');

// --- OUTPUT FOLDER LOGIC ---
const globalOutputPath = document.getElementById('global-output-path');
const btnBrowseFolder = document.getElementById('btn-browse-folder');
const btnClearFolder = document.getElementById('btn-clear-folder');

function updateOutputUI() {
    if (globalSettings.outputDir) {
        globalOutputPath.value = globalSettings.outputDir;
        globalOutputPath.style.color = "var(--text-main)";
    } else {
        globalOutputPath.value = ""; // Shows placeholder
        globalOutputPath.style.color = "var(--text-muted)";
    }
}

// Allow pressing Enter in the text box to save
advPresetName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.repeat) {
        e.preventDefault(); // Stop newline
        btnSavePreset.click();
    }
});

btnBrowseFolder.addEventListener('click', async () => {
    const path = await ipcRenderer.invoke('select-folder');
    if (path) {
        globalSettings.outputDir = path;
        updateOutputUI();
    }
});

btnClearFolder.addEventListener('click', () => {
    globalSettings.outputDir = '';
    updateOutputUI();
});

// Update the Modal "Open" listener to load the current setting
document.querySelectorAll('.gear-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        // 1. Take Snapshot
        settingsSnapshot = JSON.parse(JSON.stringify(globalSettings));

        // 2. Populate UI
        globalModelSelect.value = globalSettings.model;
        globalLangSelect.value = globalSettings.language;
        globalDeviceSelect.value = globalSettings.device;
        globalAutoOpen.checked = globalSettings.autoOpen;
        
        updateOutputUI(); 

        modal.classList.remove('hidden');
        ipcRenderer.send('modal-toggle', true);
    });
});

function applyTheme(isDark) {
    if (isDark) {
        document.body.removeAttribute('data-theme');
        globalThemeToggle.checked = true;
        ipcRenderer.send('update-theme', 'dark');
    } else {
        document.body.setAttribute('data-theme', 'light');
        globalThemeToggle.checked = false;
        ipcRenderer.send('update-theme', 'light');
    }
}

// Apply immediately on load
applyTheme(globalSettings.theme === 'dark');

// --- INIT ---
// Set Version Dynamically
const appVersion = require('../package.json').version;
document.getElementById('app-version').innerText = `v${appVersion}`;

refreshSimpleDropdown();
refreshMiniList();
updateWorkbenchUI();
updateFormatUI();

// --- QUEUE SYSTEM ---
function addFilesToQueue(files) {
    emptyMsg.classList.add('hidden');
    Array.from(files).forEach(f => {
        if (fileQueue.find(item => item.path === f.path)) return;
        const id = Date.now() + Math.random();

        const ext = path.extname(f.path || f.name || '').toLowerCase();
        const audioExts = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'];
        const isAudio = audioExts.includes(ext);

        fileQueue.push({
            id: id,
            path: f.path,
            name: f.name,
            status: 'pending',
            meta: null,
            isAudio: isAudio
        });
        ipcRenderer.send('to-python', {
            command: 'analyze',
            path: f.path
        });
    });
    renderQueue();
    updateConvertButton();
}

function renderQueue() {
    queueList.innerHTML = '';

    fileQueue.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'file-card';
        div.draggable = true;

        const duration = item.meta ? item.meta.duration : '--:--';

        let thumbHTML;
        if (item.isAudio) {
            thumbHTML = `<div class="thumb-audio">AUDIO</div>`;
        } else {
            const thumbSrc = item.meta && item.meta.thumbnail ? item.meta.thumbnail : '';
            const thumbAttr = thumbSrc ? `src="${thumbSrc}"` : '';
            thumbHTML = `<img class="file-thumb" ${thumbAttr}>`;
        }

        // Status Badge Logic
        let statusLabel = item.status.toUpperCase();
        if (item.status === 'pending') statusLabel = 'READY';

        div.innerHTML = `
            <div class="thumb-wrapper">${thumbHTML}</div>
            <div class="file-info">
                <div class="file-name" title="${item.path}">${item.name}</div>
                <div class="file-meta">${duration}</div>
                <div class="progress-container">
                    <div class="progress-bar" id="progress-${item.id}" style="width: ${item.status === 'done' ? '100%' : '0%'}"></div>
                </div>
            </div>
            <div class="status-badge ${item.status}">${statusLabel}</div>
            <button class="btn-remove"><span class="material-symbols-outlined">delete</span></button>
        `;

        if (item.status === 'processing') div.classList.add('processing');

        // Listeners
        div.querySelector('.btn-remove').onclick = (e) => {
            e.stopPropagation();
            removeFromQueue(item.id);
        };

        // Sorting Logic (Drag events)
        div.addEventListener('dragstart', (e) => {
            draggedItemIndex = index;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', 'internal-sort');
        });
        div.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (draggedItemIndex !== null && draggedItemIndex !== index) {
                const movedItem = fileQueue.splice(draggedItemIndex, 1)[0];
                fileQueue.splice(index, 0, movedItem);
                draggedItemIndex = index;
                renderQueue();
            }
        });

        queueList.appendChild(div);
    });

    if (fileQueue.length === 0) emptyMsg.classList.remove('hidden');
}

function removeFromQueue(id) {
    if (isProcessing) return;
    fileQueue = fileQueue.filter(x => x.id !== id);
    renderQueue();
    updateConvertButton();
}

function updateConvertButton() {
    const count = fileQueue.length;
    convertBtn.disabled = count === 0 || isProcessing;
    convertBtn.textContent = isProcessing ? "PROCESSING..." : `PROCESS BATCH (${count})`;
}

// --- QUEUE PROCESSOR ---
async function processQueue() {
    const pending = fileQueue.find(x => x.status === 'pending');
    // 2. If no pending, we are done
    if (!pending) {
        // Ensure visual state matches memory state
        const stuck = fileQueue.find(x => x.status === 'processing');
        if (stuck) stuck.status = 'done';
        renderQueue();

        isProcessing = false;
        updateConvertButton();

        // Auto-open (or focus) the output folder when enabled
        if (globalSettings.autoOpen && lastSavePath) {
            // showItemInFolder:
            // - If the folder is already open, Windows usually focuses that window
            //   and highlights the file (taskbar icon flashes).
            // - If it's not open, it opens a new Explorer window for that folder.
            shell.showItemInFolder(lastSavePath);
        }

        return;
    }

    isProcessing = true;
    updateConvertButton();
    pending.status = 'processing';
    renderQueue();

    // Settings logic
    const presetName = simplePresetSelect.value;
    const format = formatSelect.value;
    const settings = getPresetSettings(presetName);
    const langCode = (globalSettings.language && globalSettings.language !== 'auto') ? globalSettings.language : 'auto';
    const cleanPreset = presetName.replace(/[^a-zA-Z0-9]/g, "");
    const outputSuffix = `${langCode}_${cleanPreset}`;

    const payload = {
        command: "transcribe",
        path: pending.path,
        model: globalSettings.model,
        language: globalSettings.language,
        device: globalSettings.device,
        format: format,
        outputName: outputSuffix,
        outputDir: globalSettings.outputDir,
        preset: settings.logic,
        maxChars: parseInt(settings.maxChars),
        maxLines: parseInt(settings.maxLines),
        profanity: settings.profanity
    };

    ipcRenderer.send('to-python', payload);
}

function getPresetSettings(name) {
    if (userPresets[name]) return userPresets[name];
    return {
        logic: name,
        maxChars: 42,
        maxLines: 2,
        profanity: false
    };
}

// --- EVENT LISTENERS ---

// --- DRAG & DROP & CLICK ---
// 1. Handle Dragging
queueContainer.addEventListener('dragover', (e) => { 
    e.preventDefault(); 
    if (e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('text/plain')) {
        queueContainer.classList.add('drag-over'); 
    }
});
queueContainer.addEventListener('dragleave', () => queueContainer.classList.remove('drag-over'));
queueContainer.addEventListener('drop', (e) => {
    e.preventDefault(); queueContainer.classList.remove('drag-over');
    if (draggedItemIndex !== null) return; // Internal Sort
    if (e.dataTransfer.files.length > 0) addFilesToQueue(e.dataTransfer.files);
});

// 2. Handle Clicking (To Open Picker)
queueContainer.addEventListener('click', async (e) => {
    if (e.target.closest('.file-card') || e.target.closest('.btn-remove')) return;
    
    // Prevent opening multiple windows
    if (isFileDialogOpen) return;

    isFileDialogOpen = true;
    try {
        const files = await ipcRenderer.invoke('select-files');
        if (files && files.length > 0) {
            addFilesToQueue(files);
        }
    } finally {
        isFileDialogOpen = false;
    }
});

// UI: Handle Format Change (Gray out preset for TXT)
formatSelect.addEventListener('change', updateFormatUI);

function updateFormatUI() {
    if (formatSelect.value === 'txt') {
        simplePresetSelect.disabled = true;
        simplePresetSelect.style.opacity = '0.5';
        presetLabel.textContent = "Format Preset (Ignored for .TXT)";
        presetLabel.style.opacity = '0.7';
    } else {
        simplePresetSelect.disabled = false;
        simplePresetSelect.style.opacity = '1';
        presetLabel.textContent = "Format Preset";
        presetLabel.style.opacity = '1';
    }
}

convertBtn.addEventListener('click', () => {
    if (isProcessing) return;
    let resetCount = 0;
    fileQueue.forEach(f => {
        if (f.status === 'done' || f.status === 'error') {
            f.status = 'pending';
            resetCount++;
        }
    });
    if (resetCount > 0) renderQueue();
    processQueue();
});

function closeModal() {
    modal.classList.add('hidden');
    ipcRenderer.send('modal-toggle', false);
}

function cancelChanges() {
    // Restore from snapshot
    if (settingsSnapshot) {
        globalSettings = JSON.parse(JSON.stringify(settingsSnapshot));
        
        // Revert Visuals
        applyTheme(globalSettings.theme === 'dark');
        updateOutputUI();
    }
    closeModal();
}

// Bind Buttons
btnCancelModal.addEventListener('click', cancelChanges);
btnCloseX.addEventListener('click', cancelChanges);

btnCancelModal.addEventListener('click', closeModal);
btnCloseX.addEventListener('click', closeModal);

btnSaveModal.addEventListener('click', () => {
    globalSettings.model = globalModelSelect.value;
    globalSettings.language = globalLangSelect.value;
    globalSettings.device = globalDeviceSelect.value;
    globalSettings.autoOpen = globalAutoOpen.checked;

    // Save Theme
    globalSettings.theme = globalThemeToggle.checked ? 'dark' : 'light';
    applyTheme(globalSettings.theme === 'dark');

    localStorage.setItem('globalSettings', JSON.stringify(globalSettings));
    closeModal();
});

globalThemeToggle.addEventListener('change', (e) => {
    applyTheme(e.target.checked);
});

// Preset Logic
advBaseLogic.addEventListener('change', updateWorkbenchUI);

function updateWorkbenchUI() {
    const isStandard = advBaseLogic.value === 'standard';
    advMaxChars.disabled = !isStandard;
    advMaxLines.disabled = !isStandard;
}

// --- PRESET SAVE LOGIC ---
function executeSave(name, config) {
    userPresets[name] = config;
    localStorage.setItem('userPresets', JSON.stringify(userPresets));
    
    // UI Feedback
    if (btnSavePreset.dataset.timer) clearTimeout(btnSavePreset.dataset.timer);
    const originalText = "SAVE PRESET";
    btnSavePreset.innerText = "SAVED!";
    btnSavePreset.style.backgroundColor = "var(--success)";
    
    btnSavePreset.dataset.timer = setTimeout(() => {
        btnSavePreset.innerText = originalText;
        btnSavePreset.style.backgroundColor = "";
    }, 2000);

    refreshMiniList();
}

btnSavePreset.addEventListener('click', () => {
    const name = advPresetName.value.trim();
    if (!name) return alert("Enter Name"); // Keep simple alert for empty name
    const safeName = name.replace(/[^a-zA-Z0-9 -]/g, "");
    
    const config = {
        logic: advBaseLogic.value,
        maxChars: advMaxChars.value,
        maxLines: advMaxLines.value,
        profanity: advProfanity.checked
    };

    // Check if exists
    if (userPresets[safeName]) {
        // Show Modal
        pendingPresetData = { name: safeName, config: config };
        overwriteModal.classList.remove('hidden');
        ipcRenderer.send('modal-toggle', true); // Dim controls
    } else {
        // Save Immediately
        executeSave(safeName, config);
    }
});

// Modal Actions
btnCancelOverwrite.addEventListener('click', () => {
    overwriteModal.classList.add('hidden');
    ipcRenderer.send('modal-toggle', false); // Restore controls
    pendingPresetData = null;
});

btnConfirmOverwrite.addEventListener('click', () => {
    if (pendingPresetData) {
        executeSave(pendingPresetData.name, pendingPresetData.config);
        overwriteModal.classList.add('hidden');
        ipcRenderer.send('modal-toggle', false); // Restore controls
        pendingPresetData = null;
    }
});

// UI Helpers
function refreshSimpleDropdown() {
    simplePresetSelect.innerHTML = '';
    const defaults = [{
        n: "TikTok Style",
        v: "tiktok"
    }, {
        n: "Standard Style",
        v: "standard"
    }];
    defaults.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.v;
        opt.textContent = p.n;
        simplePresetSelect.appendChild(opt);
    });
    Object.keys(userPresets).forEach(k => {
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = k;
        simplePresetSelect.appendChild(opt);
    });
}

function refreshMiniList() {
    miniPresetList.innerHTML = '';
    Object.keys(userPresets).forEach(k => {
        const div = document.createElement('div');
        div.className = 'mini-item';
        div.innerHTML = `<span>${k}</span><button class="btn-remove" style="font-size:16px;"><span class="material-symbols-outlined">close</span></button>`;
        div.querySelector('.btn-remove').onclick = () => {
            delete userPresets[k];
            localStorage.setItem('userPresets', JSON.stringify(userPresets));
            refreshMiniList();
        };
        miniPresetList.appendChild(div);
    });
}

// Nav
navToAdvanced.addEventListener('click', () => {
    simpleView.classList.add('hidden');
    navToAdvanced.classList.add('hidden');
    advancedView.classList.remove('hidden');
    navToSimple.classList.remove('hidden');
});
navToSimple.addEventListener('click', () => {
    advancedView.classList.add('hidden');
    navToSimple.classList.add('hidden');
    simpleView.classList.remove('hidden');
    navToAdvanced.classList.remove('hidden');
    refreshSimpleDropdown();
});

// Python IPC
ipcRenderer.on('python-output', (event, msg) => {
    try {
        const res = JSON.parse(msg);

        if (res.type === 'analysis-result') {
            const item = fileQueue.find(x => x.path === res.data.path);
            if (item) {
                item.meta = res.data;
                renderQueue();
            }
        } else if (res.type === 'success') {
            const item = fileQueue.find(x => x.status === 'processing');
            if (item) {
                item.status = 'done';
                const bar = document.getElementById(`progress-${item.id}`);
                if (bar) bar.style.width = '100%';
            }

            // Remember the last successfully saved output file for auto-open behavior
            if (res.data && res.data.savePath) {
                lastSavePath = res.data.savePath;
            }

            processQueue();
        } else if (res.type === 'progress') {
            const item = fileQueue.find(x => x.status === 'processing');
            if (item && res.data) {
                const bar = document.getElementById(`progress-${item.id}`);
                if (bar) bar.style.width = res.data + '%';
            }
        } else if (res.type === 'error') {
            const item = fileQueue.find(x => x.status === 'processing');
            if (item) {
                item.status = 'error';
                alert(`Error: ${res.message}`);
                renderQueue();
            }
            processQueue();
        }
    } catch (e) {}
});

// --- EXTERNAL LINKS HANDLER ---
// Open all links with class 'external-link' in the default system browser
document.body.addEventListener('click', (event) => {
    // Check if the clicked element (or parent) has the class
    const link = event.target.closest('.external-link');
    if (link) {
        event.preventDefault();
        const url = link.getAttribute('href');
        if (url && url !== '#') {
            shell.openExternal(url);
        }
    }
});