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
    java: 'Java', kt: 'Kotlin', kts: 'Kotlin', txt: '', html: 'HTML', js: 'JavaScript',
    json: 'JSON', php: 'PHP', cpp: 'C++', c: 'C', h: 'C', css: 'CSS',
    py: 'Python', rb: 'Ruby', rs: 'Rust', go: 'Go', ts: 'TypeScript',
    jsx: 'JavaScript', tsx: 'TypeScript', sh: 'bash', xml: 'XML',
    yml: 'YAML', yaml: 'YAML', md: 'Markdown', swift: 'Swift', scala: 'Scala',
    sql: 'SQL', dart: 'Dart', lua: 'Lua', r: 'R',
    gradle: 'Groovy',
    bat: 'bat',
    support: '',
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
    const successfulFilesData = [];

    // Filter for enabled files to generate markdown
    const enabledFileObjects = fileObjects.filter(f => f.enabled);
    const enabledFilePaths = enabledFileObjects.map(f => f.path);
    const enabledDisplayPaths = generateDisplayPaths(enabledFilePaths);

    for (let i = 0; i < enabledFileObjects.length; i++) {
        const file = enabledFileObjects[i];
        const displayPath = enabledDisplayPaths[i];

        try {
            if (!fs.existsSync(file.path)) {
                errorMarkdown += `### \`${file.path}\`\n\n\`\`\`\n[Error: File not found]\n\`\`\`\n\n`;
                continue; // Skip this file
            }
            const ext = path.extname(file.path).slice(1).toLowerCase();
            const content = fs.readFileSync(file.path, 'utf-8');
            const lang = EXT_MAP[ext] || '';
            successfulFilesData.push({ displayPath, content, lang });
        } catch (err) {
            errorMarkdown += `### \`${file.path}\`\n\n\`\`\`\n[Error reading file]\n\`\`\`\n\n`;
        }
    }

    let contentMarkdown = successfulFilesData.map(data => {
        const displayPath = data.displayPath.replace(/\\/g, '/');
        return `### \`${displayPath}\`\n\n\`\`\`${data.lang}\n${data.content}\n\`\`\`\n\n`;
    }).join('');


    if (contentMarkdown !== '') contentMarkdown = '## Project Files:\n\n' + contentMarkdown;

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
        width: 1080,
        height: 800,
        minWidth: 1080,
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
            // Get stats to retrieve modification time
            const stats = fs.statSync(filePath);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return { 
                uid: path.basename(file, '.json'), 
                name: data.name,
                mtime: stats.mtime // Add modification time to return object
            };
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

// --- Diff Parsing Helper ---
function parseDiffContent(text) {
    // UPDATED REGEX: Matches 4 or more <, =, > symbols with loose context
    // It captures:
    // 1. <<<< followed by anything until newline
    // 2. content (old part)
    // 3. ==== followed by anything until newline (allows indentation)
    // 4. content (new part)
    // 5. >>>> followed by anything until newline (or end of string) (allows indentation)
    // This allows finding diffs anywhere in the string, even if surrounded by other text and indented.
    const diffRegex = /(<{4,}.*?)\r?\n([\s\S]*?)\r?\n\s*(={4,}.*?)\r?\n([\s\S]*?)\r?\n\s*(>{4,}.*?)(?:\r?\n|$)/g;
    
    let match;
    const diffs = [];
    
    while ((match = diffRegex.exec(text)) !== null) {
        diffs.push({
            oldPart: match[2], // We keep newlines intact
            newPart: match[4]
        });
    }

    if (diffs.length > 0) {
        return diffs;
    }
    return null;
}

function countOccurrences(string, subString, allowOverlapping) {
    string += "";
    subString += "";
    if (subString.length <= 0) return (string.length + 1);

    var n = 0,
        pos = 0,
        step = allowOverlapping ? 1 : subString.length;

    while (true) {
        pos = string.indexOf(subString, pos);
        if (pos >= 0) {
            ++n;
            pos += step;
        } else break;
    }
    return n;
}


ipcMain.handle('smart-paste:find-similar', async () => {
    const clipboardText = clipboard.readText();
    const enabledFiles = currentSession.lastFiles.filter(f => f.enabled);

    if (!clipboardText || !enabledFiles || enabledFiles.length === 0) {
        return { files: [], hasOmission: false, isDiff: false };
    }

    // Check for omission strings
    const hasOmission = clipboardText.includes('/* ...') || clipboardText.includes('// ...');

    // Check for Diff Syntax
    const diffs = parseDiffContent(clipboardText);
    const isDiff = diffs !== null;

    const enabledFilePaths = enabledFiles.map(f => f.path);
    const displayPaths = generateDisplayPaths(enabledFilePaths);

    const similarities = enabledFiles.map((file, index) => {
        try {
            const fileContent = fs.readFileSync(file.path, 'utf-8');
            let similarity = 0;
            let matchCount = 0;

            if (isDiff) {
                // For Diff: Check if ALL distinct diffs from the clipboard exist in this file
                const normalizedFile = fileContent.replace(/\r\n/g, '\n');
                let allDiffsFound = true;
                let totalDiffsInFile = 0;

                for (const diff of diffs) {
                    const normalizedOld = diff.oldPart.replace(/\r\n/g, '\n');
                    const count = countOccurrences(normalizedFile, normalizedOld, false);
                    
                    if (count === 0) {
                        allDiffsFound = false;
                        break; 
                    }
                    totalDiffsInFile += count;
                }

                if (allDiffsFound) {
                    matchCount = totalDiffsInFile;
                } else {
                    matchCount = 0;
                }

                similarity = matchCount > 0 ? 100 : 0;

            } else {
                similarity = textSimilarity.similarity.jaccard(clipboardText, fileContent);
                similarity = (similarity * 100).toFixed(2);
            }

            return {
                path: file.path,
                displayPath: displayPaths[index],
                similarity: similarity,
                matchCount: matchCount // Only used if isDiff is true (Sum of all diff replacements)
            };
        } catch (err) {
            console.error(`Could not read file for similarity check: ${file.path}`, err);
            return {
                path: file.path,
                displayPath: displayPaths[index],
                similarity: 0,
                matchCount: 0
            };
        }
    });

    if (isDiff) {
        // Filter: only files that have matched ALL diffs at least once
        const matchingFiles = similarities.filter(f => f.matchCount > 0);
        // Sort by match count desc
        matchingFiles.sort((a, b) => b.matchCount - a.matchCount);
        return {
            files: matchingFiles,
            hasOmission: false, 
            isDiff: true,
            diffCount: diffs.length // Pass number of distinct diff blocks found
        };
    } else {
        similarities.sort((a, b) => b.similarity - a.similarity);
        return {
            files: similarities,
            hasOmission: hasOmission,
            isDiff: false,
            diffCount: 0
        };
    }
});


ipcMain.handle('smart-paste:apply-update', async (_, { filePath }) => {
    const clipboardText = clipboard.readText();
    if (!clipboardText || !filePath) {
        return { success: false, error: 'No content on clipboard or no file path provided.' };
    }

    try {
        const diffs = parseDiffContent(clipboardText);

        if (diffs) {
            // Diff Mode: Replace ALL occurrences of oldPart with newPart for EVERY diff block
            // NOTE: We ignore the rest of the clipboardText here, using only the diffs found.
            let content = fs.readFileSync(filePath, 'utf-8');
            
            diffs.forEach(diff => {
                // Try simple string split/join logic
                
                if (content.indexOf(diff.oldPart) === -1 && content.indexOf(diff.oldPart.replace(/\r\n/g, '\n')) !== -1) {
                     // Normalize content temporarily could be risky, but if it's the only way...
                     // For now, sticking to exact match.
                }

                const parts = content.split(diff.oldPart);
                content = parts.join(diff.newPart);
            });

            fs.writeFileSync(filePath, content, 'utf-8');
        } else {
            // Standard Mode: Overwrite
            fs.writeFileSync(filePath, clipboardText, 'utf-8');
        }

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
    // UPDATED PARSING STRATEGY:
    // Split text by "### " markers that appear at start of line.
    // This handles multiple code blocks per file header robustly.
    const sections = clipboardText.split(/(?:\r?\n|^)### /);

    for (const section of sections) {
        if (!section.trim()) continue;

        // 1. Extract File Path
        // The first line of the section is the file path header.
        const firstLineEnd = section.indexOf('\n');
        if (firstLineEnd === -1) continue; // Malformed section

        const headerLine = section.substring(0, firstLineEnd);
        // Path might be wrapped in backticks `path` or plain text
        const pathMatch = headerLine.match(/`([^`]+)`/);
        const filePath = pathMatch ? pathMatch[1] : headerLine.trim();

        if (!filePath) continue;

        // 2. Extract All Code Blocks for this File
        const contentPart = section.substring(firstLineEnd);
        // Regex to find content inside ```code ... ``` blocks
        const codeBlockRegex = /```(?:[^\n]*)\n([\s\S]*?)```/g;
        let blockMatch;
        let mergedContent = '';

        while ((blockMatch = codeBlockRegex.exec(contentPart)) !== null) {
            // Join blocks with newlines. 
            // If it's a diff, strict adjacency doesn't matter as we parse specific blocks later.
            // If it's content, merging is the best guess.
            mergedContent += blockMatch[1] + '\n';
        }

        if (mergedContent) {
            files.push({
                path: filePath.trim().replace(/\\/g, '/'),
                content: mergedContent
            });
        }
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

        // Check for content omission in this specific file
        const hasOmission = clipboardFile.content.includes('/* ...') || clipboardFile.content.includes('// ...');
        
        // Check for Diff Syntax inside this specific file's content
        // This will find diffs anywhere in the code block content
        const diffs = parseDiffContent(clipboardFile.content);
        const isDiff = diffs !== null;
        let anyDiffPartNotFound = false; // Flag to track if ANY old part is missing

        if (match) {
            try {
                const projectFileContent = fs.readFileSync(match.file.path, 'utf-8');
                let difference = 0;
                let matchCount = 0;

                if (isDiff) {
                    const normalizedFile = projectFileContent.replace(/\r\n/g, '\n');
                    
                    diffs.forEach(diff => {
                        const normalizedOld = diff.oldPart.replace(/\r\n/g, '\n');
                        const count = countOccurrences(normalizedFile, normalizedOld, false);
                        if (count === 0) {
                            anyDiffPartNotFound = true;
                        }
                        matchCount += count;
                    });

                } else {
                    const similarity = textSimilarity.similarity.jaccard(clipboardFile.content, projectFileContent);
                    difference = (1 - similarity) * 100;
                }

                return {
                    found: true,
                    path: match.file.path,
                    displayPath: match.displayPath,
                    difference: difference,
                    hasOmission: hasOmission,
                    isDiff: isDiff,
                    matchCount: matchCount,
                    anyDiffPartNotFound: anyDiffPartNotFound
                };
            } catch (err) {
                console.error(`Could not read file for import comparison: ${match.file.path}`, err);
                return { found: false, path: clipboardFile.path, hasOmission: hasOmission, isDiff: isDiff, matchCount: 0, anyDiffPartNotFound: true };
            }
        } else {
            return { found: false, path: clipboardFile.path, hasOmission: hasOmission, isDiff: isDiff, matchCount: 0, anyDiffPartNotFound: true };
        }
    }).filter(item => {
        // Filter logic:
        if (item.isDiff) return true;
        if (!item.found) return true;
        return item.difference > 0;
    });

    return analysis;
});


ipcMain.handle('import:apply-changes', async (event, { approvedPaths }) => {
    const clipboardText = clipboard.readText();
    if (!clipboardText || !approvedPaths || approvedPaths.length === 0) {
        return { success: false, error: 'No clipboard content or no files selected for import.' };
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    const clipboardFiles = parseFilesFromClipboard(clipboardText);
    const projectFiles = currentSession.lastFiles;
    const projectFilePaths = projectFiles.map(f => f.path);
    const projectDisplayPaths = generateDisplayPaths(projectFilePaths).map(p => p.replace(/\\/g, '/'));

    const newlyCreatedFilePaths = [];

    try {
        for (const clipboardFile of clipboardFiles) {
            const match = findBestMatch(clipboardFile.path, projectFiles, projectDisplayPaths);
            // Re-parse diffs to apply them
            const diffs = parseDiffContent(clipboardFile.content);

            if (match) { // This is a potential update for an existing file
                if (approvedPaths.includes(match.file.path)) {
                    // It's an approved update
                    if (diffs) {
                         // Apply Diff replacement logic for ALL diff blocks found in the content
                         // NOTE: We ignore the rest of clipboardFile.content, using only the diffs found.
                        let content = fs.readFileSync(match.file.path, 'utf-8');
                        diffs.forEach(diff => {
                            const parts = content.split(diff.oldPart);
                            content = parts.join(diff.newPart);
                        });
                        fs.writeFileSync(match.file.path, content, 'utf-8');
                    } else {
                        // Standard overwrite
                        fs.writeFileSync(match.file.path, clipboardFile.content, 'utf-8');
                    }
                }
            } else { // This is a potential new file
                if (approvedPaths.includes(clipboardFile.path)) {
                    
                    // SAFETY CHECK: If it is a new file but content is a DIFF, do not create it.
                    if (diffs) {
                        console.warn(`Skipping creation of new file ${clipboardFile.path} because content is a DIFF.`);
                        continue; 
                    }

                    // It's an approved creation, so we ask the user where to save it.
                    const projectRootForSaving = findLowestCommonAncestor(projectFilePaths.length > 0 ? projectFilePaths : [currentSession.lastPath || app.getPath('documents')]);

                    const saveResult = await dialog.showSaveDialog(win, {
                        title: `Save New File: ${clipboardFile.path}`,
                        defaultPath: path.join(currentSession.lastPath || projectRootForSaving, path.basename(clipboardFile.path)),
                        buttonLabel: 'Save File'
                    });

                    if (!saveResult.canceled && saveResult.filePath) {
                        const newFilePath = saveResult.filePath;
                        fs.writeFileSync(newFilePath, clipboardFile.content, 'utf-8');
                        newlyCreatedFilePaths.push(newFilePath);
                        // Update lastPath for the next save dialog in this loop
                        currentSession.lastPath = path.dirname(newFilePath);
                    }
                }
            }
        }

        // If new files were created, add them to the current session's file list.
        if (newlyCreatedFilePaths.length > 0) {
            processAndMergeFiles(newlyCreatedFilePaths);
        }

        saveCurrentSession();
        // Reprocess all files to get the fresh list for the renderer.
        const result = await processFiles(currentSession.lastFiles);
        return { success: true, updatedFiles: result.filesForRenderer };

    } catch (err) {
        console.error(`Failed to apply import:`, err);
        return { success: false, error: err.message };
    }
});


app.whenReady().then(async () => {
    tokenizer = await fromPreTrained();
    createWindow();
});