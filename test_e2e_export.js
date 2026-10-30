'use strict';
/* ============================================================
 * test_e2e_export.js — 真实 Electron 窗口里的「导出 Excel」端到端测试
 *
 * 目的：验证 v5.8.3 新增的导出不是「只在本机 node 脚本里能跑」，
 *   而是在真实渲染进程 + 真实下载链路下产出可用的 .xlsx：
 *     1 预置 6 条夹具（覆盖 4 类异常 + 库位分布）
 *     2 打开异常工装页 → 点「📊 导出 Excel」→ 弹窗 5 个类型 + 取色器
 *     3 点「导出」→ 主进程 will-download 拦下并落盘 → 校验 zip / 工作表 / 行数
 *     4 取消勾选部分类型再导一次 → 工作表数量随之减少
 *     5 颜色配置写入 localStorage
 *
 * 运行：node_modules/electron/dist/electron.exe test_e2e_export.js
 *   ⚠️ 必须用 electron.exe（CLI binary），不能用 node 运行
 * ============================================================ */
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = path.join(os.tmpdir(), 'fixture-e2e-export-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

/* ---------- 预置数据（应用启动即读） ---------- */
const DATA_DIR = path.join(TMP, 'fixture-mgmt');
fs.mkdirSync(DATA_DIR, { recursive: true });
const now = Date.now();
let nextId = 1;
function mk(serialNo, name, location) {
  return {
    serialNo, name, lineModels: [], category: '', location, remark: '', lines: [],
    code: String(2000 + nextId), id: 9000 + nextId++, status: 'stocked',
    totalOutCount: 0, totalReturnCount: 0, repairCount: 0, createdAt: now, updatedAt: now
  };
}
const FIXTURES = [
  mk('G10BP5-921-025-001', '定位销-压板2', 'ZP1-A-1-1'),   // ① 名称套号不符（001 vs 尾号 2）
  mk('BM40M2-921-001', '部品锁入主轴-底座', 'ZP1-B-1-1'),   // ② 名称主干不同
  mk('BM40M2-921-002', '部品锁入主轴-压头', 'ZP1-B-1-1'),
  mk('CR12VY-921-030001', '锁机盖壳', 'ZP1-C-1-1'),         // ③ 编号格式异常（末尾非 3 位）
  mk('XXK-D10VG-001', '对中块1', 'ZP1-D-1-1'),              // ④ 套号缺失（缺 002）
  mk('XXK-D10VG-003', '对中块3', 'ZP1-D-1-2'),
  mk('BH18LTX-921-001-001', '卡簧压入汽缸外-压头工装', 'ZP1-L24-0-0')  // ⑤ 库位分布（单套不触发，另有 2 套在别处）
];
FIXTURES.push(mk('BH18LTX-921-001-002', '卡簧压入汽缸外-压头工装', 'ZP1-L25-0-0'));
fs.writeFileSync(path.join(DATA_DIR, 'fixture-data.json'), JSON.stringify({
  fixtures: FIXTURES, fixTransactions: [], lines: [], productions: [], staffs: []
}, null, 2), 'utf8');

/* ---------- Electron ---------- */
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.setPath('userData', TMP);

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (extra !== undefined ? ' -> ' + extra : '')); console.log('  ❌ ' + name + (extra !== undefined ? ' -> ' + extra : '')); }
}
function section(t) { console.log('\n【' + t + '】'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DL = path.join(TMP, 'downloads');
fs.mkdirSync(DL, { recursive: true });

async function main() {
  await app.whenReady();
  require('./main.js');
  await sleep(800);

  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.error('窗口未创建'); process.exit(1); }
  const wc = win.webContents;

  const consoleErrors = [];
  wc.on('console-message', (ev, level, message, line, sourceId) => {
    if (level === 3 || level === 'error') consoleErrors.push(message);
  });

  /* 拦住下载并落盘（避免弹出「另存为」对话框卡住测试） */
  const downloads = [];
  let dlSeq = 0;
  wc.session.on('will-download', (e, item) => {
    // 同一分钟内两次导出文件名相同，加序号避免后一次覆盖前一次
    const savePath = path.join(DL, (++dlSeq) + '_' + item.getFilename());
    item.setSavePath(savePath);
    downloads.push(savePath);
  });

  for (let i = 0; i < 40; i++) {
    const ready = await wc.executeJavaScript('!!(window.showView && window.openExportAnomalyModal)').catch(() => false);
    if (ready) break;
    await sleep(250);
  }

  /* ---------- 1. 页面与按钮 ---------- */
  section('1. 异常工装页 / 导出入口');
  const page = await wc.executeJavaScript(`(async () => {
    window.showView('fixanomaly');
    await new Promise(r => setTimeout(r, 500));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('导出 Excel'));
    return {
      hasBtn: !!btn,
      onclick: btn ? btn.getAttribute('onclick') : '',
      refresh: [...document.querySelectorAll('button')].some(b => b.textContent.includes('刷新')),
      xlsxLoaded: typeof window.XlsxWriter === 'object' && typeof window.XlsxWriter.create === 'function',
      stat: (document.querySelector('.info-tip') || {}).textContent || ''
    };
  })()`);
  ok('「📊 导出 Excel」按钮存在', page.hasBtn);
  ok('按钮挂在 openExportAnomalyModal', page.onclick === 'openExportAnomalyModal()', page.onclick);
  ok('「🔄 刷新」按钮仍在（未被替换）', page.refresh);
  ok('xlsx_writer.js 已随包加载（window.XlsxWriter）', page.xlsxLoaded);
  ok('页面统计包含「名称套号不符」', page.stat.includes('名称套号不符'), page.stat.slice(0, 40));

  /* ---------- 2. 配置弹窗 ---------- */
  section('2. 导出配置弹窗');
  const modal = await wc.executeJavaScript(`(async () => {
    window.openExportAnomalyModal();
    await new Promise(r => setTimeout(r, 200));
    const types = ['seqNameAnoms','nameAnoms','unparsed','missingAnoms','locInfo'];
    return {
      open: !document.querySelector('#modalOverlay').hidden,
      checks: types.filter(k => !!document.querySelector('#export_type_' + k)).length,
      colors: types.map(k => (document.querySelector('#export_color_' + k) || {}).value),
      hexLabels: types.filter(k => !!document.querySelector('#export_hex_' + k)).length,
      allOn: types.every(k => document.querySelector('#export_type_' + k).checked),
      hasAllBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('全选')),
      hasResetBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('恢复默认颜色'))
    };
  })()`);
  ok('弹窗已打开', modal.open);
  ok('5 个异常类型勾选框齐全', modal.checks === 5, modal.checks);
  ok('5 个取色器齐全且默认色正确', JSON.stringify(modal.colors) === JSON.stringify(['#ffcccc', '#ffcccc', '#ffcccc', '#fff9e6', '#e6f3ff']), modal.colors);
  ok('十六进制回显元素齐全', modal.hexLabels === 5, modal.hexLabels);
  ok('默认全部勾选', modal.allOn);
  ok('有「全选」/「恢复默认颜色」辅助按钮', modal.hasAllBtn && modal.hasResetBtn);

  /* ---------- 3. 导出（全选） ---------- */
  section('3. 导出全部 5 类');
  await wc.executeJavaScript('window.submitExportAnomaly(); true');
  for (let i = 0; i < 60 && downloads.length === 0; i++) await sleep(200);
  ok('触发了下载事件', downloads.length === 1, downloads.length);

  const f1 = downloads[0];
  ok('文件名以 .xlsx 结尾（不是 .html）', /\.xlsx$/.test(path.basename(f1 || '')), path.basename(f1 || ''));
  let buf1 = Buffer.alloc(0);
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(f1) && fs.statSync(f1).size > 0) { buf1 = fs.readFileSync(f1); break; }
    await sleep(150);
  }
  ok('文件已落盘且非空', buf1.length > 2000, buf1.length);
  ok('首 4 字节为 zip 本地头 PK\\3\\4', buf1.length >= 4 && buf1.readUInt32LE(0) === 0x04034B50);
  const raw1 = buf1.toString('utf8');
  const names1 = Array.from(raw1.matchAll(/<sheet name="([^"]*)"/g)).map((m) => m[1]);
  ok('工作簿含 5 个工作表', names1.length === 5, names1);
  ok('表名与异常类型对应', names1.join(',') === '①名称套号不符,②名称主干不同,③编号格式异常,④套号缺失,库位分布', names1);
  ok('含 styles.xml（说明带样式，不是纯文本表）', raw1.includes('xl/styles.xml'));
  ok('数据行填充色已写入（FFFFCCCC / FFFFF9E6 / FFE6F3FF）',
    raw1.includes('rgb="FFFFCCCC"') && raw1.includes('rgb="FFFFF9E6"') && raw1.includes('rgb="FFE6F3FF"'));
  ok('首行冻结', /state="frozen"/.test(raw1));

  /* 行数核对：① 1 条、② 1 组、③ 1 条、④ 1 组、库位分布 2 个工装号（XXK 两套也在不同库位）= 6 行 */
  const rowCounts = Array.from(raw1.matchAll(/<row r="/g)).length;
  ok('总行数 = 表头 5 + 数据 6', rowCounts === 11, rowCounts);

  /* ---------- 4. 只选两类再导 ---------- */
  section('4. 取消勾选后只导 2 类');
  downloads.length = 0;
  await wc.executeJavaScript(`(async () => {
    window.openExportAnomalyModal();
    await new Promise(r => setTimeout(r, 150));
    ['unparsed','missingAnoms','locInfo'].forEach(k => { document.querySelector('#export_type_' + k).checked = false; });
    document.querySelector('#export_color_nameAnoms').value = '#ffdddd';
    window.exportAnomalyHex('nameAnoms', '#ffdddd');
    window.submitExportAnomaly();
    return true;
  })()`);
  for (let i = 0; i < 60 && downloads.length === 0; i++) await sleep(200);
  ok('第二次下载已触发', downloads.length === 1, downloads.length);
  let buf2 = Buffer.alloc(0);
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(downloads[0]) && fs.statSync(downloads[0]).size > 0) { buf2 = fs.readFileSync(downloads[0]); break; }
    await sleep(150);
  }
  const names2 = Array.from(buf2.toString('utf8').matchAll(/<sheet name="([^"]*)"/g)).map((m) => m[1]);
  ok('只导出勾选的 2 类', names2.length === 2, names2);
  ok('自定义颜色 #ffdddd 生效', buf2.toString('utf8').includes('rgb="FFFFDDDD"'), names2);

  /* ---------- 5. 配置持久化 ---------- */
  section('5. 颜色配置持久化');
  const saved = await wc.executeJavaScript(`(function(){
    try { return JSON.parse(localStorage.getItem('fixAnomalyExportColors') || 'null'); } catch (e) { return 'ERR:' + e.message; }
  })()`);
  ok('颜色配置已写入 localStorage', saved && saved.nameAnoms === '#ffdddd', JSON.stringify(saved));
  const reopen = await wc.executeJavaScript(`(async () => {
    window.openExportAnomalyModal();
    await new Promise(r => setTimeout(r, 150));
    const v = (document.querySelector('#export_color_nameAnoms') || {}).value;
    window.closeModal();
    return v;
  })()`);
  ok('重新打开弹窗沿用上次颜色', reopen === '#ffdddd', reopen);

  /* ---------- 6. 无运行期错误 ---------- */
  section('6. 运行期错误');
  ok('渲染进程无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  console.log('\n=== 结果 ===');
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail) console.log('失败项:\n - ' + failures.join('\n - '));
  console.log('导出文件：' + downloads.filter(Boolean).join(' , '));
  app.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('E2E 崩溃:', e); app.exit(2); });
