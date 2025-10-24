const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // --- Template management functions ---
    getTemplates: () => ipcRenderer.invoke('templates:get-all'),
    createTemplate: (name) => ipcRenderer.invoke('templates:create', name),
    updateTemplate: (data) => ipcRenderer.invoke('templates:update', data),
    deleteTemplate: (uid) => ipcRenderer.invoke('templates:delete', uid),
    loadTemplate: (uid) => ipcRenderer.send('templates:load', uid),
    showTemplates: () => ipcRenderer.send('app:show-templates'),

    // --- File operation functions ---
    setFileState: (data) => ipcRenderer.send('file:set-state', data),
    pickFiles: async () => {
        const files = await ipcRenderer.invoke('open-file-dialog');
        if (!files || files.length === 0) return;
        const result = await ipcRenderer.invoke('read-files', files);
        window.dispatchEvent(new CustomEvent('files-read', { detail: result }));
    },
    // Function to handle picking a folder
    pickFolder: async () => {
        const files = await ipcRenderer.invoke('open-folder-dialog');
        if (!files || files.length === 0) return;
        const result = await ipcRenderer.invoke('read-files', files);
        window.dispatchEvent(new CustomEvent('files-read', { detail: result }));
    },

    // --- MODIFIED: Handle dropped files using webUtils in preload ---
    handleDrop: async (fileList) => {
        // 1. Receive array of DOM File objects from renderer.
        // 2. Use webUtils in preload to extract the real path.
        const paths = fileList.map(file => webUtils.getPathForFile(file));

        // Filter out any paths that couldn't be resolved
        const validPaths = paths.filter(p => p);

        if (validPaths.length > 0) {
            // 3. Send array of path strings to main process.
            const result = await ipcRenderer.invoke('handle-dropped-paths', validPaths);
            if (result) {
                window.dispatchEvent(new CustomEvent('files-read', { detail: result }));
            }
        }
    },

    // Smart Paste functions
    findSimilarFiles: () => ipcRenderer.invoke('smart-paste:find-similar'),
    applySmartPaste: (filePath) => ipcRenderer.invoke('smart-paste:apply-update', { filePath }),

    // Import from Clipboard functions
    parseClipboardForImport: () => ipcRenderer.invoke('import:parse-clipboard'),
    applyImport: (filePathsToUpdate) => ipcRenderer.invoke('import:apply-changes', { filePathsToUpdate }),

    // Function to improve the prompt text
    improvePrompt: (text) => ipcRenderer.invoke('improve-prompt', text),
    calculateTokens: (payload) => ipcRenderer.invoke('calculate-tokens', payload),
    rereadFiles: async (files) => {
        if (!files || files.length === 0) return;
        const result = await ipcRenderer.invoke('read-files', []);
        window.dispatchEvent(new CustomEvent('files-reloaded', { detail: result }));
    },
    reloadAndCopy: (payload) => ipcRenderer.invoke('reload-and-copy', payload),
    updateFileList: (fileObjects) => {
        ipcRenderer.send('update-file-list', fileObjects);
    },
    updatePrompt: (prompt) => ipcRenderer.send('session:update-prompt', prompt),

    // --- Event listeners ---
    onInitialLoad: (callback) => {
        ipcRenderer.on('initial-load', (_, result) => callback(result));
    },
    onFilesRead: (callback) => {
        window.addEventListener('files-read', (e) => callback(e.detail));
    },
    onFilesReloaded: (callback) => {
        window.addEventListener('files-reloaded', (e) => callback(e.detail));
    },
    onFileListUpdated: (callback) => {
        ipcRenderer.on('file-list-updated', (_, files) => callback(files));
    },
});