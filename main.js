const { app, BrowserWindow, screen, ipcMain } = require('electron');
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

function compareVersions(a, b) {
  const pa = String(a || '0').split(/[._-]/).map(s => parseInt(s, 10) || 0);
  const pb = String(b || '0').split(/[._-]/).map(s => parseInt(s, 10) || 0);
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

    const currentExePath = process.execPath;
    const backupExePath = `${currentExePath}.bak`;
    const scriptPath = path.join(app.getPath('temp'), `kakimoni-layout-updater-${Date.now()}.cmd`);
    const script = [
      '@echo off',
      'setlocal',
      'timeout /t 2 /nobreak >nul',
      `copy /y "${currentExePath}" "${backupExePath}" >nul`,
      `copy /y "${downloadedPath}" "${currentExePath}" >nul`,
      'if errorlevel 1 (',
      `  copy /y "${backupExePath}" "${currentExePath}" >nul`,
      ')',
      `start "" "${currentExePath}"`,
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

app.whenReady().then(createLauncher);
app.on('window-all-closed', () => { app.quit(); });
