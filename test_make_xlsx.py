# -*- coding: utf-8 -*-
"""手工构造真实 .xlsx（zip + sharedStrings），用于验证 xlsx_reader.js 解析器
与 v5.4.0 的夹具导入链路（22 列表头：机种 12 列、无工位列）。

覆盖：
  • 共享字符串 / inlineStr / 纯数字单元格 / 真·空单元格（缺 <c> 节点）/ 全空行
  • 多工作表
  • 有效行（2 机种 / 单机种 / 多机种合并成串 + 多产线 / **12 机种填满**）与无效行（库位非法 / 产线未建档）

⚠️ 行数据按「表头名 → 值」构造，不手写单元格字母：改列数（机种 7→12 这类）只改 HEADERS 与表头上限，
   行数据自动跟随，不会再出现「表头改了、测试夹具没改」的不一致。

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

MAX_LINE_MODELS = 12
MAX_LINES = 5

# v5.4.0 标准表头（22 列：机种 12 列，工位列已移除）
HEADERS = (['夹具编号', '名称']
           + [f'机种名称{i}' for i in range(1, MAX_LINE_MODELS + 1)]
           + ['分类', '库位']
           + [f'产线{i}' for i in range(1, MAX_LINES + 1)]
           + ['备注'])

assert len(HEADERS) == 22, len(HEADERS)

def row_cells(r, vals):
    """vals: {表头名: (kind, text)}，kind ∈ s/n/i/e。
    未出现在 vals 里的列**不生成 <c> 节点**，用于模拟 Excel 里真正的空单元格。"""
    out = []
    for i, h in enumerate(HEADERS):
        if h not in vals:
            continue
        ref = f'{col_letter(i + 1)}{r}'
        kind, text = vals[h]
        if kind == 's':
            out.append(s_cell(ref, text))
        elif kind == 'n':
            out.append(n_cell(ref, text))
        elif kind == 'i':
            out.append(inline_cell(ref, text))
        elif kind == 'e':
            out.append(e_cell(ref))
        else:
            raise ValueError('unknown kind ' + kind)
    return f'<row r="{r}">' + ''.join(out) + '</row>'

rows_xml = []
rows_xml.append('<row r="1">' + ''.join(s_cell(f'{col_letter(i + 1)}1', h) for i, h in enumerate(HEADERS)) + '</row>')

# 行 2：双机种；其余机种列完全没有 <c> 节点（模拟 Excel 中真正的空单元格）；备注含 XML 实体
rows_xml.append(row_cells(2, {
    '夹具编号': ('s', 'DH40MC-921-001-001'), '名称': ('s', '定位销压板'),
    '机种名称1': ('s', 'MODEL-A'), '机种名称2': ('s', 'MODEL-B'),
    '分类': ('s', '冲压'), '库位': ('s', 'ZP1-U-1-1'),
    '产线1': ('s', 'L1 总装线'),
    '备注': ('s', '用于冲压定位，含 & <特殊字符>'),
}))

# 行 3：单机种 + inlineStr 备注 + 真·空单元格（机种2/3/4）
rows_xml.append(row_cells(3, {
    '夹具编号': ('s', 'XXK-D10VG-002'), '名称': ('s', '焊接夹具'),
    '机种名称1': ('s', 'MODEL-C'),
    '机种名称2': ('e', ''), '机种名称3': ('e', ''), '机种名称4': ('e', ''),
    '分类': ('s', '焊接'), '库位': ('s', 'ZP1-U-1-2'),
    '产线1': ('s', 'L1 总装线'),
    '备注': ('i', 'inline 字符串备注'),
}))

# 行 4：单格内的多机种（斜杠分隔）+ inlineStr 机种 + 多产线（产线1/产线2）
rows_xml.append(row_cells(4, {
    '夹具编号': ('s', 'DH40MC-921-001-002'), '名称': ('s', '装配工装'),
    '机种名称1': ('i', 'MODEL-D/MODEL-E'),
    '分类': ('s', '装配'), '库位': ('s', 'ZP1-U-1-3'),
    '产线1': ('s', 'L1 总装线'), '产线2': ('s', 'L2 U型线'),
}))

# 行 5：库位用纯数字单元格 → 非 4 段式，应跳过
rows_xml.append(row_cells(5, {
    '夹具编号': ('s', 'SN-BAD-001'), '名称': ('s', '库位错误夹具'),
    '机种名称1': ('s', 'MODEL-F'),
    '分类': ('s', '冲压'), '库位': ('n', '1234'),
    '产线1': ('s', 'L1 总装线'),
}))

# 行 6：产线未建档 → 自动补建（不再跳过）
rows_xml.append(row_cells(6, {
    '夹具编号': ('s', 'SN-BAD-002'), '名称': ('s', '产线缺失夹具'),
    '机种名称1': ('s', 'MODEL-G'),
    '分类': ('s', '焊接'), '库位': ('s', 'ZP1-U-1-4'),
    '产线1': ('s', '幽灵线'),
}))

# 行 7：全空行（无任何 <c> 节点）→ 应被解析为空数组并被导入逻辑过滤
rows_xml.append('<row r="7"></row>')

# 行 8：12 个机种位全部填满（v5.4.0 上限验证：末位的 机种名称12 不能被丢）
rows_xml.append(row_cells(8, dict([
    ('夹具编号', ('s', 'SN-MAX-012')), ('名称', ('s', '满机种夹具')),
    ('分类', ('s', '装配')), ('库位', ('s', 'ZP1-U-2-2')),
    ('产线1', ('s', 'L1 总装线')),
] + [(f'机种名称{i}', ('s', f'MX-{i}')) for i in range(1, MAX_LINE_MODELS + 1)])))

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

print(f'生成 {out} ({os.path.getsize(out)} bytes, sharedStrings={len(_shared)}, 表头={len(HEADERS)} 列)')
