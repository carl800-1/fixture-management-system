'use strict';
/* ============================================================
 * test_e2e_import.js — 端到端验证：真实 xlsx 文件 → 解析 → 导入计划 → 落库
 *
 * 把 test_xlsx.js 的解析链路与 test_import.js 的映射链路串起来，
 * 用真实磁盘上的 .xlsx 走完整流程，最后真的写入 store 再读回校验。
 * 运行：node test_e2e_import.js
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

console.log('=== 端到端导入验证（真实 xlsx → 落库） ===');

/* ---- 1. 解析真实 xlsx（走主进程同一份代码） ---- */
const { readWorkbook } = require('./js/xlsx_reader');
const wb = readWorkbook(fs.readFileSync(XLSX));
ok(wb.sheets.length === 2, '解析出 2 张工作表');
ok(wb.sheets[0].name === '夹具清单', '第 1 张表名为「夹具清单」', wb.sheets[0].name);
const xrows = wb.sheets[0].rows;
ok(xrows.length === 4, '第 1 张表 4 行（表头 + 3 条数据）', xrows.length);

/* ---- 2. 走 app.js 的导入映射（vm 沙箱抽取纯函数） ---- */
const src = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
const s0 = src.indexOf('const FIX_IMPORT_HEADERS');
const s1 = src.indexOf('/* 导入入口');
// parseCSV 定义在文件后段，单独取出
const c0 = src.indexOf('function parseCSV(text)');
if (s0 < 0 || s1 < 0 || c0 < 0) { console.error('未能定位 app.js 导入模块'); process.exit(1); }
// parseCSV 从定义处到下一个 "/* ===" 分节注释为止
let c1 = src.indexOf('/* ============================================================', c0);
if (c1 < 0) c1 = src.length;
const csvSrc = src.slice(c0, c1);
let modSrc = csvSrc + '\n' + src.slice(s0, s1)
  .replace(/window\.__importPlan/g, '__importPlan')
  .replace(/window\.showImportPreview/g, '__e1')
  .replace(/window\.confirmImportPlan/g, '__e2')
  .replace(/window\.downloadFixtureTemplate/g, '__e3')
  .replace(/window\.fixtureImport/g, '__e4');
modSrc += ';__export = { buildImportPlan, parseCSV };';

const sandbox = { state: { fixtures: [] }, window: {}, console, esc: (s) => String(s == null ? '' : s), openModal() {}, toast() {} };
vm.createContext(sandbox);
vm.runInContext(modSrc, sandbox);
const M = sandbox.__export;

/* ---- 3. 生成导入计划 ---- */
console.log('\n[导入计划]');
sandbox.state.fixtures = [{ code: '1001', name: '已存在的夹具' }];
const plan = M.buildImportPlan(xrows);
ok(plan.ok, '生成导入计划成功', plan.error);
ok(plan.plan.length === 3, '3 条数据全部有效', plan.plan.length);
ok(plan.skipped.length === 0, '无跳过行', plan.skipped);

const names = plan.plan.map((p) => p.fixture.name);
ok(JSON.stringify(names) === JSON.stringify(['定位销压板', '焊接夹具', '装配工装']),
   '三条夹具名称按顺序解析正确', names);

// 编号：首行 2001 保留；2002 保留；第三行编号是占位串 → 自动分配
ok(plan.plan[0].fixture.code === '2001', '第 1 条保留原编号 2001', plan.plan[0].fixture.code);
ok(plan.plan[0].autoCode === false, '第 1 条不自动分配', plan.plan[0].autoCode);
ok(plan.plan[1].fixture.code === '2002', '第 2 条保留原编号 2002（数字单元格）', plan.plan[1].fixture.code);
ok(plan.plan[2].autoCode === true, '第 3 条编号为空 → 自动分配', plan.plan[2].autoCode);
ok(plan.plan[2].fixture.code === '1002', '第 3 条自动分配到 1002（跳过已占用的 1001）', plan.plan[2].fixture.code);

// 机种 / 分类 / 库位 / 备注（含 XML 实体）
ok(JSON.stringify(plan.plan[0].fixture.lineModels) === JSON.stringify(['MODEL-A', 'MODEL-B']),
   '第 1 条机种 = [MODEL-A, MODEL-B]', plan.plan[0].fixture.lineModels);
ok(plan.plan[0].fixture.category === '冲压', '第 1 条分类 = 冲压', plan.plan[0].fixture.category);
ok(plan.plan[0].fixture.location === 'A-01-01', '第 1 条库位 = A-01-01', plan.plan[0].fixture.location);
ok(plan.plan[0].fixture.remark === '用于冲压定位，含 & <特殊字符>',
   '第 1 条备注 XML 实体正确解码', plan.plan[0].fixture.remark);
ok(plan.plan[1].fixture.remark === 'inline 字符串备注', '第 2 条 inlineStr 备注', plan.plan[1].fixture.remark);
ok(plan.plan[2].fixture.category === '装配', '第 3 条分类 = 装配', plan.plan[2].fixture.category);

/* ---- 4. 真正落库（临时目录，不污染真实数据） ---- */
console.log('\n[真实落库]');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fms-import-'));
const store = require('./store');
store.setDataDir(tmpDir);

// 预置一条占用 1001 的夹具
store.addFixture({ code: '1001', name: '已存在的夹具', lineModels: [], category: '', location: '', remark: '' });

let added = 0;
for (const p of plan.plan) {
  store.addFixture({
    code: p.fixture.code,
    name: p.fixture.name,
    lineModels: p.fixture.lineModels,
    category: p.fixture.category,
    location: p.fixture.location,
    remark: p.fixture.remark
  });
  added++;
}
ok(added === 3, '写入 3 条成功', added);

const all = store.getAll('fixtures');
ok(all.length === 4, '库中共 4 条（含预置 1 条）', all.length);

const byCode = {};
all.forEach((f) => { byCode[f.code] = f; });
ok(!!byCode['2001'] && byCode['2001'].name === '定位销压板', '2001 落库正确', byCode['2001'] && byCode['2001'].name);
ok(!!byCode['2001'] && byCode['2001'].qrToken === 'SPMS1|2001', '二维码 token 自动生成', byCode['2001'] && byCode['2001'].qrToken);
ok(!!byCode['2001'] && byCode['2001'].status === 'stocked', '初始状态 = 在库', byCode['2001'] && byCode['2001'].status);
ok(!!byCode['2001'] && byCode['2001'].totalOutCount === 0 && byCode['2001'].repairCount === 0, '统计字段已初始化');
ok(!!byCode['2001'] && byCode['2001'].lineModels.length === 2 && byCode['2001'].lineModels[1] === 'MODEL-B',
   '机种数组正确落库', byCode['2001'] && byCode['2001'].lineModels);
ok(!!byCode['1002'] && byCode['1002'].name === '装配工装', '自动分配的 1002 落库正确', byCode['1002'] && byCode['1002'].name);

// 落盘文件确实存在
ok(fs.existsSync(path.join(tmpDir, 'fixture-data.json')), '数据文件已写入磁盘');

/* ---- 5. 重复导入的编号冲突保护（store 层应抛错） ---- */
console.log('\n[重复编号保护]');
let threw = false;
try { store.addFixture({ code: '2001', name: '重复编号', lineModels: [] }); }
catch (e) { threw = /编号已存在/.test(e.message); }
ok(threw, '重复编号被 store 层拒绝并抛出「编号已存在」');

/* ---- 6. CSV 路径同样走通 ---- */
console.log('\n[CSV 路径]');
const csvText = '﻿编号,名称,机种名称1,分类,库位,备注\r\n3001,CSV夹具A,MODEL-X,冲压,A-9,csv导入\r\n3002,CSV夹具B,MODEL-Y,焊接,B-9,\r\n';
const csvRows = M.parseCSV(csvText);
ok(csvRows.length === 3, 'CSV 解析 3 行（表头 + 2 条）', csvRows.length);
sandbox.state.fixtures = all;
const csvPlan = M.buildImportPlan(csvRows);
ok(csvPlan.ok && csvPlan.plan.length === 2, 'CSV 也能生成导入计划', csvPlan.ok ? csvPlan.plan.length : csvPlan.error);
ok(csvPlan.plan[0].fixture.code === '3001', 'CSV 编号 3001 保留', csvPlan.ok ? csvPlan.plan[0].fixture.code : null);
ok(csvPlan.plan[0].fixture.name === 'CSV夹具A', 'CSV 名称正确');
ok(csvPlan.plan[1].fixture.code === '3002' && csvPlan.plan[1].autoCode === false, 'CSV 第 2 条保留编号 3002', csvPlan.ok ? csvPlan.plan[1] : null);
ok(csvPlan.plan[1].fixture.remark === '', 'CSV 空备注正确为空串', csvPlan.ok ? csvPlan.plan[1].fixture.remark : null);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);