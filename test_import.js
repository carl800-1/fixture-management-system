'use strict';
/* ============================================================
 * test_import.js — 验证 app.js 的「夹具批量导入」纯函数（v4.0.0）
 *
 * v4.0.0 语义变化：
 *   · 表格**不再提供**桥梁编号 code（一律系统自动分配）
 *   · 实物编号 serialNo 为必填、允许重复
 *   · 库位 location 为必填且须 4 段式
 *   · 产线 / 工位按名称引用，**必须已在产线配置建档**（不自动补建）
 *   · 机种名称支持 1~7 独立列，上限由 4 提升到 7
 *
 * 做法：用 vm 沙箱载入 app.js 的两段真实源码（常量 + 校验 / 导入模块）。
 * 运行：node test_import.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → 实际: ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n' + t); }

const APP = path.join(__dirname, 'js', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

function slice(startMark, endMark) {
  const s = src.indexOf(startMark);
  if (s < 0) { console.error('切片起点未找到：' + startMark); process.exit(1); }
  const e = src.indexOf(endMark, s);
  if (e < 0) { console.error('切片终点未找到：' + endMark); process.exit(1); }
  return src.slice(s, e);
}

// ① 业务上限与格式校验（parseImportRow 依赖）
const constSrc = slice('/* ---------------- 业务上限与格式约束', '/* 机种名称：展示 / 搜索 helpers */');
// ② 夹具导入模块（FIX_IMPORT_HEADERS → 导入入口之前）
const importSrc = slice('const FIX_IMPORT_HEADERS', '/* 导入入口');
// ③ 产线导入模块（LINE_IMPORT_HEADERS → 落库函数之前；纯计划逻辑）
const lineImportSrc = slice('const LINE_IMPORT_HEADERS', '/* 落库：');

const sandbox = {
  state: { fixtures: [], lines: [], stations: [] },
  window: {},
  console,
  DB: { fixtureAdd: async () => 1 },
  esc: (s) => String(s == null ? '' : s),
  openModal: () => {},
  toast: () => {},
  reloadAll: async () => {},
  renderFixtures: () => {},
  download: () => {}
};
sandbox.global = sandbox;
const vm = require('vm');
const ctx = vm.createContext(sandbox);

let moduleSrc = constSrc + '\n' + importSrc + '\n' + lineImportSrc;
moduleSrc = moduleSrc.replace(/window\.__importPlan/g, '__importPlan')
  .replace(/window\.__lineImportPlan/g, '__lineImportPlan')
  .replace(/window\.showImportPreview/g, '__export_showImportPreview')
  .replace(/window\.confirmImportPlan/g, '__export_confirmImportPlan')
  .replace(/window\.downloadFixtureTemplate/g, '__export_downloadFixtureTemplate')
  .replace(/window\.fixtureImport/g, '__export_fixtureImport');
moduleSrc += `
;__export = { FIX_IMPORT_HEADERS, FIX_IMPORT_ALIAS, normalizeHeader, mapImportHeader,
              parseImportRow, splitNames, buildImportPlan,
              LINE_IMPORT_HEADERS, LINE_IMPORT_ALIAS, mapLineImportHeader, parseLineType,
              buildLineImportPlan,
              MAX_LINE_MODELS, MAX_LINES, MAX_STATIONS, isValidSerialNo, isValidLocation };
`;
vm.runInContext(moduleSrc, ctx);

const M = sandbox.__export;
if (!M) { console.error('模块导出失败'); process.exit(1); }

console.log('=== 夹具导入映射逻辑测试（v4.0.0） ===');

/* ---------- 1. 表头归一化 ---------- */
section('[表头归一化]');
ok(M.normalizeHeader('实物编号') === '实物编号', '普通表头原样');
ok(M.normalizeHeader('  名称  ') === '名称', '去首尾空格');
ok(M.normalizeHeader('机种名称1') === '机种名称1', '含数字表头');
ok(M.normalizeHeader('名称(必填)') === '名称', '剥离括号注释');
ok(M.normalizeHeader('库位：') === '库位', '剥离冒号');
ok(M.normalizeHeader('\uFEFF实物编号') === '实物编号', '剥离 BOM');

/* ---------- 2. 表头映射 · 标准顺序（v4 的 14 列模板） ---------- */
section('[表头映射 · 标准]');
ok(M.FIX_IMPORT_HEADERS.length === 14, '模板为 14 列', M.FIX_IMPORT_HEADERS.length);
ok(M.FIX_IMPORT_HEADERS[0] === '实物编号' && M.FIX_IMPORT_HEADERS[9] === '分类'
  && M.FIX_IMPORT_HEADERS[10] === '库位' && M.FIX_IMPORT_HEADERS[11] === '产线'
  && M.FIX_IMPORT_HEADERS[12] === '工位', '模板列序符合定稿',
  M.FIX_IMPORT_HEADERS.join('|'));

const idxStd = M.mapImportHeader(['实物编号', '名称', '机种名称1', '机种名称2', '机种名称3', '机种名称4',
  '机种名称5', '机种名称6', '机种名称7', '分类', '库位', '产线', '工位', '备注']);
ok(idxStd.serialNo === 0, 'serialNo → 第 0 列', idxStd.serialNo);
ok(idxStd.name === 1, 'name → 第 1 列', idxStd.name);
ok(idxStd.lm1 === 2 && idxStd.lm4 === 5 && idxStd.lm7 === 8, '机种 1~7 列正确',
  [idxStd.lm1, idxStd.lm4, idxStd.lm7]);
ok(idxStd.category === 9, 'category → 第 9 列', idxStd.category);
ok(idxStd.location === 10, 'location → 第 10 列', idxStd.location);
ok(idxStd.lines === 11, 'lines → 第 11 列', idxStd.lines);
ok(idxStd.stations === 12, 'stations → 第 12 列', idxStd.stations);
ok(idxStd.remark === 13, 'remark → 第 13 列', idxStd.remark);

/* ---------- 3. 表头映射 · 乱序 + 别名 ---------- */
section('[表头映射 · 乱序 + 别名]');
const idx2 = M.mapImportHeader(['备注', '存放位置', '夹具名称', '夹具编号', '适用机种', '类别', '多余列A', '线体', '工位名称']);
ok(idx2.name === 2, '「夹具名称」别名 → name', idx2.name);
ok(idx2.serialNo === 3, '「夹具编号」别名 → serialNo（v4 语义反转）', idx2.serialNo);
ok(idx2.location === 1, '「存放位置」别名 → location', idx2.location);
ok(idx2.category === 5, '「类别」别名 → category', idx2.category);
ok(idx2.lms === 4, '「适用机种」别名 → lms', idx2.lms);
ok(idx2.remark === 0, '「备注」→ remark', idx2.remark);
ok(idx2.lines === 7, '「线体」别名 → lines', idx2.lines);
ok(idx2.stations === 8, '「工位名称」别名 → stations', idx2.stations);
ok(idx2.lm1 === undefined && idx2.lm7 === undefined, '未出现的机种列不映射');

/* ---------- 4. 行解析 · 机种合并 ---------- */
section('[行解析 · 机种合并]');
const base = { serialNo: 'SN-001', location: 'ZP1-U-1-1' };
const idxLm = M.mapImportHeader(['机种名称1', '机种名称2', '机种名称3', '机种名称4', '机种名称5', '机种名称6', '机种名称7', '名称', '实物编号', '库位']);
let p = M.parseImportRow(['A', 'B', 'C', 'D', 'E', 'F', 'G', '夹具A', base.serialNo, base.location], idxLm);
ok(p.ok, '解析成功', p.reason);
ok(JSON.stringify(p.fixture.lineModels) === JSON.stringify(['A', 'B', 'C', 'D', 'E', 'F', 'G']),
  '7 个机种全部保留（上限由 4 提升到 7）', p.fixture.lineModels);

const idxLms = M.mapImportHeader(['机种名称', '名称', '实物编号', '库位']);
p = M.parseImportRow(['MODEL-A,MODEL-B;MODEL-C', '夹具B', base.serialNo, base.location], idxLms);
ok(p.ok && JSON.stringify(p.fixture.lineModels) === JSON.stringify(['MODEL-A', 'MODEL-B', 'MODEL-C']),
  '逗号/分号分隔的多机种被拆开', p.fixture.lineModels);

p = M.parseImportRow(['M1,M2,M3,M4,M5,M6,M7,M8,M9', '夹具C', base.serialNo, base.location], idxLms);
ok(p.ok && p.fixture.lineModels.length === 7, '机种超过 7 个时截断到 7', p.fixture.lineModels);

p = M.parseImportRow(['MODEL-A,MODEL-A', '夹具D', base.serialNo, base.location], idxLms);
ok(p.ok && JSON.stringify(p.fixture.lineModels) === JSON.stringify(['MODEL-A']), '重复机种去重', p.fixture.lineModels);

/* ---------- 5. 行解析 · 必填校验 ---------- */
section('[行解析 · 校验]');
const idxV = M.mapImportHeader(['实物编号', '名称', '机种名称1', '库位', '产线', '工位']);
p = M.parseImportRow(['SN-1', '', 'M', 'ZP1-U-1-1', 'L1', '工位A'], idxV);
ok(!p.ok && /名称为空/.test(p.reason), '名称为空被拒绝', p.reason);

p = M.parseImportRow(['', '夹具E', 'M', 'ZP1-U-1-1', 'L1', '工位A'], idxV);
ok(!p.ok && /实物编号/.test(p.reason), '实物编号为空被拒绝', p.reason);

p = M.parseImportRow(['SN-1', '夹具E', 'M', '', 'L1', '工位A'], idxV);
ok(!p.ok && /库位/.test(p.reason), '库位为空被拒绝', p.reason);

p = M.parseImportRow(['SN-1', '夹具E', 'M', 'A-1', 'L1', '工位A'], idxV);
ok(!p.ok && /4 段式/.test(p.reason), '库位非 4 段式被拒绝', p.reason);

p = M.parseImportRow(['SN-1', '夹具E', '', 'ZP1-U-1-1', 'L1', '工位A'], idxV);
ok(!p.ok && /机种/.test(p.reason), '机种名称为空被拒绝', p.reason);

p = M.parseImportRow(['SN-1', '夹具E', 'M', 'ZP1-U-1-1', 'L1', '工位A'], idxV);
ok(p.ok && p.fixture.lineNames[0] === 'L1' && p.fixture.stationNames[0] === '工位A',
  '产线 / 工位名称被解析成数组', [p.fixture.lineNames, p.fixture.stationNames]);

p = M.parseImportRow(['SN-1', '夹具E', 'M', 'ZP1-U-1-1', 'L1,L2', '工位A、工位B'], idxV);
ok(p.ok && p.fixture.lineNames.length === 2 && p.fixture.stationNames.length === 2,
  '多产线 / 多工位用分隔符拆开', [p.fixture.lineNames, p.fixture.stationNames]);

/* ---------- 6. buildImportPlan（夹具导入）· 端到端 ---------- */
section('[夹具导入 buildImportPlan · 端到端]');
const L1 = { id: 11, name: 'L1 总装线', type: 'linear' };
const L2 = { id: 22, name: 'L2 U型线', type: 'u' };
const S11 = { id: 111, lineId: 11, name: '上料工位', seq: 10 };
const S12 = { id: 112, lineId: 11, name: '压装工位', seq: 20 };
const S21 = { id: 221, lineId: 22, name: '工位一', seq: 10 };

const ctxFix = {
  lines: [L1, L2],
  stations: [S11, S12, S21],
  fixtures: [
    { id: 1, code: '1001', serialNo: 'SN-OLD', name: '已有夹具', lines: [11], stations: [111] },
    { id: 2, code: '1002', serialNo: 'SN-DUP', name: '重号甲', status: 'stocked', lines: [11], stations: [111] },
    { id: 3, code: '1003', serialNo: 'SN-DUP', name: '重号乙', status: 'checked_out', lines: [11], stations: [112] }
  ]
};
const fixRows = [
  ['实物编号', '名称', '机种名称1', '分类', '库位', '产线', '工位', '备注'],
  ['SN-OLD', '追加另一条产线', 'MODEL-A', '冲压', 'ZP1-U-1-1', 'L2 U型线', '工位一', 'ok'],
  ['SN-NEW', '全新夹具', 'MODEL-B', '焊接', 'ZP1-U-2-1', 'L1 总装线', '上料工位', 'ok'],
  ['SN-OLD', '产线未建档', 'MODEL-C', '装配', 'ZP1-U-3-1', 'LX 未知线', '工位X', '产线不存在'],
  ['', '实物编号为空', 'MODEL-D', '装配', 'ZP1-U-4-1', 'L1 总装线', '上料工位', '必填缺失'],
  ['SN-OLD', '工位不属该产线', 'MODEL-E', '装配', 'ZP1-U-5-1', 'L1 总装线', '工位一', '工位归属错误'],
  ['SN-DUP', '重号记录', 'MODEL-F', '冲压', 'ZP1-U-6-1', 'L1 总装线', '压装工位', '重号提示'],
  ['SN-OLD', '', 'MODEL-G', '冲压', 'ZP1-U-7-1', 'L1 总装线', '上料工位', '名称为空']
];
const fxPlan = M.buildImportPlan(fixRows, ctxFix);
ok(fxPlan.ok, '生成夹具导入计划成功', fxPlan.error);
ok(fxPlan.plan.length === 3, '3 条有效数据', fxPlan.plan.length);
ok(fxPlan.skipped.length === 4, '4 条被跳过', fxPlan.skipped.length);
const fxSkip = fxPlan.skipped.map((s) => s.reason).join(' | ');
ok(/产线「LX 未知线」未建档/.test(fxSkip), '未建档产线被跳过', fxSkip);
ok(/实物编号为空或格式不合法/.test(fxSkip), '实物编号缺失被跳过', fxSkip);
ok(/工位「工位一」不属于已选产线/.test(fxSkip), '工位归属错误被跳过', fxSkip);
ok(/名称为空/.test(fxSkip), '名称为空被跳过', fxSkip);

const fxByName = {};
fxPlan.plan.forEach((p) => { fxByName[p.fixture.name] = p; });
ok(fxByName['追加另一条产线'].fixture.lines.join(',') === '22'
  && fxByName['追加另一条产线'].fixture.stations.join(',') === '221',
  '产线 / 工位名称被正确反查为 id', fxByName['追加另一条产线'].fixture);
ok(fxByName['全新夹具'].fixture.serialNo === 'SN-NEW', '实物编号原样保留');
ok(typeof fxByName['重号记录'].dupHint === 'string' && /已有 2 套/.test(fxByName['重号记录'].dupHint),
  '重号给出持有量提示', fxByName['重号记录'].dupHint);
ok(fxByName['重号记录'].fixture.code === undefined, '桥梁编号不由表格提供（系统分配）',
  fxByName['重号记录'].fixture.code);

/* ---------- 7. buildLineImportPlan（产线导入）· 端到端 ---------- */
section('[产线导入 buildLineImportPlan · 端到端]');
ok(M.LINE_IMPORT_HEADERS.length === 6, '产线导入模板为 6 列', M.LINE_IMPORT_HEADERS.length);
ok(M.LINE_IMPORT_HEADERS.join('|') === '线体|线体形态|工位|工位顺序|夹具编号|备注',
  '产线导入模板删掉产品两列', M.LINE_IMPORT_HEADERS.join('|'));

const lineRows = [
  ['线体', '线体形态', '工位', '工位顺序', '夹具编号', '备注'],
  ['L2 U型线', 'U型', '工位一', '10', 'SN-OLD', '给已有夹具追加另一条产线'],
  ['L1 总装线', '直线形', '压装工位', '20', 'SN-OLD', '同一套夹具再加一个工位'],
  ['L1 总装线', '直线形', '上料工位', '10', 'SN-NOTEXIST', '夹具未建档应跳过'],
  ['L1 总装线', '直线形', '上料工位', '10', '', '夹具编号为空应跳过'],
  ['L2 U型线', 'U型', '工位一', '10', 'SN-OLD', '文件内重复行应去重'],
  ['L1 总装线', '直线形', '上料工位', '10', 'SN-OLD', '既有产线 + 既有工位应忽略'],
  ['L9 新线', '直线形', '新工位', '35', 'SN-OLD', '线体 / 工位未建档则自动补建'],
  ['L1 总装线', '直线形', '', '10', 'SN-OLD', '工位为空应跳过']
];
const lnPlan = M.buildLineImportPlan(lineRows, ctxFix);
ok(lnPlan.ok, '生成产线导入计划成功', lnPlan.error);
ok(lnPlan.appends.length === 3, '3 行有效追加', lnPlan.appends.length);
ok(lnPlan.skipped.length === 5, '5 行被跳过', lnPlan.skipped.length);

const lnSkip = lnPlan.skipped.map((s) => s.reason).join(' | ');
ok(/未建档/.test(lnSkip), '夹具未建档的行被跳过', lnSkip);
ok(/重复行/.test(lnSkip), '文件内重复行被跳过', lnSkip);
ok(/已关联/.test(lnSkip), '已存在关联的行被忽略', lnSkip);
ok(/空缺/.test(lnSkip), '工位空缺的行被跳过', lnSkip);

const bySerial = {};
lnPlan.appends.forEach((a) => {
  bySerial[a.serialNo] = bySerial[a.serialNo] || [];
  bySerial[a.serialNo].push(a);
});
ok(bySerial['SN-OLD'].length === 3, 'SN-OLD 命中 3 条追加', bySerial['SN-OLD'].length);
const addL2 = bySerial['SN-OLD'].find((a) => a.lineName === 'L2 U型线');
ok(addL2 && addL2.addLine === true && addL2.addStation === true, '新产线 + 新工位都标记为新增', addL2);
const addS12 = bySerial['SN-OLD'].find((a) => a.stationName === '压装工位');
ok(addS12 && addS12.addLine === false && addS12.addStation === true, '已有产线只新增工位', addS12);

ok(lnPlan.newLines.length === 1 && lnPlan.newLines[0].name === 'L9 新线',
  '未建档的线体被登记为待新建', lnPlan.newLines);
ok(lnPlan.newStations.length === 1 && lnPlan.newStations[0].name === '新工位'
  && lnPlan.newStations[0].lineName === 'L9 新线', '未建档的工位被登记为待新建', lnPlan.newStations);
ok(lnPlan.newStations[0].seq === 35, '工位顺序被解析为数字', lnPlan.newStations[0]);

/* ---------- 8. buildLineImportPlan · 异常 ---------- */
section('[产线导入 buildLineImportPlan · 异常]');
ok(M.buildLineImportPlan([['实物编号'], ['SN-1']], {}).ok === false, '缺线体列 → 报错',
  M.buildLineImportPlan([['实物编号'], ['SN-1']], {}).error);
ok(M.buildLineImportPlan([['线体'], ['L1']], {}).ok === false, '缺工位列 → 报错',
  M.buildLineImportPlan([['线体'], ['L1']], {}).error);
ok(M.buildLineImportPlan([['线体', '工位'], ['L1', '上料工位']], {}).ok === false, '缺夹具编号列 → 报错',
  M.buildLineImportPlan([['线体', '工位'], ['L1', '上料工位']], {}).error);
ok(M.buildLineImportPlan([['线体', '工位', '夹具编号']], {}).ok === false, '只有表头无数据行 → 报错',
  M.buildLineImportPlan([['线体', '工位', '夹具编号']], {}).error);
ok(M.buildLineImportPlan([], {}).ok === false, '空数组 → 报错', M.buildLineImportPlan([], {}).error);
ok(M.buildLineImportPlan([['线体', '工位', '夹具编号'], ['  ', '　', '']], {}).ok === false,
  '数据行全为空白 → 报错（无有效行）',
  M.buildLineImportPlan([['线体', '工位', '夹具编号'], ['  ', '　', '']], {}).error);
const noFix = M.buildLineImportPlan(
  [['线体', '工位', '夹具编号'], ['L1 总装线', '上料工位', 'SN-NOTEXIST']],
  { lines: [L1], stations: [S11], fixtures: [] });
ok(noFix.ok === false, '夹具编号在库中不存在 → 无有效行', noFix.error);
ok(/未建档/.test((noFix.skipped || []).map((s) => s.reason).join('|')), '失败时仍返回逐行原因', noFix.skipped);

const dupFix = M.buildLineImportPlan(
  [['线体', '工位', '夹具编号'], ['L1 总装线', '上料工位', 'SN-DUP']],
  { lines: [L1], stations: [S11], fixtures: ctxFix.fixtures });
ok(dupFix.ok === false, '实物编号对应多套 → 无法唯一定位 → 无有效行', dupFix.error);
ok(/对应 2 套/.test((dupFix.skipped || []).map((s) => s.reason).join('|')),
  '重号无法定位给出明确原因', (dupFix.skipped || []).map((s) => s.reason).join('|'));

/* ---------- 9. buildLineImportPlan · 上限 ---------- */
section('[产线导入 buildLineImportPlan · 上限]');
/* L0（id 100）下挂 10 个工位 S0..S9；L1..L5（101..105）各挂 1 个工位 */
const manyLines = [{ id: 100, name: 'L0', type: 'linear' }];
const manyStations = [];
for (let i = 0; i < 10; i++) manyStations.push({ id: 1000 + i, lineId: 100, name: 'S' + i, seq: i });
for (let i = 1; i <= 5; i++) {
  manyLines.push({ id: 100 + i, name: 'L' + i, type: 'linear' });
  manyStations.push({ id: 1100 + i, lineId: 100 + i, name: 'S' + i, seq: 10 });
}
/* 供「未达上限」用：L0 下的第 11 个工位（id 1010 占位 → 用 1011 避免与 S10 冲突） */
manyStations.push({ id: 1011, lineId: 100, name: 'S10B', seq: 100 });
manyStations.push({ id: 1012, lineId: 100, name: 'S10C', seq: 101 });

/* ① 产线已达 5 条上限 */
const limFix = [
  { id: 9, code: '1009', serialNo: 'SN-LIM', name: '满产线夹具',
    lines: [100, 101, 102, 103, 104], stations: [1000] }
];
const limPlan = M.buildLineImportPlan(
  [['线体', '工位', '夹具编号'], ['L5', 'S5', 'SN-LIM']],
  { lines: manyLines, stations: manyStations, fixtures: limFix });
ok(limPlan.ok === false, '产线已达上限 5 条 → 整表无有效行', limPlan.error);
ok(/上限 5/.test((limPlan.skipped || []).map((s) => s.reason).join('|')), '提示中给出产线上限',
  (limPlan.skipped || []).map((s) => s.reason).join('|'));

/* ② 工位已达 10 个上限 */
const stFix = [
  { id: 8, code: '1008', serialNo: 'SN-STFULL', name: '满工位夹具',
    lines: [100], stations: [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009] }
];
const stLimitPlan = M.buildLineImportPlan(
  [['线体', '工位', '夹具编号'], ['L0', 'S10B', 'SN-STFULL']],
  { lines: manyLines, stations: manyStations, fixtures: stFix });
ok(stLimitPlan.ok === false, '工位已达上限 10 个 → 无有效行', stLimitPlan.error);
ok(/上限 10/.test((stLimitPlan.skipped || []).map((s) => s.reason).join('|')),
  '提示中给出工位上限', (stLimitPlan.skipped || []).map((s) => s.reason).join('|'));

/* ③ 未达上限 → 只追加工位、不重复加产线 */
const st9 = [{ id: 7, code: '1007', serialNo: 'SN-ST9', name: '第 9 个工位',
  lines: [100], stations: [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008] }];
const okPlan = M.buildLineImportPlan(
  [['线体', '工位', '夹具编号'], ['L0', 'S10C', 'SN-ST9']],
  { lines: manyLines, stations: manyStations, fixtures: st9 });
ok(okPlan.ok === true, '未达工位上限时可追加', okPlan.error);
ok(okPlan.appends[0].addStation === true && okPlan.appends[0].addLine === false,
  '已有产线只追加工位', okPlan.appends[0]);
ok(okPlan.newLines.length === 0 && okPlan.newStations.length === 0, '无需新建线体 / 工位',
  [okPlan.newLines, okPlan.newStations]);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
