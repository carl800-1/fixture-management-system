'use strict';
/* ============================================================
 * test_e2e.js — 真实运行测试（v4.0.0）
 * 启动真实 Electron 窗口 → 加载 index.html → 驱动 UI 走完整业务流程
 * → 主进程侧读取 JSON 数据文件校验结果 → 捕获所有 console 错误
 *
 * 覆盖顺序（v4 关键约束：建档强校验要求「≥1 产线 ≥1 工位」，
 *   因此必须先建产线配置，再建档）：
 *   0  启动与版本
 *   1  showView 全局挂载
 *   2  产线配置（线体 + 工位）
 *   3  夹具建档（含 7 条强校验的 UI 落地）
 *   4  出库（库位冻结）
 *   5  回库（可改库位，写回 location）
 *   6  重复出库/回库 3 轮
 *   7  送修 / 维修完成
 *   8  报废
 *   9  搜索 / 二维码标签 / 视图切换 / 流水 / 仪表盘
 *   10 库位管理（卡片数字 = 在库套数）
 *   11 产线夹具查询（只读、无产品级联、示意图）
 *   12 机种管理 / 按机种查询
 *   13 清空数据落盘 + 重启恢复
 *   14 运行期错误捕获
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

/* 渲染进程通用小工具（注入到每个 executeJavaScript 里复用） */
const HELPERS = `
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const $=(s)=>document.querySelector(s);
  const $$=(s)=>[...document.querySelectorAll(s)];
  const setV=(s,v)=>{ const el=$(s); if(!el) return false; el.value=v; el.dispatchEvent(new Event('input')); return true; };
  const btnByText=(t)=>$$('button').find(b=>b.textContent.includes(t));
  const btnByOnclick=(fn)=>$$('button').find(b=>String(b.getAttribute('onclick')||'').startsWith(fn));
  const idFromOnclick=(b,fn)=>Number(String((b&&b.getAttribute('onclick'))||'').match(new RegExp(fn+'\\\\((\\\\d+)\\\\)'))[1]);
`;

/* 建档工具：按实物编号建一套夹具（自动选产线 + 勾工位）
   ⚠️ 产线/工位都以**名称**传入：`#fix_line_pick` 只存在于表单弹窗内，
      必须在 openFixForm 之后才能读到线体 id，不能在弹窗外预先解析。 */
const NEW_FIXTURE_FN = `
  async function newFixture(o) {
    window.showView('fixtures'); await sleep(150);
    window.fixtureNew(); await sleep(300);
    const diag = [];
    if (!setV('#fix_serial', o.serialNo)) diag.push('no#fix_serial');
    setV('#fix_name', o.name);
    setV('#fix_loc', o.location); setV('#fix_cat', o.cat || '');
    if (o.remark) setV('#fix_remark', o.remark);
    (o.models || []).forEach((m) => { setV('#fix_lm_new', m); window.fixFormAddModelNew(); });
    await sleep(100);
    for (const nm of (o.lines || [])) {
      const sel = $('#fix_line_pick');
      const opt = sel ? [...sel.options].find((x) => x.textContent.includes(nm)) : null;
      if (!opt) { diag.push('no-line:' + nm); continue; }
      sel.value = opt.value; window.fixFormAddLine(); await sleep(160);
    }
    for (const nm of (o.stations || [])) {
      const cb = $$('#fix_ls_box input[type=checkbox]').find((x) => x.closest('.ls-st') && x.closest('.ls-st').textContent.includes(nm));
      if (!cb) { diag.push('no-station:' + nm); continue; }
      cb.checked = true; cb.dispatchEvent(new Event('change')); await sleep(100);
    }
    const selCount = (($('#fix_ls_count')||{}).textContent||'');
    window.submitFixForm();
    /* 建档是异步的（IPC + 首次落盘可能 >500ms）⇒ 轮询等弹窗关闭，别用固定 sleep 造成假失败 */
    for (let i = 0; i < 40; i++) { await sleep(100); if ($('#modalOverlay').hidden) break; }
    await sleep(250);
    const cardHit = (($('#fixture_list')||{textContent:''}).textContent||'').includes(o.serialNo);
    return { ok: cardHit, diag, selCount, toast: (($('#toast')||{}).textContent||''), open: $('#modalOverlay').hidden === false };
  }
`;

async function main() {
  await app.whenReady();

  /* 加载真实应用入口（main.js 会自行建窗并 loadFile index.html） */
  require('./main.js');
  await sleep(600);

  const win = BrowserWindow.getAllWindows()[0];
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

  const PKG_VER = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
  const dataFile = path.join(TMP, 'fixture-mgmt', 'fixture-data.json');
  const readDb = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  /* ---------- 0. 应用启动 ---------- */
  section('0. 应用启动');
  const boot = await wc.executeJavaScript('({title: document.title, hasContent: !!document.querySelector("#content"), navCount: document.querySelectorAll(".nav-item").length, brand: (document.querySelector(".brand-name")||{}).textContent||"", views: [...document.querySelectorAll(".nav-item")].map(b=>b.dataset.view)})');
  ok('页面标题含当前版本 v' + PKG_VER, boot.title.includes('v' + PKG_VER), boot.title);
  ok('侧边栏品牌名含当前版本 v' + PKG_VER, boot.brand.includes('v' + PKG_VER), boot.brand);
  ok('主内容容器存在', boot.hasContent);
  ok('导航项 >= 9 个（含机种管理 / 按机种查询）', boot.navCount >= 9, String(boot.navCount));
  ok('导航含 prod（机种管理）与 prodquery（按机种查询）',
    boot.views.includes('prod') && boot.views.includes('prodquery'), boot.views);
  const cssLoaded = await wc.executeJavaScript('getComputedStyle(document.body).backgroundColor');
  ok('CSS 已生效（v1.0 曾丢失样式）', cssLoaded !== 'rgba(0, 0, 0, 0)' && cssLoaded !== 'transparent', cssLoaded);

  /* ---------- 1. showView 回归 ---------- */
  section('1. showView 全局挂载（v1.0 严重 bug 回归）');
  const svRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    const out = {};
    for (const v of ['fixtures','outbound','return','records','data','dashboard','location','linecfg','linequery','prod','prodquery']) {
      try { window.showView(v); await sleep(40); out[v] = 'OK'; }
      catch (e) { out[v] = 'FAIL:' + e.message; }
    }
    window.showView('outbound'); await sleep(120);
    const btn = btnByText('清除已选内容');
    if (btn) { try { btn.click(); out.btnClick='OK'; } catch(e){ out.btnClick='FAIL:'+e.message; } }
    else out.btnClick = 'NO_BTN';
    return out;
  })()`);
  Object.keys(svRes).filter((k) => k !== 'btnClick').forEach((v) => {
    ok('showView(' + v + ')', svRes[v] === 'OK', svRes[v]);
  });
  ok('点击出库页「清除已选内容」不报错', svRes.btnClick === 'OK', svRes.btnClick);

  /* ---------- 2. 产线配置（v4：建档前必须先有产线与工位） ---------- */
  section('2. 产线配置（线体 + 工位）');
  const cfgRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    const out = {};
    window.showView('linecfg'); await sleep(450);
    out.navOk = (($('#viewTitle')||{}).textContent||'').includes('产线配置');

    /* 线体表单：形态下拉只有 linear / u */
    window.lineCfgLineForm(0); await sleep(150);
    out.lineFormOk = !!$('#lc_line_name') && !!$('#lc_line_type');
    out.typeOpts = $$('#lc_line_type option').map(o=>o.value);
    setV('#lc_line_name','L1 总装线'); $('#lc_line_type').value='linear';
    window.lineCfgSaveLine(0); await sleep(400);

    window.lineCfgLineForm(0); await sleep(150);
    setV('#lc_line_name','L2 U型线'); $('#lc_line_type').value='u';
    window.lineCfgSaveLine(0); await sleep(400);

    out.lineRows = $$('#content tbody tr').length;

    /* 选中 L1 → 建 2 个工位 */
    const pickBtns = $$('button').filter(b=>String(b.getAttribute('onclick')||'').startsWith('lineCfgPickLine'));
    out.pickBtnCount = pickBtns.length;
    const l1Id = idFromOnclick(pickBtns.find(b=>b.closest('tr').textContent.includes('L1 总装线')), 'lineCfgPickLine');
    const l2Id = idFromOnclick(pickBtns.find(b=>b.closest('tr').textContent.includes('L2 U型线')), 'lineCfgPickLine');
    out.l1Id = l1Id; out.l2Id = l2Id;
    window.lineCfgPickLine(l1Id); await sleep(400);
    for (const [nm, seq] of [['上料工位','10'],['压装工位','20']]) {
      window.lineCfgStationForm(0); await sleep(150);
      setV('#lc_st_name', nm); setV('#lc_st_seq', seq);
      window.lineCfgSaveStation(0); await sleep(400);
    }
    /* 切到 L2 → 建 3 个工位（U型图用） */
    window.lineCfgPickLine(l2Id); await sleep(400);
    for (const [nm, seq] of [['左一','10'],['底一','20'],['右一','30']]) {
      window.lineCfgStationForm(0); await sleep(150);
      setV('#lc_st_name', nm); setV('#lc_st_seq', seq);
      window.lineCfgSaveStation(0); await sleep(400);
    }
    /* 工位面板为只读：无绑定表单，操作列是「编辑夹具 / 编辑工位 / 删除」 */
    const rowBtns = $$('button').filter(b=>String(b.getAttribute('onclick')||'').startsWith('lineCfgStationEditFixtures'));
    out.editFixBtnCount = rowBtns.length;
    out.hasBindForm = $$('button').some(b=>String(b.getAttribute('onclick')||'').startsWith('lineCfgBindForm'));
    out.readonlyHead = (($('#content')||{}).textContent||'').includes('只读关联');
    return out;
  })()`);
  ok('产线配置页可进入', cfgRes.navOk === true, cfgRes.navOk);
  ok('线体表单字段齐全', cfgRes.lineFormOk === true);
  ok('线体形态下拉只有 直线形 / U型 两项',
    JSON.stringify(cfgRes.typeOpts) === JSON.stringify(['linear', 'u']), cfgRes.typeOpts);
  ok('线体表渲染 2 行', cfgRes.lineRows === 2, String(cfgRes.lineRows));
  ok('线体行含「选择」按钮', cfgRes.pickBtnCount >= 2, String(cfgRes.pickBtnCount));
  ok('工位面板标题标注「只读关联」', cfgRes.readonlyHead === true);
  ok('工位行渲染「编辑夹具」按钮（3 个工位）', cfgRes.editFixBtnCount === 3, String(cfgRes.editFixBtnCount));
  ok('工位面板已无「配置夹具」绑定表单（v3 的 stationFixtures 入口已删）',
    cfgRes.hasBindForm === false, String(cfgRes.hasBindForm));

  const dbCfg = readDb();
  ok('lines 已落盘 2 条', (dbCfg.lines || []).length === 2, String((dbCfg.lines || []).length));
  ok('stations 已落盘 5 个', (dbCfg.stations || []).length === 5, String((dbCfg.stations || []).length));
  ok('U型线体落盘 type=u', (dbCfg.lines || []).some((l) => l.type === 'u'));
  ok('v4：数据文件不再有 products 集合', dbCfg.products === undefined, Object.keys(dbCfg));
  ok('v4：数据文件不再有 stationFixtures 集合', dbCfg.stationFixtures === undefined, Object.keys(dbCfg));
  ok('v4：数据文件含 productions 集合', Array.isArray(dbCfg.productions));

  const cfg = { l1: cfgRes.l1Id, l2: cfgRes.l2Id };

  /* ---------- 3. 夹具建档 ---------- */
  section('3. 夹具建档（7 条强校验的 UI 落地）');
  const formRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    const out = {};
    window.showView('fixtures'); await sleep(200);
    window.fixtureNew(); await sleep(250);
    out.fields = ['#fix_serial','#fix_name','#fix_lm_pick','#fix_lm_new','#fix_loc','#fix_cat','#fix_ls_box','#fix_remark']
      .every(s=>!!$(s));
    out.labelText = (($('#modalBody')||{}).textContent||'');
    /* 未选产线/工位直接提交 → 必须被拒 */
    setV('#fix_serial','SN-DENY'); setV('#fix_name','缺产线夹具'); setV('#fix_loc','ZP1-U-9-9');
    setV('#fix_lm_new','WJ-100'); window.fixFormAddModelNew(); await sleep(80);
    window.submitFixForm(); await sleep(350);
    const toastTxt1 = (($('#toast')||{}).textContent||'');
    out.deniedNoLine = /至少选择 1 个工位|至少选择 1 条产线/.test(toastTxt1);
    out.deniedStillOpen = $('#modalOverlay').hidden === false;
    window.closeModal(); await sleep(120);
    /* 非法库位被拒 */
    window.fixtureNew(); await sleep(200);
    setV('#fix_serial','SN-BAD'); setV('#fix_name','非法库位'); setV('#fix_loc','A-9');
    setV('#fix_lm_new','WJ-100'); window.fixFormAddModelNew(); await sleep(60);
    const sel0 = $('#fix_line_pick'); sel0.value=String(${cfg.l1}); window.fixFormAddLine(); await sleep(120);
    const cb0 = $$('#fix_ls_box input[type=checkbox]')[0]; if (cb0) { cb0.checked=true; cb0.dispatchEvent(new Event('change')); }
    await sleep(80);
    window.submitFixForm(); await sleep(350);
    out.deniedBadLoc = /4 段式/.test((($('#toast')||{}).textContent||''));
    window.closeModal(); await sleep(120);
    /* 机种上限 7：加第 8 个必须被拒 */
    window.fixtureNew(); await sleep(200);
    for (let i=1;i<=7;i++) { setV('#fix_lm_new','MX-'+i); window.fixFormAddModelNew(); await sleep(40); }
    setV('#fix_lm_new','MX-8'); window.fixFormAddModelNew(); await sleep(80);
    out.chipCount = $$('#fix_lm_chips .chip-tag').length;
    out.lmCountText = (($('#fix_lm_count')||{}).textContent||'');
    out.pickDisabled = !!$('#fix_lm_pick') && $('#fix_lm_pick').disabled;
    window.closeModal(); window.resetFixForm(); await sleep(120);
    return out;
  })()`);
  ok('建档表单字段齐全', formRes.fields === true);
  ok('表单标注「≥1 产线 ≥1 工位 · ≤5 产线 ≤10 工位」',
    /≥1 产线 ≥1 工位/.test(formRes.labelText) && /≤5 产线 ≤10 工位/.test(formRes.labelText),
    (formRes.labelText || '').slice(0, 120));
  ok('零产线零工位提交被拒（弹窗保持打开）', formRes.deniedNoLine === true && formRes.deniedStillOpen === true);
  ok('非法库位（A-9）提交被拒', formRes.deniedBadLoc === true);
  ok('机种最多 7 个：第 8 个被拒', formRes.chipCount === 7, String(formRes.chipCount));
  ok('机种计数文案 7 / 7', formRes.lmCountText === '7 / 7', formRes.lmCountText);
  ok('机种达上限后选择器被禁用', formRes.pickDisabled === true);

  /* 正式建 4 套（第 4 套与第 1 套同实物编号，验证「多套追踪」） */
  const mkRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    ${NEW_FIXTURE_FN}
    window.showView('fixtures'); await sleep(200);
    const r = {};
    r.detail = [];
    r.a = await newFixture({ serialNo:'DH40MC-921-001-001', name:'定位销压板', location:'ZP1-U-1-1', cat:'冲压',
      models:['DH40MC','DH40MC-B'], lines:['L1 总装线'], stations:['上料工位'], remark:'建档测试A' });
    r.detail.push(r.a);
    r.b = await newFixture({ serialNo:'XXK-D10VG-002', name:'焊接夹具B', location:'ZP1-U-1-2', cat:'焊接',
      models:['XXK-D10VG'], lines:['L1 总装线'], stations:['压装工位'] });
    r.detail.push(r.b);
    r.c = await newFixture({ serialNo:'SN-C-003', name:'装配工装C', location:'ZP1-U-1-3', cat:'装配',
      models:['ASSY-01'], lines:['L2 U型线'], stations:['左一'] });
    r.detail.push(r.c);
    r.d = await newFixture({ serialNo:'DH40MC-921-001-001', name:'定位销压板', location:'ZP1-U-1-9', cat:'冲压',
      models:['DH40MC'], lines:['L1 总装线'], stations:['上料工位'] });
    r.detail.push(r.d);
    r.a = r.a.ok; r.b = r.b.ok; r.c = r.c.ok; r.d = r.d.ok;
    r.cards = $$('#fixture_list .fixture-card').length;
    return r;
  })()`);
  ok('建档 A（DH40MC-921-001-001 / L1·上料工位）成功', mkRes.a === true, JSON.stringify(mkRes.detail && mkRes.detail[0]));
  ok('建档 B（XXK-D10VG-002 / L1·压装工位）成功', mkRes.b === true, JSON.stringify(mkRes.detail && mkRes.detail[1]));
  ok('建档 C（SN-C-003 / L2·左一）成功', mkRes.c === true, JSON.stringify(mkRes.detail && mkRes.detail[2]));
  ok('同实物编号可再建一套（多套追踪）', mkRes.d === true, JSON.stringify(mkRes.detail && mkRes.detail[3]));
  ok('卡片视图渲染 4 张卡', mkRes.cards === 4, String(mkRes.cards));

  const db3 = readDb();
  ok('fixtures 落盘 4 条', db3.fixtures.length === 4, String(db3.fixtures.length));
  ok('桥梁编号为 4 位纯数字', db3.fixtures.every((f) => /^\d{4}$/.test(String(f.code))), db3.fixtures.map((f) => f.code));
  ok('桥梁编号互不相同', new Set(db3.fixtures.map((f) => String(f.code))).size === 4);
  ok('每条夹具都落盘了 lines / stations 数组',
    db3.fixtures.every((f) => Array.isArray(f.lines) && f.lines.length >= 1 && Array.isArray(f.stations) && f.stations.length >= 1),
    db3.fixtures.map((f) => [f.lines, f.stations]));
  ok('夹具记录无 quantity / qty 存储字段（数量为派生值）',
    db3.fixtures.every((f) => f.quantity === undefined && f.qty === undefined));
  ok('夹具记录不再落盘 qrToken', db3.fixtures.every((f) => f.qrToken === undefined));
  ok('初始状态全部为 stocked', db3.fixtures.every((f) => f.status === 'stocked'));

  const n1001 = db3.fixtures.filter((f) => f.serialNo === 'DH40MC-921-001-001');
  ok('同实物编号 2 套分别独立记录（库位不同）',
    n1001.length === 2 && new Set(n1001.map((f) => f.location)).size === 2, n1001.map((f) => f.location));
  const codeOf = {};
  db3.fixtures.forEach((f) => { codeOf[f.location] = f.code; });

  /* 编辑夹具：桥梁编号不可改，只有提示 */
  const editRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    const card = $$('.fixture-card').find(c=>c.textContent.includes('SN-C-003'));
    if (!card) return { err:'未找到 SN-C-003 卡片' };
    const id = Number(card.dataset.id);
    window.fixtureEdit(id); await sleep(300);
    const txt = (($('#modalBody')||{}).textContent||'');
    const out = { hasSerial: !!$('#fix_serial'), noCodeInput: !$('#fix_new_code'), tip: /不可修改/.test(txt), title: (($('#modalTitle')||{}).textContent||'') };
    /* 改库位并保存 */
    setV('#fix_loc','ZP1-U-1-3'); setV('#fix_cat','装配-改');
    window.submitFixForm();
    /* 保存同样是异步的（IPC 落盘）⇒ 轮询等弹窗关闭，别用固定 sleep 造成假失败 */
    for (let i = 0; i < 40; i++) { await sleep(100); if ($('#modalOverlay').hidden) break; }
    out.closed = $('#modalOverlay').hidden === true;
    return out;
  })()`);
  ok('编辑弹窗含实物编号输入但无桥梁编号输入', editRes.hasSerial === true && editRes.noCodeInput === true, JSON.stringify(editRes));
  ok('编辑弹窗提示桥梁编号不可修改', editRes.tip === true);
  ok('编辑弹窗标题显示实物编号', /SN-C-003/.test(editRes.title), editRes.title);
  ok('编辑保存后弹窗关闭', editRes.closed === true);

  /* ---------- 4. 出库（库位冻结） ---------- */
  section('4. 出库流程');
  const outRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('fixtures'); await sleep(250);
    const card = $$('.fixture-card').find(c=>c.textContent.includes('DH40MC-921-001-001'));
    if (!card) return { err:'未找到 DH40MC-921-001-001 卡片' };
    const btn = [...card.querySelectorAll('button')].find(b=>b.textContent.trim()==='出库');
    if (!btn) return { err:'卡片无出库按钮' };
    btn.click(); await sleep(300);
    const hasOp = !!$('#fix_out_op');
    const hasLocInput = !!$('#fix_out_loc');
    if (hasOp) {
      setV('#fix_out_op','李四'); setV('#fix_out_party','生产一车间'); setV('#fix_out_remark','首次领用');
      btnByText('确认出库').click();
    }
    await sleep(650);
    return { hasOp, hasLocInput };
  })()`);
  ok('出库弹窗打开且字段存在', outRes.hasOp === true, JSON.stringify(outRes));
  ok('建档已填库位 → 出库弹窗无需补填库位', outRes.hasLocInput === false, String(outRes.hasLocInput));
  ok('数据文件已生成于隔离目录', fs.existsSync(dataFile), dataFile);

  const db4 = readDb();
  const outFix = db4.fixtures.find((f) => f.location === 'ZP1-U-1-1' && f.serialNo === 'DH40MC-921-001-001');
  ok('出库后状态 = checked_out', outFix && outFix.status === 'checked_out', outFix && outFix.status);
  ok('出库次数 = 1', outFix && outFix.totalOutCount === 1, outFix && String(outFix.totalOutCount));
  ok('出库冻结库位（location 不变）', outFix && outFix.location === 'ZP1-U-1-1', outFix && outFix.location);
  const txOut = db4.fixTransactions.find((t) => t.fixtureCode === String(codeOf['ZP1-U-1-1']) && t.type === 'out');
  ok('出库流水已写入', !!txOut);
  ok('流水经办人 = 李四', txOut && txOut.operator === '李四', txOut && txOut.operator);
  ok('流水领用人 = 生产一车间', txOut && txOut.counterparty === '生产一车间', txOut && txOut.counterparty);
  ok('流水状态迁移 stocked → checked_out', txOut && txOut.fromStatus === 'stocked' && txOut.toStatus === 'checked_out');
  ok('流水带库位快照 from/to = ZP1-U-1-1',
    txOut && txOut.fromLocation === 'ZP1-U-1-1' && txOut.toLocation === 'ZP1-U-1-1', txOut && [txOut.fromLocation, txOut.toLocation]);
  ok('流水冗余实物编号字段', txOut && txOut.fixtureSerialNo === 'DH40MC-921-001-001', txOut && txOut.fixtureSerialNo);

  /* ---------- 5. 回库（可改库位） ---------- */
  section('5. 回库流程（四栏互查 → 勾选 → 改库位 → 提交）');
  const retRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('return'); await sleep(300);
    const codeBox = $('#return_code');
    if (!codeBox) return { err:'回库页无编号输入框' };
    codeBox.value='DH40MC-921-001-001';
    codeBox.dispatchEvent(new Event('input'));
    await sleep(450);
    const picks=[...document.querySelectorAll('.return-pick')];
    if (picks.length) {
      picks.forEach(c=>{ c.checked=true; c.dispatchEvent(new Event('change')); });
      await sleep(200);
    }
    const hasLocField = !!$('#return_new_location');
    if (hasLocField) setV('#return_new_location','ZP1-U-2-2');
    const op=$('#return_operator'); if (op) setV('#return_operator','王五');
    const rm=$('#return_remark'); if (rm) setV('#return_remark','归还完好');
    const btn=btnByText('提交回库');
    if (btn) btn.click();
    await sleep(750);
    return { n:picks.length, hasLocField, clicked:!!btn };
  })()`);
  ok('回库候选列表命中 1 台待回库夹具', retRes.n === 1, JSON.stringify(retRes));
  ok('回库页提供「回库库位」输入框（v4 新增）', retRes.hasLocField === true);
  ok('「提交回库」按钮存在且已点击', retRes.clicked === true);

  const db5 = readDb();
  const retFix = db5.fixtures.find((f) => f.serialNo === 'DH40MC-921-001-001' && f.code === codeOf['ZP1-U-1-1']);
  ok('回库后状态 = stocked', retFix && retFix.status === 'stocked', retFix && retFix.status);
  ok('回库次数 = 1', retFix && retFix.totalReturnCount === 1, retFix && String(retFix.totalReturnCount));
  ok('回库库位写回 location（ZP1-U-1-1 → ZP1-U-2-2）', retFix && retFix.location === 'ZP1-U-2-2', retFix && retFix.location);
  const txRet = db5.fixTransactions.find((t) => t.type === 'return' && t.operator === '王五');
  ok('回库流水已写入', !!txRet);
  ok('流水记录库位变更 from ZP1-U-1-1 → to ZP1-U-2-2',
    txRet && txRet.fromLocation === 'ZP1-U-1-1' && txRet.toLocation === 'ZP1-U-2-2', txRet && [txRet.fromLocation, txRet.toLocation]);
  ok('非法回库库位尝试（下一步校验未写库）', await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    /* 先把 B 出库 */
    window.showView('fixtures'); await sleep(250);
    const card = $$('.fixture-card').find(c=>c.textContent.includes('XXK-D10VG-002'));
    const ob=[...card.querySelectorAll('button')].find(b=>b.textContent.trim()==='出库');
    if (!ob) return false;
    ob.click(); await sleep(280);
    setV('#fix_out_op','李四'); btnByText('确认出库').click(); await sleep(550);
    /* 再以非法库位回库 */
    window.showView('return'); await sleep(320);
    const box=$('#return_code'); box.value='XXK-D10VG-002'; box.dispatchEvent(new Event('input')); await sleep(420);
    $$('.return-pick').forEach(c=>{ c.checked=true; c.dispatchEvent(new Event('change')); });
    await sleep(180);
    const loc=$('#return_new_location');
    const hadField = !!loc;
    if (loc) setV('#return_new_location','BAD');
    setV('#return_operator','王五');
    btnByText('提交回库').click(); await sleep(650);
    return hadField;
  })()`) === true);
  const db5b = readDb();
  const bFix = db5b.fixtures.find((f) => f.serialNo === 'XXK-D10VG-002');
  ok('非法回库库位 → 该夹具仍为 checked_out（未写库）', bFix && bFix.status === 'checked_out', bFix && bFix.status);
  ok('非法回库库位 → 库位未被污染', bFix && bFix.location === 'ZP1-U-1-2', bFix && bFix.location);

  /* 把 B 正常回库，供后续循环使用 */
  await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('return'); await sleep(300);
    const box=$('#return_code'); box.value='XXK-D10VG-002'; box.dispatchEvent(new Event('input')); await sleep(400);
    $$('.return-pick').forEach(c=>{ c.checked=true; c.dispatchEvent(new Event('change')); });
    await sleep(150);
    setV('#return_operator','王五');
    btnByText('提交回库').click(); await sleep(650);
  })()`);

  /* ---------- 6. 重复出库/回库 3 轮 ---------- */
  section('6. 重复出库/回库 3 轮（核心需求）');
  for (let i = 0; i < 3; i++) {
    await wc.executeJavaScript(`(async () => {
      ${HELPERS}
      window.showView('fixtures'); await sleep(200);
      const card=$$('.fixture-card').find(c=>c.textContent.includes('DH40MC-921-001-001'));
      [...card.querySelectorAll('button')].find(b=>b.textContent.trim()==='出库').click();
      await sleep(280);
      setV('#fix_out_op','李四');
      btnByText('确认出库').click();
      await sleep(550);
      window.showView('return'); await sleep(300);
      const codeBox = $('#return_code');
      codeBox.value='DH40MC-921-001-001';
      codeBox.dispatchEvent(new Event('input'));
      await sleep(450);
      const picks=[...document.querySelectorAll('.return-pick')];
      if (!picks.length) throw new Error('第 ' + ${i + 1} + ' 轮未渲染出回库候选');
      picks.forEach(c=>{ c.checked=true; c.dispatchEvent(new Event('change')); });
      await sleep(150);
      setV('#return_operator','王五');
      const rbtn=btnByText('提交回库');
      if (!rbtn) throw new Error('第 ' + ${i + 1} + ' 轮未找到提交回库按钮');
      rbtn.click();
      await sleep(600);
    })()`).catch((e) => { ok('第 ' + (i + 1) + ' 轮出库/回库', false, e.message); });
  }
  const db6 = readDb();
  const cyc = db6.fixtures.find((f) => f.serialNo === 'DH40MC-921-001-001' && f.code === codeOf['ZP1-U-1-1']);
  ok('累计出库 4 次', cyc.totalOutCount === 4, String(cyc.totalOutCount));
  ok('累计回库 4 次', cyc.totalReturnCount === 4, String(cyc.totalReturnCount));
  ok('最终状态 stocked', cyc.status === 'stocked', cyc.status);
  ok('该夹具流水累计 8 条', db6.fixTransactions.filter((t) => t.fixtureId === cyc.id).length === 8,
    String(db6.fixTransactions.filter((t) => t.fixtureId === cyc.id).length));

  /* ---------- 7. 送修 / 维修完成 ---------- */
  section('7. 送修与维修完成');
  const repRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('fixtures'); await sleep(250);
    const card=$$('.fixture-card').find(c=>c.textContent.includes('XXK-D10VG-002'));
    if(!card) return {err:'无 XXK-D10VG-002'};
    const btn=[...card.querySelectorAll('button')].find(b=>b.textContent.includes('送修'));
    if(!btn) return {err:'无送修按钮', btns:[...card.querySelectorAll('button')].map(b=>b.textContent)};
    btn.click(); await sleep(300);
    const hasOp=!!$('#fix_repair_op');
    const hasType=!!$('#fix_repair_type');
    if(hasOp&&hasType){
      setV('#fix_repair_op','赵六');
      $('#fix_repair_type').value='calibrate';
      setV('#fix_repair_remark','精度校准');
      btnByText('确认送修').click();
    }
    await sleep(650);
    return {hasOp, hasType};
  })()`);
  ok('送修弹窗字段齐全', repRes.hasOp === true && repRes.hasType === true, JSON.stringify(repRes));
  const db7 = readDb();
  const rFix = db7.fixtures.find((f) => f.serialNo === 'XXK-D10VG-002');
  ok('状态 = repair', rFix.status === 'repair', rFix.status);
  ok('维修次数 = 1', rFix.repairCount === 1, String(rFix.repairCount));
  const repTx = db7.fixTransactions.find((t) => t.fixtureId === rFix.id && t.type === 'repair');
  ok('送修流水已写入', !!repTx);
  ok('维修子类型已保留（v1.1 修复）', repTx && repTx.repairType === 'calibrate', repTx && String(repTx.repairType));

  const compRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('fixtures'); await sleep(250);
    const card=$$('.fixture-card').find(c=>c.textContent.includes('XXK-D10VG-002'));
    const btn=[...card.querySelectorAll('button')].find(b=>b.textContent.includes('维修完成'));
    if(!btn) return {err:'无维修完成按钮', btns:[...card.querySelectorAll('button')].map(b=>b.textContent)};
    btn.click(); await sleep(350);
    const hasOp = !!$('#fix_rdone_op');
    if (hasOp) {
      setV('#fix_rdone_op','赵六');
      setV('#fix_rdone_remark','更换定位销，校准合格');
      btnByText('确认完成并回库').click();
    }
    await sleep(700);
    return {hasOp};
  })()`);
  ok('维修完成弹窗字段存在', compRes.hasOp === true, JSON.stringify(compRes));
  const db8 = readDb();
  const rFix2 = db8.fixtures.find((f) => f.serialNo === 'XXK-D10VG-002');
  ok('维修完成后回到 stocked', rFix2.status === 'stocked', rFix2.status);
  const rdoneTx = db8.fixTransactions.find((t) => t.fixtureId === rFix2.id && t.type === 'repair_done');
  ok('repair_done 流水已写入', !!rdoneTx);
  ok('维修完成流水状态迁移 repair → stocked',
    rdoneTx && rdoneTx.fromStatus === 'repair' && rdoneTx.toStatus === 'stocked',
    rdoneTx ? rdoneTx.fromStatus + '->' + rdoneTx.toStatus : 'N/A');
  ok('维修完成后卡片再次出现「出库」按钮', await wc.executeJavaScript(`(() => {
    const card=[...document.querySelectorAll('.fixture-card')].find(c=>c.textContent.includes('XXK-D10VG-002'));
    return !!card && [...card.querySelectorAll('button')].some(b=>b.textContent.trim()==='出库');
  })()`));

  /* ---------- 8. 报废 ---------- */
  section('8. 报废流程');
  const retireRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('fixtures'); await sleep(250);
    const card=$$('.fixture-card').find(c=>c.textContent.includes('SN-C-003'));
    [...card.querySelectorAll('button')].find(b=>b.textContent.includes('报废')).click();
    await sleep(350);
    const hasOp = !!$('#fix_retire_op');
    if (hasOp) {
      setV('#fix_retire_op','管理员');
      setV('#fix_retire_remark','精度超差无法修复');
      btnByText('确认报废').click();
    }
    await sleep(700);
    return {hasOp};
  })()`);
  ok('报废弹窗字段存在', retireRes.hasOp === true, JSON.stringify(retireRes));
  const db9 = readDb();
  const cFix = db9.fixtures.find((f) => f.serialNo === 'SN-C-003');
  ok('状态 = retired', cFix.status === 'retired', cFix.status);
  ok('报废后卡片无出库按钮', await wc.executeJavaScript(`(() => {
    const card=[...document.querySelectorAll('.fixture-card')].find(c=>c.textContent.includes('SN-C-003'));
    return card ? ![...card.querySelectorAll('button')].some(b=>b.textContent.trim()==='出库') : false;
  })()`));

  /* ---------- 9. 搜索 / 二维码 / 视图 / 流水 / 仪表盘 ---------- */
  section('9. 搜索、二维码标签与打印、视图切换、流水、仪表盘');
  const searchRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('fixtures'); await sleep(250);
    const box=$('#fix_search');
    const search=async(v)=>{ box.value=v; box.dispatchEvent(new Event('input')); await sleep(220); };
    await search('DH40MC-921-001-001');
    const n1=$$('#fixture_list .fixture-card').length;
    await search('SN-C-003');
    const nRetired=$$('#fixture_list .fixture-card').length;
    await search('不存在的夹具XYZ');
    const empty=!!$('#fixture_list .empty-tip');
    await search('上料工位');
    const nByStation=$$('#fixture_list .fixture-card').length;
    await search('');
    const n2=$$('#fixture_list .fixture-card').length;
    return {n1, nRetired, empty, nByStation, n2};
  })()`);
  ok('按实物编号搜索命中 2 套（同编号多套）', searchRes.n1 === 2, JSON.stringify(searchRes));
  ok('按实物编号搜索命中已报废套', searchRes.nRetired === 1, String(searchRes.nRetired));
  ok('无结果显示空提示', searchRes.empty === true);
  ok('支持按工位名搜索（产线/工位维度的模糊检索）', searchRes.nByStation === 2, String(searchRes.nByStation));
  ok('清空搜索恢复全部 4 条', searchRes.n2 === 4, String(searchRes.n2));

  /* 库位管理（卡片数字 = 在库套数） */
  section('9.1 库位管理（卡片数字 = 在库套数）');
  const locRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('location'); await sleep(400);
    const cards=$$('.loc-card').map(c=>({loc:(c.querySelector('.loc-card-no')||{}).textContent||'', n:Number(((c.querySelector('.loc-card-num')||{}).textContent||'0').trim()), title:c.getAttribute('title')||''}));
    return {
      hasGrid: !!$('.loc-grid10'),
      cards,
      hasAuditBtn: !!btnByText('手工盘点')
    };
  })()`);
  ok('库位页渲染网格', locRes.hasGrid === true);
  ok('库位卡片 >= 4（ZP1-U-1-2/1-3/1-9/2-2）', locRes.cards.length >= 4, JSON.stringify(locRes.cards.map((c) => c.loc)));
  const locMap = {};
  locRes.cards.forEach((c) => { locMap[c.loc] = c.n; });
  ok('回库改库位后 ZP1-U-2-2 在库 1 套、原库位 ZP1-U-1-1 已无在库件',
    locMap['ZP1-U-2-2'] === 1 && locMap['ZP1-U-1-1'] === undefined, JSON.stringify(locMap));
  ok('ZP1-U-1-2 在库 1 套（送修完成后回库）', locMap['ZP1-U-1-2'] === 1, JSON.stringify(locMap));
  ok('ZP1-U-1-3 在库 0 套（已报废不计入在库）', locMap['ZP1-U-1-3'] === 0, JSON.stringify(locMap));
  ok('卡片 hover 提示区分「在库 / 不在库」',
    locRes.cards.some((c) => /在库/.test(c.title) && /不在库/.test(c.title)),
    (locRes.cards.find((c) => /不在库/.test(c.title)) || locRes.cards[0] || {}).title);
  ok('「手工盘点」按钮存在', locRes.hasAuditBtn === true);

  /* 二维码弹窗：内容 = SPMS1|<code>，标签卡只印实物编号 + 名称 */
  const qrRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('fixtures'); await sleep(300);
    const card=$$('.fixture-card').find(c=>c.textContent.includes('XXK-D10VG-002'));
    const qrBtn=[...card.querySelectorAll('button')].find(b=>b.textContent.includes('二维码'));
    const out={ hasBatch: !!btnByText('批量打印标签') };
    if(!qrBtn){ out.err='无二维码按钮'; return out; }
    qrBtn.click(); await sleep(450);
    const canvas=$('#qrCanvas');
    const modalText=(($('#modalBody')||{}).textContent||'');
    out.hasCanvas=!!canvas;
    out.qrDrawn=!!canvas && canvas.width>0 && canvas.height>0;
    out.tokenShown=/SPMS1\\|\\d{4}/.test(modalText);
    out.hasBridgeLabel=modalText.includes('桥梁编号');
    out.hasDownload=!!btnByText('下载 PNG');
    out.hasPrint=!!btnByText('打印');
    out.modalTitle=(($('#modalTitle')||{}).textContent||'');
    return out;
  })()`);
  ok('夹具卡片含「二维码」按钮', !qrRes.err, JSON.stringify(qrRes));
  ok('「批量打印标签」按钮存在', qrRes.hasBatch === true);
  ok('二维码弹窗打开并绘制二维码', qrRes.hasCanvas === true && qrRes.qrDrawn === true, JSON.stringify(qrRes));
  ok('弹窗展示二维码内容 SPMS1|<桥梁编号>', qrRes.tokenShown === true);
  ok('弹窗区分「实物编号」与「桥梁编号」两个概念', qrRes.hasBridgeLabel === true);
  ok('二维码弹窗标题显示实物编号', /XXK-D10VG-002/.test(qrRes.modalTitle), qrRes.modalTitle);
  ok('「下载 PNG」「打印」按钮存在', qrRes.hasDownload === true && qrRes.hasPrint === true);

  const printRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    const btn=$$('button').find(b=>b.textContent.includes('打印') && !b.textContent.includes('批量'));
    btn.click(); await sleep(550);
    const page=$('#ppPage');
    const card = page ? page.querySelector('.label-card') : null;
    return {
      hasPaper: !!$('#ppPaper'),
      hasAlign: !!$('#ppHa') && !!$('#ppVa'),
      hasCopies: !!$('#ppCopies'),
      previewLabels: page ? page.querySelectorAll('.label-card').length : 0,
      previewQR: page ? page.querySelectorAll('.label-qr').length : 0,
      hasSerial: !!card && !!card.querySelector('.lc-code'),
      hasName: !!card && !!card.querySelector('.lc-name'),
      noModels: !card || !card.querySelector('.lc-lineModels'),
      noLoc: !card || !card.querySelector('.lc-loc'),
      cardText: card ? card.textContent.replace(/\\s+/g,' ').trim() : ''
    };
  })()`);
  ok('打印设置面板含纸张/对齐/份数', printRes.hasPaper === true && printRes.hasAlign === true && printRes.hasCopies === true, JSON.stringify(printRes));
  ok('打印预览含 1 张标签', printRes.previewLabels === 1, String(printRes.previewLabels));
  ok('预览标签已绘制二维码', printRes.previewQR === 1, String(printRes.previewQR));
  ok('标签卡只印实物编号 + 名称两项', printRes.hasSerial === true && printRes.hasName === true && printRes.noModels === true && printRes.noLoc === true,
    JSON.stringify(printRes));
  ok('标签卡内容为「XXK-D10VG-002 焊接夹具B」', /XXK-D10VG-002/.test(printRes.cardText) && /焊接夹具B/.test(printRes.cardText), printRes.cardText);
  await wc.executeJavaScript('window.closeModal()');

  /* 列表/卡片视图切换 */
  const viewRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('fixtures'); await sleep(300);
    const hasCardBtn=!!btnByText('卡片'), hasListBtn=!!btnByText('列表');
    const isCard=!!$('#fixture_list .fixture-grid');
    btnByText('列表').click(); await sleep(350);
    const isList=!!$('#fixture_list .table-wrap table');
    const rows=$$('#fixture_list tbody tr');
    const headerText=(($('#fixture_list thead')||{}).textContent||'');
    const firstRowHasQR=rows.length>0 && rows[0].textContent.includes('二维码');
    btnByText('卡片').click(); await sleep(350);
    return { hasCardBtn, hasListBtn, isCard, isList, rowCount: rows.length, headerText, firstRowHasQR, backCard: !!$('#fixture_list .fixture-grid') };
  })()`);
  ok('夹具列表含「卡片」「列表」切换按钮', viewRes.hasCardBtn === true && viewRes.hasListBtn === true);
  ok('默认卡片视图', viewRes.isCard === true);
  ok('切到列表视图显示表格', viewRes.isList === true);
  ok('列表视图含 4 行数据', viewRes.rowCount === 4, String(viewRes.rowCount));
  ok('列表视图含状态/操作列', viewRes.headerText.includes('状态') && viewRes.headerText.includes('操作'), viewRes.headerText);
  ok('列表行含操作按钮', viewRes.firstRowHasQR === true);
  ok('切回卡片视图', viewRes.backCard === true);

  /* 流水记录页 */
  const recRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('records'); await sleep(400);
    const rows=$$('#rec_list .tx-row');
    const out = {
      hasList: !!$('#rec_list .tx-list'),
      rows: rows.filter(r=>!r.classList.contains('tx-header')).length,
      hasHeader: rows.some(r=>r.classList.contains('tx-header')),
      sample: rows.length>1 ? rows[1].textContent.replace(/\\s+/g,' ').trim().slice(0,60) : ''
    };
    const box=$('#rec_search');
    box.value='李四'; box.dispatchEvent(new Event('input')); await sleep(300);
    out.n1=$$('#rec_list .tx-row').filter(r=>!r.classList.contains('tx-header')).length;
    box.value=''; box.dispatchEvent(new Event('input')); await sleep(300);
    out.n2=$$('#rec_list .tx-row').filter(r=>!r.classList.contains('tx-header')).length;
    return out;
  })()`);
  ok('流水记录页渲染列表', recRes.hasList === true, JSON.stringify(recRes));
  ok('流水记录含表头', recRes.hasHeader === true);
  ok('流水记录有数据行', recRes.rows > 0, String(recRes.rows));
  console.log('     示例行：' + recRes.sample);
  ok('流水按经办人搜索生效', recRes.n1 > 0 && recRes.n1 < recRes.n2, JSON.stringify([recRes.n1, recRes.n2]));

  /* 数据备份页 + 仪表盘 */
  ok('数据备份页可渲染', await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('data'); await sleep(300);
    const t=(($('#content')||{}).textContent||'');
    return t.includes('备份') || t.includes('导出');
  })()`));
  const dashRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('dashboard'); await sleep(400);
    const t=($('#content')||{}).textContent.replace(/\\s+/g,' ');
    return { text: t.slice(0,260), hasModel: t.includes('数据模型') || t.includes('派生') };
  })()`);
  ok('仪表盘可渲染', dashRes.text.length > 10, dashRes.text.slice(0, 80));
  ok('仪表盘含 v4 数据模型说明（数量为派生值）', dashRes.hasModel === true, dashRes.text.slice(0, 120));

  /* ---------- 10. 产线夹具查询 ---------- */
  section('10. 产线夹具查询（只读 / 无产品级联 / 示意图）');
  const lqRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('linequery'); await sleep(700);
    const out={};
    out.navOk=(($('#viewTitle')||{}).textContent||'').includes('产线夹具查询');
    out.lineOptCount=$$('#lq_line option').length;
    out.hasProductSelect=!!$('#lq_product');
    out.hasTable=!!$('#lq_body table');
    out.headText=(($('#lq_body thead')||{}).textContent||'').replace(/\\s+/g,'');
    out.rowsL1=$$('#lq_body table tbody tr').length;
    const bodyL1=(($('#lq_body')||{}).textContent||'');
    out.l1HasSerial=bodyL1.includes('DH40MC-921-001-001');
    out.l1ReadonlyTip=bodyL1.includes('只读');
    out.l1SvgLines=$$('#lq_body svg line.ld-track').length;
    out.l1SvgPoly=$$('#lq_body svg polyline.ld-track').length;
    out.l1Title=(($('#lq_body .ld-title')||{}).textContent||'');
    out.l1Count=(($('#lq_count')||{}).textContent||'');
    out.hasGotoProdQuery=$$('button').some(b=>String(b.getAttribute('onclick')||'').includes("showView('prodquery')"));
    /* 切到 U 型线 */
    const sel=$('#lq_line');
    const uOpt=$$('#lq_line option').find(o=>o.textContent.includes('U型'));
    if (uOpt) { sel.value=uOpt.value; sel.dispatchEvent(new Event('change')); await sleep(500); }
    out.rowsL2=$$('#lq_body table tbody tr').length;
    out.l2SvgPoly=$$('#lq_body svg polyline.ld-track').length;
    out.l2SvgLines=$$('#lq_body svg line.ld-track').length;
    out.l2Title=(($('#lq_body .ld-title')||{}).textContent||'');
    out.l2HasRetired=(($('#lq_body')||{}).textContent||'').includes('SN-C-003');
    out.hasResetBtn=!!btnByText('重置筛选');
    return out;
  })()`);
  ok('查询页可进入', lqRes.navOk === true, lqRes.navOk);
  ok('线体下拉 = 2 条线体 + 1 占位 = 3 项', lqRes.lineOptCount === 3, String(lqRes.lineOptCount));
  ok('v4：产品级联下拉已移除（无 #lq_product）', lqRes.hasProductSelect === false, String(lqRes.hasProductSelect));
  ok('结果表为 7 列（工位名称/顺序/实物编号/桥梁号/名称/状态/备注）',
    ['工位名称', '工位顺序', '实物夹具编号', '桥梁号', '夹具名称', '状态', '备注'].every((h) => lqRes.headText.includes(h)),
    lqRes.headText);
  ok('L1 配置表渲染 3 行（上料工位 2 套 → 2 行，压装工位 1 套 → 1 行）', lqRes.rowsL1 === 3, String(lqRes.rowsL1));
  ok('表格显示实物夹具编号', lqRes.l1HasSerial === true);
  ok('页面提示「只读」视图', lqRes.l1ReadonlyTip === true);
  ok('直线形用折线轨迹（line.ld-track）', lqRes.l1SvgLines >= 1, String(lqRes.l1SvgLines));
  ok('直线形不使用 polyline 轨迹', lqRes.l1SvgPoly === 0, String(lqRes.l1SvgPoly));
  ok('L1 图标题含「直线形」', lqRes.l1Title.includes('直线形'), lqRes.l1Title);
  ok('统计文案含工位与夹具数量', /工位\s*2\s*个/.test(lqRes.l1Count) && /本线关联/.test(lqRes.l1Count), lqRes.l1Count);
  ok('L2 U型线配置表渲染 3 行', lqRes.rowsL2 === 3, String(lqRes.rowsL2));
  ok('U型使用 polyline 轨迹', lqRes.l2SvgPoly === 1, String(lqRes.l2SvgPoly));
  ok('U型不使用 line 轨迹', lqRes.l2SvgLines === 0, String(lqRes.l2SvgLines));
  ok('L2 图标题含「U型」', lqRes.l2Title.includes('U型'), lqRes.l2Title);
  ok('报废夹具仍出现在产线视图中（状态列区分）', lqRes.l2HasRetired === true);
  ok('存在「重置筛选」按钮', lqRes.hasResetBtn === true);
  ok('存在「🏷 按机种查询」跳转按钮', lqRes.hasGotoProdQuery === true);

  /* ---------- 11. 机种管理 / 按机种查询 ---------- */
  section('11. 机种管理与按机种查询');
  const prodRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('prod'); await sleep(500);
    const out={};
    out.navOk=(($('#viewTitle')||{}).textContent||'').includes('机种');
    const t=($('#content')||{}).textContent||'';
    out.hasOrphan = /字典里没有/.test(t);
    out.orphanShown = t.includes('DH40MC') && t.includes('ASSY-01');
    out.hasAdoptBtn = $$('button').some(b=>String(b.getAttribute('onclick')||'').includes('prodAdoptOrphans'));
    if (out.hasAdoptBtn) { window.prodAdoptOrphans(); await sleep(600); }
    const t2=($('#content')||{}).textContent||'';
    out.rowsAfterAdopt = $$('#content tbody tr').length;
    /* 新建一个机种 */
    window.prodForm(0); await sleep(250);
    out.formOk = !!$('#prod_name') && !!$('#prod_order');
    setV('#prod_name','ZZZ-NEW'); setV('#prod_order','99');
    window.prodSave(0); await sleep(500);
    out.createdZZZ = (($('#content')||{}).textContent||'').includes('ZZZ-NEW');
    /* 被引用机种删除保护 */
    const delBtn = $$('button').find(b=>String(b.getAttribute('onclick')||'').startsWith('prodDel(') && b.closest('tr') && b.closest('tr').textContent.includes('DH40MC'));
    if (delBtn) { delBtn.click(); await sleep(300); }
    out.delGuardText = (($('#modalBody')||{}).textContent||'');
    window.closeModal(); await sleep(120);
    return out;
  })()`);
  ok('机种管理页可进入', prodRes.navOk === true, prodRes.navOk);
  ok('机种管理页识别「孤儿机种」（夹具在用但字典未登记）', prodRes.hasOrphan === true && prodRes.orphanShown === true, JSON.stringify(prodRes));
  ok('「一键补登」按钮存在', prodRes.hasAdoptBtn === true);
  ok('补登后机种字典列出 4 条以上', prodRes.rowsAfterAdopt >= 4, String(prodRes.rowsAfterAdopt));
  ok('机种表单字段齐全（名称 + 排序号）', prodRes.formOk === true);
  ok('新建机种 ZZZ-NEW 成功', prodRes.createdZZZ === true);
  ok('被夹具引用的机种禁止删除（提示无法删除）', /无法删除|仍被/.test(prodRes.delGuardText), prodRes.delGuardText.slice(0, 120));
  const db11 = readDb();
  ok('productions 已落盘（含 DH40MC）', (db11.productions || []).some((p) => p.name === 'DH40MC'), (db11.productions || []).map((p) => p.name));
  ok('productions 记录只有 id/name/order（不隶属产线）',
    (db11.productions || []).every((p) => p.lineId === undefined && p.name && p.order !== undefined),
    db11.productions && db11.productions[0]);

  const pqRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('prodquery'); await sleep(600);
    const out={};
    out.navOk=(($('#viewTitle')||{}).textContent||'').includes('按机种查询');
    out.optCount=$('#pq_name') ? $('#pq_name').options.length : 0;
    out.totalRows=$$('#pq_body table tbody tr').length;
    const groups=$$('#pq_body .pq-head').map(x=>x.textContent.replace(/\\s+/g,' ').trim());
    out.groups=groups;
    out.headText=(($('#pq_body thead')||{}).textContent||'').replace(/\\s+/g,'');
    /* 只看 DH40MC */
    const sel=$('#pq_name');
    const opt=$$('#pq_name option').find(o=>o.textContent.trim()==='DH40MC');
    if (opt) { sel.value=opt.value; sel.dispatchEvent(new Event('change')); await sleep(450); }
    out.pickedRows=$$('#pq_body table tbody tr').length;
    out.pickedGroups=$$('#pq_body .pq-head').map(x=>x.textContent.replace(/\\s+/g,' ').trim());
    out.hasLineCol=(($('#pq_body')||{}).textContent||'').includes('L1 总装线');
    out.countText=(($('#pq_count')||{}).textContent||'');
    return out;
  })()`);
  ok('按机种查询页可进入', pqRes.navOk === true, pqRes.navOk);
  ok('机种下拉含字典 + 孤儿机种', pqRes.optCount >= 5, String(pqRes.optCount));
  ok('默认按机种分组渲染多组', pqRes.groups.length >= 3, JSON.stringify(pqRes.groups));
  ok('结果表固定列（产线 / 夹具编号 / 库位 / 状态）',
    ['产线', '夹具编号', '库位', '状态'].every((h) => pqRes.headText.includes(h)), pqRes.headText);
  ok('筛选 DH40MC 后只显示该机种分组', pqRes.pickedGroups.length === 1 && pqRes.pickedGroups[0].includes('DH40MC'), JSON.stringify(pqRes.pickedGroups));
  ok('筛选后行数 = 该机种关联的产线行', pqRes.pickedRows >= 1, String(pqRes.pickedRows));
  ok('结果中显示夹具所在产线名', pqRes.hasLineCol === true);

  /* ---------- 12. 清空数据落盘 ---------- */
  section('12. 清空数据落盘验证与重启恢复');
  const clearRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('data'); await sleep(300);
    const btn=btnByText('清空');
    if(!btn) return {err:'无清空按钮'};
    btn.click(); await sleep(350);
    const hasInput = !!$('#fix_clear_confirm');
    if (hasInput) {
      setV('#fix_clear_confirm','随便填');
      btnByText('确认清空').click();
      await sleep(450);
    }
    const stillHas = !!$('#fix_clear_confirm');
    if (stillHas) {
      setV('#fix_clear_confirm','清空');
      btnByText('确认清空').click();
      await sleep(900);
    }
    return {hasInput, stillHas};
  })()`);
  ok('清空弹窗含确认输入框', clearRes.hasInput === true, JSON.stringify(clearRes));
  ok('错误确认文本被拒绝（弹窗未关闭）', clearRes.stillHas === true);

  const db12 = readDb();
  ok('清空后 fixtures 表已落盘为空', db12.fixtures.length === 0, String(db12.fixtures.length));
  ok('清空后 fixTransactions 表已落盘为空', db12.fixTransactions.length === 0, String(db12.fixTransactions.length));
  ok('清空只清业务数据：产线 / 工位 / 机种字典（主数据）保留',
    (db12.lines || []).length === 2 && (db12.stations || []).length === 5 && (db12.productions || []).length >= 4,
    [(db12.lines || []).length, (db12.stations || []).length, (db12.productions || []).length]);
  ok('清空后页面无夹具卡片', await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('fixtures'); await sleep(300);
    return $$('.fixture-card').length;
  })()`) === 0);

  await wc.reload();
  await sleep(800);
  for (let i = 0; i < 40; i++) {
    const ready = await wc.executeJavaScript('!!(window.fixtureNew && window.showView)').catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  ok('清空后重启程序数据仍为空（不复活）', await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('fixtures'); await sleep(350);
    return $$('.fixture-card').length;
  })()`) === 0);

  /* ---------- 13. 运行期错误捕获 ---------- */
  section('13. 运行期错误捕获');
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
