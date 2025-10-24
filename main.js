const { app, BrowserWindow, dialog, ipcMain, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { fromPreTrained } = require("@lenml/tokenizer-gemini");
const textSimilarity = require('text-similarity-node');

// --- Globals ---
let tokenizer;

// --- Templates Directory Setup ---
const TEMPLATES_DIR = path.join(app.getPath("userData"), "templates");
if (!fs.existsSync(TEMPLATES_DIR)) {
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
}

// In-memory state for the currently loaded template
let currentSession = {
    uid: null,
    name: null,
    lastPath: null,
    lastFiles: [],
};

// --- File processing logic and helpers ---
const EXT_MAP = {
    java: 'Java', kt: 'Kotlin', txt: '', html: 'HTML', js: 'JavaScript',
    json: 'JSON', php: 'PHP', cpp: 'C++', c: 'C', h: 'C', css: 'CSS',
    py: 'Python', rb: 'Ruby', rs: 'Rust', go: 'Go', ts: 'TypeScript',
    jsx: 'JavaScript', tsx: 'TypeScript', sh: 'bash', xml: 'XML',
    yml: 'YAML', yaml: 'YAML', md: 'Markdown', swift: 'Swift', scala: 'Scala',
    sql: 'SQL', dart: 'Dart', lua: 'Lua', r: 'R',
    gradle: 'Groovy',
};

const getAllFiles = (dir, files = []) => {
    const dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    for (const dirEntry of dirEntries) {
        const fullPath = path.join(dir, dirEntry.name);
        if (dirEntry.isDirectory()) {
            getAllFiles(fullPath, files);
        } else {
            files.push(fullPath);
        }
    }
    return files;
};


function findLowestCommonAncestor(paths) {
    if (!paths || paths.length === 0) return '';
    if (paths.length === 1) return path.dirname(paths[0]); // Corrected: Expects a single path string
    const dirPaths = paths.map(p => path.dirname(p));
    const splitPaths = dirPaths.map(p => p.split(path.sep));
    let commonPath = [];
    // Corrected logic to find common ancestor
    if (splitPaths.length > 0) {
        const firstPathParts = splitPaths[0];
        for (let i = 0; i < firstPathParts.length; i++) {
            const part = firstPathParts[i];
            if (splitPaths.every(p => p.length > i && p[i] === part)) {
                commonPath.push(part);
            } else {
                break;
            }
        }
    }
    return commonPath.join(path.sep);
}

function generateDisplayPaths(files) {
    if (!files || files.length === 0) return [];
    if (files.length === 1) {
        // Corrected: Handle single file case properly
        const filePath = files[0];
        return [path.join(path.basename(path.dirname(filePath)), path.basename(filePath))];
    }
    const commonAncestor = findLowestCommonAncestor(files);
    const relativePaths = files.map(f => path.relative(commonAncestor, f));
    const pathSet = new Set();
    relativePaths.forEach(p => {
        let current = p;
        while (current && current !== '.') {
            pathSet.add(current);
            current = path.dirname(current);
            if (current === '.') break;
        }
    });
    const childCounts = new Map();
    pathSet.forEach(p => {
        const parent = path.dirname(p);
        if (p !== parent) {
            childCounts.set(parent, (childCounts.get(parent) || 0) + 1);
        }
    });
    let collapsedPaths = relativePaths.map(relPath => {
        const parts = relPath.split(path.sep);
        let firstBranchIndex = -1;
        for (let i = 0; i < parts.length - 1; i++) {
            const currentRelativeDir = parts.slice(0, i + 1).join(path.sep);
            if ((childCounts.get(currentRelativeDir) || 1) > 1) {
                firstBranchIndex = i;
                break;
            }
        }
        if (firstBranchIndex !== -1) {
            return parts.slice(firstBranchIndex).join(path.sep);
        } else {
            // Fallback for paths that don't branch off significantly
            return parts.length > 1 ? parts.slice(-2).join(path.sep) : relPath;
        }
    });
    const hasRootFile = collapsedPaths.some(p => !p.includes(path.sep));
    if (hasRootFile) {
        const parentName = path.basename(commonAncestor);
        if (parentName) {
            collapsedPaths = collapsedPaths.map(p => path.join(parentName, p));
        }
    }
    return collapsedPaths;
}

// Function to generate a Markdown tree of the file structure
function generateMarkdownTree(files) {
    if (!files || files.length === 0) return '';

    const tree = {};
    for (const file of files) {
        const parts = file.displayPath.replace(/\\/g, '/').split('/');
        let currentLevel = tree;
        for (const part of parts) {
            if (!currentLevel[part]) {
                currentLevel[part] = {};
            }
            currentLevel = currentLevel[part];
        }
    }

    function buildTreeString(node, prefix = '') {
        let result = '';
        const keys = Object.keys(node).sort((a, b) => {
            const aIsFolder = Object.keys(node[a]).length > 0;
            const bIsFolder = Object.keys(node[b]).length > 0;
            if (aIsFolder && !bIsFolder) return -1;
            if (!aIsFolder && bIsFolder) return 1;
            return a.localeCompare(b);
        });

        keys.forEach((key, index) => {
            const isLast = index === keys.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            result += prefix + connector + key + '\n';

            if (Object.keys(node[key]).length > 0) {
                const newPrefix = prefix + (isLast ? '    ' : '│   ');
                result += buildTreeString(node[key], newPrefix);
            }
        });
        return result;
    }

    const treeString = buildTreeString(tree);
    return `\n## Project Structure:\n\`\`\`Markdown\n${treeString}\`\`\`\n\n`;
}


async function processFiles(fileObjects) {
    let errorMarkdown = '';

    // Filter for enabled files to generate markdown
    const enabledFileObjects = fileObjects.filter(f => f.enabled);
    const enabledFilePaths = enabledFileObjects.map(f => f.path);
    const enabledDisplayPaths = generateDisplayPaths(enabledFilePaths);

    const supportedFileData = [];
    for (const file of enabledFileObjects) {
        try {
            if (!fs.existsSync(file.path)) {
                errorMarkdown += `### \`${file.path}\`\n\n\`\`\`\n[Error: File not found]\n\`\`\`\n\n`;
                continue;
            }
            const ext = path.extname(file.path).slice(1).toLowerCase();
            const content = fs.readFileSync(file.path, 'utf-8');
            const lang = EXT_MAP[ext] || '';
            supportedFileData.push({ content, lang });
        } catch (err) {
            errorMarkdown += `### \`${file.path}\`\n\n\`\`\`\n[Error reading file]\n\`\`\`\n\n`;
        }
    }

    let contentMarkdown = '';
    enabledFileObjects.forEach((_file, index) => {
        const displayPath = enabledDisplayPaths[index].replace(/\\/g, '/');
        const { content, lang } = supportedFileData[index];
        contentMarkdown += `### \`${displayPath}\`\n\n\`\`\`${lang}\n${content}\n\`\`\`\n\n`;
    });

    if(contentMarkdown !== '' ) contentMarkdown = '## Project Files:\n\n' + contentMarkdown;

    // Generate display paths for ALL files (enabled or not) for the UI tree
    const allFilePaths = fileObjects.map(f => f.path);
    const allDisplayPaths = generateDisplayPaths(allFilePaths);

    const filesForRenderer = fileObjects.map((file, index) => ({
        ...file,
        displayPath: allDisplayPaths[index]
    }));

    const treeMarkdown = generateMarkdownTree(filesForRenderer);

    return { contentMarkdown, treeMarkdown, errorMarkdown, filesForRenderer };
}


function processAndMergeFiles(newFilePaths) {
    const existingFilePaths = new Set(currentSession.lastFiles.map(f => f.path));
    const unsupported = [];

    const newFiles = newFilePaths
        .filter(p => !existingFilePaths.has(p))
        .map(p => {
            const ext = path.extname(p).slice(1).toLowerCase();
            if (ext in EXT_MAP) {
                return { path: p, enabled: true, unsupported: false };
            } else {
                unsupported.push(path.basename(p));
                return { path: p, enabled: false, unsupported: true };
            }
        });

    currentSession.lastFiles.push(...newFiles);
    saveCurrentSession();
    return { unsupportedFiles: unsupported };
}

function saveCurrentSession() {
    if (!currentSession || !currentSession.uid) {
        return;
    }
    try {
        const filePath = path.join(TEMPLATES_DIR, `${currentSession.uid}.json`);
        fs.writeFileSync(filePath, JSON.stringify(currentSession, null, 2), 'utf-8');
    } catch (err) {
        console.error('Error saving template file:', err);
    }
}

function createWindow() {
    const win = new BrowserWindow({
        width: 940,
        height: 800,
        minWidth: 940,
        minHeight: 600,
        icon: path.join(__dirname, 'assets', 'icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.setMenu(null);
    const iconPath = path.join(__dirname, 'assets', 'icon.ico');
    console.log(iconPath); // Check the absolute path
    win.loadFile('templates.html');
}

// --- IPC Handlers for Template Management ---

ipcMain.handle('templates:get-all', () => {
    try {
        const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
        const templates = files.map(file => {
            const filePath = path.join(TEMPLATES_DIR, file);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return { uid: path.basename(file, '.json'), name: data.name };
        });
        return templates;
    } catch (err) {
        // console.error("Could not read templates (might be first run):", err);
        return [];
    }
});

ipcMain.handle('templates:create', (event, name) => {
    try {
        const uid = crypto.randomBytes(16).toString('hex');
        const newTemplate = {
            name: name || 'Untitled Template',
            lastPath: null,
            lastFiles: [],
            prompt: '',
        };
        const filePath = path.join(TEMPLATES_DIR, `${uid}.json`);
        fs.writeFileSync(filePath, JSON.stringify(newTemplate, null, 2), 'utf-8');
        return { uid, ...newTemplate };
    } catch (err) {
        console.error("Could not create template:", err);
        return null;
    }
});

ipcMain.handle('templates:update', (_, { uid, newName }) => {
    try {
        const filePath = path.join(TEMPLATES_DIR, `${uid}.json`);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        data.name = newName;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
        console.error("Could not update template:", err);
    }
});

ipcMain.handle('templates:delete', (_, uid) => {
    try {
        const filePath = path.join(TEMPLATES_DIR, `${uid}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.error("Could not delete template:", err);
    }
});

ipcMain.on('templates:load', async (event, uid) => {
    try {
        const filePath = path.join(TEMPLATES_DIR, `${uid}.json`);
        const data = fs.readFileSync(filePath, 'utf-8');
        currentSession = { uid, ...JSON.parse(data) };
        currentSession.lastFiles = currentSession.lastFiles || [];

        const win = BrowserWindow.fromWebContents(event.sender);
        win.loadFile('index.html');

        win.webContents.once('did-finish-load', async () => {
            if (currentSession.lastFiles.length > 0) {
                const result = await processFiles(currentSession.lastFiles);
                result.templateName = currentSession.name;
                result.prompt = currentSession.prompt;
                win.webContents.send('initial-load', result); //
            } else {
                win.webContents.send('initial-load', { filesForRenderer: [], templateName: currentSession.name, prompt: currentSession.prompt });
            }
        });

    } catch (err) {
        console.error(`Could not load template ${uid}:`, err);
    }
});

ipcMain.on('app:show-templates', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    currentSession = {};
    win.loadFile('templates.html');
});


// --- IPC handlers for File Operations ---
ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        defaultPath: currentSession.lastPath || undefined,
    });
    if (!result.canceled && result.filePaths.length > 0) {
        // FIX: Use the directory of the first selected file.
        currentSession.lastPath = path.dirname(result.filePaths[0]);
    }
    return result.filePaths;
});

ipcMain.handle('open-folder-dialog', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        defaultPath: currentSession.lastPath || undefined,
    });

    if (result.canceled || result.filePaths.length === 0) {
        return [];
    }

    // FIX: Get the single directory path from the result array.
    const dirPath = result.filePaths[0];
    currentSession.lastPath = dirPath;

    try {
        return getAllFiles(dirPath);
    } catch (error) {
        console.error('Error reading folder contents:', error);
        return [];
    }
});


ipcMain.handle('read-files', async (_, files) => {
    const { unsupportedFiles } = processAndMergeFiles(files);
    const result = await processFiles(currentSession.lastFiles);
    result.unsupportedFiles = unsupportedFiles;
    return result;
});


ipcMain.handle('reload-and-copy', async (_, { files: fileObjects, prompt }) => {
    currentSession.lastFiles = fileObjects.map(({ path, enabled }) => ({ path, enabled }));
    currentSession.prompt = prompt;
    saveCurrentSession();
    const result = await processFiles(currentSession.lastFiles);

    const { contentMarkdown, treeMarkdown, errorMarkdown } = result;

    let promptBlock = '';
    if (prompt && prompt.trim().length > 0) {
        promptBlock = `\n## User's prompt:\n\`\`\`Markdown\n${prompt}\n\`\`\`\n`;
    }

    const finalMarkdown = contentMarkdown + treeMarkdown + errorMarkdown + promptBlock;

    if (finalMarkdown) {
        clipboard.writeText(finalMarkdown);
    }
    return result;
});

ipcMain.handle('improve-prompt', async (event, text) => {
    const professionalPrompt = `
You are an expert copy agent. Your task is to correct the grammar, spelling, and punctuation of the following text to improve its clarity and readability.

Text to correct stringified:${JSON.stringify(text)}

Instructions:
- Provide ONLY the corrected text stringified, without any additional commentary or formatting.
- Do not include any explanations, introductions, or markdown formatting.
- Do not alter the original meaning of the text.
- If the original text is already perfect, return it unchanged.
- You are allowed to respond only with valid stringified text.

Corrected Text in stringified format:`.trim();

    try {
        const response = await axios.post('https://apifreellm.com/api/chat',
            {
                message: professionalPrompt
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Request-Source': 'homepage-welcome'
                }
            }
        );

        const improvedText = response.data.response || response.data.content || text;
        return JSON.parse(improvedText.trim());

    } catch (error) {
        console.error('Error with ApiFreeLLM.com request:', error.message);
        return text;
    }
});

ipcMain.handle('calculate-tokens', async (_, { files: fileObjects, prompt }) => {
    if (!tokenizer) return 0; // Guard against calls before tokenizer is ready

    const result = await processFiles(fileObjects);
    const { contentMarkdown, treeMarkdown, errorMarkdown } = result;

    let promptBlock = '';
    if (prompt && prompt.trim().length > 0) {
        promptBlock = `\n## User's prompt:\n\`\`\`Markdown\n${prompt}\n\`\`\`\n`;
    }
    const finalMarkdown = contentMarkdown + treeMarkdown + errorMarkdown + promptBlock;
    if (!finalMarkdown) return 0;
    try {
        const encoded = tokenizer.encode(finalMarkdown);
        return encoded.length;
    } catch (error) {
        console.error("Error counting tokens:", error);
        return 0;
    }
});


ipcMain.on('update-file-list', (_, fileObjects) => {
    currentSession.lastFiles = fileObjects.map(
        ({ path, enabled, unsupported }) => ({ path, enabled, unsupported })
    );
    saveCurrentSession();
});

ipcMain.on('session:update-prompt', (_, prompt) => {
    if (currentSession) {
        currentSession.prompt = prompt;
        saveCurrentSession();
    }
});

ipcMain.on('file:set-state', async (event, { path: toggledPath, type, enabled }) => {
    if (type === 'file') {
        const file = currentSession.lastFiles.find(f => f.path === toggledPath);
        if (file) {
            if (file.unsupported && enabled) {
                return;
            }
            file.enabled = enabled;
        }
    } else if (type === 'folder') {
        const allPaths = currentSession.lastFiles.map(f => f.path);
        const displayPaths = generateDisplayPaths(allPaths);

        currentSession.lastFiles.forEach((file, index) => {
            const fileDisplayPath = displayPaths[index].replace(/\\/g, '/');
            if (fileDisplayPath.startsWith(toggledPath + '/') || fileDisplayPath === toggledPath) {
                if (!(file.unsupported && enabled)) {
                    file.enabled = enabled;
                }
            }
        });
    }

    saveCurrentSession();

    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await processFiles(currentSession.lastFiles);
    win.webContents.send('file-list-updated', result.filesForRenderer);
});

// --- MODIFIED: IPC handler for processing dropped paths (now strings) ---
ipcMain.handle('handle-dropped-paths', async (_, paths) => {
    // 'paths' is an array of absolute path strings from preload
    let allFilePaths = [];
    for (const p of paths) {
        try {
            if (fs.statSync(p).isDirectory()) {
                allFilePaths.push(...getAllFiles(p));
            } else {
                allFilePaths.push(p);
            }
        } catch (err)
        {
            console.error(`Error processing dropped path ${p}:`, err);
        }
    }

    if (allFilePaths.length > 0) {
        const { unsupportedFiles } = processAndMergeFiles(allFilePaths);
        const result = await processFiles(currentSession.lastFiles);
        result.unsupportedFiles = unsupportedFiles;
        return result;
    }
    return null;
});

ipcMain.handle('smart-paste:find-similar', async () => {
    const clipboardText = clipboard.readText();
    const enabledFiles = currentSession.lastFiles.filter(f => f.enabled);

    if (!clipboardText || !enabledFiles || enabledFiles.length === 0) {
        return [];
    }

    const enabledFilePaths = enabledFiles.map(f => f.path);
    const displayPaths = generateDisplayPaths(enabledFilePaths);

    const similarities = enabledFiles.map((file, index) => {
        try {
            const fileContent = fs.readFileSync(file.path, 'utf-8');
            const similarity = textSimilarity.similarity.jaccard(clipboardText, fileContent);
            return {
                path: file.path,
                displayPath: displayPaths[index],
                similarity: (similarity * 100).toFixed(2) // Two-digit precision
            };
        } catch (err) {
            console.error(`Could not read file for similarity check: ${file.path}`, err);
            return {
                path: file.path,
                displayPath: displayPaths[index],
                similarity: (0).toFixed(2)
            };
        }
    });

    similarities.sort((a, b) => b.similarity - a.similarity);

    return similarities;
});


ipcMain.handle('smart-paste:apply-update', async (_, { filePath }) => {
    const clipboardText = clipboard.readText();
    if (!clipboardText || !filePath) {
        return { success: false, error: 'No content on clipboard or no file path provided.' };
    }

    try {
        fs.writeFileSync(filePath, clipboardText, 'utf-8');
        const result = await processFiles(currentSession.lastFiles);
        return { success: true, updatedFiles: result.filesForRenderer };
    } catch (err) {
        console.error(`Failed to write file for smart paste: ${filePath}`, err);
        return { success: false, error: err.message };
    }
});

// --- Import from Clipboard ---

function parseFilesFromClipboard(clipboardText) {
    const files = [];
    // CORRECTED REGEX: More flexible with whitespace and optional elements.
    const regex = /### `([^`]+)`\s*```(?:[^\n]*)?\n([\s\S]*?)\n?```/g;
    let match;
    while ((match = regex.exec(clipboardText)) !== null) {
        files.push({
            path: match[1].trim().replace(/\\/g, '/'), // Path is in group 1
            content: match[2],                       // Content is in group 2
        });
    }
    return files;
}

function findBestMatch(clipboardPath, projectFiles, projectDisplayPaths) {
    let bestMatchIndex = -1;

    // 1. Check for an exact match
    const exactMatchIndex = projectDisplayPaths.findIndex(p => p === clipboardPath);
    if (exactMatchIndex > -1) {
        bestMatchIndex = exactMatchIndex;
    } else {
        // 2. If no exact match, find the shortest display path that has the clipboard path as a suffix
        let shortestMatchPathLength = Infinity;
        projectDisplayPaths.forEach((displayPath, index) => {
            if (displayPath.endsWith('/' + clipboardPath) || displayPath === clipboardPath) {
                if (displayPath.length < shortestMatchPathLength) {
                    shortestMatchPathLength = displayPath.length;
                    bestMatchIndex = index;
                }
            }
        });
    }

    if (bestMatchIndex !== -1) {
        return {
            file: projectFiles[bestMatchIndex],
            displayPath: projectDisplayPaths[bestMatchIndex],
            index: bestMatchIndex
        };
    }

    return null; // No match found
}


ipcMain.handle('import:parse-clipboard', async () => {
    const clipboardText = clipboard.readText();
    if (!clipboardText) return [];

    const clipboardFiles = parseFilesFromClipboard(clipboardText);
    if (clipboardFiles.length === 0) return [];

    const projectFiles = currentSession.lastFiles;
    const projectFilePaths = projectFiles.map(f => f.path);
    const projectDisplayPaths = generateDisplayPaths(projectFilePaths).map(p => p.replace(/\\/g, '/'));

    const analysis = clipboardFiles.map(clipboardFile => {
        const match = findBestMatch(clipboardFile.path, projectFiles, projectDisplayPaths);

        if (match) {
            try {
                const projectFileContent = fs.readFileSync(match.file.path, 'utf-8');
                const similarity = textSimilarity.similarity.jaccard(clipboardFile.content, projectFileContent);
                const difference = (1 - similarity) * 100;
                return {
                    found: true,
                    path: match.file.path,
                    displayPath: match.displayPath,
                    difference: difference,
                };
            } catch (err) {
                console.error(`Could not read file for import comparison: ${match.file.path}`, err);
                return { found: false, path: clipboardFile.path };
            }
        } else {
            return { found: false, path: clipboardFile.path };
        }
    });

    return analysis;
});


ipcMain.handle('import:apply-changes', async (_, { filePathsToUpdate }) => {
    const clipboardText = clipboard.readText();
    if (!clipboardText || !filePathsToUpdate || filePathsToUpdate.length === 0) {
        return { success: false, error: 'No clipboard content or no files selected for update.' };
    }

    const clipboardFiles = parseFilesFromClipboard(clipboardText);
    const projectFiles = currentSession.lastFiles;
    const projectFilePaths = projectFiles.map(f => f.path);
    const projectDisplayPaths = generateDisplayPaths(projectFilePaths).map(p => p.replace(/\\/g, '/'));

    try {
        for (const clipboardFile of clipboardFiles) {
            const match = findBestMatch(clipboardFile.path, projectFiles, projectDisplayPaths);
            if (match && filePathsToUpdate.includes(match.file.path)) {
                fs.writeFileSync(match.file.path, clipboardFile.content, 'utf-8');
            }
        }
        const result = await processFiles(currentSession.lastFiles);
        return { success: true, updatedFiles: result.filesForRenderer };
    } catch (err) {
        console.error(`Failed to write file during import:`, err);
        return { success: false, error: err.message };
    }
});


app.whenReady().then(async () => {
    tokenizer = await fromPreTrained();
    createWindow();
});