const { app, BrowserWindow, screen, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { spawn } = require('child_process');

let launcherWin = null;
// 最大2画面分のウィンドウを管理
const displayWins = [null, null];
let controlWin = null;
let failoverServerProc = null;
let failoverServerState = {
  running: false,
  pid: null,
  port: 3100,
  serverRoot: '',
  startedAt: null,
  lastError: '',
};

function normalizePort(value, fallback = 3100) {
  const n = parseInt(String(value || ''), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback;
  return n;
}

function guessDefaultServerRoot() {
  const candidates = [
    path.resolve(__dirname, '..', 'server'),
    path.resolve(process.cwd(), '..', 'server'),
    path.resolve(process.cwd(), 'server'),
    path.resolve(__dirname, '..', 'kakimoni'),
    path.resolve(process.cwd(), '..', 'kakimoni'),
    path.resolve(process.cwd(), 'kakimoni'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'server.js'))) return c;
  }
  return candidates[0];
}

function emitFailoverServerStatus() {
  if (!launcherWin || launcherWin.isDestroyed()) return;
  launcherWin.webContents.send('failover-server-status', { ...failoverServerState });
}

function mapFailoverExitError(code, stderrText) {
  const raw = String(stderrText || '').trim();
  if (/EADDRINUSE/i.test(raw)) {
    return 'ポートが使用中です。別ポートを指定するか既存サーバーを停止してください。';
  }
  if (/Cannot find module|MODULE_NOT_FOUND/i.test(raw)) {
    return '依存パッケージ不足です。サブサーバーフォルダで npm install --omit=dev を実行してください。';
  }
  if (raw) {
    const lines = raw.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
    const tail = lines.slice(-2).join(' / ');
    return `起動失敗: ${tail}`;
  }
  if (code && code !== 0) {
    return `サブサーバーが終了しました (code ${code})`;
  }
  return 'サブサーバーが停止しました。';
}

function stopFailoverServerInternal() {
  if (!failoverServerProc) return false;
  try {
    failoverServerProc.kill();
  } catch {}
  failoverServerProc = null;
  failoverServerState.running = false;
  failoverServerState.pid = null;
  failoverServerState.startedAt = null;
  emitFailoverServerStatus();
  return true;
}

function compareVersions(a, b) {
  const parsePart = (part) => {
    const m = String(part || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  };
  const pa = String(a || '0').split(/[._-]/).map(parsePart);
  const pb = String(b || '0').split(/[._-]/).map(parsePart);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function fetchJson(urlString) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers: { Accept: 'application/json' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
  });
}

function downloadFile(urlString, outputPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadFile(res.headers.location, outputPath));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`Download error ${res.statusCode}`));
      }
      const out = fs.createWriteStream(outputPath);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(outputPath)));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

function sha256OfFile(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

function toSafeRepo(input) {
  const repo = String(input || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return '';
  return repo;
}

function githubRequestJson(urlString, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'kakimoni-layout-updater',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = lib.get(u, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, urlString).toString();
        res.resume();
        return resolve(githubRequestJson(next, token));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
  });
}

function downloadBinary(urlString, outputPath, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': 'kakimoni-layout-updater' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = lib.get(u, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, urlString).toString();
        res.resume();
        return resolve(downloadBinary(next, outputPath, token));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`Download error ${res.statusCode}`));
      }
      const out = fs.createWriteStream(outputPath);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(outputPath)));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

function createLauncher() {
  launcherWin = new BrowserWindow({
    width: 820,
    height: 560,
    minWidth: 700,
    minHeight: 520,
    resizable: true,
    title: 'KakiMoni レイアウト専用機',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  launcherWin.setMenuBarVisibility(false);
  launcherWin.loadFile(path.join(__dirname, 'launcher.html'));
  launcherWin.on('closed', () => {
    displayWins.forEach(w => { if (w) w.close(); });
    app.quit();
  });
}

// 接続済みのモニター一覧を返す
ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map((d, i) => ({
    index: i,
    id: d.id,
    label: `モニター ${i + 1}  (${d.bounds.width}×${d.bounds.height})`,
    bounds: d.bounds,
    isPrimary: d.id === screen.getPrimaryDisplay().id,
  }));
});

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-failover-server-defaults', () => {
  const serverRoot = guessDefaultServerRoot();
  return {
    serverRoot,
    port: failoverServerState.port || 3100,
    serverJsExists: fs.existsSync(path.join(serverRoot, 'server.js')),
  };
});

ipcMain.handle('get-failover-server-status', () => ({ ...failoverServerState }));

ipcMain.handle('pick-failover-server-root', async (event, payload = {}) => {
  const defaultPath = String(payload.defaultPath || guessDefaultServerRoot());
  const result = await dialog.showOpenDialog({
    title: 'サブサーバーフォルダを選択',
    defaultPath,
    properties: ['openDirectory'],
  });

  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }
  return { ok: true, path: result.filePaths[0] };
});

ipcMain.handle('start-failover-server', async (event, payload = {}) => {
  try {
    if (failoverServerProc) {
      return { ok: true, alreadyRunning: true, status: { ...failoverServerState } };
    }

    const serverRoot = path.resolve(String(payload.serverRoot || guessDefaultServerRoot()));
    const serverJsPath = path.join(serverRoot, 'server.js');
    const port = normalizePort(payload.port, failoverServerState.port || 3100);
    const expressPath = path.join(serverRoot, 'node_modules', 'express');

    if (!fs.existsSync(serverJsPath)) {
      return { ok: false, error: `server.js が見つかりません: ${serverJsPath}` };
    }
    if (!fs.existsSync(expressPath)) {
      return {
        ok: false,
        error: '依存パッケージが未インストールです。サブサーバーフォルダで npm install --omit=dev を実行してください。',
      };
    }

    let stderrBuf = '';

    const proc = spawn('node', [serverJsPath], {
      cwd: serverRoot,
      env: { ...process.env, KAKIMONI_PORT: String(port) },
      windowsHide: true,
    });

    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        stderrBuf += String(chunk || '');
        if (stderrBuf.length > 4000) {
          stderrBuf = stderrBuf.slice(-4000);
        }
      });
    }

    proc.on('error', (err) => {
      failoverServerState.lastError = err?.message || 'サブサーバー起動に失敗しました。';
      failoverServerState.running = false;
      failoverServerState.pid = null;
      failoverServerState.startedAt = null;
      failoverServerProc = null;
      emitFailoverServerStatus();
    });

    proc.on('exit', (code) => {
      failoverServerState.running = false;
      failoverServerState.pid = null;
      failoverServerState.startedAt = null;
      failoverServerState.lastError = mapFailoverExitError(code, stderrBuf);
      failoverServerProc = null;
      emitFailoverServerStatus();
    });

    failoverServerProc = proc;
    failoverServerState = {
      running: true,
      pid: proc.pid || null,
      port,
      serverRoot,
      startedAt: new Date().toISOString(),
      lastError: '',
    };
    emitFailoverServerStatus();
    return { ok: true, status: { ...failoverServerState } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('stop-failover-server', async () => {
  const stopped = stopFailoverServerInternal();
  return { ok: true, stopped, status: { ...failoverServerState } };
});

// コントロール画面を開く／閉じる
ipcMain.on('toggle-control', (event, { url }) => {
  if (controlWin) { controlWin.focus(); return; }
  controlWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'KakiMoni レイアウトコントローラー',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  controlWin.setMenuBarVisibility(false);
  controlWin.loadURL(url);
  controlWin.on('closed', () => {
    controlWin = null;
    if (launcherWin) launcherWin.webContents.send('control-status', false);
  });
  if (launcherWin) launcherWin.webContents.send('control-status', true);
});

// 指定スロットの表示ウィンドウを開く／閉じる
ipcMain.on('toggle-display', (event, { slot, url, displayIndex }) => {
  const idx = slot; // 0 or 1

  if (displayWins[idx]) {
    displayWins[idx].close();
    return;
  }

  const displays = screen.getAllDisplays();
  const target = displays[displayIndex] || displays[0];

  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    frame: false,
    fullscreen: true,
    title: `KakiMoni レイアウト専用機 [${slot + 1}]`,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(url, { extraHeaders: 'pragma: no-cache\nCache-Control: no-cache\n' });
  win.on('closed', () => {
    displayWins[idx] = null;
    if (launcherWin) launcherWin.webContents.send('display-status', { slot: idx, open: false });
  });
  displayWins[idx] = win;
  if (launcherWin) launcherWin.webContents.send('display-status', { slot: idx, open: true });
});

ipcMain.handle('check-layout-update', async (event, { serverUrl }) => {
  try {
    const base = String(serverUrl || '').trim().replace(/\/$/, '');
    if (!base) return { ok: false, error: 'サーバーURLが空です。' };

    const latest = await fetchJson(`${base}/api/update/layout/latest`);
    if (!latest || !latest.ok) {
      return { ok: false, error: latest?.error || '更新情報がありません。' };
    }

    const currentVersion = app.getVersion();
    const latestVersion = String(latest.version || '0.0.0');
    const available = compareVersions(latestVersion, currentVersion) > 0;

    return {
      ok: true,
      available,
      currentVersion,
      latestVersion,
      fileName: latest.fileName,
      size: latest.size || 0,
      sha256: latest.sha256 || '',
      notes: latest.notes || '',
      downloadPath: latest.downloadPath,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('download-layout-update', async (event, { serverUrl, fileName, downloadPath, sha256 }) => {
  try {
    const base = String(serverUrl || '').trim().replace(/\/$/, '');
    if (!base) return { ok: false, error: 'サーバーURLが空です。' };

    const safeName = path.basename(String(fileName || 'update.exe'));
    const relPath = downloadPath || `/api/update/layout/file/${encodeURIComponent(safeName)}`;
    const url = new URL(relPath, `${base}/`).toString();

    const tempDir = app.getPath('temp');
    const targetPath = path.join(tempDir, `kakimoni-layout-update-${Date.now()}.exe`);
    await downloadFile(url, targetPath);

    if (sha256) {
      const actual = sha256OfFile(targetPath);
      if (actual.toLowerCase() !== String(sha256).toLowerCase()) {
        try { fs.unlinkSync(targetPath); } catch {}
        return { ok: false, error: 'SHA256不一致のため更新を中止しました。' };
      }
    }

    return { ok: true, downloadedPath: targetPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('apply-layout-update', async (event, { downloadedPath }) => {
  try {
    if (!app.isPackaged) {
      return { ok: false, error: '開発モードでは自己更新を実行できません。' };
    }
    if (!downloadedPath || !fs.existsSync(downloadedPath)) {
      return { ok: false, error: '更新ファイルが見つかりません。' };
    }

    const scriptPath = path.join(app.getPath('temp'), `kakimoni-layout-updater-${Date.now()}.cmd`);
    const script = [
      '@echo off',
      'setlocal',
      'timeout /t 2 /nobreak >nul',
      `start "" "${downloadedPath}" /S`,
      `del /f /q "${downloadedPath}" >nul 2>nul`,
      `del /f /q "${scriptPath}" >nul 2>nul`,
      'endlocal',
    ].join('\r\n');

    fs.writeFileSync(scriptPath, script, 'utf-8');
    spawn('cmd.exe', ['/c', scriptPath], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 100);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('check-layout-self-update-from-github', async (event, payload = {}) => {
  try {
    const repo = toSafeRepo(payload.repo);
    const releaseTag = String(payload.releaseTag || '').trim();
    const token = String(payload.token || '').trim();
    const assetPattern = String(payload.assetPattern || '').trim().toLowerCase();

    if (!repo) return { ok: false, error: 'repo は owner/repo 形式で入力してください。' };

    const apiUrl = releaseTag
      ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(releaseTag)}`
      : `https://api.github.com/repos/${repo}/releases/latest`;
    const release = await githubRequestJson(apiUrl, token || null);

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const exeAssets = assets.filter(a => typeof a.name === 'string' && a.name.toLowerCase().endsWith('.exe'));
    if (exeAssets.length === 0) return { ok: false, error: 'Releaseに .exe アセットがありません。' };

    let picked = null;
    if (assetPattern) picked = exeAssets.find(a => a.name.toLowerCase().includes(assetPattern));
    if (!picked) picked = exeAssets[0];
    if (!picked.browser_download_url) return { ok: false, error: 'ダウンロードURLを取得できませんでした。' };

    const currentVersion = app.getVersion();
    const latestVersion = String(release.tag_name || release.name || '').trim();
    if (!latestVersion) return { ok: false, error: 'Releaseのバージョン情報を取得できませんでした。' };
    const available = compareVersions(latestVersion, currentVersion) > 0;

    return {
      ok: true,
      available,
      currentVersion,
      latestVersion,
      repo,
      releaseTag: release.tag_name || '',
      releaseUrl: release.html_url || '',
      assetName: picked.name,
      downloadUrl: picked.browser_download_url,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('download-layout-self-update-from-github', async (event, payload = {}) => {
  try {
    const downloadUrl = String(payload.downloadUrl || '').trim();
    const token = String(payload.token || '').trim();
    const assetName = path.basename(String(payload.assetName || 'kakimoni-layout-update.exe'));
    if (!downloadUrl) return { ok: false, error: 'downloadUrl が空です。' };

    const tempName = `km-layout-self-${Date.now()}-${assetName}`;
    const tempFilePath = path.join(app.getPath('temp'), tempName);
    await downloadBinary(downloadUrl, tempFilePath, token || null);

    return { ok: true, downloadedPath: tempFilePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(createLauncher);
app.on('before-quit', () => {
  stopFailoverServerInternal();
});
app.on('window-all-closed', () => { app.quit(); });
