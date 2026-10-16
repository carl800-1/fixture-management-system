'use strict';
/* ============================================================
 * test_line.js — 产线夹具查询 / 产线配置 模块测试（v3.0.1）
 *
 * 覆盖：
 *   A. 数据层：新集合 CRUD、一对多绑定、覆盖式写入、级联删除、落盘
 *   B. 线体形态：lineTypeLabel / lineTypeKey / parseLineType
 *   C. 工位排序：seq 数值序、无 seq 置末尾、同号按名称、不改原数组
 *   D. 工位夹具配置表：buildStationRows（排序/一对多/回填/未建档/按产品隔离）
 *   E. 产线图布局：computeLineLayout（直线折行、U型三边布点、坐标范围）
 *   F. 产线图渲染：renderLineDiagram（高亮、无配置标注、空态）
 *   G. 导入映射：mapLineImportHeader / buildLineImportPlan（建结构、去重、跳过、幂等）
 *   H. 端到端：plan → applyLineImportPlan（真实 store）→ 读回校验 + 重复导入幂等
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

/* ---------- 从 app.js 抽取被测代码 ---------- */
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
  slice('function formatLineModels(f, emptyMark', 'function lineModelsMatch'),
  slice('function normalizeHeader(h)', '// 把二维数组的首行解析成'),
  slice('const LINE_TYPES = [', '/* ---------------- 产线夹具查询页 ---------------- */'),
  slice('const LINE_IMPORT_HEADERS = [', '/* 落库：按'),
  slice('async function applyLineImportPlan(plan) {', 'window.showLineImportPreview')
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
  state: { fixtures: [], lines: [], products: [], stations: [], stationFixtures: [] },
  DB: {
    add: async (name, item) => store.add(name, item),
    setStationFixtures: async (p) => store.setStationFixtures(p)
  }
};
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(parts.join('\n') + `
;__export = {
  lineTypeLabel, lineTypeKey, sortStations, buildStationRows, computeLineLayout,
  productsOfLine, stationsOfLine, fixtureMapByCode, renderLineDiagram,
  mapLineImportHeader, parseLineType, buildLineImportPlan, applyLineImportPlan
};`, ctx);
const M = sandbox.__export;
if (!M) { console.error('模块导出失败'); process.exit(1); }

function syncState() {
  sandbox.state.lines = store.getAll('lines');
  sandbox.state.products = store.getAll('products');
  sandbox.state.stations = store.getAll('stations');
  sandbox.state.stationFixtures = store.getAll('stationFixtures');
}

console.log('=== 产线模块测试 ===');

/* ============ A. 数据层 ============ */
section('A. 数据层（store）');
const l1 = store.add('lines', { name: 'L1 总装线', type: 'linear', remark: '' });
const l2 = store.add('lines', { name: 'L2 环形线', type: 'loop', remark: '' });
const p1 = store.add('products', { lineId: l1, name: '产品甲', code: 'P-01' });
const p2 = store.add('products', { lineId: l1, name: '产品乙', code: 'P-02' });
const s1 = store.add('stations', { lineId: l1, seq: 10, name: '上料工位' });
const s2 = store.add('stations', { lineId: l1, seq: 20, name: '压装工位' });
const s3 = store.add('stations', { lineId: l2, seq: 10, name: '环形工位一' });

ok(store.getAll('lines').length === 2, 'lines 写入 2 条', store.getAll('lines').length);
ok(store.getAll('products').length === 2, 'products 写入 2 条');
ok(store.getAll('stations').length === 3, 'stations 写入 3 条');
ok(new Set([l1, l2, p1, p2, s1, s2, s3]).size === 7, 'id 互不相同');

store.setStationFixtures({ productId: p1, stationId: s2, codes: ['2001', '2002'] });
store.setStationFixtures({ productId: p1, stationId: s1, codes: ['2003'] });
store.setStationFixtures({ productId: p2, stationId: s2, codes: ['2004'] });
ok(store.getAll('stationFixtures').length === 4, '绑定共 4 条（含一对多的 2 条）', store.getAll('stationFixtures').length);
ok(store.getAll('stationFixtures').filter((x) => x.productId === p1 && x.stationId === s2).length === 2,
   '一个工位可绑多个夹具');

store.setStationFixtures({ productId: p1, stationId: s2, codes: ['2009'] });
ok(store.getAll('stationFixtures').filter((x) => x.productId === p1 && x.stationId === s2).length === 1,
   '覆盖式写入不累积（4 → 3 条）', store.getAll('stationFixtures').length);
store.setStationFixtures({ productId: p1, stationId: s2, codes: ['2001', '2002'] }); // 还原

const file = path.join(tmpDir, 'fixture-data.json');
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
ok(['lines', 'products', 'stations', 'stationFixtures'].every((k) => Array.isArray(raw[k])),
   'JSON 落盘含全部 4 个新集合', Object.keys(raw));

/* 级联删除 */
const p3 = store.add('products', { lineId: l2, name: '产品丙' });
store.setStationFixtures({ productId: p3, stationId: s3, codes: ['3001'] });
store.delProduct(p3);
ok(store.getAll('stationFixtures').every((x) => x.productId !== p3), '删产品 → 级联清理其绑定');

// 用独立工位测「删工位级联」，避免影响后面 D 段依赖的 L1 工位
const s9 = store.add('stations', { lineId: l2, seq: 90, name: '临时工位' });
store.setStationFixtures({ productId: p1, stationId: s9, codes: ['3002'] });
store.delStation(s9);
ok(store.getAll('stationFixtures').every((x) => x.stationId !== s9), '删工位 → 级联清理其绑定');

store.add('products', { lineId: l2, name: '产品丁' });
store.delLine(l2);
ok(store.getAll('lines').every((x) => x.id !== l2), '删线体：线体已移除');
ok(store.getAll('products').every((x) => x.lineId !== l2), '删线体：产品级联移除');
ok(store.getAll('stations').every((x) => x.lineId !== l2), '删线体：工位级联移除');
ok(store.getAll('stationFixtures').length === 4, '删线体：其绑定级联移除（剩 L1 的 4 条）', store.getAll('stationFixtures').length);

/* ============ B. 线体形态 ============ */
section('B. 线体形态（只有 直线形 / U型 两种）');
ok(M.lineTypeLabel('linear') === '直线形', 'linear → 直线形');
ok(M.lineTypeLabel('u') === 'U型', 'u → U型');
ok(M.lineTypeLabel('weird') === '直线形', '未知类型回退直线形', M.lineTypeLabel('weird'));
ok(M.lineTypeKey('weird') === 'linear', '未知类型键归一为 linear');
ok(M.lineTypeKey('u') === 'u', '已知类型键保持');

/* 历史数据兼容：早期版本用 loop / circle / ring / 环形 表示「环形」，一律折算为 U型，
   且不写回数据文件（只在显示与绘图时折算），保证旧 fixture-data.json 直接可用 */
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

/* ============ D. 工位夹具配置表 ============ */
section('D. buildStationRows 工位夹具配置表');
syncState();
const fixtures = [
  { code: '2001', name: '定位销压板', lineModels: ['MODEL-A', 'MODEL-B'], category: '冲压' },
  { code: '2002', name: '焊接夹具', lineModels: ['MODEL-C'], category: '焊接' },
  { code: '2003', name: '装配工装', lineModels: [], category: '装配' }
];
const fmap = M.fixtureMapByCode(fixtures);
ok(fmap['2001'].name === '定位销压板', 'fixtureMapByCode 建索引正确');

const lineStations = store.getAll('stations').filter((s) => s.lineId === l1);
const rows = M.buildStationRows(lineStations, store.getAll('stationFixtures'), p1, fmap);
ok(rows.length === 2, '两个工位 → 两行', rows.length);
ok(rows[0].station.name === '上料工位' && rows[1].station.name === '压装工位', '按工位顺序排列（seq 10 → 20）', rows.map((r) => r.station.name));
ok(rows[0].fixtures.map((f) => f.code).join(',') === '2003', '上料工位 1 个夹具', rows[0].fixtures.map((f) => f.code));
ok(rows[1].fixtures.length === 2, '压装工位为一对多（2 个夹具）', rows[1].fixtures.length);
ok(rows[1].fixtures.map((f) => f.code).join(',') === '2001,2002', '夹具编号顺序稳定', rows[1].fixtures.map((f) => f.code));
ok(rows[1].fixtures[0].name === '定位销压板', '回填夹具名称');
ok(rows[1].fixtures[0].spec === 'MODEL-A / MODEL-B', '回填规格/型号（机种拼接）', rows[1].fixtures[0].spec);
ok(rows[1].fixtures[0].found === true, '已建档编号 found = true');

// 无任何绑定的工位 → fixtures 为空数组（渲染时显示「—」）
const noCfgRows = M.buildStationRows([{ id: 77, name: '空工位', seq: 1 }], store.getAll('stationFixtures'), p1, fmap);
ok(noCfgRows[0].fixtures.length === 0, '无绑定的工位 fixtures 为空数组', noCfgRows[0].fixtures);
ok(M.buildStationRows([{ id: 77, name: '空工位', seq: 1 }], [], p1, fmap)[0].fixtures.length === 0, '绑定集合为空时也安全');

const rowsOther = M.buildStationRows(lineStations, store.getAll('stationFixtures'), p2, fmap);
ok(rowsOther[0].fixtures.length === 0, '按产品隔离：产品乙在上料工位无配置', rowsOther[0].fixtures.length);
ok(rowsOther[1].fixtures.map((f) => f.code).join(',') === '2004', '产品乙在压装工位 1 个夹具', rowsOther[1].fixtures.map((f) => f.code));
ok(M.buildStationRows(lineStations, store.getAll('stationFixtures'), 9999, fmap).every((r) => r.fixtures.length === 0),
   '不存在的产品 → 全部无配置');

const missRows = M.buildStationRows(
  [{ id: 1, name: 'W', seq: 1 }],
  [{ productId: 1, stationId: 1, fixtureCode: '9999' }],
  1, fmap
);
ok(missRows[0].fixtures[0].found === false, '未建档编号 found = false', missRows[0].fixtures[0]);
ok(missRows[0].fixtures[0].name === '' && missRows[0].fixtures[0].spec === '', '未建档编号名称/规格留空');

/* ============ E. 产线图布局 ============ */
section('E. computeLineLayout 产线图布局');
ok(M.computeLineLayout(0, 'linear').length === 0, '0 个工位 → 空布局');
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
ok(Math.abs(u6[0].x - u6[1].x) < 1e-9 && u6[1].y > u6[0].y, 'U型左侧竖边：x 相同、y 递增', [u6[0], u6[1]]);
ok(Math.abs(u6[4].x - u6[5].x) < 1e-9 && u6[4].y > u6[5].y, 'U型右侧竖边：x 相同、y 递减', [u6[4], u6[5]]);
ok(Math.abs(u6[2].y - u6[3].y) < 1e-9 && u6[2].x < u6[3].x, 'U型底部横边：y 相同、x 递增', [u6[2], u6[3]]);
ok(Math.abs(u6[0].y - u6[5].y) < 1e-9, 'U型两端等高（左右顶点同一水平线）', [u6[0].y, u6[5].y]);
ok(M.computeLineLayout(1, 'u').length === 1, 'U型单工位也能布点');
ok(M.computeLineLayout(2, 'u').length === 2, 'U型 2 工位布点正常');
ok(M.computeLineLayout(9, 'u').every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1), 'U型 9 工位坐标不越界');
ok(M.computeLineLayout(6, 'loop').every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1),
   '历史 loop 数据按 U型布局，坐标不越界');
ok(M.computeLineLayout(5, 'weird').every((p) => p.y === M.computeLineLayout(5, 'linear')[0].y),
   '未知形态按直线形处理');

/* ============ F. 产线图渲染 ============ */
section('F. renderLineDiagram 产线图渲染');
const lineObj = { name: 'L1 总装线', type: 'linear' };
const rowsForSvg = M.buildStationRows(
  [{ id: 1, name: '上料工位', seq: 10 }, { id: 2, name: '压装工位', seq: 20 }],
  [{ productId: 1, stationId: 2, fixtureCode: '2001' }],
  1, fmap
);
const svg = M.renderLineDiagram(lineObj, rowsForSvg);
ok(svg.includes('L1 总装线'), '图内包含线体名');
ok(svg.includes('直线形产线示意图'), '图标题含形态名');
ok(svg.includes('ld-on'), '有夹具的工位高亮（ld-on）');
ok(svg.includes('ld-off'), '无夹具的工位不加高亮（ld-off）');
ok(svg.includes('2001'), '标注夹具编号');
ok(svg.includes('>无<'), '无配置的工位标注「无」');
ok(svg.includes('<line'), '直线形使用折线轨迹');
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
const svgEsc = M.renderLineDiagram({ name: '<script>x</script>', type: 'linear' }, [{ station: { name: 'A&B' }, seq: 1, fixtures: [] }]);
ok(!svgEsc.includes('<script>') && svgEsc.includes('&lt;script&gt;'), '线体名做 HTML 转义');

/* ============ G. 导入映射 ============ */
section('G. 产线导入映射');
const idxStd = M.mapLineImportHeader(['线体', '线体形态', '产品', '产品编号', '工位', '工位顺序', '夹具编号', '备注']);
ok(idxStd.line === 0 && idxStd.lineType === 1 && idxStd.product === 2 && idxStd.station === 4, '标准表头映射正确', idxStd);
const idxAlias = M.mapLineImportHeader(['产线', '形态', '机型', '工位号', '顺序', '编号']);
ok(idxAlias.line === 0, '「产线」→ line');
ok(idxAlias.lineType === 1, '「形态」→ lineType');
ok(idxAlias.product === 2, '「机型」→ product');
ok(idxAlias.station === 3, '「工位号」→ station');
ok(idxAlias.seq === 4, '「顺序」→ seq');
ok(idxAlias.fixtureCode === 5, '「编号」→ fixtureCode');

section('G2. buildLineImportPlan');
const emptyExisting = { lines: [], products: [], stations: [] };
const rowsOk = [
  ['线体', '线体形态', '产品', '产品编号', '工位', '工位顺序', '夹具编号', '备注'],
  ['L1 总装线', '直线形', '产品甲', 'P-01', '上料工位', '10', '2001', ''],
  ['L1 总装线', '直线形', '产品甲', 'P-01', '压装工位', '20', '2002', ''],
  ['L1 总装线', '直线形', '产品甲', 'P-01', '压装工位', '20', '2003', '同工位多夹具'],
  ['L1 总装线', '直线形', '产品甲', 'P-01', '  ', '30', '2004', '工位缺失应跳过'],
  ['L2 U型线', 'U型', '产品乙', 'P-02', '工位一', '10', '2005', '']
];
const plan = M.buildLineImportPlan(rowsOk, emptyExisting);
ok(plan.ok, '生成计划成功', plan.error);
ok(plan.newLines.length === 2, '新建 2 条线体', plan.newLines.map((l) => l.name));
ok(plan.newLines.find((l) => l.name === 'L2 U型线').type === 'u', 'U型线体类型正确');
ok(plan.newProducts.length === 2, '新建 2 个产品', plan.newProducts.map((p) => p.name));
ok(plan.newStations.length === 3, '新建 3 个工位（L1 两个去重 + L2 一个；缺工位那行跳过）', plan.newStations.map((s) => s.name));
ok(plan.newStations.find((s) => s.name === '压装工位').seq === 20, '工位顺序写入为数字', plan.newStations.find((s) => s.name === '压装工位'));
ok(plan.binds.length === 4, '4 条夹具绑定（2001/2002/2003/2005）', plan.binds.map((b) => b.fixtureCode));
ok(plan.skipped.length === 1 && plan.skipped[0].row === 5, '跳过第 5 行（工位为空）', plan.skipped);

// 幂等：已存在的线体/产品/工位不重复新建
const existing = {
  lines: [{ id: 1, name: 'L1 总装线', type: 'linear' }],
  products: [{ id: 1, lineId: 1, name: '产品甲' }],
  stations: [{ id: 1, lineId: 1, name: '上料工位', seq: 10 }]
};
const plan2 = M.buildLineImportPlan(rowsOk, existing);
ok(plan2.newLines.length === 1 && plan2.newLines[0].name === 'L2 U型线', '已存在线体不重复新建', plan2.newLines.map((l) => l.name));
ok(plan2.newProducts.length === 1, '已存在产品不重复新建', plan2.newProducts.map((p) => p.name));
ok(plan2.newStations.length === 2, '已存在工位不重复新建（压装 + 工位一）', plan2.newStations.map((s) => s.name));
ok(plan2.binds.length === 4, '绑定仍为 4 条（绑定是覆盖式的，与是否新建无关）', plan2.binds.length);

// 夹具编号为空 → 建结构但不绑定
const rowsNoCode = [
  ['线体', '产品', '工位'],
  ['L9', '产品X', '工位A'],
  ['L9', '产品X', '工位B']
];
const plan3 = M.buildLineImportPlan(rowsNoCode, emptyExisting);
ok(plan3.ok && plan3.newLines.length === 1 && plan3.newStations.length === 2, '无夹具编号仍建线体与工位');
ok(plan3.binds.length === 0, '无夹具编号 → 零绑定', plan3.binds.length);

// 重复绑定去重
const rowsDup = [
  ['线体', '产品', '工位', '夹具编号'],
  ['L1', '产品甲', '工位A', '2001'],
  ['L1', '产品甲', '工位A', '2001']
];
ok(M.buildLineImportPlan(rowsDup, emptyExisting).binds.length === 1, '完全重复的绑定去重');

// 缺列 / 空表
ok(M.buildLineImportPlan([['产品', '工位'], ['A', 'B']], emptyExisting).ok === false, '缺「线体」列 → 报错',
   M.buildLineImportPlan([['产品', '工位'], ['A', 'B']], emptyExisting).error);
ok(M.buildLineImportPlan([['线体', '工位'], ['A', 'B']], emptyExisting).ok === false, '缺「产品」列 → 报错');
ok(M.buildLineImportPlan([['线体', '产品'], ['A', 'B']], emptyExisting).ok === false, '缺「工位」列 → 报错');
ok(M.buildLineImportPlan([['线体', '产品', '工位']], emptyExisting).ok === false, '只有表头 → 报错');
ok(M.buildLineImportPlan([], emptyExisting).ok === false, '空数组 → 报错');
ok(M.buildLineImportPlan([['线体', '产品', '工位'], ['', '', '']], emptyExisting).ok === false,
   '全空行 → 报错（无有效数据）');

/* ============ H. 端到端：导入落库 ============ */
(async () => {
section('H. 端到端导入落库');
syncState();
const beforeLines = store.getAll('lines').length;
const planExec = M.buildLineImportPlan([
  ['线体', '线体形态', '产品', '产品编号', '工位', '工位顺序', '夹具编号', '备注'],
  ['L3 焊装线', '直线形', '产品丙', 'P-03', '工位甲', '10', '2001', ''],
  ['L3 焊装线', '直线形', '产品丙', 'P-03', '工位甲', '10', '2002', ''],
  ['L3 焊装线', '直线形', '产品丙', 'P-03', '工位乙', '20', '', '无夹具'],
  ['L4 U型线', 'U型', '产品丁', 'P-04', '工位丙', '10', '2003', '']
], { lines: store.getAll('lines'), products: store.getAll('products'), stations: store.getAll('stations') });
ok(planExec.ok, '端到端计划生成成功', planExec.error);

const stat = await M.applyLineImportPlan(planExec);
ok(stat.lines === 2, '落库新建 2 条线体', stat.lines);
ok(stat.products === 2, '落库新建 2 个产品', stat.products);
ok(stat.stations === 3, '落库新建 3 个工位', stat.stations);
ok(stat.binds === 3, '落库绑定 3 条', stat.binds);
ok(store.getAll('lines').length === beforeLines + 2, '线体总数 +2', store.getAll('lines').length);

syncState();
const l3 = store.getAll('lines').find((x) => x.name === 'L3 焊装线');
const l3p = store.getAll('products').find((x) => x.name === '产品丙');
const l3st = store.getAll('stations').filter((x) => x.lineId === l3.id);
ok(l3 && l3.type === 'linear', 'L3 线体类型 = 直线形', l3 && l3.type);
ok(l3p && l3p.lineId === l3.id, '产品丙隶属 L3', l3p && l3p.lineId);
ok(l3st.length === 2, 'L3 下 2 个工位', l3st.length);
ok(l3st.map((s) => s.name).sort().join(',') === '工位乙,工位甲', '工位名称正确', l3st.map((s) => s.name));

const l3s1 = l3st.find((s) => s.name === '工位甲');
const bindsA = store.getAll('stationFixtures').filter((sf) => sf.productId === l3p.id && sf.stationId === l3s1.id);
ok(bindsA.length === 2 && bindsA.map((b) => b.fixtureCode).sort().join(',') === '2001,2002',
   '工位甲绑定 2 个夹具（一对多落库）', bindsA.map((b) => b.fixtureCode));

// 读回表格验证
const rowsAfter = M.buildStationRows(l3st, store.getAll('stationFixtures'), l3p.id, M.fixtureMapByCode([
  { code: '2001', name: '定位销压板', lineModels: ['MODEL-A'] },
  { code: '2002', name: '焊接夹具', lineModels: ['MODEL-C'] }
]));
ok(rowsAfter.length === 2, '导入后表格 2 行');
ok(rowsAfter.find((r) => r.station.name === '工位甲').fixtures.length === 2, '工位甲显示 2 个夹具');
ok(rowsAfter.find((r) => r.station.name === '工位乙').fixtures.length === 0, '工位乙显示无配置');

// 幂等：同一份数据再导一次，不重复建线体，绑定数量不变
const planAgain = M.buildLineImportPlan([
  ['线体', '线体形态', '产品', '产品编号', '工位', '工位顺序', '夹具编号', '备注'],
  ['L3 焊装线', '直线形', '产品丙', 'P-03', '工位甲', '10', '2001', ''],
  ['L3 焊装线', '直线形', '产品丙', 'P-03', '工位甲', '10', '2002', ''],
  ['L3 焊装线', '直线形', '产品丙', 'P-03', '工位乙', '20', '', '']
], { lines: store.getAll('lines'), products: store.getAll('products'), stations: store.getAll('stations') });
ok(planAgain.newLines.length === 0 && planAgain.newProducts.length === 0 && planAgain.newStations.length === 0,
   '重复导入：线体/产品/工位均不重复创建',
   [planAgain.newLines.length, planAgain.newProducts.length, planAgain.newStations.length]);
const cntBefore = store.getAll('stationFixtures').length;
await M.applyLineImportPlan(planAgain);
ok(store.getAll('stationFixtures').length === cntBefore, '重复导入：绑定数量不变（幂等）', store.getAll('stationFixtures').length);

/* ---------- 收尾 ---------- */
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n==================================================');
console.log('测试汇总：通过 ' + pass + ' / 失败 ' + fail);
console.log('==================================================');
process.exit(fail ? 1 : 0);
})();
