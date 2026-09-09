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
const hRe = /'([a-zA-Z0-9_-]+)':\s*\(/g;
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
const ver = pkg.version.split('.').slice(0, 2).join('.');
ok('package.json 版本 = ' + ver, !!ver);
ok('db.js APP_VERSION = ' + ver, dbJs.indexOf("APP_VERSION = '" + ver + "'") >= 0,
  (dbJs.match(/APP_VERSION = '([^']+)'/) || [])[1]);
ok('index.html 标题含 v' + ver, html.indexOf('v' + ver) >= 0);
ok('main.js 窗口标题含 v' + ver, mainJs.indexOf('v' + ver) >= 0);
ok('preload.js 版本标记 = ' + ver, preloadJs.indexOf("version: '" + ver + "'") >= 0,
  (preloadJs.match(/version: '([^']+)'/) || [])[1]);
ok('package.json 描述含 v' + ver, pkg.description.indexOf('v' + ver) >= 0);
const an = (pkg.build && pkg.build.win && pkg.build.win.artifactName) || (pkg.build && pkg.build.artifactName) || '';
ok('artifactName 含 v' + ver, an.indexOf('v' + ver) >= 0, an);

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(50));
console.log('测试汇总：通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
console.log('='.repeat(50));
process.exit(fail > 0 ? 1 : 0);
