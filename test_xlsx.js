'use strict';
/* ============================================================
 * test_xlsx.js — 验证 js/xlsx_reader.js 解析真实 .xlsx 文件
 * 运行：node test_xlsx.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const { readWorkbook } = require('./js/xlsx_reader');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → 实际: ' + JSON.stringify(extra) : '')); }
}

const FILE = path.join(__dirname, 'test_fixture.xlsx');
if (!fs.existsSync(FILE)) {
  console.error('缺少测试文件 test_fixture.xlsx，请先运行：python test_make_xlsx.py test_fixture.xlsx');
  process.exit(1);
}

console.log('=== xlsx_reader 测试 ===');
const wb = readWorkbook(fs.readFileSync(FILE));
const rows = wb.sheets[0].rows;

// --- 工作表结构 ---
console.log('\n[工作表结构]');
ok(Array.isArray(wb.sheets) && wb.sheets.length === 2, '识别出 2 张工作表', wb.sheets.length);
ok(wb.sheetNames[0] === '夹具清单', '第 1 张表名 = 夹具清单', wb.sheetNames[0]);
ok(wb.sheetNames[1] === '第二页', '第 2 张表名 = 第二页', wb.sheetNames[1]);
ok(wb.sheets[1].rows.length === 1, '第 2 张表 1 行', wb.sheets[1].rows.length);

// --- 表头行 ---
console.log('\n[表头解析]');
const HEAD = ['编号', '名称', '机种名称1', '机种名称2', '机种名称3', '机种名称4', '分类', '库位', '备注'];
ok(rows[0].length === 9, '表头 9 列', rows[0].length);
HEAD.forEach((h, i) => ok(rows[0][i] === h, `表头[${i}] = ${h}`, rows[0][i]));

// --- 数据行 1：全字符串 + XML 实体 ---
console.log('\n[数据行 1 · 字符串 + XML 实体]');
const r1 = rows[1];
ok(r1[0] === '2001', '编号列 = 2001（纯数字单元格）', r1[0]);
ok(r1[1] === '定位销压板', '名称 = 定位销压板', r1[1]);
ok(r1[2] === 'MODEL-A', '机种名称1 = MODEL-A', r1[2]);
ok(r1[3] === 'MODEL-B', '机种名称2 = MODEL-B', r1[3]);
ok(r1[6] === '冲压', '分类 = 冲压', r1[6]);
ok(r1[7] === 'A-01-01', '库位 = A-01-01', r1[7]);
ok(r1[8] === '用于冲压定位，含 & <特殊字符>', '备注正确解码 XML 实体 & 和 <', r1[8]);

// --- 数据行 2：数字单元格 + inlineStr ---
console.log('\n[数据行 2 · 数字 + inlineStr]');
const r2 = rows[2];
ok(r2[0] === '2002', '纯数字单元格读为 "2002"（字符串）', r2[0]);
ok(r2[1] === '焊接夹具', '名称 = 焊接夹具', r2[1]);
ok(r2[2] === 'MODEL-C', '机种名称1 = MODEL-C', r2[2]);
ok(r2[8] === 'inline 字符串备注', 'inlineStr 类型正确解析', r2[8]);

// --- 数据行 3：稀疏列（中间空单元格） ---
console.log('\n[数据行 3 · 稀疏列补位]');
const r3 = rows[3];
ok(r3.length >= 7, '稀疏行长度补齐到 >= 7 列（实际 ' + r3.length + '）', r3.length);
ok(r3[0] === '', 'A 列空（该行编号留空，交由导入时自动分配）', r3[0]);
ok(r3[1] === '装配工装', 'B 列 = 装配工装', r3[1]);
ok(r3[2] === '', 'C 列空（稀疏）正确留空', r3[2]);
ok(r3[3] === 'MODEL-A', 'D 列 = MODEL-A（跨过空 C 列不偏移）', r3[3]);
ok(r3[4] === '', 'E 列空（稀疏）正确留空', r3[4]);
ok(r3[5] === 'MODEL-B', 'F 列 = MODEL-B', r3[5]);
ok(r3[6] === '装配', 'G 列 = 装配', r3[6]);

// --- 错误处理 ---
console.log('\n[错误处理]');
try {
  readWorkbook(Buffer.from('not a zip file at all'));
  ok(false, '非 zip 输入应抛错');
} catch (e) {
  ok(/不是 \.xlsx/.test(e.message) || /不是/.test(e.message), '非 zip 输入给出明确报错', e.message);
}
try {
  readWorkbook(Buffer.alloc(0));
  ok(false, '空输入应抛错');
} catch (e) {
  ok(true, '空输入给出明确报错', e.message);
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);