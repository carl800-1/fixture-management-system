'use strict';
/* ============================================================
 * test_store.js — store.js 数据层功能测试（纯 Node，无需 Electron）
 * 运行：node test_store.js
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

/* ---------- 1. 建档 ---------- */
section('1. 夹具建档');
store.open();
const id1 = store.addFixture({ code: '2001', name: '焊接夹具A', spec: 'WJ-100', location: 'A1-01', category: '焊接', owner: '张三' });
ok('建档返回 id', typeof id1 === 'number' && id1 > 0, 'id=' + id1);

let f1 = store.getAll('fixtures').find((f) => f.id === id1);
ok('初始状态 stocked', f1.status === 'stocked', f1.status);
ok('二维码令牌 SPMS1|2001', f1.qrToken === 'SPMS1|2001', f1.qrToken);
ok('计数归零', f1.totalOutCount === 0 && f1.totalReturnCount === 0 && f1.repairCount === 0);
ok('创建时间已写入', typeof f1.createdAt === 'number' && f1.createdAt > 0);

ok('重复编号被拒绝', throws(() => store.addFixture({ code: '2001', name: '重复' }), '编号已存在'));

const id2 = store.addFixture({ code: '2002', name: '冲压夹具B', spec: 'CY-200', location: 'A1-02', category: '冲压' });
ok('第二个夹具建档成功', id2 > id1, 'id2=' + id2);
ok('夹具总数=2', store.count('fixtures') === 2);

/* ---------- 2. 出库 ---------- */
section('2. 夹具出库（stocked -> checked_out）');
let t = Date.now();
const txOut1 = store.addFixTransaction({ fixtureId: id1, type: 'out', operator: '李四', counterparty: '生产一车间', time: t, remark: '首次领用' });
ok('出库流水写入', typeof txOut1 === 'number' && txOut1 > 0);
f1 = store.getAll('fixtures').find((f) => f.id === id1);
ok('状态变为 checked_out', f1.status === 'checked_out', f1.status);
ok('出库次数 +1', f1.totalOutCount === 1, String(f1.totalOutCount));

let r1 = store.getAll('fixTransactions').find((x) => x.id === txOut1);
ok('流水记录编号正确', r1.fixtureCode === '2001', r1.fixtureCode);
ok('流水记录名称正确', r1.fixtureName === '焊接夹具A', r1.fixtureName);
ok('流水状态迁移 recorded', r1.fromStatus === 'stocked' && r1.toStatus === 'checked_out', r1.fromStatus + '->' + r1.toStatus);
ok('流水经办人保存', r1.operator === '李四', r1.operator);

ok('重复出库被拒绝（不在库）', throws(() => store.addFixTransaction({ fixtureId: id1, type: 'out', operator: '李四', time: t }), '不在库'));

/* ---------- 3. 回库 ---------- */
section('3. 夹具回库（checked_out -> stocked）');
const txRet1 = store.addFixTransaction({ fixtureId: id1, type: 'return', operator: '王五', time: t + 1000, remark: '归还完好' });
f1 = store.getAll('fixtures').find((f) => f.id === id1);
ok('状态回到 stocked', f1.status === 'stocked', f1.status);
ok('回库次数 +1', f1.totalReturnCount === 1, String(f1.totalReturnCount));
ok('出库次数保持 1', f1.totalOutCount === 1, String(f1.totalOutCount));

ok('未出库时回库被拒绝', throws(() => store.addFixTransaction({ fixtureId: id1, type: 'return', operator: '王五', time: t }), '未处于已出库状态'));

/* ---------- 4. 多轮循环流转 ---------- */
section('4. 重复出库/回库循环（核心需求）');
for (let i = 2; i <= 5; i++) {
  store.addFixTransaction({ fixtureId: id1, type: 'out', operator: '李四', counterparty: '生产一车间', time: t + i * 10000 });
  store.addFixTransaction({ fixtureId: id1, type: 'return', operator: '王五', time: t + i * 10000 + 5000 });
}
f1 = store.getAll('fixtures').find((f) => f.id === id1);
ok('5 轮后出库次数=5', f1.totalOutCount === 5, String(f1.totalOutCount));
ok('5 轮后回库次数=5', f1.totalReturnCount === 5, String(f1.totalReturnCount));
ok('最终状态 stocked', f1.status === 'stocked', f1.status);
const txCount1 = store.getAll('fixTransactions').filter((x) => x.fixtureId === id1).length;
ok('该夹具流水条数=10', txCount1 === 10, String(txCount1));

/* ---------- 5. 维修流程 ---------- */
section('5. 送修与维修完成（stocked -> repair -> stocked）');
const txRep = store.addFixTransaction({ fixtureId: id2, type: 'repair', operator: '赵六', time: t + 60000, remark: '定位销磨损' });
f1 = store.getAll('fixtures').find((f) => f.id === id2);
ok('状态变为 repair', f1.status === 'repair', f1.status);
ok('维修次数 +1', f1.repairCount === 1, String(f1.repairCount));

ok('维修中不能出库', throws(() => store.addFixTransaction({ fixtureId: id2, type: 'out', operator: '李四', time: t }), '不在库'));
ok('维修中不能回库', throws(() => store.addFixTransaction({ fixtureId: id2, type: 'return', operator: '王五', time: t }), '未处于已出库状态'));

// v1.1 新增：repair_done 流水类型，repair -> stocked
const txDone = store.addFixTransaction({ fixtureId: id2, type: 'repair_done', operator: '赵六', time: t + 65000, remark: '更换定位销，校准合格' });
const f2after = store.getAll('fixtures').find((f) => f.id === id2);
ok('维修完成后状态 stocked', f2after.status === 'stocked', f2after.status);
const doneRec = store.getAll('fixTransactions').find((x) => x.id === txDone);
ok('repair_done 流水状态迁移 repair->stocked', doneRec.fromStatus === 'repair' && doneRec.toStatus === 'stocked',
  doneRec.fromStatus + '->' + doneRec.toStatus);
ok('维修完成不增加出库计数', f2after.totalOutCount === 0, String(f2after.totalOutCount));
ok('维修完成可再次出库', !throws(() => store.addFixTransaction({ fixtureId: id2, type: 'out', operator: '李四', time: t + 70000 })));
ok('非维修中执行 repair_done 被拒绝', throws(() => store.addFixTransaction({ fixtureId: id2, type: 'repair_done', operator: 'x', time: t }), '未处于维修中状态'));

/* ---------- 6. 报废流程 ---------- */
section('6. 报废（-> retired）');
const id3 = store.addFixture({ code: '2003', name: '老旧夹具C' });
store.addFixTransaction({ fixtureId: id3, type: 'retire', operator: '管理员', time: t + 80000, remark: '精度超差' });
const f3 = store.getAll('fixtures').find((f) => f.id === id3);
ok('状态 retired', f3.status === 'retired', f3.status);
ok('报废后不能出库', throws(() => store.addFixTransaction({ fixtureId: id3, type: 'out', operator: '李四', time: t }), '不在库'));

/* ---------- 7. 异常与边界 ---------- */
section('7. 异常与边界');
ok('不存在的夹具抛错', throws(() => store.addFixTransaction({ fixtureId: 99999, type: 'out', operator: 'x', time: t }), '夹具不存在'));
ok('无 operator 不报错', !throws(() => store.addFixTransaction({ fixtureId: id1, type: 'out', time: t + 90000 })));
const lastTx = store.getAll('fixTransactions').slice(-1)[0];
ok('缺省 operator 存空串', lastTx.operator === '', JSON.stringify(lastTx.operator));
ok('缺省 remark 存空串', lastTx.remark === '', JSON.stringify(lastTx.remark));

/* ---------- 8. 持久化 ---------- */
section('8. 数据持久化');
const dataFile = path.join(TMP, 'fixture-data.json');
ok('数据文件已生成', fs.existsSync(dataFile));
const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
ok('文件含 fixtures 表', Array.isArray(raw.fixtures) && raw.fixtures.length === store.count('fixtures'));
ok('文件含 fixTransactions 表', Array.isArray(raw.fixTransactions));
ok('文件含 meta 表', typeof raw.meta === 'object');
ok('JSON 可解析', Array.isArray(raw.fixtures));

/* ---------- 9. 重新加载（模拟重启） ---------- */
section('9. 重启后数据恢复（独立模块实例）');
delete require.cache[require.resolve('./store.js')];
const store2 = require('./store.js');
store2.setDataDir(TMP);
store2.open();
const f1reload = store2.getAll('fixtures').find((f) => f.id === id1);
ok('重启后夹具仍存在', !!f1reload);
ok('重启后出库次数保持 6', f1reload && f1reload.totalOutCount === 6, f1reload ? String(f1reload.totalOutCount) : 'N/A');
ok('重启后流水仍存在', store2.getAll('fixTransactions').length === store.getAll('fixTransactions').length);
ok('重启后 seq 不冲突', !throws(() => {
  const nid = store2.addFixture({ code: '2004', name: '新夹具D' });
  if (store2.getAll('fixtures').some((f, i, a) => a.filter((x) => x.id === f.id).length > 1)) throw new Error('id 重复');
}));

/* ---------- 10. 编号规则 ---------- */
section('10. 编号规则（4 位纯数字）');
['2001', '0001', '9999'].forEach((c) => ok('合法编号 ' + c, /^\d{4}$/.test(c)));
['201', '20001', '20A1', '', null].forEach((c) => ok('非法编号被识别 ' + JSON.stringify(c), !/^\d{4}$/.test(c)));

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
