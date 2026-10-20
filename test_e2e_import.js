'use strict';
/* ============================================================
 * test_e2e_import.js — 端到端验证：真实 xlsx 文件 → 解析 → 导入计划 → 落库
 *
 * 把 test_xlsx.js 的解析链路与 test_import.js 的映射链路串起来，
 * 用真实磁盘上的 .xlsx 走完整流程，最后真的写入 store 再读回校验。
 *
 * v5.0.0 变更（MAJOR）：
 *   • 「工位」模型整体移除 ⇒ 导入表头 22 列 → **17 列**
 *     （夹具编号 / 名称 / 机种名称1~7 / 分类 / 库位 / 产线1~5 / 备注）
 *   • 旧版「产线 / 工位」两列仍兼容：产线按分隔符拆成多条，**工位列出现也只被忽略**
 *   • 建档强校验只剩「至少 1 条产线」，不再要求工位
 *   • stationNames / hasStationColumn / _autoStations 全部不存在
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

console.log('=== 端到端导入验证（真实 xlsx → 落库，v5.0.0） ===');

/* ---- 1. 解析真实 xlsx（走主进程同一份代码） ---- */
const { readWorkbook } = require('./js/xlsx_reader');
const wb = readWorkbook(fs.readFileSync(XLSX));
ok(wb.sheets.length === 2, '解析出 2 张工作表');
ok(wb.sheets[0].name === '夹具清单', '第 1 张表名为「夹具清单」', wb.sheets[0].name);
const xrows = wb.sheets[0].rows;
ok(xrows.length === 7, '第 1 张表 7 行（表头 + 5 条数据 + 1 全空行）', xrows.length);
ok(xrows[0].length === 17 && xrows[0][0] === '夹具编号' && xrows[0][16] === '备注',
  '表头 17 列且首列为「夹具编号」', [xrows[0].length, xrows[0][0], xrows[0][16]]);
ok(xrows[1].length === 17 && xrows[1][4] === '', '稀疏列（缺 <c> 节点）补为空串', xrows[1]);
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
// 产线名归一化（v4.5.1 BUG-010：导入时把 1 / 1# 归并成同一条产线，buildImportPlan 依赖）
const normSrc = slice('/* 产线名归一化：', '/* ---------------- 关联字段派生显示');
const modSrc = [limitsSrc, normSrc, importSrc, csvSrc, ';__export = { buildImportPlan, parseCSV };'].join('\n');

const sandbox = {
  state: { fixtures: [], lines: [], productions: [] },
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
// 预置一套同夹具编号的记录 → 触发「重号提示」
sandbox.state.fixtures = [{ id: 99, code: '1001', serialNo: 'DH40MC-921-001-001', name: '已有夹具', status: 'stocked', lineModels: [], lines: [] }];

const plan = M.buildImportPlan(xrows);
ok(plan.ok, '生成导入计划成功', plan.error);
ok(plan.plan.length === 4, '4 条有效行（行 2/3/4/6：未建档产线改为自动补建，不再整行跳过）', plan.plan.length);
ok(plan.skipped.length === 1, '1 条被跳过（仅库位非法）', plan.skipped);
ok(plan.skipped[0].row === 5 && /库位/.test(plan.skipped[0].reason), '第 5 行按库位非法跳过', plan.skipped[0]);
ok(plan.plan._autoLines.indexOf('幽灵线') >= 0, '未建档产线「幽灵线」被登记为待自动补建', plan.plan._autoLines);
ok(plan.plan._autoStations === undefined, 'v5.0.0 起不再有 _autoStations（工位模型已移除）', plan.plan._autoStations);
ok(plan.skipped.every((s) => s.row !== 7), '全空行（第 7 行）不产生跳过记录（静默过滤）');
ok(plan.hasSerialColumn === true && plan.hasLineColumn === true && plan.hasStationColumn === undefined,
  'hasSerialColumn / hasLineColumn 为 true，hasStationColumn 已不存在', [plan.hasSerialColumn, plan.hasLineColumn, plan.hasStationColumn]);

const names = plan.plan.map((p) => p.fixture.name);
ok(JSON.stringify(names) === JSON.stringify(['定位销压板', '焊接夹具', '装配工装', '产线缺失夹具']),
  '四条夹具名称按顺序解析正确（含自动补建的幽灵线行）', names);

// 夹具编号（主搜索键）不再处理「自动分配」，原样保留
ok(plan.plan[0].fixture.serialNo === 'DH40MC-921-001-001', '第 1 条夹具编号原样保留', plan.plan[0].fixture.serialNo);
ok(plan.plan[1].fixture.serialNo === 'XXK-D10VG-002', '第 2 条夹具编号原样保留', plan.plan[1].fixture.serialNo);
ok(plan.plan[0].fixture.code === undefined && plan.plan[0].autoCode === undefined,
  '导入计划不产序号（由 store 自动分配）', Object.keys(plan.plan[0]));

// 机种 / 分类 / 库位 / 产线 / 备注
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
ok(plan.plan[0].fixture.lineNames.join(',') === 'L1 总装线', '第 1 条产线名原样保留', plan.plan[0].fixture.lineNames);
ok(plan.plan[2].fixture.lineNames.join(',') === 'L1 总装线,L2 U型线', '第 3 条多产线（分列）保留为 2 个产线名', plan.plan[2].fixture.lineNames);
ok(plan.plan.every((p) => p.fixture.stationNames === undefined), 'v5.0.0 起计划里不再出现 stationNames', plan.plan.map((p) => p.fixture.stationNames));

// 重号提示（夹具编号允许重复，只提示不拦截）
ok(/已有 1 套/.test(plan.plan[0].dupHint), '第 1 条给出重号提示', plan.plan[0].dupHint);
ok(plan.plan[1].dupHint === '', '第 2 条无重号提示', plan.plan[1].dupHint);

// 缺列保护（v5.0.0：不再要求「工位」列）
const noLine = M.buildImportPlan([['夹具编号', '名称', '库位'], ['S1', 'N', 'ZP1-U-1-1']]);
ok(noLine.ok === false && /模板缺少「产线」列/.test(noLine.error), '缺「产线」列 → 报错', noLine.error);
const noSn = M.buildImportPlan([['名称', '库位', '产线'], ['N', 'ZP1-U-1-1', 'L']]);
ok(noSn.ok === false && /模板缺少「夹具编号」列/.test(noSn.error), '缺「夹具编号」列 → 报错', noSn.error);
const noLoc = M.buildImportPlan([['夹具编号', '名称', '产线'], ['S1', 'N', 'L']]);
ok(noLoc.ok === false && /模板缺少「库位」列/.test(noLoc.error), '缺「库位」列 → 报错', noLoc.error);

/* 旧版「产线 / 工位」两列兼容：产线照常解析，工位列被无视且不报错 */
const legacy = M.buildImportPlan([
  ['夹具编号', '名称', '机种名称1', '库位', '产线', '工位'],
  ['LEG-001', '老模板夹具', 'M1', 'ZP1-U-1-1', 'L1 总装线, L2 U型线', '上料工位 / 压装工位']
]);
ok(legacy.ok === true && legacy.plan.length === 1, '旧版 6 列模板仍可导入', legacy.ok ? legacy.plan.length : legacy.error);
ok(legacy.ok && JSON.stringify(legacy.plan[0].fixture.lineNames) === JSON.stringify(['L1 总装线', 'L2 U型线']),
  '旧版「产线」单列按逗号拆成 2 条产线', legacy.ok ? legacy.plan[0].fixture.lineNames : null);
ok(legacy.ok && legacy.plan[0].fixture.stationNames === undefined, '旧版「工位」列被静默忽略', legacy.ok ? legacy.plan[0].fixture.stationNames : null);

/* ---- 4. 真正落库（临时目录，不污染真实数据） ---- */
console.log('\n[真实落库]');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fms-import-'));
const store = require('./store');
store.setDataDir(tmpDir);
store.open();

// 与沙箱 ctx 同名建立线体
const lineIdByName = new Map();
lineIdByName.set('L1 总装线', store.add('lines', { name: 'L1 总装线', type: 'linear', remark: '' }));
lineIdByName.set('L2 U型线', store.add('lines', { name: 'L2 U型线', type: 'u', remark: '' }));
// 模拟 confirmImportPlan：先按导入计划补建缺失的产线（同名复用），再按名称解析为 id 落库
const ensureLine = (n) => {
  if (!lineIdByName.has(n)) lineIdByName.set(n, store.add('lines', { name: n, type: 'linear', remark: '导入自动建档' }));
  return lineIdByName.get(n);
};

let added = 0;
for (const p of plan.plan) {
  const f = p.fixture;
  const lineIds = [];
  f.lineNames.forEach((n) => { const id = ensureLine(n); if (id != null && !lineIds.includes(id)) lineIds.push(id); });
  store.addFixture({
    serialNo: f.serialNo,
    name: f.name,
    lineModels: f.lineModels,
    category: f.category,
    location: f.location,
    remark: f.remark,
    lines: lineIds
  });
  added++;
}
ok(added === 4, '写入 4 条成功（含未建档产线行）', added);

const all = store.getAll('fixtures');
ok(all.length === 4, '库中共 4 条（含自动补建的幽灵线行）', all.length);
ok(all.every((f) => /^\d{4}$/.test(String(f.code))), '序号由 store 自动分配为 4 位纯数字', all.map((f) => f.code));
ok(new Set(all.map((f) => String(f.code))).size === all.length, '序号互不相同（各夹具独立分配）');
ok(all.every((f) => f.stations === undefined), '落库记录里不含 stations 字段', all.map((f) => Object.keys(f).includes('stations')));

const bySerial = {};
all.forEach((f) => { bySerial[f.serialNo] = f; });
const f1 = bySerial['DH40MC-921-001-001'];
ok(!!f1 && f1.name === '定位销压板', '夹具编号 DH40MC-921-001-001 落库正确', f1 && f1.name);
ok(!!f1 && f1.status === 'stocked', '初始状态 = 在库');
ok(!!f1 && f1.totalOutCount === 0 && f1.repairCount === 0, '统计字段已初始化');
ok(!!f1 && f1.lineModels.length === 2 && f1.lineModels[1] === 'MODEL-B', '机种数组正确落库', f1 && f1.lineModels);
ok(!!f1 && f1.lines.length === 1, '产线已落库（1 条）', f1 && f1.lines);
ok(!!f1 && f1.location === 'ZP1-U-1-1', '库位落库正确');
ok(!!f1 && f1.qrToken === undefined, 'qrToken 不再落库（改为渲染层派生值）', f1 && f1.qrToken);
ok(store.findFixtureByCode(f1.code) !== null, 'findFixtureByCode 能按序号反查');
ok(store.stockCountBySerial('DH40MC-921-001-001') === 1, '在库套数为派生值（1 套）', store.stockCountBySerial('DH40MC-921-001-001'));

const f3 = bySerial['DH40MC-921-001-002'];
ok(!!f3 && f3.lines.length === 2, '多产线夹具落库正确（2 条产线）', f3 && f3.lines);

// 落盘文件确实存在
ok(fs.existsSync(path.join(tmpDir, 'fixture-data.json')), '数据文件已写入磁盘');
ok(!fs.readFileSync(path.join(tmpDir, 'fixture-data.json'), 'utf8').includes('"stations"'),
  '落盘 JSON 中不残留任何 stations 键');

/* ---- 5. 追加第二套同夹具编号（多套追踪：数量为派生值） ---- */
console.log('\n[同编号多套 / 编号保护]');
store.addFixture({
  serialNo: 'DH40MC-921-001-001', name: '定位销压板', lineModels: ['MODEL-A'],
  category: '冲压', location: 'ZP1-U-1-9', remark: '',
  lines: [lineIdByName.get('L1 总装线')]
});
ok(store.stockCountBySerial('DH40MC-921-001-001') === 2, '同夹具编号再加一套 → 在库 2 套（派生值）', store.stockCountBySerial('DH40MC-921-001-001'));
ok(store.stockCountBySerial('DH40MC-921-001-001', 'ZP1-U-1-9') === 1, '按「夹具编号 + 库位」分组计数 = 1', store.stockCountBySerial('DH40MC-921-001-001', 'ZP1-U-1-9'));

/* 重跑计划：应给出「已有 2 套」的重号提示 */
sandbox.state.fixtures = store.getAll('fixtures');
const planAgain = M.buildImportPlan(xrows);
ok(planAgain.ok && planAgain.plan.length === 4, '二次导入计划仍 4 条', planAgain.error);
ok(/已有 2 套/.test(planAgain.plan[0].dupHint), '二次导入重号提示更新为 2 套', planAgain.plan[0].dupHint);

/* 序号重复保护（store 层） */
let threw = false;
try {
  store.addFixture({
    code: f1.code, serialNo: 'OTHER-001', name: '重复编号', lineModels: ['X'],
    location: 'ZP1-U-1-5', lines: [lineIdByName.get('L1 总装线')]
  });
} catch (e) { threw = /编号已存在/.test(e.message); }
ok(threw, '重复序号被 store 层拒绝并抛出「编号已存在」');

/* 建档强校验：无产线直接拒绝；带 stations 字段则被静默丢弃 */
let noLineErr = null;
try { store.addFixture({ serialNo: 'S-X', name: 'X', lineModels: ['M'], location: 'ZP1-U-1-6', lines: [] }); }
catch (e) { noLineErr = e.message; }
ok(/至少选择 1 条产线/.test(noLineErr || ''), '零产线建档被拒绝', noLineErr);

const withStations = store.addFixture({
  serialNo: 'S-Z', name: 'Z', lineModels: ['M'], location: 'ZP1-U-1-7',
  lines: [lineIdByName.get('L1 总装线')], stations: [1, 2]
});
ok(store.getAll('fixtures').find((f) => f.id === withStations).stations === undefined,
  '入库时 stations 字段被静默丢弃（旧数据兼容）');

/* ---- 6. CSV 路径同样走通 ---- */
console.log('\n[CSV 路径]');
const csvText = '夹具编号,名称,机种名称1,分类,库位,产线,备注\r\n'
  + 'CSV-SN-001,CSV夹具A,MODEL-X,冲压,ZP1-U-1-8,L1 总装线,csv导入\r\n'
  + 'CSV-SN-002,CSV夹具B,MODEL-Y,焊接,ZP1-U-1-9,L1 总装线,\r\n';
const csvRows = M.parseCSV(csvText);
ok(csvRows.length === 3, 'CSV 解析 3 行（表头 + 2 条）', csvRows.length);
sandbox.state.fixtures = store.getAll('fixtures');
const csvPlan = M.buildImportPlan(csvRows);
ok(csvPlan.ok && csvPlan.plan.length === 2, 'CSV 也能生成导入计划', csvPlan.ok ? csvPlan.plan.length : csvPlan.error);
ok(csvPlan.plan[0].fixture.serialNo === 'CSV-SN-001', 'CSV 夹具编号保留', csvPlan.ok ? csvPlan.plan[0].fixture.serialNo : null);
ok(csvPlan.plan[0].fixture.name === 'CSV夹具A', 'CSV 名称正确');
ok(csvPlan.plan[1].fixture.serialNo === 'CSV-SN-002', 'CSV 第 2 条夹具编号正确', csvPlan.ok ? csvPlan.plan[1].fixture.serialNo : null);
ok(csvPlan.plan[1].fixture.remark === '', 'CSV 空备注正确为空串', csvPlan.ok ? csvPlan.plan[1].fixture.remark : null);
ok(csvPlan.plan[0].fixture.lineNames.join(',') === 'L1 总装线', 'CSV 产线名原样保留', csvPlan.plan[0].fixture.lineNames);
ok(csvPlan.plan[0].fixture.stationNames === undefined, 'CSV 路径同样不产 stationNames', csvPlan.plan[0].fixture.stationNames);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
