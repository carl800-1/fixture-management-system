'use strict';
/* ============================================================
 * main.js — 夹具管理系统主进程（v1.8）
 * ============================================================ */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');

// 【v1.2 关键修复】解决「窗口只剩标题框、无法关闭也无法切换」的致命问题。
// 根因：受限环境（企业电脑 / 远程桌面 / 虚拟机 / 沙箱）下 Chromium 沙箱无法初始化，
//   GPU 进程反复崩溃，累计后触发 FATAL "GPU process isn't usable. Goodbye."，程序直接退出。
// 实测：--disable-gpu / --disable-software-rasterizer 均无效（GPU 进程仍崩溃），
//   只有 --no-sandbox 能解决。本程序为纯本地应用、不加载任何远程网页内容，
//   关闭沙箱的兼容性收益大于安全代价。
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
// disableHardwareAcceleration 只能在 app ready 之前调用；自动化测试（test_e2e.js）
// require 本模块时 app 可能已 ready，故用 isReady 保护。
if (!app.isReady()) {
  app.disableHardwareAcceleration();
}

const exeDir = path.dirname(process.execPath);
const dataDir = app.isPackaged ? exeDir : path.join(app.getPath('userData'), 'fixture-mgmt');
store.setDataDir(dataDir);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    title: '夹具管理系统 v1.8',
    backgroundColor: '#f1f5f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.setMenuBarVisibility(false);
}

const handlers = {
  'db-open': () => store.open(),
  'db-getAll': (e, name) => store.getAll(name),
  'db-get': (e, p) => store.get(p.name, p.id),
  'db-add': (e, p) => store.add(p.name, p.item),
  'db-put': (e, p) => store.put(p.name, p.item),
  'db-del': (e, p) => store.del(p.name, p.id),
  'db-clear': (e, name) => store.clear(name),
  'db-count': (e, name) => store.count(name),
  'db-getMeta': (e, key) => store.getMeta(key),
  'db-setMeta': (e, p) => store.setMeta(p.key, p.value),
  // 夹具管理
  'fixture-add': (e, fixture) => store.addFixture(fixture),
  'fixture-update': (e, fixture) => store.updateFixture(fixture),
  'fixture-del': (e, id) => store.delFixture(id),
  'fixture-getAll': () => store.getAll('fixtures'),
  'fixture-addTransaction': (e, tx) => store.addFixTransaction(tx),
  'fixture-getTransactions': () => store.getAll('fixTransactions'),
  /* 打印二维码标签：按传入的 pageSize（毫米换算的微米 / 标准尺寸名）与份数调用 Chromium 打印，
   * 由渲染进程设置 #printArea 的 CSS 变量控制对齐与边距，这里只负责把纸张规格交给打印引擎。 */
  'print-labels': (e, opts) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return Promise.resolve({ ok: false, error: 'no-window' });
    return new Promise((resolve) => {
      try {
        win.webContents.print({
          silent: false,            // 弹出系统打印对话框，由用户选择打印机/确认
          printBackground: true,    // 打印标签边框与背景
          color: true,
          copies: (opts && opts.copies) || 1,
          pageSize: opts && opts.pageSize, // { width, height } 微米 或 'A4' 等标准名
          margins: { marginType: 'none' }  // 边距由渲染层 CSS 控制，避免双重计算
        }, (success, reason) => resolve({ ok: !!success, reason: reason || '' }));
      } catch (err) {
        resolve({ ok: false, error: String((err && err.message) || err) });
      }
    });
  }
};

for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, fn);
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
