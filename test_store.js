'use strict';
/* ============================================================
 * test_store.js — store.js 数据层功能测试（纯 Node，无需 Electron）v4.0.0
 * 运行：node test_store.js
 *
 * v5.0.0 覆盖：序号自动分配、实物编号（可重复）、产线关联强校验（工位模型已移除）、
 *   出库冻结库位 / 回库可改库位、撤销接口、级联删除重写、机种字典保护与重命名写穿、
 *   派生数量、v3.0.x → v4.0.0 数据迁移。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = path.join(os.tmpdir(), 'fixture-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

const store = require('./store.js');
store.setDataDir(TMP);

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  ❌ ' + name + (extra ? ' -> ' + extra : '')); }
}
function section(t) { console.log('\n【' + t + '】'); }
function throws(fn, msgMatch) {
  try { fn(); return false; }
  catch (e) {
    if (msgMatch && e.message.indexOf(msgMatch) < 0) { throw new Error('错误类型不符，实际: ' + e.message); }
    return true;
  }
}

/* 造一条合规的夹具入参（产线先建好；v5.0.0 起无工位） */
const lineA = store.add('lines', { name: '3 号线', type: 'linear' });
const lineB = store.add('lines', { name: 'L2 U型线', type: 'u' });
function fix(extra) {
  return Object.assign({
    serialNo: 'DH40MC-921-001-001', name: '焊接夹具A', lineModels: ['DH40MC'],
    lines: [lineA], location: 'ZP1-U-1-1', category: '焊接', remark: ''
  }, extra || {});
}

/* ---------- 1. 建档 ---------- */
section('1. 夹具建档（序号自动 / 实物编号手动）');
store.open();
const id1 = store.addFixture(fix());
ok('建档返回 id', typeof id1 === 'number' && id1 > 0, 'id=' + id1);

let f1 = store.getAll('fixtures').find((f) => f.id === id1);
ok('序号自动分配为 1001', f1.code === '1001', f1.code);
ok('实物编号按输入保存', f1.serialNo === 'DH40MC-921-001-001', f1.serialNo);
ok('初始状态 stocked', f1.status === 'stocked', f1.status);
ok('计数归零', f1.totalOutCount === 0 && f1.totalReturnCount === 0 && f1.repairCount === 0);
ok('创建时间已写入', typeof f1.createdAt === 'number' && f1.createdAt > 0);
ok('qrToken 不落库（派生值）', f1.qrToken === undefined);

const id2 = store.addFixture(fix({ serialNo: 'DH40MC-921-001-002', name: '冲压夹具B', location: 'ZP1-U-1-2' }));
ok('第二个夹具编号顺延 1002', store.getAll('fixtures').find((f) => f.id === id2).code === '1002');
ok('夹具总数=2', store.count('fixtures') === 2);

section('1b. 建档强校验（v5.0.0：产线 1~5 条，无工位）');
ok('缺实物编号被拒绝', throws(() => store.addFixture(fix({ serialNo: '' })), '实物夹具编号'));
ok('实物编号含竖线被拒绝', throws(() => store.addFixture(fix({ serialNo: 'A|B' })), '实物夹具编号'));
ok('缺名称被拒绝', throws(() => store.addFixture(fix({ name: '' })), '夹具名称'));
ok('产线为空被拒绝', throws(() => store.addFixture(fix({ lines: [] })), '至少选择 1 条产线'));
ok('产线超过 5 条被拒绝', throws(() => store.addFixture(fix({ lines: [1, 2, 3, 4, 5, 6] })), '最多关联 5 条产线'));
ok('旧数据带 stations 字段会被静默丢弃（不报错）', (() => { const i = store.addFixture(fix({ code: '3901', serialNo: 'S-OLD-ST', lines: [lineA], stations: [7, 8] })); return store.getAll('fixtures').find((f) => f.id === i).stations === undefined; })());
ok('机种超过 12 个被拒绝', throws(() => store.addFixture(fix({ lineModels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'] })), '最多 12 个'));
ok('库位空被拒绝', throws(() => store.addFixture(fix({ location: '' })), '库位号需为 4 段式'));
ok('库位非 4 段被拒绝', throws(() => store.addFixture(fix({ location: 'A1-03' })), '库位号需为 4 段式'));
ok('库位超 20 字符被拒绝', throws(() => store.addFixture(fix({ location: 'ZP12345678901-U-12-15' })), '库位号需为 4 段式'));
ok('重复序号被拒绝', throws(() => store.addFixture(fix({ code: '1001' })), '编号已存在'));
ok('指定未占用的序号可用', (() => { const i = store.addFixture(fix({ code: '3001', serialNo: 'S-1' })); return store.getAll('fixtures').find((f) => f.id === i).code === '3001'; })());

section('1c. 编号分配填补空洞');
store.addFixture(fix({ serialNo: 'S-2' }));
const all = store.getAll('fixtures').map((f) => f.code);
ok('已分配编号 1001/1002/1003/3001', all.indexOf('1001') >= 0 && all.indexOf('1002') >= 0 && all.indexOf('1003') >= 0 && all.indexOf('3001') >= 0, all.join(','));
ok('nextFreeCode 跳过已占用', store.nextFreeCode() === '1004', store.nextFreeCode());

/* ---------- 2. 出库 ---------- */
section('2. 出库（location 冻结、只改 status）');
const t = Date.now();
const txOut1 = store.addFixTransaction({ fixtureId: id1, type: 'out', operator: '李四', counterparty: '生产一车间', time: t, remark: '首次领用' });
ok('出库流水写入', typeof txOut1 === 'number' && txOut1 > 0);
f1 = store.getAll('fixtures').find((f) => f.id === id1);
ok('状态变为 checked_out', f1.status === 'checked_out', f1.status);
ok('出库次数 +1', f1.totalOutCount === 1, String(f1.totalOutCount));
ok('出库不改动库位（冻结）', f1.location === 'ZP1-U-1-1', f1.location);

let r1 = store.getAll('fixTransactions').find((x) => x.id === txOut1);
ok('流水记录序号正确', r1.fixtureCode === '1001', r1.fixtureCode);
ok('流水快照实物编号', r1.fixtureSerialNo === 'DH40MC-921-001-001', r1.fixtureSerialNo);
ok('流水快照库位 from/to', r1.fromLocation === 'ZP1-U-1-1' && r1.toLocation === 'ZP1-U-1-1', r1.fromLocation + '->' + r1.toLocation);
ok('重复出库被拒绝（不在库）', throws(() => store.addFixTransaction({ fixtureId: id1, type: 'out', operator: '李四', time: t }), '不在库'));

section('2b. 出库补填库位（建档漏填时必选）');
const idNoLoc = store.addFixture(fix({ code: '4001', serialNo: 'NO-LOC', location: 'ZP1-U-1-9' }));
// 绕过校验直接写空库位，模拟旧数据
const rawList = store.getAll('fixtures');
rawList.find((f) => f.id === idNoLoc).location = '';
ok('无库位时出库被拒绝', throws(() => store.addFixTransaction({ fixtureId: idNoLoc, type: 'out', operator: '李四', time: t }), '尚未设置库位'));
ok('出库时补填库位成功', !throws(() => store.addFixTransaction({ fixtureId: idNoLoc, type: 'out', operator: '李四', time: t, location: 'ZP1-U-1-9' })));
ok('补填后库位已写入', store.getAll('fixtures').find((f) => f.id === idNoLoc).location === 'ZP1-U-1-9');

/* ---------- 3. 回库 ---------- */
section('3. 回库（预填原库位，允许改）');
const txRet1 = store.addFixTransaction({ fixtureId: id1, type: 'return', operator: '王五', time: t + 1000, remark: '归还完好' });
f1 = store.getAll('fixtures').find((f) => f.id === id1);
ok('状态回到 stocked', f1.status === 'stocked', f1.status);
ok('回库次数 +1', f1.totalReturnCount === 1, String(f1.totalReturnCount));
ok('出库次数保持 1', f1.totalOutCount === 1, String(f1.totalOutCount));
ok('未出库时回库被拒绝', throws(() => store.addFixTransaction({ fixtureId: id1, type: 'return', operator: '王五', time: t }), '未处于已出库状态'));

const retRec = store.getAll('fixTransactions').find((x) => x.id === txRet1);
ok('回库流水快照 from/to 库位', retRec.fromLocation === 'ZP1-U-1-1' && retRec.toLocation === 'ZP1-U-1-1');

// 改库位回库：先出库，再以新库位回库
store.addFixTransaction({ fixtureId: id1, type: 'out', operator: '李四', time: t + 2000 });
const txRet2 = store.addFixTransaction({ fixtureId: id1, type: 'return', operator: '王五', time: t + 3000, location: 'ZP1-U-2-5' });
f1 = store.getAll('fixtures').find((f) => f.id === id1);
const ret2Rec = store.getAll('fixTransactions').find((x) => x.id === txRet2);
ok('回库改库位后 location 已更新', f1.location === 'ZP1-U-2-5', f1.location);
ok('流水记录库位变化', ret2Rec.fromLocation === 'ZP1-U-1-1' && ret2Rec.toLocation === 'ZP1-U-2-5', ret2Rec.fromLocation + '->' + ret2Rec.toLocation);
ok('回库非法库位被拒绝', (() => {
  store.addFixTransaction({ fixtureId: id1, type: 'out', operator: '李四', time: t + 4000 });
  return throws(() => store.addFixTransaction({ fixtureId: id1, type: 'return', operator: '王五', time: t + 5000, location: 'BAD' }), '库位号需为 4 段式');
})());

/* ---------- 4. 多轮循环流转 ---------- */
section('4. 重复出库/回库循环（核心需求）');
const before = store.getAll('fixtures').find((f) => f.id === id2).totalOutCount || 0;
for (let i = 1; i <= 5; i++) {
  store.addFixTransaction({ fixtureId: id2, type: 'out', operator: '李四', counterparty: '生产一车间', time: t + i * 10000 });
  store.addFixTransaction({ fixtureId: id2, type: 'return', operator: '王五', time: t + i * 10000 + 5000 });
}
const f2 = store.getAll('fixtures').find((f) => f.id === id2);
ok('5 轮后出库次数=5', f2.totalOutCount === 5, String(f2.totalOutCount));
ok('5 轮后回库次数=5', f2.totalReturnCount === 5, String(f2.totalReturnCount));
ok('最终状态 stocked', f2.status === 'stocked', f2.status);
ok('流水条数=10', store.getAll('fixTransactions').filter((x) => x.fixtureId === id2).length === 10);

section('4b. 出库原因（outReason）与维修次数联动');
const idR1 = store.addFixture(fix({ serialNo: 'OUT-USE-001', name: '出库使用夹具', location: 'ZP1-U-6-1' }));
const idR2 = store.addFixture(fix({ serialNo: 'OUT-REP-001', name: '出库维修夹具', location: 'ZP1-U-6-2' }));
const tReason = Date.now();
const txUse1 = store.addFixTransaction({ fixtureId: idR1, type: 'out', operator: '李四', time: tReason, outReason: 'use' });
store.addFixTransaction({ fixtureId: idR1, type: 'return', operator: '王五', time: tReason + 1000 });
const txRep1 = store.addFixTransaction({ fixtureId: idR2, type: 'out', operator: '李四', time: tReason + 2000, outReason: 'repair' });
store.addFixTransaction({ fixtureId: idR2, type: 'return', operator: '王五', time: tReason + 3000 });
const fR1 = store.getAll('fixtures').find((f) => f.id === idR1);
const fR2 = store.getAll('fixtures').find((f) => f.id === idR2);
ok('使用出库不增加维修次数', fR1.repairCount === 0, String(fR1.repairCount));
ok('维修出库 +1 维修次数', fR2.repairCount === 1, String(fR2.repairCount));
ok('使用出库流水 outReason=use', store.getAll('fixTransactions').find((x) => x.id === txUse1).outReason === 'use');
ok('维修出库流水 outReason=repair', store.getAll('fixTransactions').find((x) => x.id === txRep1).outReason === 'repair');
ok('缺省出库原因按 use 处理', (() => {
  const idDef = store.addFixture(fix({ serialNo: 'OUT-DEF-001', name: '缺省原因夹具', location: 'ZP1-U-6-3' }));
  const txDef = store.addFixTransaction({ fixtureId: idDef, type: 'out', operator: '李四', time: tReason + 5000 });
  const dF = store.getAll('fixtures').find((f) => f.id === idDef);
  const dTx = store.getAll('fixTransactions').find((x) => x.id === txDef);
  return dF.repairCount === 0 && (dTx.outReason === 'use' || dTx.outReason === '');
})());

/* ---------- 5. 维修流程 ---------- */
section('5. 送修与维修完成');
const txRep = store.addFixTransaction({ fixtureId: id2, type: 'repair', operator: '赵六', time: t + 60000, remark: '定位销磨损' });
ok('状态变为 repair', store.getAll('fixtures').find((f) => f.id === id2).status === 'repair');
ok('维修次数 +1', store.getAll('fixtures').find((f) => f.id === id2).repairCount === 1);
ok('维修中不能出库', throws(() => store.addFixTransaction({ fixtureId: id2, type: 'out', operator: '李四', time: t }), '不在库'));
ok('维修中不能回库', throws(() => store.addFixTransaction({ fixtureId: id2, type: 'return', operator: '王五', time: t }), '未处于已出库状态'));
const txDone = store.addFixTransaction({ fixtureId: id2, type: 'repair_done', operator: '赵六', time: t + 65000, remark: '更换定位销' });
ok('维修完成后状态 stocked', store.getAll('fixtures').find((f) => f.id === id2).status === 'stocked');
ok('repair_done 流水修复', store.getAll('fixTransactions').find((x) => x.id === txDone).fromStatus === 'repair');
ok('非维修中执行 repair_done 被拒绝', throws(() => store.addFixTransaction({ fixtureId: id2, type: 'repair_done', operator: 'x', time: t }), '未处于维修中状态'));

/* ---------- 6. 报废 ---------- */
section('6. 报废（-> retired）');
const id3 = store.addFixture(fix({ code: '2003', serialNo: 'OLD-C', name: '老旧夹具C', location: 'ZP1-U-3-1' }));
store.addFixTransaction({ fixtureId: id3, type: 'retire', operator: '管理员', time: t + 80000, remark: '精度超差' });
ok('状态 retired', store.getAll('fixtures').find((f) => f.id === id3).status === 'retired');
ok('报废后不能出库', throws(() => store.addFixTransaction({ fixtureId: id3, type: 'out', operator: '李四', time: t }), '不在库'));

/* ---------- 7. 派生数量（不落库） ---------- */
section('7. 数量为派生值（按 实物编号+库位 分组）');
ok('该编号当前已出库 → 在库派生量为 0', store.stockCountBySerial('DH40MC-921-001-001', 'ZP1-U-2-5') === 0, String(store.stockCountBySerial('DH40MC-921-001-001', 'ZP1-U-2-5')));
store.addFixture(fix({ serialNo: 'SAME-001', name: '同编号A', location: 'ZP1-U-4-1' }));
store.addFixture(fix({ serialNo: 'SAME-001', name: '同编号B', location: 'ZP1-U-4-1' }));
store.addFixture(fix({ serialNo: 'SAME-001', name: '同编号C', location: 'ZP1-U-4-2' }));
ok('同编号同库位计 2 套', store.stockCountBySerial('SAME-001', 'ZP1-U-4-1') === 2);
ok('同编号不同库位分别计 1 套', store.stockCountBySerial('SAME-001', 'ZP1-U-4-2') === 1);
ok('同编号合计 3 套', store.stockCountBySerial('SAME-001') === 3);
const sameA = store.getAll('fixtures').find((f) => f.name === '同编号A');
store.addFixTransaction({ fixtureId: sameA.id, type: 'out', operator: '李四', time: t + 90000 });
ok('出库后同库位派生量自动减 1', store.stockCountBySerial('SAME-001', 'ZP1-U-4-1') === 1);
ok('出库后 location 仍在（供回库预填）', store.getAll('fixtures').find((f) => f.id === sameA.id).location === 'ZP1-U-4-1');

/* ---------- 8. 撤销接口与级联删除 ---------- */
section('8. 撤销接口与级联删除（扁平化代价）');
const idR = store.addFixture(fix({ code: '5001', serialNo: 'REV-1', lines: [lineA, lineB] }));
let fR = store.getAll('fixtures').find((f) => f.id === idR);
ok('双产线落库', fR.lines.length === 2, JSON.stringify(fR.lines));
const afterRmLine = store.removeFixtureLine('5001', lineA);
ok('撤销产线返回剩余条数 1', afterRmLine.lines === 1, JSON.stringify(afterRmLine));
fR = store.getAll('fixtures').find((f) => f.id === idR);
ok('剩余产线为被保留的那条', fR.lines.length === 1 && fR.lines[0] === lineB, JSON.stringify(fR.lines));
ok('按归一化编号也能命中撤销', !throws(() => store.removeFixtureLine('5001', lineB)));
fR = store.getAll('fixtures').find((f) => f.id === idR);
ok('撤销后产线为空数组（不影响记录本身）', fR.lines.length === 0, JSON.stringify(fR.lines));
ok('撤销不存在的夹具报错', throws(() => store.removeFixtureLine('9999', lineB), '夹具不存在'));

// 批量撤销
const idB1 = store.addFixture(fix({ code: '5002', serialNo: 'BAT-1', lines: [lineA] }));
const idB2 = store.addFixture(fix({ code: '5003', serialNo: 'BAT-2', lines: [lineA] }));
ok('批量撤销返回命中数 2', store.removeFixtureLinesByBatch(['5002', '5003'], lineA) === 2);
ok('批量撤销后产线已摘除（1）', store.getAll('fixtures').find((f) => f.id === idB1).lines.length === 0);
ok('批量撤销后产线已摘除（2）', store.getAll('fixtures').find((f) => f.id === idB2).lines.length === 0);

// 级联删除线体
const lineC = store.add('lines', { name: '临时线', type: 'linear' });
const idC = store.addFixture(fix({ code: '5004', serialNo: 'CAS-1', lines: [lineA, lineC] }));
store.delLine(lineC);
const fC = store.getAll('fixtures').find((f) => f.id === idC);
ok('删线体后夹具上的产线被摘除', fC.lines.indexOf(lineC) < 0 && fC.lines.indexOf(lineA) >= 0, JSON.stringify(fC.lines));
ok('删线体不影响其它产线', store.getAll('lines').some((l) => l.id === lineA));

/* ---------- 8b. 删除夹具（纠正录错，连带清理流水） ---------- */
section('8b. 删除夹具（连带清理流水）');
const idDel = store.addFixture(fix({ code: '5006', serialNo: 'DEL-1', lines: [lineA] }));
store.addFixTransaction({ fixtureId: idDel, type: 'out', operator: '李四', time: t + 200000 });
store.addFixTransaction({ fixtureId: idDel, type: 'return', operator: '王五', time: t + 201000 });
const idKeep = store.addFixture(fix({ code: '5007', serialNo: 'KEEP-1', lines: [lineA] }));
store.addFixTransaction({ fixtureId: idKeep, type: 'out', operator: '李四', time: t + 202000 });
const txBeforeDel = store.getAll('fixTransactions').length;
ok('删除前目标夹具流水为 2 条', store.getAll('fixTransactions').filter((x) => x.fixtureId === idDel).length === 2);
store.delFixture(idDel);
ok('夹具已从 fixtures 消失', !store.getAll('fixtures').some((f) => f.id === idDel));
ok('该夹具的流水被连带清除（不留孤儿记录）', store.getAll('fixTransactions').filter((x) => x.fixtureId === idDel).length === 0);
ok('其它夹具的流水不受影响', store.getAll('fixTransactions').some((x) => x.fixtureId === idKeep));
ok('流水总数只减去被删夹具的条数', store.getAll('fixTransactions').length === txBeforeDel - 2, String(store.getAll('fixTransactions').length));
ok('删除不存在的夹具不报错（幂等）', !throws(() => store.delFixture(999999)));

/* ---------- 9. 机种字典 ---------- */
section('9. 机种字典（productions）');
const p1 = store.ensureProduction('DH40MC');
ok('ensureProduction 新建并返回 id', typeof p1 === 'number');
ok('ensureProduction 同名复用', store.ensureProduction('DH40MC') === p1);
ok('机种字典含 order', Number.isFinite(store.getAll('productions').find((p) => p.id === p1).order));
ok('空名不入字典', store.ensureProduction('   ') === null);
const p2 = store.add('productions', { name: 'XXK-D10VG', order: 99 });
ok('被引用的机种禁止删除', throws(() => store.delProduction(p1), '仍被'));
const renamed = store.renameProduction(p1, 'DH40MC-NEW');
ok('重命名写穿所有夹具', renamed >= 1, String(renamed));
ok('夹具 lineModels 已同步新名', store.getAll('fixtures').some((f) => f.lineModels.includes('DH40MC-NEW')));
ok('旧名已无残留', !store.getAll('fixtures').some((f) => f.lineModels.includes('DH40MC')));
ok('重命名冲突被拒绝', throws(() => store.renameProduction(p2, 'DH40MC-NEW'), '同名机种'));
ok('无引用机种可删除', !throws(() => store.delProduction(p2)));

/* ---------- 10. 校验函数 ---------- */
section('10. 校验函数');
['ZP1-U-1-1', 'ZP10-U-12-15', 'a1-b2-c3-d4'].forEach((l) => ok('合法库位 ' + l, store.isValidLocation(l)));
['', 'A1-03', 'ZP1-U-1', 'ZP1U11', 'ZP1-U-1-1-1'].forEach((l) => ok('非法库位 ' + JSON.stringify(l), !store.isValidLocation(l)));
['DH40MC-921-001-001', 'A-1', '12345'].forEach((s) => ok('合法实物编号 ' + s, store.isValidSerialNo(s)));
['', 'A|B', 'X\nY'].forEach((s) => ok('非法实物编号 ' + JSON.stringify(s), !store.isValidSerialNo(s)));
['1001', '0001', '9999'].forEach((c) => ok('合法序号 ' + c, store.isBridgeCode(c)));
['201', '20001', '20A1', '', null].forEach((c) => ok('非法序号 ' + JSON.stringify(c), !store.isBridgeCode(c)));
ok('编号归一化忽略连字符', store.codeEq('SPMS1|1-0-0-1', '1001'));
ok('机种名校验长度上限', store.isValidProductionName('a'.repeat(30)) && !store.isValidProductionName('a'.repeat(31)));

/* ---------- 11. 持久化 ---------- */
section('11. 数据持久化');
const dataFile = path.join(TMP, 'fixture-data.json');
ok('数据文件已生成', fs.existsSync(dataFile));
const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
ok('文件含 fixtures 表', Array.isArray(raw.fixtures) && raw.fixtures.length === store.count('fixtures'));
ok('文件含 fixTransactions 表', Array.isArray(raw.fixTransactions));
ok('文件含 productions 表', Array.isArray(raw.productions));
ok('文件含 meta 表', typeof raw.meta === 'object');
ok('已无 stationFixtures 集合', raw.stationFixtures === undefined);
ok('已无 stations 集合（v5.0.0）', raw.stations === undefined);
ok('夹具不含 stations 字段（v5.0.0）', !raw.fixtures.some((f) => f.stations !== undefined));
ok('已无 products 集合', raw.products === undefined);
ok('夹具不含 qrToken 字段', !raw.fixtures.some((f) => f.qrToken !== undefined));

/* ---------- 12. 重启 ---------- */
section('12. 重启后数据恢复（独立模块实例）');
delete require.cache[require.resolve('./store.js')];
const store2 = require('./store.js');
store2.setDataDir(TMP);
store2.open();
const f1reload = store2.getAll('fixtures').find((f) => f.id === id1);
ok('重启后夹具仍存在', !!f1reload);
ok('重启后出库次数保持 3', f1reload && f1reload.totalOutCount === 3, f1reload ? String(f1reload.totalOutCount) : 'N/A');
ok('重启后流水仍存在', store2.getAll('fixTransactions').length === store.getAll('fixTransactions').length);
ok('重启后编号不冲突', (() => {
  const nid = store2.addFixture(fix({ serialNo: 'RESTART-1', location: 'ZP1-U-5-1' }));
  return store2.getAll('fixtures').filter((f) => f.id === nid).length === 1;
})());

/* ---------- 13. v3.0.x → v4.0.0 迁移 ---------- */
section('13. 旧数据迁移（v3.0.1 → v5.0.0）');
const TMP2 = path.join(os.tmpdir(), 'fixture-migrate-' + Date.now());
fs.mkdirSync(TMP2, { recursive: true });
fs.writeFileSync(path.join(TMP2, 'fixture-data.json'), JSON.stringify({
  fixtures: [
    { id: 1, code: '2001', name: '旧夹具', spec: 'OLD-SPEC', lineNo: 'L9', location: 'A1-01', status: 'stocked', qrToken: 'SPMS1|2001' },
    { id: 2, code: '2002', name: '多机种夹具', lineModels: ['M1', 'M2', 'M3', 'M4', 'M5'], status: 'stocked' }
  ],
  fixTransactions: [],
  lines: [{ id: 10, name: '旧线', type: 'loop' }],
  products: [
    { id: 20, lineId: 10, name: '产品甲', code: 'P-01' },
    { id: 21, lineId: 10, name: '产品甲', code: 'P-01' },
    { id: 22, lineId: 10, name: '产品乙', code: 'P-02' }
  ],
  stations: [{ id: 30, lineId: 10, seq: 10, name: '工位1' }],
  stationFixtures: [{ id: 40, productId: 20, stationId: 30, fixtureCode: '2001' }],
  meta: { k: 'v' }
}, null, 2), 'utf8');
delete require.cache[require.resolve('./store.js')];
const store3 = require('./store.js');
store3.setDataDir(TMP2);
store3.open();
const m1 = store3.getAll('fixtures').find((f) => f.code === '2001');
ok('spec/lineNo 合并进 lineModels', Array.isArray(m1.lineModels) && m1.lineModels.join(',') === 'L9,OLD-SPEC', JSON.stringify(m1.lineModels));
ok('新增 serialNo 字段（空串）', m1.serialNo === '');
ok('新增 lines 数组', Array.isArray(m1.lines) && m1.lines.length === 0);
ok('stations 字段已移除（v5.0.0）', m1.stations === undefined, String(m1.stations));
ok('qrToken 已清理', m1.qrToken === undefined);
const m2 = store3.getAll('fixtures').find((f) => f.code === '2002');
ok('机种上限 4 → 7（原 5 个全部保留）', m2.lineModels.length === 5, JSON.stringify(m2.lineModels));
ok('products 迁移为 productions（按名去重）', store3.getAll('productions').length === 2, JSON.stringify(store3.getAll('productions').map((p) => p.name)));
const prods = store3.getAll('productions');
ok('productions 无 lineId 字段', prods.every((p) => p.lineId === undefined));
ok('productions 无 code 字段', prods.every((p) => p.code === undefined));
ok('productions 带 order', prods.every((p) => Number.isFinite(Number(p.order))));
ok('products 集合已移除', store3.getAll('products').length === 0);
ok('stationFixtures 已移除', store3.getAll('stationFixtures').length === 0);
ok('stations 集合已移除（v5.0.0）', store3.getAll('stations').length === 0);
ok('lines 保留', store3.getAll('lines').length === 1);
ok('迁移后 meta 保留', store3.getMeta('k') === 'v');
const migRaw = JSON.parse(fs.readFileSync(path.join(TMP2, 'fixture-data.json'), 'utf8'));
ok('落盘文件已无 products', migRaw.products === undefined);
ok('落盘文件已无 stationFixtures', migRaw.stationFixtures === undefined);
ok('落盘文件已无 stations 集合', migRaw.stations === undefined);
ok('落盘夹具已无 stations 字段', !migRaw.fixtures.some((f) => f.stations !== undefined));
ok('落盘文件含 productions', Array.isArray(migRaw.productions));
try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch (e) { /* ignore */ }

/* ---------- 导入批次号（v4.4.0：撤销本次导入的落点） ---------- */
section('导入批次号 importBatch');
const idBatch = store.addFixture(fix({ serialNo: 'BATCH-001', name: '带批次夹具', location: 'ZP1-U-3-1', importBatch: 'bTEST-1' }));
const fBatch = store.getAll('fixtures').find((f) => f.id === idBatch);
ok('addFixture 透传未知字段 importBatch', !!fBatch && fBatch.importBatch === 'bTEST-1', fBatch && fBatch.importBatch);
store.updateFixture({ id: idBatch, name: '改过名的批次夹具' });
const fBatch2 = store.getAll('fixtures').find((f) => f.id === idBatch);
ok('编辑夹具不丢 importBatch', !!fBatch2 && fBatch2.importBatch === 'bTEST-1', fBatch2 && fBatch2.importBatch);
ok('可按批次号精确筛出本批记录',
  store.getAll('fixtures').filter((f) => f.importBatch === 'bTEST-1').length === 1,
  store.getAll('fixtures').filter((f) => f.importBatch === 'bTEST-1').length);
store.delFixture(idBatch);
ok('删除后该批次为空（撤销本次导入即可整体回滚）',
  store.getAll('fixtures').filter((f) => f.importBatch === 'bTEST-1').length === 0);

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(50));
console.log('测试汇总：通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(50));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

process.exit(fail > 0 ? 1 : 0);
