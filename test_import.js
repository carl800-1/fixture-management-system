/* ============================================================
 * test_import.js — 夹具批量导入 / 导出 / 产线配置导入 的纯逻辑测试
 *
 * v5.0.0 适配：工位（station）模型已整体移除
 *   · 夹具导入/导出模板 = 17 列（夹具编号 / 名称 / 机种名称1~7 / 分类 / 库位 / 产线1~5 / 备注）
 *   · 产线配置导入模板 = 4 列（线体 / 线体形态 / 夹具编号 / 备注）
 *   · 旧模板里的「工位N / 工位 / 工位顺序」列不参与映射，静默忽略
 *   · 产线按名称引用，未建档则导入时自动补建（同名复用）
 * 用 vm 沙箱从 js/app.js 切片抽取纯函数，不启动 Electron。
 * 运行：node test_import.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function section(t) { console.log('\n[' + t + ']'); }
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; failures.push(label + (extra === undefined ? '' : ' -> ' + extra)); console.log('  ❌ ' + label + (extra === undefined ? '' : ' -> ' + extra)); }
}

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
// ①-b 产线名归一化（v4.5.1：导入时把 1 / 1# 归并成同一条产线）
const normSrc = slice('/* 产线名归一化：', '/* ---------------- 关联字段派生显示');
// ①-c 关联字段派生（产线 id → 名称，导出用；v5.0.0 起无工位）
const relSrc = slice('/* ---------------- 关联字段派生显示', '/* ---------------- 数量：派生值（不落库）');
// ② 夹具导入模块（FIX_IMPORT_HEADERS → 导入入口之前）
const importSrc = slice('const FIX_IMPORT_HEADERS', '/* 导入入口');
// ③ 产线导入模块（LINE_IMPORT_HEADERS → 落库函数之前；纯计划逻辑）
const lineImportSrc = slice('const LINE_IMPORT_HEADERS', '/* 落库：');
// ④ 下载夹具模板（示例行需与表头列数一致）
const tmplSrc = slice('/* 下载导入模板', 'window.fixtureRetire');
// ⑤ 夹具清单导出（v4.5.0：列定义必须与模板同构，才能「导出 → 回灌」）
const exportSrc = slice('window.fixtureExportCSV = async function', '/* ============================================================\n   * 夹具批量导入');

const sandbox = {
  state: { fixtures: [], lines: [] },
  window: {},
  console,
  DB: { fixtureAdd: async () => 1, fixtureDel: async () => {}, lineDel: async () => {}, add: async () => 1 },
  esc: (s) => String(s == null ? '' : s),
  openModal: () => {},
  toast: () => {},
  reloadAll: async () => {},
  reloadLineConfig: async () => {},
  renderFixtures: () => {},
  closeModal: () => {},
  confirm: () => true,
  download: (name, content) => { sandbox.__downloaded = { name, content }; }
};
sandbox.global = sandbox;
const ctx = vm.createContext(sandbox);

let moduleSrc = constSrc + '\n' + normSrc + '\n' + relSrc + '\n' + importSrc + '\n' + tmplSrc + '\n' + exportSrc + '\n' + lineImportSrc;
moduleSrc = moduleSrc.replace(/window\.__importPlan/g, '__importPlan')
  .replace(/window\.__lineImportPlan/g, '__lineImportPlan')
  .replace(/window\.showImportPreview/g, '__export_showImportPreview')
  .replace(/window\.confirmImportPlan/g, '__export_confirmImportPlan')
  .replace(/window\.downloadFixtureTemplate/g, '__export_downloadFixtureTemplate')
  .replace(/window\.fixtureImport/g, '__export_fixtureImport')
  .replace(/window\.fixtureExportCSV/g, '__export_fixtureExportCSV');
moduleSrc += `
;__export = { FIX_IMPORT_HEADERS, FIX_IMPORT_ALIAS, normalizeHeader, mapImportHeader,
              parseImportRow, splitNames, buildImportPlan, buildCsvText,
              LINE_IMPORT_HEADERS, LINE_IMPORT_ALIAS, mapLineImportHeader, parseLineType,
              buildLineImportPlan,
              MAX_LINE_MODELS, MAX_LINES, MAX_LOCATION, isValidSerialNo, isValidLocation,
              MAX_CATEGORY, isValidCategory, CATEGORY_PRESETS,
              normalizeLineName, planStructureRecycle,
              lineNamesOf, lineNamesLabel, fixtureLineNamesForExport,
              _sigOfNames, _sigOfFixture,
              __export_confirmImportPlan, undoFixtureImport: window.undoFixtureImport, showImportFailure,
              __export_downloadFixtureTemplate, __export_fixtureExportCSV };
`;
vm.runInContext(moduleSrc, ctx);

const M = sandbox.__export;
if (!M) { console.error('模块导出失败'); process.exit(1); }

console.log('=== 夹具导入映射逻辑测试（v5.0.0，17 列 / 无工位） ===');

/* ---------- 1. 表头归一化 ---------- */
section('表头归一化');
ok(M.normalizeHeader('实物编号') === '实物编号', '普通表头原样');
ok(M.normalizeHeader('  名称  ') === '名称', '去首尾空格');
ok(M.normalizeHeader('机种名称1') === '机种名称1', '含数字表头');
ok(M.normalizeHeader('名称(必填)') === '名称', '剥离括号注释');
ok(M.normalizeHeader('库位：') === '库位', '剥离冒号');
ok(M.normalizeHeader('\uFEFF实物编号') === '实物编号', '剥离 BOM');
ok(M.normalizeHeader(null) === '', 'null 安全');

/* ---------- 2. 表头映射 · 标准 17 列 ---------- */
section('表头映射 · 标准 17 列');
ok(M.FIX_IMPORT_HEADERS.length === 17, '模板为 17 列（v5.0.0 去工位列）', M.FIX_IMPORT_HEADERS.length);
ok(M.FIX_IMPORT_HEADERS[0] === '夹具编号' && M.FIX_IMPORT_HEADERS[1] === '名称',
  '第 0/1 列为「夹具编号 / 名称」', [M.FIX_IMPORT_HEADERS[0], M.FIX_IMPORT_HEADERS[1]]);
ok(M.FIX_IMPORT_HEADERS.slice(2, 9).join('|') === '机种名称1|机种名称2|机种名称3|机种名称4|机种名称5|机种名称6|机种名称7',
  '第 2~8 列为「机种名称1~7」', M.FIX_IMPORT_HEADERS.slice(2, 9));
ok(M.FIX_IMPORT_HEADERS[9] === '分类' && M.FIX_IMPORT_HEADERS[10] === '库位',
  '第 9/10 列为「分类 / 库位」', [M.FIX_IMPORT_HEADERS[9], M.FIX_IMPORT_HEADERS[10]]);
ok(M.FIX_IMPORT_HEADERS.slice(11, 16).join('|') === '产线1|产线2|产线3|产线4|产线5',
  '第 11~15 列为「产线1~5」', M.FIX_IMPORT_HEADERS.slice(11, 16));
ok(M.FIX_IMPORT_HEADERS[16] === '备注', '最后一列为「备注」', M.FIX_IMPORT_HEADERS[16]);
ok(!M.FIX_IMPORT_HEADERS.some((h) => /工位/.test(h)), '模板中已无任何「工位」列',
  M.FIX_IMPORT_HEADERS.filter((h) => /工位/.test(h)));

const idxStd = M.mapImportHeader(M.FIX_IMPORT_HEADERS);
ok(idxStd.serialNo === 0 && idxStd.name === 1, '夹具编号 → 第 0 列、名称 → 第 1 列', [idxStd.serialNo, idxStd.name]);
ok(idxStd.lm1 === 2 && idxStd.lm7 === 8, '机种名称1 / 机种名称7 → 第 2 / 8 列', [idxStd.lm1, idxStd.lm7]);
ok(idxStd.category === 9 && idxStd.location === 10, '分类 / 库位 → 第 9 / 10 列', [idxStd.category, idxStd.location]);
ok(idxStd.line1 === 11 && idxStd.line5 === 15, '产线1 / 产线5 → 第 11 / 15 列', [idxStd.line1, idxStd.line5]);
ok(idxStd.remark === 16, '备注 → 第 16 列', idxStd.remark);
ok(idxStd.station1 === undefined && idxStd.station5 === undefined && idxStd.station === undefined,
  '工位相关字段不再有映射（station1/station5/station 均 undefined）',
  [idxStd.station1, idxStd.station5, idxStd.station]);

/* ---------- 3. 表头别名与乱序 ---------- */
section('表头别名 / 乱序 / 旧列兼容');
const idx2 = M.mapImportHeader(['备注', '存放位置', '夹具名称', '夹具编号', '适用机种', '类别', '多余列A', '线体']);
ok(idx2.remark === 0 && idx2.location === 1 && idx2.name === 2 && idx2.serialNo === 3,
  '乱序表头各自定位正确', JSON.stringify(idx2));
ok(idx2.lms === 4, '「适用机种」→ 合并机种列 lms', idx2.lms);
ok(idx2.category === 5, '「类别」→ category', idx2.category);
ok(idx2.lines === 7, '「线体」→ 旧版扁平产线列 lines', idx2.lines);
ok(Object.keys(idx2).length === 7, '未识别列被忽略（多余列A 不入映射）', Object.keys(idx2).join(','));

const idxOldStation = M.mapImportHeader(['夹具编号', '名称', '机种名称1', '库位', '产线1', '工位1', '工位', '工位顺序']);
ok(idxOldStation.line1 === 4, '旧模板「产线1」仍正常映射', idxOldStation.line1);
ok(Object.keys(idxOldStation).every((k) => !/^station/.test(k) && k !== 'seq'),
  '旧模板「工位 / 工位1 / 工位顺序」三列全部不映射（静默忽略）', Object.keys(idxOldStation).join(','));

/* ---------- 4. parseImportRow ---------- */
section('parseImportRow（单行解析）');
const idxV = M.mapImportHeader(['实物编号', '名称', '机种名称1', '库位', '产线1']);
let p = M.parseImportRow(['SN-1', '', 'M', 'ZP1-U-1-1', 'L1'], idxV);
ok(!p.ok && /名称/.test(p.reason), '名称为空 → 拒绝', p.reason);
p = M.parseImportRow(['', '夹具E', 'M', 'ZP1-U-1-1', 'L1'], idxV);
ok(!p.ok && /编号/.test(p.reason), '夹具编号为空 → 拒绝', p.reason);
p = M.parseImportRow(['SN-1', '夹具E', 'M', '', 'L1'], idxV);
ok(!p.ok && /库位/.test(p.reason), '库位为空 → 拒绝', p.reason);
p = M.parseImportRow(['SN-1', '夹具E', 'M', 'A-1', 'L1'], idxV);
ok(!p.ok && /库位/.test(p.reason), '库位非 4 段式 → 拒绝', p.reason);
p = M.parseImportRow(['SN-1', '夹具E', '', 'ZP1-U-1-1', 'L1'], idxV);
ok(!p.ok && /机种/.test(p.reason), '机种为空 → 拒绝', p.reason);
p = M.parseImportRow(['SN-1', '夹具E', 'M', 'ZP1-U-1-1', 'L1'], idxV);
ok(p.ok && p.fixture.lineNames.length === 1 && p.fixture.lineNames[0] === 'L1',
  '单产线列 → lineNames=["L1"]', JSON.stringify(p.fixture.lineNames));
ok(p.ok && p.fixture.stations === undefined, 'parseImportRow 不再产出 stations 字段', JSON.stringify(p.fixture));

const idxMulti = M.mapImportHeader(['夹具编号', '名称', '机种名称1', '库位', '产线1', '产线2', '产线3']);
p = M.parseImportRow(['SN-2', '多线夹具', 'M', 'ZP1-U-1-1', '3 号线', 'L2 U型线', 'L3'], idxMulti);
ok(p.ok && p.fixture.lineNames.join('|') === '3 号线|L2 U型线|L3',
  '产线1~5 分列按顺序收集', JSON.stringify(p.fixture.lineNames));
p = M.parseImportRow(['SN-3', '重复线夹具', 'M', 'ZP1-U-1-1', 'L1', 'L1', ''], idxMulti);
ok(p.ok && p.fixture.lineNames.length === 1, '同名列内去重', JSON.stringify(p.fixture.lineNames));

const idxFlat = M.mapImportHeader(['夹具编号', '名称', '机种名称1', '库位', '产线']);
p = M.parseImportRow(['SN-4', '旧模板夹具', 'M', 'ZP1-U-1-1', 'L1、L2 / L3'], idxFlat);
ok(p.ok && p.fixture.lineNames.length === 3 && p.fixture.lineNames.indexOf('L2') >= 0,
  '旧版扁平「产线」列用分隔符拆成多条', JSON.stringify(p.fixture.lineNames));

p = M.parseImportRow(['SN-5', '无产线夹具', 'M', 'ZP1-U-1-1', ''], idxV);
ok(p.ok && p.fixture.lineNames.length === 0, '产线为空时 parseImportRow 放行（交给 buildImportPlan 判跳过）',
  JSON.stringify(p.fixture.lineNames));

const idxFull = M.mapImportHeader(['夹具编号', '名称', '机种名称1', '库位', '产线1', '分类', '备注']);
p = M.parseImportRow(['SN-6', '全字段夹具', 'M1', 'ZP1-U-1-1', 'L1', 'PVC', '有备注'], idxFull);
ok(p.ok && p.fixture.category === 'PVC' && p.fixture.remark === '有备注',
  '分类 / 备注正常解析', JSON.stringify(p.fixture));

/* ---------- 5. buildImportPlan ---------- */
section('buildImportPlan（整表计划）');
const L1 = { id: 11, name: 'L1 总装线' };
const L2 = { id: 22, name: 'L2 U型线' };
const ctxBase = {
  lines: [L1, L2],
  fixtures: [
    { id: 1, code: '1001', serialNo: 'SN-OLD', name: '已有夹具', lineModels: ['MODEL-X'], category: '冲压', location: 'ZP1-U-9-9', remark: '', lines: [11] }
  ]
};
const rowsMain = [
  ['实物编号', '名称', '机种名称1', '分类', '库位', '产线', '备注'],
  ['SN-OLD', '追加另一条产线', 'MODEL-A', '冲压', 'ZP1-U-1-1', 'L2 U型线', 'ok'],
  ['SN-NEW', '全新夹具', 'MODEL-B', '焊接', 'ZP1-U-2-1', 'L1 总装线', 'ok'],
  ['SN-OLD', '产线未建档', 'MODEL-C', '装配', 'ZP1-U-3-1', 'LX 未知线', '产线未建档→自动补建'],
  ['', '实物编号为空', 'MODEL-D', '装配', 'ZP1-U-4-1', 'L1 总装线', '必填缺失'],
  ['SN-OLD', '', 'MODEL-G', '冲压', 'ZP1-U-7-1', 'L1 总装线', '名称为空'],
  ['SN-OLD', '库位非法', 'MODEL-H', '冲压', 'A-1', 'L1 总装线', '库位不合规'],
  ['SN-OLD', '产线为空', 'MODEL-I', '冲压', 'ZP1-U-8-1', '', '产线缺失']
];
const rMain = M.buildImportPlan(rowsMain, ctxBase);
ok(rMain.ok, '整表可导入', rMain.error);
ok(rMain.plan.length === 3, '3 条有效数据（未建档产线自动补建，不再整行跳过）', rMain.plan.length);
ok(rMain.skipped.length === 4, '4 条被跳过', rMain.skipped.length);
ok(rMain.skipped.some((s) => /编号/.test(s.reason)), '「夹具编号为空」计入跳过',
  rMain.skipped.map((s) => s.reason).join(' / '));
ok(rMain.skipped.some((s) => /名称/.test(s.reason)), '「名称为空」计入跳过');
ok(rMain.skipped.some((s) => /库位/.test(s.reason)), '「库位不合规」计入跳过');
ok(rMain.skipped.some((s) => /产线为空/.test(s.reason)), '「产线为空」计入跳过');
ok(rMain.plan._autoLines.indexOf('LX 未知线') >= 0, '未建档产线被登记为待自动补建', JSON.stringify(rMain.plan._autoLines));
ok(rMain.plan._autoLines.indexOf('L1 总装线') < 0, '已建档产线不进入补建清单', JSON.stringify(rMain.plan._autoLines));
const byName = {};
rMain.plan.forEach((x) => { byName[x.fixture.name] = x; });
ok(byName['追加另一条产线'].fixture.lineNames.join('|') === 'L2 U型线',
  '产线名称原样保留供落库时解析', JSON.stringify(byName['追加另一条产线'].fixture));
ok(byName['追加另一条产线'].fixture.stations === undefined, '计划里不再有 stations', JSON.stringify(byName['追加另一条产线'].fixture));
ok(rMain.plan._missing.some((m) => m.some((x) => x.key === 'LX 未知线' && x.kind === 'line')),
  '_missing 标出未建档产线（kind=line）', JSON.stringify(rMain.plan._missing));
ok(rMain.plan._missing.every((m) => m.every((x) => x.kind === 'line')),
  '_missing 中不再有工位项（kind 只有 line）', JSON.stringify(rMain.plan._missing));

ok(M.buildImportPlan([['名称'], ['x']], ctxBase).ok === false, '缺夹具编号列 → 报错',
  M.buildImportPlan([['名称'], ['x']], ctxBase).error);
ok(M.buildImportPlan([['夹具编号'], ['x']], ctxBase).ok === false, '缺名称列 → 报错',
  M.buildImportPlan([['夹具编号'], ['x']], ctxBase).error);
ok(M.buildImportPlan([['夹具编号', '名称'], ['a', 'b']], ctxBase).ok === false, '缺库位列 → 报错',
  M.buildImportPlan([['夹具编号', '名称'], ['a', 'b']], ctxBase).error);
ok(M.buildImportPlan([['夹具编号', '名称', '库位'], ['a', 'b', 'ZP1-U-1-1']], ctxBase).ok === false,
  '缺产线列 → 报错',
  M.buildImportPlan([['夹具编号', '名称', '库位'], ['a', 'b', 'ZP1-U-1-1']], ctxBase).error);
ok(M.buildImportPlan([['夹具编号', '名称', '库位', '产线1']], ctxBase).ok === false, '只有表头无数据行 → 报错');
const emptyRow = M.buildImportPlan([['夹具编号', '名称', '库位', '产线1'], ['  ', '　', '', '']], ctxBase);
ok(emptyRow.ok === false, '全空行 → 报错', emptyRow.error);
const allBad = M.buildImportPlan([['夹具编号', '名称', '库位', '产线1'], ['SN-X', '', 'ZP1-U-1-1', 'L1']], ctxBase);
ok(allBad.ok === false && Array.isArray(allBad.skipped) && allBad.skipped.length === 1,
  '整表被拒时返回 skipped 明细（BUG-007）', JSON.stringify(allBad.skipped));

/* ---------- 6. 产线名归并（BUG-010） ---------- */
section('产线名归并（1# → 1）');
ok(M.normalizeLineName('1#') === '1', '归一化去掉 #（1# → 1）', M.normalizeLineName('1#'));
ok(M.normalizeLineName('１') === '1', '全角转半角', M.normalizeLineName('１'));
ok(M.normalizeLineName(' 1 ') === '1', '去空白', '[' + M.normalizeLineName(' 1 ') + ']');
ok(M.normalizeLineName('3号线') !== M.normalizeLineName('3'), '「3号线」与「3」不同名（不会被误并）');
const mergeRows = [
  ['夹具编号', '名称', '机种名称1', '分类', '库位', '产线1', '备注'],
  ['SN-M1', '归并测试A', 'M1', '金属', 'ZP1-U-1-1', '1#', ''],
  ['SN-M2', '归并测试B', 'M1', '金属', 'ZP1-U-1-2', '1', ''],
  ['SN-M3', '归并测试C', 'M1', '金属', 'ZP1-U-1-3', '1#', '']
];
const mergePlan = M.buildImportPlan(mergeRows, { fixtures: [], lines: [{ id: 1, name: '1' }] });
ok(mergePlan.ok, '归并场景可导入', mergePlan.error);
ok(mergePlan.plan.every((x) => x.fixture.lineNames[0] === '1'),
  '「1#」全部归并到库内已有的「1」', JSON.stringify(mergePlan.plan.map((x) => x.fixture.lineNames)));
ok(mergePlan.plan._lineHints.length === 1 && mergePlan.plan._lineHints[0].from === '1#',
  '归并提示记录来源写法（1# → 1）', JSON.stringify(mergePlan.plan._lineHints));
ok(mergePlan.plan._lineHints[0].rows === 2, '归并提示统计涉及行数', mergePlan.plan._lineHints[0].rows);
ok(mergePlan.plan._autoLines.length === 0, '归并后不再补建同义产线', JSON.stringify(mergePlan.plan._autoLines));
const firstWins = M.buildImportPlan([
  ['夹具编号', '名称', '机种名称1', '分类', '库位', '产线1', '备注'],
  ['SN-M5', '首现为准A', 'M1', '金属', 'ZP1-U-2-1', 'A#', ''],
  ['SN-M6', '首现为准B', 'M1', '金属', 'ZP1-U-2-2', 'A', '']
], { fixtures: [], lines: [] });
ok(firstWins.plan.every((x) => x.fixture.lineNames[0] === 'A#'),
  '库内无同名时以文件内首个写法为准（A#）', JSON.stringify(firstWins.plan.map((x) => x.fixture.lineNames)));

/* ---------- 7. 导入查重（多重集 1:1 配对） ---------- */
section('导入查重（与库内多重集 1:1 配对）');
const dupLines = [{ id: 101, name: 'L1 线' }];
const dupExisting = [{
  id: 9, code: '1009', serialNo: 'SN-DUP', name: '同号夹具', location: 'ZP1-U-1-1',
  category: '金属', remark: '', lineModels: ['M1'], lines: [101]
}];
const HDR = M.FIX_IMPORT_HEADERS.slice();
const mkRow = (o) => {
  const r = new Array(HDR.length).fill('');
  const put = (key, v) => { const i = HDR.indexOf(key); if (i >= 0) r[i] = v; };
  put('夹具编号', o.serialNo || '');
  put('名称', o.name || '');
  put('机种名称1', o.lm1 || '');
  put('分类', o.category || '');
  put('库位', o.location || '');
  put('产线1', o.line1 || '');
  put('备注', o.remark || '');
  return r;
};
const exact = mkRow({ serialNo: 'SN-DUP', name: '同号夹具', lm1: 'M1', category: '金属', location: 'ZP1-U-1-1', line1: 'L1 线' });
const pDup = M.buildImportPlan([HDR, exact], { fixtures: dupExisting, lines: dupLines });
ok(pDup.ok && pDup.plan[0].isDup === true, '与库内完全一致 → 判为重复', JSON.stringify(pDup.plan[0] && pDup.plan[0].isDup));
ok(pDup.plan._dupCount === 1, '_dupCount 统计重复行数', pDup.plan._dupCount);
const pNew = M.buildImportPlan([HDR, mkRow({ serialNo: 'SN-FRESH', name: '全新', lm1: 'M2', category: '金属', location: 'ZP1-U-1-2', line1: 'L1 线' })],
  { fixtures: dupExisting, lines: dupLines });
ok(pNew.ok && pNew.plan[0].isDup === false, '内容不同 → 判为新增', JSON.stringify(pNew.plan[0] && pNew.plan[0].isDup));
const diffLine = M.buildImportPlan([HDR, mkRow({ serialNo: 'SN-DUP', name: '同号夹具', lm1: 'M1', category: '金属', location: 'ZP1-U-1-1', line1: 'L2 线' })],
  { fixtures: dupExisting, lines: dupLines });
ok(diffLine.plan[0].isDup === false, '产线不同 → 不算重复（签名含产线集合）', JSON.stringify(diffLine.plan[0].isDup));
ok(M._sigOfNames('S', 'N', 'ZP1-U-1-1', 'C', ['b', 'a'], ['L2', 'L1'], 'R')
  === M._sigOfNames('S', 'N', 'ZP1-U-1-1', 'C', ['a', 'b'], ['L1', 'L2'], 'R'),
  '签名对机种/产线集合顺序不敏感');
ok(M._sigOfNames('S', 'N', 'ZP1-U-1-1', 'C', ['a'], ['L1'], 'R')
  !== M._sigOfNames('S', 'N', 'ZP1-U-1-1', 'C', ['a'], ['L2'], 'R'),
  '签名对产线集合敏感');
const sigFix = M._sigOfFixture(dupExisting[0], dupLines);
ok(sigFix === M._sigOfNames('SN-DUP', '同号夹具', 'ZP1-U-1-1', '金属', ['M1'], ['L1 线'], ''),
  '_sigOfFixture 用 lines 反查产线名，与表格签名同构', sigFix);
const twoSame = M.buildImportPlan([HDR, exact, exact], { fixtures: dupExisting, lines: dupLines });
ok(twoSame.plan.length === 2 && twoSame.plan._dupCount === 1,
  '库内 1 套 + 本次 2 行同内容 → 1 重复 + 1 新增（不做批次内去重）',
  JSON.stringify(twoSame.plan.map((x) => x.isDup)));

/* ---------- 8-12：导出 / 模板 / 产线导入 / 回收 / 幂等 ---------- */
function splitCsvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

(async function run() {
  sandbox.state.lines = [{ id: 1, name: 'L1 线' }, { id: 2, name: 'L2 线' }];
  sandbox.state.fixtures = [
    { id: 1, code: '1001', serialNo: 'SN-E1', name: '导出甲', lineModels: ['A', 'B'],
      category: '金属', location: 'ZP1-U-1-1', lines: [1, 2], remark: '含"引号"' },
    { id: 2, code: '1002', serialNo: 'SN-E2', name: '导出乙', lineModels: [],
      category: '', location: '', lines: [], remark: '' }
  ];

  section('夹具清单导出 CSV');
  await M.__export_fixtureExportCSV();
  const csv = (sandbox.__downloaded || {}).content || '';
  ok(csv.charCodeAt(0) === 0xFEFF, '导出带 UTF-8 BOM（Excel 打开不乱码）', csv.charCodeAt(0));
  const csvLines = csv.replace(/^\uFEFF/, '').split('\r\n');
  ok(csvLines[0] === M.FIX_IMPORT_HEADERS.join(','), '导出表头与导入模板逐列一致（17 列同序）', csvLines[0]);
  ok(csvLines.length === 3, '导出 2 条数据行', csvLines.length - 1);
  const rowA = splitCsvLine(csvLines[1]);
  const rowB = splitCsvLine(csvLines[2]);
  ok(rowA.length === 17, '数据行 17 列（与模板列数一致）', rowA.length);
  ok(rowB.length === 17, '第二行同样 17 列', rowB.length);
  ok(rowA[0] === 'SN-E1' && rowA[1] === '导出甲', '夹具编号 / 名称 就位', [rowA[0], rowA[1]]);
  ok(rowA[2] === 'A' && rowA[3] === 'B' && rowA[4] === '', '机种展开成 机种名称1~7 七列', rowA.slice(2, 9));
  ok(rowA[9] === '金属' && rowA[10] === 'ZP1-U-1-1', '分类 / 库位就位', [rowA[9], rowA[10]]);
  ok(rowA[11] === 'L1 线' && rowA[12] === 'L2 线' && rowA[13] === '', '产线1 / 产线2 填了名称，其余空', rowA.slice(11, 16));
  ok(rowA[16] === '含"引号"', '备注含双引号正确转义（可被标准 CSV 解析）', rowA[16]);
  ok(rowB.slice(11, 16).every((v) => v === ''), '无关联产线的夹具产线列全空', JSON.stringify(rowB.slice(11, 16)));
  ok(!csv.includes('累计出库') && !csv.includes('维修次数'), '导出不再带 累计出库/维修次数 等派生列');
  ok(rowA.every((v) => !/工位/.test(v)), '导出内容不含任何「工位」字样');

  const backRows = [splitCsvLine(csvLines[0]), rowA];
  const back = M.buildImportPlan(backRows, { fixtures: [], lines: sandbox.state.lines });
  ok(back.ok && back.plan.length === 1, '导出文件可直接回灌（导入侧能解析）', back.error);
  ok(back.plan[0].fixture.lineNames.join('|') === 'L1 线|L2 线',
    '回灌后产线集合一致（导出→导入不丢关联）', JSON.stringify(back.plan[0].fixture.lineNames));

  section('下载夹具模板');
  M.__export_downloadFixtureTemplate();
  const tmpl = (sandbox.__downloaded || {}).content || '';
  const tl = tmpl.replace(/^\uFEFF/, '').split('\r\n');
  ok(tl[0] === M.FIX_IMPORT_HEADERS.join(','), '模板表头与导出一致（同一份列定义）', tl[0]);
  ok(tl.length > 1, '模板含示例行', tl.length - 1);
  ok(tl.slice(1).every((ln) => splitCsvLine(ln).length === 17), '每行示例都是 17 列',
    JSON.stringify(tl.slice(1).map((ln) => splitCsvLine(ln).length)));
  ok(tl.slice(1).every((ln) => !/工位/.test(ln)), '模板示例行不含工位字样');

  section('产线配置导入（线体 | 线体形态 | 夹具编号 | 备注）');
  ok(M.LINE_IMPORT_HEADERS.join('|') === '线体|线体形态|夹具编号|备注',
    '产线导入表头为 4 列（v5.0.0 去工位）', M.LINE_IMPORT_HEADERS.join('|'));
  ok(!M.LINE_IMPORT_HEADERS.some((h) => /工位/.test(h)), '产线导入表头无工位列');
  const li = M.mapLineImportHeader(['线体', '线体形态', '工位', '工位顺序', '夹具编号', '备注']);
  ok(li.line === 0 && li.lineType === 1 && li.fixtureSerial === 4 && li.remark === 5,
    '旧 6 列模板仍能定位线体/形态/夹具编号/备注', JSON.stringify(li));
  ok(li.station === undefined && li.seq === undefined, '旧模板「工位 / 工位顺序」不再映射（静默忽略）', JSON.stringify(li));

  const lnCtx = {
    lines: [{ id: 11, name: 'L1 总装线' }, { id: 22, name: 'L2 U型线' }],
    fixtures: [{ id: 1, code: '1001', serialNo: 'SN-OLD', name: '已有夹具', lines: [22], lineModels: ['M'] }]
  };
  const lnRows = [
    ['线体', '线体形态', '夹具编号', '备注'],
    ['L2 U型线', 'U型', 'SN-OLD', '已关联该产线→忽略'],
    ['L1 总装线', '直线形', 'SN-OLD', '追加一条产线'],
    ['L1 总装线', '直线形', 'SN-NOTEXIST', '夹具未建档→跳过'],
    ['L1 总装线', '直线形', '', '夹具编号为空→跳过'],
    ['L2 U型线', 'U型', 'SN-OLD', '文件内重复行'],
    ['L9 新线', '直线形', 'SN-OLD', '线体未建档→自动补建'],
    ['', '直线形', 'SN-OLD', '线体为空→跳过']
  ];
  const lnPlan = M.buildLineImportPlan(lnRows, lnCtx);
  ok(lnPlan.ok, '产线导入计划生成成功', lnPlan.error);
  ok(lnPlan.appends.length === 2, '2 行可追加（L1 总装线 / L9 新线）', lnPlan.appends.length);
  ok(lnPlan.newLines.length === 1 && lnPlan.newLines[0].name === 'L9 新线',
    '未建档线体登记为待新建', JSON.stringify(lnPlan.newLines));
  ok(lnPlan.newLines[0].type === 'linear', '线体形态被解析（直线形）', lnPlan.newLines[0].type);
  const skTxt = lnPlan.skipped.map((s) => s.reason).join(' | ');
  ok(lnPlan.skipped.length === 5, '5 行被跳过', lnPlan.skipped.length + '：' + skTxt);
  ok(/已关联产线/.test(skTxt), '已关联该产线的行被跳过并说明原因', skTxt);
  ok(/未建档/.test(skTxt), '夹具未建档的行被跳过', skTxt);
  ok(/夹具编号为空/.test(skTxt), '夹具编号为空的行被跳过', skTxt);
  ok(/文件中重复行/.test(skTxt), '文件内重复行被识别', skTxt);
  ok(/线体为空/.test(skTxt), '线体为空的行被跳过', skTxt);
  ok(lnPlan.appends.every((a) => a.stationName === undefined), '追加项里已无 stationName 字段',
    JSON.stringify(lnPlan.appends[0]));
  ok(lnPlan.appends.every((a) => typeof a.lineName === 'string' && a.fixtureId === 1),
    '追加项按夹具 id + 产线名登记', JSON.stringify(lnPlan.appends));

  ok(M.buildLineImportPlan([['线体'], ['L1']], {}).ok === false, '缺夹具编号列 → 报错',
    M.buildLineImportPlan([['线体'], ['L1']], {}).error);
  ok(M.buildLineImportPlan([['夹具编号'], ['SN-1']], {}).ok === false, '缺线体列 → 报错',
    M.buildLineImportPlan([['夹具编号'], ['SN-1']], {}).error);
  ok(M.buildLineImportPlan([['线体', '夹具编号']], {}).ok === false, '只有表头 → 报错');
  ok(M.buildLineImportPlan([['线体', '夹具编号'], ['L1', 'SN-NOTEXIST']],
    { lines: [], fixtures: [] }).ok === false, '全部行都无有效匹配 → 报错',
    M.buildLineImportPlan([['线体', '夹具编号'], ['L1', 'SN-NOTEXIST']], { lines: [], fixtures: [] }).error);
  const dupSerialCtx = {
    lines: [],
    fixtures: [
      { id: 1, code: '1001', serialNo: 'SN-DUP', name: '甲', lines: [] },
      { id: 2, code: '1002', serialNo: 'SN-DUP', name: '乙', lines: [] }
    ]
  };
  const dupSerial = M.buildLineImportPlan([['线体', '夹具编号'], ['L1', 'SN-DUP']], dupSerialCtx);
  ok(dupSerial.ok === false && /无法唯一定位/.test(dupSerial.skipped.map((s) => s.reason).join('')),
    '同编号对应多套夹具 → 无法唯一定位（跳过）', JSON.stringify(dupSerial.skipped));

  const manyLines = [];
  for (let i = 0; i < 6; i++) manyLines.push({ id: 100 + i, name: 'L' + i });
  const fullFix = [{ id: 7, code: '1007', serialNo: 'SN-FULL', name: '满线夹具', lines: [100, 101, 102, 103, 104] }];
  const limPlan = M.buildLineImportPlan([['线体', '夹具编号'], ['L5', 'SN-FULL']],
    { lines: manyLines, fixtures: fullFix });
  ok(limPlan.ok === false, '产线已达上限 5 条 → 无有效行', limPlan.error);
  ok(limPlan.skipped.some((s) => /上限 5 条/.test(s.reason)), '跳过原因写明产线上限',
    lnPlan.skipped.map((s) => s.reason).join(' | '));
  const notFullFix = [{ id: 8, code: '1008', serialNo: 'SN-ROOM', name: '还有余量', lines: [100, 101, 102, 103] }];
  const roomPlan = M.buildLineImportPlan([['线体', '夹具编号'], ['L5', 'SN-ROOM']],
    { lines: manyLines, fixtures: notFullFix });
  ok(roomPlan.ok && roomPlan.appends.length === 1, '未达上限时可追加', roomPlan.error);

  ok(M.parseLineType('U型') === 'u' && M.parseLineType('u') === 'u' && M.parseLineType('环形') === 'u',
    'U型 / u / 环形 都识别为 u', [M.parseLineType('U型'), M.parseLineType('u'), M.parseLineType('环形')]);
  ok(M.parseLineType('Unit line') === 'linear', '「Unit line」不被误判为 U 型', M.parseLineType('Unit line'));
  ok(M.parseLineType('') === 'linear' && M.parseLineType(null) === 'linear', '空值按直线形处理');

  section('撤销导入的结构回收（planStructureRecycle，只回收产线）');
  const created = { lineIds: [90, 91] };
  const rp0 = M.planStructureRecycle(created, []);
  ok(Array.isArray(rp0) && rp0.join('|') === '90|91', '无夹具引用 → 两条产线全部回收', JSON.stringify(rp0));
  ok(M.planStructureRecycle(created, [{ id: 1, lines: [90] }]).join('|') === '91',
    '仍被夹具引用的产线不回收', JSON.stringify(M.planStructureRecycle(created, [{ id: 1, lines: [90] }])));
  ok(M.planStructureRecycle(created, [{ id: 1, lines: [90, 91] }]).length === 0,
    '两条都被引用 → 不回收', JSON.stringify(M.planStructureRecycle(created, [{ id: 1, lines: [90, 91] }])));
  ok(M.planStructureRecycle(null, []).length === 0, '没有批次记录时安全返回空');
  ok(M.planStructureRecycle({ lineIds: [] }, [{ id: 1, lines: [1] }]).length === 0, '空 lineIds 安全');
  ok(M.planStructureRecycle({ lineIds: ['90'] }, []).join('|') === '90', '字符串 id 也能回收');

  section('整表落库幂等（导入两次不翻倍）');
  const db = { fixtures: [], lines: [{ id: 11, name: 'L1 线' }], seq: 100 };
  sandbox.state.lines = db.lines;
  sandbox.state.fixtures = db.fixtures;
  sandbox.DB.add = async (name, obj) => {
    const id = db.seq++;
    if (name === 'lines') db.lines.push(Object.assign({ id }, obj));
    if (name === 'fixtures') db.fixtures.push(Object.assign({ id }, obj));
    return id;
  };
  sandbox.DB.fixtureAdd = async (obj) => {
    const id = db.seq++;
    db.fixtures.push(Object.assign({
      id, code: String(1000 + id), status: 'stocked', totalOutCount: 0, totalReturnCount: 0, repairCount: 0
    }, obj));
    return id;
  };
  const rowsOnce = [HDR,
    mkRow({ serialNo: 'SN-I1', name: '幂等甲', lm1: 'M1', category: '金属', location: 'ZP1-U-3-1', line1: 'L1 线' }),
    mkRow({ serialNo: 'SN-I2', name: '幂等乙', lm1: 'M1', category: '金属', location: 'ZP1-U-3-2', line1: 'L1 线' })
  ];
  const plan1 = M.buildImportPlan(rowsOnce, { fixtures: db.fixtures, lines: db.lines });
  ok(plan1.ok && plan1.plan.length === 2 && plan1.plan._dupCount === 0, '首次导入：2 行全部新增',
    JSON.stringify(plan1.plan.map((x) => x.isDup)));

  sandbox.__importPlan = plan1.plan;
  await M.__export_confirmImportPlan('all');
  ok(db.fixtures.length === 2, '首次落库后库内 2 套', db.fixtures.length);

  const planAfter = M.buildImportPlan(rowsOnce, { fixtures: db.fixtures, lines: db.lines });
  ok(planAfter.plan.length === 2 && planAfter.plan._dupCount === 2,
    '同表再导：2 行全部判为重复（不会翻倍）', JSON.stringify(planAfter.plan.map((x) => x.isDup)));
  sandbox.__importPlan = planAfter.plan;
  await M.__export_confirmImportPlan('skip');
  ok(db.fixtures.length === 2, '默认「跳过重复」后库内仍 2 套（未翻倍）', db.fixtures.length);

  /* ---------- 汇总 ---------- */
  console.log('\n' + '='.repeat(50));
  console.log('测试汇总：通过 ' + pass + ' / 失败 ' + fail);
  if (fail > 0) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
  console.log('='.repeat(50));
  process.exit(fail > 0 ? 1 : 0);
})();
