'use strict';
/* ============================================================
 * test_import.js — 验证 app.js 的「夹具批量导入」纯函数（v4.0.0）
 *
 * v4.0.0 语义变化：
 *   · 表格**不再提供**序号 code（一律系统自动分配）
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
// ①-b 关联字段派生（线体/工位 id → 名称，导出用）
const relSrc = slice('/* ---------------- 关联字段派生显示', '/* 某产线下已选的工位');
// ② 夹具导入模块（FIX_IMPORT_HEADERS → 导入入口之前）
const importSrc = slice('const FIX_IMPORT_HEADERS', '/* 导入入口');
// ③ 产线导入模块（LINE_IMPORT_HEADERS → 落库函数之前；纯计划逻辑）
const lineImportSrc = slice('const LINE_IMPORT_HEADERS', '/* 落库：');
// ④ 下载夹具模板（示例行需与表头列数一致）
const tmplSrc = slice('/* 下载导入模板', 'window.fixtureRetire');
// ⑤ 夹具清单导出（v4.5.0：列定义必须与模板同构，才能「导出 → 回灌」）
const exportSrc = slice('window.fixtureExportCSV = async function', '/* ============================================================\n   * 夹具批量导入');

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
  closeModal: () => {},
  confirm: () => true,
  download: (name, content) => { sandbox.__downloaded = { name, content }; }
};
sandbox.global = sandbox;
const vm = require('vm');
const ctx = vm.createContext(sandbox);

let moduleSrc = constSrc + '\n' + relSrc + '\n' + importSrc + '\n' + tmplSrc + '\n' + exportSrc + '\n' + lineImportSrc;
moduleSrc = moduleSrc.replace(/window\.__importPlan/g, '__importPlan')
  .replace(/window\.__lineImportPlan/g, '__lineImportPlan')
  .replace(/window\.showImportPreview/g, '__export_showImportPreview')
  .replace(/window\.confirmImportPlan/g, '__export_confirmImportPlan')
  .replace(/window\.downloadFixtureTemplate/g, '__export_downloadFixtureTemplate')
  .replace(/window\.fixtureImport/g, '__export_fixtureImport')
  .replace(/window\.fixtureExportCSV/g, '__export_fixtureExportCSV');
moduleSrc += `
;__export = { FIX_IMPORT_HEADERS, FIX_IMPORT_ALIAS, normalizeHeader, mapImportHeader,
              parseImportRow, splitNames, buildImportPlan,
              LINE_IMPORT_HEADERS, LINE_IMPORT_ALIAS, mapLineImportHeader, parseLineType,
              buildLineImportPlan,
              MAX_LINE_MODELS, MAX_LINES, MAX_STATIONS, isValidSerialNo, isValidLocation,
              MAX_CATEGORY, isValidCategory, CATEGORY_PRESETS,
              stationNamesOf, fixtureLinePairsForExport,
              _sigOfNames, _sigOfFixture,
              __export_confirmImportPlan, undoFixtureImport: window.undoFixtureImport, showImportFailure,
              __export_downloadFixtureTemplate, __export_fixtureExportCSV };
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

/* ---------- 2. 表头映射 · 标准顺序（v4.2.0 的 22 列成对模板） ---------- */
section('[表头映射 · 标准]');
ok(M.FIX_IMPORT_HEADERS.length === 22, '模板为 22 列', M.FIX_IMPORT_HEADERS.length);
ok(M.FIX_IMPORT_HEADERS[0] === '夹具编号' && M.FIX_IMPORT_HEADERS[9] === '分类'
  && M.FIX_IMPORT_HEADERS[10] === '库位'
  && M.FIX_IMPORT_HEADERS[11] === '产线1' && M.FIX_IMPORT_HEADERS[12] === '工位1'
  && M.FIX_IMPORT_HEADERS[19] === '产线5' && M.FIX_IMPORT_HEADERS[20] === '工位5'
  && M.FIX_IMPORT_HEADERS[21] === '备注', '模板列序符合定稿（产线/工位成对）',
  M.FIX_IMPORT_HEADERS.join('|'));

const idxStd = M.mapImportHeader(M.FIX_IMPORT_HEADERS);
ok(idxStd.serialNo === 0, 'serialNo → 第 0 列', idxStd.serialNo);
ok(idxStd.name === 1, 'name → 第 1 列', idxStd.name);
ok(idxStd.lm1 === 2 && idxStd.lm4 === 5 && idxStd.lm7 === 8, '机种 1~7 列正确',
  [idxStd.lm1, idxStd.lm4, idxStd.lm7]);
ok(idxStd.category === 9, 'category → 第 9 列', idxStd.category);
ok(idxStd.location === 10, 'location → 第 10 列', idxStd.location);
ok(idxStd.line1 === 11 && idxStd.station1 === 12, '产线1/工位1 → 第 11/12 列',
  [idxStd.line1, idxStd.station1]);
ok(idxStd.line5 === 19 && idxStd.station5 === 20, '产线5/工位5 → 第 19/20 列',
  [idxStd.line5, idxStd.station5]);
ok(idxStd.remark === 21, 'remark → 第 21 列', idxStd.remark);

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
ok(!p.ok && /夹具编号/.test(p.reason), '夹具编号为空被拒绝', p.reason);

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

/* ---------- 5.1 行解析 · 成对列（v4.2.0 多产线层级） ---------- */
section('[行解析 · 成对列]');
const idxPair = M.mapImportHeader(['夹具编号', '名称', '机种名称1', '库位', '产线1', '工位1', '产线2', '工位2']);
let pp = M.parseImportRow(['SN-P1', '跨线夹具', 'M', 'ZP1-U-1-1', '3 号线', '1号工位 / 2号工位', 'L2 U型线', '1号工位'], idxPair);
ok(pp.ok, '成对列解析成功', pp.reason);
ok(pp.fixture.legacyFlat === false, '成对列不标记为旧扁平模板');
ok(pp.fixture.linePairs.length === 2, '解析出 2 对产线', pp.fixture.linePairs);
ok(pp.fixture.linePairs[0].lineName === '3 号线'
  && pp.fixture.linePairs[0].stationNames.join(',') === '1号工位,2号工位',
  '第 1 对：3 号线 → 1号工位、2号工位', pp.fixture.linePairs[0]);
ok(pp.fixture.linePairs[1].lineName === 'L2 U型线'
  && pp.fixture.linePairs[1].stationNames.join(',') === '1号工位',
  '第 2 对：L2 U型线 → 1号工位', pp.fixture.linePairs[1]);
ok(pp.fixture.lineNames.join(',') === '3 号线,L2 U型线', '产线去重汇总正确', pp.fixture.lineNames);
ok(pp.fixture.stationNames.join(',') === '1号工位,2号工位', '工位去重汇总正确', pp.fixture.stationNames);

/* 旧扁平列：仍按「每条产线 × 全部工位」展开（向后兼容） */
const idxFlat = M.mapImportHeader(['夹具编号', '名称', '机种名称1', '库位', '产线', '工位']);
pp = M.parseImportRow(['SN-F1', '旧模板夹具', 'M', 'ZP1-U-1-1', 'L1,L2', 'A、B'], idxFlat);
ok(pp.ok && pp.fixture.legacyFlat === true, '旧扁平模板被识别为兼容模式');
ok(pp.fixture.linePairs.length === 2 && pp.fixture.linePairs.every((x) => x.stationNames.length === 2),
  '旧模板按「每条产线 × 全部工位」展开（行为不变）', pp.fixture.linePairs);

/* ---------- 5.2 分类校验（v4.2.0） ---------- */
section('[分类校验]');
ok(M.CATEGORY_PRESETS.indexOf('金属') >= 0 && M.CATEGORY_PRESETS.indexOf('PVC') >= 0,
  '预设含金属 / PVC', M.CATEGORY_PRESETS);
ok(M.isValidCategory('') === true, '空分类允许（= 未分类）');
ok(M.isValidCategory('金属') === true, '常规分类通过');
ok(M.isValidCategory('x'.repeat(M.MAX_CATEGORY)) === true, '达到上限长度通过');
ok(M.isValidCategory('x'.repeat(M.MAX_CATEGORY + 1)) === false, '超过上限长度被拒');
ok(M.isValidCategory('a|b') === false, '含竖线被拒');

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
  ['SN-OLD', '产线未建档', 'MODEL-C', '装配', 'ZP1-U-3-1', 'LX 未知线', '工位X', '产线未建档→自动补建'],
  ['', '实物编号为空', 'MODEL-D', '装配', 'ZP1-U-4-1', 'L1 总装线', '上料工位', '必填缺失'],
  ['SN-OLD', '工位不属该产线', 'MODEL-E', '装配', 'ZP1-U-5-1', 'L1 总装线', '工位一', '工位未在该产线下→自动补建'],
  ['SN-DUP', '重号记录', 'MODEL-F', '冲压', 'ZP1-U-6-1', 'L1 总装线', '压装工位', '重号提示'],
  ['SN-OLD', '', 'MODEL-G', '冲压', 'ZP1-U-7-1', 'L1 总装线', '上料工位', '名称为空']
];
const fxPlan = M.buildImportPlan(fixRows, ctxFix);
ok(fxPlan.ok, '生成夹具导入计划成功', fxPlan.error);
ok(fxPlan.plan.length === 5, '5 条有效数据（未建档产线/工位改为自动补建，不再整行跳过）', fxPlan.plan.length);
ok(fxPlan.skipped.length === 2, '2 条被跳过（仅必填缺失 / 名称为空）', fxPlan.skipped.length);
const fxSkip = fxPlan.skipped.map((s) => s.reason).join(' | ');
ok(/夹具编号为空或格式不合法/.test(fxSkip), '夹具编号缺失被跳过', fxSkip);
ok(/名称为空/.test(fxSkip), '名称为空被跳过', fxSkip);
ok(fxPlan.plan._autoLines.indexOf('LX 未知线') >= 0, '未建档产线被登记为待自动补建', fxPlan.plan._autoLines);
ok(fxPlan.plan._autoStations.some((s) => s.lineName === 'LX 未知线' && s.name === '工位X'), '未建档产线下的工位被登记为待自动补建', fxPlan.plan._autoStations);
ok(fxPlan.plan._autoStations.some((s) => s.lineName === 'L1 总装线' && s.name === '工位一'), '跨产线重名工位自动补建到本行产线', fxPlan.plan._autoStations);

const fxByName = {};
fxPlan.plan.forEach((p) => { fxByName[p.fixture.name] = p; });
ok(fxByName['追加另一条产线'].fixture.lineNames.join(',') === 'L2 U型线'
  && fxByName['追加另一条产线'].fixture.stationNames.join(',') === '工位一',
  '产线 / 工位名称原样保留供落库时解析', fxByName['追加另一条产线'].fixture);
ok(fxByName['全新夹具'].fixture.serialNo === 'SN-NEW', '实物编号原样保留');
ok(typeof fxByName['重号记录'].dupHint === 'string' && /已有 2 套/.test(fxByName['重号记录'].dupHint),
  '重号给出持有量提示', fxByName['重号记录'].dupHint);
ok(fxByName['重号记录'].fixture.code === undefined, '序号不由表格提供（系统分配）',
  fxByName['重号记录'].fixture.code);

/* ---------- 6.1 成对列 · 层级不串线（v4.2.0 核心回归） ---------- */
section('[成对列 · 层级不串线]');
const pairRows = [
  ['夹具编号', '名称', '机种名称1', '库位', '产线1', '工位1', '产线2', '工位2'],
  ['SN-PA', '两条线各一个工位', 'M1', 'ZP1-U-9-1', 'L1 总装线', '上料工位', 'L2 U型线', '工位一']
];
const pairPlan = M.buildImportPlan(pairRows, ctxFix);
ok(pairPlan.ok && pairPlan.plan.length === 1, '成对列生成导入计划', pairPlan.error);
const pf = pairPlan.plan[0].fixture;
ok(pf.linePairs.length === 2
  && pf.linePairs[0].lineName === 'L1 总装线' && pf.linePairs[0].stationNames.join(',') === '上料工位'
  && pf.linePairs[1].lineName === 'L2 U型线' && pf.linePairs[1].stationNames.join(',') === '工位一',
  '层级原样保留（每条产线只带自己的工位）', pf.linePairs);
ok(!pairPlan.plan._autoStations.some((s) => s.lineName === 'L1 总装线' && s.name === '工位一'),
  '不把「工位一」错误补建到 L1 下（旧笛卡尔积缺陷已修复）', pairPlan.plan._autoStations);
ok(!pairPlan.plan._autoStations.some((s) => s.lineName === 'L2 U型线' && s.name === '上料工位'),
  '不把「上料工位」错误补建到 L2 下（旧笛卡尔积缺陷已修复）', pairPlan.plan._autoStations);

const pairNew = M.buildImportPlan([
  ['夹具编号', '名称', '机种名称1', '库位', '产线1', '工位1', '产线2', '工位2'],
  ['SN-PB', '新工位夹具', 'M2', 'ZP1-U-9-2', 'L2 U型线', '上料工位', '', '']
], ctxFix);
ok(pairNew.ok && pairNew.plan._autoStations.length === 1
  && pairNew.plan._autoStations[0].lineName === 'L2 U型线'
  && pairNew.plan._autoStations[0].name === '上料工位',
  '未建档工位只补建到所在产线下', pairNew.plan._autoStations);

const pairZero = M.buildImportPlan([
  ['夹具编号', '名称', '机种名称1', '库位', '产线1', '工位1', '产线2', '工位2'],
  ['SN-PC', '某线工位待定', 'M3', 'ZP1-U-9-3', 'L1 总装线', '', 'L2 U型线', '工位一']
], ctxFix);
ok(pairZero.ok && pairZero.plan.length === 1,
  '单条产线允许 0 工位（全记录工位 ≥1 即可）', pairZero.error);

/* ---------- 6.2 导出 → 导入 往返一致 ---------- */
section('[导出 → 导入 往返]');
sandbox.state.lines = [L1, L2];
sandbox.state.stations = [S11, S12, S21];
const f0 = { lines: [11, 22], stations: [111, 221] };
const pairs0 = M.fixtureLinePairsForExport(f0);
ok(pairs0.length === 2
  && pairs0[0].lineName === 'L1 总装线' && pairs0[0].stationNames.join(',') === '上料工位'
  && pairs0[1].lineName === 'L2 U型线' && pairs0[1].stationNames.join(',') === '工位一',
  '导出：扁平 id 还原为「产线 → 工位」层级', pairs0);

/* 按导出的成对列拼一行（严格按 22 列模板定位），再当成导入模板解析回来 */
const rowOut = new Array(M.FIX_IMPORT_HEADERS.length).fill('');
rowOut[0] = 'SN-RT';
rowOut[1] = '往返夹具';
rowOut[2] = 'MODEL-R';
rowOut[9] = '金属';
rowOut[10] = 'ZP1-U-1-1';
for (let i = 0; i < 5; i++) {
  const pr = pairs0[i];
  rowOut[11 + i * 2] = pr ? pr.lineName : '';
  rowOut[12 + i * 2] = pr ? pr.stationNames.join(' / ') : '';
}
rowOut[21] = '往返测试';
const rt = M.parseImportRow(rowOut, M.mapImportHeader(M.FIX_IMPORT_HEADERS));
ok(rt.ok, '导出行可被导入模板解析', rt.reason);
ok(JSON.stringify(rt.fixture.linePairs) === JSON.stringify(pairs0),
  '往返后层级完全一致（导出文件可直接回灌）', rt.fixture.linePairs);

/* ---------- 6.3 下载模板：示例行列数与表头一致 ---------- */
section('[下载模板 · 列对齐]');
M.__export_downloadFixtureTemplate();
const dl = sandbox.__downloaded || {};
const csvLines = String(dl.content || '').replace(/^\uFEFF/, '').split('\r\n').filter((x) => x !== '');
ok(/夹具导入模板\.csv$/.test(dl.name || ''), '模板文件名为「夹具导入模板.csv」', dl.name);
ok(csvLines.length === 4, '模板含 1 行表头 + 3 行示例', csvLines.length);
ok(csvLines[0].split(',').length === M.FIX_IMPORT_HEADERS.length,
  '表头列数 = FIX_IMPORT_HEADERS', csvLines[0].split(',').length);
ok(csvLines.slice(1).every((ln) => ln.split(',').length === M.FIX_IMPORT_HEADERS.length),
  '每行示例的列数与表头一致（字段不会错位）',
  csvLines.slice(1).map((ln) => ln.split(',').length));

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

/* ---------- 9. 导入幂等：同一份表导两次不能翻倍（v4.4.0） ---------- */
section('[导入幂等 · 重复识别]');

function mkFixRow(o) {
  const row = new Array(M.FIX_IMPORT_HEADERS.length).fill('');
  const put = (h, v) => { const i = M.FIX_IMPORT_HEADERS.indexOf(h); if (i >= 0) row[i] = v; };
  put('夹具编号', o.serialNo); put('名称', o.name);
  put('机种名称1', o.model || 'MODEL-A');
  put('分类', o.cat || '金属'); put('库位', o.loc);
  put('产线1', o.line1 == null ? 'L1 总装线' : o.line1);
  put('工位1', o.st1 == null ? 'S1 上料工位' : o.st1);
  put('备注', o.remark || '');
  return row;
}
const HDR = M.FIX_IMPORT_HEADERS.slice();

/* 9.1 库内为空：表内两行完全相同也必须都进计划（同库位放 2 套同号是合法业务） */
const rowsDupInFile = [HDR,
  mkFixRow({ serialNo: 'SN-D1', name: '同号夹具', loc: 'ZP1-U-1-1' }),
  mkFixRow({ serialNo: 'SN-D1', name: '同号夹具', loc: 'ZP1-U-1-1' })];
const p1 = M.buildImportPlan(rowsDupInFile, { fixtures: [], lines: [], stations: [] });
ok(p1.ok && p1.plan.length === 2, '批次内两行完全相同的记录都能进计划', p1.error);
ok(p1.plan._dupCount === 0 && p1.plan.every((p) => p.isDup === false),
  '库内为空时不做批次内去重（保护同库位多套同号）', p1.plan._dupCount);

const fakeLines = [{ id: 101, name: 'L1 总装线', type: 'linear' }];
const fakeStations = [{ id: 201, lineId: 101, name: 'S1 上料工位' }];
const mkFix = (id, o) => ({
  id, code: 1000 + id, serialNo: o.serialNo, name: o.name, lineModels: [o.model || 'MODEL-A'],
  category: o.cat || '金属', location: o.loc, remark: o.remark || '',
  lines: [101], stations: [201], status: 'stocked'
});
const existing2 = [mkFix(1, { serialNo: 'SN-D1', name: '同号夹具', loc: 'ZP1-U-1-1' }),
  mkFix(2, { serialNo: 'SN-D1', name: '同号夹具', loc: 'ZP1-U-1-1' })];

/* 9.2 同一份表再导一次（库内已有 2 套）→ 两行都判重复 */
const p2 = M.buildImportPlan(rowsDupInFile, { fixtures: existing2, lines: fakeLines, stations: fakeStations });
ok(p2.plan._dupCount === 2, '整份表重复导入 → 2 行全判重复', p2.plan._dupCount);
ok(p2.plan.every((p) => p.isDup === true), '两行 isDup 都为 true', p2.plan.map((p) => p.isDup));

/* 9.3 多重集 1:1 配对：库内只有 1 套、本次带来 2 行 → 1 重复 + 1 新增 */
const p3 = M.buildImportPlan(rowsDupInFile, { fixtures: [existing2[0]], lines: fakeLines, stations: fakeStations });
ok(p3.plan._dupCount === 1 && p3.plan[0].isDup === true && p3.plan[1].isDup === false,
  '库内 1 套 + 本次 2 行 → 1 重复 1 新增（不重复计数）', p3.plan.map((p) => p.isDup));

/* 9.4 任一字段不同即不算重复 */
[
  { label: '库位不同', row: mkFixRow({ serialNo: 'SN-D1', name: '同号夹具', loc: 'ZP1-U-1-2' }) },
  { label: '名称不同', row: mkFixRow({ serialNo: 'SN-D1', name: '另一个名字', loc: 'ZP1-U-1-1' }) },
  { label: '分类不同', row: mkFixRow({ serialNo: 'SN-D1', name: '同号夹具', loc: 'ZP1-U-1-1', cat: 'PVC' }) },
  { label: '机种不同', row: mkFixRow({ serialNo: 'SN-D1', name: '同号夹具', loc: 'ZP1-U-1-1', model: 'MODEL-B' }) },
  { label: '备注不同', row: mkFixRow({ serialNo: 'SN-D1', name: '同号夹具', loc: 'ZP1-U-1-1', remark: '补录' }) },
  { label: '工位不同', row: mkFixRow({ serialNo: 'SN-D1', name: '同号夹具', loc: 'ZP1-U-1-1', st1: 'S2 压装工位' }) }
].forEach((v) => {
  const r = M.buildImportPlan([HDR, v.row], { fixtures: existing2, lines: fakeLines, stations: fakeStations });
  ok(r.plan._dupCount === 0, v.label + ' → 不判重复', r.plan._dupCount);
});

/* 9.5 整份表都不可导入时必须带回 skipped 明细（BUG-007） */
const badRows = [HDR,
  mkFixRow({ serialNo: 'SN-X1', name: '无产线', loc: 'ZP1-U-1-1', line1: '', st1: '' }),
  mkFixRow({ serialNo: 'SN-X2', name: '无产线2', loc: 'ZP1-U-1-1', line1: '', st1: '' })];
const p5 = M.buildImportPlan(badRows, { fixtures: [], lines: [], stations: [] });
ok(p5.ok === false, '产线 / 工位全空 → 整份不可导入', p5.error);
ok(Array.isArray(p5.skipped) && p5.skipped.length === 2, '失败结果里带回 skipped 明细',
  p5.skipped && p5.skipped.length);
ok((p5.skipped || []).every((s) => /产线/.test(s.reason)), '原因指向「产线为空」',
  (p5.skipped || []).map((s) => s.reason));

/* ---------- 10. 端到端：落库 / 幂等 / 撤销 ---------- */
(async () => {
  section('[导入幂等 · 落库与撤销]');
  /* 上面几节把 state.lines 设成了 L1/L2，这里必须清空，否则产线会命中旧的 id、db.lines 为空 → 签名反查不到产线名 */
  sandbox.state.fixtures = [];
  sandbox.state.lines = [];
  sandbox.state.stations = [];
  const db = { fixtures: [], lines: [], stations: [], seq: 1 };
  sandbox.DB.fixtureAdd = async (f) => {
    const id = db.seq++;
    db.fixtures.push(Object.assign({ id, code: 1000 + id, status: 'stocked' }, f));
    return id;
  };
  sandbox.DB.add = async (coll, obj) => {
    const id = db.seq++;
    if (coll === 'lines') db.lines.push(Object.assign({ id }, obj));
    else db.stations.push(Object.assign({ id }, obj));
    return id;
  };
  sandbox.DB.fixtureDel = async (id) => { db.fixtures = db.fixtures.filter((f) => f.id !== id); };
  sandbox.reloadAll = async () => {
    sandbox.state.fixtures = db.fixtures;
    sandbox.state.lines = db.lines;
    sandbox.state.stations = db.stations;
  };

  const rowsOnce = [HDR, mkFixRow({ serialNo: 'SN-E2E', name: '端到端夹具', loc: 'ZP1-U-2-2' })];
  const planA = M.buildImportPlan(rowsOnce, { fixtures: [], lines: [], stations: [] });
  sandbox.__importPlan = planA.plan;
  await M.__export_confirmImportPlan('all');
  ok(db.fixtures.length === 1, '首次导入落库 1 条', db.fixtures.length);
  const batch1 = db.fixtures[0] && db.fixtures[0].importBatch;
  ok(!!batch1, '落库记录带 importBatch 批次号', batch1);

  const planB = M.buildImportPlan(rowsOnce, { fixtures: db.fixtures, lines: db.lines, stations: db.stations });
  ok(planB.plan._dupCount === 1, '再导同一份表 → 判为重复', planB.plan._dupCount);
  sandbox.__importPlan = planB.plan;
  await M.__export_confirmImportPlan();          // 不传参 = 默认「跳过重复」
  ok(db.fixtures.length === 1, '默认「跳过重复」→ 记录数不变（不再是 2 条）', db.fixtures.length);

  const planC = M.buildImportPlan(rowsOnce, { fixtures: db.fixtures, lines: db.lines, stations: db.stations });
  sandbox.__importPlan = planC.plan;
  await M.__export_confirmImportPlan('all');     // 用户明确「全部导入」
  ok(db.fixtures.length === 2, '选「全部导入」→ 确实新增第 2 条', db.fixtures.length);
  const batch2 = db.fixtures[1].importBatch;
  ok(batch1 !== batch2, '两次导入批次号不同', [batch1, batch2]);

  await M.undoFixtureImport(batch2);
  ok(db.fixtures.length === 1 && db.fixtures[0].importBatch === batch1,
    '撤销本次导入只删这一批，上一批保留', db.fixtures.length);

  /* ---------- 6. 导出清单 与 导入模板 同构（v4.5.0 / BUG-009） ---------- */
  section('[导出清单 与 导入模板 同构]');
  /* 真 CSV 解析（带引号状态机）：验证「导出的文件能被 Excel/导入器正确还原」 */
  function parseCsvLine(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }
  sandbox.state.lines = [{ id: 1, name: 'L1 线' }, { id: 2, name: 'L2 线' }];
  sandbox.state.stations = [
    { id: 11, lineId: 1, name: '上料工位' },
    { id: 12, lineId: 1, name: '压装工位' },
    { id: 21, lineId: 2, name: '焊接工位' }
  ];
  sandbox.state.fixtures = [
    { id: 1, code: '1001', serialNo: 'SN-A', name: '夹具A', lineModels: ['M1', 'M2'], category: '金属',
      location: 'ZP1-U-1-1', lines: [1, 2], stations: [11, 12, 21], remark: '备注,含逗号' },
    { id: 2, code: '1002', serialNo: 'SN-B', name: '夹具B', lineModels: [], category: '',
      location: '', lines: [], stations: [], remark: '' }
  ];
  await M.__export_fixtureExportCSV();
  const dl = sandbox.__downloaded || {};
  const csv = String(dl.content || '').replace(/^\uFEFF/, '');
  const csvRows = csv.split('\r\n');
  ok(dl.name && /^夹具清单_\d{4}-\d{2}-\d{2}\.csv$/.test(dl.name), '导出文件名为 夹具清单_YYYY-MM-DD.csv', dl.name);
  ok(csvRows[0] === M.FIX_IMPORT_HEADERS.join(','), '导出表头与导入模板逐列一致（22 列同序）',
    csvRows[0]);
  ok(csvRows[0].indexOf('序号') < 0 && csvRows[0].indexOf('状态') < 0 && csvRows[0].indexOf('累计出库') < 0,
    '导出不再带模板外列（序号 / 状态 / 累计出库）', csvRows[0]);
  const rowA = parseCsvLine(csvRows[1]);
  const unq = (v) => String(v);
  ok(rowA.length === 22, '数据行 22 列（与模板列数一致）', rowA.length);
  ok(unq(rowA[0]) === 'SN-A' && unq(rowA[1]) === '夹具A', '第 1/2 列 = 夹具编号 / 名称', [unq(rowA[0]), unq(rowA[1])]);
  ok(unq(rowA[2]) === 'M1' && unq(rowA[3]) === 'M2' && unq(rowA[4]) === '', '机种拆成 机种名称1~7 独立列',
    rowA.slice(2, 9).map(unq));
  ok(unq(rowA[9]) === '金属' && unq(rowA[10]) === 'ZP1-U-1-1', '分类 / 库位列位正确', [unq(rowA[9]), unq(rowA[10])]);
  ok(unq(rowA[11]) === 'L1 线' && unq(rowA[12]) === '上料工位 / 压装工位', '产线1 / 工位1 成对（多工位用 / 分隔）',
    [unq(rowA[11]), unq(rowA[12])]);
  ok(unq(rowA[13]) === 'L2 线' && unq(rowA[14]) === '焊接工位', '产线2 / 工位2 成对', [unq(rowA[13]), unq(rowA[14])]);
  ok(unq(rowA[21]) === '备注,含逗号', '备注列含逗号时正确加引号（可逆）', unq(rowA[21]));

  /* 导出 → 直接回灌：解析结果必须与原记录一致 */
  const idxExp = M.mapImportHeader(parseCsvLine(csvRows[0]));
  const back = M.parseImportRow(parseCsvLine(csvRows[1]), idxExp);
  ok(back.ok === true, '导出的数据行可直接被导入器解析', back.error);
  ok(back.fixture.serialNo === 'SN-A' && back.fixture.name === '夹具A', '回灌后 夹具编号/名称 一致',
    [back.fixture.serialNo, back.fixture.name]);
  ok(back.fixture.lineModels.join('|') === 'M1|M2', '回灌后 机种 一致', back.fixture.lineModels);
  ok(back.fixture.category === '金属' && back.fixture.location === 'ZP1-U-1-1', '回灌后 分类/库位 一致',
    [back.fixture.category, back.fixture.location]);
  ok(back.fixture.linePairs.length === 2
    && back.fixture.linePairs[0].lineName === 'L1 线'
    && back.fixture.linePairs[0].stationNames.join('|') === '上料工位|压装工位'
    && back.fixture.linePairs[1].lineName === 'L2 线',
    '回灌后 产线/工位层级 一致（不串线、不笛卡尔积）', back.fixture.linePairs);
  ok(back.fixture.remark === '备注,含逗号', '回灌后 备注 一致（引号转义可逆）', back.fixture.remark);

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
