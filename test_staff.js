'use strict';
/* ============================================================
 * test_staff.js — v5.1.0 人员卡库 + 进出库刷卡 + 产线清单打印 测试
 *                 （版本号断言自 v5.2.0 起改为读 package.json，升版不必改本文件）
 *
 * 三段：
 *   A. 数据层（真实 store.js + 临时目录）：卡号归一化 / 唯一性 / 角色校验 /
 *      落库结构 / 残缺数据自愈 / 流水卡号快照
 *   B. 导入解析纯函数（vm 切片 ：app.js）：表头别名 / 角色与状态归一 /
 *      逐行校验 / 导入计划（文件内查重 + 库内查重）
 *   C. 静态守卫（源码扫描）：刷卡框前缀约定、旧字段已清除、打印链路接线、
 *      版本号与集合清单——这几条一旦被改回去就是「刷一下卡直接出库」级别的事故
 *
 * 运行：node test_staff.js
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const store = require(path.join(DIR, 'store.js'));
const appJs = fs.readFileSync(path.join(DIR, 'js/app.js'), 'utf8');
const dbJs = fs.readFileSync(path.join(DIR, 'js/db.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(DIR, 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(DIR, 'preload.js'), 'utf8');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(DIR, 'css/style.css'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, actual) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (actual !== undefined ? ' -> ' + JSON.stringify(actual) : '')); console.log('  ✗ ' + name + (actual !== undefined ? '  → 实际: ' + JSON.stringify(actual) : '')); }
}
function eq(a, b, name) { ok(a === b, name, a); }
function section(t) { console.log('\n【' + t + '】'); }

/* 切片：按标记截取 app.js 的一段（结束标记取目标代码的起始行，不含） */
function slice(startMark, endMark) {
  const s = appJs.indexOf(startMark);
  if (s < 0) throw new Error('切片起点未找到：' + startMark);
  const e = appJs.indexOf(endMark, s);
  if (e < 0) throw new Error('切片终点未找到：' + endMark);
  return appJs.slice(s, e);
}
/* vm 沙箱：window 别名 + 必要桩 */
function loadFns(code, extra) {
  const sandbox = Object.assign({
    window: {},
    console,
    state: { staffs: [] },
    DB: {
      normalizeCardNo: store.normalizeCardNo,
      isValidCardNo: store.isValidCardNo,
      isValidStaffName: store.isValidStaffName,
      isValidStaffRole: store.isValidStaffRole
    },
    esc: (v) => String(v == null ? '' : v),
    natCompare: (a, b) => String(a).localeCompare(String(b), 'zh')
  }, extra || {});
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code + '\n; window.__api = {' +
    'normCard: typeof normCard === "function" ? normCard : null,' +
    'findStaffLocal: typeof findStaffLocal === "function" ? findStaffLocal : null,' +
    'staffHeaderIndex: typeof staffHeaderIndex === "function" ? staffHeaderIndex : null,' +
    'parseStaffRole: typeof parseStaffRole === "function" ? parseStaffRole : null,' +
    'parseStaffActive: typeof parseStaffActive === "function" ? parseStaffActive : null,' +
    'parseStaffRow: typeof parseStaffRow === "function" ? parseStaffRow : null,' +
    'buildStaffImportPlan: typeof buildStaffImportPlan === "function" ? buildStaffImportPlan : null,' +
    'normalizeHeader: typeof normalizeHeader === "function" ? normalizeHeader : null' +
    '};', ctx);
  return { api: sandbox.window.__api, sandbox };
}

/* ============================================================
 * A. 数据层
 * ============================================================ */
section('A. 数据层（store：卡号唯一 / 角色 / 落库 / 流水快照）');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fms-staff-'));
store.setDataDir(tmp);
store.open();

eq(store.COLLECTIONS.length, 5, 'COLLECTIONS 共 5 项');
ok(store.COLLECTIONS.indexOf('staffs') >= 0, 'staffs 已登记进 COLLECTIONS', store.COLLECTIONS);
ok(Array.isArray(store.getAll('staffs')) && store.getAll('staffs').length === 0, '空库 staffs 返回空数组');

eq(store.MAX_CARD_NO, 64, 'MAX_CARD_NO = 64');
eq(store.MAX_STAFF_NAME, 30, 'MAX_STAFF_NAME = 30');
ok(JSON.stringify(store.STAFF_ROLES) === JSON.stringify(['borrower', 'operator', 'both']), 'STAFF_ROLES 三种角色', store.STAFF_ROLES);

/* --- 卡号归一化 --- */
eq(store.normalizeCardNo('a1b2-c3d4'), 'A1B2C3D4', '归一化：小写 + 连字符 → 大写无分隔');
eq(store.normalizeCardNo(' A1B2 C3D4 '), 'A1B2C3D4', '归一化：去空格');
eq(store.normalizeCardNo('A1B2_C3D4'), 'A1B2C3D4', '归一化：去下划线');
eq(store.normalizeCardNo('Ａ１Ｂ２'), 'Ａ１Ｂ２'.toUpperCase(), '归一化：全角字符保留（仅大小写与分隔符归一）');
eq(store.normalizeCardNo(''), '', '归一化：空串');
eq(store.normalizeCardNo(null), '', '归一化：null 安全');

/* --- 卡号校验 --- */
ok(store.isValidCardNo('A1B2C3D4'), '卡号校验：常规 8 位通过');
ok(store.isValidCardNo('1234567890'), '卡号校验：纯数字 10 位通过');
ok(store.isValidCardNo('A1B2-C3D4'), '卡号校验：含连字符通过');
ok(!store.isValidCardNo(''), '卡号校验：空串拒绝');
ok(!store.isValidCardNo('   '), '卡号校验：纯空白拒绝');
ok(!store.isValidCardNo('A|B'), '卡号校验：含竖线拒绝');
ok(!store.isValidCardNo('A,B'), '卡号校验：含逗号拒绝（防破坏 CSV）');
ok(!store.isValidCardNo('x'.repeat(65)), '卡号校验：超 64 字符拒绝');
ok(store.isValidCardNo('x'.repeat(64)), '卡号校验：正好 64 字符通过');
ok(!store.isValidStaffName(''), '姓名校验：空拒绝');
ok(!store.isValidStaffName('张|三'), '姓名校验：含竖线拒绝');
ok(store.isValidStaffName('欧阳光'), '姓名校验：正常通过');
ok(store.isValidStaffRole('both'), '角色校验：both 合法');
ok(!store.isValidStaffRole('boss'), '角色校验：非法值拒绝');

/* --- 新增 --- */
const p1 = store.addStaff({ cardNo: 'a1b2-c3d4', name: '张三', dept: '装配一车间', role: 'borrower', remark: '班组长' });
const p2 = store.addStaff({ cardNo: 'B2C3D4E5', name: '李四', dept: '仓库', role: 'operator' });
ok(typeof p1 === 'number' && p1 > 0, 'addStaff 返回数字 id', p1);
eq(store.getAll('staffs').length, 2, '新增 2 人后数量为 2');

const s1 = store.getAll('staffs').find((x) => x.id === p1);
eq(s1.name, '张三', '姓名正确落库');
eq(s1.cardNo, 'a1b2-c3d4', '卡号按原始输入保存（仅比对时归一化）');
eq(s1.role, 'borrower', '角色保存 borrower');
eq(s1.active, true, '未指定 active 时默认启用');
ok(typeof s1.createdAt === 'number' && typeof s1.updatedAt === 'number', '带 createdAt / updatedAt');

/* --- 卡号唯一（归一化后比对） --- */
let threw = null;
try { store.addStaff({ cardNo: 'A1B2 C3D4', name: '冒充者' }); } catch (e) { threw = e; }
ok(!!threw, '同卡号不同写法（空格）被拒绝');
ok(!!threw && /已登记给「张三」/.test(threw.message), '错误信息指明已登记人', threw && threw.message);

threw = null;
try { store.addStaff({ cardNo: 'a1b2c3d4', name: '冒充者2' }); } catch (e) { threw = e; }
ok(!!threw, '同卡号纯小写也被拒绝');

/* --- 必填 / 取值范围 --- */
threw = null;
try { store.addStaff({ cardNo: '', name: '无卡号' }); } catch (e) { threw = e; }
ok(!!threw && /卡号不能为空/.test(threw.message), '空卡号被拒绝', threw && threw.message);

threw = null;
try { store.addStaff({ cardNo: 'Z9Y8X7', name: '  ' }); } catch (e) { threw = e; }
ok(!!threw && /姓名不能为空/.test(threw.message), '空姓名被拒绝', threw && threw.message);

threw = null;
try { store.addStaff({ cardNo: 'Z9Y8X7', name: '王五', role: 'boss' }); } catch (e) { threw = e; }
ok(!!threw && /角色只能是/.test(threw.message), '非法角色被拒绝', threw && threw.message);

threw = null;
try { store.addStaff({ cardNo: 'Z9Y8X7', name: '王五', dept: '部'.repeat(31) }); } catch (e) { threw = e; }
ok(!!threw && /部门名称最长/.test(threw.message), '部门超 30 字符被拒绝', threw && threw.message);

/* --- 按卡号反查 --- */
eq((store.findStaffByCard('A1B2C3D4') || {}).name, '张三', 'findStaffByCard 归一化命中（大写无分隔）');
eq((store.findStaffByCard('a1b2-c3d4') || {}).name, '张三', 'findStaffByCard 归一化命中（小写带连字符）');
eq(store.findStaffByCard(''), null, 'findStaffByCard 空串返回 null');
eq(store.findStaffByCard('NOT-EXIST'), null, 'findStaffByCard 未登记返回 null');

/* --- 更新 --- */
store.updateStaff({ id: p1, cardNo: 'a1b2-c3d4', name: '张三丰', dept: '装配二车间', role: 'both', active: true });
const s1b = store.getAll('staffs').find((x) => x.id === p1);
eq(s1b.name, '张三丰', '改名生效');
eq(s1b.role, 'both', '改角色生效');
ok(s1b.updatedAt >= s1b.createdAt, 'updatedAt 已刷新');

threw = null;
try { store.updateStaff({ id: p1, cardNo: 'B2C3D4E5', name: '张三丰' }); } catch (e) { threw = e; }
ok(!!threw && /已登记给「李四」/.test(threw.message), '改成别人的卡号被拒绝', threw && threw.message);

/* 自身卡号不变时不应误判重复 */
threw = null;
try { store.updateStaff({ id: p1, cardNo: 'A1B2C3D4', name: '张三丰', role: 'both' }); } catch (e) { threw = e; }
ok(!threw, '更新时保留自己的卡号（仅改写法）不报重复', threw && threw.message);

threw = null;
try { store.updateStaff({ id: 99999, cardNo: 'QQ11WW22', name: '幽灵' }); } catch (e) { threw = e; }
ok(!!threw && /人员不存在/.test(threw.message), '更新不存在的人员报错', threw && threw.message);

/* --- 停用 --- */
store.updateStaff({ id: p2, cardNo: 'B2C3D4E5', name: '李四', dept: '仓库', role: 'operator', active: false });
eq(store.findStaffByCard('B2C3D4E5').active, false, '停用状态落库');

/* --- 通用通道也必须走校验（防绕过） --- */
threw = null;
try { store.add('staffs', { cardNo: 'B2C3D4E5', name: '绕过者' }); } catch (e) { threw = e; }
ok(!!threw, '通用 add("staffs") 同样拦截重复卡号');
threw = null;
try { store.put('staffs', { id: p1, cardNo: 'B2C3D4E5', name: '绕过者' }); } catch (e) { threw = e; }
ok(!!threw, '通用 put("staffs") 同样拦截重复卡号');

/* --- 落盘 --- */
const dbFile = path.join(tmp, 'fixture-data.json');
const disk = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
ok(Array.isArray(disk.staffs), '落盘含 staffs 数组', Object.keys(disk));
eq(disk.staffs.length, 2, '落盘 2 条人员');
ok(disk.staffs.every((x) => typeof x.cardNo === 'string' && typeof x.name === 'string'), '落盘字段类型正确');

/* --- 残缺数据自愈 --- */
disk.staffs.push({ id: 9001, cardNo: 'LEGACY01', name: '老数据' });   // 缺 dept/role/active/remark
fs.writeFileSync(dbFile, JSON.stringify(disk, null, 2), 'utf8');
/* store 是单例（loaded 后 open() 不再重读文件）⇒ 必须清 require 缓存拿新实例 */
delete require.cache[require.resolve(path.join(DIR, 'store.js'))];
const storeR = require(path.join(DIR, 'store.js'));
storeR.setDataDir(tmp);
storeR.open();
const healed = storeR.getAll('staffs').find((x) => x.id === 9001);
ok(!!healed && healed.role === 'both' && healed.active === true && healed.dept === '', '残缺人员记录在 migrate 中补齐默认值', healed);

/* --- 流水卡号快照 --- */
const fixId = storeR.addFixture({ code: '1001', serialNo: 'SN-STAFF-001', name: '刷卡测试夹具', lineModels: ['M1'], lines: [1], location: 'ZP1-U-1-1', category: '金属' });
const txId = storeR.addFixTransaction({
  fixtureId: fixId, type: 'out', operator: '张三丰', counterparty: '李四',
  operatorCard: 'A1B2C3D4', partyCard: 'B2C3D4E5', time: Date.now(), outReason: 'use'
});
const tx = storeR.getAll('fixTransactions').find((x) => x.id === txId);
eq(tx.operator, '张三丰', '流水 operator = 经办人姓名');
eq(tx.counterparty, '李四', '流水 counterparty = 领用人姓名');
eq(tx.operatorCard, 'A1B2C3D4', '流水 operatorCard = 经办人卡号');
eq(tx.partyCard, 'B2C3D4E5', '流水 partyCard = 领用人卡号');

/* 删人不影响历史流水 */
storeR.delStaff(p1);
const txAfter = storeR.getAll('fixTransactions').find((x) => x.id === txId);
eq(txAfter.operator, '张三丰', '删除人员后流水姓名仍在');
eq(txAfter.operatorCard, 'A1B2C3D4', '删除人员后流水卡号仍在');
eq(storeR.getAll('staffs').length, 2, '删除后剩 2 人（李四 + 老数据）', storeR.getAll('staffs').length);

/* 无卡号的老调用仍可写流水（送修/报废不刷卡） */
const fix2 = storeR.addFixture({ code: '1002', serialNo: 'SN-STAFF-002', name: '无卡流水', lineModels: [], lines: [1], location: 'ZP1-U-1-2' });
const tx2Id = storeR.addFixTransaction({ fixtureId: fix2, type: 'repair', operator: '张三丰', time: Date.now() });
const tx2 = storeR.getAll('fixTransactions').find((x) => x.id === tx2Id);
eq(tx2.operatorCard, '', '未传卡号时流水写空串（不报错）');

fs.rmSync(tmp, { recursive: true, force: true });

/* ============================================================
 * B. 导入解析纯函数（vm 切片）
 * ============================================================ */
section('B. 导入解析（表头别名 / 角色状态归一 / 逐行校验 / 导入计划）');

const constAndHelpers = slice('  const STAFF_ROLE_LABEL = {', '  function staffFiltered() {');
ok(constAndHelpers.indexOf('STAFF_IMPORT_ALIAS') > 0, '切片含 STAFF_IMPORT_ALIAS');
ok(constAndHelpers.indexOf('function normCard') > 0, '切片含 normCard');
ok(constAndHelpers.indexOf('function findStaffLocal') > 0, '切片含 findStaffLocal');

const parseFns = slice('  function staffHeaderIndex(headerRow) {', '  let staffImportPlan = [];');
ok(parseFns.indexOf('function buildStaffImportPlan') > 0, '切片含 buildStaffImportPlan');

const headerFn = slice('  function normalizeHeader(h) {', '  // 把二维数组的首行解析成');

const loader = loadFns(constAndHelpers + '\n' + parseFns + '\n' + headerFn);
const fns = loader.api;

ok(typeof fns.normCard === 'function', 'normCard 可调用');
ok(typeof fns.staffHeaderIndex === 'function', 'staffHeaderIndex 可调用');
ok(typeof fns.parseStaffRole === 'function', 'parseStaffRole 可调用');
ok(typeof fns.buildStaffImportPlan === 'function', 'buildStaffImportPlan 可调用');

/* --- normCard 与 store 同口径 --- */
eq(fns.normCard('a1-b2_c3 d4'), store.normalizeCardNo('a1-b2_c3 d4'), 'normCard 与 store.normalizeCardNo 结果一致');

/* --- 表头别名 + 乱序 --- */
const hIdx = fns.staffHeaderIndex(['姓名', '工号', '部门', '角色', '状态', '备注']);
eq(hIdx.name, 0, '别名「姓名」→ name');
eq(hIdx.cardNo, 1, '别名「工号」→ cardNo');
eq(hIdx.dept, 2, '「部门」→ dept');
eq(hIdx.role, 3, '「角色」→ role');
eq(hIdx.active, 4, '「状态」→ active');
eq(hIdx.remark, 5, '「备注」→ remark');

const hIdx2 = fns.staffHeaderIndex(['卡号(必填)', '姓名*', '所属部门', '权限']);
eq(hIdx2.cardNo, 0, '表头括号/星号被剥离后仍识别卡号');
eq(hIdx2.name, 1, '表头星号被剥离后仍识别姓名');
eq(hIdx2.dept, 2, '别名「所属部门」→ dept');
eq(hIdx2.role, 3, '别名「权限」→ role');

/* --- 角色归一 --- */
eq(fns.parseStaffRole('领用人'), 'borrower', '角色「领用人」→ borrower');
eq(fns.parseStaffRole('经办人'), 'operator', '角色「经办人」→ operator');
eq(fns.parseStaffRole('两者皆可'), 'both', '角色「两者皆可」→ both');
eq(fns.parseStaffRole(''), 'both', '角色为空默认 both');
eq(fns.parseStaffRole('仓管'), 'operator', '角色「仓管」→ operator');
eq(fns.parseStaffRole('乱填的'), '', '无法识别的角色返回空串（该行跳过）');

/* --- 状态归一 --- */
eq(fns.parseStaffActive('启用'), true, '状态「启用」→ true');
eq(fns.parseStaffActive('停用'), false, '状态「停用」→ false');
eq(fns.parseStaffActive(''), true, '状态为空默认启用');
eq(fns.parseStaffActive('否'), false, '状态「否」→ false');
eq(fns.parseStaffActive('离职'), false, '状态「离职」→ false');

/* --- 逐行校验 --- */
const idxStd = fns.staffHeaderIndex(['卡号', '姓名', '部门', '角色', '状态', '备注']);
let r = fns.parseStaffRow(['A1B2C3D4', '张三', '装配一车间', '两者皆可', '启用', '班长'], idxStd);
ok(r.ok === true, '合法行解析成功', r);
eq(r.staff.cardNo, 'A1B2C3D4', '行解析：卡号');
eq(r.staff.name, '张三', '行解析：姓名');
eq(r.staff.dept, '装配一车间', '行解析：部门');
eq(r.staff.role, 'both', '行解析：角色');
eq(r.staff.active, true, '行解析：状态');

r = fns.parseStaffRow(['', '张三'], idxStd);
ok(r.ok === false && /卡号为空/.test(r.reason), '缺卡号 → 跳过并说明', r);

r = fns.parseStaffRow(['A1B2C3D4', ''], idxStd);
ok(r.ok === false && /姓名为空/.test(r.reason), '缺姓名 → 跳过并说明', r);

r = fns.parseStaffRow(['A1|B2', '张三'], idxStd);
ok(r.ok === false && /竖线/.test(r.reason), '卡号含竖线 → 跳过并说明', r);

r = fns.parseStaffRow(['A1B2C3D4', '张三', '', '外星人'], idxStd);
ok(r.ok === false && /角色无法识别/.test(r.reason), '角色乱填 → 跳过并说明', r);

/* --- 导入计划 --- */
loader.sandbox.state.staffs = [{ id: 1, cardNo: 'EXIST001', name: '库内已有', role: 'both', active: true }];
const rows = [
  ['卡号', '姓名', '部门', '角色', '状态', '备注'],
  ['A1B2C3D4', '张三', '装配一车间', '两者皆可', '启用', ''],
  ['a1b2-c3d4', '张三(重复行)', '', '领用人', '', ''],       // 文件内重复（归一化后同号）
  ['EXIST001', '库里的人', '', '经办人', '', ''],              // 库内已存在
  ['', '无卡号', '', '', '', ''],                              // 缺卡号
  ['B2C3D4E5', '李四', '仓库', '经办人', '停用', '']
];
const plan = fns.buildStaffImportPlan(rows);
ok(plan.ok === true, '导入计划生成成功', plan);
eq(plan.plan.length, 2, '可导入 2 行（张三 / 李四）', plan.plan.length);
eq(plan.skipped.length, 3, '跳过 3 行', plan.skipped.length);
ok(plan.skipped.some((x) => /卡号重复/.test(x.reason)), '文件内同号被识别为重复', plan.skipped);
ok(plan.skipped.some((x) => /已登记给「库内已有」/.test(x.reason)), '库内已存在被跳过', plan.skipped);
ok(plan.skipped.some((x) => /卡号为空/.test(x.reason)), '缺卡号被跳过', plan.skipped);
eq(plan.plan[1].staff.active, false, '李四按「停用」导入');

/* 表头缺列 */
let bad = fns.buildStaffImportPlan([['姓名', '部门'], ['张三', '车间']]);
ok(bad.ok === false && /缺少「卡号」列/.test(bad.error), '缺卡号列 → 整表拒绝', bad.error);

bad = fns.buildStaffImportPlan([['卡号', '部门'], ['A1', '车间']]);
ok(bad.ok === false && /缺少「姓名」列/.test(bad.error), '缺姓名列 → 整表拒绝', bad.error);

bad = fns.buildStaffImportPlan([['甲', '乙'], ['1', '2']]);
ok(bad.ok === false && /没找到/.test(bad.error), '完全认不出表头 → 提示核对模板', bad.error);

bad = fns.buildStaffImportPlan([]);
ok(bad.ok === false, '空文件被拒绝', bad.error);

/* 空行忽略 */
const withBlank = fns.buildStaffImportPlan([
  ['卡号', '姓名'],
  ['A1B2C3D4', '张三'],
  ['', ''],
  [' ', '  '],
  ['B2C3D4E5', '李四']
]);
eq(withBlank.plan.length, 2, '全空行被忽略，不影响其它行', withBlank.plan.length);
eq(withBlank.skipped.length, 0, '空行不计入跳过明细', withBlank.skipped.length);

/* ============================================================
 * C. 静态守卫
 * ============================================================ */
section('C. 静态守卫（刷卡前缀 / 旧字段清除 / 打印接线 / 版本）');

/* --- 刷卡组件存在 --- */
['swipeFieldHtml', 'bindSwipe', 'resolveSwipe', 'validateSwipePair'].forEach((fn) => {
  ok(appJs.indexOf('function ' + fn) >= 0, 'app.js 定义 ' + fn);
});
['printLineQueryList', 'lineQueryRows'].forEach((fn) => {
  ok(appJs.indexOf('function ' + fn) >= 0 || appJs.indexOf('window.' + fn + ' = function') >= 0, 'app.js 定义 ' + fn);
});

/* --- 三处刷卡位都接上了 --- */
ok(/swipeFieldHtml\('out', 'party'\)/.test(appJs), '出库页有领用人刷卡位');
ok(/swipeFieldHtml\('out', 'operator'\)/.test(appJs), '出库页有经办人刷卡位');
ok(/swipeFieldHtml\('ret', 'party'\)/.test(appJs), '回库页有退库人刷卡位');
ok(/swipeFieldHtml\('ret', 'operator'\)/.test(appJs), '回库页有经办人刷卡位');
ok(/swipeFieldHtml\('dlg', 'party'\)/.test(appJs), '单件出库弹窗有领用人刷卡位');
ok(/swipeFieldHtml\('dlg', 'operator'\)/.test(appJs), '单件出库弹窗有经办人刷卡位');
ok(/swipeFieldHtml\('rdlg', 'party'\)/.test(appJs), '单件回库弹窗有退库人刷卡位');
ok(/swipeFieldHtml\('rdlg', 'operator'\)/.test(appJs), '单件回库弹窗有经办人刷卡位');
ok(/bindSwipe\('out', 'party'\)/.test(appJs) && /bindSwipe\('out', 'operator'\)/.test(appJs), '出库页刷卡位已绑定');
ok(/bindSwipe\('ret', 'party'\)/.test(appJs) && /bindSwipe\('ret', 'operator'\)/.test(appJs), '回库页刷卡位已绑定');
ok(/bindSwipe\('dlg', 'party'\)/.test(appJs) && /bindSwipe\('dlg', 'operator'\)/.test(appJs), '出库弹窗刷卡位已绑定');
ok(/bindSwipe\('rdlg', 'party'\)/.test(appJs) && /bindSwipe\('rdlg', 'operator'\)/.test(appJs), '回库弹窗刷卡位已绑定');

/* --- 旧的手填字段必须彻底消失（否则会绕过刷卡校验） --- */
const legacyIds = ['out_party', 'out_operator', 'return_party', 'return_operator', 'fix_out_op', 'fix_out_party', 'fix_return_op'];
legacyIds.forEach((id) => {
  ok(appJs.indexOf('id="' + id + '"') < 0 && appJs.indexOf('#' + id + "'") < 0 && appJs.indexOf('#' + id + '"') < 0,
    '旧手填字段 #' + id + ' 已彻底移除');
});

/* --- 刷卡框前缀与回车保护 --- */
const swipeIds = (appJs.match(/'#swipe_(out|ret|dlg)_(party|operator)'/g) || []).length;
ok(swipeIds >= 6, '三个上下文共 6 个 swipe_ 前缀的刷卡框定义', swipeIds);
ok(appJs.indexOf('data-swipe=') >= 0, '刷卡框带 data-swipe 标记');
ok(/dataset\.swipe\)\s*return/.test(appJs), 'handleKeyDown 里对 data-swipe 做了回车拦截（防刷卡直接出库）');
ok(/stopPropagation\(\)/.test(appJs), 'bindSwipe 里 stopPropagation 阻断冒泡');

/* --- 提交时必须走成对校验 --- */
ok(/const v = validateSwipePair\('out'\)/.test(appJs), 'submitOutDo 调用 validateSwipePair("out")');
ok(/const v = validateSwipePair\('ret'\)/.test(appJs), 'submitReturnDo 调用 validateSwipePair("ret")');
ok(/const v = validateSwipePair\('dlg'\)/.test(appJs), 'submitFixtureOut 调用 validateSwipePair("dlg")');
ok(/const v = validateSwipePair\('rdlg'\)/.test(appJs), 'submitFixtureReturn 调用 validateSwipePair("rdlg")');
ok(appJs.indexOf('不能是同一个人（同一张卡）') >= 0, '有「两人不得同卡」的校验文案');
ok(appJs.indexOf('operatorCard') >= 0 && appJs.indexOf('partyCard') >= 0, '流水写入卡号快照字段');
eq((appJs.match(/operatorCard, partyCard/g) || []).length, 4, '四处提交都带 operatorCard/partyCard', (appJs.match(/operatorCard, partyCard/g) || []).length);

/* --- 人员卡库页面 --- */
ok(appJs.indexOf('staff: renderStaff') >= 0, 'RENDERERS 注册了 staff 视图');
ok(html.indexOf('data-view="staff"') >= 0, '侧边栏有「人员卡库」导航');
ok(appJs.indexOf("staff: '人员卡库'") >= 0, 'VIEW_TITLES 有人员卡库标题');
['staffForm', 'submitStaffForm', 'staffDelConfirm', 'staffImport', 'downloadStaffTemplate', 'exportStaffCsv'].forEach((fn) => {
  ok(appJs.indexOf('window.' + fn + ' = ') >= 0, '挂载全局函数 ' + fn);
});
ok(appJs.indexOf('STAFF_IMPORT_HEADERS') >= 0, '有导入/导出共用列定义');

/* --- 人员卡库属主数据，清空数据不应清掉 --- */
const clearBlock = appJs.slice(appJs.indexOf('window.submitClearAllData = async function'), appJs.indexOf('window.submitClearAllData = async function') + 700);
ok(clearBlock.indexOf("'staffs'") < 0, '清空数据不清人员卡库（主数据保留）');

/* --- 打印链路 --- */
ok(html.indexOf('id="printListArea"') >= 0, 'index.html 有清单打印容器 #printListArea');
ok(/class="print-sheet"/.test(html), '清单容器使用 .print-sheet 类');
ok(css.indexOf('.print-sheet') >= 0, 'CSS 有 .print-sheet 样式');
ok(/body > \*:not\(\.print-area\):not\(\.print-sheet\)/.test(css), '@media print 同时放行标签与清单两个容器');
ok(appJs.indexOf("pageSize: 'A4'") >= 0 && appJs.indexOf('landscape: true') >= 0, '清单按 A4 横向打印');
ok(/btn sm" onclick="printLineQueryList\(\)/.test(appJs), '产线使用页有「打印清单」按钮');
ok(appJs.indexOf('与标签打印互斥') >= 0 || appJs.indexOf('与「产线清单」打印互斥') >= 0, '标签打印与清单打印互斥清场');
/* 打印与屏幕共用同一份计算：renderLineQueryBody 与 printLineQueryList 都必须调用 lineQueryRows */
const bodyStart = appJs.indexOf('function renderLineQueryBody()');
const printStart = appJs.indexOf('window.printLineQueryList = function');
ok(bodyStart > 0 && appJs.slice(bodyStart, printStart).indexOf('lineQueryRows()') >= 0, '屏幕渲染使用 lineQueryRows()');
ok(printStart > 0 && appJs.slice(printStart, printStart + 1500).indexOf('lineQueryRows()') >= 0, '打印使用 lineQueryRows()');

/* --- 关于面板鸣谢区（v5.3.0） --- */
ok(appJs.indexOf('const THANKS_NAMES = [') >= 0, '鸣谢名单集中在 THANKS_NAMES 常量（改名单只改这一处）');
ok(/鸣谢/.test(appJs), '关于面板有「鸣谢」标题');
ok(appJs.indexOf('感谢以下同事提供的宝贵意见') >= 0, '鸣谢区有致谢说明文案');
ok(appJs.indexOf("class=\"about-thanks\"") >= 0, '鸣谢区使用 .about-thanks 样式类');
ok(/\.about-thanks\s*\{/.test(css), 'CSS 提供 .about-thanks 样式');
['薛添才', '朱近', '林长平', '林捷', '林详杰', '陈旭'].forEach((n) => {
  ok(appJs.indexOf("'" + n + "'") >= 0, '鸣谢名单含 ' + n);
});
/* 名单必须在滚动区外，滚到底也能看到 */
const aboutStart = appJs.indexOf('window.openAbout = function');
const aboutEnd = appJs.indexOf('window.showAbout = window.openAbout');
const aboutSrc = appJs.slice(aboutStart, aboutEnd);
ok(aboutStart > 0 && aboutEnd > aboutStart, '能定位 openAbout 函数体');
ok(aboutSrc.indexOf('about-thanks') > aboutSrc.indexOf('about-scroll'), '鸣谢区排在变更日记滚动区之后（滚动到底仍可见）');
ok(aboutSrc.indexOf('THANKS_NAMES.join') >= 0, '鸣谢名单由常量 join 生成，不另写一份');

/* --- 主进程 / 桥接 --- */
ok(mainJs.indexOf("'staff-add'") >= 0, 'main.js 有 staff-add 通道');
ok(mainJs.indexOf("'staff-update'") >= 0, 'main.js 有 staff-update 通道');
ok(mainJs.indexOf("'staff-del'") >= 0, 'main.js 有 staff-del 通道');
ok(/landscape: !!o\.landscape/.test(mainJs), 'print-labels 支持 landscape 参数');
ok(preloadJs.indexOf('staffAdd:') >= 0 && preloadJs.indexOf('staffUpdate:') >= 0 && preloadJs.indexOf('staffDel:') >= 0,
  'preload 暴露 staffAdd / staffUpdate / staffDel');

/* --- db.js 两侧后端都实现 --- */
ok(dbJs.indexOf('staffAdd, staffUpdate, staffDel, findStaffByCard') >= 0, 'db.js 浏览器分支导出人员方法');
ok(dbJs.indexOf("staffAdd: (staff) => invoke('staff-add', staff)") >= 0, 'db.js Electron 分支走 IPC');

/* --- 版本号（以 package.json 为准，避免每次升版都要改测试） --- */
const VER = pkg.version;
ok(/^\d+\.\d+\.\d+$/.test(VER), 'package.json 版本为三段式语义化', VER);
ok(dbJs.indexOf("APP_VERSION = '" + VER + "'") >= 0, 'db.js APP_VERSION = ' + VER);
ok(preloadJs.indexOf("version: '" + VER + "'") >= 0, 'preload version = ' + VER);
ok(html.indexOf('v' + VER) >= 0, '页脚版本 = v' + VER);
ok(mainJs.indexOf('v' + VER) >= 0, 'main.js 版本标记 = v' + VER);
ok(pkg.build.win.artifactName.indexOf('v' + VER) >= 0, 'artifactName 含 v' + VER, pkg.build.win.artifactName);
ok(appJs.indexOf("version: '" + VER + "'") >= 0, '关于面板 CHANGELOG 置顶 v' + VER);

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('\n' + '='.repeat(50));
console.log('测试汇总：通过 ' + pass + ' / 失败 ' + fail);
if (fail) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(50));
process.exit(fail ? 1 : 0);
