# -*- coding: utf-8 -*-
"""手工构造真实 .xlsx（zip + sharedStrings），用于验证 xlsx_reader.js 解析器
与 v4.0.0 的夹具导入链路（14 列表头）。

覆盖：
  • 共享字符串 / inlineStr / 纯数字单元格 / 真·空单元格（缺 <c> 节点）/ 全空行
  • 多工作表
  • 有效行（2 机种 / 单机种 / 多机种合并成串 + 多产线）与无效行（库位非法 / 产线未建档）

用法：python test_make_xlsx.py test_fixture.xlsx
"""
import zipfile, sys, os

def col_letter(n):
    s = ''
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s

# 共享字符串池（动态登记，避免手数下标出错）
_shared = []
_si = {}

def sid(text):
    if text not in _si:
        _si[text] = len(_shared)
        _shared.append(text)
    return _si[text]

def s_cell(ref, text):
    return f'<c r="{ref}" t="s"><v>{sid(text)}</v></c>'

def n_cell(ref, val):
    return f'<c r="{ref}"><v>{val}</v></c>'

def inline_cell(ref, text):
    return f'<c r="{ref}" t="inlineStr"><is><t>{text}</t></is></c>'

def e_cell(ref):
    """真·空单元格：sharedStrings 里的空串"""
    return s_cell(ref, '')

# v4.0.0 标准表头（14 列）
HEADERS = ['实物编号', '名称',
           '机种名称1', '机种名称2', '机种名称3', '机种名称4', '机种名称5', '机种名称6', '机种名称7',
           '分类', '库位', '产线', '工位', '备注']

rows_xml = []
rows_xml.append('<row r="1">' + ''.join(s_cell(f'{col_letter(i + 1)}1', h) for i, h in enumerate(HEADERS)) + '</row>')

# 行 2：双机种；E2~I2 完全没有 <c> 节点（模拟 Excel 中真正的空单元格）；备注含 XML 实体
rows_xml.append('<row r="2">' +
    s_cell('A2', 'DH40MC-921-001-001') + s_cell('B2', '定位销压板') +
    s_cell('C2', 'MODEL-A') + s_cell('D2', 'MODEL-B') +
    s_cell('J2', '冲压') + s_cell('K2', 'ZP1-U-1-1') + s_cell('L2', 'L1 总装线') + s_cell('M2', '上料工位') +
    s_cell('N2', '用于冲压定位，含 & <特殊字符>') + '</row>')

# 行 3：单机种 + inlineStr 备注 + 真·空单元格（分类/机种2）
rows_xml.append('<row r="3">' +
    s_cell('A3', 'XXK-D10VG-002') + s_cell('B3', '焊接夹具') + s_cell('C3', 'MODEL-C') +
    e_cell('D3') + e_cell('E3') + e_cell('F3') +
    s_cell('J3', '焊接') + s_cell('K3', 'ZP1-U-1-2') + s_cell('L3', 'L1 总装线') + s_cell('M3', '压装工位') +
    inline_cell('N3', 'inline 字符串备注') + '</row>')

# 行 4：单格内的多机种（斜杠分隔）+ inlineStr 机种 + 多产线（逗号分隔）
rows_xml.append('<row r="4">' +
    s_cell('A4', 'DH40MC-921-001-002') + s_cell('B4', '装配工装') +
    inline_cell('C4', 'MODEL-D/MODEL-E') +
    s_cell('J4', '装配') + s_cell('K4', 'ZP1-U-1-3') +
    s_cell('L4', 'L1 总装线, L2 U型线') + s_cell('M4', '上料工位') + '</row>')

# 行 5：库位用纯数字单元格 → 非 4 段式，应跳过
rows_xml.append('<row r="5">' +
    s_cell('A5', 'SN-BAD-001') + s_cell('B5', '库位错误夹具') + s_cell('C5', 'MODEL-F') +
    s_cell('J5', '冲压') + n_cell('K5', 1234) + s_cell('L5', 'L1 总装线') + s_cell('M5', '上料工位') + '</row>')

# 行 6：产线未建档 → 应跳过
rows_xml.append('<row r="6">' +
    s_cell('A6', 'SN-BAD-002') + s_cell('B6', '产线缺失夹具') + s_cell('C6', 'MODEL-G') +
    s_cell('J6', '焊接') + s_cell('K6', 'ZP1-U-1-4') + s_cell('L6', '幽灵线') + s_cell('M6', '上料工位') + '</row>')

# 行 7：全空行（无任何 <c> 节点）→ 应被解析为空数组并被导入逻辑过滤
rows_xml.append('<row r="7"></row>')

sheet1 = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{''.join(rows_xml)}</sheetData></worksheet>'''

# 第 2 张表：只有表头
sheet2 = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>第二页占位</t></is></c></row></sheetData></worksheet>'''

shared_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(_shared)}" uniqueCount="{len(_shared)}">{''.join(f'<si><t>{s}</t></si>' for s in _shared)}</sst>'''

workbook = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="夹具清单" sheetId="1" r:id="rId1"/><sheet name="第二页" sheetId="2" r:id="rId2"/></sheets></workbook>'''

rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'''

content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'''

root_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'''

out = sys.argv[1] if len(sys.argv) > 1 else 'test_fixture.xlsx'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', content_types)
    z.writestr('_rels/.rels', root_rels)
    z.writestr('xl/workbook.xml', workbook)
    z.writestr('xl/_rels/workbook.xml.rels', rels)
    z.writestr('xl/sharedStrings.xml', shared_xml)
    z.writestr('xl/worksheets/sheet1.xml', sheet1)
    z.writestr('xl/worksheets/sheet2.xml', sheet2)

print(f'生成 {out} ({os.path.getsize(out)} bytes, sharedStrings={len(_shared)})')
