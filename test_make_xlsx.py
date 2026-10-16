# -*- coding: utf-8 -*-
"""手工构造真实 .xlsx（zip + sharedStrings），用于验证 xlsx_reader.js 解析器。
覆盖：共享字符串、inlineStr、纯数字、空单元格、多工作表。
"""
import zipfile, sys, os

def col_letter(n):
    s = ''
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s

# 共享字符串表
shared = [
    '编号', '名称', '机种名称1', '机种名称2', '机种名称3', '机种名称4', '分类', '库位', '备注',  # 0-8
    '定位销压板', '焊接夹具', '装配工装', 'MODEL-A', 'MODEL-B', 'MODEL-C',  # 9-14
    '冲压', '焊接', '装配', 'A-01-01', 'B-02-03', 'C-03-05',  # 15-20
    '用于冲压定位，含 & <特殊字符>', '第二页占位',  # 21-22
]

def s_cell(ref, idx):
    return f'<c r="{ref}" t="s"><v>{idx}</v></c>'

def n_cell(ref, val):
    return f'<c r="{ref}"><v>{val}</v></c>'

def inline_cell(ref, text):
    return f'<c r="{ref}" t="inlineStr"><is><t>{text}</t></is></c>'

# 第 1 张表：表头 + 3 行数据
rows_xml = []
rows_xml.append('<row r="1">' + ''.join(s_cell(f'{col_letter(i+1)}1', i) for i in range(9)) + '</row>')
# 行 2：2001 定位销压板 MODEL-A MODEL-B （机种3/4 真空） 冲压 A-01-01 带特殊字符
rows_xml.append('<row r="2">' +
    n_cell('A2', 2001) + s_cell('B2', 9) + s_cell('C2', 12) + s_cell('D2', 13) +
    '' + '' +  # E2/F2 完全没有 <c> 节点，模拟 Excel 中真正的空单元格
    s_cell('G2', 15) + s_cell('H2', 18) + s_cell('I2', 21) + '</row>')
# 行 3：2002 焊接夹具（纯数字单元格 2002）
rows_xml.append('<row r="3">' +
    n_cell('A3', 2002) + s_cell('B3', 10) + s_cell('C3', 14) +
    s_cell('D3', 0) + s_cell('E3', 0) + s_cell('F3', 0) +
    s_cell('G3', 16) + s_cell('H3', 19) + inline_cell('I3', 'inline 字符串备注') + '</row>')
# 行 3：编号留空（模拟自动分配），且中间有稀疏列 C3/E3 空着
rows_xml.append('<row r="4">' +
    '' + s_cell('B4', 11) +
    '' + s_cell('D4', 12) +
    '' +
    s_cell('F4', 13) + s_cell('G4', 17) + '</row>')
# 行 5：全空行（应被过滤）

sheet1 = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{''.join(rows_xml)}</sheetData></worksheet>'''

# 第 2 张表：只有表头
sheet2 = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>第二页占位</t></is></c></row></sheetData></worksheet>'''

shared_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(shared)}" uniqueCount="{len(shared)}">{''.join(f'<si><t>{s}</t></si>' for s in shared)}</sst>'''

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

print(f'生成 {out} ({os.path.getsize(out)} bytes)')