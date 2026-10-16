'use strict';
/* ============================================================
 * test_import.js — 验证 app.js 的导入映射逻辑（表头匹配 / 编号分配 / 机种合并）
 *
 * 直接从 js/app.js 抽取导入模块的纯函数来测，避免依赖 DOM。
 * 做法：用 vm 载入一个精简沙箱，注入 app.js 里这段源码。
 * 运行：node test_import.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → 实际: ' + JSON.stringify(extra) : '')); }
}

const APP = path.join(__dirname, 'js', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

// 定位导入模块：从 FIX_IMPORT_HEADERS 到 window.fixtureImport 之前
const start = src.indexOf('const FIX_IMPORT_HEADERS');
const end = src.indexOf('/* 导入入口');
if (start < 0 || end < 0 || end <= start) {
  console.error('未能在 js/app.js 中定位导入模块');
  process.exit(1);
}
let moduleSrc = src.slice(start, end);

// 沙箱：注入 state / toast / openModal / esc
const sandbox = {
  state: { fixtures: [] },
  window: {},
  console,
  DB: { fixtureAdd: async () => 1 },
  esc: (s) => String(s == null ? '' : s),
  openModal: () => {},
  toast: () => {},
  reloadAll: async () => {},
  renderFixtures: () => {}
};
sandbox.global = sandbox;
const vm = require('vm');
const ctx = vm.createContext(sandbox);
// 把 window.X = 改成裸赋值，便于沙箱内取用；同时补齐 __ 依赖
moduleSrc = moduleSrc.replace(/window\.__importPlan/g, '__importPlan')
  .replace(/window\.showImportPreview/g, '__export_showImportPreview')
  .replace(/window\.confirmImportPlan/g, '__export_confirmImportPlan')
  .replace(/window\.downloadFixtureTemplate/g, '__export_downloadFixtureTemplate')
  .replace(/window\.fixtureImport/g, '__export_fixtureImport');
moduleSrc += `
;__export = { FIX_IMPORT_HEADERS, FIX_IMPORT_ALIAS, normalizeHeader, mapImportHeader,
              parseImportRow, nextFreeCode, buildImportPlan };
`;
vm.runInContext(moduleSrc, ctx);

const M = sandbox.__export;
if (!M) { console.error('模块导出失败'); process.exit(1); }

console.log('=== 导入映射逻辑测试 ===');

// --- 表头归一化 ---
console.log('\n[表头归一化]');
ok(M.normalizeHeader('编号') === '编号', '普通表头原样');
ok(M.normalizeHeader('  名称  ') === '名称', '去首尾空格');
ok(M.normalizeHeader('机种名称1') === '机种名称1', '含数字表头');
ok(M.normalizeHeader('名称(必填)') === '名称', '剥离括号注释');
ok(M.normalizeHeader('库位：') === '库位', '剥离冒号');
ok(M.normalizeHeader('﻿编号') === '编号', '剥离 BOM');

// --- 表头映射：标准顺序 ---
console.log('\n[表头映射 · 标准]');
const idxStd = M.mapImportHeader(['编号', '名称', '机种名称1', '机种名称2', '机种名称3', '机种名称4', '分类', '库位', '备注']);
ok(idxStd.code === 0, 'code → 第 0 列', idxStd.code);
ok(idxStd.name === 1, 'name → 第 1 列', idxStd.name);
ok(idxStd.lm1 === 2 && idxStd.lm2 === 3 && idxStd.lm3 === 4 && idxStd.lm4 === 5, '机种 1-4 列正确');
ok(idxStd.category === 6, 'category → 第 6 列', idxStd.category);
ok(idxStd.location === 7, 'location → 第 7 列', idxStd.location);
ok(idxStd.remark === 8, 'remark → 第 8 列', idxStd.remark);

// --- 表头映射：乱序 + 别名 + 多余列 ---
console.log('\n[表头映射 · 乱序 + 别名]');
const idx2 = M.mapImportHeader(['备注', '存放位置', '夹具名称', '编码', '适用机种', '类别', '多余列A', '多余列B']);
ok(idx2.name === 2, '「夹具名称」别名 → name', idx2.name);
ok(idx2.code === 3, '「编码」别名 → code', idx2.code);
ok(idx2.location === 1, '「存放位置」别名 → location', idx2.location);
ok(idx2.category === 5, '「类别」别名 → category', idx2.category);
ok(idx2.lms === 4, '「适用机种」别名 → lms', idx2.lms);
ok(idx2.remark === 0, '「备注」→ remark', idx2.remark);
ok(idx2.lm1 === undefined && idx2.lm4 === undefined, '未出现的机种列不映射');

// --- 行解析：多机种合并 ---
console.log('\n[行解析 · 机种合并]');
const idxLm = M.mapImportHeader(['机种名称1', '机种名称2', '机种名称3', '机种名称4', '名称']);
let p = M.parseImportRow(['A', 'B', 'C', 'D', '夹具A'], idxLm);
ok(p.ok, '解析成功');
ok(JSON.stringify(p.fixture.lineModels) === JSON.stringify(['A', 'B', 'C', 'D']), '4 个机种全部保留', p.fixture.lineModels);

const idxLms = M.mapImportHeader(['机种名称', '名称']);
p = M.parseImportRow(['MODEL-A,MODEL-B;MODEL-C', '夹具B'], idxLms);
ok(p.ok, '合并列解析成功');
ok(JSON.stringify(p.fixture.lineModels) === JSON.stringify(['MODEL-A', 'MODEL-B', 'MODEL-C']),
   '逗号/分号分隔的多机种被拆开', p.fixture.lineModels);

const idxLm5 = M.mapImportHeader(['机种名称', '名称']);
p = M.parseImportRow(['M1,M2,M3,M4,M5,M6', '夹具C'], idxLm5);
ok(p.fixture.lineModels.length === 4, '机种超过 4 个时截断到 4', p.fixture.lineModels);

p = M.parseImportRow(['MODEL-A,MODEL-A', '夹具D'], idxLms);
ok(JSON.stringify(p.fixture.lineModels) === JSON.stringify(['MODEL-A']), '重复机种去重', p.fixture.lineModels);

// --- 名称为空 ---
console.log('\n[行解析 · 校验]');
p = M.parseImportRow(['2001', '', 'X', '', '', ''], M.mapImportHeader(['编号', '名称', '机种名称1', '机种名称2', '机种名称3', '机种名称4']));
ok(!p.ok && /名称为空/.test(p.reason), '名称为空被拒绝', p.reason);

// --- nextFreeCode ---
console.log('\n[编号自动分配]');
ok(M.nextFreeCode(new Set()) === '1001', '空库从 1001 开始');
ok(M.nextFreeCode(new Set(['1001', '1002'])) === '1003', '跳过已占用', M.nextFreeCode(new Set(['1001', '1002'])));
ok(M.nextFreeCode(new Set(['1001', '1002', '1003', '1005'])) === '1004', '填补空洞 1004', M.nextFreeCode(new Set(['1001', '1002', '1003', '1005'])));

// --- buildImportPlan：完整场景 ---
console.log('\n[buildImportPlan · 端到端]');
sandbox.state.fixtures = [{ code: '1001', name: '已有夹具' }];
const rows = [
  ['编号', '名称', '机种名称1', '分类', '库位', '备注'],
  ['1001', '重复编号夹具', 'MODEL-A', '冲压', 'A-1', '编号冲突应自动分配'],
  ['abc', '非法编号夹具', 'MODEL-B', '焊接', 'B-2', '非数字应自动分配'],
  ['1005', '正常编号夹具', 'MODEL-C', '装配', 'C-3', '合法且未占用'],
  ['1006', '', 'MODEL-D', '装配', 'C-4', '名称为空应跳过'],
  ['', '空编号夹具', 'MODEL-E', '冲压', 'A-3', '编号空应自动分配'],
  ['1007', '含特殊字符夹具', '', '冲压', 'A-4', '夹具, 带逗号"引号']
];
const plan = M.buildImportPlan(rows);
ok(plan.ok, '生成导入计划成功', plan.error);
ok(plan.plan.length === 5, '5 条有效数据（1 条名称为空被跳过）', plan.plan.length);
ok(plan.skipped.length === 1, '1 条跳过', plan.skipped.length);
ok(plan.skipped[0].row === 5, '跳过的是第 5 行（名称为空）', plan.skipped[0]);

const byName = {};
plan.plan.forEach((p) => { byName[p.fixture.name] = p; });

ok(byName['重复编号夹具'].autoCode === true, '重复编号标记自动分配');
ok(byName['重复编号夹具'].fixture.code === '1002', '冲突编号 → 1002', byName['重复编号夹具'].fixture.code);
ok(byName['非法编号夹具'].autoCode === true, '非法编号标记自动分配');
ok(byName['非法编号夹具'].fixture.code === '1003', '非法编号 → 1003', byName['非法编号夹具'].fixture.code);
ok(byName['正常编号夹具'].autoCode === false, '合法未占用编号不自动分配');
ok(byName['正常编号夹具'].fixture.code === '1005', '合法编号保持 1005', byName['正常编号夹具'].fixture.code);
ok(byName['空编号夹具'].autoCode === true, '空编号标记自动分配');
ok(byName['空编号夹具'].fixture.code === '1004', '空编号 → 填补 1004 空洞', byName['空编号夹具'].fixture.code);

const sp = byName['含特殊字符夹具'];
ok(sp.fixture.remark === '夹具, 带逗号"引号', 'CSV 引号转义正确还原', sp.fixture.remark);

// 计划内编号不得互相重复
const codes = plan.plan.map((p) => p.fixture.code);
ok(new Set(codes).size === codes.length, '计划内编号互不重复', codes);

// --- 缺列 / 空表 ---
console.log('\n[buildImportPlan · 异常]');
sandbox.state.fixtures = [];
const onlyName = M.buildImportPlan([['名称'], ['只有名称的夹具']]);
ok(onlyName.ok === true, '仅名称列也可导入（编号自动分配）', onlyName.error);
ok(onlyName.plan.length === 1 && onlyName.plan[0].autoCode === true && onlyName.plan[0].fixture.code === '1001',
   '仅名称列时编号从 1001 自动分配', onlyName.ok ? onlyName.plan[0] : null);
ok(M.buildImportPlan([['备注', '库位']]).ok === false, '缺名称列 → 报错', M.buildImportPlan([['备注']]).error);
ok(M.buildImportPlan([['编号', '名称']]).ok === false, '只有表头无数据行 → 报错', M.buildImportPlan([['编号', '名称']]).error);
ok(M.buildImportPlan([]).ok === false, '空数组 → 报错', M.buildImportPlan([]).error);
ok(M.buildImportPlan([['名称'], ['  '], ['　']]).ok === false, '数据行全为空白 → 报错（无有效行）', M.buildImportPlan([['名称'], ['  ']]).error);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);