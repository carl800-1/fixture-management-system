'use strict';
/* ============================================================
 * test_swipe.js — v5.9.1 领用人/退库人「选择后提交报未登记」回归测试
 *
 * 缺陷背景（BUG）：
 *   v5.9.0 把领用人改成 <input> + <datalist> 后，resolveSwipe() 成功时会把输入框
 *   的值改写成「卡号 | 姓名 - 部门」的展示串。提交出库时 validateSwipe() 再解析
 *   一次，把展示串当卡号去查人员卡库 → 查不到 → 误报「领用人未登记」。
 *
 * 本文件锁死四件事：
 *   1. 解析后输入框里只允许是纯卡号（等于 datalist 的 option value）；
 *   2. 同一次录入反复解析（change → 提交校验）结果一致（幂等）；
 *   3. 历史遗留的展示串仍能被正确解析（老窗口 / 老数据不至于卡死）；
 *   4. 姓名匹配只认唯一命中，同名多人 / 部门名一律不猜（防出错人）。
 *
 * 运行：node test_swipe.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const store = require(path.join(DIR, 'store.js'));
const appJs = fs.readFileSync(path.join(DIR, 'js/app.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, actual) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name); console.log('  ✗ ' + name + (actual !== undefined ? '  → 实际: ' + JSON.stringify(actual) : '')); }
}
function eq(a, b, name) { ok(a === b, name, a === b ? undefined : a); }
function section(t) { console.log('\n【' + t + '】'); }

function slice(startMark, endMark) {
  const s = appJs.indexOf(startMark);
  if (s < 0) throw new Error('切片起点未找到：' + startMark);
  const e = appJs.indexOf(endMark, s);
  if (e < 0) throw new Error('切片终点未找到：' + endMark);
  return appJs.slice(s, e);
}

/* --- 取解析函数（normCard / swipeCardPart / findStaffByCard / findStaffLocal） --- */
const parseSlice = slice('  const STAFF_ROLE_LABEL = {', '  function staffFiltered() {');
/* --- 取刷卡组件（SWIPE_CTX / swipeHintText / swipeFieldHtml / bindSwipe / resolveSwipe / validateSwipe） --- */
const swipeSlice = slice('  const SWIPE_CTX = {', '  /* ============================================================\n   * 夹具管理');

/* --- 最小 DOM 桩：$('#id') 按键取节点 --- */
function makeDom() {
  const nodes = new Map();
  function mk(id) {
    const n = {
      id: id,
      value: '',
      className: '',
      textContent: '',
      dataset: {},
      addEventListener() {}
    };
    nodes.set(id, n);
    return n;
  }
  const $ = (sel) => nodes.get(String(sel).replace(/^#/, '')) || null;
  return { mk, $, nodes };
}

function build(staffs, extra) {
  const dom = makeDom();
  const state = Object.assign({
    staffs: staffs,
    swipePick: { out: { party: 0 }, ret: { party: 0 }, dlg: { party: 0 }, rdlg: { party: 0 } }
  }, extra || {});
  const sandbox = {
    window: {},
    console,
    document: { querySelector: dom.$ },
    state,
    $: dom.$,
    $$: () => [],
    esc: (v) => String(v == null ? '' : v),
    natCompare: (a, b) => String(a).localeCompare(String(b), 'zh'),
    DB: { normalizeCardNo: store.normalizeCardNo }
  };
  const code = parseSlice + '\n' + swipeSlice + '\n;window.__api = {'
    + 'swipeCardPart: swipeCardPart, findStaffByCard: findStaffByCard,'
    + 'findStaffLocal: findStaffLocal, resolveSwipe: resolveSwipe,'
    + 'validateSwipe: validateSwipe, swipeFieldHtml: swipeFieldHtml'
    + '};';
  vm.runInContext(code, vm.createContext(sandbox));
  return { api: sandbox.window.__api, dom, state };
}

const STAFFS = [
  { id: 1, cardNo: 'C1001', name: '张三', dept: '生产部', role: 'worker', active: true },
  { id: 2, cardNo: 'C1002', name: '李四', dept: '生产部', role: 'worker', active: true },
  { id: 3, cardNo: 'C1003', name: '张三', dept: '品质部', role: 'worker', active: true }, // 同名，用于歧义
  { id: 4, cardNo: 'C1004', name: '王五', dept: '仓库', role: 'worker', active: false },  // 已停用
  { id: 5, cardNo: 'A-2001', name: '赵六', dept: '装配', role: 'worker', active: true }   // 卡号含横线
];

/* ============================================================
 * A. swipeCardPart：输入 → 纯卡号
 * ============================================================ */
section('A. swipeCardPart（输入归一：剥掉「| 姓名 - 部门」后缀）');
{
  const { api } = build(STAFFS);
  eq(api.swipeCardPart(''), '', '空串 → 空串');
  eq(api.swipeCardPart('   '), '', '纯空格 → 空串');
  eq(api.swipeCardPart('  C1001  '), 'C1001', '首尾空格被去掉');
  eq(api.swipeCardPart('C1001 | 张三 - 生产部'), 'C1001', '展示串 → 取竖线前段');
  eq(api.swipeCardPart('  C1001|张三'), 'C1001', '无空格的展示串也能剥');
  eq(api.swipeCardPart('张三'), '张三', '纯姓名原样返回（交给后续姓名匹配）');
  eq(api.swipeCardPart(null), '', 'null → 空串');
  eq(api.swipeCardPart(undefined), '', 'undefined → 空串');
  eq(api.swipeCardPart(1001), '1001', '数字也能转成字符串');
}

/* ============================================================
 * B. 核心回归：选人 → 提交校验必须通过
 * ============================================================ */
section('B. 回归：datalist 选中后提交出库，不得报「领用人未登记」');
{
  const { api, dom } = build(STAFFS);
  const input = dom.mk('swipe_out_party');
  dom.mk('swipe_out_party_state');
  dom.mk('swipe_out_party_tip');
  input.value = 'C1001';                 // datalist 的 option value = 卡号

  const r1 = api.resolveSwipe('out');
  ok(r1.ok, '① 选中后解析通过');
  eq(r1.staff && r1.staff.id, 1, '② 解析到正确的人（张三）');
  eq(input.value, 'C1001', '③ 输入框仍只有纯卡号，没被改写成展示串');
  ok(input.value.indexOf('|') < 0, '④ 输入框里不含竖线');

  const v = api.validateSwipe('out');
  ok(v.ok, '⑤ 提交校验通过（旧版在此误报「未登记」）', v.msg);
  eq(v.party && v.party.name, '张三', '⑥ 校验返回的人正确');
}

/* ============================================================
 * C. 幂等：反复解析结果一致
 * ============================================================ */
section('C. 幂等（change 触发 + 提交校验，共解析多次）');
{
  const { api, dom, state } = build(STAFFS);
  const input = dom.mk('swipe_out_party');
  dom.mk('swipe_out_party_state');
  dom.mk('swipe_out_party_tip');
  input.value = 'C1002';

  const results = [];
  for (let i = 0; i < 4; i++) results.push(api.resolveSwipe('out'));
  ok(results.every((r) => r.ok), '连续解析 4 次全部通过', results.map((r) => r.ok));
  ok(results.every((r) => r.staff.id === 2), '每次都是同一个人（id=2）');
  eq(state.swipePick.out.party, 2, 'swipePick 记录的 id 正确');
  eq(input.value, 'C1002', '输入框值始终不变');
}

/* ============================================================
 * D. 历史遗留展示串：仍能解析并被规范化
 * ============================================================ */
section('D. 兼容历史：「卡号 | 姓名 - 部门」仍能解析');
{
  const { api, dom } = build(STAFFS);
  const input = dom.mk('swipe_out_party');
  dom.mk('swipe_out_party_state');
  dom.mk('swipe_out_party_tip');
  input.value = 'C1001 | 张三 - 生产部';

  const r = api.resolveSwipe('out');
  ok(r.ok, '① 展示串能被解析（不至于卡死旧窗口）');
  eq(input.value, 'C1001', '② 顺手规范化成纯卡号');
  ok(api.validateSwipe('out').ok, '③ 规范化后提交校验通过');
}

/* ============================================================
 * E. 手工输入姓名：唯一命中才认
 * ============================================================ */
section('E. 姓名输入（唯一命中 → 回填卡号；歧义 → 不猜）');
{
  const { api, dom } = build(STAFFS);
  const input = dom.mk('swipe_out_party');
  dom.mk('swipe_out_party_state');
  dom.mk('swipe_out_party_tip');

  input.value = '李四';
  const r = api.resolveSwipe('out');
  ok(r.ok, '① 唯一姓名「李四」可解析');
  eq(input.value, 'C1002', '② 解析成功后回填为卡号（与下拉选项值一致）');

  input.value = '张三';                   // C1001 / C1003 同名
  const r2 = api.resolveSwipe('out');
  ok(!r2.ok, '③ 同名多人时不猜，直接拦下');
  ok(/未登记/.test(r2.msg || ''), '④ 给出明确提示', r2.msg);

  input.value = '生产部';                 // 同部门两人
  const r3 = api.resolveSwipe('out');
  ok(!r3.ok, '⑤ 部门名不再被当作人员（旧版会挑第一个，等于出错人）');

  input.value = '赵六';
  const r4 = api.resolveSwipe('out');
  ok(r4.ok && r4.staff.id === 5, '⑥ 卡号带横线的人员也能按姓名命中');
  eq(input.value, 'A-2001', '⑦ 回填原样卡号');
}

/* ============================================================
 * F. 各种失败分支
 * ============================================================ */
section('F. 失败分支（空 / 未登记 / 已停用 / 归一化）');
{
  const { api, dom, state } = build(STAFFS);
  const input = dom.mk('swipe_out_party');
  const st = dom.mk('swipe_out_party_state');
  dom.mk('swipe_out_party_tip');

  input.value = '';
  const e1 = api.resolveSwipe('out');
  ok(!e1.ok && e1.empty, '① 空值 → empty');
  eq(st.textContent, '未刷卡', '② 徽标显示「未刷卡」');
  eq(state.swipePick.out.party, 0, '③ 空值时清掉已记录的 party');

  input.value = 'C9999';
  const e2 = api.resolveSwipe('out');
  ok(!e2.ok && !e2.empty, '④ 不存在的卡 → 失败');
  eq(st.textContent, '未登记', '⑤ 徽标显示「未登记」');

  input.value = 'C1004';
  const e3 = api.resolveSwipe('out');
  ok(!e3.ok, '⑥ 停用卡 → 失败');
  eq(st.textContent, '已停用', '⑦ 徽标显示「已停用」');

  input.value = 'c 1001';                 // 小写 + 空格，归一化后应命中 C1001
  const e4 = api.resolveSwipe('out');
  ok(e4.ok && e4.staff.id === 1, '⑧ 卡号小写/带空格也能命中（归一化比对）');

  input.value = 'C1004 | 王五 - 仓库';
  ok(!api.resolveSwipe('out').ok, '⑨ 展示串 + 停用卡 → 仍拦下（剥壳逻辑不掩盖停用）');
}

/* ============================================================
 * G. 退库位同样生效（ctx 不止 out）
 * ============================================================ */
section('G. 退库人 / 弹窗（ret、dlg、rdlg 走同一套逻辑）');
{
  ['ret', 'dlg', 'rdlg'].forEach((ctx) => {
    const { api, dom } = build(STAFFS);
    const input = dom.mk('swipe_' + ctx + '_party');
    dom.mk('swipe_' + ctx + '_party_state');
    dom.mk('swipe_' + ctx + '_party_tip');
    input.value = 'C1001';
    const r = api.resolveSwipe(ctx);
    ok(r.ok && r.staff.id === 1, ctx + ' 位选人后可解析');
    ok(api.validateSwipe(ctx).ok, ctx + ' 位提交校验通过');
    eq(input.value, 'C1001', ctx + ' 位输入框保持纯卡号');
  });
}

/* ============================================================
 * H. 静态守卫：防止把展示串写回输入框的写法再进来
 * ============================================================ */
section('H. 静态守卫（源码扫描）');
{
  ok(!/el\.value\s*=\s*`\$\{s\.cardNo\}\s*\|/.test(appJs), '不再把「卡号 | 姓名」展示串写回输入框');
  ok(!/deptMatch/.test(appJs), 'findStaffLocal 已移除按部门匹配（防出错人）');
  ok(appJs.indexOf('function swipeCardPart') > 0, 'swipeCardPart 存在');
  ok(appJs.indexOf('function findStaffByCard') > 0, 'findStaffByCard 存在');
  ok(/split\('\|'\)\[0\]/.test(appJs), 'swipeCardPart 按竖线切分');
  ok(/const dup = findStaffByCard\(v\);/.test(appJs), '新卡查重走纯卡号匹配');
  /* 卡片查重处若又改回 findStaffLocal，会把「卡号等于某人姓名」当成重复 */
  ok(!/const dup = findStaffLocal\(v\)/.test(appJs), '查重处不再用带姓名兜底的 findStaffLocal');
}

console.log('\n' + '='.repeat(50));
console.log('测试汇总：通过 ' + pass + ' / 失败 ' + fail);
if (fail) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
console.log('='.repeat(50));
process.exit(fail ? 1 : 0);
