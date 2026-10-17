'use strict';
/* ============================================================
 * test_migrate_id.js — 回归测试：旧数据夹具缺失 id 时，migrate() 自动补主键
 * 运行：node test_migrate_id.js   （独立进程，全新模块状态）
 *
 * 背景：早期样本/旧版数据里的夹具记录没有 id 字段，导致
 *   openFixForm(id) 中 state.fixtures.find(x => x.id === id) 全部落空
 *   → 卡片「编辑」被误判为「新建」。store.js migrate() 第 7 步负责补齐。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TMP = path.join(os.tmpdir(), 'fixture-migrate-id-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  ❌ ' + name + (extra ? ' -> ' + extra : '')); }
}

/* 构造一份「缺 id」的旧版数据：夹具无 id，线体/工位有 id，并保留 legacy products 数组 */
const legacy = {
  fixtures: [
    { code: '1001', serialNo: 'A-001', name: '夹具A', lineModels: ['DH40MC'], lines: [1], stations: [2], location: 'ZP1-U-1-1', status: 'stocked', totalOutCount: 0, totalReturnCount: 0, repairCount: 0 },
    { code: '1002', serialNo: 'A-002', name: '夹具B', lineModels: ['DH40MC'], lines: [1], stations: [2], location: 'ZP1-U-1-2', status: 'stocked', totalOutCount: 0, totalReturnCount: 0, repairCount: 0 }
  ],
  lines: [{ id: 1, name: '3 号线', type: 'linear' }],
  stations: [{ id: 2, lineId: 1, name: '1号工位', seq: 10 }],
  products: [{ name: 'DH40MC' }, { name: 'DH50MC' }],
  meta: {}
};
fs.writeFileSync(path.join(TMP, 'fixture-data.json'), JSON.stringify(legacy, null, 2), 'utf8');

const store = require('./store.js');
store.setDataDir(TMP);

console.log('\n【旧数据：夹具缺失 id → migrate 自动补齐】');
const all = store.getAll('fixtures');
ok('夹具总数=2', all.length === 2, 'n=' + all.length);
ok('补全后无缺失 id', all.every((f) => typeof f.id === 'number'));
ok('id 互不相同', new Set(all.map((f) => f.id)).size === all.length);
ok('id 不与线体/工位冲突', all.every((f) => f.id !== 1 && f.id !== 2));
ok('序号保持不变', all.map((f) => f.code).sort().join(',') === '1001,1002');

/* 落盘校验 */
const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'fixture-data.json'), 'utf8'));
ok('落盘后夹具无缺失 id', onDisk.fixtures.every((f) => typeof f.id === 'number'));
ok('落盘后线体 id 完好', onDisk.lines.every((x) => typeof x.id === 'number'));
ok('legacy products 已迁移为 productions', Array.isArray(onDisk.productions) && onDisk.productions.length === 2 && onDisk.products === undefined);

/* 跨进程幂等：用同一目录重新加载，id 应稳定不变且仍无缺失 */
console.log('\n【跨进程幂等性】');
const child = spawnSync(process.execPath, [
  '-e',
  'const fs=require("fs");const store=require(' + JSON.stringify(path.join(__dirname, 'store.js')) + ');' +
  'store.setDataDir(' + JSON.stringify(TMP) + ');' +
  'const a=store.getAll("fixtures").map(f=>f.id).sort((x,y)=>x-y);' +
  'process.stdout.write(JSON.stringify(a));'
], { encoding: 'utf8' });
const secondIds = JSON.parse(child.stdout || '[]');
ok('二次加载成功返回 id 数组', Array.isArray(secondIds) && secondIds.length === 2);
ok('id 跨进程稳定', JSON.stringify(secondIds) === JSON.stringify(all.map((f) => f.id).sort((x, y) => x - y)));

console.log('\n==== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ====');
if (fail) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
