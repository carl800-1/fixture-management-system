'use strict';
/* ============================================================
 * test_e2e_import.js — 端到端验证：真实 xlsx 文件 → 解析 → 导入计划 → 落库
 *
 * 把 test_xlsx.js 的解析链路与 test_import.js 的映射链路串起来，
 * 用真实磁盘上的 .xlsx 走完整流程，最后真的写入 store 再读回校验。
 *
 * v4.0.0 变更：夹具导入表头 9 列 → 14 列（实物编号 / 名称 / 机种名称1~7 /
 *   分类 / 库位 / 产线 / 工位 / 备注）；`产线 / 工位` 为**必填**（建档强校验
 *   「至少 1 条产线 1 个工位」）；桥梁编号由 store 自动分配，导入不再处理编号；
 *   `qrToken` 改为派生值不再落库。
 *
 * 运行：node test_e2e_import.js
 *   （若缺少 test_fixture.xlsx，先运行：python test_make_xlsx.py test_fixture.xlsx）
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → 实际: ' + JSON.stringify(extra) : '')); }
}

const XLSX = path.join(__dirname, 'test_fixture.xlsx');
if (!fs.existsSync(XLSX)) {
  console.error('缺少 test_fixture.xlsx，请先运行：python test_make_xlsx.py test_fixture.xlsx');
  process.exit(1);
}

console.log('=== 端到端导入验证（真实 xlsx → 落库，v4.0.0） ===');

/* ---- 1. 解析真实 xlsx（走主进程同一份代码） ---- */
const { readWorkbook } = require('./js/xlsx_reader');
const wb = readWorkbook(fs.readFileSync(XLSX));
ok(wb.sheets.length === 2, '解析出 2 张工作表');
ok(wb.sheets[0].name === '夹具清单', '第 1 张表名为「夹具清单」', wb.sheets[0].name);
const xrows = wb.sheets[0].rows;
ok(xrows.length === 7, '第 1 张表 7 行（表头 + 5 条数据 + 1 全空行）', xrows.length);
ok(xrows[0].length === 14 && xrows[0][0] === '实物编号' && xrows[0][13] === '备注',
  '表头 14 列且首列为「实物编号」', [xrows[0].length, xrows[0][0], xrows[0][13]]);
ok(xrows[1].length === 14 && xrows[1][4] === '', '稀疏列（缺 <c> 节点）补为空串', xrows[1]);
ok(Array.isArray(xrows[6]) && xrows[6].length === 0, '全空行解析为空数组', xrows[6]);

/* ---- 2. 走 app.js 的导入映射（vm 沙箱抽取纯函数） ---- */
const src = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
function slice(startMark, endMark) {
  const s = src.indexOf(startMark);
  if (s < 0) throw new Error('切片起点未找到：' + startMark);
  const e = endMark ? src.indexOf(endMark, s + 1) : src.length;
  if (e < 0) throw new Error('切片终点未找到：' + endMark);
  return src.slice(s, e);
}
// parseCSV 定义在文件后段，单独取出（到下一个分节注释为止）
const csvSrc = slice('function parseCSV(text)', '/* ============================================================');
// 导入模块：业务上限常量 + 表头别名 + 解析/计划
const importSrc = slice('const FIX_IMPORT_HEADERS', '/* 导入入口');
const limitsSrc = slice('/* ---------------- 业务上限与格式约束', '/* 机种名称：展示 / 搜索 helpers */');
const modSrc = [limitsSrc, importSrc, csvSrc, ';__export = { buildImportPlan, parseCSV };'].join('\n');

const sandbox = {
  state: { fixtures: [], lines: [], stations: [], productions: [] },
  window: {},
  console,
  esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  openModal() {}, toast() {},
  Math, Number, String, Array, Object, JSON, Set, Map, Date, RegExp, Boolean, parseInt, parseFloat, isNaN, Infinity, NaN
};
vm.createContext(sandbox);
vm.runInContext(modSrc, sandbox);
const M = sandbox.__export;
if (!M) { console.error('模块导出失败'); process.exit(1); }

/* ---- 3. 生成导入计划 ---- */
console.log('\n[导入计划]');
sandbox.state.lines = [
  { id: 1, name: 'L1 总装线', type: 'linear' },
  { id: 2, name: 'L2 U型线', type: 'u' }
];
sandbox.state.stations = [
  { id: 11, lineId: 1, name: '上料工位', seq: 10 },
  { id: 12, lineId: 1, name: '压装工位', seq: 20 },
  { id: 21, lineId: 2, name: '上料工位', seq: 10 }
];
// 预置一套同实物编号的夹具 → 触发「重号提示」
sandbox.state.fixtures = [{ id: 99, code: '1001', serialNo: 'DH40MC-921-001-001', name: '已有夹具', status: 'stocked', lineModels: [], lines: [], stations: [] }];

const plan = M.buildImportPlan(xrows);
ok(plan.ok, '生成导入计划成功', plan.error);
ok(plan.plan.length === 3, '3 条有效行（行 2/3/4）', plan.plan.length);
ok(plan.skipped.length === 2, '2 条被跳过（库位非法 + 产线未建档）', plan.skipped);
ok(plan.skipped[0].row === 5 && /库位/.test(plan.skipped[0].reason), '第 5 行按库位非法跳过', plan.skipped[0]);
ok(plan.skipped[1].row === 6 && /幽灵线/.test(plan.skipped[1].reason), '第 6 行按产线未建档跳过', plan.skipped[1]);
ok(plan.skipped.every((s) => s.row !== 7), '全空行（第 7 行）不产生跳过记录（静默过滤）');
ok(plan.hasSerialColumn === true && plan.hasLineColumn === true && plan.hasStationColumn === true,
  'hasSerialColumn / hasLineColumn / hasStationColumn 均为 true', [plan.hasSerialColumn, plan.hasLineColumn, plan.hasStationColumn]);

const names = plan.plan.map((p) => p.fixture.name);
ok(JSON.stringify(names) === JSON.stringify(['定位销压板', '焊接夹具', '装配工装']),
  '三条夹具名称按顺序解析正确', names);

// 实物编号（主搜索键）不再处理「自动分配」，原样保留
ok(plan.plan[0].fixture.serialNo === 'DH40MC-921-001-001', '第 1 条实物编号原样保留', plan.plan[0].fixture.serialNo);
ok(plan.plan[1].fixture.serialNo === 'XXK-D10VG-002', '第 2 条实物编号原样保留', plan.plan[1].fixture.serialNo);
ok(plan.plan[0].fixture.code === undefined && plan.plan[0].autoCode === undefined,
  '导入计划不产桥梁编号（由 store 自动分配）', Object.keys(plan.plan[0]));

// 机种 / 分类 / 库位 / 产线 / 工位 / 备注
ok(JSON.stringify(plan.plan[0].fixture.lineModels) === JSON.stringify(['MODEL-A', 'MODEL-B']),
  '第 1 条机种 = [MODEL-A, MODEL-B]', plan.plan[0].fixture.lineModels);
ok(JSON.stringify(plan.plan[1].fixture.lineModels) === JSON.stringify(['MODEL-C']),
  '第 2 条机种 = [MODEL-C]（单机种 + 三个真空列）', plan.plan[1].fixture.lineModels);
ok(JSON.stringify(plan.plan[2].fixture.lineModels) === JSON.stringify(['MODEL-D', 'MODEL-E']),
  '第 3 条机种由单格斜杠分隔拆成两个', plan.plan[2].fixture.lineModels);
ok(plan.plan[0].fixture.category === '冲压', '第 1 条分类 = 冲压', plan.plan[0].fixture.category);
ok(plan.plan[0].fixture.location === 'ZP1-U-1-1', '第 1 条库位 = ZP1-U-1-1', plan.plan[0].fixture.location);
ok(plan.plan[0].fixture.remark === '用于冲压定位，含 & <特殊字符>',
  '第 1 条备注 XML 实体正确解码', plan.plan[0].fixture.remark);
ok(plan.plan[1].fixture.remark === 'inline 字符串备注', '第 2 条 inlineStr 备注', plan.plan[1].fixture.remark);
ok(plan.plan[2].fixture.category === '装配', '第 3 条分类 = 装配', plan.plan[2].fixture.category);
ok(JSON.stringify(plan.plan[0].fixture.lines) === JSON.stringify([1]), '第 1 条产线解析为 L1 的 id', plan.plan[0].fixture.lines);
ok(JSON.stringify(plan.plan[0].fixture.stations) === JSON.stringify([11]), '第 1 条工位解析为「上料工位」的 id', plan.plan[0].fixture.stations);
ok(JSON.stringify(plan.plan[1].fixture.stations) === JSON.stringify([12]), '第 2 条工位为「压装工位」', plan.plan[1].fixture.stations);
ok(JSON.stringify(plan.plan[2].fixture.lines) === JSON.stringify([1, 2]), '第 3 条多产线（逗号分隔）解析为 2 条', plan.plan[2].fixture.lines);
ok(JSON.stringify(plan.plan[2].fixture.stations) === JSON.stringify([11, 21]),
  '第 3 条「上料工位」跨产线重名，两条产线下的同名工位都命中', plan.plan[2].fixture.stations);

// 重号提示（实物编号允许重复，只提示不拦截）
ok(/已有 1 套/.test(plan.plan[0].dupHint), '第 1 条给出重号提示', plan.plan[0].dupHint);
ok(plan.plan[1].dupHint === '', '第 2 条无重号提示', plan.plan[1].dupHint);

// 缺列保护
const noLine = M.buildImportPlan([['实物编号', '名称', '库位', '工位'], ['S1', 'N', 'ZP1-U-1-1', 'W']]);
ok(noLine.ok === false && /模板缺少「产线」列/.test(noLine.error), '缺「产线」列 → 报错', noLine.error);
const noSt = M.buildImportPlan([['实物编号', '名称', '库位', '产线'], ['S1', 'N', 'ZP1-U-1-1', 'L']]);
ok(noSt.ok === false && /模板缺少「工位」列/.test(noSt.error), '缺「工位」列 → 报错', noSt.error);
const noSn = M.buildImportPlan([['名称', '库位', '产线', '工位'], ['N', 'ZP1-U-1-1', 'L', 'W']]);
ok(noSn.ok === false && /模板缺少「实物编号」列/.test(noSn.error), '缺「实物编号」列 → 报错', noSn.error);

/* ---- 4. 真正落库（临时目录，不污染真实数据） ---- */
console.log('\n[真实落库]');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fms-import-'));
const store = require('./store');
store.setDataDir(tmpDir);
store.open();

// 与沙箱 ctx 同名建立线体/工位
const lineIdByName = new Map();
lineIdByName.set('L1 总装线', store.add('lines', { name: 'L1 总装线', type: 'linear', remark: '' }));
lineIdByName.set('L2 U型线', store.add('lines', { name: 'L2 U型线', type: 'u', remark: '' }));
const stIdByKey = new Map();
[['上料工位', 'L1 总装线', 10], ['压装工位', 'L1 总装线', 20], ['上料工位', 'L2 U型线', 10]].forEach(([n, ln, seq]) => {
  stIdByKey.set(n + '\u0000' + ln, store.add('stations', { lineId: lineIdByName.get(ln), name: n, seq }));
});
// ctx id → 名称 的映射（计划里带的是沙箱 ctx 的 id）
const ctxLineName = new Map(sandbox.state.lines.map((l) => [l.id, l.name]));
const ctxStInfo = new Map(sandbox.state.stations.map((s) => [s.id, { name: s.name, lineName: ctxLineName.get(s.lineId) }]));

let added = 0;
for (const p of plan.plan) {
  const f = p.fixture;
  store.addFixture({
    serialNo: f.serialNo,
    name: f.name,
    lineModels: f.lineModels,
    category: f.category,
    location: f.location,
    remark: f.remark,
    lines: f.lines.map((id) => lineIdByName.get(ctxLineName.get(id))),
    stations: f.stations.map((id) => {
      const info = ctxStInfo.get(id);
      return stIdByKey.get(info.name + '\u0000' + info.lineName);
    })
  });
  added++;
}
ok(added === 3, '写入 3 条成功', added);

const all = store.getAll('fixtures');
ok(all.length === 3, '库中共 3 条', all.length);
ok(all.every((f) => /^\d{4}$/.test(String(f.code))), '桥梁编号由 store 自动分配为 4 位纯数字', all.map((f) => f.code));
ok(new Set(all.map((f) => String(f.code))).size === 3, '桥梁编号互不相同');

const bySerial = {};
all.forEach((f) => { bySerial[f.serialNo] = f; });
const f1 = bySerial['DH40MC-921-001-001'];
ok(!!f1 && f1.name === '定位销压板', '实物编号 DH40MC-921-001-001 落库正确', f1 && f1.name);
ok(!!f1 && f1.status === 'stocked', '初始状态 = 在库');
ok(!!f1 && f1.totalOutCount === 0 && f1.repairCount === 0, '统计字段已初始化');
ok(!!f1 && f1.lineModels.length === 2 && f1.lineModels[1] === 'MODEL-B', '机种数组正确落库', f1 && f1.lineModels);
ok(!!f1 && f1.lines.length === 1 && f1.stations.length === 1, '产线/工位已落库', f1 && [f1.lines, f1.stations]);
ok(!!f1 && f1.location === 'ZP1-U-1-1', '库位落库正确');
ok(!!f1 && f1.qrToken === undefined, 'qrToken 不再落库（改为渲染层派生值）', f1 && f1.qrToken);
ok(store.findFixtureByCode(f1.code) !== null, 'findFixtureByCode 能按桥梁编号反查');
ok(store.stockCountBySerial('DH40MC-921-001-001') === 1, '在库套数为派生值（1 套）', store.stockCountBySerial('DH40MC-921-001-001'));

const f3 = bySerial['DH40MC-921-001-002'];
ok(!!f3 && f3.lines.length === 2 && f3.stations.length === 2, '多产线多工位夹具落库正确', f3 && [f3.lines, f3.stations]);

// 落盘文件确实存在
ok(fs.existsSync(path.join(tmpDir, 'fixture-data.json')), '数据文件已写入磁盘');

/* ---- 5. 追加第二套同实物编号（多套追踪：数量为派生值） ---- */
console.log('\n[同编号多套 / 编号保护]');
store.addFixture({
  serialNo: 'DH40MC-921-001-001', name: '定位销压板', lineModels: ['MODEL-A'],
  category: '冲压', location: 'ZP1-U-1-9', remark: '',
  lines: [lineIdByName.get('L1 总装线')], stations: [stIdByKey.get('上料工位\u0000L1 总装线')]
});
ok(store.stockCountBySerial('DH40MC-921-001-001') === 2, '同实物编号再加一套 → 在库 2 套（派生值）', store.stockCountBySerial('DH40MC-921-001-001'));
ok(store.stockCountBySerial('DH40MC-921-001-001', 'ZP1-U-1-9') === 1, '按「实物编号 + 库位」分组计数 = 1', store.stockCountBySerial('DH40MC-921-001-001', 'ZP1-U-1-9'));

/* 重跑计划：应给出「已有 2 套」的重号提示 */
sandbox.state.fixtures = store.getAll('fixtures');
const planAgain = M.buildImportPlan(xrows);
ok(planAgain.ok && planAgain.plan.length === 3, '二次导入计划仍 3 条', planAgain.error);
ok(/已有 2 套/.test(planAgain.plan[0].dupHint), '二次导入重号提示更新为 2 套', planAgain.plan[0].dupHint);

/* 桥梁编号重复保护（store 层） */
let threw = false;
try {
  store.addFixture({
    code: f1.code, serialNo: 'OTHER-001', name: '重复编号', lineModels: ['X'],
    location: 'ZP1-U-1-5', lines: [lineIdByName.get('L1 总装线')], stations: [stIdByKey.get('上料工位\u0000L1 总装线')]
  });
} catch (e) { threw = /编号已存在/.test(e.message); }
ok(threw, '重复桥梁编号被 store 层拒绝并抛出「编号已存在」');

/* 建档强校验：无产线 / 无工位 直接拒绝 */
let noLineErr = null, noStErr = null;
try { store.addFixture({ serialNo: 'S-X', name: 'X', lineModels: ['M'], location: 'ZP1-U-1-6', lines: [], stations: [1] }); }
catch (e) { noLineErr = e.message; }
try { store.addFixture({ serialNo: 'S-Y', name: 'Y', lineModels: ['M'], location: 'ZP1-U-1-7', lines: [1], stations: [] }); }
catch (e) { noStErr = e.message; }
ok(/至少选择 1 条产线/.test(noLineErr || ''), '零产线建档被拒绝', noLineErr);
ok(/至少选择 1 个工位/.test(noStErr || ''), '零工位建档被拒绝', noStErr);

/* ---- 6. CSV 路径同样走通 ---- */
console.log('\n[CSV 路径]');
const csvText = '实物编号,名称,机种名称1,分类,库位,产线,工位,备注\r\n'
  + 'CSV-SN-001,CSV夹具A,MODEL-X,冲压,ZP1-U-1-8,L1 总装线,上料工位,csv导入\r\n'
  + 'CSV-SN-002,CSV夹具B,MODEL-Y,焊接,ZP1-U-1-9,L1 总装线,压装工位,\r\n';
const csvRows = M.parseCSV(csvText);
ok(csvRows.length === 3, 'CSV 解析 3 行（表头 + 2 条）', csvRows.length);
sandbox.state.fixtures = store.getAll('fixtures');
const csvPlan = M.buildImportPlan(csvRows);
ok(csvPlan.ok && csvPlan.plan.length === 2, 'CSV 也能生成导入计划', csvPlan.ok ? csvPlan.plan.length : csvPlan.error);
ok(csvPlan.plan[0].fixture.serialNo === 'CSV-SN-001', 'CSV 实物编号保留', csvPlan.ok ? csvPlan.plan[0].fixture.serialNo : null);
ok(csvPlan.plan[0].fixture.name === 'CSV夹具A', 'CSV 名称正确');
ok(csvPlan.plan[1].fixture.serialNo === 'CSV-SN-002', 'CSV 第 2 条实物编号正确', csvPlan.ok ? csvPlan.plan[1].fixture.serialNo : null);
ok(csvPlan.plan[1].fixture.remark === '', 'CSV 空备注正确为空串', csvPlan.ok ? csvPlan.plan[1].fixture.remark : null);
ok(JSON.stringify(csvPlan.plan[0].fixture.stations) === JSON.stringify([11]), 'CSV 工位名同样能反查到 id', csvPlan.plan[0].fixture.stations);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
