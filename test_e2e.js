'use strict';
/* ============================================================
 * test_e2e.js — 真实运行测试
 * 启动真实 Electron 窗口 → 加载 index.html → 驱动 UI 走完整业务流程
 * → 主进程侧读取 JSON 数据文件校验结果 → 捕获所有 console 错误
 *
 * 运行：node_modules/.bin/electron test_e2e.js
 *   （或 node_modules/electron/dist/electron.exe test_e2e.js）
 * ============================================================ */
const path = require('path');
const fs = require('fs');
const os = require('os');

/* 必须在 require('electron') 之后、require('./main.js') 之前改 userData，
   确保测试写临时目录，绝不污染真实数据 */
const TMP = path.join(os.tmpdir(), 'fixture-e2e-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

const { app, BrowserWindow } = require('electron');

/* 测试环境（沙箱/CI）常无可用 GPU，禁用硬件加速避免 GPU 进程崩溃 */
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');

app.setPath('userData', TMP);

let pass = 0, fail = 0;
const failures = [];
const consoleErrors = [];
const pageErrors = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  ❌ ' + name + (extra ? ' -> ' + extra : '')); }
}
function section(t) { console.log('\n【' + t + '】'); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  await app.whenReady();

  /* 加载真实应用入口（main.js 会自行建窗并 loadFile index.html） */
  require('./main.js');
  await sleep(600);

  let win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.error('窗口未创建'); process.exit(1); }
  const wc = win.webContents;

  /* 捕获渲染进程错误 */
  wc.on('console-message', (ev, level, message, line, sourceId) => {
    const lvl = ['debug', 'info', 'warning', 'error'][level] || level;
    if (lvl === 'error') consoleErrors.push(message + ' @' + (sourceId || '') + ':' + line);
  });
  wc.on('did-fail-load', (e, code, desc) => pageErrors.push('did-fail-load ' + code + ' ' + desc));

  /* 等待页面就绪 */
  for (let i = 0; i < 40; i++) {
    const ready = await wc.executeJavaScript('!!(window.fixtureNew && window.showView)').catch(() => false);
    if (ready) break;
    await sleep(250);
  }

  section('0. 应用启动');
  const boot = await wc.executeJavaScript('({title: document.title, hasContent: !!document.querySelector("#content"), navCount: document.querySelectorAll(".nav-item").length})');
  ok('页面标题正确 v1.9', /v1\.9/.test(boot.title), boot.title);
  ok('主内容容器存在', boot.hasContent);
  ok('导航项 7 个（含库位管理）', boot.navCount === 7, String(boot.navCount));
  const cssLoaded = await wc.executeJavaScript('getComputedStyle(document.body).backgroundColor');
  ok('CSS 已生效（v1.0 曾丢失样式）', cssLoaded !== 'rgba(0, 0, 0, 0)' && cssLoaded !== 'transparent', cssLoaded);

  /* ---------- 1. showView 回归测试 ---------- */
  section('1. showView 全局挂载（v1.0 严重 bug 回归）');
  const svRes = await wc.executeJavaScript(`(async () => {
    const out = {};
    for (const v of ['fixtures','outbound','return','records','data','dashboard']) {
      try { window.showView(v); out[v] = 'OK'; }
      catch (e) { out[v] = 'FAIL:' + e.message; }
    }
    // 直接点击「返回列表选择」按钮（v1.0 中该按钮点击必崩）
    window.showView('outbound');
    await new Promise(r=>setTimeout(r,80));
    const btn = [...document.querySelectorAll('button')].find(b=>b.textContent.includes('返回列表选择'));
    if (btn) { try { btn.click(); out.btnClick='OK'; } catch(e){ out.btnClick='FAIL:'+e.message; } }
    else out.btnClick = 'NO_BTN';
    await new Promise(r=>setTimeout(r,150));
    out.finalTitle = document.querySelector('#viewTitle').textContent;
    return out;
  })()`);
  Object.keys(svRes).filter((k) => k !== 'finalTitle' && k !== 'btnClick').forEach((v) => {
    ok('showView(' + v + ')', svRes[v] === 'OK', svRes[v]);
  });
  ok('点击「返回列表选择」不报错', svRes.btnClick === 'OK', svRes.btnClick);

  /* ---------- 2. 建档 ---------- */
  section('2. 夹具建档（走真实 UI）');
  const newRes = await wc.executeJavaScript(`(async () => {
    const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('fixtures'); await sleep(120);
    window.fixtureNew(); await sleep(120);
    const set = (id,v)=>{ const el=document.querySelector(id); if(el) el.value=v; return !!el; };
    const found = {
      code: set('#fix_new_code','2001'), name: set('#fix_new_name','焊接夹具A'),
      spec: set('#fix_new_spec','WJ-100'), cat: set('#fix_new_cat','焊接'),
      loc: set('#fix_new_loc','A1-01'), remark: set('#fix_new_remark','测试建档')
    };
    [...document.querySelectorAll('button')].find(b=>b.textContent.includes('建档')).click();
    await sleep(500);
    const listText = (document.querySelector('#fixture_list')||{textContent:''}).textContent;
    return { found, hasCard: listText.includes('2001'), modalClosed: !document.querySelector('#modalOverlay').classList.contains('show') };
  })()`);
  ok('建档表单字段齐全', Object.values(newRes.found).every(Boolean), JSON.stringify(newRes.found));
  ok('新夹具卡片已渲染', newRes.hasCard);

  // 编号校验：非法编号应被拒绝
  const badRes = await wc.executeJavaScript(`(async () => {
    const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
    window.fixtureNew(); await sleep(120);
    document.querySelector('#fix_new_code').value='12';
    document.querySelector('#fix_new_name').value='非法编号';
    [...document.querySelectorAll('button')].find(b=>b.textContent.includes('建档')).click();
    await sleep(300);
    return (document.querySelector('#fixture_list')||{textContent:''}).textContent.includes('非法编号');
  })()`);
  ok('非法编号（12）被拒绝', !badRes);

  const dupRes = await wc.executeJavaScript(`(async () => {
    const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
    window.closeModal(); await sleep(80);
    window.fixtureNew(); await sleep(120);
    document.querySelector('#fix_new_code').value='2001';
    document.querySelector('#fix_new_name').value='重复编号';
    [...document.querySelectorAll('button')].find(b=>b.textContent.includes('建档')).click();
    await sleep(400);
    return (document.querySelector('#fixture_list')||{textContent:''}).textContent.includes('重复编号');
  })()`);
  ok('重复编号 2001 被拒绝', !dupRes);
  await wc.executeJavaScript('window.closeModal()');

  /* 再建两个夹具用于后续流程 */
  for (const [code, name] of [['2002', '冲压夹具B'], ['2003', '装配夹具C']]) {
    await wc.executeJavaScript(`(async () => {
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      window.fixtureNew(); await sleep(120);
      document.querySelector('#fix_new_code').value='${code}';
      document.querySelector('#fix_new_name').value='${name}';
      [...document.querySelectorAll('button')].find(b=>b.textContent.includes('建档')).click();
      await sleep(400);
    })()`);
  }

  /* ---------- 3. 出库 ---------- */
  section('3. 出库流程（真实 UI + 数据校验）');
  const outRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('fixtures'); await sleep(150);
    // 找到 2001 的卡片并点击「出库」
    const card = [...document.querySelectorAll('.fixture-card')].find(c=>c.textContent.includes('2001'));
    if (!card) return { err:'未找到 2001 卡片' };
    const btn = [...card.querySelectorAll('button')].find(b=>b.textContent.includes('出库'));
    if (!btn) return { err:'卡片无出库按钮' };
    btn.click(); await sleep(200);
    const hasOp = !!document.querySelector('#fix_out_op');
    if (hasOp) {
      document.querySelector('#fix_out_op').value='李四';
      document.querySelector('#fix_out_party').value='生产一车间';
      document.querySelector('#fix_out_remark').value='首次领用';
      [...document.querySelectorAll('#modalBox button, .modal button')].find(b=>b.textContent.includes('确认出库')).click();
    }
    await sleep(600);
    return { hasOp };
  })()`);
  ok('出库弹窗打开且字段存在', outRes.hasOp === true, JSON.stringify(outRes));

  /* 主进程侧读数据文件校验 */
  const store = require('./store.js');
  const dataFile = path.join(TMP, 'fixture-mgmt', 'fixture-data.json');
  ok('数据文件已生成于隔离目录', fs.existsSync(dataFile), dataFile);
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const f2001 = db.fixtures.find((f) => f.code === '2001');
  ok('夹具 2001 已入库', !!f2001);
  ok('2001 状态 = checked_out', f2001 && f2001.status === 'checked_out', f2001 && f2001.status);
  ok('2001 出库次数 = 1', f2001 && f2001.totalOutCount === 1, f2001 && String(f2001.totalOutCount));
  const txOut = db.fixTransactions.find((t) => t.fixtureCode === '2001' && t.type === 'out');
  ok('出库流水已写入', !!txOut);
  ok('流水经办人 = 李四', txOut && txOut.operator === '李四', txOut && txOut.operator);
  ok('流水领用人 = 生产一车间', txOut && txOut.counterparty === '生产一车间', txOut && txOut.counterparty);
  ok('流水状态迁移 recorded', txOut && txOut.fromStatus === 'stocked' && txOut.toStatus === 'checked_out');

  /* ---------- 4. 回库 ---------- */
  section('4. 回库流程（v1.4 改为四栏互查）');
  const retRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('return'); await sleep(250);
    // v1.4 回库页改为四栏互查：输入编号后命中唯一自动弹出回库表单
    const codeBox = document.querySelector('#return_code');
    if (!codeBox) return { err:'回库页无编号输入框' };
    codeBox.value='2001';
    codeBox.dispatchEvent(new Event('input'));
    await sleep(400);
    const hasOp = !!document.querySelector('#fix_return_op');
    if (hasOp) {
      document.querySelector('#fix_return_op').value='王五';
      document.querySelector('#fix_return_remark').value='归还完好';
      [...document.querySelectorAll('button')].find(b=>b.textContent.includes('确认回库')).click();
    }
    await sleep(600);
    return { hasOp };
  })()`);
  ok('回库弹窗打开且字段存在', retRes.hasOp === true, JSON.stringify(retRes));

  const db2 = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const f2001b = db2.fixtures.find((f) => f.code === '2001');
  ok('2001 状态回到 stocked', f2001b.status === 'stocked', f2001b.status);
  ok('2001 回库次数 = 1', f2001b.totalReturnCount === 1, String(f2001b.totalReturnCount));
  ok('回库流水已写入', db2.fixTransactions.some((t) => t.fixtureCode === '2001' && t.type === 'return' && t.operator === '王五'));

  /* ---------- 5. 多轮循环（核心需求）---------- */
  section('5. 重复出库/回库 3 轮（核心需求）');
  for (let i = 0; i < 3; i++) {
    await wc.executeJavaScript(`(async () => {
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      window.showView('fixtures'); await sleep(150);
      const card=[...document.querySelectorAll('.fixture-card')].find(c=>c.textContent.includes('2001'));
      [...card.querySelectorAll('button')].find(b=>b.textContent.includes('出库')).click();
      await sleep(200);
      document.querySelector('#fix_out_op').value='李四';
      [...document.querySelectorAll('button')].find(b=>b.textContent.includes('确认出库')).click();
      await sleep(450);
      // v1.4 回库改为四栏互查
      window.showView('return'); await sleep(200);
      const codeBox = document.querySelector('#return_code');
      codeBox.value='2001';
      codeBox.dispatchEvent(new Event('input'));
      await sleep(400);
      document.querySelector('#fix_return_op').value='王五';
      [...document.querySelectorAll('button')].find(b=>b.textContent.includes('确认回库')).click();
      await sleep(450);
    })()`);
  }
  const db3 = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const f2001c = db3.fixtures.find((f) => f.code === '2001');
  ok('累计出库 4 次', f2001c.totalOutCount === 4, String(f2001c.totalOutCount));
  ok('累计回库 4 次', f2001c.totalReturnCount === 4, String(f2001c.totalReturnCount));
  ok('最终状态 stocked', f2001c.status === 'stocked', f2001c.status);
  const tx2001 = db3.fixTransactions.filter((t) => t.fixtureCode === '2001');
  ok('2001 流水累计 8 条', tx2001.length === 8, String(tx2001.length));

  /* ---------- 6. 送修 ---------- */
  section('6. 送修与维修完成');
  const repRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('fixtures'); await sleep(150);
    const card=[...document.querySelectorAll('.fixture-card')].find(c=>c.textContent.includes('2002'));
    if(!card) return {err:'无2002'};
    const btn=[...card.querySelectorAll('button')].find(b=>b.textContent.includes('维修')||b.textContent.includes('送修'));
    if(!btn) return {err:'无送修按钮', btns:[...card.querySelectorAll('button')].map(b=>b.textContent)};
    btn.click(); await sleep(250);
    const hasOp=!!document.querySelector('#fix_repair_op');
    const hasType=!!document.querySelector('#fix_repair_type');
    if(hasOp&&hasType){
      document.querySelector('#fix_repair_op').value='赵六';
      document.querySelector('#fix_repair_type').value='calibrate';
      document.querySelector('#fix_repair_remark').value='精度校准';
      [...document.querySelectorAll('button')].find(b=>b.textContent.includes('确认送修')).click();
    }
    await sleep(600);
    return {hasOp, hasType};
  })()`);
  ok('送修弹窗字段齐全', repRes.hasOp === true && repRes.hasType === true, JSON.stringify(repRes));

  const db4 = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const f2002 = db4.fixtures.find((f) => f.code === '2002');
  ok('2002 状态 = repair', f2002.status === 'repair', f2002.status);
  ok('2002 维修次数 = 1', f2002.repairCount === 1, String(f2002.repairCount));
  const repTx = db4.fixTransactions.find((t) => t.fixtureCode === '2002' && t.type === 'repair');
  ok('送修流水已写入', !!repTx);
  ok('维修子类型已保留（v1.1 修复）', repTx && repTx.repairType === 'calibrate', repTx && String(repTx.repairType));

  const compRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('fixtures'); await sleep(200);
    const card=[...document.querySelectorAll('.fixture-card')].find(c=>c.textContent.includes('2002'));
    const btn=[...card.querySelectorAll('button')].find(b=>b.textContent.includes('维修完成'));
    if(!btn) return {err:'无维修完成按钮', btns:[...card.querySelectorAll('button')].map(b=>b.textContent)};
    btn.click(); await sleep(300);
    const hasOp = !!document.querySelector('#fix_rdone_op');
    if (hasOp) {
      document.querySelector('#fix_rdone_op').value='赵六';
      document.querySelector('#fix_rdone_remark').value='更换定位销，校准合格';
      [...document.querySelectorAll('button')].find(b=>b.textContent.includes('确认完成并回库')).click();
    }
    await sleep(700);
    return {hasOp};
  })()`);
  ok('维修完成弹窗字段存在（v1.1 改为 modal）', compRes.hasOp === true, JSON.stringify(compRes));
  const db5 = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const f2002b = db5.fixtures.find((f) => f.code === '2002');
  ok('2002 维修完成后回到 stocked', f2002b.status === 'stocked', f2002b.status);
  const rdoneTx = db5.fixTransactions.find((t) => t.fixtureCode === '2002' && t.type === 'repair_done');
  ok('repair_done 流水已写入', !!rdoneTx);
  ok('维修完成流水状态迁移 repair→stocked', rdoneTx && rdoneTx.fromStatus === 'repair' && rdoneTx.toStatus === 'stocked',
    rdoneTx ? rdoneTx.fromStatus + '->' + rdoneTx.toStatus : 'N/A');
  ok('维修完成后可再次出库', await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('fixtures'); await sleep(200);
    const card=[...document.querySelectorAll('.fixture-card')].find(c=>c.textContent.includes('2002'));
    const btn=[...card.querySelectorAll('button')].find(b=>b.textContent.trim()==='出库');
    if(!btn) return false;
    btn.click(); await sleep(250);
    const op=document.querySelector('#fix_out_op');
    if(!op) return false;
    op.value='李四';
    [...document.querySelectorAll('button')].find(b=>b.textContent.includes('确认出库')).click();
    await sleep(600);
    return true;
  })()`));

  /* ---------- 7. 报废 ---------- */
  section('7. 报废流程（v1.1 改为 modal，去掉阻塞式 confirm）');
  const retireRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('fixtures'); await sleep(200);
    const card=[...document.querySelectorAll('.fixture-card')].find(c=>c.textContent.includes('2003'));
    [...card.querySelectorAll('button')].find(b=>b.textContent.includes('报废')).click();
    await sleep(300);
    const hasOp = !!document.querySelector('#fix_retire_op');
    if (hasOp) {
      document.querySelector('#fix_retire_op').value='管理员';
      document.querySelector('#fix_retire_remark').value='精度超差无法修复';
      [...document.querySelectorAll('button')].find(b=>b.textContent.includes('确认报废')).click();
    }
    await sleep(700);
    return {hasOp};
  })()`);
  ok('报废弹窗字段存在', retireRes.hasOp === true, JSON.stringify(retireRes));
  const db6 = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const f2003 = db6.fixtures.find((f) => f.code === '2003');
  ok('2003 状态 = retired', f2003.status === 'retired', f2003.status);
  ok('报废后卡片无出库按钮', await wc.executeJavaScript(`(() => {
    const card=[...document.querySelectorAll('.fixture-card')].find(c=>c.textContent.includes('2003'));
    return card ? ![...card.querySelectorAll('button')].some(b=>b.textContent.includes('出库')) : false;
  })()`));

  /* ---------- 8. 搜索 / 统计 / 导出 ---------- */
  section('8. 搜索、统计与导出');
  const searchRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('fixtures'); await sleep(150);
    const box=document.querySelector('#fix_search');
    box.value='2001'; box.dispatchEvent(new Event('input')); await sleep(200);
    const n1=document.querySelectorAll('#fixture_list .fixture-card').length;
    box.value='不存在的夹具XYZ'; box.dispatchEvent(new Event('input')); await sleep(200);
    const empty=!!document.querySelector('#fixture_list .empty-tip');
    box.value=''; box.dispatchEvent(new Event('input')); await sleep(200);
    const n2=document.querySelectorAll('#fixture_list .fixture-card').length;
    return {n1, empty, n2};
  })()`);
  ok('搜索 2001 命中 1 条', searchRes.n1 === 1, JSON.stringify(searchRes));
  ok('无结果显示空提示', searchRes.empty === true);
  ok('清空搜索恢复全部 3 条', searchRes.n2 === 3, String(searchRes.n2));

  const statsRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('dashboard'); await sleep(200);
    return document.querySelector('#content').textContent.replace(/\\s+/g,' ').slice(0,200);
  })()`);
  ok('仪表盘可渲染', statsRes.length > 10, statsRes.slice(0, 80));

  /* 流水记录页使用 CSS 网格布局（.tx-list / .tx-row），非 <table> */
  const recRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('records'); await sleep(300);
    const rows=[...document.querySelectorAll('#rec_list .tx-row')];
    return {
      hasList: !!document.querySelector('#rec_list .tx-list'),
      rows: rows.filter(r=>!r.classList.contains('tx-header')).length,
      hasHeader: rows.some(r=>r.classList.contains('tx-header')),
      sample: rows.length>1 ? rows[1].textContent.replace(/\\s+/g,' ').trim().slice(0,60) : ''
    };
  })()`);
  ok('流水记录页渲染列表', recRes.hasList, JSON.stringify(recRes));
  ok('流水记录含表头', recRes.hasHeader);
  ok('流水记录有数据行', recRes.rows > 0, String(recRes.rows));
  console.log('     示例行：' + recRes.sample);

  /* 流水搜索 */
  const recSearch = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const box=document.querySelector('#rec_search');
    box.value='李四'; box.dispatchEvent(new Event('input')); await sleep(250);
    const n1=[...document.querySelectorAll('#rec_list .tx-row')].filter(r=>!r.classList.contains('tx-header')).length;
    box.value=''; box.dispatchEvent(new Event('input')); await sleep(250);
    const n2=[...document.querySelectorAll('#rec_list .tx-row')].filter(r=>!r.classList.contains('tx-header')).length;
    return {n1,n2};
  })()`);
  ok('流水按经办人搜索生效', recSearch.n1 > 0 && recSearch.n1 < recSearch.n2, JSON.stringify(recSearch));

  const dataRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('data'); await sleep(250);
    return (document.querySelector('#content')||{textContent:''}).textContent.includes('备份') ||
           (document.querySelector('#content')||{textContent:''}).textContent.includes('导出');
  })()`);
  ok('数据备份页可渲染', dataRes);

  /* ---------- 8.1 库位管理（v1.6 新增） ---------- */
  section('8.1 库位管理（v1.6 新增）');
  const locRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('location'); await sleep(350);
    const grid=document.querySelector('.loc-grid10');
    const cards=[...document.querySelectorAll('.loc-card')].map(c=>c.textContent.trim());
    return {
      hasGrid: !!grid,
      cardCount: cards.length,
      cards,
      hasA101: cards.includes('A1-01'),
      hasUnassigned: cards.includes('（未分配）'),
      hasAuditBtn: !![...document.querySelectorAll('button')].find(b=>b.textContent.includes('手工盘点'))
    };
  })()`);
  ok('库位页渲染网格', locRes.hasGrid, JSON.stringify(locRes));
  ok('库位卡片 >= 2（A1-01 + 未分配）', locRes.cardCount >= 2, String(locRes.cardCount));
  ok('卡片含 A1-01', locRes.hasA101);
  ok('「未分配」库位置于列表中', locRes.hasUnassigned);
  ok('「手工盘点」按钮存在', locRes.hasAuditBtn);

  /* 点击库位卡片筛选 */
  const locFilterRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const card=[...document.querySelectorAll('.loc-card')].find(c=>c.textContent.trim()==='A1-01');
    if(!card) return {err:'无 A1-01 卡片'};
    card.click(); await sleep(350);
    const rows=[...document.querySelectorAll('.loc-bottom tbody tr')].map(r=>r.textContent);
    const has2001=rows.some(r=>r.includes('2001'));
    const has2002=rows.some(r=>r.includes('2002'));
    const hasClearBtn=!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('清除筛选'));
    return {rows:rows.length, has2001, has2002, hasClearBtn};
  })()`);
  ok('点击 A1-01 后筛选出 1 件', locFilterRes.rows === 1 && locFilterRes.has2001, JSON.stringify(locFilterRes));
  ok('筛选后不含 2002', !locFilterRes.has2002);
  ok('出现「清除筛选」按钮', locFilterRes.hasClearBtn);

  /* 清除筛选恢复全部 */
  const locClearRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('清除筛选'));
    btn.click(); await sleep(350);
    return [...document.querySelectorAll('.loc-bottom tbody tr')].length;
  })()`);
  ok('清除筛选恢复全部 3 件', locClearRes === 3, String(locClearRes));

  /* ---------- 8.2 编号归一化匹配（v1.6 新增） ---------- */
  section('8.2 编号归一化匹配');
  const normRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('fixtures'); await sleep(250);
    const box=document.querySelector('#fix_search');
    box.value='20-01'; box.dispatchEvent(new Event('input')); await sleep(250);
    const n1=document.querySelectorAll('#fixture_list .fixture-card').length;
    const hit1=(document.querySelector('#fixture_list')||{textContent:''}).textContent.includes('2001');
    box.value='20_02'; box.dispatchEvent(new Event('input')); await sleep(250);
    const hit2=(document.querySelector('#fixture_list')||{textContent:''}).textContent.includes('2002');
    box.value='SPMS1|2003'; box.dispatchEvent(new Event('input')); await sleep(250);
    const hit3=(document.querySelector('#fixture_list')||{textContent:''}).textContent.includes('2003');
    box.value=''; box.dispatchEvent(new Event('input')); await sleep(200);
    return {n1, hit1, hit2, hit3};
  })()`);
  ok('连字符编号 20-01 命中 2001', normRes.n1 === 1 && normRes.hit1, JSON.stringify(normRes));
  ok('下划线编号 20_02 命中 2002', normRes.hit2);
  ok('二维码前缀 SPMS1|2003 命中 2003', normRes.hit3);

  /* ---------- 8.3 二维码标签 + 打印（v1.7 新增） ---------- */
  section('8.3 二维码标签 + 打印');
  const qrRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('fixtures'); await sleep(250);
    const card=[...document.querySelectorAll('.fixture-card')].find(c=>c.textContent.includes('2001'));
    const qrBtn=card ? [...card.querySelectorAll('button')].find(b=>b.textContent.includes('二维码')) : null;
    const hasBatch=!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('批量打印标签'));
    if(!qrBtn) return {err:'无二维码按钮', hasBatch};
    qrBtn.click(); await sleep(400);
    const canvas=document.querySelector('#qrCanvas');
    const modalText=(document.querySelector('#modalBody')||{textContent:''}).textContent;
    const hasDownload=!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('下载 PNG'));
    const hasPrint=!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('打印'));
    return {
      hasBatch,
      hasCanvas: !!canvas,
      qrDrawn: !!canvas && canvas.width > 0 && canvas.height > 0,
      tokenShown: modalText.includes('SPMS1|2001'),
      hasDownload, hasPrint
    };
  })()`);
  ok('夹具卡片含「二维码」按钮', !qrRes.err, JSON.stringify(qrRes));
  ok('「批量打印标签」按钮存在', qrRes.hasBatch);
  ok('二维码弹窗打开并绘制二维码', qrRes.hasCanvas && qrRes.qrDrawn, JSON.stringify(qrRes));
  ok('弹窗展示二维码内容 SPMS1|2001', qrRes.tokenShown);
  ok('「下载 PNG」「打印」按钮存在', qrRes.hasDownload && qrRes.hasPrint);

  /* 点击「打印」打开打印设置面板 + 预览 */
  const printRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('打印') && !b.textContent.includes('批量'));
    btn.click(); await sleep(500);
    const page=document.querySelector('#ppPage');
    return {
      hasPaper: !!document.querySelector('#ppPaper'),
      hasAlign: !!document.querySelector('#ppHa') && !!document.querySelector('#ppVa'),
      hasCopies: !!document.querySelector('#ppCopies'),
      hasPreview: !!page,
      previewLabels: page ? page.querySelectorAll('.label-card').length : 0,
      previewQR: page ? page.querySelectorAll('.label-qr').length : 0
    };
  })()`);
  ok('打印设置面板含纸张/对齐/份数', printRes.hasPaper && printRes.hasAlign && printRes.hasCopies, JSON.stringify(printRes));
  ok('打印预览含 1 张标签', printRes.hasPreview && printRes.previewLabels === 1, JSON.stringify(printRes));
  ok('预览标签已绘制二维码', printRes.previewQR === 1);
  await wc.executeJavaScript('window.closeModal()');

  /* ---------- 8.4 列表/卡片视图切换（v1.8 新增） ---------- */
  section('8.4 列表/卡片视图切换');
  const viewRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('fixtures'); await sleep(250);
    const hasCardBtn=!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('卡片'));
    const hasListBtn=!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('列表'));
    const isCard=!!document.querySelector('#fixture_list .fixture-grid');
    // 切到列表视图
    const listBtn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('列表'));
    listBtn.click(); await sleep(300);
    const isList=!!document.querySelector('#fixture_list .table-wrap table');
    const rows=document.querySelectorAll('#fixture_list tbody tr');
    const headerText=(document.querySelector('#fixture_list thead')||{textContent:''}).textContent;
    const firstRowHasQR=rows.length>0 && rows[0].textContent.includes('二维码');
    // 切回卡片
    const cardBtn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('卡片'));
    cardBtn.click(); await sleep(300);
    const backCard=!!document.querySelector('#fixture_list .fixture-grid');
    return { hasCardBtn, hasListBtn, isCard, isList, rowCount: rows.length, headerText, firstRowHasQR, backCard };
  })()`);
  ok('夹具列表含「卡片」「列表」切换按钮', viewRes.hasCardBtn && viewRes.hasListBtn, JSON.stringify(viewRes));
  ok('默认卡片视图', viewRes.isCard);
  ok('切到列表视图显示表格', viewRes.isList);
  ok('列表视图含 3 行数据', viewRes.rowCount === 3, String(viewRes.rowCount));
  ok('列表视图含状态/操作列', viewRes.headerText.includes('状态') && viewRes.headerText.includes('操作'), viewRes.headerText);
  ok('列表行含操作按钮', viewRes.firstRowHasQR);
  ok('切回卡片视图', viewRes.backCard);

  /* ---------- 8.5 清空数据（v1.1 修复：此前只清内存不落盘） ---------- */
  section('8.5 清空数据落盘验证');
  const clearRes = await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('data'); await sleep(250);
    const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('清空'));
    if(!btn) return {err:'无清空按钮'};
    btn.click(); await sleep(300);
    const hasInput = !!document.querySelector('#fix_clear_confirm');
    // 先输错误文本，应被拒绝
    if (hasInput) {
      document.querySelector('#fix_clear_confirm').value='随便填';
      [...document.querySelectorAll('button')].find(b=>b.textContent.includes('确认清空')).click();
      await sleep(400);
    }
    const stillHas = !!document.querySelector('#fix_clear_confirm');
    // 再输入正确的「清空」，应真正执行
    if (stillHas) {
      document.querySelector('#fix_clear_confirm').value='清空';
      [...document.querySelectorAll('button')].find(b=>b.textContent.includes('确认清空')).click();
      await sleep(800);
    }
    return {hasInput, stillHas};
  })()`);
  ok('清空弹窗含确认输入框', clearRes.hasInput === true, JSON.stringify(clearRes));
  ok('错误确认文本被拒绝（弹窗未关闭）', clearRes.stillHas === true);

  /* 关键：验证数据真正写入文件（v1.0 中仅清内存，重启后数据复活） */
  const db7 = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  ok('清空后 fixtures 表已落盘为空', db7.fixtures.length === 0, String(db7.fixtures.length));
  ok('清空后 fixTransactions 表已落盘为空', db7.fixTransactions.length === 0, String(db7.fixTransactions.length));
  ok('清空后页面无夹具卡片', await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('fixtures'); await sleep(250);
    return document.querySelectorAll('.fixture-card').length;
  })()`) === 0);

  /* 重启恢复验证：清空后重新加载应仍为空 */
  await wc.reload();
  await sleep(700);
  for (let i = 0; i < 40; i++) {
    const ready = await wc.executeJavaScript('!!(window.fixtureNew && window.showView)').catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  ok('清空后重启程序数据仍为空（不复活）', await wc.executeJavaScript(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    window.showView('fixtures'); await sleep(300);
    return document.querySelectorAll('.fixture-card').length;
  })()`) === 0);

  /* ---------- 9. 错误捕获 ---------- */
  section('9. 运行期错误捕获');
  ok('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  ok('无页面加载失败', pageErrors.length === 0, pageErrors.join(' | '));

  /* ---------- 汇总 ---------- */
  console.log('\n' + '='.repeat(54));
  console.log('E2E 测试汇总：通过 ' + pass + ' / 失败 ' + fail);
  if (failures.length) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
  console.log('='.repeat(54));

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  app.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); app.exit(1); });
