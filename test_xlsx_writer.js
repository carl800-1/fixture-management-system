'use strict';
/* ============================================================
 * test_xlsx_writer.js — 验证 js/xlsx_writer.js 生成的 .xlsx
 *
 * 覆盖：
 *   - zip 结构（PK 头、条目、CRC 一致性，能被 xlsx_reader 解回）
 *   - 工作簿 / 工作表 / 单元格文本与 XML 转义
 *   - 单元格背景色（fill → cellXfs → 单元格 s 索引自洽）
 *   - 表头加粗、冻结首行、自动筛选、列宽
 *   - 边界：空单元格仍带样式、非法表名净化、超长表名截断、重名去重、颜色归一化
 *
 * 运行：node test_xlsx_writer.js
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const XlsxWriter = require('./js/xlsx_writer');
const { readWorkbook } = require('./js/xlsx_reader');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → 实际: ' + JSON.stringify(extra) : '')); }
}

console.log('=== xlsx_writer 测试 ===');

/* ---------- 1. 颜色 / 列号工具 ---------- */
console.log('\n[工具函数]');
ok(XlsxWriter.argb('#ffcccc') === 'FFFFCCCC', '#ffcccc → FFFFCCCC', XlsxWriter.argb('#ffcccc'));
ok(XlsxWriter.argb('ffcccc') === 'FFFFCCCC', '无井号亦可', XlsxWriter.argb('ffcccc'));
ok(XlsxWriter.argb('#abc') === 'FFAABBCC', '3 位缩写 #abc → FFAABBCC', XlsxWriter.argb('#abc'));
ok(XlsxWriter.argb('FFFFCCCC') === 'FFFFCCCC', '已是 ARGB 不重复加 FF', XlsxWriter.argb('FFFFCCCC'));
ok(XlsxWriter.argb('不是颜色') === 'FFFFFFFF', '非法颜色兜底为白色', XlsxWriter.argb('不是颜色'));
ok(XlsxWriter.colName(0) === 'A' && XlsxWriter.colName(25) === 'Z', '列号 0/25 → A/Z');
ok(XlsxWriter.colName(26) === 'AA' && XlsxWriter.colName(27) === 'AB', '列号 26/27 → AA/AB', XlsxWriter.colName(27));

/* ---------- 2. 生成工作簿 ---------- */
console.log('\n[生成与结构]');
const wb = XlsxWriter.create();
wb.addSheet('①名称套号不符', {
  header: ['编号', '名称', '说明'],
  widths: [24, 32, 30],
  rows: [
    { cells: ['G10BP5-921-025-001', '定位销<压板>&"测试"', '套号 001 ≠ 名称尾号 2'], fill: '#ffcccc' },
    { cells: ['G10BP5-921-025-002', '定位销', '套号 002 ≠ 名称尾号 3'], fill: '#ffcccc' },
    { cells: ['G10BP5-921-025-003', '', ''], fill: '#ffcccc' }
  ]
});
wb.addSheet('④套号缺失', {
  header: ['工装号', '现有套号', '缺失套号'],
  widths: [24, 30, 20],
  rows: [{ cells: ['XXK-D10VG-002', '001、003', '002'], fill: '#fff9e6' }]
});
wb.addSheet('库位分布', {
  header: ['工装号', '套数', '库位分布'],
  rows: [{ cells: ['BH18LTX-921', '3 套', 'A-01（2套）、B-02（1套）'], fill: '#e6f3ff' }]
});

const buf = Buffer.from(wb.toArrayBuffer());
ok(buf.length > 1000, '生成字节数 > 1000', buf.length);
ok(buf.readUInt32LE(0) === 0x04034B50, '首 4 字节为 zip 本地头 PK\\3\\4');
ok(wb.sheetCount() === 3, '3 张工作表', wb.sheetCount());
ok(wb.rowCount() === 5, '数据行合计 5 行（3 + 1 + 1）', wb.rowCount());

/* stored 未压缩 → 直接扫明文 XML 断言结构 */
const raw = buf.toString('utf8');
ok(raw.includes('[Content_Types].xml'), '含 [Content_Types].xml');
ok(raw.includes('xl/workbook.xml') && raw.includes('xl/styles.xml'), '含 workbook.xml / styles.xml');
ok(raw.includes('xl/worksheets/sheet3.xml'), '含第 3 张工作表部件');
ok(/<pane ySplit="1"[^>]*state="frozen"\/>/.test(raw), '首行冻结（pane ySplit=1）');
ok(/<autoFilter ref="A1:C4"\/>/.test(raw), '自动筛选范围 A1:C4', (raw.match(/<autoFilter[^>]*>/) || [])[0]);
ok(/<col min="2" max="2" width="32"/.test(raw), '第 2 列列宽 32');

/* ---------- 3. 背景色自洽 ---------- */
console.log('\n[背景色]');
const fills = (raw.match(/<fills count="(\d+)">([\s\S]*?)<\/fills>/) || []);
const fillCount = Number(fills[1]);
const fillRgbs = (fills[2] || '').match(/rgb="[0-9A-F]{8}"/g) || [];
ok(fillCount === 6, 'fills 共 6 个（none / gray125 / 表头灰 / 3 种异常色）', fillCount);
ok(fillRgbs.indexOf('rgb="FFFFCCCC"') !== -1, '含浅红 FFFFCCCC');
ok(fillRgbs.indexOf('rgb="FFFFF9E6"') !== -1, '含浅黄 FFFFF9E6');
ok(fillRgbs.indexOf('rgb="FFE6F3FF"') !== -1, '含浅蓝 FFE6F3FF');
ok(fillRgbs.indexOf('rgb="FFF0F0F0"') !== -1, '含表头灰 FFF0F0F0');

const xfsBlock = (raw.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/) || []);
const xfCount = Number(xfsBlock[1]);
const xfFillIds = Array.from(xfsBlock[2].matchAll(/fillId="(\d+)"/g)).map((m) => Number(m[1]));
ok(xfCount === 5, 'cellXfs 共 5 个（默认 / 表头 / 3 类数据色）', xfCount);
ok(xfFillIds.every((id) => id < fillCount), '全部 fillId 未越界（< fills 数量）', xfFillIds);
ok(/<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0"[^>]*applyFont="1"/.test(raw), '表头 xf 引用加粗字体');

/* 单元格 s 索引必须落在 cellXfs 范围内 */
const sIds = Array.from(raw.matchAll(/<c r="[A-Z]+\d+" s="(\d+)"/g)).map((m) => Number(m[1]));
ok(sIds.length > 0 && sIds.every((s) => s < xfCount), '所有单元格 s 索引未越界', [Math.min.apply(null, sIds), Math.max.apply(null, sIds)]);
ok(sIds.indexOf(1) !== -1, '表头单元格用的是 s=1（加粗灰底）');
ok(sIds.filter((s) => s >= 2).length >= 12, '数据行单元格都带数据样式', sIds.filter((s) => s >= 2).length);

/* ---------- 4. 用项目自带 reader 读回（读写往返） ---------- */
console.log('\n[读写往返]');
const tmpFile = path.join(os.tmpdir(), 'xlsx_writer_test_' + process.pid + '.xlsx');
fs.writeFileSync(tmpFile, buf);
let book = null;
try {
  book = readWorkbook(fs.readFileSync(tmpFile));
} catch (e) {
  ok(false, 'xlsx_reader 能解析生成的 xlsx', e.message);
}
if (book) {
  ok(book.sheetNames.length === 3, 'reader 读到 3 张表', book.sheetNames.length);
  ok(book.sheetNames[0] === '①名称套号不符', '第 1 张表名一致', book.sheetNames[0]);
  const r0 = book.sheets[0].rows;
  ok(r0.length === 4, '第 1 张表 4 行（表头 + 3 数据）', r0.length);
  ok(r0[0].join('|') === '编号|名称|说明', '表头文本一致', r0[0]);
  ok(r0[1][1] === '定位销<压板>&"测试"', 'XML 实体正确还原', r0[1][1]);
  ok(r0[2][0] === 'G10BP5-921-025-002', '数据行文本一致', r0[2][0]);
  ok(r0[3][1] === '' && r0[3][2] === '', '空单元格读回为空串', [r0[3][1], r0[3][2]]);
  ok(book.sheets[2].rows[1][2] === 'A-01（2套）、B-02（1套）', '第 3 张表中文与括号完整', book.sheets[2].rows[1][2]);
}
try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }

/* ---------- 5. 边界 ---------- */
console.log('\n[边界情况]');
const wb2 = XlsxWriter.create();
ok((() => { try { wb2.toArrayBuffer(); return false; } catch (e) { return /至少需要一个工作表/.test(e.message); } })(),
  '无工作表时抛错而不是产出坏文件');

wb2.addSheet('a/b:c*d?e[f]g', { header: ['h'], rows: [{ cells: ['x'], fill: 'red' }] });
wb2.addSheet('名称很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长', { header: ['h'], rows: [{ cells: ['y'] }] });
wb2.addSheet('a/b:c*d?e[f]g', { header: ['h'], rows: [{ cells: ['z'] }] });
const raw2 = Buffer.from(wb2.toArrayBuffer()).toString('utf8');
const names = Array.from(raw2.matchAll(/<sheet name="([^"]*)"/g)).map((m) => m[1]);
ok(names[0] === 'a_b_c_d_e_f_g', '非法表名字符被替换为下划线', names[0]);
ok(names[1].length === 31, '超长表名截断到 31 字符', names[1].length);
ok(names[2] !== names[0] && names[2].length <= 31, '重名表自动去重', names[2]);
ok(/rgb="FFFFFFFF"/.test(raw2), '非法颜色值 red 兜底为白色 FFFFFFFF（不产生非法 rgb）', (raw2.match(/rgb="[0-9A-F]{8}"/g) || []).slice(0, 3));

/* 无 rows 只有 header 的表：不应生成 autoFilter 之外的空 sheetData 错误 */
const wb3 = XlsxWriter.create();
wb3.addSheet('空表', { header: ['A', 'B'], rows: [] });
const raw3 = Buffer.from(wb3.toArrayBuffer()).toString('utf8');
ok(/<row r="1"/.test(raw3), '仅表头时仍写出表头行');
ok(!/<c r="A2"/.test(raw3), '无数据行时不产生空数据行');

/* ---------- 汇总 ---------- */
console.log('\n=== 结果 ===');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
