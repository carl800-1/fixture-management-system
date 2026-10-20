'use strict';
/* ============================================================
 * test_line.js — 产线 / 机种 模块测试（v5.0.0）
 *
 * v5.0.0 变更要点（本测试据此重写）：
 *   • **工位（station）模型整体移除**：COLLECTIONS 5 → 4 项（无 stations）
 *     fixtures.stations、工位 CRUD、产线示意图（工位图）全部删除
 *   • 「夹具 ↔ 产线」扁平进夹具记录：`fixtures.lines[]`（1~5 条）
 *   • 产线配置导入表头 6 列 → 4 列（线体 | 线体形态 | 夹具编号 | 备注）
 *   • 撤销接口只保留 removeFixtureLine / removeFixtureLinesByBatch
 *   • buildProdDetailRows 签名去 stations（机种 × 线体，不再到工位）
 *
 * 分区：
 *   A. 数据层（store：集合清单 / CRUD / 派生数量 / 级联删除 / 落盘）
 *   B. 线体形态
 *   C. fixturesOfLine（按产线反查夹具）
 *   G. 产线导入映射与计划（4 列表头 / 追加去重 / 上限拦截）
 *   H. 端到端：plan → applyLineImportPlan（真实 store）→ 读回校验 + 重复导入幂等
 *   I. 撤销接口（removeFixtureLine / removeFixtureLinesByBatch）
 *   J. buildProdQueryRows / buildProdDetailRows（机种查询与机种明细）
 *
 * 运行：node test_line.js
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function section(s) { console.log('\n【' + s + '】'); }
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → 实际: ' + JSON.stringify(extra) : '')); }
}

/* ---------- 从 app.js 抽取被测代码（按定界注释切片） ---------- */
const src = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
function slice(startMark, endMark) {
  const s = src.indexOf(startMark);
  if (s < 0) throw new Error('切片起点未找到：' + startMark);
  const e = endMark ? src.indexOf(endMark, s + 1) : src.length;
  if (e < 0) throw new Error('切片终点未找到：' + endMark);
  return src.slice(s, e);
}

const parts = [
  slice('function natCompare(a, b)', '/* 库位列表排序'),
  slice('function formatLineModels(f, emptyMark', '/* 一件夹具关联的机种数（去重后） */'),
  slice('/* ---------------- 业务上限与格式约束', '/* 机种名称：展示 / 搜索 helpers */'),
  slice('function normalizeHeader(h)', '// 把二维数组的首行解析成'),
  slice('const LINE_TYPES = [', '/* ---------------- 产线使用页'),
  slice('const LINE_IMPORT_HEADERS = [', '/* 落库：'),
  slice('async function applyLineImportPlan(plan) {', 'window.showLineImportPreview'),
  slice('function buildProdQueryRows(fixtures, lines, names) {', 'async function renderProdQuery()')
];

/* ---------- 真实 store 作为 DB 后端（临时目录，不污染真实数据）---------- */
const store = require('./store');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fms-line-test-'));
store.setDataDir(tmpDir);
store.open();

const sandbox = {
  console,
  Math, Number, String, Array, Object, JSON, Set, Map, Date, RegExp, Boolean, parseInt, parseFloat, isNaN, Infinity, NaN,
  esc: (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  state: { fixtures: [], fixTransactions: [], lines: [], productions: [] },
  DB: {
    add: async (name, item) => store.add(name, item),
    put: async (name, item) => store.put(name, item),
    fixtureUpdate: async (f) => store.updateFixture(f)
  }
};
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(parts.join('\n') + `
;__export = {
  lineTypeLabel, lineTypeKey, parseLineType, fixturesOfLine,
  normModelName, lineModelsMatch, lineModelsExact,
  lineModelNamesOfLine, lineNamesOfModel, slashCell,
  mapLineImportHeader, buildLineImportPlan, applyLineImportPlan,
  buildProdQueryRows, buildProdDetailRows,
  isValidLocation, isValidSerialNo, isValidProductionName,
  LINE_IMPORT_HEADERS, MAX_LINES, MAX_LINE_MODELS
};`, ctx);
const M = sandbox.__export;
if (!M) { console.error('模块导出失败'); process.exit(1); }

/* 按 id 取夹具（store.get 的签名是 get(name, id)，此处封装以避免误用） */
const fixById = (id) => store.getAll('fixtures').find((f) => f.id === id) || {};

function syncState() {
  sandbox.state.fixtures = store.getAll('fixtures');
  sandbox.state.fixTransactions = store.getAll('fixTransactions');
  sandbox.state.lines = store.getAll('lines');
  sandbox.state.productions = store.getAll('productions');
}
function state_() {
  return {
    fixtures: store.getAll('fixtures'),
    lines: store.getAll('lines'),
    productions: store.getAll('productions')
  };
}

console.log('=== 产线 / 机种 模块测试（v5.0.0：无工位）===');

/* ============ A. 数据层 ============ */
section('A. 数据层（store：集合清单 / CRUD / 派生数量 / 级联删除 / 落盘）');
ok(store.COLLECTIONS.join(',') === 'fixtures,fixTransactions,lines,productions,staffs',
  'COLLECTIONS 为 5 项（v5.1.0 增加 staffs 人员卡库）', store.COLLECTIONS);
ok(store.COLLECTIONS.indexOf('stations') < 0, 'stations 集合已不在 COLLECTIONS 内', store.COLLECTIONS);
ok(store.setStationFixtures === undefined, 'setStationFixtures（v3 一对多绑定接口）已删除');
ok(store.delStation === undefined, 'delStation（工位删除）已删除', typeof store.delStation);
ok(store.removeFixtureStation === undefined, 'removeFixtureStation（撤销单工位）已删除', typeof store.removeFixtureStation);
ok(store.MAX_STATIONS === undefined, 'MAX_STATIONS 常量已删除', store.MAX_STATIONS);
ok(store.productsOfLine === undefined && store.delProduct === undefined, '旧 products 相关接口已删除');

const l1 = store.add('lines', { name: 'L1 总装线', type: 'linear', remark: '' });
const l2 = store.add('lines', { name: 'L2 U型线', type: 'u', remark: '' });
const p1 = store.add('productions', { name: '机种甲', order: 1 });
const p2 = store.add('productions', { name: '机种乙', order: 2 });

ok(store.getAll('lines').length === 2, 'lines 写入 2 条', store.getAll('lines').length);
ok(store.getAll('productions').length === 2, 'productions 写入 2 条（无 lineId 字段）');
ok(store.getAll('productions').every((p) => p.lineId === undefined), 'productions 不隶属产线（无 lineId）');
ok(store.getAll('stations') === undefined || store.getAll('stations').length === 0,
  'stations 集合不存在（getAll 返回空）', store.getAll('stations'));
ok(new Set([l1, l2, p1, p2]).size === 4, 'id 互不相同');

/* 夹具建档（lines 扁平字段；同实物编号可多套） */
const fx1 = store.add('fixtures', {
  serialNo: 'DH40MC-921-001-001', name: '定位销压板', lineModels: ['机种甲', '机种乙'],
  lines: [l1], location: 'ZP1-U-1-1', category: '冲压'
});
const fx2 = store.add('fixtures', {
  serialNo: 'DH40MC-921-001-001', name: '定位销压板', lineModels: ['机种甲'],
  lines: [l1, l2], location: 'ZP1-U-1-2', category: '冲压'
});
ok(store.getAll('fixtures').length === 2, '同实物编号写入 2 套夹具（允许重复）');
const codes = store.getAll('fixtures').map((f) => String(f.code));
ok(codes.every((c) => /^\d{4}$/.test(c)), '序号为 4 位纯数字且自动分配', codes);
ok(new Set(codes).size === 2, '序号唯一');
ok(fixById(fx1).stations === undefined && fixById(fx2).stations === undefined,
  '夹具记录不含 stations 字段（v5.0.0）', [fixById(fx1).stations, fixById(fx2).stations]);

/* 数量为派生值，不落库 */
ok(store.stockCountBySerial('DH40MC-921-001-001') === 2, '在库套数 = 按实物编号分组计数', store.stockCountBySerial('DH40MC-921-001-001'));
ok(store.stockCountBySerial('DH40MC-921-001-001', 'ZP1-U-1-1') === 1, '按实物编号 + 库位计数', store.stockCountBySerial('DH40MC-921-001-001', 'ZP1-U-1-1'));
ok(fixById(fx1).qty === undefined && fixById(fx1).quantity === undefined, '夹具记录无 qty/quantity 存储字段');

const file = path.join(tmpDir, 'fixture-data.json');
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
ok(['fixtures', 'fixTransactions', 'lines', 'productions'].every((k) => Array.isArray(raw[k])),
  'JSON 落盘含全部 4 个集合', Object.keys(raw));
ok(raw.stations === undefined, '落盘文件不含 stations 集合（v5.0.0）');
ok(raw.stationFixtures === undefined, '落盘文件不含 stationFixtures');
ok(raw.fixtures.every((f) => f.stations === undefined), '落盘夹具不含 stations 字段');

/* 机种删除保护 + 改名写穿 */
let delErr = null;
try { store.del('productions', p1); } catch (e) { delErr = e; }
ok(delErr && delErr.name === 'ConstraintError' && /仍被/.test(delErr.message), '被引用机种禁止删除（ConstraintError）', delErr && delErr.message);
ok(store.getAll('productions').length === 2, '删除失败后机种数量不变');
const swept = store.renameProduction(p1, '机种甲改');
ok(swept === 2, '机种改名批量写穿 fixtures.lineModels（2 条）', swept);
ok(store.getAll('fixtures').every((f) => !(f.lineModels || []).includes('机种甲')), '旧名已完全替换');
ok(store.getAll('fixtures').filter((f) => (f.lineModels || []).includes('机种甲改')).length === 2, '新名已写入');

/* 级联删除：删产线 → 从夹具 lines 摘除（不再有工位级联） */
store.del('lines', l2);
ok(store.getAll('lines').every((x) => x.id !== l2), '删产线：产线已移除');
ok(fixById(fx2).lines.indexOf(l2) < 0, '删产线：夹具 lines 已摘除该线', fixById(fx2).lines);
ok(fixById(fx2).lines.indexOf(l1) >= 0, '删产线：其它产线保留', fixById(fx2).lines);
ok(store.getAll('fixtures').every((f) => f.stations === undefined), '删产线不产生 stations 字段');

/* 直接删 stations 集合名不再有特殊分支 */
ok(!throws(() => store.getAll('stations')), 'getAll("stations") 不抛异常（返回空数组）');

function throws(fn) {
  try { fn(); return false; } catch (e) { return true; }
}

/* ============ B. 线体形态 ============ */
section('B. 线体形态（只有 直线形 / U型 两种）');
ok(M.lineTypeLabel('linear') === '直线形', 'linear → 直线形');
ok(M.lineTypeLabel('u') === 'U型', 'u → U型');
ok(M.lineTypeLabel('weird') === '直线形', '未知类型回退直线形', M.lineTypeLabel('weird'));
ok(M.lineTypeKey('weird') === 'linear', '未知类型键归一为 linear');
ok(M.lineTypeKey('u') === 'u', '已知类型键保持');

/* 历史数据兼容：早期版本用 loop / circle / ring / 环形 表示「环形」，一律折算为 U型 */
ok(M.lineTypeKey('loop') === 'u', '历史值 loop 折算为 u');
ok(M.lineTypeKey('circle') === 'u', '历史值 circle 折算为 u');
ok(M.lineTypeLabel('loop') === 'U型', '历史值 loop 显示为 U型');
ok(M.lineTypeLabel('环形') === 'U型', '历史值「环形」显示为 U型');

ok(M.parseLineType('U型') === 'u', '「U型」→ u');
ok(M.parseLineType('u') === 'u', '「u」→ u');
ok(M.parseLineType('U形线') === 'u', '「U形线」→ u');
ok(M.parseLineType('环形') === 'u', '老表格里的「环形」→ u（兼容）');
ok(M.parseLineType('环线') === 'u', '「环线」→ u（兼容）');
ok(M.parseLineType('圆形线') === 'u', '「圆形线」→ u（兼容）');
ok(M.parseLineType('Loop') === 'u', '英文 Loop → u（兼容）');
ok(M.parseLineType('直线形') === 'linear', '「直线形」→ linear');
ok(M.parseLineType('Unit line') === 'linear', '含 u 的英文词（Unit）不被误判为 U型');
ok(M.parseLineType('') === 'linear', '空值 → linear');
ok(M.parseLineType(null) === 'linear', 'null → linear');

/* ============ C. fixturesOfLine ============ */
section('C. fixturesOfLine（按产线反查夹具）');
const cLines = [{ id: 1, name: 'C1 线' }, { id: 2, name: 'C2 线' }];
sandbox.state.fixtures = [
  { id: 1, code: '2002', serialNo: 'SN-B', lines: [1] },
  { id: 2, code: '2001', serialNo: 'SN-A', lines: [1, 2] },
  { id: 3, code: '2003', serialNo: '', lines: [], },
  { id: 4, code: '2004', serialNo: 'SN-C', lines: ['2'] }
];
const ofC1 = M.fixturesOfLine(1);
ok(ofC1.length === 2, 'C1 线 → 2 套夹具', ofC1.map((f) => f.code));
ok(ofC1.map((f) => f.code).join(',') === '2001,2002', '按实物编号自然序（SN-A 在 SN-B 前 → 2001/2002）', ofC1.map((f) => f.code));
ok(M.fixturesOfLine(2).length === 2, 'C2 线 → 2 套（含字符串 id "2"）', M.fixturesOfLine(2).map((f) => f.code));
ok(M.fixturesOfLine(9).length === 0, '不存在的产线 → 0 套');
ok(M.fixturesOfLine('1').length === 2, '字符串产线 id 也能命中（Number 归一）', M.fixturesOfLine('1').length);
sandbox.state.fixtures = [];
ok(M.fixturesOfLine(1).length === 0, '夹具为空时安全');

/* ============ G. 产线导入映射与计划（v5.0.0 四列） ============ */
section('G. 产线导入映射（v5.0.0 四列表头）');
ok(M.LINE_IMPORT_HEADERS.join(',') === '线体,线体形态,夹具编号,备注',
  '标准表头为 4 列（工位两列已删）', M.LINE_IMPORT_HEADERS);
const idxStd = M.mapLineImportHeader(['线体', '线体形态', '夹具编号', '备注']);
ok(idxStd.line === 0 && idxStd.lineType === 1 && idxStd.fixtureSerial === 2 && idxStd.remark === 3,
  '标准表头映射正确', JSON.stringify(idxStd));
ok(idxStd.station === undefined && idxStd.seq === undefined, '不再识别「工位 / 工位顺序」列', JSON.stringify(idxStd));
ok(idxStd.product === undefined && idxStd.productCode === undefined, '不再识别「产品 / 产品编号」列（products 已废除）');
const idxAlias = M.mapLineImportHeader(['产线', '形态', '编号']);
ok(idxAlias.line === 0 && idxAlias.lineType === 1 && idxAlias.fixtureSerial === 2,
  '别名表头映射正确（编号 → 夹具编号）', JSON.stringify(idxAlias));
ok(M.mapLineImportHeader(['实物编号']).fixtureSerial === 0, '「实物编号」→ fixtureSerial');
ok(M.mapLineImportHeader(['夹具编号']).fixtureSerial === 0, '「夹具编号」→ fixtureSerial（语义已反转，不再指序号）');
ok(M.mapLineImportHeader(['线体（必填）']).line === 0, '括号注释被忽略');
ok(M.mapLineImportHeader([]).line === undefined, '空表头安全');
const idxOld6 = M.mapLineImportHeader(['线体', '线体形态', '工位', '工位顺序', '夹具编号', '备注']);
ok(idxOld6.fixtureSerial === 4, '旧 6 列模板仍能定位夹具编号（工位列被忽略）', JSON.stringify(idxOld6));
ok(idxOld6.station === undefined && idxOld6.seq === undefined, '旧 6 列模板的工位列不参与映射', JSON.stringify(idxOld6));

section('G2. buildLineImportPlan（4 列 / 追加去重 / 上限拦截）');
const gEx = {
  lines: [{ id: 1, name: 'L1 总装线', type: 'linear' }],
  fixtures: [
    { id: 1, code: '2001', serialNo: 'SN-A', lines: [] },
    { id: 2, code: '2002', serialNo: 'SN-B', lines: [] },
    { id: 3, code: '2003', serialNo: 'SN-C', lines: [] }
  ]
};
const rowsOk = [
  ['线体', '线体形态', '夹具编号', '备注'],
  ['L1 总装线', '直线形', 'SN-A', ''],
  ['L1 总装线', '直线形', 'SN-B', '同产线第二套'],
  ['  ', '直线形', 'SN-B', '线体缺失应跳过'],
  ['L2 U型线', 'U型', 'SN-C', '']
];
const plan = M.buildLineImportPlan(rowsOk, gEx);
ok(plan.ok, '生成计划成功', plan.error);
ok(plan.newLines.length === 1 && plan.newLines[0].name === 'L2 U型线', '仅新建 1 条线体（L1 已存在）', plan.newLines.map((l) => l.name));
ok(plan.newLines[0].type === 'u', 'U型线体类型正确', plan.newLines[0].type);
ok(plan.appends.length === 3, '3 条追加关联（SN-A×1 / SN-B×1 / SN-C×1）', plan.appends.map((a) => a.serialNo + '@' + a.lineName));
ok(plan.skipped.length === 1 && plan.skipped[0].row === 4 && /线体为空/.test(plan.skipped[0].reason),
  '跳过第 4 行（线体为空，1-based 行号）', plan.skipped);
ok(plan.appends.every((a) => typeof a.fixtureId === 'number' && a.code), '每条追加项带 fixtureId 与序号');
ok(plan.appends.every((a) => a.stationName === undefined), '追加项不再有 stationName 字段', Object.keys(plan.appends[0]));

/* 已存在关联 → 无新增，已忽略 */
const gEx2 = {
  lines: [{ id: 1, name: 'L1 总装线', type: 'linear' }],
  fixtures: [{ id: 1, code: '2001', serialNo: 'SN-A', lines: [1] }]
};
const planDup = M.buildLineImportPlan([['线体', '夹具编号'], ['L1 总装线', 'SN-A']], gEx2);
ok(planDup.ok === false && planDup.skipped.length === 1 && /已关联/.test(planDup.skipped[0].reason),
  '已关联的产线 → 跳过并提示「无新增，已忽略」', planDup.skipped);

/* 未建档 / 重复套 / 文件内重复行 / 空编号 */
const planMiss = M.buildLineImportPlan([['线体', '夹具编号'], ['L1 总装线', 'SN-NOT-EXIST']], gEx);
ok(planMiss.ok === false && /未建档/.test(planMiss.skipped[0].reason), '未建档实物编号 → 跳过', planMiss.skipped);
const planDupSerial = M.buildLineImportPlan([['线体', '夹具编号'], ['L1 总装线', 'SN-A']], {
  lines: gEx.lines,
  fixtures: [
    { id: 1, code: '2001', serialNo: 'SN-A', lines: [] },
    { id: 2, code: '2002', serialNo: 'SN-A', lines: [] }
  ]
});
ok(planDupSerial.ok === false && /无法唯一定位/.test(planDupSerial.skipped[0].reason),
  '同实物编号多套 → 无法唯一定位，跳过', planDupSerial.skipped);
const planRowDup = M.buildLineImportPlan([
  ['线体', '夹具编号'],
  ['L1 总装线', 'SN-A'],
  ['L1 总装线', 'SN-A']
], gEx);
ok(planRowDup.appends.length === 1 && /文件中重复行/.test(planRowDup.skipped[0].reason),
  '文件内完全重复的行只处理一次', planRowDup.skipped);
const planNoSerial = M.buildLineImportPlan([['线体', '夹具编号'], ['L1 总装线', '']], gEx);
ok(planNoSerial.ok === false && /为空/.test(planNoSerial.skipped[0].reason), '夹具编号为空 → 跳过', planNoSerial.skipped);

/* 上限拦截：产线 ≤5（虚拟状态预演，计划阶段即拦住） */
const ml = [];
for (let i = 0; i < 6; i++) ml.push({ id: 900 + i, name: 'ML' + i, type: 'linear' });
const planMaxLine = M.buildLineImportPlan([['线体', '夹具编号'], ['ML9 新线', 'SN-L5']],
  { lines: ml, fixtures: [{ id: 70, code: '9070', serialNo: 'SN-L5', lines: [900, 901, 902, 903, 904] }] });
ok(planMaxLine.ok === false && /上限 5/.test(planMaxLine.skipped[0].reason), '产线已达 5 条 → 跳过（上限 5）', planMaxLine.skipped);
const planFour = M.buildLineImportPlan([['线体', '夹具编号'], ['ML0', 'SN-L4']],
  { lines: ml, fixtures: [{ id: 72, code: '9072', serialNo: 'SN-L4', lines: [901, 902, 903, 904] }] });
ok(planFour.ok && planFour.appends.length === 1, '产线 4 条（未达上限）→ 正常追加', planFour.error);

/* 缺列 / 空表 */
ok(M.buildLineImportPlan([['夹具编号'], ['SN-A']], gEx).ok === false, '缺「线体」列 → 报错');
ok(/缺少「线体」/.test(M.buildLineImportPlan([['夹具编号'], ['SN-A']], gEx).error), '缺线体列的报错文案正确',
  M.buildLineImportPlan([['夹具编号'], ['SN-A']], gEx).error);
ok(/缺少「夹具编号」/.test(M.buildLineImportPlan([['线体'], ['L1']], gEx).error), '缺「夹具编号」列 → 报错');
ok(M.buildLineImportPlan([['线体', '夹具编号']], gEx).ok === false, '只有表头 → 报错');
ok(M.buildLineImportPlan([], gEx).ok === false, '空数组 → 报错');
ok(M.buildLineImportPlan(null, gEx).ok === false, 'null → 报错');
const planAllBad = M.buildLineImportPlan([['线体', '夹具编号'], ['', ''], ['L1 总装线', '']], gEx);
ok(planAllBad.ok === false && /没有可导入的有效数据行/.test(planAllBad.error), '全无效行 → 报错', planAllBad.error);
ok(Array.isArray(planAllBad.skipped) && planAllBad.skipped.length === 1,
  '失败返回值同时带 skipped（预览页才能列出跳过原因）', planAllBad.skipped);
ok(M.buildLineImportPlan([['线体', '夹具编号'], [null, null]], gEx).ok === false, '全 null 行 → 报错');

/* ============ H / I / J：需要异步与真实 store ============ */
(async () => {
  /* ============ H. 端到端：导入落库 ============ */
  section('H. 端到端导入落库');
  const hl = store.add('lines', { name: 'H1 基础线', type: 'linear', remark: '' });
  store.add('fixtures', { serialNo: 'SN-E', name: '端到端夹具E', lineModels: ['E1'], lines: [hl], location: 'ZP2-U-1-1', category: '焊接' });
  store.add('fixtures', { serialNo: 'SN-F', name: '端到端夹具F', lineModels: [], lines: [hl], location: 'ZP2-U-1-2', category: '' });
  syncState();

  const beforeLines = store.getAll('lines').length;
  const planExec = M.buildLineImportPlan([
    ['线体', '线体形态', '夹具编号', '备注'],
    ['L3 焊装线', '直线形', 'SN-E', ''],
    ['L3 焊装线', '直线形', 'SN-F', ''],
    ['L4 U型线', 'U型', 'SN-E', '']
  ], { lines: state_().lines, fixtures: state_().fixtures });
  ok(planExec.ok, '端到端计划生成成功', planExec.error);
  ok(planExec.newLines.length === 2, '计划：新建 2 条线体', planExec.newLines.map((l) => l.name));
  ok(planExec.appends.length === 3, '计划：3 条追加', planExec.appends.length);

  const stat = await M.applyLineImportPlan(planExec);
  ok(stat.lines === 2, '落库新建 2 条线体', stat.lines);
  ok(stat.appends === 3, '落库追加 3 行', stat.appends);
  ok(stat.applied === 2, '实际更新 2 套夹具', stat.applied);
  ok(stat.linesAdded === 3, '新增 3 条产线关联（SN-E 2 + SN-F 1）', stat.linesAdded);
  ok(store.getAll('lines').length === beforeLines + 2, '线体总数 +2', store.getAll('lines').length);
  ok(stat.undo.fixtures.length === 2 && stat.undo.createdLineIds.length === 2,
    '返回 undo 信息（供「撤销本次导入」）', JSON.stringify(Object.keys(stat.undo)));

  syncState();
  const l3 = store.getAll('lines').find((x) => x.name === 'L3 焊装线');
  const l4 = store.getAll('lines').find((x) => x.name === 'L4 U型线');
  ok(l3 && l3.type === 'linear', 'L3 线体类型 = 直线形', l3 && l3.type);
  ok(l4 && l4.type === 'u', 'L4 线体类型 = U型', l4 && l4.type);

  const fE = store.getAll('fixtures').find((f) => f.serialNo === 'SN-E');
  const fF = store.getAll('fixtures').find((f) => f.serialNo === 'SN-F');
  ok(fE.lines.includes(hl) && fE.lines.includes(l3.id) && fE.lines.includes(l4.id),
    'SN-E 产线 = 原有的 H1 + 新增 L3 / L4（追加不覆盖）', fE.lines);
  ok(fF.lines.includes(hl) && fF.lines.includes(l3.id) && !fF.lines.includes(l4.id),
    'SN-F 只追加了 L3（未涉及 L4）', fF.lines);
  ok(fE.stations === undefined && fF.stations === undefined, '落库后夹具仍无 stations 字段');

  /* 幂等：同一份文件再导一次 —— 「无新增即无有效行」*/
  const planAgain = M.buildLineImportPlan([
    ['线体', '线体形态', '夹具编号', '备注'],
    ['L3 焊装线', '直线形', 'SN-E', ''],
    ['L3 焊装线', '直线形', 'SN-F', ''],
    ['L4 U型线', 'U型', 'SN-E', '']
  ], { lines: state_().lines, fixtures: state_().fixtures });
  ok(planAgain.ok === false, '重复导入：无新增 → 计划判定为「无有效行」', planAgain.error);
  ok(planAgain.skipped.length === 3 && planAgain.skipped.every((s) => /已关联/.test(s.reason)),
    '重复导入：3 行全部提示「已关联（无新增，已忽略）」', planAgain.skipped.map((s) => s.reason));
  const cntFixtures = store.getAll('fixtures').length;
  const cntLines2 = store.getAll('lines').length;
  ok(cntFixtures === 4 && cntLines2 === beforeLines + 2, '重复导入：夹具与线体数量不变（幂等）', [cntFixtures, cntLines2]);

  /* ============ I. 撤销接口 ============ */
  section('I. 撤销接口（removeFixtureLine / removeFixtureLinesByBatch）');
  const undoFixtures = stat.undo.fixtures;
  const removedLineIds = Array.from(new Set(undoFixtures.flatMap((u) => u.lineIds)));
  ok(removedLineIds.length === 2, '本次导入涉及 2 条新产线', removedLineIds);
  let removedCount = 0;
  removedLineIds.forEach((lineId) => {
    const batch = undoFixtures.filter((u) => u.lineIds.includes(lineId)).map((u) => u.code);
    removedCount += store.removeFixtureLinesByBatch(batch, lineId);
  });
  ok(removedCount === 3, 'removeFixtureLinesByBatch 批量摘产线：跨 2 条产线共命中 3 次（L3 两套 + L4 一套）', removedCount);
  syncState();
  const fE2 = fixById(fE.id);
  ok(!fE2.lines.includes(l3.id) && !fE2.lines.includes(l4.id), '批量撤销后 SN-E 不再关联 L3 / L4', fE2.lines);
  ok(fE2.lines.includes(hl), '批量撤销保留原有的 H1 产线（不误伤）', fE2.lines);

  /* removeFixtureLine：单条撤销，返回剩余条数 */
  const il = store.add('lines', { name: 'IX 线', type: 'linear', remark: '' });
  const il2 = store.add('lines', { name: 'IY 线', type: 'u', remark: '' });
  const ifid = store.add('fixtures', { serialNo: 'SN-U1', name: '撤销用夹具', lineModels: [], lines: [il, il2], location: 'ZP3-U-1-1', category: '' });
  const ifCode = fixById(ifid).code;
  const r2 = store.removeFixtureLine(ifCode, il2);
  ok(r2.lines === 1, 'removeFixtureLine 返回剩余产线条数 1', JSON.stringify(r2));
  ok(typeof r2.stations === 'undefined', '返回值不再包含 stations 计数', JSON.stringify(r2));
  const r3 = store.removeFixtureLine(ifCode, il);
  ok(r3.lines === 0, '摘除最后一条产线 → 剩 0 条（记录本身保留）', JSON.stringify(r3));
  ok(fixById(ifid).id === ifid, '夹具记录仍在（只摘关联，不删记录）');
  let notFound = null;
  try { store.removeFixtureLine('9999', il); } catch (e) { notFound = e; }
  ok(notFound && notFound.name === 'NotFoundError', '对不存在的序号调用撤销接口 → NotFoundError', notFound && notFound.name);

  /* ============ J. 按机种查询 ============ */
  section('J. buildProdQueryRows 按机种查询（机种 → 夹具 → 产线 1 跳推导）');
  const jLines = [{ id: 1, name: 'J1 线' }, { id: 2, name: 'J2 线' }];
  const jFixtures = [
    { id: 1, code: '3001', serialNo: 'SN-J1', location: 'ZP1-U-1-1', status: 'stocked', lineModels: ['机种甲', '机种乙'], lines: [1, 2] },
    { id: 2, code: '3002', serialNo: 'SN-J2', location: 'ZP1-U-1-2', status: 'checked_out', lineModels: ['机种甲'], lines: [] },
    { id: 3, code: '3003', serialNo: 'SN-J3', location: '', status: 'stocked', lineModels: ['机种丙'], lines: [2] }
  ];
  const jRows = M.buildProdQueryRows(jFixtures, jLines, ['机种甲', '机种乙']);
  ok(jRows.length === 5, '展开为 5 行（机种甲×3 + 机种乙×2）', jRows.length);
  ok(jRows.filter((r) => r.production === '机种甲').length === 3, '机种甲 3 行（J1 / J2 / 未关联）');
  ok(jRows.filter((r) => r.production === '机种乙').length === 2, '机种乙 2 行（J1 / J2）');
  ok(jRows.every((r) => r.production !== '机种丙'), '未选中的机种被过滤（机种丙）');
  ok(jRows[0].production === '机种甲' && jRows[jRows.length - 1].production === '机种乙',
    '按机种分组排序（机种甲在前、机种乙在后）', [jRows[0].production, jRows[jRows.length - 1].production]);
  const orphan = jRows.find((r) => r.lineName === '（未关联产线）');
  ok(orphan && orphan.serialNo === 'SN-J2', '无产线关联的夹具占位「（未关联产线）」', orphan);
  ok(jRows.every((r) => ['lineName', 'serialNo', 'code', 'location', 'status', 'fixtureId'].every((k) => k in r)),
    '输出固定列齐备（产线 / 夹具编号 / 库位 / 状态 / id）', Object.keys(jRows[0]));
  const jJ1 = jRows.find((r) => r.production === '机种甲' && r.lineName === 'J1 线');
  ok(jJ1.code === '3001' && jJ1.location === 'ZP1-U-1-1' && jJ1.status === 'stocked' && jJ1.fixtureId === 1,
    '行内字段映射正确', jJ1);
  ok(M.buildProdQueryRows(jFixtures, jLines, []).length === 0, '未选机种 → 0 行');
  ok(M.buildProdQueryRows([], jLines, ['机种甲']).length === 0, '无夹具 → 0 行');
  ok(M.buildProdQueryRows([{ id: 9, code: '9', lineModels: ['机种甲'], lines: null }], jLines, ['机种甲']).length === 1,
    'lines 非数组时占位「未关联产线」');
  ok(M.buildProdQueryRows([{ id: 9, code: '9', lineModels: ['机种甲'], lines: [7] }], jLines, ['机种甲'])[0].lineName === '（未关联产线）',
    '产线 id 已失效（被删）时同样占位');

  /* ============ J2. 机种明细（v5.0.0 只到线体） ============ */
  section('J2. buildProdDetailRows 机种 × 线体（明细面板数据源，无工位）');
  const kLines = [{ id: 1, name: 'K1 线' }, { id: 2, name: 'K2 线' }];
  const kFixtures = [
    { id: 31, code: '4001', serialNo: 'SN-K1', name: '定位销压板', location: 'ZP1-U-1-1', status: 'stocked', lineModels: ['机种甲'], lines: [1, 2] },
    { id: 32, code: '4002', serialNo: 'SN-K2', name: '焊接夹具', location: 'ZP1-U-1-2', status: 'checked_out', lineModels: ['机种甲'], lines: [2] },
    { id: 33, code: '4003', serialNo: 'SN-K3', name: '无产线夹具', location: '', status: 'stocked', lineModels: ['机种甲'], lines: [] },
    { id: 34, code: '4004', serialNo: 'SN-K4', name: '别的机种夹具', location: 'X', status: 'stocked', lineModels: ['机种乙'], lines: [1] }
  ];
  const kd = M.buildProdDetailRows(kFixtures, kLines, ['机种甲']);
  ok(kd.length === 4, '机种甲共 4 行（K1 一条 + K2 两条 + 未关联一条）', kd.map((r) => r.lineName + '/' + r.serialNo));
  ok(kd.every((r) => r.production === '机种甲'), '非目标机种被过滤（机种乙的夹具不出现）');
  ok(kd.filter((r) => r.lineName === 'K1 线').length === 1, 'K1 线 1 行（夹具 31）');
  ok(kd.filter((r) => r.lineName === 'K2 线').length === 2, 'K2 线 2 行（31 + 32）');
  const orphanK = kd.filter((r) => r.lineName === '（未关联产线）');
  ok(orphanK.length === 1 && orphanK[0].fixtureId === 33, '无产线夹具 → 「（未关联产线）」占位', orphanK[0]);
  ok(kd.every((r) => r.stationName === undefined), '明细行不再有 stationName 字段', Object.keys(kd[0]));
  ok(kd.every((r) => ['production', 'lineId', 'lineName', 'fixtureId', 'code', 'serialNo', 'name', 'location', 'status'].every((k) => k in r)),
    '明细行字段齐备（线体 + 夹具字段）', Object.keys(kd[0]));
  ok(M.buildProdDetailRows(kFixtures, kLines, []).length === 0, '未指定机种 → 0 行');
  ok(M.buildProdDetailRows([], kLines, ['机种甲']).length === 0, '无夹具 → 0 行');
  ok(M.buildProdDetailRows([{ id: 35, code: '4005', lineModels: ['机种甲'], lines: null }], kLines, ['机种甲']).length === 1,
    'lines 非数组时占位「未关联产线」');
  ok(M.buildProdDetailRows([{ id: 36, code: '4006', lineModels: ['机种甲'], lines: [9] }], kLines, ['机种甲'])[0].lineName === '（产线已删除 #9）',
    '产线 id 已失效时标注「产线已删除 #id」', M.buildProdDetailRows([{ id: 36, code: '4006', lineModels: ['机种甲'], lines: [9] }], kLines, ['机种甲'])[0].lineName);

  syncState();
  ok(store.getAll('fixtures').length === 5,
    'J 段为纯函数，不写库（A 段 2 + H 段 2 + I 段 1 = 5 套）', store.getAll('fixtures').length);

  /* ============================================================
   * K. v5.2.0 线体 ↔ 机种 互查派生列
   *    lineModelNamesOfLine（产线配置「机种名称」列）
   *    lineNamesOfModel   （机种管理「线体」列）
   *    两者都由夹具的 lines / lineModels 现算，不落库。
   * ============================================================ */
  section('K1. lineModelNamesOfLine（线体 → 机种，去重 + 自然序）');
  const kLines2 = [
    { id: 1, name: 'L1 总装线', type: 'linear' },
    { id: 2, name: 'L2 U型线', type: 'u' },
    { id: 10, name: 'L10 线', type: 'linear' }
  ];
  const kFx2 = [
    { id: 101, lines: [1], lineModels: ['DH38YE3', 'DH40MC'] },
    { id: 102, lines: [1, 2], lineModels: ['DH38YE3'] },          // L1 上重复机种
    { id: 103, lines: [2], lineModels: [] },                       // 无机的夹具
    { id: 104, lines: [10], lineModels: ['X2', 'X10', 'X1'] },     // 自然序
    { id: 105, lines: null, lineModels: ['孤儿机种'] },             // 未关联产线
    { id: 106, lines: [1], lineModels: ['  DH38YE3  ', '', null] } // 带空白/空值
  ];

  ok(JSON.stringify(M.lineModelNamesOfLine(1, kFx2)) === JSON.stringify(['DH38YE3', 'DH40MC']),
    'L1 → DH38YE3 / DH40MC（去重 + 排序，空白项被 trim 合并）', M.lineModelNamesOfLine(1, kFx2));
  ok(JSON.stringify(M.lineModelNamesOfLine(2, kFx2)) === JSON.stringify(['DH38YE3']),
    'L2 → 只算 lines 含 2 的夹具（无机种的夹具不产生空项）', M.lineModelNamesOfLine(2, kFx2));
  ok(JSON.stringify(M.lineModelNamesOfLine(10, kFx2)) === JSON.stringify(['X1', 'X2', 'X10']),
    '自然序而非字典序（X2 < X10）', M.lineModelNamesOfLine(10, kFx2));
  ok(M.lineModelNamesOfLine(999, kFx2).length === 0, '不存在的线体 → 空数组');
  ok(M.lineModelNamesOfLine(1, []).length === 0, '空夹具列表 → 空数组');
  ok(M.lineModelNamesOfLine('1', kFx2).length === 2, '线体 id 传字符串也能匹配（内部 Number 归一）');
  ok(M.lineModelNamesOfLine(1, [{ id: 9, lines: '1', lineModels: ['A'] }]).length === 0,
    'lines 非数组时安全跳过（不抛错）');
  ok(M.lineModelNamesOfLine(1, [{ id: 9, lines: [1], lineModels: null }]).length === 0,
    'lineModels 为 null 时安全跳过');

  section('K2. lineNamesOfModel（机种 → 线体，去重 + 自然序）');
  ok(JSON.stringify(M.lineNamesOfModel('DH38YE3', kFx2, kLines2)) === JSON.stringify(['L1 总装线', 'L2 U型线']),
    'DH38YE3 → L1 / L2（同一线体多套夹具只出现一次）', M.lineNamesOfModel('DH38YE3', kFx2, kLines2));
  ok(JSON.stringify(M.lineNamesOfModel('DH40MC', kFx2, kLines2)) === JSON.stringify(['L1 总装线']),
    'DH40MC → L1', M.lineNamesOfModel('DH40MC', kFx2, kLines2));
  ok(M.lineNamesOfModel('孤儿机种', kFx2, kLines2).length === 0,
    '夹具未关联产线 → 空数组（该机种没有线体）');
  ok(M.lineNamesOfModel('  DH38YE3  ', kFx2, kLines2).length === 2,
    '机种名首尾空白被 trim 后仍能匹配');
  ok(M.lineNamesOfModel('', kFx2, kLines2).length === 0, '空机种名 → 空数组');
  ok(M.lineNamesOfModel('不存在', kFx2, kLines2).length === 0, '未使用的机种 → 空数组');
  ok(JSON.stringify(M.lineNamesOfModel('X2', kFx2, [{ id: 10, name: 'L10 线' }])) === JSON.stringify(['L10 线']),
    '线体字典只给 1 条时另一条失效 id 被忽略');
  ok(M.lineNamesOfModel('X2', [{ id: 104, lines: [10, 999], lineModels: ['X2'] }], [{ id: 10, name: 'L10 线' }]).length === 1,
    '夹具引用了已删除线体 id（999）→ 忽略，不显示幽灵线体');

  section('K3. 两列互为逆关系（同一份夹具数据）');
  const kLineNames = kLines2.map((l) => l.name);
  const kAllModelsOfL1 = M.lineModelNamesOfLine(1, kFx2);
  ok(kAllModelsOfL1.every((m) => M.lineNamesOfModel(m, kFx2, kLines2).indexOf('L1 总装线') >= 0),
    'L1 上的每个机种，反查都包含 L1（双向一致）');
  ok(kLineNames.filter((n) => M.lineNamesOfModel('DH38YE3', kFx2, kLines2).indexOf(n) >= 0).length === 2,
    'DH38YE3 的线体集合与 L1/L2 上出现 DH38YE3 的事实一致');

  section('K4. slashCell（多值渲染：/ 分隔 + 悬停看全 + 空值破折号）');
  ok(M.slashCell(['A', 'B']).indexOf('A / B') >= 0, '两个值 → 以「 / 」拼接', M.slashCell(['A', 'B']));
  ok(M.slashCell(['A', 'B']).indexOf('title="A / B"') >= 0, '完整文本放进 title（列变窄也能悬停看全）');
  ok(M.slashCell([]).indexOf('—') >= 0, '空数组 → 破折号', M.slashCell([]));
  ok(M.slashCell(null).indexOf('—') >= 0, 'null → 破折号');
  ok(M.slashCell(['<b>', '&']).indexOf('&lt;b&gt;') >= 0, '值经过 HTML 转义（防注入）', M.slashCell(['<b>', '&']));

  section('K5. 静态守卫（两处表格已挂上新列）');
  const appSrc = src;
  ok(/<th style="width:210px">机种名称<\/th>/.test(appSrc), '产线配置表头含「机种名称」列');
  ok(/<td>\$\{slashCell\(lineModelNamesOfLine\(l\.id\)\)\}<\/td>/.test(appSrc),
    '产线配置单元格调用 lineModelNamesOfLine（无副作用的纯派生）');
  ok(/<th style="width:210px">线体<\/th>/.test(appSrc), '机种管理表头含「线体」列');
  ok(/<td>\$\{slashCell\(lineNamesOfModel\(p\.name\)\)\}<\/td>/.test(appSrc),
    '机种管理单元格调用 lineNamesOfModel');
  ok(/派生值/.test(appSrc) && /不单独存储/.test(appSrc), '两处表格下方都有「派生值 / 不单独存储」说明');
  ok(!/lineModels\s*:.*新增/.test(appSrc), '未给夹具或机种新增存储字段');
  const cssSrc = fs.readFileSync(path.join(__dirname, 'css', 'style.css'), 'utf8');
  ok(/\.slash-text\s*\{/.test(cssSrc), 'CSS 提供 .slash-text（长清单自动换行不撑爆表格）');

  /* ---------- L. BUG-012：机种筛选大小写不敏感 + 精确匹配（v5.2.1）----------
   * 产线使用页下拉值是大写原始值（如 DH40MC），旧实现传给 lineModelsMatch 做
   * includes ⇒ 库里值经 toLowerCase 变小写后 .includes('DH40MC') 恒 false ⇒ 恒 0 条。
   * 修复：函数内部统一 normModelName；下拉筛选改精确等值（防 DH40 命中 DH40MC）。 */
  section('L. 机种筛选修复（BUG-012，v5.2.1）');
  const lf1 = { id: 1, serialNo: 'DH40MC-921-001-001', name: '总成夹具A', status: 'stocked',
                lineModels: ['DH40MC', 'DH40SC', 'KH540'], lines: [1] };
  const lf2 = { id: 2, serialNo: 'DH38MC-921-005-001', name: '总成夹具B', status: 'stocked',
                lineModels: ['DH40MC', 'DH40SC', 'DH38YE3', 'KH540'], lines: [1] };
  const lfx = [lf1, lf2];

  // normModelName：去首尾空白 + 小写
  ok(M.normModelName(' DH40MC ') === 'dh40mc', 'normModelName 去空白并转小写', M.normModelName(' DH40MC '));
  ok(M.normModelName(null) === '', 'normModelName(null) → 空串');
  ok(M.normModelName(540) === '540', 'normModelName 数字也能归一');

  // lineModelsMatch（模糊包含）：大小写/空白不敏感
  ok(M.lineModelsMatch(lf1, 'DH40MC'), '大写查询能命中（旧 bug 在此为 false）', 'DH40MC');
  ok(M.lineModelsMatch(lf1, 'dh40mc'), '小写查询命中');
  ok(M.lineModelsMatch(lf1, ' KH540 '), '带空白查询命中');
  ok(!M.lineModelsMatch(lf1, 'ZZZ'), '不存在的机种不命中');
  ok(M.lineModelsMatch(lf1, ''), '空关键字视为不过滤（返回 true）');

  // lineModelsExact（精确等值，下拉用）
  ok(M.lineModelsExact(lf1, 'DH40MC'), '精确等值：含 DH40MC 命中');
  ok(M.lineModelsExact(lf1, 'dh40mc'), '精确等值：大小写不敏感');
  ok(!M.lineModelsExact(lf1, 'DH40'), '前缀不命中（DH40 不等于 DH40MC/DH40SC）');
  ok(!M.lineModelsExact(lf1, '40MC'), '中段不命中（防包含误匹配）');
  ok(M.lineModelsExact(lf1, 'KH540'), '多个机种中任一精确命中即可');
  ok(M.lineModelsExact(lf2, 'DH38YE3'), '第 2 套独有 DH38YE3 命中');
  ok(!M.lineModelsExact(lf1, 'DH38YE3'), '第 1 套不含 DH38YE3 不命中（对照，1 套）');

  // 模拟 lineQueryRows 的下拉筛选逻辑：线体 1 + 选机种 DH38YE3 → 只 1 套
  const pickExact = (name) => lfx.filter((f) => M.lineModelsExact(f, name));
  ok(pickExact('DH40MC').length === 2, '线体1 选 DH40MC → 2 套（两套都含）', pickExact('DH40MC').length);
  ok(pickExact('DH38YE3').length === 1, '线体1 选 DH38YE3 → 1 套（仅 B）', pickExact('DH38YE3').length);
  ok(pickExact('DH1826DA').length === 0, '线体1 选 DH1826DA → 0 套（该线确实没有）', pickExact('DH1826DA').length);

  // 静态守卫：lineQueryRows 已改用精确匹配；函数内部归一（不再依赖调用方）
  ok(/function lineModelsMatch\(f, q\) \{[\s\S]*?normModelName\(q\)/.test(src),
    'lineModelsMatch 内部对 q 做 normModelName 归一（不依赖调用方）');
  ok(/lineQueryRows\(\) \{[\s\S]*?rows\.filter\(\(f\) => lineModelsExact\(f, lineModel\)\)/.test(src),
    'lineQueryRows 的下拉筛选改用 lineModelsExact（精确等值）');
  ok(/renderLineQuery\(\) \{[\s\S]*?modelSorted\.indexOf\(q\.lineModel\) < 0\) q\.lineModel = ''/.test(src),
    '选中机种已从选项消失时自动复位 lineModel（防界面与结果脱节）');

  /* ---------- 收尾 ---------- */
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n==================================================');
  console.log('测试汇总：通过 ' + pass + ' / 失败 ' + fail);
  if (fail) { console.log('（有失败项，见上方 ✗）'); }
  console.log('==================================================');
  process.exit(fail ? 1 : 0);
})();
