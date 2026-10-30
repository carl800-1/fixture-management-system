'use strict';
/* ============================================================
 * xlsx_writer.js — 极简 XLSX(.xlsx) 写入器（无第三方依赖）
 *
 * 用途：异常工装「导出 Excel」。生成**真正的 Excel 文件**（OOXML + zip），
 *   支持：单元格背景色 / 表头加粗居中 / 细边框 / 列宽 / 冻结首行 / 自动筛选。
 *
 * 为什么不用 SheetJS：其社区版**不支持写入单元格样式**（cell.s 会被忽略），
 *   导出的表能打开但没有颜色；故自实现写入器，与 xlsx_reader.js 对称（同样零依赖）。
 *
 * 用法：
 *   const wb = XlsxWriter.create();
 *   wb.addSheet('①名称套号不符', {
 *     header: ['编号', '名称', '详情'],          // 表头（加粗、灰底、居中、冻结）
 *     widths: [22, 34, 38],                      // 各列宽（字符数，可省略）
 *     rows: [ { cells: ['A-001', 'xx', '说明'], fill: '#ffcccc' }, ... ]
 *   });
 *   wb.download('异常工装导出_20261030_1353.xlsx');   // 触发浏览器/Electron 下载
 * ============================================================ */
(function (global) {

  /* ---------- CRC32（zip 校验用） ---------- */
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------- UTF-8 编码（自实现，避免依赖 TextEncoder） ---------- */
  function utf8(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        const cp = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(++i) - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return new Uint8Array(out);
  }

  /* ---------- ZIP 打包（仅 stored 不压缩，Excel 完全接受） ---------- */
  function dosDateTime(d) {
    return {
      time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
      date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
    };
  }

  function zipStore(files) {
    const dt = dosDateTime(new Date());
    const locals = [];
    const central = [];
    let offset = 0;

    files.forEach(function (f) {
      const nameBytes = utf8(f.name);
      const data = f.data;
      const crc = crc32(data);
      const size = data.length;

      /* 本地文件头 */
      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034B50, true);   // PK\3\4
      lv.setUint16(4, 20, true);           // 解压所需版本
      lv.setUint16(6, 0x0800, true);       // 标志位：文件名为 UTF-8
      lv.setUint16(8, 0, true);            // 压缩方法 = stored
      lv.setUint16(10, dt.time, true);
      lv.setUint16(12, dt.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);        // 压缩后大小
      lv.setUint32(22, size, true);        // 原始大小
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);           // extra 长度
      lh.set(nameBytes, 30);

      locals.push(lh, data);

      /* 中央目录项 */
      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014B50, true);
      cv.setUint16(4, 20, true);           // version made by
      cv.setUint16(6, 20, true);           // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dt.time, true);
      cv.setUint16(14, dt.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);           // extra
      cv.setUint16(32, 0, true);           // 注释
      cv.setUint16(34, 0, true);           // 起始磁盘
      cv.setUint16(36, 0, true);           // 内部属性
      cv.setUint32(38, 0, true);           // 外部属性
      cv.setUint32(42, offset, true);      // 本地头偏移
      ch.set(nameBytes, 46);
      central.push(ch);

      offset += lh.length + size;
    });

    const cdSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054B50, true);     // PK\5\6
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const out = new Uint8Array(offset + cdSize + 22);
    let p = 0;
    locals.forEach(function (c) { out.set(c, p); p += c.length; });
    central.forEach(function (c) { out.set(c, p); p += c.length; });
    out.set(eocd, p);
    return out;
  }

  /* ---------- XML 工具 ---------- */
  // 转义 + 剔除 XML 非法控制字符（\t\n\r 保留）
  function xesc(v) {
    return String(v == null ? '' : v)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // 0-based 列序号 → Excel 列字母（0 → A，26 → AA）
  function colName(i) {
    let s = '';
    let n = i + 1;
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // 颜色归一化为 8 位 ARGB（#ffcccc → FFFFCCCC；已是 ARGB 的原样保留）
  function argb(hex) {
    let h = String(hex || '').trim().replace(/^#/, '').toUpperCase();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 8) h = h.slice(2);   // 入参已是 ARGB，取后 6 位 RGB
    if (!/^[0-9A-F]{6}$/.test(h)) h = 'FFFFFF';
    return 'FF' + h;
  }

  // 工作表名：≤31 字符、去除 OOXML 禁用字符、同名自动去重
  function safeSheetName(name, used) {
    let base = String(name || 'Sheet').replace(/[\[\]:*?\/\\]/g, '_').slice(0, 31) || 'Sheet';
    let out = base;
    let i = 2;
    while (used.indexOf(out) !== -1) {
      const suffix = '_' + i++;
      out = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.push(out);
    return out;
  }

  /* ---------- 样式表：按需登记填充色，生成 styles.xml ---------- */
  function StyleBook() {
    // fills：0 无填充 / 1 gray125（规范要求）/ 2 表头灰 / 3.. 各数据行颜色
    this.fills = [null, null, 'FFF0F0F0'];
    this.fillToId = new Map();
    // cellXfs：0 默认 / 1 表头 / 2.. 数据行（每种颜色一个，后续复用）
    this.xfByColor = new Map();
  }

  StyleBook.prototype.fillId = function (hex) {
    const rgb = argb(hex);
    if (this.fillToId.has(rgb)) return this.fillToId.get(rgb);
    const id = this.fills.length;
    this.fills.push(rgb);
    this.fillToId.set(rgb, id);
    return id;
  };

  // 返回数据行使用的 cellXfs 索引
  StyleBook.prototype.dataXf = function (hex) {
    const rgb = argb(hex);
    if (this.xfByColor.has(rgb)) return this.xfByColor.get(rgb);
    const id = 2 + this.xfByColor.size;   // 0=默认、1=表头，数据行从 2 开始
    this.xfByColor.set(rgb, id);
    return id;
  };

  StyleBook.prototype.headerXf = function () { return 1; };

  StyleBook.prototype.toXml = function () {
    const self = this;

    // ⚠️ 必须先把数据行用到的颜色全部登记进 fills，再拼 fillsXml，
    //    否则 xf 里的 fillId 会指向尚未输出的 fill（Excel/openpyxl 报索引越界）。
    const ordered = Array.from(this.xfByColor.entries()).sort(function (a, b) { return a[1] - b[1]; });
    ordered.forEach(function (entry) { self.fillId(entry[0]); });

    const fillsXml = this.fills.map(function (rgb, i) {
      if (i === 0) return '<fill><patternFill patternType="none"/></fill>';
      if (i === 1) return '<fill><patternFill patternType="gray125"/></fill>';
      return '<fill><patternFill patternType="solid"><fgColor rgb="' + (rgb || 'FFFFFFFF') + '"/><bgColor indexed="64"/></patternFill></fill>';
    }).join('');

    const BORDER = '<border><left style="thin"><color rgb="FFD9D9D9"/></left>'
      + '<right style="thin"><color rgb="FFD9D9D9"/></right>'
      + '<top style="thin"><color rgb="FFD9D9D9"/></top>'
      + '<bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border>';

    const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      // 表头：加粗 + 灰底 + 边框 + 居中
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0"'
      + ' applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
      + '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>'];

    // 数据行：按登记顺序输出（保证 xf 索引与 dataXf 返回一致）
    ordered.forEach(function (entry) {
      xfs.push('<xf numFmtId="0" fontId="0" fillId="' + self.fillId(entry[0]) + '" borderId="1" xfId="0"'
        + ' applyFill="1" applyBorder="1" applyAlignment="1">'
        + '<alignment vertical="center" wrapText="1"/></xf>');
    });

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="2">'
      + '<font><sz val="11"/><name val="微软雅黑"/><charset val="134"/></font>'
      + '<font><b/><sz val="11"/><name val="微软雅黑"/><charset val="134"/></font>'
      + '</fonts>'
      + '<fills count="' + this.fills.length + '">' + fillsXml + '</fills>'
      + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' + BORDER + '</borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>';
  };

  /* ---------- 工作表 XML ---------- */
  function sheetXml(sheet, styleBook, tabSelected, freezeHeader) {
    const header = sheet.header || [];
    const rows = sheet.rows || [];
    const colCount = Math.max(
      header.length,
      rows.reduce(function (m, r) { return Math.max(m, (r.cells || []).length); }, 0)
    );
    const rowCount = rows.length + (header.length ? 1 : 0);
    const dim = 'A1:' + colName(Math.max(colCount - 1, 0)) + Math.max(rowCount, 1);

    /* 列宽 */
    let colsXml = '';
    if (sheet.widths && sheet.widths.length) {
      colsXml = '<cols>' + sheet.widths.map(function (w, i) {
        return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (Number(w) || 12)
          + '" customWidth="1"/>';
      }).join('') + '</cols>';
    }

    /* 行 */
    const rowXmls = [];
    let r = 1;

    if (header.length) {
      const cells = header.map(function (h, i) {
        return '<c r="' + colName(i) + r + '" s="' + styleBook.headerXf() + '" t="inlineStr">'
          + '<is><t xml:space="preserve">' + xesc(h) + '</t></is></c>';
      }).join('');
      rowXmls.push('<row r="' + r + '" ht="24" customHeight="1">' + cells + '</row>');
      r++;
    }

    rows.forEach(function (row) {
      const xs = styleBook.dataXf(row.fill || '#FFFFFF');
      const cellsArr = row.cells || [];
      let cellXml = '';
      for (let i = 0; i < colCount; i++) {
        const val = cellsArr[i];
        const addr = colName(i) + r;
        if (val === null || val === undefined || val === '') {
          // 空值也写出来，让背景色铺满整行
          cellXml += '<c r="' + addr + '" s="' + xs + '"/>';
        } else {
          cellXml += '<c r="' + addr + '" s="' + xs + '" t="inlineStr">'
            + '<is><t xml:space="preserve">' + xesc(val) + '</t></is></c>';
        }
      }
      rowXmls.push('<row r="' + r + '" ht="18" customHeight="1">' + cellXml + '</row>');
      r++;
    });

    /* 视图：冻结表头 + 选中态 */
    const pane = (freezeHeader && header.length)
      ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
      : '<selection activeCell="A1" sqref="A1"/>';

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<dimension ref="' + dim + '"/>'
      + '<sheetViews><sheetView' + (tabSelected ? ' tabSelected="1"' : '') + ' workbookViewId="0">'
      + pane + '</sheetView></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="16.5"/>'
      + colsXml
      + '<sheetData>' + rowXmls.join('') + '</sheetData>'
      + (header.length && rows.length ? '<autoFilter ref="' + dim.split(':')[0] + ':' + colName(Math.max(colCount - 1, 0)) + rowCount + '"/>' : '')
      + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
      + '</worksheet>';
  }

  /* ---------- 工作簿 ---------- */
  function create() {
    const sheets = [];
    const usedNames = [];

    const wb = {
      /* 添加工作表；spec = { header, widths, rows:[{cells,fill}], freeze } */
      addSheet: function (name, spec) {
        spec = spec || {};
        sheets.push({
          name: safeSheetName(name, usedNames),
          header: spec.header || [],
          widths: spec.widths || [],
          rows: spec.rows || [],
          freeze: spec.freeze !== false
        });
        return wb;
      },

      sheetCount: function () { return sheets.length; },

      rowCount: function () {
        return sheets.reduce(function (s, sh) { return s + sh.rows.length; }, 0);
      },

      /* 生成 xlsx 字节 */
      toArrayBuffer: function () {
        if (!sheets.length) throw new Error('工作簿至少需要一个工作表');

        const styleBook = new StyleBook();
        // 先扫一遍收集颜色，让 styles.xml 的 fill/xf 索引稳定
        sheets.forEach(function (sh) {
          (sh.rows || []).forEach(function (row) { styleBook.dataXf(row.fill || '#FFFFFF'); });
        });

        const files = [];
        const sheetFiles = sheets.map(function (sh, i) {
          return {
            name: 'xl/worksheets/sheet' + (i + 1) + '.xml',
            data: utf8(sheetXml(sh, styleBook, i === 0, sh.freeze))
          };
        });

        /* [Content_Types].xml */
        const overrides = sheets.map(function (sh, i) {
          return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml"'
            + ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
        }).join('');
        files.push({
          name: '[Content_Types].xml',
          data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            + '<Default Extension="xml" ContentType="application/xml"/>'
            + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            + overrides
            + '</Types>')
        });

        /* _rels/.rels */
        files.push({
          name: '_rels/.rels',
          data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            + '</Relationships>')
        });

        /* xl/workbook.xml */
        const sheetTags = sheets.map(function (sh, i) {
          return '<sheet name="' + xesc(sh.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
        }).join('');
        files.push({
          name: 'xl/workbook.xml',
          data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
            + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            + '<workbookPr/><bookViews><workbookView activeTab="0"/></bookViews>'
            + '<sheets>' + sheetTags + '</sheets></workbook>')
        });

        /* xl/_rels/workbook.xml.rels */
        const relTags = sheets.map(function (sh, i) {
          return '<Relationship Id="rId' + (i + 1) + '"'
            + ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"'
            + ' Target="worksheets/sheet' + (i + 1) + '.xml"/>';
        }).join('');
        files.push({
          name: 'xl/_rels/workbook.xml.rels',
          data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + relTags
            + '<Relationship Id="rId' + (sheets.length + 1) + '"'
            + ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            + '</Relationships>')
        });

        /* xl/styles.xml */
        files.push({ name: 'xl/styles.xml', data: utf8(styleBook.toXml()) });

        /* 各工作表 */
        sheetFiles.forEach(function (f) { files.push(f); });

        const bytes = zipStore(files);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },

      /* 生成 Blob（Electron / 浏览器通用） */
      toBlob: function () {
        return new Blob([wb.toArrayBuffer()], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
      },

      /* 触发下载 */
      download: function (filename) {
        const blob = wb.toBlob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || 'export.xlsx';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // 稍后释放，避免个别环境下下载未开始就被回收
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        return filename;
      }
    };

    return wb;
  }

  const api = { create: create, argb: argb, colName: colName, _zipStore: zipStore, _utf8: utf8, _crc32: crc32 };
  global.XlsxWriter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
