'use strict';
/* ============================================================
 * xlsx_reader.js — 主进程侧极简 XLSX(.xlsx) 读取器（无第三方依赖）
 *
 * 用途：夹具管理系统「导入 Excel」功能。渲染进程读不到 zlib，
 *   故由渲染进程把文件字节传进来，此处解 zip + 解析 XML，返回二维数组。
 *
 * 支持：
 *   - zip（deflate / stored）解包，仅取需要的 4 个部件
 *   - sharedStrings 共享字符串表
 *   - sheet 首张工作表
 *   - 单元格类型：s(共享串) / inlineStr / str(公式结果) / b(布尔) / 数值
 *   - r="B7" 形式的列标 → 列索引，自动跳过中间空列
 *
 * 不支持（明确边界）：
 *   - .xls（旧二进制格式）、.csv（渲染进程直接读文本）
 *   - 加密工作簿、公式重算（只取 Excel 已缓存的计算结果）
 *   - 单元格样式 / 日期格式化（日期列将以 Excel 序列号数字返回）
 * ============================================================ */
const zlib = require('zlib');

/* ---------- ZIP 解析 ---------- */

// 定位 EOCD（End of Central Directory），从尾部反向扫描
function findEOCD(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// 读中央目录，返回 { name -> { method, offset, compSize, uncompSize } }
function readCentralDirectory(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('不是有效的 xlsx/zip 文件（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const map = new Map();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    map.set(name, { method, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return map;
}

// 按中央目录记录取出条目内容并解压
function readEntry(buf, entry) {
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('zip 局部头损坏');
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('不支持的压缩方式：' + entry.method);
}

function readEntryText(buf, dir, name) {
  const e = dir.get(name);
  if (!e) return null;
  return readEntry(buf, e).toString('utf8');
}

/* ---------- XML 解析 ---------- */

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

// 取某个片段内所有 <t ...>…</t> 的拼接文本（兼容 <si><r><t> 分段）
function collectT(fragment) {
  const out = [];
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(fragment))) {
    out.push(m[1] == null ? '' : decodeEntities(m[1]));
  }
  return out.join('');
}

// sharedStrings.xml → string[]
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    out.push(m[1] == null ? '' : collectT(m[1]));
  }
  return out;
}

// "B7" → 1（0 基列索引）
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(String(ref || '').toUpperCase());
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function attr(tag, name) {
  const re = new RegExp(name + '="([^"]*)"');
  const m = re.exec(tag);
  return m ? m[1] : '';
}

// sheetN.xml → 二维数组（每行长度按最大列号补齐）
function parseSheet(xml, shared) {
  const rows = [];
  if (!xml) return rows;
  const rowRe = /<row(?:\s([^>]*))?>([\s\S]*?)<\/row>|<row(?:\s([^>]*))?\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const body = rm[2] || '';
    const cells = [];
    const cellRe = /<c(?:\s([^>]*))?>([\s\S]*?)<\/c>|<c(?:\s([^>]*))?\/>/g;
    let cm;
    while ((cm = cellRe.exec(body))) {
      const tag = (cm[1] != null ? ' ' + cm[1] : '') || (cm[3] != null ? ' ' + cm[3] : '');
      const inner = cm[2] || '';
      const ref = attr(tag, 'r');
      const t = attr(tag, 't');
      const ci = ref ? colIndex(ref) : cells.length;

      let value = '';
      if (t === 'inlineStr') {
        const isM = /<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/.exec(inner);
        value = isM ? collectT(isM[1]) : '';
      } else {
        const vM = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
        const raw = vM ? decodeEntities(vM[1]) : '';
        if (t === 's') value = shared[parseInt(raw, 10)] != null ? shared[parseInt(raw, 10)] : '';
        else if (t === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else value = raw;
      }
      // 稀疏列补空
      while (cells.length < ci) cells.push('');
      cells[ci] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/* ---------- 对外入口 ---------- */

/**
 * 解析 xlsx 字节流，返回首张工作表的二维数组（字符串）。
 * @param {Buffer|Uint8Array} input 文件字节
 * @returns {{ sheets: Array<{name:string, rows:string[][]}>, sheetNames: string[] }}
 */
function readWorkbook(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 4) throw new Error('文件为空');
  // xlsx 是 zip；魔数 PK\x03\x04
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new Error('不是 .xlsx 文件（xlsx 实际是 zip 包）。若为 .xls 或 .csv，请先另存为 .xlsx / .csv');
  }

  const dir = readCentralDirectory(buf);
  const shared = parseSharedStrings(readEntryText(buf, dir, 'xl/sharedStrings.xml'));

  // 工作表清单：优先按 workbook.xml + rels 顺序，退化按 worksheets/sheetN.xml 顺序
  const sheetNames = [];
  const wbXml = readEntryText(buf, dir, 'xl/workbook.xml');
  if (wbXml) {
    const re = /<sheet(?:\s[^>]*)?>/g;
    let m;
    while ((m = re.exec(wbXml))) {
      const nm = attr(m[0], 'name');
      if (nm) sheetNames.push(nm);
    }
  }
  const sheetFiles = [];
  for (const key of dir.keys()) {
    const m = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(key);
    if (m) sheetFiles.push({ key, idx: parseInt(m[1], 10) });
  }
  sheetFiles.sort((a, b) => a.idx - b.idx);

  const sheets = sheetFiles.map((f, i) => ({
    name: sheetNames[i] || ('Sheet' + (i + 1)),
    rows: parseSheet(readEntryText(buf, dir, f.key), shared)
  }));
  if (!sheets.length) throw new Error('xlsx 中没有找到工作表');
  return { sheets, sheetNames: sheets.map((s) => s.name) };
}

module.exports = { readWorkbook };