'use strict';
/* ============================================================
 * test_e2e.js — 真实运行测试（v5.2.0）
 * 启动真实 Electron 窗口 → 加载 index.html → 驱动 UI 走完整业务流程
 * → 主进程侧读取 JSON 数据文件校验结果 → 捕获所有 console 错误
 *
 * 覆盖顺序（v5 关键约束：建档强校验只要求「≥1 产线」，工位模型已移除，
 *   因此必须先建线体，再建档）：
 *   0  启动与版本
 *   1  showView 全局挂载
 *   2  产线配置（只有线体，无工位；表头含 v5.2.0 的「机种名称」列）
 *   2.5 人员卡库（v5.1.0：刷卡前置数据，卡号唯一）
 *   3  夹具建档（含强校验的 UI 落地）
 *   3.5 线体 ↔ 机种 派生列（v5.2.0：产线配置「机种名称」= 夹具 lineModels 汇总）
 *   4  出库（库位冻结 + 刷卡严格校验：未登记 / 同卡 / 角色不符都拒）
 *   5  回库（可改库位，写回 location）
 *   6  重复出库/回库 3 轮
 *   7  送修 / 维修完成
 *   8  报废
 *   9  搜索 / 二维码标签 / 视图切换 / 流水 / 仪表盘
 *   10 库位管理（卡片数字 = 在库套数）
 *   11 产线使用（只读、无产品级联、无工位/示意图；v5.1.0 打印清单入口）
 *   12 机种管理 / 机种明细（v5.2.0 表头含「线体」列，与产线配置互逆）
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

/* 测试环境必须用全局 app / BrowserWindow（非 require）：
   Electron CLI binary 模式已注入全局对象，而 script 模式下
   require('electron') 返回路径字符串而非 API 对象。 */
const { app, BrowserWindow, ipcMain } = require('electron');

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
  /* #fix_cat 已是下拉：值不在候选里时先补 option（等价于「＋ 新增分类」）再选中 */
  const setCat=(v)=>{ const sel=$('#fix_cat'); if(!sel) return false;
    if(v && ![...sel.options].some(o=>o.value===v)){ const o=document.createElement('option'); o.value=v; o.textContent=v;
      sel.insertBefore(o, sel.querySelector('option[value="__NEW__"]')); }
    sel.value=v; sel.dispatchEvent(new Event('change')); return true; };
  const btnByText=(t)=>$$('button').find(b=>b.textContent.includes(t));
  const btnByOnclick=(fn)=>$$('button').find(b=>String(b.getAttribute('onclick')||'').startsWith(fn));
  /* v5.1.0 刷卡：USB 读卡器 = 键盘模拟，写入卡号后派发 Enter 即等价于刷一次卡 */
  const swipe=(sel,card)=>{ const el=$(sel); if(!el) return false;
    el.focus(); el.value=card; el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    return true; };
  const idFromOnclick=(b,fn)=>Number(String((b&&b.getAttribute('onclick'))||'').match(new RegExp(fn+'\\\\((\\\\d+)\\\\)'))[1]);
`;

/* 建档工具：按夹具编号建一套夹具（自动选产线）
   ⚠️ 产线以**名称**传入：`#fix_line_pick` 只存在于表单弹窗内，
      必须在 openFixForm 之后才能读到线体 id，不能在弹窗外预先解析。
   v5.0.0：工位模型已移除，不再有 #fix_st_pick / 工位勾选步骤。 */
const NEW_FIXTURE_FN = `
  async function newFixture(o) {
    window.showView('fixtures'); await sleep(150);
    window.fixtureNew(); await sleep(300);
    const diag = [];
    if (!setV('#fix_serial', o.serialNo)) diag.push('no#fix_serial');
    setV('#fix_name', o.name);
    setV('#fix_loc', o.location); setCat(o.cat || '');
    if (o.remark) setV('#fix_remark', o.remark);
    setV('#fix_lm_text', (o.models || []).join(' / ')); window.fixFormModelsInput();
    await sleep(100);
    for (const nm of (o.lines || [])) {
      const sel = $('#fix_line_pick');
      const opt = sel ? [...sel.options].find((x) => x.textContent.includes(nm)) : null;
      if (!opt) { diag.push('no-line:' + nm); continue; }
      sel.value = opt.value; window.fixFormLinePicked(); await sleep(160);
      /* v5.0.0：fixFormLinePicked 只记住下拉选择，必须再点「+ 添加」才会进入标签区 */
      window.fixFormAddLine(); await sleep(160);
    }
    if ($('#fix_st_pick')) diag.push('station-picker-still-present');
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
  const boot = await wc.executeJavaScript('({title: document.title, hasContent: !!document.querySelector("#content"), navCount: document.querySelectorAll(".nav-item").length, brand: (document.querySelector(".brand-name")||{}).textContent||"", foot: (document.querySelector(".foot-version")||{}).textContent||"", views: [...document.querySelectorAll(".nav-item")].map(b=>b.dataset.view)})');
  /* v4.0.4 起 title / 品牌名统一为程序名，界面版本号只在页脚显示 */
  ok('页面标题为程序名（v4.0.4 起不再带版本号）', boot.title === '工装夹具管理程序', boot.title);
  ok('侧边栏品牌名为程序名（v4.0.4 起不再带版本号）', boot.brand.trim() === '工装夹具管理程序', boot.brand);
  ok('页脚版本号 = v' + PKG_VER, boot.foot.includes('v' + PKG_VER), boot.foot);
  ok('主内容容器存在', boot.hasContent);
  ok('导航项 >= 8 个（含机种管理）', boot.navCount >= 8, String(boot.navCount));
  ok('导航含 prod（机种管理）；v4.5.0 起「按机种查询」已合并，不再单独占导航',
    boot.views.includes('prod') && !boot.views.includes('prodquery'), boot.views);
  const cssLoaded = await wc.executeJavaScript('getComputedStyle(document.body).backgroundColor');
  ok('CSS 已生效（v1.0 曾丢失样式）', cssLoaded !== 'rgba(0, 0, 0, 0)' && cssLoaded !== 'transparent', cssLoaded);

  /* ---------- 1. showView 回归 ---------- */
  section('1. showView 全局挂载（v1.0 严重 bug 回归）');
  const svRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    const out = {};
    for (const v of ['fixtures','outbound','return','records','data','dashboard','location','linecfg','linequery','prod']) {
      try { window.showView(v); await sleep(40); out[v] = 'OK'; }
      catch (e) { out[v] = 'FAIL:' + e.message; }
    }
    /* v4.5.0 旧视图名别名：prodquery → prod，不得空白 */
    try {
      window.showView('prodquery'); await sleep(250);
      out.aliasProdQuery = ((($('#viewTitle') || {}).textContent) || '').includes('机种管理') ? 'OK' : 'BAD_TITLE';
    } catch (e) { out.aliasProdQuery = 'FAIL:' + e.message; }
    window.showView('outbound'); await sleep(120);
    const btn = btnByText('清除已选内容');
    if (btn) { try { btn.click(); out.btnClick='OK'; } catch(e){ out.btnClick='FAIL:'+e.message; } }
    else out.btnClick = 'NO_BTN';
    return out;
  })()`);
  Object.keys(svRes).filter((k) => k !== 'btnClick' && k !== 'aliasProdQuery').forEach((v) => {
    ok('showView(' + v + ')', svRes[v] === 'OK', svRes[v]);
  });
  ok('点击出库页「清除已选内容」不报错', svRes.btnClick === 'OK', svRes.btnClick);
  ok('旧视图名 showView(\'prodquery\') 平滑落到机种管理', svRes.aliasProdQuery === 'OK', svRes.aliasProdQuery);

  /* ---------- 2. 产线配置（v5：只有线体，工位模型已移除） ---------- */
  section('2. 产线配置（仅线体）');
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

    /* 选中 L1 → 面板只展示该线体的夹具数量 */
    const pickBtns = $$('button').filter(b=>String(b.getAttribute('onclick')||'').startsWith('lineCfgPickLine'));
    out.pickBtnCount = pickBtns.length;
    const l1Id = idFromOnclick(pickBtns.find(b=>b.closest('tr').textContent.includes('L1 总装线')), 'lineCfgPickLine');
    const l2Id = idFromOnclick(pickBtns.find(b=>b.closest('tr').textContent.includes('L2 U型线')), 'lineCfgPickLine');
    out.l1Id = l1Id; out.l2Id = l2Id;
    window.lineCfgPickLine(l1Id); await sleep(400);
    const bodyTxt = (($('#content')||{}).textContent||'');
    out.pickedMarked = bodyTxt.includes('已选');
    /* v5.0.0：工位相关 UI 一律不存在 */
    out.hasStationForm = $$('button').some(b=>String(b.getAttribute('onclick')||'').startsWith('lineCfgStationForm'));
    out.hasStationBind = $$('button').some(b=>String(b.getAttribute('onclick')||'').startsWith('lineCfgBindForm'));
    out.hasStationText = /工位/.test(bodyTxt);
    out.hasDiagram = $$('#content svg').length;
    out.headText = (($('#content thead')||{}).textContent||'').replace(/\\s+/g,'');
    return out;
  })()`);
  ok('产线配置页可进入', cfgRes.navOk === true, cfgRes.navOk);
  ok('线体表单字段齐全', cfgRes.lineFormOk === true);
  ok('线体形态下拉只有 直线形 / U型 两项',
    JSON.stringify(cfgRes.typeOpts) === JSON.stringify(['linear', 'u']), cfgRes.typeOpts);
  ok('线体表渲染 2 行', cfgRes.lineRows === 2, String(cfgRes.lineRows));
  ok('线体行含「选择」按钮', cfgRes.pickBtnCount >= 2, String(cfgRes.pickBtnCount));
  ok('点「选择」后该行标记为「已选」', cfgRes.pickedMarked === true);
  ok('v5：工位表单入口已移除（无 lineCfgStationForm）', cfgRes.hasStationForm === false, String(cfgRes.hasStationForm));
  ok('v5：工位绑定表单已移除（无 lineCfgBindForm）', cfgRes.hasStationBind === false, String(cfgRes.hasStationBind));
  ok('v5：产线配置页正文不再出现「工位」字样', cfgRes.hasStationText === false);
  ok('v5：产线配置页不再渲染任何示意图（无 svg）', cfgRes.hasDiagram === 0, String(cfgRes.hasDiagram));
  ok('线体表头 = 选用 / 线体名称 / 形态 / 关联夹具 / 机种名称 / 备注 / 操作',
    ['选用', '线体名称', '形态', '关联夹具', '机种名称', '备注', '操作'].every((h) => cfgRes.headText.includes(h)), cfgRes.headText);

  const dbCfg = readDb();
  ok('lines 已落盘 2 条', (dbCfg.lines || []).length === 2, String((dbCfg.lines || []).length));
  ok('v5：数据文件不再有 stations 集合', dbCfg.stations === undefined, Object.keys(dbCfg));
  ok('U型线体落盘 type=u', (dbCfg.lines || []).some((l) => l.type === 'u'));
  ok('v4：数据文件不再有 products 集合', dbCfg.products === undefined, Object.keys(dbCfg));
  ok('v4：数据文件不再有 stationFixtures 集合', dbCfg.stationFixtures === undefined, Object.keys(dbCfg));
  ok('v4：数据文件含 productions 集合', Array.isArray(dbCfg.productions));

  const cfg = { l1: cfgRes.l1Id, l2: cfgRes.l2Id };

  /* ---------- 2.5 人员卡库（v5.1.0：刷卡前置数据） ---------- */
  section('2.5 人员卡库（卡号 → 姓名 / 角色，刷卡的前置数据）');
  const staffRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    const out = {};
    window.showView('staff'); await sleep(450);
    out.navOk = ((($('#viewTitle')||{}).textContent)||'').includes('人员卡库');
    out.emptyBefore = (($('#staff_table_box')||{}).textContent||'').includes('还没有登记');
    const addStaff = async (card, name, dept, role) => {
      window.staffForm(0); await sleep(200);
      setV('#st_card', card); setV('#st_name', name); setV('#st_dept', dept);
      const rs = $('#st_role'); if (rs) rs.value = role;
      await window.submitStaffForm(0);
      for (let i = 0; i < 30; i++) { await sleep(80); if ($('#modalOverlay').hidden) break; }
      await sleep(180);
    };
    await addStaff('OP-0001', '王经办', '仓库', 'operator');
    await addStaff('BR-0001', '李领用', '生产一车间', 'borrower');
    await addStaff('BOTH01', '张全能', '装配车间', 'both');
    out.rows = $$('#staff_table_box tbody tr').length;
    out.tableText = (($('#staff_table_box')||{}).textContent||'');

    /* 重复卡号（大小写 + 分隔符写法不同，归一化后同号）→ 输入时提示、保存时拦截 */
    window.staffForm(0); await sleep(200);
    setV('#st_card', 'op0001'); setV('#st_name', '冒充者');
    const cardEl = $('#st_card');
    cardEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await sleep(180);
    out.dupMark = (($('#st_card_state')||{}).textContent||'');
    await window.submitStaffForm(0); await sleep(320);
    out.dupBlocked = $('#modalOverlay').hidden === false;
    out.dupToast = (($('#toast')||{}).textContent||'');
    window.closeModal(); await sleep(150);
    out.rowsAfter = $$('#staff_table_box tbody tr').length;

    /* 搜索过滤 */
    setV('#staff_kw', '李领用'); await sleep(220);
    out.filterRows = $$('#staff_table_box tbody tr').length;
    window.staffQueryClear(); await sleep(150);
    return out;
  })()`);
  ok('人员卡库页可进入', staffRes.navOk === true, staffRes.navOk);
  ok('初始为空态提示', staffRes.emptyBefore === true);
  ok('界面新增 3 张卡后表格 3 行', staffRes.rows === 3, String(staffRes.rows));
  ok('表格显示卡号 / 姓名 / 角色',
    /OP-0001/.test(staffRes.tableText) && /王经办/.test(staffRes.tableText) && /经办人/.test(staffRes.tableText));
  ok('重复卡号在录入时即提示「已登记给」', /已登记给/.test(staffRes.dupMark || ''), staffRes.dupMark);
  ok('重复卡号保存被拒（弹窗保持打开）', staffRes.dupBlocked === true);
  ok('重复卡号提示写明已登记人', /已登记给「王经办」/.test(staffRes.dupToast || ''), staffRes.dupToast);
  ok('被拒后人数未增加', staffRes.rowsAfter === 3, String(staffRes.rowsAfter));
  ok('按姓名搜索命中 1 条', staffRes.filterRows === 1, String(staffRes.filterRows));

  const dbStaff = readDb();
  ok('staffs 已落盘 3 条', (dbStaff.staffs || []).length === 3, String((dbStaff.staffs || []).length));
  ok('落盘角色覆盖 operator / borrower / both',
    ['operator', 'borrower', 'both'].every((r) => (dbStaff.staffs || []).some((x) => x.role === r)),
    (dbStaff.staffs || []).map((x) => x.role));
  ok('落盘均默认启用', (dbStaff.staffs || []).every((x) => x.active === true));

  /* ---------- 3. 夹具建档 ---------- */
  section('3. 夹具建档（强校验的 UI 落地）');
  const formRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    const out = {};
    window.showView('fixtures'); await sleep(200);
    window.fixtureNew(); await sleep(250);
    out.fields = ['#fix_serial','#fix_name','#fix_lm_text','#fix_loc','#fix_cat','#fix_ls_box','#fix_remark']
      .every(s=>!!$(s));
    out.hasStationPicker = !!$('#fix_st_pick');
    out.labelText = (($('#modalBody')||{}).textContent||'');
    /* 未选产线直接提交 → 必须被拒 */
    setV('#fix_serial','SN-DENY'); setV('#fix_name','缺产线夹具'); setV('#fix_loc','ZP1-U-9-9');
    setV('#fix_lm_text','WJ-100'); window.fixFormModelsInput(); await sleep(80);
    window.submitFixForm(); await sleep(350);
    const toastTxt1 = (($('#toast')||{}).textContent||'');
    out.deniedNoLine = /至少选择 1 条产线/.test(toastTxt1);
    out.deniedStillOpen = $('#modalOverlay').hidden === false;
    window.closeModal(); await sleep(120);
    /* 非法库位被拒 */
    window.fixtureNew(); await sleep(200);
    setV('#fix_serial','SN-BAD'); setV('#fix_name','非法库位'); setV('#fix_loc','A-9');
    setV('#fix_lm_text','WJ-100'); window.fixFormModelsInput(); await sleep(60);
    const sel0 = $('#fix_line_pick'); sel0.value=String(${cfg.l1}); window.fixFormLinePicked(); await sleep(120);
    window.fixFormAddLine(); await sleep(150);
    window.submitFixForm(); await sleep(350);
    out.deniedBadLoc = /4 段式/.test((($('#toast')||{}).textContent||''));
    window.closeModal(); await sleep(120);
    /* 机种上限 12：输入 15 个（用 / 分隔）应只保留前 12 个并给出提示 */
    window.fixtureNew(); await sleep(200);
    const fifteen = Array.from({length:15},(_,i)=>'MX-'+(i+1)).join(' / ');
    setV('#fix_lm_text', fifteen); window.fixFormModelsInput(); await sleep(80);
    out.chipCount = $$('#fix_lm_chips .chip-tag').length;
    out.lmCountText = (($('#fix_lm_count')||{}).textContent||'');
    out.lmHint = (($('#fix_lm_hint')||{}).textContent||'');
    window.closeModal(); window.resetFixForm(); await sleep(120);
    return out;
  })()`);
  ok('建档表单字段齐全', formRes.fields === true);
  ok('v5：表单已无工位选择控件（#fix_st_pick）', formRes.hasStationPicker === false, String(formRes.hasStationPicker));
  ok('表单标注「关联产线（≥1 条 · ≤5 条）」',
    /关联产线/.test(formRes.labelText) && /≥1 条/.test(formRes.labelText) && /≤5 条/.test(formRes.labelText),
    (formRes.labelText || '').slice(0, 120));
  ok('表单正文不再出现「工位」字样', !/工位/.test(formRes.labelText), (formRes.labelText || '').slice(0, 160));
  ok('零产线提交被拒（弹窗保持打开）', formRes.deniedNoLine === true && formRes.deniedStillOpen === true);
  ok('非法库位（A-9）提交被拒', formRes.deniedBadLoc === true);
  ok('机种最多 12 个：第 13 个起被截断', formRes.chipCount === 12, String(formRes.chipCount));
  ok('机种计数文案 12 / 12', formRes.lmCountText === '12 / 12', formRes.lmCountText);
  ok('机种超过 12 个时给出截断提示', /超过 12 个/.test(formRes.lmHint || ''), formRes.lmHint);

  /* 正式建 4 套（第 4 套与第 1 套同夹具编号，验证「多套追踪」） */
  const mkRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    ${NEW_FIXTURE_FN}
    window.showView('fixtures'); await sleep(200);
    const r = {};
    r.detail = [];
    r.a = await newFixture({ serialNo:'DH40MC-921-001-001', name:'定位销压板', location:'ZP1-U-1-1', cat:'冲压',
      models:['DH40MC','DH40MC-B'], lines:['L1 总装线'], remark:'建档测试A' });
    r.detail.push(r.a);
    r.b = await newFixture({ serialNo:'XXK-D10VG-002', name:'焊接夹具B', location:'ZP1-U-1-2', cat:'焊接',
      models:['XXK-D10VG'], lines:['L1 总装线'] });
    r.detail.push(r.b);
    r.c = await newFixture({ serialNo:'SN-C-003', name:'装配工装C', location:'ZP1-U-1-3', cat:'装配',
      models:['ASSY-01'], lines:['L2 U型线'] });
    r.detail.push(r.c);
    r.d = await newFixture({ serialNo:'DH40MC-921-001-001', name:'定位销压板', location:'ZP1-U-1-9', cat:'冲压',
      models:['DH40MC'], lines:['L1 总装线'] });
    r.detail.push(r.d);
    r.a = r.a.ok; r.b = r.b.ok; r.c = r.c.ok; r.d = r.d.ok;
    r.cards = $$('#fixture_list .fixture-card').length;
    return r;
  })()`);
  ok('建档 A（DH40MC-921-001-001 / L1 总装线）成功', mkRes.a === true, JSON.stringify(mkRes.detail && mkRes.detail[0]));
  ok('建档 B（XXK-D10VG-002 / L1 总装线）成功', mkRes.b === true, JSON.stringify(mkRes.detail && mkRes.detail[1]));
  ok('建档 C（SN-C-003 / L2 U型线）成功', mkRes.c === true, JSON.stringify(mkRes.detail && mkRes.detail[2]));
  ok('同夹具编号可再建一套（多套追踪）', mkRes.d === true, JSON.stringify(mkRes.detail && mkRes.detail[3]));
  ok('建档全流程未出现工位相关的失败诊断',
    (mkRes.detail || []).every((x) => !(x && x.diag || []).some((d) => /station/i.test(d))),
    JSON.stringify((mkRes.detail || []).map((x) => x && x.diag)));
  ok('卡片视图渲染 4 张卡', mkRes.cards === 4, String(mkRes.cards));

  const db3 = readDb();
  ok('fixtures 落盘 4 条', db3.fixtures.length === 4, String(db3.fixtures.length));
  ok('序号为 4 位纯数字', db3.fixtures.every((f) => /^\d{4}$/.test(String(f.code))), db3.fixtures.map((f) => f.code));
  ok('序号互不相同', new Set(db3.fixtures.map((f) => String(f.code))).size === 4);
  ok('每条夹具都落盘了 lines 数组（≥1 条产线）',
    db3.fixtures.every((f) => Array.isArray(f.lines) && f.lines.length >= 1),
    db3.fixtures.map((f) => f.lines));
  ok('v5：夹具记录不再落盘 stations 字段',
    db3.fixtures.every((f) => f.stations === undefined), db3.fixtures.map((f) => Object.keys(f).includes('stations')));
  ok('夹具记录无 quantity / qty 存储字段（数量为派生值）',
    db3.fixtures.every((f) => f.quantity === undefined && f.qty === undefined));
  ok('夹具记录不再落盘 qrToken', db3.fixtures.every((f) => f.qrToken === undefined));
  ok('初始状态全部为 stocked', db3.fixtures.every((f) => f.status === 'stocked'));

  const n1001 = db3.fixtures.filter((f) => f.serialNo === 'DH40MC-921-001-001');
  ok('同实物编号 2 套分别独立记录（库位不同）',
    n1001.length === 2 && new Set(n1001.map((f) => f.location)).size === 2, n1001.map((f) => f.location));
  const codeOf = {};
  db3.fixtures.forEach((f) => { codeOf[f.location] = f.code; });

  /* 编辑夹具：序号不可改，只有提示 */
  const editRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    const card = $$('.fixture-card').find(c=>c.textContent.includes('SN-C-003'));
    if (!card) return { err:'未找到 SN-C-003 卡片' };
    const id = Number(card.dataset.id);
    window.fixtureEdit(id); await sleep(300);
    const txt = (($('#modalBody')||{}).textContent||'');
    const out = { hasSerial: !!$('#fix_serial'), noCodeInput: !$('#fix_new_code'), tip: /不可修改/.test(txt), title: (($('#modalTitle')||{}).textContent||'') };
    /* 改库位并保存 */
    setV('#fix_loc','ZP1-U-1-3'); setCat('装配-改');
    window.submitFixForm();
    /* 保存同样是异步的（IPC 落盘）⇒ 轮询等弹窗关闭，别用固定 sleep 造成假失败 */
    for (let i = 0; i < 40; i++) { await sleep(100); if ($('#modalOverlay').hidden) break; }
    out.closed = $('#modalOverlay').hidden === true;
    return out;
  })()`);
  ok('编辑弹窗含实物编号输入但无序号输入', editRes.hasSerial === true && editRes.noCodeInput === true, JSON.stringify(editRes));
  ok('编辑弹窗提示序号不可修改', editRes.tip === true);
  ok('编辑弹窗标题显示实物编号', /SN-C-003/.test(editRes.title), editRes.title);
  ok('编辑保存后弹窗关闭', editRes.closed === true);

  /* ---------- 3.5 线体 ↔ 机种 派生列（v5.2.0） ---------- */
  section('3.5 线体 ↔ 机种 派生列（两列都由夹具现算，不新增存储字段）');
  const crossRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    const out = {};
    /* ① 产线配置：线体 → 机种名称（夹具 a/b/d 在 L1，夹具 c 在 L2） */
    window.showView('linecfg'); await sleep(450);
    out.lcHead = ((($('#content thead')||{}).textContent)||'').replace(/\\s+/g,'');
    const trOf = (nm) => $$('#content tbody tr').find(tr=>tr.textContent.includes(nm));
    const r1 = trOf('L1 总装线'), r2 = trOf('L2 U型线');
    out.colCount = r1 ? r1.children.length : -1;
    out.l1Cell = r1 ? r1.children[4].textContent.trim() : '(未找到 L1 行)';
    out.l2Cell = r2 ? r2.children[4].textContent.trim() : '(未找到 L2 行)';
    /* 派生列不应写库：机种仍在夹具的 lineModels 上，lines 集合没有机种字段 */
    return out;
  })()`);
  ok('产线配置表头含新增的「机种名称」列', crossRes.lcHead.includes('机种名称'), crossRes.lcHead);
  ok('线体表列数 = 7（选用 / 线体名称 / 形态 / 关联夹具 / 机种名称 / 备注 / 操作）',
    crossRes.colCount === 7, String(crossRes.colCount));
  ok('L1 的机种名称 = DH40MC / DH40MC-B / XXK-D10VG（去重 + 自然序，/ 分隔）',
    crossRes.l1Cell === 'DH40MC / DH40MC-B / XXK-D10VG', crossRes.l1Cell);
  ok('L2 的机种名称 = ASSY-01（只算挂在该线上的夹具）', crossRes.l2Cell === 'ASSY-01', crossRes.l2Cell);

  const db35 = readDb();
  ok('派生列不落库：lines 记录仍只有 name/type/remark（无机种字段）',
    (db35.lines || []).every((l) => l.models === undefined && l.lineModels === undefined && l.productions === undefined),
    (db35.lines || []).map((l) => Object.keys(l)));
  ok('派生列不落库：夹具仍只在 lineModels 上存机种',
    (db35.fixtures || []).every((f) => Array.isArray(f.lineModels)));

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
    const out = {};   // 刷卡校验用例的容器
    const hasOp = !!$('#swipe_dlg_operator');
    const hasLocInput = !!$('#fix_out_loc');
    if (hasOp) {
      /* ① 未登记的卡 → 必须被拒 */
      swipe('#swipe_dlg_party','NOCARD-X'); swipe('#swipe_dlg_operator','OP-0001');
      btnByText('确认出库').click(); await sleep(350);
      out.unknownBlocked = ('#modalOverlay' && !$('#modalOverlay').hidden) && /未登记/.test((($('#toast')||{}).textContent||''));
      out.unknownToast = (($('#toast')||{}).textContent||'');
      /* ② 同一张卡刷两个位 → 必须被拒（用「两者皆可」的卡，否则会先被角色校验拦下） */
      swipe('#swipe_dlg_party','BOTH01'); swipe('#swipe_dlg_operator','BOTH01');
      btnByText('确认出库').click(); await sleep(350);
      out.sameCardBlocked = /同一个人（同一张卡）/.test((($('#toast')||{}).textContent||''));
      /* ③ 角色不符：领用位刷「经办人」角色的卡 */
      swipe('#swipe_dlg_party','OP-0001');
      out.roleBlocked = /不能作为领用人/.test((($('#swipe_dlg_party_tip')||{}).textContent||''));
      out.roleTip = (($('#swipe_dlg_party_tip')||{}).textContent||'');
      /* ④ 正常刷卡：领用人 BR-0001 + 经办人 OP-0001 */
      swipe('#swipe_dlg_party','BR-0001'); swipe('#swipe_dlg_operator','OP-0001');
      out.partyState = (($('#swipe_dlg_party_state')||{}).textContent||'');
      out.opState = (($('#swipe_dlg_operator_state')||{}).textContent||'');
      setV('#fix_out_remark','首次领用');
      btnByText('确认出库').click();
    }
    await sleep(650);
    return Object.assign({ hasOp, hasLocInput }, out);
  })()`);
  ok('出库弹窗打开且字段存在', outRes.hasOp === true, JSON.stringify(outRes));
  ok('建档已填库位 → 出库弹窗无需补填库位', outRes.hasLocInput === false, String(outRes.hasLocInput));
  ok('v5.1.0：未登记卡号被拒（弹窗未提交）', outRes.unknownBlocked === true, outRes.unknownToast);
  ok('v5.1.0：同一张卡刷两个位被拒', outRes.sameCardBlocked === true);
  ok('v5.1.0：角色不符被拒（领用位刷「经办人」的卡）', outRes.roleBlocked === true, outRes.roleTip);
  ok('v5.1.0：刷卡成功后领用人位显示姓名', /李领用/.test(outRes.partyState || ''), outRes.partyState);
  ok('v5.1.0：刷卡成功后经办人位显示姓名', /王经办/.test(outRes.opState || ''), outRes.opState);
  ok('数据文件已生成于隔离目录', fs.existsSync(dataFile), dataFile);

  const db4 = readDb();
  const outFix = db4.fixtures.find((f) => f.location === 'ZP1-U-1-1' && f.serialNo === 'DH40MC-921-001-001');
  ok('出库后状态 = checked_out', outFix && outFix.status === 'checked_out', outFix && outFix.status);
  ok('出库次数 = 1', outFix && outFix.totalOutCount === 1, outFix && String(outFix.totalOutCount));
  ok('出库冻结库位（location 不变）', outFix && outFix.location === 'ZP1-U-1-1', outFix && outFix.location);
  const txOut = db4.fixTransactions.find((t) => t.fixtureCode === String(codeOf['ZP1-U-1-1']) && t.type === 'out');
  ok('出库流水已写入', !!txOut);
  ok('流水经办人 = 王经办（刷卡带出，非手填）', txOut && txOut.operator === '王经办', txOut && txOut.operator);
  ok('流水经办人卡号 = OP0001（归一化后落库）', txOut && txOut.operatorCard === 'OP0001', txOut && txOut.operatorCard);
  ok('流水领用人 = 李领用（刷卡带出）', txOut && txOut.counterparty === '李领用', txOut && txOut.counterparty);
  ok('流水领用人卡号 = BR0001（归一化后落库）', txOut && txOut.partyCard === 'BR0001', txOut && txOut.partyCard);
  ok('流水状态迁移 stocked → checked_out', txOut && txOut.fromStatus === 'stocked' && txOut.toStatus === 'checked_out');
  ok('流水带库位快照 from/to = ZP1-U-1-1',
    txOut && txOut.fromLocation === 'ZP1-U-1-1' && txOut.toLocation === 'ZP1-U-1-1', txOut && [txOut.fromLocation, txOut.toLocation]);
  ok('流水冗余实物编号字段', txOut && txOut.fixtureSerialNo === 'DH40MC-921-001-001', txOut && txOut.fixtureSerialNo);

  /* ---------- 5. 回库（可改库位） ---------- */
  section('5. 回库流程（四栏互查 → 卡片弹窗改库位 → 提交）');
  const retRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('return'); await sleep(300);
    const codeBox = $('#return_code');
    if (!codeBox) return { err:'回库页无编号输入框' };
    codeBox.value='DH40MC-921-001-001';
    codeBox.dispatchEvent(new Event('input'));
    await sleep(450);
    const picks=[...document.querySelectorAll('.return-pick')];
    /* v4.0.4 设计：批量回库表单不含库位字段；改库位在卡片「回库」弹窗完成 */
    const pageHasLoc = !!$('#return_new_location');

    window.showView('fixtures'); await sleep(300);
    const card=$$('.fixture-card').find(c=>c.textContent.includes('DH40MC-921-001-001'));
    if (!card) return { n:picks.length, pageHasLoc, err:'无 A 卡片' };
    const rb=[...card.querySelectorAll('button')].find(b=>b.textContent.trim()==='回库');
    if (!rb) return { n:picks.length, pageHasLoc, err:'卡片无回库按钮',
                      btns:[...card.querySelectorAll('button')].map(b=>b.textContent.trim()) };
    rb.click(); await sleep(320);
    const hasLocField = !!$('#fix_return_loc');
    if (hasLocField) setV('#fix_return_loc','ZP1-U-2-2');
    swipe('#swipe_rdlg_party','BR-0001'); swipe('#swipe_rdlg_operator','OP-0001');
    const btn=btnByText('确认回库');
    if (btn) btn.click();
    await sleep(800);
    return { n:picks.length, pageHasLoc, hasLocField, clicked:!!btn };
  })()`);
  ok('回库候选列表命中 1 台待回库夹具', retRes.n === 1, JSON.stringify(retRes));
  ok('批量回库表单不含库位字段（v4.0.4 设计）', retRes.pageHasLoc === false, JSON.stringify(retRes));
  ok('卡片「回库」弹窗提供库位字段（可改库位）', retRes.hasLocField === true, JSON.stringify(retRes));
  ok('「确认回库」按钮存在且已点击', retRes.clicked === true, JSON.stringify(retRes));

  const db5 = readDb();
  const retFix = db5.fixtures.find((f) => f.serialNo === 'DH40MC-921-001-001' && f.code === codeOf['ZP1-U-1-1']);
  ok('回库后状态 = stocked', retFix && retFix.status === 'stocked', retFix && retFix.status);
  ok('回库次数 = 1', retFix && retFix.totalReturnCount === 1, retFix && String(retFix.totalReturnCount));
  ok('回库库位写回 location（ZP1-U-1-1 → ZP1-U-2-2）', retFix && retFix.location === 'ZP1-U-2-2', retFix && retFix.location);
  const txRet = db5.fixTransactions.find((t) => t.type === 'return' && t.operator === '王经办');
  ok('回库流水已写入', !!txRet);
  ok('流水记录库位变更 from ZP1-U-1-1 → to ZP1-U-2-2',
    txRet && txRet.fromLocation === 'ZP1-U-1-1' && txRet.toLocation === 'ZP1-U-2-2', txRet && [txRet.fromLocation, txRet.toLocation]);
  ok('非法回库库位尝试（下一步校验未写库）', await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    /* 先把 B 出库 */
    window.showView('fixtures'); await sleep(250);
    let card = $$('.fixture-card').find(c=>c.textContent.includes('XXK-D10VG-002'));
    const ob=[...card.querySelectorAll('button')].find(b=>b.textContent.trim()==='出库');
    if (!ob) return false;
    ob.click(); await sleep(300);
    swipe('#swipe_dlg_party','BR-0001'); swipe('#swipe_dlg_operator','OP-0001');
    btnByText('确认出库').click(); await sleep(600);
    /* 再以非法库位回库（卡片弹窗路径，v4.0.4 改库位入口） */
    card = $$('.fixture-card').find(c=>c.textContent.includes('XXK-D10VG-002'));
    const rb=[...card.querySelectorAll('button')].find(b=>b.textContent.trim()==='回库');
    if (!rb) return false;
    rb.click(); await sleep(320);
    const loc=$('#fix_return_loc');
    const hadField = !!loc;
    if (loc) setV('#fix_return_loc','BAD');
    swipe('#swipe_rdlg_party','BR-0001'); swipe('#swipe_rdlg_operator','OP-0001');
    btnByText('确认回库').click(); await sleep(650);
    /* 校验失败时弹窗保持打开，关闭后继续后续流程 */
    if (window.closeModal) { window.closeModal(); await sleep(150); }
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
    swipe('#swipe_ret_party','BR-0001'); swipe('#swipe_ret_operator','OP-0001');
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
      swipe('#swipe_dlg_party','BR-0001'); swipe('#swipe_dlg_operator','OP-0001');
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
      swipe('#swipe_ret_party','BR-0001'); swipe('#swipe_ret_operator','OP-0001');
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
    await search('L1 总装线');
    const nByLine=$$('#fixture_list .fixture-card').length;
    await search('上料工位');
    const nByStation=$$('#fixture_list .fixture-card').length;
    await search('');
    const n2=$$('#fixture_list .fixture-card').length;
    return {n1, nRetired, empty, nByLine, nByStation, n2};
  })()`);
  ok('按夹具编号搜索命中 2 套（同编号多套）', searchRes.n1 === 2, JSON.stringify(searchRes));
  ok('按夹具编号搜索命中已报废套', searchRes.nRetired === 1, String(searchRes.nRetired));
  ok('无结果显示空提示', searchRes.empty === true);
  ok('支持按产线名搜索（3 套挂在 L1 总装线）', searchRes.nByLine === 3, String(searchRes.nByLine));
  ok('v5：工位名不再参与检索（搜「上料工位」命中 0）', searchRes.nByStation === 0, String(searchRes.nByStation));
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

  /* 二维码弹窗：内容 = 纯序号（如 1001，无 SPMS1| 前缀），标签卡只印夹具编号 + 名称 */
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
    out.tokenShown=/二维码内容：\\d{4}/.test(modalText);
    out.tokenHasSpms=/SPMS/i.test(modalText);
    out.hasNameLabel=modalText.includes('夹具编号');
    out.hasBridgeLabel=modalText.includes('序号');
    out.hasDownload=!!btnByText('下载 PNG');
    out.hasPrint=!!btnByText('打印');
    out.modalTitle=(($('#modalTitle')||{}).textContent||'');
    return out;
  })()`);
  ok('夹具卡片含「二维码」按钮', !qrRes.err, JSON.stringify(qrRes));
  ok('「批量打印标签」按钮存在', qrRes.hasBatch === true);
  ok('二维码弹窗打开并绘制二维码', qrRes.hasCanvas === true && qrRes.qrDrawn === true, JSON.stringify(qrRes));
  ok('弹窗展示二维码内容为纯序号（4 位数字）', qrRes.tokenShown === true, JSON.stringify(qrRes));
  ok('二维码内容不含 SPMS 前缀', qrRes.tokenHasSpms === false, JSON.stringify(qrRes));
  ok('弹窗区分「夹具编号」与「序号」两个概念', qrRes.hasNameLabel === true && qrRes.hasBridgeLabel === true);
  ok('二维码弹窗标题显示夹具编号', /XXK-D10VG-002/.test(qrRes.modalTitle), qrRes.modalTitle);
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
    box.value='王经办'; box.dispatchEvent(new Event('input')); await sleep(300);
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

  /* ---------- 10. 产线使用 ---------- */
  section('10. 产线使用（只读 / 无产品级联 / 无工位与示意图）');
  const lqRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('linequery'); await sleep(700);
    const out={};
    out.navOk=(($('#viewTitle')||{}).textContent||'').includes('产线使用');
    out.lineOptCount=$$('#lq_line option').length;
    out.hasProductSelect=!!$('#lq_product');
    out.hasTable=!!$('#lq_body table');
    out.headText=(($('#lq_body thead')||{}).textContent||'').replace(/\\s+/g,'');
    out.rowsL1=$$('#lq_body table tbody tr').length;
    const bodyL1=(($('#lq_body')||{}).textContent||'');
    out.l1HasSerial=bodyL1.includes('DH40MC-921-001-001');
    out.l1ReadonlyTip=bodyL1.includes('只读');
    out.l1HasStationWord=/工位/.test(bodyL1);
    out.l1Svg=$$('#lq_body svg').length;
    out.l1Count=(($('#lq_count')||{}).textContent||'');
    out.hasGotoProd=$$('button').some(b=>String(b.getAttribute('onclick')||'').includes("showView('prod')"));
    /* ---------- v5.2.1 BUG-012：机种下拉筛选（此前任何含字母的机种恒 0 条） ---------- */
    out.modelDisabled = !!$('#lq_model').disabled;
    out.modelOptCount = $$('#lq_model option').length;
    out.modelDefault = $('#lq_model').value;
    const mSel = $('#lq_line').value ? $('#lq_model') : null;
    /* helper：选一个机种 → 返回渲染行数与正文 */
    async function pickModel(m) {
      const s=$('#lq_model');
      const o=$$('#lq_model option').find(x=>x.value===m);
      if (!o) return { missing:true, value:s.value };
      s.value=o.value; s.dispatchEvent(new Event('change')); await sleep(400);
      return {
        value: $('#lq_model').value,
        rows: $$('#lq_body table tbody tr').length,
        text: (($('#lq_body')||{}).textContent||''),
        count: (($('#lq_count')||{}).textContent||'')
      };
    }
    /* L1 上 3 套：DH40MC-921-001-001(DH40MC+DH40MC-B) / XXK-D10VG-002(XXK-D10VG) / DH40MC-921-001-001(DH40MC) */
    out.mDH40MC   = await pickModel('DH40MC');
    out.mDH40MCB  = await pickModel('DH40MC-B');
    out.mXXK      = await pickModel('XXK-D10VG');
    out.mASSY     = await pickModel('ASSY-01');   // 该机种在 L2，不在 L1 ⇒ 应为 0 条 + 空提示
    out.mDummy     = await pickModel('DH40');      // 下拉里不存在该值 ⇒ 不得命中 DH40MC
    window.lineQueryReset(); await sleep(400);
    out.afterReset = $('#lq_model').value;
    out.rowsAfterReset = $$('#lq_body table tbody tr').length;
    /* 切到 U 型线 */
    const sel=$('#lq_line');
    const uOpt=$$('#lq_line option').find(o=>o.textContent.includes('U型'));
    if (uOpt) { sel.value=uOpt.value; sel.dispatchEvent(new Event('change')); await sleep(500); }
    out.rowsL2=$$('#lq_body table tbody tr').length;
    out.l2HasRetired=(($('#lq_body')||{}).textContent||'').includes('SN-C-003');
    out.hasResetBtn=!!btnByText('重置筛选');
    out.hasPrintBtn=!!btnByText('打印清单');
    out.hasPrintArea=!!$('#printListArea');
    return out;
  })()`);
  ok('查询页可进入', lqRes.navOk === true, lqRes.navOk);
  ok('线体下拉 = 2 条线体 + 1 占位 = 3 项', lqRes.lineOptCount === 3, String(lqRes.lineOptCount));
  ok('v4：产品级联下拉已移除（无 #lq_product）', lqRes.hasProductSelect === false, String(lqRes.hasProductSelect));
  ok('结果表为 7 列（序号/夹具编号/名称/机种名称/库位/状态/操作）',
    ['序号', '夹具编号', '名称', '机种名称', '库位', '状态', '操作'].every((h) => lqRes.headText.includes(h))
      && lqRes.headText.indexOf('序号') < lqRes.headText.indexOf('夹具编号'),
    lqRes.headText);
  ok('v5：结果表头已无「工位」列',
    !lqRes.headText.includes('工位名称') && !lqRes.headText.includes('工位顺序'), lqRes.headText);
  ok('L1 上线 3 套夹具 → 渲染 3 行（按套一行，不再按工位拆行）', lqRes.rowsL1 === 3, String(lqRes.rowsL1));
  ok('表格显示实物夹具编号', lqRes.l1HasSerial === true);
  ok('页面提示「只读」视图', lqRes.l1ReadonlyTip === true);
  ok('v5：正文不再出现「工位」字样', lqRes.l1HasStationWord === false);
  ok('v5：产线使用页不再渲染示意图（无 svg）', lqRes.l1Svg === 0, String(lqRes.l1Svg));
  ok('统计文案含夹具套数与在库套数',
    /夹具\s*3\s*套/.test(lqRes.l1Count) && /在库\s*3\s*套/.test(lqRes.l1Count), lqRes.l1Count);
  ok('L2 U型线上线 1 套 → 1 行', lqRes.rowsL2 === 1, String(lqRes.rowsL2));
  ok('报废夹具仍出现在产线视图中（状态列区分）', lqRes.l2HasRetired === true);
  ok('存在「重置筛选」按钮', lqRes.hasResetBtn === true);
  ok('存在「🏷 机种管理」跳转按钮', lqRes.hasGotoProd === true);
  ok('v5.1.0：「🖨 打印清单」按钮存在', lqRes.hasPrintBtn === true);
  ok('v5.1.0：清单打印容器 #printListArea 存在', lqRes.hasPrintArea === true);

  /* ---------- v5.2.1 BUG-012 回归：机种下拉筛选 ---------- */
  ok('选定线体后机种下拉可用（未 disabled）', lqRes.modelDisabled === false, String(lqRes.modelDisabled));
  ok('机种下拉 = 「全部机种」+ 全库 4 个机种 = 5 项', lqRes.modelOptCount === 5, String(lqRes.modelOptCount));
  ok('机种下拉默认为「全部机种」（空值）', lqRes.modelDefault === '', JSON.stringify(lqRes.modelDefault));
  ok('选 DH40MC → L1 命中 2 套（BUG-012 修复前为 0）',
    lqRes.mDH40MC && !lqRes.mDH40MC.missing && lqRes.mDH40MC.rows === 2,
    JSON.stringify({ rows: lqRes.mDH40MC && lqRes.mDH40MC.rows, count: lqRes.mDH40MC && lqRes.mDH40MC.count }));
  ok('选 DH40MC → 正文含该机种两套的编号且不含 XXK 夹具',
    !!lqRes.mDH40MC && lqRes.mDH40MC.text.includes('DH40MC-921-001-001')
      && !lqRes.mDH40MC.text.includes('XXK-D10VG-002'),
    lqRes.mDH40MC && lqRes.mDH40MC.text.slice(0, 120));
  ok('选 DH40MC → 统计文案套数同步收敛为 2',
    !!lqRes.mDH40MC && /夹具\s*2\s*套/.test(lqRes.mDH40MC.count), lqRes.mDH40MC && lqRes.mDH40MC.count);
  ok('选 DH40MC-B → 精确等值只命中 1 套（不被 DH40MC 包含关系带出）',
    lqRes.mDH40MCB && lqRes.mDH40MCB.rows === 1, JSON.stringify(lqRes.mDH40MCB && lqRes.mDH40MCB.rows));
  ok('选 XXK-D10VG → L1 命中 1 套', lqRes.mXXK && lqRes.mXXK.rows === 1, JSON.stringify(lqRes.mXXK && lqRes.mXXK.rows));
  ok('选 XXK-D10VG → 正文含该夹具编号',
    !!lqRes.mXXK && lqRes.mXXK.text.includes('XXK-D10VG-002'), lqRes.mXXK && lqRes.mXXK.text.slice(0, 80));
  ok('选本线不存在的机种 ASSY-01 → 0 条并给出空提示（不是静默空白）',
    lqRes.mASSY && lqRes.mASSY.rows === 0 && /没有|暂无|无符合|0 套/.test(lqRes.mASSY.text),
    JSON.stringify({ rows: lqRes.mASSY && lqRes.mASSY.rows, text: lqRes.mASSY && lqRes.mASSY.text.slice(0, 120) }));
  ok('精确匹配：下拉里不存在的「DH40」不会被自动选中（不回落成命中 DH40MC）',
    lqRes.mDummy && lqRes.mDummy.missing === true, JSON.stringify(lqRes.mDummy));
  ok('「重置筛选」把机种复位为全部 → 恢复 3 行', lqRes.afterReset === '' && lqRes.rowsAfterReset === 3,
    JSON.stringify({ v: lqRes.afterReset, rows: lqRes.rowsAfterReset }));

  /* ---------- 11. 机种管理（v4.5.0 已合并按机种查询：点机种名展开线体明细） ---------- */
  section('11. 机种管理与机种明细');
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
    /* v5.2.0：机种 → 线体 派生列（补登后字典齐了才能按名称定位行） */
    out.headText = ((($('#content thead')||{}).textContent)||'').replace(/\\s+/g,'');
    const pickRow = (nm) => $$('#content tbody tr').find(tr=>{
      const a = tr.querySelector('a.prod-pick');
      return a && a.textContent.trim() === nm;
    });
    const pr = pickRow('DH40MC'), pa = pickRow('ASSY-01');
    out.cellCount = pr ? pr.children.length : -1;
    out.lineCellDH40 = pr ? pr.children[1].textContent.trim() : '(未找到 DH40MC 行)';
    out.lineCellASSY = pa ? pa.children[1].textContent.trim() : '(未找到 ASSY-01 行)';
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
  ok('机种管理表头含新增的「线体」列', prodRes.headText.includes('线体'), prodRes.headText);
  ok('机种表列数 = 6（机种名称 / 线体 / 关联夹具 / 在库套数 / 排序号 / 操作）',
    prodRes.cellCount === 6, String(prodRes.cellCount));
  ok('DH40MC 的线体 = L1 总装线（与产线配置「机种名称」列互逆）',
    prodRes.lineCellDH40 === 'L1 总装线', prodRes.lineCellDH40);
  ok('ASSY-01 的线体 = L2 U型线', prodRes.lineCellASSY === 'L2 U型线', prodRes.lineCellASSY);
  ok('机种表单字段齐全（名称 + 排序号）', prodRes.formOk === true);
  ok('新建机种 ZZZ-NEW 成功', prodRes.createdZZZ === true);
  ok('被夹具引用的机种禁止删除（提示无法删除）', /无法删除|仍被/.test(prodRes.delGuardText), prodRes.delGuardText.slice(0, 120));
  const db11 = readDb();
  ok('productions 已落盘（含 DH40MC）', (db11.productions || []).some((p) => p.name === 'DH40MC'), (db11.productions || []).map((p) => p.name));
  ok('productions 记录只有 id/name/order（不隶属产线）',
    (db11.productions || []).every((p) => p.lineId === undefined && p.name && p.order !== undefined),
    db11.productions && db11.productions[0]);

  /* v4.5.0：不再有独立「按机种查询」页 —— 机种管理里点机种名称，
     下方展开「线体 → 夹具」明细；再点一次收起。v5.0.0 去掉了工位列。 */
  const pqRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('prod'); await sleep(600);
    const out={};
    out.navOk=(($('#viewTitle')||{}).textContent||'').includes('机种');
    out.pickLinks=$$('#content a.prod-pick').length;
    out.hasOldQueryPage=!!$('#pq_name');
    const link=$$('#content a.prod-pick').find(a=>a.textContent.trim()==='DH40MC');
    if (link) link.click();
    await sleep(350);
    out.detailShown=!!$('#prod_detail');
    const dt=(($('#prod_detail')||{}).textContent||'');
    out.detailText=dt.replace(/\\s+/g,'');
    out.hasStationWord=/工位/.test(dt);
    out.groups=$$('#prod_detail .pq-head').map(x=>x.textContent.replace(/\\s+/g,' ').trim());
    out.headText=(($('#prod_detail thead')||{}).textContent||'').replace(/\\s+/g,'');
    out.rowCount=$$('#prod_detail table tbody tr').length;
    out.pickedRow=$$('#content tr.pick-row').length;
    /* 再点一次同机种 → 收起 */
    const link2=$$('#content a.prod-pick').find(a=>a.textContent.trim()==='DH40MC');
    if (link2) link2.click();
    await sleep(300);
    out.collapsed=!$('#prod_detail');
    return out;
  })()`);
  ok('机种管理页可进入', pqRes.navOk === true, pqRes.navOk);
  ok('独立的「按机种查询」控件已移除（合并进机种管理）', pqRes.hasOldQueryPage === false, String(pqRes.hasOldQueryPage));
  ok('机种名称渲染为可点击链接', pqRes.pickLinks >= 3, String(pqRes.pickLinks));
  ok('点机种名称 → 下方出现明细面板', pqRes.detailShown === true);
  ok('明细按线体分组（含 L1 总装线）', pqRes.groups.some((g) => g.includes('L1 总装线')), JSON.stringify(pqRes.groups));
  ok('明细表头含「夹具编号 / 名称 / 库位 / 状态」',
    ['夹具编号', '名称', '库位', '状态'].every((h) => pqRes.headText.includes(h)), pqRes.headText);
  ok('v5：明细表头不再有「工位」列', !pqRes.headText.includes('工位'), pqRes.headText);
  ok('v5：明细正文不再出现「工位」字样', pqRes.hasStationWord === false, pqRes.detailText.slice(0, 160));
  ok('明细列出夹具实物编号', pqRes.detailText.includes('DH40MC-921-001-001'), pqRes.detailText.slice(0, 160));
  ok('选中机种行高亮', pqRes.pickedRow === 1, String(pqRes.pickedRow));
  ok('再次点击同一机种 → 明细收起', pqRes.collapsed === true);

  /* ---------- 11.5 删除夹具（录错纠正） ---------- */
  section('11.5 删除夹具（录错纠正 + 连带清流水）');
  const delPre = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    ${NEW_FIXTURE_FN}
    const out = {};
    window.showView('fixtures'); await sleep(250);
    /* ⚠️ 第 9 节的视图切换用例可能把界面留在列表模式 ⇒ 必须先切回卡片，否则找不到 .fixture-card */
    window.setFixViewMode('card'); await sleep(250);
    out.beforeCards = $$('.fixture-card').length;
    out.made = await newFixture({ serialNo:'DEL-TEST-001', name:'待删除夹具', location:'ZP1-U-3-1', cat:'金属',
      models:['DH40MC'], lines:['L1 总装线'] });
    window.showView('fixtures'); await sleep(300);
    window.setFixViewMode('card'); await sleep(250);
    const card = $$('.fixture-card').find(c => c.textContent.includes('DEL-TEST-001'));
    if (!card) return { err:'卡片未找到', made: out.made, cards: $$('.fixture-card').length };
    const delBtn = [...card.querySelectorAll('button')].find(b=>b.textContent.trim()==='删除');
    if (!delBtn) return { err:'卡片无删除按钮', made: out.made };
    out.id = idFromOnclick(delBtn, 'fixtureDelete');
    /* 用真实 UI 造 2 条流水（出库 → 回库）：这样 state.fixTransactions 会随操作刷新，
       弹窗里的「关联流水条数」才是真实值（直接调 DB 只写文件、不会同步渲染层 state） */
    const cardOf = () => $$('.fixture-card').find(c => c.textContent.includes('DEL-TEST-001'));
    const pickBtn = (c, t) => [...((c && c.querySelectorAll('button')) || [])].find(b => b.textContent.trim() === t);
    const waitModal = async () => { for (let i=0;i<40;i++){ await sleep(100); if ($('#modalOverlay').hidden) break; } await sleep(400); };

    const ob = pickBtn(cardOf(), '出库');
    if (!ob) return { err:'卡片无出库按钮', made: out.made };
    ob.click(); await sleep(320);
    swipe('#swipe_dlg_party','BR-0001'); swipe('#swipe_dlg_operator','OP-0001');
    btnByText('确认出库').click(); await waitModal();

    const rb = pickBtn(cardOf(), '回库');
    if (!rb) return { err:'卡片无回库按钮', made: out.made };
    rb.click(); await sleep(320);
    swipe('#swipe_rdlg_party','BR-0001'); swipe('#swipe_rdlg_operator','OP-0001');
    btnByText('确认回库').click(); await waitModal();

    const delBtn2 = pickBtn(cardOf(), '删除');
    if (!delBtn2) return { err:'重绘后卡片无删除按钮', made: out.made };
    delBtn2.click(); await sleep(320);
    out.modalShown = $('#modalOverlay').hidden === false;
    out.modalText = (($('#modalOverlay')||{}).textContent||'').replace(/\\s+/g,' ').trim();
    /* ⚠️ 弹窗里的夹具信息是 disabled input，value 不进 textContent ⇒ 必须单独读 value */
    out.modalInputs = $$('#modalOverlay input').map(i => i.value);
    return out;
  })()`);
  ok('前置：测试夹具已成功建档', !!(delPre.made && delPre.made.ok), JSON.stringify(delPre.made));
  ok('卡片操作区有「删除」按钮', !delPre.err, delPre.err + ' / cards=' + JSON.stringify(delPre.cards));
  ok('删除确认弹窗已弹出', delPre.modalShown === true);
  ok('弹窗展示夹具编号与名称',
    (delPre.modalText || '').includes('DEL-TEST-001') && (delPre.modalText || '').includes('待删除夹具'), delPre.modalText);
  ok('弹窗列出状态 / 库位与关联流水条数',
    (delPre.modalInputs || []).join(' | ').includes('2 条（将一并删除）')
    && (delPre.modalInputs || []).join(' | ').includes('ZP1-U-3-1'),
    JSON.stringify(delPre.modalInputs));
  ok('弹窗提示不可恢复并引导改用报废',
    (delPre.modalText || '').includes('不可恢复') && (delPre.modalText || '').includes('报废'));

  const delDone = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    const btn = [...$$('#modalOverlay button')].find(b=>b.textContent.includes('确认删除'));
    if (!btn) return { err:'无确认删除按钮' };
    btn.click();
    for (let i=0;i<40;i++){ await sleep(100); if ($('#modalOverlay').hidden) break; }
    await sleep(500);
    return {
      cards: $$('.fixture-card').length,
      stillThere: (($('#fixture_list')||{}).textContent||'').includes('DEL-TEST-001'),
      toast: (($('#toast')||{}).textContent||'')
    };
  })()`);
  ok('确认删除后弹窗关闭', !delDone.err, delDone.err);
  ok('卡片视图不再显示该夹具', delDone.stillThere === false);
  ok('卡片数回到删除前（少 1 套）', delDone.cards === delPre.beforeCards,
    String(delDone.cards) + ' / 期望 ' + String(delPre.beforeCards));
  ok('删除后提示「夹具已删除」', (delDone.toast || '').includes('已删除'), delDone.toast);

  await sleep(400);
  const dbDel = readDb();
  ok('落盘：该夹具已从 fixtures 移除', !dbDel.fixtures.some((f) => f.serialNo === 'DEL-TEST-001'));
  ok('落盘：该夹具的流水被一并清除', dbDel.fixTransactions.filter((t) => t.fixtureId === delPre.id).length === 0,
    String(dbDel.fixTransactions.filter((t) => t.fixtureId === delPre.id).length));

  /* ---------- 11.6 导入 → 撤销 → 回收自动补建结构（v4.5.1 BUG-011） ---------- */
  section('11.6 撤销导入回收自动补建的产线');
  const dbImpBefore = readDb();
  const impRun = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    window.showView('fixtures'); await sleep(200);
    /* buildImportPlan 未挂 window，这里直接构造落库计划：
       只验「补建结构 → 落库 → 撤销 → 回收」这条链路（解析/归并由 test_import 覆盖）
       v5.0.0：计划里只有 lineNames，不再有 linePairs / stationNames。 */
    window.__importPlan = [{
      row: 2, isDup: false,
      fixture: { serialNo: 'ZZ-IMP-001', name: '导入回收集合', lineModels: ['DH40MC'], category: '金属',
        location: 'ZP1-U-9-9', remark: '', lineNames: ['E2E临时线'] }
    }];
    await confirmImportPlan('all');
    await sleep(700);
    return { modalOpen: !$('#modalOverlay').hidden,
             modalText: (($('#modalOverlay') || {}).textContent || '').replace(/\\s+/g, ' ').trim() };
  })()`);
  await sleep(400);
  const dbImpAfter = readDb();
  const impFixture = dbImpAfter.fixtures.find((f) => f.serialNo === 'ZZ-IMP-001') || null;
  const impBatch = impFixture ? impFixture.importBatch : '';
  const impLine = dbImpAfter.lines.find((l) => l.name === 'E2E临时线') || null;
  ok('导入后新建了 1 条产线 / 1 套夹具（不再补建工位）',
    dbImpAfter.lines.length === dbImpBefore.lines.length + 1
    && dbImpAfter.fixtures.length === dbImpBefore.fixtures.length + 1,
    JSON.stringify({ lines: [dbImpBefore.lines.length, dbImpAfter.lines.length],
      fixtures: [dbImpBefore.fixtures.length, dbImpAfter.fixtures.length] }));
  ok('导入补建的产线带「导入自动建档」备注', !!impLine && impLine.remark === '导入自动建档',
    impLine && impLine.remark);
  ok('v5：导入不会产生 stations 集合', dbImpAfter.stations === undefined, Object.keys(dbImpAfter));
  ok('落库的夹具带批次号', !!impBatch, impBatch);
  const impCreated = await wc.executeJavaScript(`(window.__importCreatedByBatch || {})[${JSON.stringify(impBatch)}] || null`);
  ok('渲染层记录了本批新建的产线 id（且无 stationIds）',
    !!impCreated && impCreated.lineIds.length === 1 && impCreated.stationIds === undefined,
    JSON.stringify(impCreated));

  const impUndo = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    const orig = window.confirm;
    window.confirm = () => true;   // undoFixtureImport 走原生 confirm，E2E 里必须打桩
    await window.undoFixtureImport(${JSON.stringify(impBatch)});
    window.confirm = orig;
    for (let i = 0; i < 40; i++) { await sleep(100); if ($('#modalOverlay').hidden) break; }
    await sleep(600);
    return { toast: (($('#toast') || {}).textContent || '') };
  })()`);
  await sleep(400);
  const dbImpUndo = readDb();
  ok('撤销后夹具已移除', !dbImpUndo.fixtures.some((f) => f.serialNo === 'ZZ-IMP-001'));
  ok('撤销后自动补建的产线被回收', !dbImpUndo.lines.some((l) => l.name === 'E2E临时线'));
  ok('撤销后产线数量回到导入前',
    dbImpUndo.lines.length === dbImpBefore.lines.length,
    JSON.stringify({ lines: [dbImpBefore.lines.length, dbImpUndo.lines.length] }));
  ok('撤销提示写明回收了自动补建的产线', (impUndo.toast || '').includes('回收自动补建'), impUndo.toast);

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
  ok('清空只清业务数据：产线 / 机种字典（主数据）保留',
    (db12.lines || []).length === 2 && (db12.productions || []).length >= 4,
    [(db12.lines || []).length, (db12.productions || []).length]);
  ok('v5：清空后数据文件仍无 stations 集合', db12.stations === undefined, Object.keys(db12));
  ok('v5.1.0：清空数据保留人员卡库（主数据，3 人仍在）',
    (db12.staffs || []).length === 3, String((db12.staffs || []).length));
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

  /* ---------- 12.5 关于面板鸣谢区（v5.3.0） ---------- */
  section('12.5 关于 / About 面板（鸣谢区）');
  const aboutRes = await wc.executeJavaScript(`(async () => {
    ${HELPERS}
    const out = {};
    out.hasBtn = !!$('#aboutBtn');
    $('#aboutBtn').click(); await sleep(400);
    out.title = (($('#modalTitle')||{}).textContent||'');
    const txt = (($('#modalBody')||{}).textContent||'');
    out.hasChangelog = txt.includes('变更日记');
    out.hasThanksH = !!$('.about-h') && $$('.about-h').some(h=>h.textContent.trim()==='鸣谢');
    out.thanksCls = !!$('.about-thanks');
    out.thanksText = ($('.about-thanks')||{}).textContent||'';
    /* 6 位同事一个都不能少 */
    out.names = ['薛添才','朱近','林长平','林捷','林详杰','陈旭'].filter(n=>out.thanksText.includes(n));
    out.missing = ['薛添才','朱近','林长平','林捷','林详杰','陈旭'].filter(n=>!out.thanksText.includes(n));
    /* 鸣谢必须在滚动区之外（滚到底也看得到） */
    const sc = $('.about-scroll'), th = $('.about-thanks');
    out.scrollBeforeThanks = !!(sc && th) && (sc.compareDocumentPosition(th) & Node.DOCUMENT_POSITION_FOLLOWING) > 0;
    out.thanksBg = th ? getComputedStyle(th).backgroundColor : '';
    out.version = (($('.about-version')||{}).textContent||'');
    window.closeModal && window.closeModal();
    return out;
  })()`);
  ok('右下角有「关于 / About」按钮', aboutRes.hasBtn === true);
  ok('点击后弹出标题为「关于 / About」', /关于/.test(aboutRes.title), aboutRes.title);
  ok('面板内含「变更日记」滚动区', aboutRes.hasChangelog === true);
  ok('鸣谢标题渲染为独立小节', aboutRes.hasThanksH === true);
  ok('鸣谢区使用 .about-thanks 样式（浅蓝底 + 描边）',
    aboutRes.thanksCls === true && aboutRes.thanksBg && aboutRes.thanksBg !== 'rgba(0, 0, 0, 0)' && aboutRes.thanksBg !== 'transparent',
    aboutRes.thanksBg);
  ok('鸣谢文案含「感谢以下同事提供的宝贵意见」', /感谢以下同事提供的宝贵意见/.test(aboutRes.thanksText), aboutRes.thanksText.slice(0, 80));
  ok('鸣谢名单 6 位同事全部渲染（薛添才、朱近、林长平、林捷、林详杰、陈旭）',
    aboutRes.names.length === 6 && aboutRes.missing.length === 0,
    '命中 ' + aboutRes.names.length + ' 位，缺 ' + JSON.stringify(aboutRes.missing));
  ok('鸣谢区在变更日记滚动区之外（滚到底仍可见）', aboutRes.scrollBeforeThanks === true);
  ok('底部仍显示当前版本行', /当前版本：v/.test(aboutRes.version), aboutRes.version.slice(0, 60));

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
