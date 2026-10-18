'use strict';
/* ============================================================
 * main.js — 工装夹具管理程序主进程（v4.0.6）
 * ============================================================ */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const { readWorkbook } = require('./js/xlsx_reader');

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
    title: '工装夹具管理程序',
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
  // 桥梁编号分配（4 位纯数字，1001 起顺延填补空洞）
  'next-free-code': () => store.nextFreeCode(),
  // 关联维护（v4.0.0）：线体 / 工位 / 机种 的「增改查」走通用 db-add / db-put / db-getAll
  //（集合名 lines / stations / productions），删除需级联清理，故走专用通道。
  'line-del': (e, id) => store.delLine(id),
  'station-del': (e, id) => store.delStation(id),
  'production-del': (e, id) => store.delProduction(id),
  'production-rename': (e, p) => store.renameProduction(p.id, p.name),
  /* 撤销接口：产线导入只做「追加」，误加需能撤销。
   * 三者共用「编辑夹具」扇区的移除按钮代码路径。 */
  'fixture-line-remove': (e, p) => store.removeFixtureLine(p.code, p.lineId),
  'fixture-station-remove': (e, p) => store.removeFixtureStation(p.code, p.stationId),
  'fixture-lines-removeBatch': (e, p) => store.removeFixtureLinesByBatch(p.codes, p.lineId),
  /* Excel 导入：渲染进程读不到 zlib，故由它把文件字节传进来，此处解 zip + 解析 XML。
   * 返回首张工作表的二维数组；出错时返回 { ok:false, error } 而非 reject，便于 UI 提示。 */
  'read-spreadsheet': (e, buf) => {
    try {
      const wb = readWorkbook(Buffer.from(buf));
      return { ok: true, sheetNames: wb.sheetNames, rows: wb.sheets[0].rows, sheetName: wb.sheets[0].name };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },
  /* 打开系统文件选择框读取表格文件。
   * 返回 { ok, name, kind:'csv'|'xlsx', text? , bytes? }；取消返回 { ok:false, canceled:true } */
  'pick-spreadsheet': async (e) => {
    try {
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog({
        title: '选择要导入的表格文件',
        properties: ['openFile'],
        filters: [
          { name: 'Excel 工作簿', extensions: ['xlsx'] },
          { name: 'CSV 文件', extensions: ['csv'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      const p = r.filePaths[0];
      const name = path.basename(p);
      if (/\.csv$/i.test(name)) {
        return { ok: true, name, kind: 'csv', text: fs.readFileSync(p, 'utf8') };
      }
      return { ok: true, name, kind: 'xlsx', bytes: Array.from(fs.readFileSync(p)) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },
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
  // 测试模式：多窗口时不自动退出，允许测试完成
  if (BrowserWindow.getAllWindows().length > 0) return;
  if (process.platform !== 'darwin') app.quit();
});
