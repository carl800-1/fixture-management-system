'use strict';
/* ============================================================
 * test_render.js — 渲染层静态检查
 * 目标：揪出「点击报错 ReferenceError」类问题
 *  1. 抽取 app.js / index.html 中所有 onclick 引用的函数名
 *  2. 校验每个函数名都已作为 window.xxx 挂载
 *  3. 校验 app.js 调用的 DB.* 方法在 db.js 中均已实现
 *  4. 校验 IPC 通道在 main.js 中均有 handler
 * 运行：node test_render.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const appJs = fs.readFileSync(path.join(DIR, 'js/app.js'), 'utf8');
const dbJs = fs.readFileSync(path.join(DIR, 'js/db.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(DIR, 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(DIR, 'preload.js'), 'utf8');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  ❌ ' + name + (extra ? ' -> ' + extra : '')); }
}
function section(t) { console.log('\n【' + t + '】'); }

/* ---------- 1. onclick 函数挂载校验 ---------- */
section('1. 事件处理函数挂载校验');
const handlerNames = new Set();
// 匹配 onclick="fnName(" 和 onclick="event.stopPropagation(); fnName("
const re = /on(?:click|change|input|submit|keydown|keyup)\s*=\s*"([^"]*)"/g;
let m;
const sources = [['app.js', appJs], ['index.html', html]];
sources.forEach(([srcName, src]) => {
  re.lastIndex = 0;
  while ((m = re.exec(src))) {
    const expr = m[1];
    // 模板拼接函数名：onchange="${prefix}ToggleGroup(this)" —— 按已知前缀展开后校验
    const PREFIX_VALUES = { prefix: ['out', 'return'] };
    const tplRe = /\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}([A-Za-z0-9_$]+)\s*\(/g;
    let tm;
    while ((tm = tplRe.exec(expr))) {
      const vals = PREFIX_VALUES[tm[1]];
      if (vals) vals.forEach((p) => handlerNames.add(p + tm[2] + '|' + srcName));
    }
    const fnRe = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    let mm;
    while ((mm = fnRe.exec(expr))) {
      const fn = mm[1];
      // 模板拼接里只取到后半段（${prefix}ToggleGroup → ToggleGroup）的已单独展开，跳过
      if (expr.charAt(mm.index - 1) === '}') continue;
      // 排除内建/局部
      if (['event', 'this', 'if', 'return', 'alert', 'confirm', 'prompt', 'console', 'Number', 'String', 'parseInt', 'parseFloat', 'stopPropagation', 'preventDefault', 'target', 'value'].includes(fn)) continue;
      handlerNames.add(fn + '|' + srcName);
    }
  }
});

// 收集 app.js 中挂载到 window 的函数名
const mounted = new Set();
const mountRe = /window\.([A-Za-z0-9_$]+)\s*=/g;
while ((m = mountRe.exec(appJs))) mounted.add(m[1]);

const missing = [];
handlerNames.forEach((entry) => {
  const [fn, srcName] = entry.split('|');
  if (!mounted.has(fn)) missing.push(fn + '（引用于 ' + srcName + '）');
});
ok('所有 onclick 函数均已挂载 window', missing.length === 0, missing.join(', '));
console.log('     已挂载 window 函数 ' + mounted.size + ' 个，事件引用检查 ' + handlerNames.size + ' 处');

/* ---------- 2. DB 方法校验 ---------- */
section('2. 数据层方法调用校验');
const dbCalls = new Set();
const dbRe = /DB\.([A-Za-z0-9_$]+)\s*\(/g;
while ((m = dbRe.exec(appJs))) dbCalls.add(m[1]);

// db.js electron 分支 + browser 分支导出的方法名
const dbDefined = new Set();
const dbDefRe = /^\s{4,6}([A-Za-z0-9_$]+)\s*[:(]/gm;
while ((m = dbDefRe.exec(dbJs))) dbDefined.add(m[1]);
// 补上 return 对象里显式列出的
['open', 'getAll', 'get', 'add', 'put', 'del', 'clear', 'count', 'getMeta', 'setMeta',
  'fixtureAdd', 'fixtureUpdate', 'fixtureDel', 'fixtureGetAll', 'fixtureAddTransaction',
  'fixtureGetTransactions', 'currentBackend', 'APP_VERSION'].forEach((k) => dbDefined.add(k));

const dbMissing = [...dbCalls].filter((k) => !dbDefined.has(k));
ok('app.js 调用的 DB 方法均已实现', dbMissing.length === 0, dbMissing.join(', '));
console.log('     调用：' + [...dbCalls].join(', '));

/* ---------- 3. IPC 通道校验 ---------- */
section('3. IPC 通道校验');
const channels = new Set();
const chRe = /invoke\(\s*'([a-zA-Z0-9_-]+)'/g;
while ((m = chRe.exec(dbJs))) channels.add(m[1]);
const preloadChRe = /ipcRenderer\.invoke\(\s*'([a-zA-Z0-9_-]+)'/g;
while ((m = preloadChRe.exec(preloadJs))) channels.add(m[1]);

const handled = new Set();
// 允许 handler 写成 `'ch': (e, p) =>` 或 `'ch': async (e) =>` 等形式
const hRe = /['"]([a-zA-Z0-9_-]+)['"]:\s*(?:async\s*)?\(/g;
while ((m = hRe.exec(mainJs))) handled.add(m[1]);

const chMissing = [...channels].filter((c) => !handled.has(c));
ok('所有 IPC 通道均有主进程 handler', chMissing.length === 0, chMissing.join(', '));
console.log('     通道：' + [...channels].sort().join(', '));

/* ---------- 4. 状态常量一致性 ---------- */
section('4. 状态常量一致性');
const appStatuses = new Set();
const stRe = /'(stocked|checked_out|repair|retired)'/g;
while ((m = stRe.exec(appJs))) appStatuses.add(m[1]);
const storeStRe = /toStatus\s*=\s*'(stocked|checked_out|repair|retired)'/g;
const storeStatuses = new Set();
while ((m = storeStRe.exec(mainJs + fs.readFileSync(path.join(DIR, 'store.js'), 'utf8')))) storeStatuses.add(m[1]);

const storeJs = fs.readFileSync(path.join(DIR, 'store.js'), 'utf8');
['stocked', 'checked_out', 'repair', 'retired'].forEach((s) => {
  ok('状态 ' + s + ' 在 store.js 中已处理', storeJs.indexOf("'" + s + "'") >= 0);
});
ok('app.js 与数据层状态集一致', [...appStatuses].every((s) => storeJs.indexOf("'" + s + "'") >= 0),
  [...appStatuses].join(','));

/* ---------- 5. 二维码解析 ---------- */
section('5. 二维码令牌解析（执行 app.js 真实源码）');
/* 抽取 app.js 中 parseQRToken 的真实函数体并执行，确保测试与实现不脱节 */
const pqtBody = appJs.match(/function parseQRToken\s*\([^)]*\)\s*\{[\s\S]*?\n {2}\};/);
ok('app.js 中存在 parseQRToken 实现', !!pqtBody);
let parseQRToken = null;
if (pqtBody) {
  try {
    parseQRToken = new Function(pqtBody[0] + '; return parseQRToken;')();
    ok('parseQRToken 可独立执行', typeof parseQRToken === 'function');
  } catch (e) {
    ok('parseQRToken 可独立执行', false, e.message);
  }
}
if (parseQRToken) {
  const cases = [
    ['SPMS1|2001', '2001'],
    ['SPMS|2001', '2001'],
    ['spms1|2001', '2001'],
    ['SPMS1 | 2001', '2001'],
    ['  SPMS1|2001  ', '2001'],
    ['2001', '2001'],
    ['20-01', '2001'],
    ['', null],
    ['ABCD|2001', null],
    ['SPMS1|ABC', null]
  ];
  cases.forEach(([input, expect]) => {
    let got;
    try { got = parseQRToken(input); } catch (e) { got = 'THROW:' + e.message; }
    ok('parseQRToken(' + JSON.stringify(input) + ') = ' + JSON.stringify(expect), got === expect, '实际 ' + JSON.stringify(got));
  });
}

/* ---------- 6. HTML 资源引用 ---------- */
section('6. 静态资源引用');
const refRe = /(?:src|href)\s*=\s*"([^"]+)"/g;
const refs = [];
while ((m = refRe.exec(html))) refs.push(m[1]);
const badRefs = refs.filter((r) => {
  if (/^(https?:|data:|#|javascript:)/.test(r)) return false;
  return !fs.existsSync(path.join(DIR, r));
});
ok('HTML 引用的本地资源全部存在', badRefs.length === 0, badRefs.join(', '));
console.log('     引用：' + refs.join(', '));

/* ---------- 7. 导航视图与渲染函数对应 ---------- */
section('7. 导航视图与渲染函数对应');
const views = [];
const viewRe = /data-view="([a-zA-Z0-9_-]+)"/g;
while ((m = viewRe.exec(html))) views.push(m[1]);
/* 从 app.js 的 RENDERERS 映射自动推导（勿硬编码：新增视图时此处无需改动） */
const renderersSrc = (appJs.match(/const RENDERERS = \{([\s\S]*?)\};/) || ['', ''])[1];
const viewMap = {};
const rRe = /([a-zA-Z0-9_-]+)\s*:\s*(render[A-Za-z0-9_]*)/g;
let rm = null;
while ((rm = rRe.exec(renderersSrc))) viewMap[rm[1]] = rm[2];
ok('从 app.js 解析到 RENDERERS 映射（' + Object.keys(viewMap).length + ' 项）', Object.keys(viewMap).length > 0);
views.forEach((v) => {
  const fn = viewMap[v];
  if (fn) ok('视图 ' + v + ' -> ' + fn + ' 已定义', appJs.indexOf('function ' + fn) >= 0);
  else ok('视图 ' + v + ' 有对应渲染函数', false, '未找到映射');
});

/* ---------- 8. 版本号一致性 ---------- */
section('8. 版本号一致性');
const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
// 语义化版本（主版本号.次版本号.修订号），全量比对，三处必须完全一致
const ver = pkg.version;
ok('package.json 版本为语义化三段式 x.y.z', /^\d+\.\d+\.\d+$/.test(ver), ver);
ok('package.json 版本 = ' + ver, !!ver);
ok('db.js APP_VERSION = ' + ver, dbJs.indexOf("APP_VERSION = '" + ver + "'") >= 0,
  (dbJs.match(/APP_VERSION = '([^']+)'/) || [])[1]);
ok('侧边栏 footer 显示版本号', html.indexOf('v' + ver) >= 0, '侧边栏含 ' + ver),
ok('侧边栏 footer 含品牌名', html.indexOf('工装夹具管理程序') >= 0, 'brand-name 干净');
ok('main.js 窗口标题含 v' + ver, mainJs.indexOf('v' + ver) >= 0);
ok('preload.js 版本标记 = ' + ver, preloadJs.indexOf("version: '" + ver + "'") >= 0,
  (preloadJs.match(/version: '([^']+)'/) || [])[1]);
ok('package.json 描述含 v' + ver, pkg.description.indexOf('v' + ver) >= 0);
const an = (pkg.build && pkg.build.win && pkg.build.win.artifactName) || (pkg.build && pkg.build.artifactName) || '';
ok('artifactName 含 v' + ver, an.indexOf('v' + ver) >= 0, an);

/* ---------- 9. 显示层表格列序：序号 排在 夹具编号 之前 ---------- */
section('9. 显示层表格列序（序号 → 夹具编号）');
/* 显示层表格都应有「序号」表头：
 *   夹具列表 / 库位明细 / 查询结果 / 产线使用 / 产线夹具清单打印页（v5.1.0 新增）= 5 */
const seqThCount = (appJs.match(/<th[^>]*>序号<\/th>/g) || []).length;
ok('5 个表格含「序号」表头（v5.1.0 增加产线清单打印页）', seqThCount === 5, String(seqThCount));
/* 表头不得再出现「夹具编号 … 序号」的旧列序 */
const badHead = (appJs.match(/<th[^>]*>夹具编号<\/th>\s*<th[^>]*>序号<\/th>/g) || []).length;
ok('表头无「夹具编号 在前、序号 在后」的旧列序', badHead === 0, String(badHead));
/* 查询结果表：序号 在 可排序的「夹具编号」之前 */
const qHeadOk = (appJs.match(/<th style="width:64px">序号<\/th>\$\{thSort\('serial', '夹具编号'\)\}/g) || []).length;
ok('夹具查询结果表：序号 排在 夹具编号 之前', qHeadOk === 1, String(qHeadOk));
/* 单行两单元格的数据行：序号 在前 */
const badRow = (appJs.match(/^[ \t]*<td>\$\{esc\(f\.serialNo \|\| '—'\)\}<\/td><td class="muted">\$\{esc\(f\.code\)\}<\/td>/gm) || []).length;
ok('数据行无「夹具编号 在前、序号 在后」', badRow === 0, String(badRow));
const goodRow = (appJs.match(/^[ \t]*<td class="muted">\$\{esc\(f\.code\)\}<\/td>/gm) || []).length;
ok('数据行「序号 在前」共 4 处（2 单行 + 2 跨行）', goodRow === 4, String(goodRow));
/* CSV 导出列序（v4.5.0：夹具清单导出与「下载模板」共用 FIX_IMPORT_HEADERS，22 列同构） */
const expStart = appJs.indexOf('window.fixtureExportCSV = async function');
const expEnd = appJs.indexOf('* 夹具批量导入', expStart);
const exportSrc = appJs.slice(expStart, expEnd > expStart ? expEnd : expStart + 4000);
ok('夹具清单导出使用与模板共用的 FIX_IMPORT_HEADERS',
  /const headers = FIX_IMPORT_HEADERS\.slice\(\)/.test(exportSrc));
ok('夹具清单导出不再输出模板外的「序号 / 状态 / 累计出库 / 累计回库 / 维修次数」列',
  !/累计出库|累计回库|维修次数|'状态'/.test(exportSrc), exportSrc.slice(0, 200));
ok('导出与模板共用 buildCsvText（BOM / 换行 / 转义一致）',
  /buildCsvText\(headers, rows\)/.test(exportSrc) && /buildCsvText\(FIX_IMPORT_HEADERS, sample\)/.test(appJs));
ok('导出按 MAX_LINE_MODELS 展开机种列（v5.4.0 为 12 列），不再合并成一格',
  /for \(let i = 0; i < MAX_LINE_MODELS; i\+\+\) models\.push/.test(exportSrc));

/* ---------- 9.5 机种管理（v4.5.0 合并按机种查询） ---------- */
section('9.5 机种管理：点机种名展开线体明细（v5.0.0 无工位）');
ok('机种名称渲染为可点击链接（prod-pick → prodPick）',
  appJs.includes('class="prod-pick"') && appJs.includes('window.prodPick = function'));
ok('明细用纯函数 buildProdDetailRows（机种 × 线体）', appJs.includes('function buildProdDetailRows('));
ok('明细面板渲染函数 prodDetailHtml 存在', appJs.includes('function prodDetailHtml('));
ok('buildProdDetailRows 调用签名已去 stations', appJs.includes('buildProdDetailRows(state.fixtures, state.lines, [name])'));
const detailStart = appJs.indexOf('function prodDetailHtml(name)');
const detailSrc = appJs.slice(detailStart, detailStart + 3000);
ok('明细表头含「夹具编号 / 名称 / 库位 / 状态」',
  detailSrc.includes('>夹具编号</th>') && detailSrc.includes('>名称</th>')
  && detailSrc.includes('>库位</th>') && detailSrc.includes('>状态</th>'));
ok('明细表已无「工位」列与「工位 N 个」汇总',
  !detailSrc.includes('>工位</th>') && !/工位 \$\{/.test(detailSrc));
ok('导航与视图表已移除 prodquery（按机种查询）',
  !html.includes('data-view="prodquery"') && !appJs.includes('prodquery: renderProdQuery'));
ok('保留旧视图名别名 prodquery → prod', appJs.includes("const VIEW_ALIAS = { prodquery: 'prod' }"));
ok('paintProduction 拆出纯渲染（点机种不重新读盘）',
  appJs.includes('function paintProduction()') && appJs.includes('paintProduction();'));

/* ---------- 10. 机种名称输入：输入框（草稿）+「添加」按钮 → 标签区 ---------- */
section('10. 机种名称输入（输入框 + 添加按钮 → 标签区）');
/* 控件存在、旧三件套控件已消失 */
ok('表单含输入框 #fix_lm_text', appJs.includes('id="fix_lm_text"'));
ok('输入框挂 datalist #fix_lm_list', appJs.includes('id="fix_lm_list"') && appJs.includes('list="fix_lm_list"'));
ok('输入框绑定草稿事件 fixFormDraftInput', appJs.includes('oninput="fixFormDraftInput()"'));
ok('输入框回车 = 添加（fixFormModelsKeydown）', appJs.includes('onkeydown="fixFormModelsKeydown(event)"'));
ok('存在「添加」按钮 #fix_lm_addbtn → fixFormModelsInput', appJs.includes('id="fix_lm_addbtn"') && appJs.includes('onclick="fixFormModelsInput()"'));
ok('挂载 window.fixFormModelsInput（提交入列）', appJs.includes('window.fixFormModelsInput = function'));
ok('挂载 window.fixFormDraftInput', appJs.includes('window.fixFormDraftInput = function'));
ok('挂载 window.fixFormModelsKeydown', appJs.includes('window.fixFormModelsKeydown = function'));
ok('旧控件「从机种字典选择」已移除', !appJs.includes('fix_lm_pick') && !appJs.includes('从机种字典选择'));
ok('旧控件「新增机种」已移除', !appJs.includes('fix_lm_new') && !appJs.includes('fixFormAddModelNew'));
ok('机种名称不再写死 / 分隔提示占位（改为按钮语义）', appJs.includes('点「添加」或按回车'));

/* 执行真实源码：抽取 MODEL_SEP + parseModelText 独立跑 */
const mmSep = appJs.match(/const MODEL_SEP = (\/[^\n]*\/);/);
const mmFn = appJs.match(/function parseModelText\s*\([^)]*\)\s*\{[\s\S]*?\n {2}\}/);
ok('app.js 中存在 MODEL_SEP 与 parseModelText 实现', !!mmSep && !!mmFn);
if (mmSep && mmFn) {
  let parseModelText = null;
  try {
    parseModelText = new Function('const MODEL_SEP = ' + mmSep[1] + ';\n' + mmFn[0] + '; return parseModelText;')();
    ok('parseModelText 可独立执行', typeof parseModelText === 'function');
  } catch (e) {
    ok('parseModelText 可独立执行', false, e.message);
  }
  if (parseModelText) {
    const cases = [
      ['', [], '/ 空串'],
      [null, [], '/ null'],
      ['A', ['A'], '/ 单个'],
      ['A / B', ['A', 'B'], '/ 斜杠分隔'],
      ['A/B', ['A', 'B'], '/ 无空格斜杠'],
      ['A、B，C；D;E', ['A', 'B', 'C', 'D', 'E'], '/ 中英文分隔符混用'],
      ['A / A / B', ['A', 'B'], '/ 去重'],
      ['  A  /  B  ', ['A', 'B'], '/ 两端空白'],
      ['A /  / B', ['A', 'B'], '/ 空段落'],
      ['DH40MC / DH50MC', ['DH40MC', 'DH50MC'], '/ 真实机种名']
    ];
    cases.forEach(([input, expect, tag]) => {
      let got;
      try { got = JSON.stringify(parseModelText(input)); } catch (e) { got = 'THROW:' + e.message; }
      ok('parseModelText(' + JSON.stringify(input) + ') ' + tag, got === JSON.stringify(expect), '实际 ' + got);
    });
  }
}

/* ---------- 10b. 「添加」语义：并入标签区 + 清空草稿（真实函数在 DOM 桩上跑） ---------- */
section('10b. 添加按钮语义（草稿 → 标签区，去重/截断/清空）');
{
  const maxLm = (appJs.match(/const MAX_LINE_MODELS = (\d+);/) || [])[1];
  const maxPn = (appJs.match(/const MAX_PROD_NAME = (\d+);/) || [])[1];
  const pnFn = appJs.match(/function isValidProductionName\s*\([^)]*\)\s*\{[\s\S]*?\n {2}\}/);
  const blk = appJs.match(/function syncLmAddBtn\s*\(\)[\s\S]*?window\.fixFormRemoveModel = function \(i\) \{[\s\S]*?\n {2}\};/);
  ok('可抽取 MAX_LINE_MODELS / MAX_PROD_NAME / isValidProductionName / 机种标签函数块',
    !!maxLm && !!maxPn && !!pnFn && !!blk && !!mmSep && !!mmFn);
  if (maxLm && maxPn && pnFn && blk && mmSep && mmFn) {
    const src = `
      const MAX_LINE_MODELS = ${maxLm};
      const MAX_PROD_NAME = ${maxPn};
      const MODEL_SEP = ${mmSep[1]};
      const window = {};
      ${mmFn[0]}
      ${pnFn[0]}
      const state = { fixForm: { lineModels: [] } };
      const els = {
        '#fix_lm_text':  { value: '', focus() { this.focused = (this.focused || 0) + 1; } },
        '#fix_lm_addbtn': { disabled: false, title: '' },
        '#fix_lm_chips': { innerHTML: '' },
        '#fix_lm_count': { textContent: '' },
        '#fix_lm_hint':  { textContent: '', className: '' }
      };
      const $ = (s) => (els[s] === undefined ? null : els[s]);
      const esc = (s) => String(s == null ? '' : s);
      ${blk[0]}
      renderLineModelChips();   /* 模拟 openFixForm 打开表单后的首次渲染 */
      return { state, els, api: window, render: renderLineModelChips, cnt: () => els['#fix_lm_count'].textContent, hint: () => els['#fix_lm_hint'].textContent };
    `;
    let H = null;
    try { H = new Function(src)(); ok('机种标签函数块可独立执行', !!H, ''); }
    catch (e) { ok('机种标签函数块可独立执行', false, e.message); }
    if (H) {
      const inp = H.els['#fix_lm_text'];
      const btn = H.els['#fix_lm_addbtn'];
      const add = (text) => { inp.value = text; H.api.fixFormModelsInput(); };
      ok('初始：标签区为空、计数 0/7', H.state.fixForm.lineModels.length === 0 && H.cnt() === '0 / ' + maxLm);
      ok('空草稿时「添加」按钮禁用', btn.disabled === true);
      inp.value = 'WR22SE'; H.api.fixFormDraftInput();
      ok('草稿有内容 →「添加」按钮可用', btn.disabled === false);
      add('WR22SE');
      ok('点添加：入列 1 个', JSON.stringify(H.state.fixForm.lineModels) === JSON.stringify(['WR22SE']), JSON.stringify(H.state.fixForm.lineModels));
      ok('点添加后草稿被清空', inp.value === '');
      ok('点添加后计数 1/7', H.cnt() === '1 / ' + maxLm, H.cnt());
      ok('点添加后标签区渲染出 chip', /WR22SE/.test(H.els['#fix_lm_chips'].innerHTML));
      ok('点添加后草稿清空 →「添加」按钮回到禁用', btn.disabled === true);
      add('A / B');
      ok('一次用 / 加入多个', JSON.stringify(H.state.fixForm.lineModels) === JSON.stringify(['WR22SE', 'A', 'B']), JSON.stringify(H.state.fixForm.lineModels));
      add('A');
      ok('重复项不再入列（去重）', H.state.fixForm.lineModels.length === 3);
      ok('重复项给出提示', /已在列表中/.test(H.hint()), H.hint());
      /* 一次塞满并越过上限：数量随 MAX_LINE_MODELS 自动生成，改上限不用手改这里 */
      const filler = [];
      for (let i = 0; i < Number(maxLm) + 3; i++) filler.push('FILL' + i);
      add(filler.join(' / '));
      ok('超过上限截断到 ' + maxLm + ' 个', H.state.fixForm.lineModels.length === Number(maxLm), String(H.state.fixForm.lineModels.length));
      ok('超上限给出提示', /超过/.test(H.hint()), H.hint());
      ok('满员时「添加」按钮禁用', btn.disabled === true);
      H.api.fixFormRemoveModel(0);
      ok('点 × 移除首个（' + maxLm + ' → ' + (maxLm - 1) + '）', H.state.fixForm.lineModels.length === Number(maxLm) - 1, String(H.state.fixForm.lineModels.length));
      ok('移除后「添加」按钮恢复可用（未满）', btn.disabled === false || inp.value.trim() === '');
      /* 回车 = 添加 */
      inp.value = '回车机种'; H.api.fixFormModelsKeydown({ key: 'Enter', preventDefault() { H._prevented = true; } });
      ok('回车提交草稿入列', H.state.fixForm.lineModels.includes('回车机种'), JSON.stringify(H.state.fixForm.lineModels));
      ok('回车调用 preventDefault（不触发外层表单）', H._prevented === true);
      inp.value = '回车机种'; H._prevented = false; H.api.fixFormModelsKeydown({ key: 'a' });
      ok('非回车键不入列', H._prevented === false && inp.value === '回车机种');
      /* 非法名称 */
      H.state.fixForm.lineModels.length = 0;
      add('BAD|NAME');
      ok('非法名称（含 |）被忽略', H.state.fixForm.lineModels.length === 0, JSON.stringify(H.state.fixForm.lineModels));
      ok('非法名称给出提示', /已忽略不合法名称/.test(H.hint()), H.hint());
      add('  OK1  ');
      ok('合法名称入列（两端空白已去）', JSON.stringify(H.state.fixForm.lineModels) === JSON.stringify(['OK1']), JSON.stringify(H.state.fixForm.lineModels));
    }
  }
}

/* ---------- 10c. 关联产线：下拉 +「添加」→ 标签区（真实函数在 DOM 桩上跑） ---------- */
section('10c. 关联产线（产线下拉 → 标签区，v5.0.0 已无工位）');
{
  const mxLn = (appJs.match(/const MAX_LINES = (\d+);/) || [])[1];
  const lsBlk = appJs.match(/let lsPick = \{ lineId: 0 \};[\s\S]*?window\.fixFormRemoveLine = function \(i\) \{[\s\S]*?\n {2}\};/);
  ok('可抽取关联产线函数块（lsPick → fixFormRemoveLine）', !!lsBlk && !!mxLn);
  ok('表单容器 #fix_ls_box 仍在', appJs.includes('id="fix_ls_box"'));
  ok('产线下拉（onchange=fixFormLinePicked）',
    appJs.includes('id="fix_line_pick"') && appJs.includes('onchange="fixFormLinePicked()"'));
  ok('「+ 添加」按钮（onclick=fixFormAddLine）',
    appJs.includes('id="fix_ls_addbtn"') && appJs.includes('onclick="fixFormAddLine()"'));
  ok('表单标签改为「关联产线（≥1 条 · ≤5 条）」',
    appJs.includes('关联产线 <span class="req">*</span>（≥1 条 · ≤'));
  ok('工位控件已彻底移除（fix_st_pick / fixFormStationPicked / fixFormAddStation）',
    !appJs.includes('fix_st_pick') && !appJs.includes('fixFormStationPicked') && !appJs.includes('fixFormAddStation'));
  ok('工位函数已彻底移除（fixFormRemoveStation / stationsOfLineInForm / fixFormToggleStation）',
    !appJs.includes('fixFormRemoveStation') && !appJs.includes('stationsOfLineInForm') && !appJs.includes('fixFormToggleStation'));
  ok('旧折叠扇区彻底移除（ls-sec / ls-st / lsExpanded）',
    !appJs.includes('ls-sec') && !appJs.includes('ls-st') && !appJs.includes('lsExpanded'));

  if (lsBlk && mxLn) {
    const src = `
      const MAX_LINES = ${mxLn};
      const window = {};
      const toasts = [];
      const toast = (m, t) => toasts.push(String(t || '') + ':' + String(m));
      const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const natCompare = (a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN');
      const state = {
        lines: [
          { id: 1, name: '1号线', type: 'linear' }, { id: 2, name: '2号线', type: 'linear' },
          { id: 3, name: '3号线', type: 'linear' }, { id: 4, name: '4号线', type: 'linear' },
          { id: 5, name: '5号线', type: 'linear' }, { id: 6, name: '6号线', type: 'linear' }
        ],
        fixForm: { editId: 0, lineModels: [], lines: [] }
      };
      const els = {
        '#fix_line_pick': { value: '', options: [] },
        '#fix_ls_addbtn': { disabled: true, title: '' },
        '#fix_ls_hint': { textContent: '', className: '' },
        '#fix_ls_count': { textContent: '' }
      };
      const parseOpts = (html) => {
        const list = [];
        const re = /<option value="([^"]*)"([^>]*)>([\\s\\S]*?)<\\/option>/g;
        let m;
        while ((m = re.exec(html))) list.push({ value: m[1], selected: /selected/.test(m[2]), text: m[3] });
        return list;
      };
      const box = {
        _h: '',
        get innerHTML() { return this._h; },
        set innerHTML(v) { this._h = v; syncFromHtml(v); }
      };
      els['#fix_ls_box'] = box;
      function syncFromHtml(html) {
        const lp = html.match(/<select id="fix_line_pick"[^>]*>([\\s\\S]*?)<\\/select>/);
        const ab = html.match(/<button[^>]*id="fix_ls_addbtn"[^>]*>/);
        const hm = html.match(/<small class="([^"]*)" id="fix_ls_hint">([\\s\\S]*?)<\\/small>/);
        const cm = html.match(/<span class="muted" id="fix_ls_count">([\\s\\S]*?)<\\/span>/);
        if (lp) {
          const o = parseOpts(lp[1]);
          const sel = o.find((x) => x.selected);
          els['#fix_line_pick'].value = sel ? sel.value : (o[0] ? o[0].value : '');
          els['#fix_line_pick'].options = o;
        }
        if (ab) els['#fix_ls_addbtn'].disabled = /disabled/.test(ab[0]);
        if (hm) { els['#fix_ls_hint'].className = hm[1]; els['#fix_ls_hint'].textContent = hm[2]; }
        if (cm) els['#fix_ls_count'].textContent = cm[1];
      }
      const $ = (s) => (els[s] === undefined ? null : els[s]);
      ${lsBlk[0]}
      renderLineSectors();   /* 模拟 openFixForm 打开表单后的首次渲染 */
      return {
        state, els, api: window, toasts,
        html: () => box.innerHTML,
        chips: () => (box.innerHTML.match(/<div id="fix_ls_chips"[^>]*>([\\s\\S]*?)<\\/div>/) || [])[1] || '',
        cnt: () => els['#fix_ls_count'].textContent,
        hint: () => els['#fix_ls_hint'].textContent,
        render: renderLineSectors
      };
    `;
    let H = null;
    try { H = new Function(src)(); ok('关联产线函数块可独立执行', !!H, ''); }
    catch (e) { ok('关联产线函数块可独立执行', false, e.message); }
    if (H) {
      const st = H.state;
      const pickLine = (lid) => { H.els['#fix_line_pick'].value = String(lid); H.api.fixFormLinePicked(); };
      ok('初始：0/5 条产线', /0 \/ 5 条产线/.test(H.cnt()), H.cnt());
      ok('初始：「+ 添加」禁用', H.els['#fix_ls_addbtn'].disabled === true);
      ok('产线下拉列出全部产线', /1号线/.test(H.html()) && /5号线/.test(H.html()) && /6号线/.test(H.html()));
      ok('初始：标签区提示「尚未选择产线」', /尚未选择产线/.test(H.chips()), H.chips());
      ok('初始：提示区为空', H.hint() === '');

      pickLine(1);
      ok('选产线后「+ 添加」可用', H.els['#fix_ls_addbtn'].disabled === false);
      H.api.fixFormAddLine();
      ok('添加成功：lines=[1]', JSON.stringify(st.fixForm.lines) === '[1]', JSON.stringify(st.fixForm.lines));
      ok('计数更新为 1/5 条产线', /1 \/ 5 条产线/.test(H.cnt()), H.cnt());
      ok('标签区渲染「1号线」', /1号线/.test(H.chips()), H.chips());
      ok('添加后「+ 添加」回到禁用（该产线已关联）', H.els['#fix_ls_addbtn'].disabled === true);
      ok('已关联产线在下拉中标注（已关联）', /1号线（已关联）/.test(H.html()), '');
      ok('添加成功无报警提示', H.hint() === '', H.hint());

      H.api.fixFormAddLine();
      ok('重复添加被拒', st.fixForm.lines.length === 1, JSON.stringify(st.fixForm.lines));
      ok('重复添加给出提示', /已在下方标签区中/.test(H.hint()), H.hint());
      ok('重复提示直接出现在重绘后的提示区（不被 innerHTML 冲掉）',
        /已在下方标签区中/.test(H.html()), '');

      ok('移除越界索引不抛异常（-1）', (() => { try { H.api.fixFormRemoveLine(-1); return true; } catch (e) { return false; } })());
      ok('移除越界索引不抛异常（99）', (() => { try { H.api.fixFormRemoveLine(99); return true; } catch (e) { return false; } })());
      ok('越界移除后数据未被破坏', JSON.stringify(st.fixForm.lines) === '[1]', JSON.stringify(st.fixForm.lines));

      /* 凑满 5 条产线 */
      [2, 3, 4, 5].forEach((lid) => { pickLine(lid); H.api.fixFormAddLine(); });
      ok('累加至产线上限（5 条）', st.fixForm.lines.length === Number(mxLn), JSON.stringify(st.fixForm.lines));
      ok('满员时提示已达上限', /已达产线上限/.test(H.html()), '');
      ok('满员时下拉不再列出新产线（6号线）', !/6号线/.test(H.html()), '');
      ok('满员时「+ 添加」置灰', H.els['#fix_ls_addbtn'].disabled === true);

      /* 逐个移除 */
      H.api.fixFormRemoveLine(0);
      ok('移除首个 → 剩 4 条', st.fixForm.lines.length === 4, JSON.stringify(st.fixForm.lines));
      while (st.fixForm.lines.length) H.api.fixFormRemoveLine(0);
      ok('移除最后一个 → 产线清空、计数归零',
        st.fixForm.lines.length === 0 && /0 \/ 5 条产线/.test(H.cnt()), H.cnt());
      ok('清空后标签区回到「尚未选择产线」', /尚未选择产线/.test(H.chips()), H.chips());
      ok('清空后下拉重新列出全部产线（6号线回来了）', /6号线/.test(H.html()), '');

      /* 无产线时的空态 */
      const st2 = H.state;
      st2.lines.length = 0;
      H.render();
      ok('无产线时给出「尚无产线」提示与去配置入口',
        /尚无产线/.test(H.html()) && /fixFormGotoLineCfg/.test(H.html()), '');
    }
  }
}

/* ---------- 11. 序号显示为纯数字（不加 # 前缀） ---------- */
section('11. 序号显示为纯数字（无 # 前缀）');
/* 显示层不得再出现 #1001 这类写法 */
const hashCode = (appJs.match(/#\$\{esc\((?:f|r)\.code\)\}/g) || []).length;
ok('显示模板无「#序号」写法', hashCode === 0, String(hashCode));
const hashConcat = (appJs.match(/'#'\s*\+\s*(?:f|r)\.code/g) || []).length;
ok("不再用『'#' + code』拼接序号", hashConcat === 0, String(hashConcat));
const hashTitle = (appJs.match(/序号 #/g) || []).length;
ok('文案无「序号 #」', hashTitle === 0, String(hashTitle));
/* 仍在的 '#' + 只应是站台 id 兜底与 DOM 选择器（$('#...')） */
const hashLeft = (appJs.match(/'#'\s*\+/g) || []).length;
const hashDomEles = (appJs.match(/\$\('#'\s*\+/g) || []).length;
ok("剩余的 '#' + 均为 DOM 选择器或工位 id 兜底", hashLeft - hashDomEles === 1, 'left=' + hashLeft + ' dom=' + hashDomEles);
/* ---------- 12. 二维码内容 = 纯序号（无 SPMS1| 前缀） ---------- */
section('12. 二维码内容为纯序号（无 SPMS1| 前缀）');
ok('已移除 QR_PREFIX 常量', !appJs.includes('QR_PREFIX'));
const mqtBody = appJs.match(/function makeQRToken\s*\([^)]*\)\s*\{[^\n]*\}/);
ok('app.js 中存在 makeQRToken 实现', !!mqtBody, mqtBody && mqtBody[0]);
if (mqtBody) {
  let makeQRToken = null;
  try {
    makeQRToken = new Function(mqtBody[0] + '; return makeQRToken;')();
    ok('makeQRToken 可独立执行', typeof makeQRToken === 'function');
  } catch (e) {
    ok('makeQRToken 可独立执行', false, e.message);
  }
  if (makeQRToken) {
    const tok = makeQRToken({ code: '1001' });
    ok('makeQRToken({code:"1001"}) = "1001"', tok === '1001', tok);
    ok('二维码内容不含 SPMS 前缀', !/SPMS/i.test(tok), tok);
    ok('二维码内容为纯 4 位数字', /^\d{4}$/.test(tok), tok);
    ok('空夹具返回空串', makeQRToken(null) === '', makeQRToken(null));
  }
}
/* 旧前缀仍能扫（保证已打印的旧标签继续可用） */
if (parseQRToken) {
  ok('旧标签 SPMS1|1001 仍可扫出 1001', parseQRToken('SPMS1|1001') === '1001', parseQRToken('SPMS1|1001'));
  ok('新标签纯数字 1001 可扫', parseQRToken('1001') === '1001', parseQRToken('1001'));
}

/* ---------- 13. 夹具卡片：产线/工位合并一行 + 操作按钮同排 ---------- */
section('13. 卡片布局（产线一行、5 个按钮同排）');
ok('卡片不再有独立的「产线：」行', !appJs.includes('<div class="fixture-spec">产线：${'));
ok('卡片不再有独立的「工位：」行', !appJs.includes('<div class="fixture-spec">工位：${'));

ok('卡片「产线：」行单行省略（fixture-ls）', appJs.includes('class="fixture-spec fixture-ls"'));

const mNamesOf = appJs.match(/function lineNamesOf\(f\)\s*\{[\s\S]*?\n  \}/);
const mNamesLbl = appJs.match(/function lineNamesLabel\(f, emptyMark = '—'\)\s*\{[\s\S]*?\n  \}/);
const mExpNames = appJs.match(/function fixtureLineNamesForExport\(f\)\s*\{[\s\S]*?\n  \}/);
ok('app.js 中存在 lineNamesOf / lineNamesLabel / fixtureLineNamesForExport',
  !!mNamesOf && !!mNamesLbl && !!mExpNames);
ok('工位合并标签函数已彻底移除（lineStationPairsOf / lineStationLabel / stationNamesLabel）',
  !appJs.includes('function lineStationPairsOf(') && !appJs.includes('function lineStationLabel(')
  && !appJs.includes('function stationNamesLabel('));
if (mNamesOf && mNamesLbl && mExpNames) {
  let L = null;
  try {
    L = new Function(`
      const state = {
        lines: [{ id: 1, name: '1 号线' }, { id: 2, name: '2 号线' }, { id: 3, name: '3 号线' }]
      };
      ${mNamesOf[0]}
      ${mNamesLbl[0]}
      ${mExpNames[0]}
      return { lineNamesOf, lineNamesLabel, fixtureLineNamesForExport };
    `)();
    ok('产线名标签函数可独立执行', !!(L && L.lineNamesLabel));
  } catch (e) {
    ok('产线名标签函数可独立执行', false, e.message);
  }
  if (L) {
    const lbl = (f) => {
      try { return L.lineNamesLabel(f); } catch (e) { return 'THROW:' + e.message; }
    };
    ok('单产线 → 「1 号线」', lbl({ lines: [1] }) === '1 号线', lbl({ lines: [1] }));
    ok('多产线 → 用 / 连接', lbl({ lines: [1, 2] }) === '1 号线 / 2 号线', lbl({ lines: [1, 2] }));
    ok('顺序跟随 f.lines（2 号线在前）', lbl({ lines: [2, 1] }) === '2 号线 / 1 号线', lbl({ lines: [2, 1] }));
    ok('无产线 → 空标记 —', lbl({ lines: [] }) === '—', lbl({ lines: [] }));
    ok('空标记可自定义', L.lineNamesLabel({ lines: [] }, '') === '', L.lineNamesLabel({ lines: [] }, ''));
    ok('失效 id 被忽略（不出现 undefined）', lbl({ lines: [99] }) === '—', lbl({ lines: [99] }));
    ok('lineNamesOf 返回名称数组', JSON.stringify(L.lineNamesOf({ lines: [1, 2] })) === '["1 号线","2 号线"]',
      JSON.stringify(L.lineNamesOf({ lines: [1, 2] })));
    ok('导出用名称数组保留失效 id 为 #id（不丢信息）',
      JSON.stringify(L.fixtureLineNamesForExport({ lines: [1, 99] })) === '["1 号线","#99"]',
      JSON.stringify(L.fixtureLineNamesForExport({ lines: [1, 99] })));
    ok('导出用名称数组长度 = f.lines 长度（供产线1~5 列定位）',
      L.fixtureLineNamesForExport({ lines: [1, 2, 3] }).length === 3);
  }
}
/* 按钮同排：卡片操作按钮收紧内距 + 网格最小列宽抬到 240px */
const css = (function () {
  try { return require('fs').readFileSync(require('path').join(__dirname, 'css', 'style.css'), 'utf8'); } catch (e) { return ''; }
})();
ok('style.css 可读', css.length > 0, String(css.length));
ok('卡片操作按钮收紧内距（padding 3px 5px）',
  /\.fixture-card-footer \.btn\.sm\s*\{[^}]*padding:\s*3px 5px/.test(css));
ok('卡片操作按钮不换行（white-space: nowrap）',
  /\.fixture-card-footer \.btn\.sm\s*\{[^}]*white-space:\s*nowrap/.test(css));
ok('卡片网格最小列宽 240px（放得下 5 个按钮）',
  /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(240px,\s*1fr\)\)/.test(css), '');

/* 关联产线工具区：下拉 + 按钮 + 计数 一行排列（空间不足换行）+ 标签区空态边框 */
ok('.ls-toolbar 为 flex 一行布局', /\.ls-toolbar\s*\{[^}]*display:\s*flex/.test(css));
ok('ls-box 占满剩余宽度（flex: 1 1 auto）', /\.ls-box\s*\{[^}]*flex:\s*1 1 auto/.test(css));
ok('产线下拉自适应（flex: 0 1 auto，可收缩换行）', /\.ls-toolbar #fix_line_pick\s*\{[^}]*flex:\s*0 1 auto/.test(css));
ok('工位下拉样式已移除（#fix_st_pick）', !/#fix_st_pick/.test(css));
ok('「+ 添加」按钮固定不换行', /\.ls-toolbar \.btn\s*\{[^}]*white-space:\s*nowrap/.test(css));
ok('标签区空态有边框（.chip-box-empty）', /\.chip-box\.chip-box-empty/.test(css));
/* 横向表单组：关联产线区标签置顶、控件区占满剩余宽度 */
ok('app.js 产线工位 form-group 带 form-group-row 类', appJs.includes('form-group-row'));
ok('.form-group-row 为横向 flex（标签不独占一行）', /\.form-group\.form-group-row\s*\{[^}]*display:\s*flex/.test(css));
ok('.form-group-row > :not(label) 占满剩余宽度', /\.form-group\.form-group-row > :not\(label\)\s*\{[^}]*flex:\s*1 1 340px/.test(css));

/* ---------- 14. 出库原因 / 维修次数：查询区与结果表、详情、列表、CSV ---------- */
section('14. 出库原因与维修次数（查询选项 + 展示）');
ok('查询筛选区含「出库原因」下拉（#q_out_reason）',
  appJs.includes('id="q_out_reason"') && appJs.includes('onchange="queryApply()"') && appJs.includes('q.outReason'));
ok('出库原因选项含「全部 / 使用 / 维修」',
  /<option value="">全部<\/option>/.test(appJs) && appJs.includes('value="use"') && appJs.includes('value="repair"'));
ok('sortOpt 含 repair（维修次数排序）',
  appJs.includes("sortOpt('repair')") && appJs.includes("sb === 'repair'"));
ok('查询结果表含「维修次数」列',
  appJs.includes("thSort('repair', '维修次数')") && appJs.includes("f.repairCount || 0"));
ok('详情弹窗「累计出库 / 回库 / 维修」显示 repairCount',
  appJs.includes("' / ' + (f.repairCount || 0))") || appJs.includes("+ ' / ' + (f.repairCount || 0)"));
ok('手工盘点 CSV 表头含「维修次数」',
  appJs.includes("'累计出库', '累计回库', '维修次数'"));
ok('state.query 初始化含 outReason 字段',
  appJs.includes("outReason: ''") && appJs.includes("statuses: [], sortBy: 'code', sortDir: 'asc', outReason: ''"));
ok('queryReset 保留 outReason 字段',
  appJs.includes("queryReset = function () {") && /state\.query = \{[^}]*outReason: ''/.test(appJs));
ok('queryApply 读取 #q_out_reason',
  appJs.includes("q.outReason = ($('#q_out_reason') || {}).value || ''"));
ok('fixtureOut 弹窗含出库原因下拉（#fix_out_reason）',
  appJs.includes('id="fix_out_reason"') && appJs.includes("reasonEl && reasonEl.value === 'repair' ? 'repair' : 'use'"));
ok('submitFixtureOut 传递 outReason 给 DB.fixtureAddTransaction',
  appJs.includes("location: location || undefined, outReason"));

/* 动态：抽取 fixtureHasOutReason 独立跑（真实函数 + DOM 桩 state） */
{
  const fnBody = appJs.match(/function fixtureHasOutReason\(f, reason\)\s*\{[\s\S]*?\n {2}\}\n/);
  ok('可抽取 fixtureHasOutReason 实现', !!fnBody);
  if (fnBody) {
      const src = `
      const state = {
        fixTransactions: [
          { fixtureId: 1, type: 'out', outReason: 'use' },
          { fixtureId: 1, type: 'out', outReason: 'repair' },
          { fixtureId: 2, type: 'out', outReason: 'repair' },
          { fixtureId: 3, type: 'out', outReason: '' },
          { fixtureId: 4, type: 'repair' },
          { fixtureId: 5, type: 'out' },
          { fixtureId: 6, type: 'out', outReason: 'use' }
        ]
      };
      ${fnBody[0]}
      return fixtureHasOutReason;
    `;
    let fn = null;
    try { fn = new Function(src)(); ok('fixtureHasOutReason 可独立执行', typeof fn === 'function'); }
    catch (e) { ok('fixtureHasOutReason 可独立执行', false, e.message); }
    if (fn) {
      ok('夹具 1：维修原因命中（out repair + outReason repair）', fn({ id: 1 }, 'repair') === true);
      ok('夹具 1：使用原因命中（outReason use）', fn({ id: 1 }, 'use') === true);
      ok('夹具 2：维修原因命中（仅 out repair）', fn({ id: 2 }, 'repair') === true);
      ok('夹具 2：使用原因不命中', fn({ id: 2 }, 'use') === false);
      ok('夹具 3：缺省 outReason 视为使用', fn({ id: 3 }, 'use') === true);
      ok('夹具 4：「送修」流水计入维修', fn({ id: 4 }, 'repair') === true);
      ok('夹具 4：「送修」不计入使用', fn({ id: 4 }, 'use') === false);
      ok('夹具 5：无 outReason 旧流水按使用处理（outReason 缺失 = undefined，归为使用）', fn({ id: 5 }, 'use') === true, '实际 ' + fn({ id: 5 }, 'use'));
      ok('夹具 5：无 outReason 旧流水不命中维修', fn({ id: 5 }, 'repair') === false);
      ok('未知原因不过滤', fn({ id: 1 }, 'unknown') === true);
    }
  }
}

/* ---------- 15. 删除夹具入口 ---------- */
section('15. 删除夹具入口（录错纠正）');
ok('window.fixtureDelete / fixtureDeleteConfirm 均已挂载',
  mounted.has('fixtureDelete') && mounted.has('fixtureDeleteConfirm'));
ok('删除入口调用 DB.fixtureDel', appJs.includes('await DB.fixtureDel(id)'));
ok('卡片视图含删除按钮', /fixtureDelete\(\$\{f\.id\}\)">删除</.test(appJs));
ok('列表视图含删除按钮', (appJs.match(/fixtureDelete\(\$\{f\.id\}\)">删除</g) || []).length >= 2);
ok('查询结果与详情弹窗含删除入口', appJs.includes('🗑 删除该夹具'));
ok('删除确认弹窗说明「不可恢复」并引导改用报废',
  appJs.includes('删除后<b>不可恢复</b>') && appJs.includes('请改用「报废」保留记录'));
ok('删除确认弹窗展示关联流水条数', appJs.includes('（将一并删除）') && appJs.includes('（无流水）'));
ok('已出库 / 维修中状态给额外警告',
  appJs.includes('已出库未回库') && appJs.includes('处于维修中'));
ok('删除后清理选中态', appJs.includes('if (state.fixSelectedId === id) state.fixSelectedId = 0'));
ok('查询页删除后就地重跑查询（不切回夹具管理）',
  appJs.includes("if ($('#query_results')) renderQueryResults(applyQueryFilters(state.query));"));
ok('报废按钮不再使用未定义的 btn-danger 类',
  !appJs.includes('btn-danger') && /class="btn sm" onclick="event\.stopPropagation\(\); fixtureRetire/.test(appJs));

/* ---------- 16. 导入幂等与撤销（v4.4.0） ---------- */
section('16. 导入幂等与撤销本次导入');
ok('导入查重签名函数存在（_sigOfNames / _sigOfFixture）',
  appJs.includes('function _sigOfNames(') && appJs.includes('function _sigOfFixture('));
ok('buildImportPlan 计算重复行数 _dupCount',
  appJs.includes('plan._dupCount = plan.filter((p) => p.isDup).length'));
ok('预览提供「跳过重复」按钮（默认口径）',
  appJs.includes("confirmImportPlan('skip')") && appJs.includes('跳过重复，导入'));
ok('预览提供「全部导入」按钮',
  appJs.includes("confirmImportPlan('all')") && appJs.includes('全部导入'));
ok('预览列出重复统计横幅', appJs.includes('行与库内已有记录<b>完全一致</b>'));
ok('预览表格有「状态」列且区分重复/新增',
  appJs.includes('<th>状态</th>') && appJs.includes("'<span class=\"badge warn\">重复</span>'"));
ok('落库写入 importBatch 批次号', appJs.includes('importBatch: batchId'));
ok('导入结果弹窗提供「撤销本次导入」', appJs.includes('undoFixtureImport(') && appJs.includes('↩ 撤销本次导入'));
ok('撤销按批次过滤（只删这一批）',
  appJs.includes("state.fixtures.filter((f) => f.importBatch === batchId)"));
ok('整份表全部被拒时给出原因明细（BUG-007）',
  appJs.includes('function showImportFailure(') && appJs.includes('行被跳过'));
ok('confirmImportPlan 默认跳过重复（mode !== \'all\'）',
  appJs.includes("const skipDup = mode !== 'all';"));

/* ---------- 17. 产线名归并与撤销回收（v4.5.1） ---------- */
section('17. 产线名归并 / 撤销回收结构项（v5.0.0：只回收产线）');
ok('存在产线名归一化函数 normalizeLineName',
  appJs.includes('function normalizeLineName('));
ok('归一化去掉 # 与空白（1# → 1）',
  appJs.includes('/[#＃\\s]+/g'));
ok('buildImportPlan 内建立归一化别名表 normToLine',
  appJs.includes('const normToLine = new Map();'));
ok('buildImportPlan 输出归并提示 plan._lineHints',
  appJs.includes('plan._lineHints = Array.from(lineHints.entries())'));
ok('预览顶部展示自动归并横幅',
  appJs.includes('已自动归并<b>同名产线</b>'));
ok('confirmImportPlan 只记录本批新建的产线 id',
  appJs.includes('const createdLineIds = [];') && !appJs.includes('const createdStationIds = [];'));
ok('本批新建产线挂在 __importCreatedByBatch（无 stationIds）',
  appJs.includes('window.__importCreatedByBatch[batchId] = { lineIds: createdLineIds.slice() }'));
ok('存在结构回收纯函数 planStructureRecycle（只回收产线）',
  appJs.includes('function planStructureRecycle(created, fixtures)'));
ok('撤销导入调用结构回收（BUG-011）',
  appJs.includes('planStructureRecycle(created, state.fixtures || [])'));
ok('撤销结果提示回收数量',
  appJs.includes('并回收自动补建的'));
ok('夹具导入模板 22 列（机种 12 列、无工位列）',
  appJs.includes("'夹具编号', '名称',") && !/'工位1'/.test(appJs) && !/'工位顺序'/.test(appJs));
ok('模板列由上限常量生成（改 MAX_LINE_MODELS 无需手改表头/示例行）',
  /\.\.\.Array\.from\(\{ length: MAX_LINE_MODELS \}, \(_, i\) => '机种名称' \+ \(i \+ 1\)\)/.test(appJs)
  && /\.\.\.Array\.from\(\{ length: MAX_LINES \}, \(_, i\) => '产线' \+ \(i \+ 1\)\)/.test(appJs));
ok('模板示例行按表头位置生成（不再手写固定列数数组）',
  /const mkSample = \(o\) => \{/.test(appJs) && /FIX_IMPORT_HEADERS\.map\(\(\) => ''\)/.test(appJs));

/* 上限常量三处必须同源：app.js（渲染层）/ db.js（本地存储层）/ store.js（主进程层）改一处漏两处会直接不一致 */
{
  const dbSrc = fs.readFileSync(path.join(__dirname, 'js', 'db.js'), 'utf8');
  const storeSrc = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf8');
  const grab = (s) => (s.match(/const MAX_LINE_MODELS = (\d+);/) || [])[1];
  const a = grab(appJs), d = grab(dbSrc), st = grab(storeSrc);
  ok('MAX_LINE_MODELS 在 app.js / db.js / store.js 三处一致（v5.4.0 = 12）',
    a === '12' && d === '12' && st === '12', [a, d, st]);
}

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(50));
console.log('测试汇总：通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
console.log('='.repeat(50));
process.exit(fail > 0 ? 1 : 0);
