'use strict';
/* ============================================================
 * test_line.js — 产线 / 工位 / 机种 模块测试（v4.0.0）
 *
 * v4.0.0 变更要点（本测试据此重写）：
 *   • `stationFixtures` 集合整体废弃 → COLLECTIONS 6 → 5 项
 *   • `products{lineId}` → `productions{id,name,order}`（机种不隶属产线）
 *   • 「夹具 ↔ 产线 / 工位」扁平进夹具记录：`fixtures.lines[] / fixtures.stations[]`
 *   • buildStationRows(stations, fixtures) 签名变更（从夹具全表反查，不再按产品筛选）
 *   • 产线导入表头 8 列 → 6 列（去掉产品两列），「夹具编号」列语义变为**实物编号**，
 *     写库为**追加 + 去重**（绝不覆盖）
 *   • 新增撤销接口 removeFixtureLine / removeFixtureStation / removeFixtureLinesByBatch
 *   • 新增「按机种查询」纯函数 buildProdQueryRows
 *
 * 分区：
 *   A. 数据层（store：新集合 CRUD / 派生数量 / 级联删除 / 落盘）
 *   B. 线体形态
 *   C. 工位排序
 *   D. buildStationRows 工位夹具配置表（v4 新签名）
 *   E. computeLineLayout / lineLayoutPoints 产线图布局
 *   F. renderLineDiagram 产线图渲染
 *   G. 产线导入映射与计划（v4 六列表头 / 追加去重 / 上限拦截）
 *   H. 端到端：plan → applyLineImportPlan（真实 store）→ 读回校验 + 重复导入幂等
 *   I. 撤销接口（removeFixtureLine / removeFixtureStation / removeFixtureLinesByBatch）
 *   J. buildProdQueryRows（按机种查询）
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
  slice('function formatLineModels(f, emptyMark', 'function fullLineModels'),
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
  state: { fixtures: [], fixTransactions: [], lines: [], productions: [], stations: [] },
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
  lineTypeLabel, lineTypeKey, parseLineType, sortStations, buildStationRows,
  fixturesOfLine, fixturesOnStation, computeLineLayout, lineLayoutPoints, stationsOfLine,
  renderLineDiagram, stationLabel, lineDiagramHeight, lineDiagramWidth, svgTextWidth,
  fixtureBadgeText, sideGap: LD_GAP, near: LD_CODE_NEAR, far: LD_CODE_FAR, mapLineImportHeader, buildLineImportPlan, applyLineImportPlan,
  buildProdQueryRows, buildProdDetailRows, isValidLocation, isValidSerialNo, isValidProductionName,
  LINE_IMPORT_HEADERS, MAX_LINES, MAX_STATIONS, MAX_LINE_MODELS
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
  sandbox.state.stations = store.getAll('stations');
}

console.log('=== 产线 / 工位 / 机种 模块测试（v4.0.0）===');

/* ============ A. 数据层 ============ */
section('A. 数据层（store：集合清单 / CRUD / 派生数量 / 级联删除 / 落盘）');
ok(store.COLLECTIONS.join(',') === 'fixtures,fixTransactions,lines,productions,stations',
  'COLLECTIONS 已收窄为 5 项（stationFixtures 已移除）', store.COLLECTIONS);
ok(store.setStationFixtures === undefined, 'setStationFixtures（v3 一对多绑定接口）已删除');
ok(store.productsOfLine === undefined && store.delProduct === undefined, '旧 products 相关接口已删除');

const l1 = store.add('lines', { name: 'L1 总装线', type: 'linear', remark: '' });
const l2 = store.add('lines', { name: 'L2 U型线', type: 'u', remark: '' });
const p1 = store.add('productions', { name: '机种甲', order: 1 });
const p2 = store.add('productions', { name: '机种乙', order: 2 });
const s1 = store.add('stations', { lineId: l1, seq: 10, name: '上料工位' });
const s2 = store.add('stations', { lineId: l1, seq: 20, name: '压装工位' });
const s3 = store.add('stations', { lineId: l2, seq: 10, name: '环形工位一' });

ok(store.getAll('lines').length === 2, 'lines 写入 2 条', store.getAll('lines').length);
ok(store.getAll('productions').length === 2, 'productions 写入 2 条（无 lineId 字段）');
ok(store.getAll('productions').every((p) => p.lineId === undefined), 'productions 不隶属产线（无 lineId）');
ok(store.getAll('stations').length === 3, 'stations 写入 3 条');
ok(new Set([l1, l2, p1, p2, s1, s2, s3]).size === 7, 'id 互不相同');

/* 夹具建档（lines / stations 扁平字段；同实物编号可多套） */
const fx1 = store.add('fixtures', {
  serialNo: 'DH40MC-921-001-001', name: '定位销压板', lineModels: ['机种甲', '机种乙'],
  lines: [l1], stations: [s1], location: 'ZP1-U-1-1', category: '冲压'
});
const fx2 = store.add('fixtures', {
  serialNo: 'DH40MC-921-001-001', name: '定位销压板', lineModels: ['机种甲'],
  lines: [l1], stations: [s1, s2], location: 'ZP1-U-1-2', category: '冲压'
});
ok(store.getAll('fixtures').length === 2, '同实物编号写入 2 套夹具（允许重复）');
const codes = store.getAll('fixtures').map((f) => String(f.code));
ok(codes.every((c) => /^\d{4}$/.test(c)), '序号为 4 位纯数字且自动分配', codes);
ok(new Set(codes).size === 2, '序号唯一');

/* 数量为派生值，不落库 */
ok(store.stockCountBySerial('DH40MC-921-001-001') === 2, '在库套数 = 按实物编号分组计数', store.stockCountBySerial('DH40MC-921-001-001'));
ok(store.stockCountBySerial('DH40MC-921-001-001', 'ZP1-U-1-1') === 1, '按实物编号 + 库位计数', store.stockCountBySerial('DH40MC-921-001-001', 'ZP1-U-1-1'));
ok(fixById(fx1).qty === undefined && fixById(fx1).quantity === undefined, '夹具记录无 qty/quantity 存储字段');

const file = path.join(tmpDir, 'fixture-data.json');
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
ok(['fixtures', 'fixTransactions', 'lines', 'productions', 'stations'].every((k) => Array.isArray(raw[k])),
  'JSON 落盘含全部 5 个集合', Object.keys(raw));
ok(raw.stationFixtures === undefined, '落盘文件不含 stationFixtures');

/* 机种删除保护 + 改名写穿 */
let delErr = null;
try { store.del('productions', p1); } catch (e) { delErr = e; }
ok(delErr && delErr.name === 'ConstraintError' && /仍被/.test(delErr.message), '被引用机种禁止删除（ConstraintError）', delErr && delErr.message);
ok(store.getAll('productions').length === 2, '删除失败后机种数量不变');
const swept = store.renameProduction(p1, '机种甲改');
ok(swept === 2, '机种改名批量写穿 fixtures.lineModels（2 条）', swept);
ok(store.getAll('fixtures').every((f) => !(f.lineModels || []).includes('机种甲')), '旧名已完全替换');
ok(store.getAll('fixtures').filter((f) => (f.lineModels || []).includes('机种甲改')).length === 2, '新名已写入');

/* 级联删除：删工位 → 从夹具 stations 摘除 */
store.del('stations', s2);
ok(fixById(fx2).stations.indexOf(s2) < 0, '删工位 → 夹具 stations 级联摘除', fixById(fx2).stations);
ok(fixById(fx2).lines.indexOf(l1) >= 0, '删工位不影响所属产线', fixById(fx2).lines);

/* 级联删除：删产线 → 连同其工位一起从夹具上摘除 */
store.del('lines', l2);
ok(store.getAll('lines').every((x) => x.id !== l2), '删产线：产线已移除');
ok(store.getAll('stations').every((x) => x.lineId !== l2), '删产线：工位级联移除');
ok(store.getAll('stations').some((x) => x.id === s1), '删产线：其他产线的工位保留');
ok(fixById(fx1).lines.indexOf(l2) < 0, '删产线：夹具 lines 已摘除该线（本例原本未关联，仅验证不报错）');

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

/* ============ C. 工位排序 ============ */
section('C. 工位排序');
const sts = [
  { id: 1, name: 'B工位', seq: 10 },
  { id: 2, name: 'A工位', seq: 2 },
  { id: 3, name: 'C工位', seq: null },
  { id: 4, name: 'D工位', seq: '30' }
];
const sorted = M.sortStations(sts);
ok(sorted.map((s) => s.name).join(',') === 'A工位,B工位,D工位,C工位',
  'seq 数值升序（2 < 10 < 30），无 seq 置末尾', sorted.map((s) => s.name));
ok(sts[0].name === 'B工位', '排序不改动原数组顺序（返回新数组）', sts[0].name);
const sameSeq = M.sortStations([{ name: '工位10', seq: 5 }, { name: '工位9', seq: 5 }]);
ok(sameSeq.map((s) => s.name).join(',') === '工位9,工位10', '同 seq 按名称自然序（9 < 10）', sameSeq.map((s) => s.name));
ok(M.sortStations([]).length === 0, '空数组安全');
ok(M.sortStations(null).length === 0, 'null 安全');
const withUndef = M.sortStations([{ name: 'X', seq: undefined }, { name: 'Y', seq: 1 }]);
ok(withUndef[0].name === 'Y', 'seq 为 undefined 也置末尾（不被当作 0）', withUndef.map((s) => s.name));
const crossLine = M.sortStations([{ id: 5, lineId: 2, name: 'E工位', seq: 5 }, { id: 6, lineId: 1, name: 'F工位', seq: 5 }]);
ok(crossLine.map((s) => s.name).join(',') === 'E工位,F工位' && crossLine.map((s) => s.lineId).join(',') === '2,1',
  '同 seq 跨产线同名序时仍按名称自然序（与所属产线无关）', crossLine.map((s) => s.name + '@' + s.lineId));

/* ============ D. buildStationRows（v4 新签名） ============ */
section('D. buildStationRows 工位夹具配置表（v4：从夹具全表反查）');
const dStations = [
  { id: 10, lineId: 1, name: '上料工位', seq: 10 },
  { id: 20, lineId: 1, name: '压装工位', seq: 20 },
  { id: 30, lineId: 1, name: '空工位', seq: null }
];
const dFixtures = [
  { id: 1, code: '2001', serialNo: 'SN-B', name: '焊接夹具', status: 'stocked', lineModels: ['M1', 'M2'], lines: [1], stations: [10, 20] },
  { id: 2, code: '2002', serialNo: 'SN-A', name: '定位销压板', status: 'checked_out', lineModels: [], lines: [1, 2], stations: [20] },
  { id: 3, code: '2003', serialNo: '', name: '装配工装', status: 'stocked', lineModels: ['M3'], lines: [2], stations: [] }
];
const rows = M.buildStationRows(dStations, dFixtures);
ok(rows.length === 3, '三个工位 → 三行', rows.length);
ok(rows.map((r) => r.station.name).join(',') === '上料工位,压装工位,空工位',
  '按工位顺序排列（seq 10 → 20 → 无 seq 置末尾）', rows.map((r) => r.station.name));
ok(rows[0].fixtures.map((f) => f.code).join(',') === '2001', '上料工位 1 个夹具', rows[0].fixtures.map((f) => f.code));
ok(rows[1].fixtures.length === 2, '压装工位 2 个夹具（从夹具 stations 反查）', rows[1].fixtures.length);
ok(rows[1].fixtures.map((f) => f.serialNo).join(',') === 'SN-A,SN-B',
  '夹具按实物编号排序（SN-A < SN-B）', rows[1].fixtures.map((f) => f.serialNo));
ok(rows[1].fixtures[0].name === '定位销压板', '回填夹具名称');
ok(rows[1].fixtures[0].status === 'checked_out', '回填状态');
ok(rows[1].fixtures[1].spec === 'M1 / M2', '回填规格（机种拼接）', rows[1].fixtures[1].spec);
ok(rows[1].fixtures[0].spec === '', '无机种时 spec 为空串（不是「—」）', rows[1].fixtures[0].spec);
ok(rows[1].fixtures[0].id === 2 && typeof rows[1].fixtures[0].id === 'number', '带出夹具 id（用于「编辑夹具」跳转）');
ok(rows[2].fixtures.length === 0, '无夹具的工位 fixtures 为空数组', rows[2].fixtures);
ok(rows[2].fixtures, '空数组而非 undefined（渲染显示「— / 无」）');

/* 边界：夹具集合异常 */
ok(M.buildStationRows(dStations, []).every((r) => r.fixtures.length === 0), '夹具集合为空时全部无配置');
ok(M.buildStationRows(dStations, null).every((r) => r.fixtures.length === 0), '夹具集合为 null 时安全');
ok(M.buildStationRows([], dFixtures).length === 0, '工位集合为空 → 零行');
ok(M.buildStationRows(null, dFixtures).length === 0, '工位集合为 null → 零行');
ok(M.buildStationRows([{ id: 99, name: 'X', seq: 1 }], [{ id: 9, serialNo: 'S', stations: [99] }])[0].fixtures.length === 0,
  '无 code 的脏记录被过滤（不渲染空编号）');
ok(M.buildStationRows([{ id: 99, name: 'X', seq: 1 }], [{ id: 9, code: '9', stations: null }])[0].fixtures.length === 0,
  'stations 非数组时安全');
ok(M.buildStationRows([{ id: 99, name: 'X', seq: 1 }], [{ id: 9, code: '9', stations: ['99'] }])[0].fixtures.length === 1,
  'stations 内字符串 id 也能命中（Number 归一）');

/* fixturesOfLine / fixturesOnStation（读 state） */
sandbox.state.fixtures = dFixtures;
ok(M.fixturesOfLine(1).length === 2, 'fixturesOfLine(1) → 2 套', M.fixturesOfLine(1).map((f) => f.code));
ok(M.fixturesOfLine(2).length === 2, 'fixturesOfLine(2) → 2 套（含跨产线夹具）', M.fixturesOfLine(2).map((f) => f.code));
ok(M.fixturesOfLine(3).length === 0, 'fixturesOfLine(不存在的产线) → 0 套');
ok(M.fixturesOnStation(20).map((f) => f.serialNo).join(',') === 'SN-A,SN-B', 'fixturesOnStation 按实物编号排序', M.fixturesOnStation(20).map((f) => f.serialNo));
ok(M.fixturesOnStation(30).length === 0, '未安装夹具的工位 → 0 套');
ok(M.stationsOfLine(dStations, 1).length === 3, 'stationsOfLine 返回该线全部工位（已排序）', M.stationsOfLine(dStations, 1).length);
sandbox.state.fixtures = [];

/* ============ E. 产线图布局 ============ */
section('E. computeLineLayout / lineLayoutPoints 产线图布局');
ok(M.computeLineLayout(0, 'linear').length === 0, '0 个工位 → 空布局');
ok(M.computeLineLayout(-1, 'linear').length === 0, '负数 → 空布局');
ok(M.computeLineLayout(5, 'linear').length === 5, '直线形：N 个点');
const lin5 = M.computeLineLayout(5, 'linear');
ok(lin5.every((p) => p.y === lin5[0].y), '直线形 5 个工位在同一行（y 相同）', lin5.map((p) => p.y));
ok(lin5[0].x < lin5[4].x, '直线形从左到右排布');
const lin8 = M.computeLineLayout(8, 'linear');
ok(new Set(lin8.map((p) => p.y)).size === 2, '直线形 8 个工位折成 2 行', lin8.map((p) => p.y));
const lin7 = M.computeLineLayout(7, 'linear', 7);
ok(new Set(lin7.map((p) => p.y)).size === 1, 'perRow=7 时 7 个工位一行放下');
/* U 型：左上角起 → 沿左侧竖边下行 → 底部横边右移 → 沿右侧竖边上行 → 右上角止 */
const u4 = M.computeLineLayout(4, 'u');
ok(u4.length === 4, 'U型：N 个点');
ok(u4[0].x < 0.5 && u4[0].y < 0.5, 'U型首点在左上角', u4[0]);
ok(u4[3].x > 0.5 && u4[3].y < 0.5, 'U型末点在右上角', u4[3]);
ok(u4[0].x < u4[3].x, 'U型左右两侧分居画布左右');
const u6 = M.computeLineLayout(6, 'u');
ok(u6.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1), 'U型坐标均在 0~1 内');
ok(Math.abs(u6[0].x - u6[1].x) < 1e-9 && u6[1].y > u6[0].y, 'U型左侧竖边：x 相同、y 递增');
ok(Math.abs(u6[4].x - u6[5].x) < 1e-9 && u6[4].y > u6[5].y, 'U型右侧竖边：x 相同、y 递减');
ok(Math.abs(u6[2].y - u6[3].y) < 1e-9 && u6[2].x < u6[3].x, 'U型底部横边：y 相同、x 递增');
ok(Math.abs(u6[0].y - u6[5].y) < 1e-9, 'U型两端等高（左右顶点同一水平线）');
ok(M.lineLayoutPoints(6).length === 6, 'lineLayoutPoints 直接调用返回 N 个点');
ok(M.computeLineLayout(6, 'u').map((p) => p.x.toFixed(6) + '|' + p.y.toFixed(6)).join(';')
  === M.lineLayoutPoints(6).map((p) => p.x.toFixed(6) + '|' + p.y.toFixed(6)).join(';'),
  'U 型布局与 lineLayoutPoints 完全一致（共用同一套几何常量）');
ok(M.computeLineLayout(1, 'u').length === 1, 'U型单工位也能布点');
ok(M.computeLineLayout(2, 'u').length === 2, 'U型 2 工位布点正常');
ok(M.computeLineLayout(9, 'u').every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1), 'U型 9 工位坐标不越界');
ok(M.computeLineLayout(6, 'loop').every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1),
  '历史 loop 数据按 U型布局，坐标不越界');
ok(M.computeLineLayout(5, 'weird').every((p) => p.y === M.computeLineLayout(5, 'linear')[0].y),
  '未知形态按直线形处理');

/* ============ F. 产线图渲染 ============ */
section('F. renderLineDiagram 产线图渲染');
const svgStations = [{ id: 10, lineId: 1, name: '上料工位', seq: 10 }, { id: 20, lineId: 1, name: '压装工位', seq: 20 }];
const rowsForSvg = M.buildStationRows(svgStations, [
  { id: 1, code: '2001', serialNo: 'SN-X', name: '焊接夹具', status: 'stocked', lineModels: ['M1'], lines: [1], stations: [20] }
]);
const lineObj = { name: 'L1 总装线', type: 'linear' };
const svg = M.renderLineDiagram(lineObj, rowsForSvg);
ok(svg.includes('L1 总装线'), '图内包含线体名');
ok(svg.includes('直线形产线示意图'), '图标题含形态名');
ok(svg.includes('ld-on'), '有夹具的工位高亮（ld-on）');
ok(svg.includes('ld-off'), '无夹具的工位不加高亮（ld-off）');
ok(svg.includes('SN-X'), '节点徽标显示实物编号', svg.match(/ld-code[^>]*>([^<]*)</g));
ok(svg.includes('>无<'), '无配置的工位标注「无」');
ok(svg.includes('<line'), '直线形使用折线轨迹');
const svgNoSerial = M.renderLineDiagram(lineObj, M.buildStationRows(svgStations, [
  { id: 1, code: '2001', serialNo: '', name: '焊接夹具', status: 'stocked', lineModels: [], lines: [1], stations: [20] }
]));
ok(svgNoSerial.includes('>2001<'), '无夹具编号时徽标退回「序号」纯数字', svgNoSerial.match(/ld-code[^>]*>([^<]*)</g));
ok(!svgNoSerial.includes('#2001'), '徽标序号不带 # 前缀');
const svgU = M.renderLineDiagram({ name: 'L2', type: 'u' }, rowsForSvg);
ok(svgU.includes('<polyline'), 'U型使用折线轨迹');
ok(svgU.includes('U型产线示意图'), 'U型图标题含形态名');
ok(!svgU.includes('<ellipse'), 'U型不再使用椭圆轨迹');
ok((svgU.match(/class="ld-track"/g) || []).length === 1, 'U型只有一条轨迹线（三边连成折线）');
const svgLegacy = M.renderLineDiagram({ name: 'L2', type: 'loop' }, rowsForSvg);
ok(svgLegacy.includes('<polyline') && svgLegacy.includes('U型产线示意图'),
  '历史 loop 数据仍按 U型绘制且标题显示 U型');
ok(M.renderLineDiagram(lineObj, []) === '<div class="empty-tip">该线体尚未配置工位</div>', '无工位 → 空态提示');
ok(M.renderLineDiagram(null, rowsForSvg) === '<div class="empty-tip">该线体尚未配置工位</div>', '无线体 → 空态提示');
const svgEsc = M.renderLineDiagram({ name: '<script>x</script>', type: 'linear' }, [
  { station: { name: '3号工位' }, seq: 1, fixtures: [{ id: 9, code: '99', serialNo: 'A&B<X>', name: '<b>夹具</b>', status: 'stocked' }] }
]);
ok(!svgEsc.includes('<script>') && svgEsc.includes('&lt;script&gt;'), '线体名做 HTML 转义');
ok(svgEsc.includes('A&amp;B&lt;X&gt;'), '夹具编号做 HTML 转义');
ok(!svgEsc.includes('<b>夹具</b>'), '悬浮提示中的夹具名做 HTML 转义');
ok(svg.includes('ld-name') && !svg.includes('ld-seq'), '圆圈上方显示工位名，圆圈内不再写顺序号');

/* v4.0.7：圆圈上方＝工位名、下方＝夹具号，两者基线间距 ≥24px（沿用 v4.0.6 拉开距离的要求）。 */
const mNameY = svg.match(/<text x="[\d.]+" y="([\d.]+)" text-anchor="middle" class="ld-name">/);
const mCodeY = svg.match(/<text x="[\d.]+" y="([\d.]+)" text-anchor="middle" class="ld-code/);
ok(mNameY && mCodeY && Number(mCodeY[1]) - Number(mNameY[1]) >= 24,
  '工位名（圆上）与夹具编号（圆下）垂直间距 ≥24px',
  mNameY && mCodeY ? `name y=${mNameY[1]}, code y=${mCodeY[1]}` : '');
const circY = svg.match(/<circle cx="[\d.]+" cy="([\d.]+)" r="19"/);
ok(circY && mNameY && Number(mNameY[1]) < Number(circY[1]), '工位名基线在圆圈上方');
ok(circY && mCodeY && Number(mCodeY[1]) > Number(circY[1]), '夹具编号基线在圆圈下方');

/* 工位名简化：一律「N号工位」，去掉「X号线」前缀（线体名已在标题显示） */
ok(M.stationLabel({ name: '1号线3号工位' }, 1) === '3号工位', '「1号线3号工位」→「3号工位」');
ok(M.stationLabel({ name: '4号工位' }, 2) === '4号工位', '「4号工位」保持不变');
ok(M.stationLabel({ name: '4工位' }, 3) === '4号工位', '「4工位」补全为「4号工位」');
ok(M.stationLabel({ name: '1号线20号工位' }, 4) === '20号工位', '两位数工位号正确解析');
ok(M.stationLabel({ name: 'OP-10 装配' }, 5) === '5号工位', '名称无数字时退回顺序号');
ok(M.stationLabel({ name: 'OP-10 装配', seq: 8 }, 5) === '8号工位', '有 seq 时优先用 seq');
ok(M.stationLabel(null, 7) === '7号工位', '空工位用列表位置兜底');
const svgLabel = M.renderLineDiagram({ name: '1号线', type: 'linear' }, [
  { station: { name: '1号线3号工位' }, seq: 1, fixtures: [] },
  { station: { name: '4工位' }, seq: 2, fixtures: [] }
]);
ok(svgLabel.includes('>3号工位<') && svgLabel.includes('>4号工位<'), '图内工位名统一为「N号工位」');
ok(!/>1号线3号工位</.test(svgLabel), '图内工位名不再带「X号线」前缀');

/* v4.0.7 画布高度自适应：节点纵向跨度 74px，按「最小间距 ≥100px」反推高度，
 * 保证行/列间距不会小于 74px（否则圆上工位名会贴到上一行的夹具号）。 */
const mkRows = (n) => Array.from({ length: n }, (_, i) => ({
  station: { id: i + 1, name: (i + 1) + '号工位' }, seq: i + 1,
  fixtures: i % 3 === 0 ? [] : [{ id: 300 + i, code: String(3001 + i), serialNo: 'SN-' + i, name: '夹具' + i, status: 'stocked' }]
}));
/* 从 SVG 解析「圆上 label → 圆」与「圆 → 圆下 code」的纵向跨度，以及相邻行/列的最小间隙 */
function diagramMetrics(type, n) {
  const svgN = M.renderLineDiagram({ name: 'LX', type }, mkRows(n));
  const H = +svgN.match(/viewBox="0 0 \d+ (\d+)"/)[1];
  const lb = [...svgN.matchAll(/<text x="([\d.]+)" y="(-?[\d.]+)"[^>]*class="ld-name"/g)].map((a) => ({ x: +a[1], y: +a[2] }));
  const cd = [...svgN.matchAll(/<text x="([\d.]+)" y="(-?[\d.]+)"[^>]*class="ld-code/g)].map((a) => ({ x: +a[1], y: +a[2] }));
  const cy = [...svgN.matchAll(/<circle cx="[\d.]+" cy="([\d.]+)"/g)].map((a) => +a[1]);
  let gap = Infinity;
  for (let i = 0; i < cd.length; i++) {
    for (let j = 0; j < lb.length; j++) {
      if (i === j || Math.abs(lb[j].x - cd[i].x) > 1) continue;   // 同列才比较（底部横排节点 x 不同）
      const d = lb[j].y - cd[i].y;
      if (d > 0 && d < gap) gap = d;
    }
  }
  const ys = lb.map((l) => l.y).concat(cd.map((c) => c.y));
  return { H, gap, minY: Math.min(...ys), maxY: Math.max(...ys), aboveOk: lb.every((l, i) => l.y < cy[i] && cd[i].y > cy[i]) };
}
[[3, 'linear'], [4, 'linear'], [7, 'linear'], [19, 'linear']].forEach(([n, t]) => {
  const mm = diagramMetrics(t, n);
  const tag = `${t} ${n}工位`;
  ok(mm.aboveOk, tag + '：工位名在圆上、夹具号在圆下');
  ok(mm.gap >= 25.9, tag + '：上下相邻行/列文字间隙 ≥26px', mm.gap === Infinity ? 'n/a' : mm.gap.toFixed(1));
  ok(mm.minY >= 0 && mm.maxY <= mm.H, tag + `：文字不越出画布（${mm.minY.toFixed(0)}~${mm.maxY.toFixed(0)} / H=${mm.H}）`);
});

/* ===== v4.1.0：U 型「工位名在内侧、夹具号在外侧」 =====
 * 逐个 <g class="ld-node"> 取出圆/名称/编号的位置与 text-anchor，
 * 「内侧」＝画布中心方向：左列内侧为右、右列内侧为左、底横边内侧为上。 */
function nodeBoxes(type, n) {
  const s = M.renderLineDiagram({ name: 'LX', type }, mkRows(n));
  const W = +s.match(/viewBox="0 0 (\d+)/)[1];
  const nodes = [...s.matchAll(/<g class="ld-node[\s\S]*?<\/g>/g)].map((m) => {
    const g = m[0];
    const c = g.match(/<circle cx="([\d.]+)" cy="([\d.]+)"/);
    const nm = g.match(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="(\w+)" class="ld-name">([^<]*)</);
    const cd = g.match(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="(\w+)" class="ld-code[^>]*>([^<]*)</);
    return {
      cx: +c[1], cy: +c[2],
      nx: +nm[1], ny: +nm[2], na: nm[3], ntxt: nm[4],
      fx: +cd[1], fy: +cd[2], fa: cd[3], ftxt: cd[4]
    };
  });
  return { W, nodes };
}
const ub = nodeBoxes('u', 15);
const mid = ub.W / 2;
const sideN = ub.nodes.filter((b) => Math.abs(b.ny - b.cy) <= 6);      // 左右竖列：名称与编号同基线
const bottomN = ub.nodes.filter((b) => Math.abs(b.ny - b.cy) > 6);     // 底横边：上下结构
ok(sideN.length + bottomN.length === ub.nodes.length && sideN.length > 0 && bottomN.length > 0,
  'U型节点分「竖列侧排」与「底横边上下排」两类', `side=${sideN.length}, bottom=${bottomN.length}`);
ok(sideN.every((b) => (b.nx - b.cx) * (mid - b.cx) > 0), 'U型竖列：工位名在圆的内侧（朝画布中心）');
ok(sideN.every((b) => (b.fx - b.cx) * (mid - b.cx) < 0), 'U型竖列：夹具号在圆的外侧（背离画布中心）');
ok(sideN.every((b) => (b.na === 'start') === (b.nx > b.cx)), 'U型竖列：工位名锚点朝远离圆的方向展开');
ok(sideN.every((b) => (b.fa === 'start') === (b.fx > b.cx)), 'U型竖列：夹具号锚点朝远离圆的方向展开');
ok(sideN.every((b) => Math.abs(b.nx - b.cx) > 19 && Math.abs(b.fx - b.cx) > 19), 'U型竖列：文字与圆之间留出间隙（不压圆）');
ok(bottomN.every((b) => b.ny < b.cy && b.fy > b.cy && b.na === 'middle'), 'U型底横边：工位名在圆上、夹具号在圆下');

/* 直线形不受影响：仍是圆上/圆下且居中 */
const lb0 = nodeBoxes('linear', 5).nodes;
ok(lb0.every((b) => b.na === 'middle' && b.fa === 'middle' && b.ny < b.cy && b.fy > b.cy),
  '直线形保持「圆上工位名 / 圆下夹具号、居中」不变');

/* ===== v4.1.0：位置不够就把示意图拉长 ===== */
const longRows = (n, serial) => Array.from({ length: n }, (_, i) => ({
  station: { id: i + 1, name: (i + 1) + '号工位' }, seq: i + 1,
  fixtures: [{ id: 900 + i, code: String(9001 + i), serialNo: serial, name: '夹具', status: 'stocked' }]
}));
const SN21 = 'SN-2024-0001-ABCDEFGH';   // 21 字，未触发 22 字截断
const wShort = +M.renderLineDiagram({ name: 'L', type: 'u' }, longRows(6, 'SN-1')).match(/viewBox="0 0 (\d+)/)[1];
ok(wShort === 1000, '短编号放得下时保持基准宽度 1000', 'W=' + wShort);
const svgWide = M.renderLineDiagram({ name: 'L', type: 'u' }, longRows(30, SN21));
const wWide = +svgWide.match(/viewBox="0 0 (\d+)/)[1];
ok(wWide > 1000, 'U型底横边工位多、编号长时画布自动拉长', 'W=' + wWide);
const bn = Math.max(1, Math.round(30 / 3));
const pitch = (0.56 * (wWide - 120)) / (bn - 1);   // v4.1.0 底排跨度收窄为 0.56
/* v4.1.0：底排编号上下错行 → 同一条基线上的相邻编号相隔 2 个节点间距 */
ok(pitch * 2 >= M.svgTextWidth(SN21, 11) + M.sideGap - 0.01,
  '底排编号错行后，同基线相邻编号间距（2 个节点间距）容得下编号文字', (pitch * 2).toFixed(1));

/* v4.1.0：底横排相邻夹具号标签上下错开，不共用一条基线（用户截图：编号首尾粘连） */
const botNodes = nodeBoxes2('u', 30, SN21).nodes.filter((b) => Math.abs(b.ny - b.cy) > 6);
const codeDy = botNodes.map((b) => Math.round(b.fy - b.cy));
ok(codeDy.every((d) => d === M.near || d === M.far), '底排编号只落在两档基线上（贴圆 / 下沉）',
  codeDy.slice(0, 6).join(','));
ok(codeDy.every((d, i) => i === 0 || d !== codeDy[i - 1]), '底排相邻编号不共用同一基线（上下错开）',
  codeDy.slice(0, 6).join(','));
ok(M.far - M.near === 20, '两条编号基线相差 20px（足够放下 11px 字号）', `${M.near}/${M.far}`);
const pitchB = (0.56 * (nodeBoxes2('u', 30, SN21).W - 120)) / (botNodes.length - 1);
ok(pitchB * 2 >= M.svgTextWidth(SN21, 11), '同基线相邻编号横向不粘连（间距 ≥ 字宽）',
  (pitchB * 2).toFixed(1) + ' vs ' + M.svgTextWidth(SN21, 11).toFixed(1));
const H30 = +M.renderLineDiagram({ name: 'LX', type: 'u' }, longRows(30, SN21)).match(/viewBox="0 0 \d+ (\d+)"/)[1];
ok(Math.max(...botNodes.map((b) => b.fy)) + 4 <= H30, '错行后的编号不越出画布底边',
  `${Math.max(...botNodes.map((b) => b.fy)).toFixed(0)} / H=${H30}`);
ok(/style="min-width:\d+px"/.test(svgWide) && /style="min-width:1000px"/.test(svgWide) === false,
  '拉长的画布带 min-width，避免整图被等比缩到看不清');
/* 文字不越出画布：按估算宽度还原每段文字的左右边界 */
function textBounds(type, n, serial) {
  const { W, nodes } = nodeBoxes2(type, n, serial);
  return nodes.map((b) => {
    const wN = M.svgTextWidth(b.ntxt, 12);
    const wF = M.svgTextWidth(b.ftxt, 11);
    const span = (x, w, anchor) => (anchor === 'middle' ? [x - w / 2, x + w / 2]
      : anchor === 'end' ? [x - w, x] : [x, x + w]);
    const [n1, n2] = span(b.nx, wN, b.na);
    const [f1, f2] = span(b.fx, wF, b.fa);
    return { W, min: Math.min(n1, f1), max: Math.max(n2, f2) };
  });
}
function nodeBoxes2(type, n, serial) {
  const s = M.renderLineDiagram({ name: 'LX', type }, longRows(n, serial));
  const W = +s.match(/viewBox="0 0 (\d+)/)[1];
  const nodes = [...s.matchAll(/<g class="ld-node[\s\S]*?<\/g>/g)].map((m) => {
    const g = m[0];
    const c = g.match(/<circle cx="([\d.]+)" cy="([\d.]+)"/);
    const nm = g.match(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="(\w+)" class="ld-name">([^<]*)</);
    const cd = g.match(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="(\w+)" class="ld-code[^>]*>([^<]*)</);
    return {
      cx: +c[1], cy: +c[2], nx: +nm[1], ny: +nm[2], na: nm[3], ntxt: nm[4],
      fx: +cd[1], fy: +cd[2], fa: cd[3], ftxt: cd[4]
    };
  });
  return { W, nodes };
}

const boundsU = textBounds('u', 30, SN21);
ok(boundsU.every((b) => b.min >= 0 && b.max <= b.W),
  'U型长编号文字不越出画布左右边界',
  boundsU.map((b) => `${b.min.toFixed(0)}~${b.max.toFixed(0)}`).slice(0, 3).join(' '));
const boundsL = textBounds('linear', 19, SN21);
ok(boundsL.every((b) => b.min >= 0 && b.max <= b.W), '直线形长编号文字不越出画布左右边界');
ok(M.lineDiagramHeight(6, 'linear') === 520, '单行布点沿用基准高度 520', M.lineDiagramHeight(6, 'linear'));
ok(M.lineDiagramHeight(19, 'linear') > 520, '4 行布点自动加高', M.lineDiagramHeight(19, 'linear'));
ok(M.lineDiagramHeight(15, 'u') > 520, 'U 型单列 5 工位自动加高', M.lineDiagramHeight(15, 'u'));

/* v4.1.0 转角守护（用户截图反馈）：底横排两端必须与左右竖列**同 x**，
 * 这样「5号→6号」「10号→11号」是竖直下落/上升，而不是斜线。
 * 原来底排铺 0.08→0.92，比竖列（0.22 / 0.78）还宽，两端只能斜连。 */
const cornerCases = [[6, 'u'], [9, 'u'], [15, 'u'], [21, 'u'], [30, 'u'], [33, 'u']];
cornerCases.forEach(([n]) => {
  const pts = M.computeLineLayout(n, 'u');
  const lefts = pts.filter((q) => q.seg === 'left');
  const bots = pts.filter((q) => q.seg === 'bottom');
  const rights = pts.filter((q) => q.seg === 'right');
  // 6 工位：底 2 / 左 2 / 右 2，三个段都非空
  ok(lefts.length > 0 && bots.length > 0 && rights.length > 0, `U型 ${n}工位：三段布点都非空`);
  if (bots.length > 1) {
    ok(Math.abs(lefts[lefts.length - 1].x - bots[0].x) < 1e-9,
      `U型 ${n}工位：左列末位与底排首位同 x（左转角竖直）`,
      `left=${lefts[lefts.length - 1].x.toFixed(2)}, bottom=${bots[0].x.toFixed(2)}`);
    ok(Math.abs(rights[0].x - bots[bots.length - 1].x) < 1e-9,
      `U型 ${n}工位：底排末位与右列首位同 x（右转角竖直）`,
      `bottom=${bots[bots.length - 1].x.toFixed(2)}, right=${rights[0].x.toFixed(2)}`);
  }
});

/* 渲染出的折线也要真竖直：取 15 工位（底 5 / 左 5 / 右 5），检查第 5→6、第 10→11 段 */
const uSvg15 = M.renderLineDiagram({ name: 'LX', type: 'u' }, mkRows(15));
const poly = uSvg15.match(/<polyline points="([^"]+)"/)[1].trim().split(/\s+/)
  .map((t) => t.split(',').map(Number));
const segV = (k) => Math.abs(poly[k][0] - poly[k + 1][0]) < 0.05 && Math.abs(poly[k][1] - poly[k + 1][1]) > 1;
ok(segV(4), '折线：第 5→6 段竖直（左转角）', `(${poly[4]})→(${poly[5]})`);
ok(segV(9), '折线：第 10→11 段竖直（右转角）', `(${poly[9]})→(${poly[10]})`);
ok(Math.abs(poly[5][1] - poly[6][1]) < 0.05, '折线：底横排 6→7 段水平');
ok((uSvg15.match(/class="ld-plate"/g) || []).length === 2, 'U型转角两个标签带白色垫底（连线不割字）',
  (uSvg15.match(/class="ld-plate"/g) || []).length);

const uPts = M.computeLineLayout(15, 'u');
const lastLeftY = Math.max(...uPts.filter((p) => p.seg === 'left').map((p) => p.y));
const bottomY = uPts.filter((p) => p.seg === 'bottom')[0].y;
ok(lastLeftY < bottomY - 0.1, 'U型竖列末端明显高于底横排（转角留白）', `col=${lastLeftY.toFixed(2)}, bottom=${bottomY.toFixed(2)}`);
ok(uPts.filter((p) => p.seg === 'bottom').every((q) => q.x >= 0.22 - 1e-9 && q.x <= 0.78 + 1e-9),
  'U型底横排收在左右竖列之间（0.22~0.78）');

/* ============ G. 产线导入映射与计划（v4） ============ */
section('G. 产线导入映射（v4 六列表头）');
ok(M.LINE_IMPORT_HEADERS.join(',') === '线体,线体形态,工位,工位顺序,夹具编号,备注',
  '标准表头为 6 列（产品两列已删）', M.LINE_IMPORT_HEADERS);
const idxStd = M.mapLineImportHeader(['线体', '线体形态', '工位', '工位顺序', '夹具编号', '备注']);
ok(idxStd.line === 0 && idxStd.lineType === 1 && idxStd.station === 2 && idxStd.seq === 3 && idxStd.fixtureSerial === 4 && idxStd.remark === 5,
  '标准表头映射正确', idxStd);
ok(idxStd.product === undefined && idxStd.productCode === undefined, '不再识别「产品 / 产品编号」列（products 已废除）');
const idxAlias = M.mapLineImportHeader(['产线', '形态', '工位号', '顺序', '编号']);
ok(idxAlias.line === 0 && idxAlias.lineType === 1 && idxAlias.station === 2 && idxAlias.seq === 3 && idxAlias.fixtureSerial === 4,
  '别名表头映射正确（编号 → 夹具编号/实物编号）', idxAlias);
ok(M.mapLineImportHeader(['实物编号']).fixtureSerial === 0, '「实物编号」→ fixtureSerial');
ok(M.mapLineImportHeader(['夹具编号']).fixtureSerial === 0, '「夹具编号」→ fixtureSerial（语义已反转，不再指序号）');
ok(M.mapLineImportHeader(['线体（必填）']).line === 0, '括号注释被忽略');
ok(M.mapLineImportHeader([]).line === undefined, '空表头安全');

section('G2. buildLineImportPlan');
/* 现有数据：L1 已存在 + 上料工位已存在；3 套已建档夹具 */
const gEx = {
  lines: [{ id: 1, name: 'L1 总装线', type: 'linear' }],
  stations: [{ id: 11, lineId: 1, name: '上料工位', seq: 10 }],
  fixtures: [
    { id: 1, code: '2001', serialNo: 'SN-A', lines: [], stations: [] },
    { id: 2, code: '2002', serialNo: 'SN-B', lines: [], stations: [] },
    { id: 3, code: '2003', serialNo: 'SN-C', lines: [], stations: [] }
  ]
};
const rowsOk = [
  ['线体', '线体形态', '工位', '工位顺序', '夹具编号', '备注'],
  ['L1 总装线', '直线形', '上料工位', '10', 'SN-A', ''],
  ['L1 总装线', '直线形', '压装工位', '20', 'SN-A', '同夹具第二个工位'],
  ['L1 总装线', '直线形', '压装工位', '20', 'SN-B', ''],
  ['L1 总装线', '直线形', '  ', '30', 'SN-B', '工位缺失应跳过'],
  ['L2 U型线', 'U型', '工位一', '10', 'SN-C', '']
];
const plan = M.buildLineImportPlan(rowsOk, gEx);
ok(plan.ok, '生成计划成功', plan.error);
ok(plan.newLines.length === 1 && plan.newLines[0].name === 'L2 U型线', '仅新建 1 条线体（L1 已存在）', plan.newLines.map((l) => l.name));
ok(plan.newLines[0].type === 'u', 'U型线体类型正确', plan.newLines[0].type);
ok(plan.newStations.length === 2, '新建 2 个工位（压装工位 + 工位一；上料工位复用）', plan.newStations.map((s) => s.lineName + '/' + s.name));
ok(plan.newStations.find((s) => s.name === '压装工位').seq === 20, '工位顺序写入为数字', plan.newStations.find((s) => s.name === '压装工位'));
ok(plan.appends.length === 4, '4 条追加关联（SN-A×2 / SN-B×1 / SN-C×1）', plan.appends.map((a) => a.serialNo + '@' + a.stationName));
ok(plan.appends[0].addLine === true && plan.appends[0].addStation === true, '首行：产线与工位都要新增', plan.appends[0]);
ok(plan.appends[1].addLine === false && plan.appends[1].addStation === true, '同夹具第二行：产线已在计划内（虚拟状态），只新增工位', plan.appends[1]);
ok(plan.appends.every((a) => typeof a.fixtureId === 'number' && a.code), '每条追加项带 fixtureId 与序号');
ok(plan.skipped.length === 1 && plan.skipped[0].row === 5 && /空缺/.test(plan.skipped[0].reason),
  '跳过第 5 行（工位为空，1-based 行号）', plan.skipped);

/* 已存在关联 → 无新增，已忽略 */
const gEx2 = {
  lines: [{ id: 1, name: 'L1 总装线', type: 'linear' }],
  stations: [{ id: 11, lineId: 1, name: '上料工位', seq: 10 }],
  fixtures: [{ id: 1, code: '2001', serialNo: 'SN-A', lines: [1], stations: [11] }]
};
const planDup = M.buildLineImportPlan([
  ['线体', '工位', '夹具编号'],
  ['L1 总装线', '上料工位', 'SN-A']
], gEx2);
ok(planDup.ok === false && planDup.skipped.length === 1 && /已关联/.test(planDup.skipped[0].reason),
  '已关联的产线/工位 → 跳过并提示「无新增，已忽略」', planDup.skipped);

/* 未建档 / 重复套 / 文件内重复行 / 空编号 */
const planMiss = M.buildLineImportPlan([['线体', '工位', '夹具编号'], ['L1 总装线', '上料工位', 'SN-NOT-EXIST']], gEx);
ok(planMiss.ok === false && /未建档/.test(planMiss.skipped[0].reason), '未建档实物编号 → 跳过', planMiss.skipped);
const planDupSerial = M.buildLineImportPlan([['线体', '工位', '夹具编号'], ['L1 总装线', '上料工位', 'SN-A']],
  { lines: gEx.lines, stations: gEx.stations, fixtures: [
    { id: 1, code: '2001', serialNo: 'SN-A', lines: [], stations: [] },
    { id: 2, code: '2002', serialNo: 'SN-A', lines: [], stations: [] }
  ] });
ok(planDupSerial.ok === false && /无法唯一定位/.test(planDupSerial.skipped[0].reason),
  '同实物编号多套 → 无法唯一定位，跳过', planDupSerial.skipped);
const planRowDup = M.buildLineImportPlan([
  ['线体', '工位', '夹具编号'],
  ['L1 总装线', '上料工位', 'SN-A'],
  ['L1 总装线', '上料工位', 'SN-A']
], gEx);
ok(planRowDup.appends.length === 1 && /文件中重复行/.test(planRowDup.skipped[0].reason),
  '文件内完全重复的行只处理一次', planRowDup.skipped);
const planNoSerial = M.buildLineImportPlan([['线体', '工位', '夹具编号'], ['L1 总装线', '上料工位', '']], gEx);
ok(planNoSerial.ok === false && /为空/.test(planNoSerial.skipped[0].reason), '夹具编号为空 → 跳过', planNoSerial.skipped);

/* 上限拦截：产线 ≤5 / 工位 ≤10（虚拟状态预演，计划阶段即拦住） */
const ml = [];
const mst = [];
for (let i = 0; i < 5; i++) { ml.push({ id: 900 + i, name: 'ML' + i, type: 'linear' }); mst.push({ id: 950 + i, lineId: 900 + i, name: 'MS' + i, seq: 1 }); }
for (let i = 0; i < 10; i++) mst.push({ id: 1000 + i, lineId: 900, name: 'MSS' + i, seq: 10 + i });
const planMaxLine = M.buildLineImportPlan([['线体', '工位', '夹具编号'], ['ML9 新线', 'SX', 'SN-L5']],
  { lines: ml, stations: mst, fixtures: [{ id: 70, code: '9070', serialNo: 'SN-L5', lines: [900, 901, 902, 903, 904], stations: [950] }] });
ok(planMaxLine.ok === false && /上限 5/.test(planMaxLine.skipped[0].reason), '产线已达 5 条 → 跳过（上限 5）', planMaxLine.skipped);
const planMaxSt = M.buildLineImportPlan([['线体', '工位', '夹具编号'], ['ML0', 'SX2', 'SN-S10']],
  { lines: ml, stations: mst, fixtures: [{ id: 71, code: '9071', serialNo: 'SN-S10', lines: [900], stations: mst.slice(5, 15).map((s) => s.id) }] });
ok(planMaxSt.ok === false && /上限 10/.test(planMaxSt.skipped[0].reason), '工位已达 10 个 → 跳过（上限 10）', planMaxSt.skipped);
const planNine = M.buildLineImportPlan([['线体', '工位', '夹具编号'], ['ML0', 'SX9', 'SN-S9']],
  { lines: ml, stations: mst, fixtures: [{ id: 72, code: '9072', serialNo: 'SN-S9', lines: [900], stations: mst.slice(5, 14).map((s) => s.id) }] });
ok(planNine.ok && planNine.appends.length === 1, '工位 9 个（未达上限）→ 正常追加', planNine.error);
ok(planNine.newStations.length === 1 && planNine.newStations[0].name === 'SX9', '未达上限时新工位被补建', planNine.newStations);

/* 缺列 / 空表 —— v4 三者都必填 */
ok(M.buildLineImportPlan([['工位', '夹具编号'], ['A', 'B']], gEx).ok === false, '缺「线体」列 → 报错');
ok(/缺少「线体」/.test(M.buildLineImportPlan([['工位', '夹具编号'], ['A', 'B']], gEx).error), '缺线体列的报错文案正确',
  M.buildLineImportPlan([['工位', '夹具编号'], ['A', 'B']], gEx).error);
ok(/缺少「工位」/.test(M.buildLineImportPlan([['线体', '夹具编号'], ['A', 'B']], gEx).error), '缺「工位」列 → 报错');
ok(/缺少「夹具编号」/.test(M.buildLineImportPlan([['线体', '工位'], ['A', 'B']], gEx).error),
  '缺「夹具编号」列 → 报错（v4 必须填实物编号）');
ok(M.buildLineImportPlan([['线体', '工位', '夹具编号']], gEx).ok === false, '只有表头 → 报错');
ok(M.buildLineImportPlan([], gEx).ok === false, '空数组 → 报错');
ok(M.buildLineImportPlan(null, gEx).ok === false, 'null → 报错');
const planAllBad = M.buildLineImportPlan([['线体', '工位', '夹具编号'], ['', '', ''], ['L1 总装线', '', 'SN-A']], gEx);
ok(planAllBad.ok === false && /没有可导入的有效数据行/.test(planAllBad.error), '全无效行 → 报错', planAllBad.error);
ok(Array.isArray(planAllBad.skipped) && planAllBad.skipped.length === 1,
  '失败返回值同时带 skipped（预览页才能列出跳过原因）', planAllBad.skipped);
ok(M.buildLineImportPlan([['线体', '工位', '夹具编号'], [null, null, null]], gEx).ok === false, '全 null 行 → 报错');

/* ============ H / I / J：需要异步与真实 store ============ */
(async () => {
  /* ============ H. 端到端：导入落库 ============ */
  section('H. 端到端导入落库');
  const hl = store.add('lines', { name: 'H1 基础线', type: 'linear', remark: '' });
  const hs = store.add('stations', { lineId: hl, name: 'H1 工位', seq: 1 });
  store.add('fixtures', { serialNo: 'SN-E', name: '端到端夹具E', lineModels: ['E1'], lines: [hl], stations: [hs], location: 'ZP2-U-1-1', category: '焊接' });
  store.add('fixtures', { serialNo: 'SN-F', name: '端到端夹具F', lineModels: [], lines: [hl], stations: [hs], location: 'ZP2-U-1-2', category: '' });
  syncState();

  const beforeLines = store.getAll('lines').length;
  const beforeStations = store.getAll('stations').length;
  const planExec = M.buildLineImportPlan([
    ['线体', '线体形态', '工位', '工位顺序', '夹具编号', '备注'],
    ['L3 焊装线', '直线形', '工位甲', '10', 'SN-E', ''],
    ['L3 焊装线', '直线形', '工位甲', '10', 'SN-F', ''],
    ['L3 焊装线', '直线形', '工位乙', '20', 'SN-F', ''],
    ['L4 U型线', 'U型', '工位丙', '10', 'SN-E', '']
  ], { lines: state_().lines, stations: state_().stations, fixtures: state_().fixtures });
  ok(planExec.ok, '端到端计划生成成功', planExec.error);
  ok(planExec.newLines.length === 2 && planExec.newStations.length === 3 && planExec.appends.length === 4,
    '计划：2 线体 / 3 工位 / 4 追加', [planExec.newLines.length, planExec.newStations.length, planExec.appends.length]);

  const stat = await M.applyLineImportPlan(planExec);
  ok(stat.lines === 2, '落库新建 2 条线体', stat.lines);
  ok(stat.stations === 3, '落库新建 3 个工位', stat.stations);
  ok(stat.appends === 4, '落库追加 4 行', stat.appends);
  ok(stat.applied === 2, '实际更新 2 套夹具', stat.applied);
  ok(stat.linesAdded === 3 && stat.stationsAdded === 4, '新增关联：3 条产线关联 / 4 个工位关联（SN-E 2+2、SN-F 1+2）', [stat.linesAdded, stat.stationsAdded]);
  ok(store.getAll('lines').length === beforeLines + 2, '线体总数 +2', store.getAll('lines').length);
  ok(store.getAll('stations').length === beforeStations + 3, '工位总数 +3', store.getAll('stations').length);
  ok(stat.undo.fixtures.length === 2 && stat.undo.createdLineIds.length === 2 && stat.undo.createdStationIds.length === 3,
    '返回 undo 信息（供「撤销本次导入」）', stat.undo);

  syncState();
  const l3 = store.getAll('lines').find((x) => x.name === 'L3 焊装线');
  const l4 = store.getAll('lines').find((x) => x.name === 'L4 U型线');
  const l3st = store.getAll('stations').filter((x) => x.lineId === l3.id);
  ok(l3 && l3.type === 'linear', 'L3 线体类型 = 直线形', l3 && l3.type);
  ok(l4 && l4.type === 'u', 'L4 线体类型 = U型', l4 && l4.type);
  ok(l3st.length === 2, 'L3 下 2 个工位', l3st.length);
  ok(l3st.map((s) => s.name).sort().join(',') === '工位乙,工位甲', '工位名称正确', l3st.map((s) => s.name));
  ok(l3st.find((s) => s.name === '工位甲').seq === 10, '工位顺序落库为数字', l3st.find((s) => s.name === '工位甲').seq);

  const fE = store.getAll('fixtures').find((f) => f.serialNo === 'SN-E');
  const fF = store.getAll('fixtures').find((f) => f.serialNo === 'SN-F');
  const stJia = l3st.find((s) => s.name === '工位甲');
  const stYi = l3st.find((s) => s.name === '工位乙');
  const stBing = store.getAll('stations').find((s) => s.name === '工位丙');
  ok(fE.lines.includes(hl) && fE.lines.includes(l3.id) && fE.lines.includes(l4.id),
    'SN-E 产线 = 原有的 H1 + 新增 L3 / L4（追加不覆盖）', fE.lines);
  ok(fE.stations.includes(hs) && fE.stations.includes(stJia.id) && fE.stations.includes(stBing.id),
    'SN-E 工位 = 原有的 H1 工位 + 工位甲 + 工位丙', fE.stations);
  ok(fF.lines.includes(hl) && fF.lines.includes(l3.id) && !fF.lines.includes(l4.id),
    'SN-F 只追加了 L3（未涉及 L4）', fF.lines);
  ok(fF.stations.includes(stJia.id) && fF.stations.includes(stYi.id), 'SN-F 追加了工位甲 + 工位乙', fF.stations);

  /* 读回表格（新签名） */
  syncState();
  const rowsAfter = M.buildStationRows(l3st, state_().fixtures);
  ok(rowsAfter.length === 2, '导入后配置表 2 行');
  ok(rowsAfter.find((r) => r.station.name === '工位甲').fixtures.length === 2, '工位甲显示 2 套夹具');
  ok(rowsAfter.find((r) => r.station.name === '工位乙').fixtures.length === 1, '工位乙显示 1 套夹具');

  /* 幂等：同一份文件再导一次 —— v4 语义为「无新增即无有效行」*/
  const planAgain = M.buildLineImportPlan([
    ['线体', '线体形态', '工位', '工位顺序', '夹具编号', '备注'],
    ['L3 焊装线', '直线形', '工位甲', '10', 'SN-E', ''],
    ['L3 焊装线', '直线形', '工位甲', '10', 'SN-F', ''],
    ['L3 焊装线', '直线形', '工位乙', '20', 'SN-F', ''],
    ['L4 U型线', 'U型', '工位丙', '10', 'SN-E', '']
  ], { lines: state_().lines, stations: state_().stations, fixtures: state_().fixtures });
  ok(planAgain.ok === false, '重复导入：无新增 → 计划判定为「无有效行」', planAgain.error);
  ok(planAgain.skipped.length === 4 && planAgain.skipped.every((s) => /已关联/.test(s.reason)),
    '重复导入：4 行全部提示「已关联（无新增，已忽略）」', planAgain.skipped.map((s) => s.reason));
  const cntFixtures = store.getAll('fixtures').length;
  const cntLines2 = store.getAll('lines').length;
  ok(cntFixtures === 4 && cntLines2 === beforeLines + 2, '重复导入：夹具与线体数量不变（幂等）', [cntFixtures, cntLines2]);

  /* ============ I. 撤销接口 ============ */
  section('I. 撤销接口（removeFixtureLine / removeFixtureStation / removeFixtureLinesByBatch）');
  /* 用 H 段导入结果回滚：把 SN-E 的 L3 / L4 与本次新增工位摘掉 */
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
  ok(!fE2.stations.includes(stJia) && !fE2.stations.includes(stBing),
    'removeFixtureLine 连带摘掉该产线下的工位', fE2.stations);
  ok(fE2.stations.includes(hs), '原有工位保留', fE2.stations);

  /* removeFixtureStation：只摘工位、产线保留 */
  const il = store.add('lines', { name: 'IX 线', type: 'linear', remark: '' });
  const il2 = store.add('lines', { name: 'IY 线', type: 'u', remark: '' });
  const is1 = store.add('stations', { lineId: il, name: 'IX-1', seq: 1 });
  const is2 = store.add('stations', { lineId: il2, name: 'IY-1', seq: 1 });
  const ifid = store.add('fixtures', { serialNo: 'SN-U1', name: '撤销用夹具', lineModels: [], lines: [il, il2], stations: [is1, is2], location: 'ZP3-U-1-1', category: '' });
  const ifCode = fixById(ifid).code;
  const r1 = store.removeFixtureStation(ifCode, is1);
  ok(r1.stations === 1 && r1.lines === 2, 'removeFixtureStation 只摘工位（产线保留）', r1);
  const r2 = store.removeFixtureLine(ifCode, il2);
  ok(r2.lines === 1 && r2.stations === 0, 'removeFixtureLine 摘产线并连带摘其工位', r2);
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

  /* ============ J2. 机种明细（v4.5.0 合并进机种管理） ============ */
  section('J2. buildProdDetailRows 机种 × 线体 × 工位（明细面板数据源）');
  const kLines = [{ id: 1, name: 'K1 线' }, { id: 2, name: 'K2 线' }];
  const kStations = [
    { id: 11, lineId: 1, name: '上料工位', seq: 10 },
    { id: 12, lineId: 1, name: '压装工位', seq: 20 },
    { id: 21, lineId: 2, name: '上料工位', seq: 10 },   // 同名工位跨线体（工位表必须保留）
    { id: 22, lineId: 2, name: '焊接工位', seq: 20 }
  ];
  const kFixtures = [
    /* 一条夹具跨 2 条线，线1 两个工位、线2 一个工位 */
    { id: 31, code: '4001', serialNo: 'SN-K1', name: '定位销压板', location: 'ZP1-U-1-1', status: 'stocked', lineModels: ['机种甲'], lines: [1, 2], stations: [11, 12, 21] },
    /* 只关联线2、一个工位都没选 → 出「未指定工位」行 */
    { id: 32, code: '4002', serialNo: 'SN-K2', name: '焊接夹具', location: 'ZP1-U-1-2', status: 'checked_out', lineModels: ['机种甲'], lines: [2], stations: [] },
    /* 完全没关联产线 → 出「未关联产线」行 */
    { id: 33, code: '4003', serialNo: 'SN-K3', name: '无产线夹具', location: '', status: 'stocked', lineModels: ['机种甲'], lines: [], stations: [] },
    /* 别的机种 → 必须被过滤掉 */
    { id: 34, code: '4004', serialNo: 'SN-K4', name: '别的机种夹具', location: 'X', status: 'stocked', lineModels: ['机种乙'], lines: [1], stations: [11] }
  ];
  const kd = M.buildProdDetailRows(kFixtures, kLines, kStations, ['机种甲']);
  ok(kd.length === 5, '机种甲共 5 行（线1 两工位 + 线2 一工位 + 线2 未指定 + 未关联）', kd.length);
  ok(kd.every((r) => r.production === '机种甲'), '非目标机种被过滤（机种乙的夹具不出现）');
  const k1 = kd.filter((r) => r.lineName === 'K1 线');
  ok(k1.length === 2 && k1.every((r) => r.fixtureId === 31), 'K1 线 2 行，均来自夹具 31', k1.map((r) => r.stationName));
  ok(k1.map((r) => r.stationName).sort().join(',') === '上料工位,压装工位', 'K1 线工位 = 上料工位 / 压装工位', k1.map((r) => r.stationName));
  const k2 = kd.filter((r) => r.lineName === 'K2 线');
  ok(k2.length === 2, 'K2 线 2 行（31 的上料工位 + 32 的未指定工位）', k2.map((r) => r.stationName));
  ok(k2.some((r) => r.stationName === '上料工位' && r.fixtureId === 31), 'K2 线上料工位来自夹具 31（同名工位按 lineId 归属，不串线）');
  ok(k2.some((r) => r.stationName === '（未指定工位）' && r.fixtureId === 32), '只关联产线未选工位 → 「（未指定工位）」');
  ok(!k2.some((r) => r.stationName === '压装工位'), 'K2 线不会串入 K1 的压装工位');
  const orphanK = kd.filter((r) => r.lineName === '（未关联产线）');
  ok(orphanK.length === 1 && orphanK[0].fixtureId === 33 && orphanK[0].stationName === '—', '无产线夹具 → 「（未关联产线）」占位', orphanK[0]);
  ok(kd.every((r) => ['production', 'lineId', 'lineName', 'stationName', 'fixtureId', 'code', 'serialNo', 'name', 'location', 'status'].every((k) => k in r)),
    '明细行字段齐备（线体 / 工位 / 夹具字段）', Object.keys(kd[0]));
  ok(M.buildProdDetailRows(kFixtures, kLines, kStations, []).length === 0, '未指定机种 → 0 行');
  ok(M.buildProdDetailRows([
    { id: 35, code: '4005', serialNo: 'SN-K5', name: '坏工位', location: '', status: 'stocked', lineModels: ['机种甲'], lines: [1], stations: [999] }
  ], kLines, kStations, ['机种甲']).length === 1, '工位 id 已失效时按产线出 1 行，不丢夹具');

  syncState();
  ok(store.getAll('fixtures').length === 5 && sandbox.state.fixtures.length === 5,
    'J 段为纯函数，不写库（夹具 = A 段 2 + H 段 2 + I 段 1 = 5 套）', store.getAll('fixtures').length);

  /* ---------- 收尾 ---------- */
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n==================================================');
  console.log('测试汇总：通过 ' + pass + ' / 失败 ' + fail);
  console.log('==================================================');
  process.exit(fail ? 1 : 0);
})();

/* 便捷读取当前 store 快照（H 段内联使用，避免每次手写 4 个集合） */
function state_() {
  return {
    fixtures: store.getAll('fixtures'),
    lines: store.getAll('lines'),
    stations: store.getAll('stations'),
    productions: store.getAll('productions')
  };
}
