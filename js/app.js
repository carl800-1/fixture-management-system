/* ============================================================
 * app.js — 工装夹具管理程序主逻辑（v5.0.0）
 *
 * 数据模型要点（详见工作区根《夹具管理系统_五项决策实施方案.md》）：
 *   · 追踪单元 = 每套一条 fixtures 记录；数量是派生值，不落库
 *   · code        4 位纯数字，唯一、自动分配，是各环节的「桥梁」+ 二维码内容，不参与模糊搜索
 *   · serialNo    实物夹具编号，手动输入、可重复（同机种多套共用一个编号），主搜索键
 *   · lines[]     涉及的产线 id（≥1、≤5）
 *   · 出库只改 status（location 冻结保留）；回库预填原库位、允许改（改则写回 location）
 *
 * ⚠️ v5.0.0：**工位（stations）模型已整体移除** —— 不再有工位集合、fixtures.stations、
 *    工位图（产线示意图）、工位筛选/展示，以及导入模板里的工位列。夹具只关联到产线。
 * ============================================================ */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* 属性值转义：esc 已含引号转义，别名便于语义区分（用于 value="..." / onclick 参数）。
   * 挂 window 只为通过 test_render 的 onclick 函数名一致性校验（它把模板插值 ${escAttr(...)}
   * 也当事件引用收集），实际只在渲染期调用，不参与点击事件。 */
  const escAttr = (s) => esc(s);
  window.escAttr = escAttr;

  const num = (v, fallback = 0) => {
    if (v == null) return fallback;
    let s = String(v);
    s = s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    s = s.replace(/[　\s,，]/g, '');
    if (s === '' || s === '-' || s === '+' || s === '.' || s === '-.' || s === '+.') return fallback;
    const n = parseFloat(s);
    return (isNaN(n) || !isFinite(n)) ? fallback : n;
  };

  const pad = (n) => String(n).padStart(2, '0');

  /* 自然排序：数字按数值而非字符序（如 A-2 < A-10），中文用 zh-Hans-CN 排序 */
  function natCompare(a, b) {
    return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  }
  /* 库位列表排序：真实库位升序，「（未分配）」始终置于末尾 */
  function locSort(keys) {
    const UNASSIGNED = '（未分配）';
    return keys.sort((a, b) => {
      if (a === UNASSIGNED) return 1;
      if (b === UNASSIGNED) return -1;
      return natCompare(a, b);
    });
  }
  /* 编号归一化：忽略大小写 / 连字符 / 下划线 / 空格，用于扫码枪录入差异容错。
   * 仅用于匹配比较，建档保存始终使用用户原始编号。*/
  function normalizeCode(str) {
    return String(str == null ? '' : str)
      .replace(/^SPMS1?\s*\|\s*/i, '')   // 兼容旧二维码前缀（v4.0.2 起二维码内容已是纯序号）
      .replace(/[\s\-_]/g, '')
      .toUpperCase();
  }
  /* 编号模糊比较：先普通包含，再归一化比较（命中即视为同一编号）*/
  function codeLike(haystack, needle) {
    const h = String(haystack == null ? '' : haystack);
    const n = String(needle == null ? '' : needle);
    if (n === '') return false;
    return h.toLowerCase().includes(n.toLowerCase()) || normalizeCode(h).includes(normalizeCode(n));
  }

  /* ---------------- 业务上限与格式约束（与 store.js / db.js 同源） ---------------- */
  const MAX_LINE_MODELS = 12;   // 一件夹具最多关联机种数（原 7）
  const MAX_LINES = 5;          // 一件夹具最多涉及产线数
  const MAX_SERIAL_NO = 64;
  const MAX_LOCATION = 20;
  const LOCATION_RE = /^[A-Za-z0-9]+(-[A-Za-z0-9]+){3}$/;
  const MAX_PROD_NAME = 30;
  const MAX_CATEGORY = 30;      // 分类名称长度上限
  /* 分类预设（材质类）：仅作下拉候选，用户仍可自定义新增；
   * 新增值随夹具落库，下次打开表单时由 categoryCandidates() 从现有夹具收集，自动进入候选。 */
  const CATEGORY_PRESETS = ['金属', '不锈钢', '铝合金', 'PVC', '亚克力', '橡胶', '硅胶', '尼龙', '电木', '木质', '复合材料'];
  function isValidLocation(v) {
    const s = String(v == null ? '' : v).trim();
    return !!s && s.length <= MAX_LOCATION && LOCATION_RE.test(s);
  }
  function isValidSerialNo(v) {
    const s = String(v == null ? '' : v).trim();
    return !!s && s.length <= MAX_SERIAL_NO && !/[|\r\n]/.test(s);
  }
  function isValidProductionName(v) {
    const s = String(v == null ? '' : v).trim();
    return !!s && s.length <= MAX_PROD_NAME && !/[|\r\n]/.test(s);
  }
  /* 分类允许为空（非必填），只约束长度与换行；空串视为「未分类」 */
  function isValidCategory(v) {
    const s = String(v == null ? '' : v).trim();
    return s.length <= MAX_CATEGORY && !/[|\r\n]/.test(s);
  }

  /* 机种名称：展示 / 搜索 helpers */
  function formatLineModels(f, emptyMark = '—', opts) {
    const arr = (Array.isArray(f.lineModels) ? f.lineModels : []).filter((x) => String(x).trim() !== '');
    if (!arr.length) return emptyMark;
    /* collapse: 表格列最多显示前 N 个，其余折叠为「等 M 项」（hover 用 fullLineModels 看全） */
    const keep = opts && opts.collapse ? opts.collapse : 0;
    if (keep && arr.length > keep) return arr.slice(0, keep).join(' / ') + ' 等 ' + arr.length + ' 项';
    return arr.join(' / ');
  }
  function fullLineModels(f, emptyMark = '—') {
    const arr = (Array.isArray(f.lineModels) ? f.lineModels : []).filter((x) => String(x).trim() !== '');
    return arr.length ? arr.join(' / ') : emptyMark;
  }
  /* 机种名比对归一：去首尾空白 + 转小写。**只用于比对，不改写落库原值。**
   * ⚠️ BUG-012（v5.2.1）：入参归一必须做在这里，不能指望调用方先转小写。
   *   产线使用页的下拉直接把原始值（大写 DH40MC）传进来，而库里经 toLowerCase 变成
   *   'dh40mc'，'dh40mc'.includes('DH40MC') === false ⇒ 任何含字母的机种筛选恒为 0 条。 */
  function normModelName(v) {
    return String(v == null ? '' : v).trim().toLowerCase();
  }
  /* 模糊匹配：任一机种名**包含**关键字即命中（顶栏搜索 / 出库页机种搜索框用） */
  function lineModelsMatch(f, q) {
    const s = normModelName(q);
    if (!s) return true;                       // 空关键字 = 不过滤（与原 includes('') 等价）
    const arr = Array.isArray(f.lineModels) ? f.lineModels : [];
    return arr.some((lm) => normModelName(lm).includes(s));
  }
  /* 精确匹配：任一机种名与 name **完全相同**（大小写 / 首尾空格不敏感）。
   * 下拉框是枚举值，必须用等值而非包含 —— 否则选「DH40」会连带命中「DH40MC」，
   * 筛选结果多于用户所选的那一项。 */
  function lineModelsExact(f, name) {
    const s = normModelName(name);
    if (!s) return true;
    const arr = Array.isArray(f.lineModels) ? f.lineModels : [];
    return arr.some((lm) => normModelName(lm) === s);
  }
  /* 一件夹具关联的机种数（去重后） */
  function lineModelCount(f) {
    return (Array.isArray(f.lineModels) ? f.lineModels : []).filter((x) => String(x).trim() !== '').length;
  }
  /* 产线名归一化：**只用于判断「是不是同一条产线」**，绝不改写用户填写的原值。
   * 去掉 # / ＃ / 全部空白，全角字符转半角，再统一小写 —— 「1#」「1 」「１」「1　」都归到「1」。
   * 背景（BUG-010）：台账里 1 和 1# 混写时，导入会按字面各补建一条线，
   * 夹具被拆到两条同义产线上，用户在「产线使用」里选哪条都看不全。
   * 注意：「3号线」与「3」归一化后不同（后缀属于真实命名差异），不会被误并。 */
  function normalizeLineName(name) {
    return String(name == null ? '' : name)
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[#＃\s]+/g, '')
      .toLowerCase();
  }

  /* ---------------- 关联字段派生显示（不冗余存名，一律从 id 推导） ---------------- */
  /* 产线名列表：fixtures.lines([lineId]) → lines.name */
  function lineNamesOf(f) {
    const ids = Array.isArray(f && f.lines) ? f.lines.map(Number) : [];
    return ids.map((id) => (state.lines.find((l) => l.id === id) || {}).name).filter(Boolean);
  }
  function lineNamesLabel(f, emptyMark = '—') {
    const names = lineNamesOf(f);
    return names.length ? names.join(' / ') : emptyMark;
  }
  /* 导出 / 下载模板用：以 fixtures.lines 为基准，输出产线名数组（v5.0.0 起无工位）。 */
  function fixtureLineNamesForExport(f) {
    const lineIds = Array.isArray(f && f.lines) ? f.lines.map(Number) : [];
    return lineIds.map((lid) => {
      const line = state.lines.find((l) => l.id === lid);
      return line ? line.name : `#${lid}`;
    });
  }

  /* ---------------- 数量：派生值（不落库） ---------------- */
  /* 在库量：某夹具编号在指定库位的可领用套数（location 传 null 表示跨全部库位） */
  function availQty(serialNo, location) {
    return state.fixtures.filter((f) =>
      f.serialNo === serialNo &&
      f.status === 'stocked' &&
      (location == null || (f.location || '') === location)
    ).length;
  }
  /* 台账总量：不限状态（含已出库 / 维修中 / 已报废） */
  function totalQty(serialNo) {
    return state.fixtures.filter((f) => f.serialNo === serialNo).length;
  }
  function outQty(serialNo) {
    return state.fixtures.filter((f) => f.serialNo === serialNo && f.status === 'checked_out').length;
  }
  function repairQty(serialNo) {
    return state.fixtures.filter((f) => f.serialNo === serialNo && f.status === 'repair').length;
  }
  function retiredQty(serialNo) {
    return state.fixtures.filter((f) => f.serialNo === serialNo && f.status === 'retired').length;
  }
  /* 建/导入重号提示用：该编号的持有概况 */
  function serialNoSummary(serialNo) {
    const t = totalQty(serialNo);
    if (!t) return '';
    return `该编号已有 ${t} 套（在库 ${availQty(serialNo)} 套，在外 ${outQty(serialNo)} 套）`;
  }

  /* 机种字典引用计数（用于删除保护提示） */
  function productionRefCount(name) {
    return state.fixtures.filter((f) => (Array.isArray(f.lineModels) ? f.lineModels : []).includes(name)).length;
  }
  /* 库位候选：从现有夹具去重生成（不新建集合），落实「规定最大位数以减少录入出错」 */
  function locationCandidates() {
    return uniqueSorted(state.fixtures.map((f) => f.location).filter(Boolean));
  }
  /* 分类候选：预设（保持声明顺序在前）∪ 现有夹具已用分类（去重、自然序在后）。
   * 不新建集合 —— 自定义分类靠「随夹具落库 → 下次收集」自然记住。 */
  function categoryCandidates() {
    const used = state.fixtures.map((f) => f.category).filter(Boolean);
    const extra = uniqueSorted(used.filter((v) => CATEGORY_PRESETS.indexOf(v) < 0));
    return CATEGORY_PRESETS.concat(extra);
  }

  /* 出库/回库页第一栏（扫码枪）：桥梁编号精确命中 + 夹具编号模糊命中 */
  function matchCodeField(f, q) {
    if (!q) return true;
    if (DB.codeEq ? DB.codeEq(f.code, q) : String(f.code) === String(q)) return true;
    return String(f.serialNo || '').toLowerCase().includes(String(q).toLowerCase());
  }

  /* 统一夹具检索谓词：serialNo/名称/库位/机种/分类/产线 模糊；
   * code 只在「完全相等（归一化）」时命中 —— 桥梁编号不参与模糊搜索。 */
  function matchFixture(f, q) {
    if (!q) return true;
    const s = String(q).trim().toLowerCase();
    if (!s) return true;
    if (DB.codeEq ? DB.codeEq(f.code, s) : String(f.code) === s) return true;
    if ((f.serialNo || '').toLowerCase().includes(s)) return true;
    if ((f.name || '').toLowerCase().includes(s)) return true;
    if ((f.location || '').toLowerCase().includes(s)) return true;
    if ((f.category || '').toLowerCase().includes(s)) return true;
    if (lineModelsMatch(f, s)) return true;
    if (lineNamesOf(f).some((n) => n.toLowerCase().includes(s))) return true;
    return false;
  }

  /* 中文输入法守卫：组合输入期间不触发实时搜索 */
  function imeGuard(input, onInput) {
    if (!input) return;
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => {
      composing = false;
      onInput();
    });
    input.addEventListener('input', () => { if (!composing) onInput(); });
  }

  function nowInput() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function inputToMs(v) { return v ? new Date(v).getTime() : Date.now(); }
  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function todayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

  let toastTimer = null;
  function toast(msg, type) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (type ? ' ' + type : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /* 全局错误兜底 */
  function showFatal(msg) {
    const c = $('#content');
    if (!c) return;
    if (!c.textContent.trim()) {
      c.innerHTML = `<div class="panel">
        <div class="panel-title" style="color:var(--danger)">页面运行出错</div>
        <p>${esc(msg)}</p>
      </div>`;
    } else {
      toast('出错：' + msg, 'err');
    }
  }
  window.addEventListener('error', (e) => {
    if (e && e.target && e.target !== window) return;
    showFatal((e && e.message) || '未知脚本错误');
  });
  window.addEventListener('unhandledrejection', (e) => {
    showFatal((e && e.reason && (e.reason.message || e.reason)) || '未处理的异步错误');
  });

  /* ---------------- 全局状态 ---------------- */
  const state = {
    view: 'dashboard',
    fixtures: [],
    fixTransactions: [],
    fixSelectedId: 0,
    operators: [],
    locFilter: '',          // 库位管理：当前选中的库位（空 = 全部）
    qrFixture: null,        // 当前查看二维码的夹具（单标签打印用）
    fixViewMode: 'card',    // 夹具列表视图模式：card = 卡片 / list = 表格
    fixShown: 300,          // 夹具列表已渲染条数（v5.6.0 限流：一次只渲染这么多，可点「显示更多」累加）
    outAvailable: 0,        // 出库页：当前检索结果中的可出库台数（数量上限）
    returnAvailable: 0,     // 回库页：当前检索结果中的可回库台数（数量上限）
    outSelectedId: 0,       // 出库页当前选中的夹具（0 = 未选）
    returnSelectedId: 0,    // 回库页当前选中的夹具（0 = 未选）
    // 出库/回库页的常驻录入项：切换选项或提交后仍保留，便于连续作业
    outForm: { operator: '', counterparty: '', remark: '', time: '' },
    returnForm: { operator: '', remark: '', time: '' },
    // 夹具查询：筛选/排序状态（切换视图后保留，便于连续检索）
    query: { keyword: '', code: '', name: '', location: '', lineModel: '', borrower: '', category: '', statuses: [], sortBy: 'code', sortDir: 'asc', outReason: '' },
    // 关联配置数据
    lines: [],
    productions: [],
    staffs: [],                                  // v5.1.0 人员卡库（刷卡反查姓名/角色）
    staffQuery: '',                              // 人员卡库页：搜索关键字
    // 刷卡位已识别的人员（存 staff.id；0 = 未识别）
    swipePick: { out: { party: 0 }, ret: { party: 0 }, dlg: { party: 0 }, rdlg: { party: 0 } },
    lineCfg: { lineId: 0 },                          // 产线配置页：当前选中的线体
    lineQuery: { lineId: 0, lineModel: '' },                    // 产线使用页：当前选中的线体 + 机种（为空=全部）
    prodPick: '',            // 机种管理页：当前展开明细的机种名称（'' = 未展开）
    // 建档 / 编辑夹具表单的暂存（产线选择用，退出表单即清空）
    fixForm: { editId: 0, lineModels: [], lines: [] }
  };

  /* ---------------- 数据加载 ---------------- */
  async function reloadAll() {
    state.fixtures = await DB.fixtureGetAll();
    state.fixTransactions = await DB.fixtureGetTransactions();
    // 人员卡库随主数据一起加载：刷卡位需要即时反查姓名，避免每次刷卡走一次 IPC
    try { await reloadStaff(); } catch (e) { state.staffs = []; }
  }

  /* 人员卡库数据加载（独立函数：人员页改动后单独刷新，不动夹具） */
  async function reloadStaff() {
    state.staffs = (await DB.staffGetAll()) || [];
    return state.staffs;
  }

  /* 产线配置数据加载（独立于夹具数据，按需刷新） */
  async function reloadLineConfig() {
    state.lines = await DB.getAll('lines');
    state.productions = await DB.getAll('productions');
  }

  /* ---------------- 状态映射 ---------------- */
  const FIX_STATUS = {
    stocked: { label: '在库', cls: 'ok' },
    checked_out: { label: '已出库', cls: 'warn' },
    repair: { label: '维修中', cls: 'danger' },
    retired: { label: '已报废', cls: 'muted' }
  };
  const FIX_TX_TYPE = {
    out: { label: '出库', icon: '📤' },
    return: { label: '回库', icon: '📥' },
    in: { label: '入库', icon: '📦' },
    repair: { label: '维修', icon: '🔧' },
    repair_done: { label: '维修完成', icon: '✅' },
    retire: { label: '报废', icon: '🗑️' }
  };
  const OUT_REASON_LABEL = { use: '使用', repair: '维修', other: '其它' };

  /* ---------------- 变更日志（关于面板） ---------------- */
  const CHANGELOG = [
    {
      version: '5.8.1', date: '2026-10-29', items: [
        '<b>【规则调整】库位按「套」管理，多套可不同库位（不再误报异常）</b>：'
          + '此前把「库位不一致」列为异常（同工装号多套应同库位），但 FMS 是单件追踪、每条记录=一套实物，'
          + '库位是<b>每套自己的属性</b>，同一工装号的多套散放在不同库位属正常存储 —— 原规则误报 166 组 / 623 条。'
          + '现改为库位不一致<b>不再标红异常</b>，异常工装页只保留三类真正的数据问题：名称不一致 / 编号格式异常 / 套号缺失；'
          + '「⚡ 统一库位」入口移除，改为「库位分布」信息展示（同工装号多套分布在各库位及套数，便于快速找套，不作告警）',
        '<b>【改进】异常工装页支持「逐条编辑」每一条记录的完整信息</b>：'
          + '名称不一致 / 库位分布 / 套号缺失的每个工装号下新增「📝 逐条编辑」—— 展开该工装号下所有记录'
          + '（套号 / 序号 / 编号 / 名称 / 库位 / 机种），每条可「✏️ 编辑」（就地弹窗改编号、名称、库位、机种、产线等完整字段）'
          + '或「🔍 卡片编辑」（跳到夹具管理定位该卡并打开编辑）。'
          + '解决「工装号本身编错」（如 BM40M2-921 一个号下挂了 36 个不同夹具）时，系统只报名称错误、只给「统一名称」的误判'
      ]
    },
    {
      version: '5.8.0', date: '2026-10-29', items: [
        '<b>【新增】侧边栏「⚠️ 异常工装」页（修改导入的数据）</b>：数据治理（按「工装号-套号」规则套号唯一化 + 去重）后剩 3911 条，'
          + '同工装号下仍存在名称 / 库位不一致等异常，但没有专用修改入口。'
          + '本页按工装号聚合实时列出四类异常：① <b>名称不一致</b>（154 组）—— 每行「⚡ 统一名称」一键把该工装号全部套改成选定主名称；'
          + '② <b>库位不一致</b>（218 组）—— 「⚡ 统一库位」一键统一为 4 段式库位；'
          + '③ <b>编号格式异常</b>（3 条）—— 复用编辑表单修正；'
          + '④ <b>套号缺失</b>（4 组，仅多套工装号）—— 跳「夹具管理」核对。'
          + '机种不一致属正常设计（一工装多机种），不列异常',
        '<b>【改进】批量修改走新增 fixture-updateBatch 通道</b>：整批一次写盘，避免逐套落库时反复全量重写数据文件；'
          + 'store 层把单条与批量更新抽到同一个 applyFixturePatch 归一化函数，防止两条路径的校验规则漂移'
      ]
    },
    {
      version: '5.7.1', date: '2026-10-29', items: [
        '<b>【修复】出库 / 回库会出库「错件」（BUG-017）</b>：旧版在点「提交」的一瞬间，会按数量框把候选列表<b>前 N 件</b>重新勾一遍，'
          + '把你手动勾选的夹具整片覆盖 —— 出库的、流水记录的都是列表最前面那几件，而界面没有任何提示。'
          + '现在改为<b>勾选是唯一数据源</b>：提交只校验、不改写勾选；数量框自动跟随勾选回填，两者不一致时会明确提示「已按勾选提交」',
        '【修复】扫码选中会清空此前的勾选：连扫多件时只剩最后一件，数量也退回 1。现在先记住已勾选项、重绘后恢复；'
          + '被当前检索条件隐藏、确实无法保留的会明确提示「另有 N 套未计入本次勾选」',
        '<b>【改进】流水「夹具」列增加实物编号副行</b>：4 位序号与出厂编号（如 G10BP5-921-012-001）并排可见，'
          + '不必再靠记忆把「4166」和实物编号对应起来',
        '【移除】出库页右上角「📷 批量扫码出库」按钮：它指向的区域从未出现在页面上，点击没有任何反应，且扫码器识别一次即停、本就不是批量。'
          + '摄像头扫码统一走「夹具编号」栏右侧的 📷'
      ]
    },
    {
      version: '5.7.0', date: '2026-10-23', items: [
        '<b>【新增】未导入明细记录</b>：导入完成后，结果窗口列出<b>每一行没进库的数据</b>——行号、夹具编号、名称、库位、未导入原因，按行号升序；表格内最多显示前 200 行，完整明细可一键导出 CSV',
        '【新增】未导入原因分四类并写明：<b>解析未通过</b>（名称为空 / 库位不合规 / 机种全空…）、<b>与库内记录完全一致</b>（选了「跳过重复」）、<b>产线未建档按选择跳过</b>、<b>落库失败</b>（附主进程返回的具体原因）',
        '<b>【修复】落库失败此前是黑盒</b>：旧版只给一个「失败 N 条」的数字，具体哪几行失败仅打在开发者工具控制台里，普通用户看不到；现在逐行留证并列进结果窗口',
        '【新增】「⬇ 导出未导入明细 CSV」：输出 <code>未导入明细_日期_时分.csv</code>（UTF-8 BOM + CRLF，Excel 双击不乱码），五列与本窗口表格一致，可用于存档、比对与补导',
        '【优化】整份表<b>一行都导不进</b>时同样可导出明细（此前只列前 10 条文字）；一行都没进库但存在跳过项时，也会弹出结果窗口而不是只闪一个 toast'
      ]
    },
    {
      version: '5.6.0', date: '2026-10-23', items: [
        '【调整】<b>取消「经办人」</b>：出库页只刷<b>领用人</b>、回库页只刷<b>退库人</b>，单件出库 / 单件回库弹窗同步只留一个刷卡位；送修、维修完成、报废三个弹窗里的「经办人」输入框一并移除。一次出入库只需刷<b>一张卡</b>即可提交',
        '【调整】刷卡位<b>不再按人员角色限制</b>：只要卡已在「👤 人员卡库」登记且启用就能刷（历史「经办人」角色的老卡也照常可用）；角色字段保留，仅作台账标注',
        '【兼容】流水记录 <code>operator</code> / <code>operatorCard</code> 字段保留但<b>新记录写空串</b>，历史流水的经办人仍可查、可搜索、可导出，不做数据迁移',
        '<b>【修复】大批量导入卡死</b>：原来逐条落库，<b>每条都把整个 fixture-data.json 全量重写一遍</b>；库内 9000 条 + 导入 4114 行时累计要写十几 GB，窗口数分钟无响应，用户以为卡死便反复重试，数据越滚越多（现场被重试出 8999 条）',
        '【优化】新增<b>批量落库通道</b>（<code>fixture-addBatch</code>）：按 500 条分片、整片一次写盘，4114 行从「4114 次全量写」降到「9 次」；导入过程弹出<b>进度条</b>显示已写入条数，不再是无反馈的假死',
        '【优化】导入<b>预览阶段</b>的两处 O(n²) 扫描改为一次预计算（同编号统计、产线 id→名称映射），上万行长表预览明显变快',
        '<b>【修复】导入后界面卡死</b>：夹具列表原来一次渲染全部卡片（9000 条 = 9000 张卡，每张 6~7 个按钮），渲染进程直接拖死；现在<b>默认只渲染前 300 条</b>，底部显示总条数并给「再显示 300 条」按钮，换搜索关键字自动回到首页'
      ]
    },
    {
      version: '5.5.0', date: '2026-10-23', items: [
        '【新增】出库页「可出库」、回库页「待回库」状态条的<b>右侧各增加一个「全选」开关</b>：勾上即把<b>当前检索结果里的全部夹具</b>一次性选中（跨分组），出库 / 回库数量自动回填为总套数，已选摘要与各分组头的复选框同步更新，随后回车或点「提交出库 / 提交回库」即完成<b>一键批量提交</b>',
        '【新增】顶栏开关与结果区<b>双向联动</b>：显示「全选 N 套 / 已选 n / N / 已全选 N 套」三种文案，手动取消其中一套时开关自动转为<b>半选</b>态，再点一下即全部取消，状态不会与结果区脱节',
        '【保障】<b>没有检索结果时开关自动禁用</b>（灰显且不可点），避免出现「点了全选却没对象」的假状态；清空检索词后也会立即复位为禁用',
        '【说明】仍然是<b>一次提交多套、每套各出/回库 1 件</b>，共用同一组经办人 / 领用人 / 时间 / 用途 / 备注；刷卡严格校验（两人必刷、不同卡）不变，因此「一键」只省去逐个勾选，不降低记录完整性'
      ]
    },
    {
      version: '5.4.0', date: '2026-10-21', items: [
        '【新增】单件夹具可关联的<b>机种数由 7 个提升到 12 个</b>：建档 / 编辑表单的机种标签区上限同步放宽，计数显示为 <code>n / 12</code>，达到 12 个才提示已满',
        '【调整】夹具导入 / 导出模板由 <b>17 列改为 22 列</b>：<code>夹具编号 | 名称 | 机种名称1…机种名称12 | 分类 | 库位 | 产线1…产线5 | 备注</code>。分类 / 库位移到第 14 / 15 列，产线1~5 为第 16~20 列，备注为第 21 列',
        '【兼容】<b>旧 17 列模板仍可直接导入</b>（机种只到「机种名称7」也能导）：导入是按<b>表头名称</b>映射、不看列号，缺的机种列按空处理；反过来把新 22 列导出表拿给旧版本导入时，机种8~12 会被旧版忽略',
        '【维护性】机种表头、表头别名（含「机种名称八…十二」中文数字写法）、模板示例行全部改为<b>按上限常量生成</b>，今后再调机种数量只改 <code>MAX_LINE_MODELS</code> 一处，不会再出现「改了表头漏改示例行 / 别名表」的错位',
        '【说明】已存数据<b>不受影响</b>：上限放宽不会触发任何截断，原本 7 个以内的机种原样保留'
      ]
    },
    {
      version: '5.3.0', date: '2026-10-20', items: [
        '【新增】「关于 / About」面板底部增加 <b>鸣谢</b> 区，致谢提供宝贵意见的同事：<b>薛添才、朱近、林长平、林捷、林详杰、陈旭</b>。名单集中在 app.js 顶部的 <code>THANKS_NAMES</code> 常量，以后增减只改这一处',
      ]
    },
    {
      version: '5.2.1', date: '2026-10-20', items: [
        '<b>【修复】产线使用页按机种筛选恒为 0 条</b>：机种名含字母时（如 DH40MC）无论选哪个机种都查不到夹具，选「全部机种」却正常。根因是机种比对只把<b>库里的值</b>转成小写、没处理<b>传入的关键字</b>，于是 <code>\'dh40mc\'.includes(\'DH40MC\')</code> 恒为 false。现改为函数内部统一归一（去首尾空格 + 转小写），不再依赖调用方自觉',
        '<b>【修复】下拉筛选由「模糊包含」改为「精确等值」</b>：机种下拉是枚举值，用包含匹配会出现「选 DH40 连带命中 DH40MC」这类超出所选范围的结果',
        '<b>【修复】筛选显示与结果脱节</b>：若所选机种因夹具改删而从全库机种集合中消失，下拉会回落显示「全部机种」但仍在按旧值过滤；现在自动复位为「全部机种」',
      ]
    },
    {
      version: '5.2.0', date: '2026-10-20', items: [
        '【新增】「⚙ 产线配置」线体表新增 <b>机种名称</b> 列：汇总该线体上全部夹具的「适用机种」（去重、自然排序），多个机种用 <code>/</code> 分隔；该线体还没有带机种的夹具时显示「—」',
        '【新增】「🏷 机种管理」机种表新增 <b>线体</b> 列：汇总使用该机种的全部夹具所关联的产线（去重、自然排序），多条线体用 <code>/</code> 分隔；一条线体都没关联时显示「—」',
        '【说明】这两列都是<b>派生值</b>，由夹具记录里的 <code>lines</code>（关联产线）与 <code>lineModels</code>（适用机种）现算，<b>不新增任何存储字段</b>，也不改数据文件结构；机种与线体之间依旧<b>没有直接绑定</b>，在夹具上改机种或改关联产线，两列立刻跟着变'
      ]
    },
    {
      version: '5.1.0', date: '2026-10-20', items: [
        '【新增】<b>进出库刷卡</b>：新增侧边栏「👤 人员卡库」，登记<b>卡号 / 姓名 / 部门 / 角色 / 启用状态</b>；卡号归一化后<b>唯一</b>（一张卡只对应一个人），支持 Excel/CSV 批量导入与导出，模板 6 列',
        '【新增】出库的「领用人 + 经办人」、回库的「退库人 + 经办人」改为<b>刷卡录入</b>：光标停在刷卡框，USB 读卡器刷卡后自动带出姓名与部门；刷完一位自动跳到另一位。角色为「领用人」的卡只能刷领用位，「经办人」只能刷经办位，「两者皆可」两边都能刷',
        '【校验】提交时<b>严格校验</b>：两位都必须刷卡（不允许留空手填）、卡必须已登记、必须处于启用状态、角色必须匹配、且<b>不能是同一张卡</b>；任一条不满足直接拦下并说明原因。未登记的卡会提示去「人员卡库」登记',
        '【数据】流水新增 <code>operatorCard</code> / <code>partyCard</code> 两个卡号快照字段（姓名仍存 <code>operator</code> / <code>counterparty</code>），因此<b>删人或改名都不影响历史流水</b>；旧流水无卡号字段时显示为空，不影响查询与导出',
        '【新增】「🔗 产线使用」增加 <b>🖨 打印清单</b>：按<b>当前线体 + 当前机种</b>筛选结果打印 A4 横向表，含线体/机种/套数/打印时间表头、6 列表格（序号 / 夹具编号 / 名称 / 机种名称 / 库位 / 状态）、合计与签字栏；表头每页重复，行不被跨页截断',
        '【保障】打印与屏幕<b>共用同一份筛选结果计算</b>（<code>lineQueryRows()</code>），套数与排序完全一致；标签打印与清单打印互斥清场，不会互相混页'
      ]
    },
    {
      version: '5.0.0', date: '2026-10-20', items: [
        '【重构·不兼容】<b>工位（station）模型整体移除</b>：不再有 stations 集合、<code>fixtures.stations</code>、工位 CRUD、工位筛选/展示、以及夹具导入模板里的「工位1~工位5」列。夹具只关联到<b>产线</b>（1~5 条），数据结构更简单',
        '【移除】<b>产线示意图（工位图）</b>整块删除：SVG 绘图函数群、布局常量、节点计算与相关样式全部移除，「产线使用」页改为纯表格展示该产线上的夹具清单',
        '【移除】「🔎 夹具查询」页顶部的<b>「按夹具编号查询（数量与合计）」</b>面板整体删除（含按「编号 × 库位」分组统计、在库/在外/维修/报废分列与合计行），页面只保留多条件组合检索',
        '【调整】「⚙ 产线配置」页去掉「② 工位与夹具」面板，线体表去掉「工位数」列；线体删除只从夹具的 <code>lines</code> 中摘除，不再有工位级联',
        '【调整】产线配置导入模板由 6 列改为 <b>4 列</b>：<code>线体 | 线体形态 | 夹具编号 | 备注</code>。语义仍是「把某套夹具关联到某条产线」（追加 + 去重）；<b>旧模板里的「工位 / 工位顺序」列会被静默忽略</b>，老表格仍可导入',
        '【调整】「🏷 机种管理」的机种明细由「线体 → 工位 → 夹具」改为<b>按线体分组的夹具表</b>，去掉工位列与「工位 N 个」汇总',
        '【数据】启动时<b>自动清理旧数据</b>：<code>migrate()</code> 幂等删除 <code>data.stations</code> 与每条夹具的 <code>stations</code> 字段，旧 fixture-data.json 打开即升级，不报错、不丢其它字段',
        '【移除】夹具导入导出模板由 22 列改为 <b>17 列</b>（夹具编号 / 名称 / 机种名称1~7 / 分类 / 库位 / 产线1~5 / 备注）；旧模板的工位列不参与映射，导出→导入仍逐列同构'
      ]
    },
    {
      version: '4.5.1', date: '2026-10-19', items: [
        '【修复】导入时<b>产线名只按字面比对</b>，「1#」与「1」被补建成两条线，夹具被拆到两条同义产线上 —— 用户在「产线使用」里选哪条都看不到全部（BUG-010）。现在导入按「去 # / 去空格 / 全角转半角」归一化比对：<b>库内已有名称优先，其次文件内首个写法</b>，「1#」「1 」「１」都落到同一条线，预览顶部会明示「已自动归并：1# → 1（N 行）」',
        '【修复】「撤销本次导入」以前<b>只删夹具、不回收自动补建的产线与工位</b>，每撤销一次就留下一整套「有工位、0 夹具」的空壳线，产线下拉里越积越多（BUG-011）。现在撤销时按「先工位、后产线」回收本批新建且已无人引用的结构项，结果提示会写明回收了 N 条产线 / M 个工位',
        '【说明】归并<b>只影响落库用哪个名称</b>，不改写你的表格；「3号线」与「3」因后缀不同不会被误并，确需两条线请用可区分的名称（如「1号线」「1号备用线」）'
      ]
    },
    {
      version: '4.5.0', date: '2026-10-19', items: [
        '【修复】「下载模板」与「导出CSV」两个文件<b>列结构不一致</b>（导出多「序号 / 状态 / 累计出库 / 累计回库 / 维修次数」、机种合并成一格、少 7 列机种位）⇒ 用户拿导出表改完回灌时常整列被忽略。现在两者<b>共用同一份 22 列定义（FIX_IMPORT_HEADERS）与同一个 CSV 生成函数</b>，除模板多几行示例外逐列同构，导出文件改完可直接导入',
        '【调整】夹具清单导出不再输出「序号 / 状态 / 累计出库 / 累计回库 / 维修次数」（这些都是系统内部派生值，模板里没有）；机种按<b>机种名称1~7 拆成 7 列</b>，与模板一致。要看状态请到「夹具查询」或「流水记录」',
        '【合并】原侧边栏「🧭 按机种查询」页<b>并入「🏷 机种管理」</b>，导航项由 12 个减为 11 个；旧视图名 <code>prodquery</code> 保留别名，历史调用平滑落到机种管理，不会出现空白页',
        '【新增】机种管理里点<b>机种名称</b>即在下方展开该机种的明细：<b>按线体分组 → 工位 → 夹具</b>（夹具编号 / 名称 / 库位 / 状态 / 编辑入口），顶部汇总「夹具 N 套 ｜ 在库 M 套 ｜ 线体 K 条 ｜ 工位 J 个」；再点一次收起，选中行高亮',
        '【精度】工位归属由 <code>stations.lineId</code> 反查，<b>同名工位跨产线不串线</b>；「只关联产线未选工位」单独标注「（未指定工位）」，完全没关联产线的夹具标注「（未关联产线）」，保证有夹具就一定看得见'
      ]
    },
    {
      version: '4.4.0', date: '2026-10-19', items: [
        '【新增】夹具导入<b>幂等保护</b>：预览顶部统计「本次 N 行中有 M 行与库内已有记录完全一致」（同夹具编号 + 名称 + 库位 + 分类 + 机种 + 产线工位 + 备注），表格逐行标注<b>「重复」/「新增」</b>，默认按钮为「跳过重复，导入 N-M 条」，另提供「全部导入 N 条」',
        '【修正】同一份表重复导入不再让记录翻倍（此前第一次 3 条、第二次直接变 6 条）。判定只在「与库内已有记录」之间做<b>多重集 1:1 配对</b>，<b>不做批次内去重</b> —— 同库位放多套同号夹具属合法业务',
        '【新增】落库时写入 <code>importBatch</code> 批次号，导入结果弹窗提供<b>「↩ 撤销本次导入 N 条」</b>，按批次精确回滚，不影响此前导入或手工建档的记录',
        '【修正】「未建档产线 / 工位」对话框里选「跳过该行」此前<b>未生效</b>（skipKeys 声明后未使用）；现按产线 / 工位命中整行跳过，且不再为被跳过的行补建产线、工位',
        '【修正】整份表都被跳过时只弹一句「没有可导入的有效数据行」，用户无从定位；现改为弹窗列出<b>跳过原因统计</b>（产线为空 / 库位不合规 / 名称为空 / 机种为空）与前 10 条明细（BUG-007）'
      ]
    },
    {
      version: '4.3.0', date: '2026-10-19', items: [
        '【新增】夹具支持<b>删除</b>：卡片视图 / 列表视图 / 查询结果 / 查询详情弹窗均有「删除」入口，用于纠正<b>录错、重复建档、本不该存在</b>的记录',
        '【交互】删除前弹窗列出夹具编号、名称/序号、状态/库位与<b>关联流水条数</b>，并明确「删除后不可恢复，只是停用请改用报废」；已出库未回库 / 维修中的记录额外给出红色警告',
        '【数据】删除时<b>连带清除该夹具的全部流水</b>（报废、出库、回库、维修），避免报表与记录查询里留下指向已不存在夹具的孤儿行；主进程 store.delFixture 与浏览器 localStorage 分支口径一致',
        '【语义】「报废」与「删除」明确分工：报废 = 业务状态流转、记录留档可追溯（按钮改为普通样式）；删除 = 抹掉记录本身、不可恢复（红色按钮 + 二次确认）'
      ]
    },
    {
      version: '4.2.0', date: '2026-10-19', items: [
        '【新增】建档/编辑夹具的「分类」由自由文本改为<b>下拉选择</b>：预设常用材质（金属 / 不锈钢 / 铝合金 / PVC / 亚克力 / 橡胶 / 硅胶 / 尼龙 / 电木 / 木质 / 复合材料），选「＋ 新增分类…」可就地输入自定义分类（≤30 字符），保存后自动进入后续下拉候选',
        '【新增】「🔎 夹具查询」筛选栏增加<b>分类</b>下拉（候选 = 预设 + 已在用分类），支持按分类精确过滤',
        '【调整】夹具导入模板的产线 / 工位由「两列扁平」改为<b>成对列</b>：<code>产线1 | 工位1 | 产线2 | 工位2 … 产线5 | 工位5</code>。每对表达「这条产线下装了哪些工位」（同一产线的多个工位用 / 或 、 分隔），一行 = 一套夹具，最多 5 对',
        '【修复】旧模板「产线 × 工位」按<b>笛卡尔积</b>展开导致跨线串工位（如「3号线 + L2」与「1号工位 + 2号工位」会生成 4 个组合）；成对列改为<b>严格按「产线 → 其下工位」</b>登记与落库，不再跨产线扩散',
        '【兼容】旧版扁平「产线 / 工位」两列仍可导入，行为与升级前一致（每条产线 × 全部工位）；新版成对列优先',
        '【一致】夹具清单导出 CSV 同步改为成对列，<b>导出文件可直接作为导入模板回灌</b>；下载模板示例改为真实多产线场景（3 号线装 2 个工位、L2 U型线装 1 个工位）',
        '【校验】数据层（store.js / db.js）增加分类长度与非法字符校验（≤30 字符、不含 | 与换行），编辑保存同样做 trim'
      ]
    },
    {
      version: '4.1.0', date: '2026-10-18', items: [
        '【布局】产线示意图 <b>U 型重新排布</b>：<b>圆圈内侧</b>写工位名、<b>圆圈外侧</b>写夹具号（左列名称在圆右／编号在圆左，右列相反），底横边仍是圆上名称、圆下编号；直线形不变（没有内外之分）',
        '【布局】U 型底横排<b>收在左右两列之间</b>（x 0.22~0.78，与竖列同 x）：转角处「5号→6号」「10号→11号」由<b>斜线改为竖直</b>下落/上升，成为规则的直角 U；竖列末端 0.80→0.72、底排 0.88→0.90 留出转角空间',
        '【布局】U 型底横排夹具号<b>相邻错行</b>：偶数位贴圆（+46）、奇数位下沉（+66），同基线相邻编号隔 2 个节点间距，长编号不再首尾粘连',
        '【布局】画布<b>尺寸自适应</b>：宽度按文字宽度反推，位置不够就把图<b>拉长</b>（基准 1000、上限 2600，配 min-width 横向滚动，不把整图缩到看不清）；高度按行/列最小间距反推；底排按错行折算宽度（30 工位 + 21 字编号 → 1289×1113）',
        '【视觉】转角两个节点的工位名加<b>白色垫底</b>（.ld-plate），竖直连线从标签后面穿过，不再把字割断'
      ]
    },
    {
      version: '4.0.7', date: '2026-10-18', items: [
        '【布局】产线示意图节点改为<b>上下结构</b>：圆圈<b>上方</b>写工位名、圆圈<b>下方</b>写夹具号（实物编号），圆圈本身只表示夹具状态（实心＝已配置夹具／空心＝无配置），与右上图例一一对应；原「圆圈内顺序号 + 名称 + 编号」三层堆叠取消，编号与工位名基线相距 74px',
        '【布局】示意图画布高度改为<b>自适应</b>：按「上下相邻行/列文字间隙 ≥26px」反推画布高度（原来固定 520，U 型 5 工位/列只有 75.6px 竖列间距，装不下「圆上名称 + 圆下编号」）；直线形 ≥4 行、U 型单列 ≥5 工位时自动加高，工位少时仍用 520',
        '【调整】示意图内工位名统一为「N号工位」：去掉「1号线3号工位」里的线号前缀（线体名已在示意图标题处显示），消除同一张图里「1号线3号工位」与「4工位」并存的不一致；工位号优先从工位名解析，名称无数字时退回工位顺序号，两者皆无则按列表位置兜底',
        '【新增】示意图节点悬浮提示：显示「N号工位 · 夹具名称」，多套夹具以「 / 」分隔，无配置显示「无夹具」'
      ]
    },
    {
      version: '4.0.6', date: '2026-10-18', items: [
        '【布局】产线示意图工位节点「工位名」与「夹具编号」垂直间距拉大：编号徽标由圆点下方 40px 下移至 56px（基线距 29px，原来仅 13px），显示更宽松；直线形产线 3~4 行布点行距 95~143px，不会与下一行圆点重叠'
      ]
    },
    {
      version: '4.0.2', date: '2026-10-17', items: [
        '【布局】夹具卡片「产线：」「工位：」合并为一行「**产线/工位**」（跨产线时按 `f.lines` 顺序分段，段内工位 `/`、段间 `；`，**产线名只在段首出现一次，不再给工位名补「线号·」前缀**）；卡片「出库/送修/编辑/报废/二维码」5 个操作按钮**同一排不折行**（网格 minmax 220px→240px、按钮内距收紧 3px 5px、字号 11.5px、white-space: nowrap）',
        '【布局】「🔎 夹具查询」详情弹窗「涉及产线」「安装工位」两行并入「**产线/工位**」一行（同用合并显示函数，弹窗矮了 3 行）',
        '【交互】建档表单「产线工位」工具区（选择产线 / 选择工位 / + 添加）改为**同行排列**（form-group-row 布局：标签左上、.ls-box 占满剩余宽度；两下拉 flex: 0 1 auto、max-width 240/220，足够宽时与「+ 添加」「计数」同行，不足时自动换行）',
        '【修复】启动加载时 `store.migrate()` 新增第 7 步——给所有缺 `id` 的旧夹具记录按 `nextId()` 补主键（幂等、不冲突），解决「卡片点编辑误开新建」的历史问题（旧样本数据遗留）',
        '【显示】序号一律**纯数字**（去掉 `#` 前缀），涉及弹窗夹具栏、5 个表格序号列、卡片徽标、库位明细、已选清单、各弹窗标题兜底、打印标签标题、盘点名单、产线示意图节点徽标',
        '【二维码】二维码内容改为**纯序号**（如 `1001`），去掉 `SPMS1|` 前缀；`makeQRToken` 直接返回 `String(f.code)`；扫码端保留前缀剥离正则，**旧标签仍可正常扫**'
      ]
    },
    {
      version: '4.0.1', date: '2026-10-16', items: [
        '【修复】夹具批量导入不再因「产线 / 工位未建档」而整行跳过：未建档的产线 / 工位改为按名称<b>自动补建</b>（同名复用、不重复创建），合格的表格数据可一次性完整导入',
        '【调整】术语统一（显示层）：原「实物编号」显示名改为「<b>夹具编号</b>」，原「桥梁编号 / 桥梁号」显示名改为「<b>序号</b>」；底层字段 serialNo / code 不变，旧 Excel 模板表头「实物编号」仍作为导入别名识别'
      ]
    },
    {
      version: '4.0.0', date: '2026-10-16', items: [
        '【重构·不兼容】数据模型改为「每套夹具一条记录」：实物编号 serialNo 允许重复（同一编号可有多套、分布在不同库位），数量不再存储，一律按「实物编号 + 库位」分组<b>派生</b>得出；出库只改状态，派生数量自动减 1',
        '【重构·不兼容】桥梁编号 code 收敛为 4 位纯数字、系统自动分配（1001 起、填补空洞），仅作各环节的唯一标识与二维码内容，<b>不参与模糊搜索</b>；实物编号 serialNo 成为主搜索键，必须手工输入',
        '【重构·不兼容】关联模型扁平化：废弃 stationFixtures 集合（6 → 5 个集合），夹具记录直接携带 lines（涉及产线，1~5 条）与 stations（安装工位，1~10 个）；删除产品/产线/工位时改为遍历夹具全表摘除 id',
        '【新增】新建 / 编辑夹具表单：按产线分扇区的折叠控件选工位（原生多选下拉无法表达工位归属），选中工位自动补入其所属产线，移除产线连带移除该产线下已选工位；建档强校验 7 条（≥1 产线 ≥1 工位、≤5 产线 ≤10 工位、工位必须属于已选产线）',
        '【新增】夹具「编辑」功能（此前程序无编辑入口）：可改实物编号 / 名称 / 机种 / 库位 / 分类 / 产线 / 工位 / 备注；桥梁编号不可改（改则断流水与产线绑定）',
        '【新增】机种管理页（侧边栏「🏷 机种管理」）：机种不隶属产线，独立维护受控字典；被夹具引用时禁止删除，重命名自动写穿到全部夹具记录',
        '【新增】按机种查询页（侧边栏「🔗 按机种查询」）：选择机种 → 反查夹具（1 跳）→ 展开涉及产线，输出固定的「产线 / 实物编号 / 桥梁号 / 库位 / 状态」列并按机种分组',
        '【新增】夹具查询页第①段「按实物编号查询」：按「实物编号 × 库位」分组统计，行内分列在库 / 在外 / 维修中 / 已报废 / 台账；合计行沿用同列求和（在库、在外分列），台账作小字说明',
        '【新增】机种名称上限由 4 个提升到 7 个；多选下拉（禁重名），支持从字典选择或现场输入新增',
        '【调整】产线使用页：去掉「线体 → 产品」级联，直接按线体展示各工位的夹具（只读），表格列改为实物编号 / 桥梁号 / 夹具名称 / 状态；产线示意图节点徽标改显示实物编号',
        '【调整】产线配置页：删除「产品」面板（机种已独立）；「工位夹具配置」由覆盖式写入改为<b>只读视图</b>，可点击夹具名直接编辑，或经「编辑夹具」挑选该工位上的夹具',
        '【调整】产线配置导入：表头改为「线体 | 线体形态 | 工位 | 工位顺序 | 夹具编号 | 备注」，「夹具编号」列语义反转为<b>向夹具追加产线/工位</b>（按实物编号唯一匹配，0 或 >1 条计入跳过）；写库为追加 + 去重，绝不覆盖原有内容；导入完成后可一键「撤销本次导入」精确回滚',
        '【调整】标签与二维码：二维码只编码桥梁编号（qrToken 改为派生值，不再落库）；标签卡只印实物编号 + 夹具名称（移除机种与库位），接受「码磨损后重新打印」的取舍',
        '【调整】出库必选库位（建档漏填时要求本次补填），库位在出库时冻结保留供回库预填；回库可改库位并写入，流水留痕 fromLocation / toLocation',
        '【调整】库位管理页卡片数字改为<b>在库套数</b>（过滤状态，此前把已出库的也计为在库），另以悬浮提示补充不在库数量；明细表新增实物编号 / 桥梁号 / 产线 / 工位四列',
        '【调整】库位号统一为 4 段式（如 ZP1-U-1-1），上限 20 字符，录入时提供候选下拉（从现有库位去重生成，不新建集合）',
        '【修复】批量导入预览必然崩溃：showImportPreview 实参错位（传入 plan.plan）导致 plan.skipped 取到 undefined、读 .length 抛 TypeError；已修正为传入完整结果对象',
        '【修复】机种超过上限时被静默截断而非报错；现改为显式拒绝并提示上限',
        '【修复】出库/回库过程中先自增计数再校验库位合法性，抛错时留下「文件未落盘但内存已改」的脏状态；校验已前移到任何内存改动之前',
        '【修复】建档强校验的判定顺序在渲染层与数据层不一致（渲染层先判工位、数据层先判产线），空表单提交会提示「请至少选择 1 个工位」；已统一为「产线 → 工位」顺序，提示与真实缺失项一致',
        '【迁移】启动时自动升级旧数据：spec + lineNo 合并进 lineModels（上限放宽到 7，不再截断到 4）；products 按名称去重转为 productions{id,name,order}；补 lines/stations/serialNo 空值；删除 qrToken 与 stationFixtures/products',
        '【更名】程序名称保持「工装夹具管理程序」，版本升至 v4.0.0（MAJOR：数据模型与接口不兼容）'
      ]
    },
    {
      version: '3.0.1', date: '2026-10-16', items: [
        '【新增】产线使用模块（侧边栏「🔗 产线使用」）：按「线体 + 产品」级联筛选，展示该产品在各工位上使用的夹具配置，并在表格下方以示意图呈现产线布局',
        '【新增】筛选区级联：切换线体自动重置并重建产品下拉；线体/产品任一无数据时给出明确空态提示',
        '【新增】工位夹具配置表：字段为工位名称、工位顺序、夹具编号、夹具名称、规格/型号、备注；工位按顺序号升序排列，同一工位多个夹具以多行（rowspan 合并工位列）展示，无配置的工位显示「—」「无」',
        '【新增】产线示意图（SVG）：按线体形态绘制——直线形按工位顺序横向折行（每行最多 6 个，行间折返连线）；U型沿左侧竖边下行、经底部横边、再沿右侧竖边上行，按三段实际长度等分工位；每个工位标注顺序号、名称与夹具编号，有夹具配置的工位高亮，无配置的为空心灰点并标注「无」',
        '【新增】产线配置管理页（侧边栏「⚙️ 产线配置」）：① 线体（名称/形态/备注）② 产品（隶属线体）③ 工位（名称/顺序/备注）与工位夹具绑定；删除父级自动级联清理子级与绑定',
        '【新增】线体形态作为线体属性手工指定，只有两种：直线形 / U型，决定查询页示意图的画法；早期版本数据里的「环形」（loop / circle / ring）自动折算为 U型显示与绘制，不写回数据文件',
        '【新增】工位夹具绑定支持一对多：一个工位可绑定多个夹具编号，输入支持一行一个或用逗号/顿号/分号分隔，重复自动去重',
        '【新增】产线配置 Excel/CSV 导入：一张平坦表维护「线体·产品·工位·夹具编号」，按名称自动补建线体/产品/工位（同名复用不重复创建），导入前弹预览确认；重复导入结果一致（幂等），绑定为覆盖式写入',
        '【新增】产线配置导入模板下载（含 5 行示例，覆盖一工位多夹具、某工位无夹具等场景）',
        '【容错】夹具编号未建档时表格标为「编号未建档」并统计数量，便于核对；工位顺序支持空值（排序时置于末尾）',
        '【数据】新增 lines / products / stations / stationFixtures 四个集合，随 fixture-data.json 一并落盘；旧数据文件自动兼容（缺集合时按空数组处理）',
        '【更名】程序名称由「工装夹具出入库管理系统」改为「工装夹具管理程序」（窗口标题、侧边栏品牌名、页脚、关于面板、发布 exe 文件名同步更新）',
        '【调整】线体形态收敛为两种：<b>直线形 / U型</b>，此前的「环形」不再作为独立形态；U型示意图按「左竖边 → 底横边 → 右竖边」的三段实际长度等分工位，视觉疏密一致',
        '【测试】新增 test_line.js（135 项）：覆盖数据层 CRUD 与级联删除、线体形态解析（含历史「环形」折算）、工位排序（含无顺序号置末尾）、工位夹具配置表构建、产线图布局与渲染、导入映射与端到端落库幂等；既有 test_store 56 项、test_render 40 项、test_xlsx 35 项、test_import 49 项、test_e2e_import 34 项全绿，另有真实 Electron 端到端 test_e2e 121 项（含产线模块 UI 全链路与级联删除），合计 470 项零失败'
      ]
    },
    {
      version: '2.3', date: '2026-10-16', items: [
        '【新增】夹具批量导入：支持 Excel（.xlsx）与 CSV，夹具管理页顶部新增「⬆ 导入Excel/CSV」与「📄 下载模板」按钮',
        '【新增】导入前弹出预览表格（最多 60 行），看清将要写入什么再点「确认导入」，避免误操作',
        '【新增】表头模糊匹配：列顺序任意、支持别名（如「编码/夹具编号」「存放位置」「适用机种」「类别」），自动忽略多余列；表头中的括号注释与冒号会自动剥离',
        '【新增】编号容错：编号为空 / 非 4 位纯数字 / 与已有重复时，自动分配下一个空闲 4 位号（并填补编号空洞），不丢数据',
        '【新增】机种名称既支持 1~4 独立列，也支持单个「机种名称」列内用逗号/分号分隔多个；自动去重、最多保留 4 个',
        '【新增】下载导入模板（CSV，含 2 行示例），Excel 可直接打开另存为 .xlsx 后填写',
        '【新增】主进程内置极简 xlsx 解析器（js/xlsx_reader.js，零第三方依赖）：自行解 zip（deflate/stored）、解析 sharedStrings 与工作表 XML，支持共享字符串/inlineStr/数值/稀疏列',
        '【新增】多工作表文件默认读取第 1 张并提示已选表名；解析失败给出明确中文错误（如提示 .xls 需另存为 .xlsx）',
        '【测试】新增 test_xlsx.js（35 项）、test_import.js（49 项）、test_e2e_import.js（34 项，真实 xlsx → 解析 → 落库端到端）；既有 test_store 56 项、test_render 37 项全绿，合计 211 项零失败'
      ]
    },
    {
      version: '2.2', date: '2026-09-09', items: [
        '【新增】夹具查询模块：多条件组合检索（编号/名称/机种/库位下拉/状态 chip 多选/借用人/关键字模糊），结果表含位置派生标签、责任人、状态、最近操作时间',
        '【新增】查询结果支持详情弹窗与「定位到库位」跳转（关闭弹窗后设库位筛选并切到库位视图），无结果时明确提示',
        '【修复】查询筛选栏「排序」字段因纵向布局导致下拉框与方向按钮堆叠、与同行控件错位，改为横排对齐',
        '【发布】修复版本号两位数导致的 CI 构建失败（electron-builder 要求完整 semver），workflow 改为展示层输出两位短版本；GitHub Release v2.2 已正常构建发布'
      ]
    },
    {
      version: '2.1', date: '2026-09-08', items: [
        '【改造】新建夹具表单将原「规格型号」「所属线号」合并升级为「机种名称1~4」，最多可同时关联 4 个机种；数据模型改为 lineModels 数组',
        '【兼容】启动时自动把旧版 spec / lineNo 字段迁移到 lineModels[0]，最多保留 4 项，保障历史数据可用',
        '【检索】夹具搜索、出库/回库候选列表、卡片、列表视图、二维码、打印标签、CSV 导出/盘点均按 lineModels 展示，任一机种名称命中即可匹配'
      ]
    },
    {
      version: '1.9', date: '2026-09-08', items: [
        '【优化】关于面板「变更日记」的版本标题去掉日期后缀，仅显示版本号（如 v1.9），更简洁',
        '【同步】合并 GitHub 仓库最新改动，保持本地开发源与远端代码一致'
      ]
    },
    {
      version: '1.8', date: '2026-09-07', items: [
        '【新增】夹具列表「卡片 / 列表」视图切换：列表视图以表格紧凑展示编号/名称/规格/分类/库位/状态/累计出库/累计回库 + 操作按钮',
        '【修复】补齐表格样式（table-wrap/table/th/td/行悬停/选中高亮，此前缺失导致库位明细表无样式）',
        '【修复】「维修完成」按钮类名 btn-primary 拼写错误（应为 primary），主色背景此前未生效'
      ]
    },
    {
      version: '1.7', date: '2026-09-07', items: [
        '【新增】夹具二维码标签：每张夹具卡片「二维码」按钮查看二维码（编号/名称/规格/库位），支持下载 PNG',
        '【新增】标签打印：单个/批量打印标签，含打印设置面板（纸张尺寸/水平垂直对齐/页边距/份数）与实时预览',
        '【新增】「🏷 批量打印标签」按钮（夹具管理页顶部），主进程 webContents.print 精确送印'
      ]
    },
    {
      version: '1.6', date: '2026-09-07', items: [
        '【新增】库位管理模块：10 列网格总览（三行可视、上下滑动浏览），点击进入筛选查看该库位夹具明细',
        '【新增】库位「手工盘点」CSV 导出：按夹具逐项明细导出，盘点人导出时录入（模态框输入，非原生 prompt）',
        '【新增】库位排序：按库位编号自然升序（数字按数值序）、「（未分配）」置于末尾，点选后保留滚动位置',
        '【优化】编号归一化匹配：忽略大小写 / 连字符 / 下划线 / 空格，扫描枪录入差异也能查到',
        '【补充】补齐 table-wrap / badge / tip / spacer 等工具类样式（此前多处引用但未定义）'
      ]
    },
    {
      version: '1.5', date: '2026-09-07', items: [
        '【调整】界面风格与备件仓库管理系统对齐：侧边栏底部「本地存储 · 无需联网」改为 design by Frank, 2026.7',
        '【调整】「关于 / About」由底部状态栏按钮改为右下角蓝色浮动胶囊按钮',
        '【调整】关于面板改用「变更日记」滚动区 + 鸣谢样式，与备件系统一致'
      ]
    },
    {
      version: '1.4', date: '2026-09-07', items: [
        '【优化】出库/回库改为「编号/名称/规格/库位」四栏互查，命中唯一自动回填，多命中点选',
        '【优化】记录查询搜索框兼容二维码前缀 SPMS1| / SPMS|',
        '【优化】搜索框增加中文输入法（IME）守卫，中文组合输入期间不打断',
        '【新增】关于 / About 面板（变更日记）'
      ]
    },
    {
      version: '1.3', date: '2026-09-07', items: [
        '【修复】启动后弹出空白「标题」模态框：CSS 增加 [hidden]{display:none!important}，覆盖 .modal-overlay 的 display:flex'
      ]
    },
    {
      version: '1.2', date: '2026-09-07', items: [
        '【修复】窗口只剩标题框/无法关闭：受限环境 Chromium 沙箱无法初始化导致 GPU 进程 FATAL 崩溃',
        '【修复】main.js 内置 no-sandbox + disable-gpu 开关，双击即生效',
        '【修复】修正 Node 路径与构建流程，重新构建并发布到 D:/project/fixture'
      ]
    },
    {
      version: '1.1', date: '2026-09-04', items: [
        '【调整】移除 portable 单文件版，改为解包目录版发布',
        '【新增】扫码集成、批量扫码出库、维修记录表单、维修完成回库',
        '【修复】维修完成流水类型、维修子类型丢失、清空数据不落盘、原生弹窗阻塞、showView 未挂载、CSS 路径错误、回库流程缺失'
      ]
    },
    { version: '1.0', date: '2026-09-04', items: ['夹具管理系统初始版本：建档、出库、回库、送修、报废、流水记录、数据备份'] }
  ];

  /* 鸣谢名单（贡献宝贵意见的同事）。放在常量区，改名单只改这一处。 */
  const THANKS_NAMES = ['薛添才', '朱近', '林长平', '林捷', '林详杰', '陈旭'];

  window.openAbout = function () {
    const html = `
      <div class="about-panel">
        <div class="about-scroll">
          <h3 class="about-h">变更日记</h3>
          ${CHANGELOG.map((log) => `
            <h4 class="about-ver">v${log.version}</h4>
            <ul class="about-list muted">
              ${log.items.map((it) => `<li>${esc(it)}</li>`).join('')}
            </ul>
          `).join('')}
        </div>
        <h3 class="about-h">鸣谢</h3>
        <p class="about-thanks">感谢以下同事提供的宝贵意见：<br><strong>${esc(THANKS_NAMES.join('、'))}</strong></p>
        <p class="about-version muted">当前版本：v${DB.APP_VERSION} · 数据文件：程序所在目录 fixture-data.json · 本地存储 · 无需联网</p>
      </div>
    `;
    openModal('关于 / About', html);
  };
  /* 兼容别名（旧版 onclick="showAbout()"） */
  window.showAbout = window.openAbout;

  /* ---------------- 视图切换 ---------------- */
  const VIEW_TITLES = {
    dashboard: '仪表盘',
    fixtures: '夹具管理',
    outbound: '夹具出库',
    return: '夹具回库',
    location: '库位管理',
    records: '流水记录',
    query: '夹具查询',
    prod: '机种管理',
    linequery: '产线使用',
    linecfg: '产线配置',
    staff: '人员卡库',
    fixanomaly: '⚠️ 异常工装',
    data: '数据备份'
  };
  const RENDERERS = {
    dashboard: renderDashboard,
    fixtures: renderFixtures,
    outbound: renderOutbound,
    return: renderReturn,
    location: renderLocation,
    records: renderRecords,
    query: renderQuery,
    prod: renderProduction,
    linequery: renderLineQuery,
    linecfg: renderLineConfig,
    staff: renderStaff,
    fixanomaly: renderFixAnomaly,
    data: renderData
  };

  /* v4.5.0：「按机种查询」已合并进「机种管理」，旧视图名做别名，绝不出现空白页 */
  const VIEW_ALIAS = { prodquery: 'prod' };

  function showView(name) {
    name = VIEW_ALIAS[name] || name;
    state.view = name;
    $('#viewTitle').textContent = VIEW_TITLES[name] || '';
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $('#content').scrollTop = 0;
    renderTopStats();
    const r = RENDERERS[name] || renderDashboard;
    /* 出库 / 回库要按卡号反查姓名，切换前先刷新人员卡库；
       若用户已切走则丢弃本次渲染，避免覆盖新页面。 */
    if (name === 'outbound' || name === 'return') {
      reloadStaff().catch(() => {}).then(() => { if (state.view === name) r(); });
    } else {
      r();
    }
  }
  window.showView = showView;

  function renderTopStats() {
    const stocked = state.fixtures.filter((f) => f.status === 'stocked').length;
    const out = state.fixtures.filter((f) => f.status === 'checked_out').length;
    const repair = state.fixtures.filter((f) => f.status === 'repair').length;
    const retired = state.fixtures.filter((f) => f.status === 'retired').length;
    $('#topStats').innerHTML =
      `总计 <b>${state.fixtures.length}</b> ｜ 在库 <b class="stat-ok">${stocked}</b> ｜ 已出库 <b class="stat-warn">${out}</b> ｜ 维修 <b class="stat-danger">${repair}</b> ｜ 报废 <b class="stat-muted">${retired}</b>`;
  }

  /* ============================================================
   * 仪表盘
   * ============================================================ */
  async function renderDashboard() {
    // 仪表盘要展示机种/产线数量，需按需补拉一次结构数据
    try { await reloadLineConfig(); } catch (e) { /* 读不到按空处理 */ }
    if (state.view !== 'dashboard') return;
    const stocked = state.fixtures.filter((f) => f.status === 'stocked').length;
    const out = state.fixtures.filter((f) => f.status === 'checked_out').length;
    const repair = state.fixtures.filter((f) => f.status === 'repair').length;
    const retired = state.fixtures.filter((f) => f.status === 'retired').length;
    const totalOut = state.fixtures.reduce((s, f) => s + (f.totalOutCount || 0), 0);
    const totalReturn = state.fixtures.reduce((s, f) => s + (f.totalReturnCount || 0), 0);
    const totalRepair = state.fixtures.reduce((s, f) => s + (f.repairCount || 0), 0);

    $('#content').innerHTML = `
      <div class="panel">
        <div class="panel-title">📊 数据概览</div>
        <div class="stats-bar">
          <div class="stat-item"><span class="stat-label">夹具总数</span><span class="stat-value">${state.fixtures.length}</span></div>
          <div class="stat-item"><span class="stat-label">在库</span><span class="stat-value stat-ok">${stocked}</span></div>
          <div class="stat-item"><span class="stat-label">已出库</span><span class="stat-value stat-warn">${out}</span></div>
          <div class="stat-item"><span class="stat-label">维修中</span><span class="stat-value stat-danger">${repair}</span></div>
          <div class="stat-item"><span class="stat-label">已报废</span><span class="stat-value stat-muted">${retired}</span></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">📈 累计统计</div>
        <div class="stats-bar">
          <div class="stat-item"><span class="stat-label">累计出库</span><span class="stat-value">${totalOut}</span></div>
          <div class="stat-item"><span class="stat-label">累计回库</span><span class="stat-value">${totalReturn}</span></div>
          <div class="stat-item"><span class="stat-label">累计维修</span><span class="stat-value">${totalRepair}</span></div>
          <div class="stat-item"><span class="stat-label">流水记录</span><span class="stat-value">${state.fixTransactions.length}</span></div>
          <div class="stat-item"><span class="stat-label">机种</span><span class="stat-value">${(state.productions || []).length}</span></div>
          <div class="stat-item"><span class="stat-label">产线</span><span class="stat-value">${(state.lines || []).length}</span></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">🧮 数据模型说明（v5.0.0）</div>
        <div style="padding:16px; line-height:2;">
          <p>📦 <b>一套一条记录</b>：同一夹具编号可以有多套，分布在不同库位；<b>数量不存储</b>，一律按「夹具编号 + 库位」分组实时统计。</p>
          <p>🔗 <b>序号</b>：系统自动分配的 4 位数字，唯一标识每一套，也是二维码内容；<b>不参与模糊搜索</b>。</p>
          <p>📝 <b>夹具编号</b>：手工录入、允许重复（同机种多套共用），是日常检索的主键。</p>
          <p>🏭 <b>产线</b>：在夹具建档时选择（1~5 条产线）；机种是独立字典，<b>不隶属产线</b>。v5.0.0 起<b>不再有工位</b>，夹具只关联到产线。</p>
          <p>🗄 <b>库位</b>：4 段式编号（如 ZP1-U-1-1），出库时冻结保留，回库时可修改。</p>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">🔩 状态说明</div>
        <div style="padding:16px; line-height:2;">
          <p>🟢 <b>在库</b>：夹具存放在仓库，可被领用</p>
          <p>🟡 <b>已出库</b>：夹具已被领用人取走，正在使用</p>
          <p>🔴 <b>维修中</b>：夹具送修或保养，不可用</p>
          <p>⚫ <b>已报废</b>：夹具损坏无法修复，已剔除</p>
        </div>
      </div>
    `;
  }

  /* ============================================================
   * 刷卡录入组件（v5.1.0）
   *
   * 硬件约定：USB / IC 读卡器工作在「键盘模拟（HID）」模式 —— 刷卡后逐字符
   *   输入卡号，并以一个 Enter 结尾。因此不需要任何驱动或额外接口，只要在输入框
   *   上监听 keydown 的 Enter 就能拿到完整卡号。
   *   ⚠️ 页面级 handleKeyDown 会把 out_ / return_ 前缀输入框的回车当成「提交」，
   *      刷卡框若沿用这些前缀，刷一下卡就会直接出库。因此刷卡框统一用 swipe_ 前缀，
   *      并在这里 preventDefault + stopPropagation 双重拦截。
   *
   * 三处使用：出库页（out）、回库页（ret）、单件出库弹窗（dlg）。
   * ============================================================ */
  const SWIPE_CTX = {
    out: { partyLabel: '领用人', partyId: '#swipe_out_party' },
    ret: { partyLabel: '退库人', partyId: '#swipe_ret_party' },
    dlg: { partyLabel: '领用人', partyId: '#swipe_dlg_party' },
    rdlg: { partyLabel: '退库人', partyId: '#swipe_rdlg_party' }
  };

  function swipeHintText() {
    return '刷卡后自动带出姓名与部门（卡需已在「👤 人员卡库」登记并启用）';
  }

  /* 生成一个刷卡输入位（HTML 片段）
   * v5.6.0：经办位整块取消，出库只有「领用人」、回库只有「退库人」，因此不再传 role。 */
  function swipeFieldHtml(ctx) {
    const c = SWIPE_CTX[ctx];
    const id = c.partyId.slice(1);
    const label = c.partyLabel;
    return `
      <div class="form-group">
        <label>${label} *</label>
        <div class="swipe-box">
          <input type="text" id="${id}" data-swipe="${ctx}" autocomplete="off"
            placeholder="💳 刷${label}工牌，或手工输入卡号后回车">
          <span class="swipe-state" id="${id}_state">未刷卡</span>
        </div>
        <small class="hint" id="${id}_tip">${swipeHintText()}</small>
      </div>`;
  }

  function bindSwipe(ctx) {
    const c = SWIPE_CTX[ctx];
    const el = $(c.partyId);
    if (!el || el.dataset.swipeBound) return;
    el.dataset.swipeBound = '1';
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // 刷卡器以回车收尾：拦死，绝不能冒泡到页面级「回车提交」
      e.preventDefault(); e.stopPropagation();
      resolveSwipe(ctx);
    });
    // 手工输入后离开输入框也复验一次，避免「填了但没按回车」导致提交时才报错
    el.addEventListener('change', () => resolveSwipe(ctx));
  }

  /* 解析一个刷卡位：查库 → 停用校验 → 渲染状态徽标 → 记录到 state
   * v5.6.0：经办位取消后不再按角色限制 —— 只要卡已登记且启用就能刷。
   *         历史「经办人」角色的人照样能刷领用/退库位（否则老卡就废了）。 */
  function resolveSwipe(ctx) {
    const c = SWIPE_CTX[ctx];
    const el = $(c.partyId);
    if (!el) return { ok: false, empty: true };
    const raw = String(el.value || '').trim();
    const stEl = $('#' + el.id + '_state');
    const tipEl = $('#' + el.id + '_tip');
    const label = c.partyLabel;

    const setState = (cls, txt, tip) => {
      if (stEl) { stEl.className = 'swipe-state' + (cls ? ' ' + cls : ''); stEl.textContent = txt; }
      if (tipEl) { tipEl.className = 'hint' + (cls === 'err' ? ' err' : ''); tipEl.textContent = tip; }
    };

    if (!raw) {
      state.swipePick[ctx].party = 0;
      setState('', '未刷卡', swipeHintText());
      return { ok: false, empty: true };
    }

    const s = findStaffLocal(raw);
    if (!s) {
      state.swipePick[ctx].party = 0;
      setState('err', '未登记', `卡号 ${raw} 未在人员卡库登记 —— 请到「👤 人员卡库」新增该卡（姓名登记一次即可复用）`);
      return { ok: false, msg: `${label}卡号 ${raw} 未登记，请先到「👤 人员卡库」登记` };
    }
    if (s.active === false) {
      state.swipePick[ctx].party = 0;
      setState('err', '已停用', `「${s.name}」的卡已停用，不能用于出入库；如确需使用请到「👤 人员卡库」重新启用`);
      return { ok: false, msg: `${label}「${s.name}」的卡已停用` };
    }

    state.swipePick[ctx].party = s.id;
    setState('ok', `${s.name}${s.dept ? ' · ' + s.dept : ''}`, `✓ 卡号 ${normCard(s.cardNo)} ｜ ${STAFF_ROLE_LABEL[s.role] || s.role || '—'}`);
    return { ok: true, staff: s };
  }

  /* 提交前的校验：该位必须刷、必须过（v5.6.0 单人版，双人复核已取消） */
  function validateSwipe(ctx) {
    const c = SWIPE_CTX[ctx];
    const r = resolveSwipe(ctx);
    if (!r.ok && r.empty) return { ok: false, msg: `请刷${c.partyLabel}的工牌（卡号不能为空）` };
    if (!r.ok) return { ok: false, msg: r.msg || `${c.partyLabel}刷卡未通过` };
    return { ok: true, party: r.staff };
  }

  /* ============================================================
   * 夹具管理
   * ============================================================ */
  window.fixtureSelect = function (id) {
    state.fixSelectedId = id;
    $$('.fixture-card').forEach((c) => c.classList.toggle('selected', c.dataset.id == id));
    $$('#fixture_list tbody tr').forEach((r) => r.classList.toggle('selected', r.dataset.id == id));
    renderFixTransactions($('#fix_tx_list'), state.fixTransactions, id);
  };

  window.fixtureOut = function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) { toast('夹具不存在', 'err'); return; }
    if (f.status !== 'stocked') { toast('夹具当前不在库', 'err'); return; }
    /* 库位在出库时冻结不变；仅当建档漏填时才要求本次补填（「出库必选库位」的落地） */
    const needLoc = !f.location;
    const locList = locationCandidates().map((v) => `<option value="${esc(v)}"></option>`).join('');
    const html = `
      <div class="form-group"><label>夹具</label><input type="text" value="${esc(f.serialNo || '（未填编号）')} ${esc(f.name)}（序号 ${esc(f.code)}）" disabled></div>
      <div class="form-group"><label>库位 ${needLoc ? '<span class="req">*</span>' : ''}</label>
        ${needLoc
          ? `<input type="text" id="fix_out_loc" list="fix_out_loc_list" placeholder="该夹具尚未设置库位，请补填（如 ZP1-U-1-1）" maxlength="${MAX_LOCATION}">
             <datalist id="fix_out_loc_list">${locList}</datalist>`
          : `<input type="text" value="${esc(f.location)}" disabled><small class="hint">出库不改动库位，回库时默认预填该值</small>`}
      </div>
      ${swipeFieldHtml('dlg')}
      <div class="form-group"><label>出库原因 <span class="req">*</span></label>
        <select id="fix_out_reason" style="width:100%; padding:8px; border:1px solid var(--border); border-radius:6px;">
          <option value="use">使用</option>
          <option value="repair">维修</option>
        </select>
        <small class="hint">选「维修」时该套夹具的维修次数 +1（与「送修」流水同口径）</small>
      </div>
      <div class="form-group"><label>出库时间</label><input type="datetime-local" id="fix_out_time" value="${nowInput()}"></div>
      <div class="form-group"><label>备注</label><input type="text" id="fix_out_remark" placeholder="可选备注"></div>
      <div class="form-actions">
        <button class="btn primary" onclick="submitFixtureOut(${id})">确认出库</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    openModal(`出库 — ${f.serialNo || f.code} ${f.name}`, html);
    /* 弹窗渲染完再绑刷卡：openModal 会整体替换 modalBody，提前绑会绑到游离节点上 */
    state.swipePick.dlg = { party: 0 };
    bindSwipe('dlg');
    const partyEl = $('#swipe_dlg_party');
    if (partyEl) partyEl.focus();
  };

  window.submitFixtureOut = async function (id) {
    const v = validateSwipe('dlg');
    if (!v.ok) { toast(v.msg, 'err'); return; }
    /* v5.6.0：经办位取消，只记一个人；operator / operatorCard 留空以兼容历史字段与旧流水 */
    const operator = '';
    const operatorCard = '';
    const counterparty = v.party.name;
    const partyCard = normCard(v.party.cardNo);
    const time = inputToMs($('#fix_out_time').value);
    const remark = ($('#fix_out_remark') || {}).value.trim();
    const locEl = $('#fix_out_loc');
    const location = locEl ? locEl.value.trim() : '';
    const reasonEl = $('#fix_out_reason');
    const outReason = reasonEl && reasonEl.value === 'repair' ? 'repair' : 'use';
    if (locEl && !isValidLocation(location)) { toast('库位号需为 4 段式（如 ZP1-U-1-1）', 'err'); return; }
    try {
      await DB.fixtureAddTransaction({ fixtureId: id, type: 'out', operator, counterparty, operatorCard, partyCard, time, remark, location: location || undefined, outReason });
      closeModal();
      await reloadAll();
      renderFixtures();
      toast('出库成功', 'ok');
    } catch (e) { toast('出库失败：' + e.message, 'err'); }
  };

  /* ============================================================
   * 建档 / 编辑夹具表单
   *
   * 三段式：① 基本信息（夹具编号 / 名称 / 库位 / 分类 / 备注）
   *         ② 机种名称（≤MAX_LINE_MODELS，输入框 +「添加」→ 标签区，多个用 / 分隔）
   *         ③ 关联产线（下拉 +「添加」→ 标签区；≥1 条、≤5 条）
   *
   * ⚠️ 表单内的「产线 / 机种」暂存在 state.fixForm，重绘只重写
   *    #fix_ls_box / #fix_lm_chips 两个容器，其余输入框不受影响（不丢已填内容）。
   * ⚠️ 桥梁编号 code 由系统自动分配（4 位纯数字），用户不可填、编辑时不可改。
   * ============================================================ */
  function resetFixForm() {
    state.fixForm = { editId: 0, lineModels: [], lines: [] };
    lsResetPick();
  }
  window.resetFixForm = resetFixForm;   // 表单「取消」按钮为内联 onclick，必须挂到 window

  /* ---- 机种名称：输入框（草稿）+「添加」按钮 → 下方标签区 ----
   * 输入框只是草稿，点「添加」（或按回车）才并入下方标签区并清空输入框，
   * 便于连续录入；分隔符与批量导入保持一致（, ， ; ； / 、），一次可加入多个。
   * 标签区（state.fixForm.lineModels）是唯一数据源；也可借 <datalist>
   * 从机种字典下拉选取。未登记的新名称按「孤儿机种」处理（可在「机种管理」
   * 一键补登），不阻塞建档。 */
  const MODEL_SEP = /[,，;；/、]/;

  function parseModelText(text) {
    const out = [];
    String(text == null ? '' : text).split(MODEL_SEP).forEach((v) => {
      const s = v.trim();
      if (s && !out.includes(s)) out.push(s);
    });
    return out;
  }

  // 「添加」按钮可用态：已满 or 草稿为空 → 禁用
  function syncLmAddBtn() {
    const btn = $('#fix_lm_addbtn');
    if (!btn) return;
    const inp = $('#fix_lm_text');
    const full = state.fixForm.lineModels.length >= MAX_LINE_MODELS;
    btn.disabled = full || !(inp && inp.value.trim());
    btn.title = full ? '已达上限（' + MAX_LINE_MODELS + ' 个）' : '加入下方机种';
  }

  // 只重绘标签区与计数，不动输入框（草稿由调用方管理）
  function renderLineModelChips() {
    const box = $('#fix_lm_chips');
    const arr = state.fixForm.lineModels;
    if (box) {
      box.innerHTML = arr.length
        ? arr.map((m, i) => `<span class="chip-tag">${esc(m)}<button type="button" class="chip-x" title="移除" onclick="fixFormRemoveModel(${i})">×</button></span>`).join('')
        : '';
    }
    const cnt = $('#fix_lm_count');
    if (cnt) cnt.textContent = arr.length + ' / ' + MAX_LINE_MODELS;
    syncLmAddBtn();
  }

  // 输入框变化：只是草稿，不即时入列，仅刷新「添加」按钮可用态
  window.fixFormDraftInput = function () { syncLmAddBtn(); };

  // 输入框回车 = 点「添加」
  window.fixFormModelsKeydown = function (e) {
    if (e && (e.key === 'Enter' || e.keyCode === 13)) {
      e.preventDefault();
      window.fixFormModelsInput();
    }
  };

  // 点「添加」（或提交前兜底）：把草稿解析后并入标签区 → 去重 → 截断 → 清空草稿
  window.fixFormModelsInput = function () {
    const inp = $('#fix_lm_text');
    const raw = parseModelText(inp ? inp.value : '');
    const valid = [], invalid = [];
    raw.forEach((n) => { (isValidProductionName(n) ? valid : invalid).push(n); });

    const listed = state.fixForm.lineModels;
    const before = listed.length;
    valid.forEach((n) => { if (!listed.includes(n)) listed.push(n); });
    const allDup = valid.length > 0 && listed.length === before;   // 输入项全都已在列表中
    let over = 0;
    if (listed.length > MAX_LINE_MODELS) { over = listed.length - MAX_LINE_MODELS; listed.length = MAX_LINE_MODELS; }

    if (inp) { inp.value = ''; try { inp.focus(); } catch (e) { /* 忽略 */ } }
    renderLineModelChips();
    const hint = $('#fix_lm_hint');
    if (hint) {
      const msgs = [];
      if (over) msgs.push('超过 ' + MAX_LINE_MODELS + ' 个，仅保留前 ' + MAX_LINE_MODELS + ' 个');
      if (invalid.length) msgs.push('已忽略不合法名称：' + invalid.join('、'));
      if (allDup) msgs.push('该机种已在列表中');
      hint.textContent = msgs.join('；');
      hint.className = 'hint' + (msgs.length ? ' hint-warn' : '');
    }
  };

  // 点标签上的 × → 从标签区移除该机种（输入框是草稿，不受影响）
  window.fixFormRemoveModel = function (i) {
    state.fixForm.lineModels.splice(i, 1);
    renderLineModelChips();
    const hint = $('#fix_lm_hint');
    if (hint) { hint.textContent = ''; hint.className = 'hint'; }
    const inp = $('#fix_lm_text');
    if (inp) { try { inp.focus(); } catch (e) { /* 忽略 */ } }
  };

  /* ---- 关联产线：下拉 +「添加」→ 下方标签区（1~5 条） ----
   * v5.0.0 起工位模型整体移除，这里只选产线：下拉 →「+ 添加」→ 标签区（可逐个 × 移除）。
   * 标签区（state.fixForm.lines）是唯一数据源。 */
  let lsPick = { lineId: 0 };   // 工具区「选择产线」的当前选择
  let lsHintMsg = { text: '', warn: false };   // 提示文案（随重绘一起输出，避免被 innerHTML 冲掉）

  function lsResetPick() { lsPick = { lineId: 0 }; lsHintMsg = { text: '', warn: false }; }

  /* 提示只记录到 lsHintMsg，由 renderLineSectors 随重绘一起输出 */
  function lsHint(msg, warn) { lsHintMsg = { text: msg || '', warn: !!warn }; }

  /* 产线名（找不到时退化为 #id，保证不丢信息） */
  function lsLineName(lid) {
    const l = (state.lines || []).find((x) => Number(x.id) === Number(lid));
    return l ? l.name : '#' + lid;
  }

  /* 产线下拉：已关联的恒列出；未达上限时附上其余产线 */
  function lsLineOptions() {
    const sel = state.fixForm.lines.map(Number);
    const allowNew = sel.length < MAX_LINES;
    const list = (state.lines || [])
      .filter((l) => sel.includes(l.id) || allowNew)
      .slice().sort((a, b) => natCompare(a.name || '', b.name || ''));
    return ['<option value="">— 选择产线 —</option>'].concat(list.map((l) => {
      const on = Number(lsPick.lineId) === Number(l.id) ? ' selected' : '';
      const tag = sel.includes(Number(l.id)) ? '（已关联）' : '';
      return `<option value="${l.id}"${on}>${esc(l.name)}${tag}</option>`;
    })).join('');
  }

  /* 「+ 添加」按钮可用态：已选产线且未触及上限、未重复 */
  function syncLsAddBtn() {
    const btn = $('#fix_ls_addbtn');
    if (!btn) return;
    const lp = $('#fix_line_pick');
    const lid = lp && lp.value ? Number(lp.value) : 0;
    const full = state.fixForm.lines.length >= MAX_LINES;
    const dup = !!lid && state.fixForm.lines.map(Number).includes(lid);
    btn.disabled = !lid || full || dup;
    btn.title = full ? ('已达产线上限（' + MAX_LINES + ' 条）')
      : (dup ? '该产线已在下方标签区' : '加入下方标签区');
  }

  /* 整块重绘 #fix_ls_box（工具区 + 标签区 + 提示），其余输入框不受影响 */
  function renderLineSectors() {
    const box = $('#fix_ls_box');
    if (!box) return;

    if (!(state.lines || []).length) {
      box.innerHTML = '<div class="tip">尚无产线。请先到「产线配置」新增产线后再建档。'
        + '<a href="javascript:;" onclick="fixFormGotoLineCfg()">去配置产线</a></div>';
      return;
    }

    if (lsPick.lineId && !(state.lines || []).some((l) => Number(l.id) === Number(lsPick.lineId))) lsPick.lineId = 0;

    const selLines = state.fixForm.lines.map(Number);
    const fullLines = selLines.length >= MAX_LINES;

    const chips = selLines.length
      ? selLines.map((lid, i) => `<span class="chip-tag chip-ls"><b>${esc(lsLineName(lid))}</b>`
        + `<button type="button" class="chip-x" title="移除" onclick="fixFormRemoveLine(${i})">×</button></span>`).join('')
      : '<span class="chip-ls-empty muted">尚未选择产线</span>';

    box.innerHTML = `
      <div class="ls-toolbar">
        <select id="fix_line_pick" class="query-select" onchange="fixFormLinePicked()">${lsLineOptions()}</select>
        <button type="button" class="btn sm" id="fix_ls_addbtn" onclick="fixFormAddLine()" disabled>+ 添加</button>
        <span class="muted" id="fix_ls_count">已选 ${selLines.length} / ${MAX_LINES} 条产线</span>
      </div>
      <div id="fix_ls_chips" class="chip-box${selLines.length ? '' : ' chip-box-empty'}">${chips}</div>
      <small class="hint${lsHintMsg.text && lsHintMsg.warn ? ' hint-warn' : ''}" id="fix_ls_hint">${esc(lsHintMsg.text)}</small>
      ${fullLines ? '<div class="tip">已达产线上限（' + MAX_LINES + ' 条）。</div>' : ''}`;

    syncLsAddBtn();
  }

  /* 选了产线 → 记住选择并刷新「+ 添加」可用态（不重绘，保住下拉选择） */
  window.fixFormLinePicked = function () {
    const lp = $('#fix_line_pick');
    lsPick.lineId = lp && lp.value ? Number(lp.value) : 0;
    syncLsAddBtn();
  };

  /* 添加：把产线并入标签区；保留下拉选择，便于连续添加 */
  window.fixFormAddLine = function () {
    const lp = $('#fix_line_pick');
    const lid = lp && lp.value ? Number(lp.value) : 0;
    if (!lid) { lsHint('请先选择产线', true); renderLineSectors(); return; }
    if (state.fixForm.lines.map(Number).includes(lid)) { lsHint('该产线已在下方标签区中', true); renderLineSectors(); return; }
    if (state.fixForm.lines.length >= MAX_LINES) { lsHint('一件夹具最多关联 ' + MAX_LINES + ' 条产线', true); renderLineSectors(); return; }
    state.fixForm.lines.push(lid);
    lsHint('', false);
    renderLineSectors();
  };

  /* 移除一个产线标签 */
  window.fixFormRemoveLine = function (i) {
    const idx = Number(i);
    if (!(idx >= 0 && idx < state.fixForm.lines.length)) return;
    state.fixForm.lines.splice(idx, 1);
    lsHint('', false);
    renderLineSectors();
  };

  /* 用户已定：跳转配置页不保留表单内容，跳转前弹确认 */
  window.fixFormGotoLineCfg = function () {
    if (!confirm('跳转将清空已填内容，是否继续？')) return;
    resetFixForm();
    closeModal();
    showView('linecfg');
  };

  /* ---- 打开表单 ---- */
  async function openFixForm(id) {
    try { await reloadLineConfig(); } catch (e) { /* 读不到按空配置处理 */ }
    const f = id ? state.fixtures.find((x) => x.id === id) : null;
    resetFixForm();
    if (f) {
      state.fixForm.editId = f.id;
      state.fixForm.lineModels = (Array.isArray(f.lineModels) ? f.lineModels : []).slice();
      state.fixForm.lines = (Array.isArray(f.lines) ? f.lines : []).map(Number).filter((lid) => state.lines.some((l) => l.id === lid));
    }
    /* 默认把「选择产线」停在第一条已关联产线，便于继续增补 */
    lsPick.lineId = state.fixForm.lines.length ? state.fixForm.lines[0] : 0;
    const locList = locationCandidates().map((v) => `<option value="${esc(v)}"></option>`).join('');
    /* 分类下拉：预设 ∪ 已用分类；当前值即使不在候选里（历史脏值）也要保留可显示 */
    const curCat = f ? String(f.category || '').trim() : '';
    const catList = categoryCandidates();
    if (curCat && catList.indexOf(curCat) < 0) catList.push(curCat);
    const catOpts = ['<option value="">— 未分类 —</option>']
      .concat(catList.map((v) => `<option value="${esc(v)}"${v === curCat ? ' selected' : ''}>${esc(v)}</option>`))
      .join('');
    const lmOptions = (state.productions || []).map((p) => p.name).slice().sort(natCompare)
      .map((n) => `<option value="${esc(n)}"></option>`).join('');
    const html = `
      <div class="form-group"><label>夹具编号 <span class="req">*</span></label>
        <input type="text" id="fix_serial" placeholder="如 DH40MC-921-001-001（同一机种多套可共用同一编号）"
          maxlength="${MAX_SERIAL_NO}" value="${esc(f ? f.serialNo || '' : '')}" onchange="fixFormCheckSerial()">
        <small class="hint" id="fix_serial_hint"></small></div>
      <div class="form-group"><label>夹具名称 <span class="req">*</span></label>
        <input type="text" id="fix_name" placeholder="夹具名称" value="${esc(f ? f.name || '' : '')}"></div>
      <div class="form-group"><label>机种名称 <span class="req">*</span>（最多 ${MAX_LINE_MODELS} 个）<span class="muted" id="fix_lm_count"></span></label>
        <div class="chip-add">
          <input type="text" id="fix_lm_text" list="fix_lm_list" oninput="fixFormDraftInput()" onkeydown="fixFormModelsKeydown(event)"
            placeholder="输入机种名称后点「添加」或按回车；一次可多个，用 / 分隔"
            value="">
          <button type="button" class="btn sm" id="fix_lm_addbtn" onclick="fixFormModelsInput()" disabled>+ 添加</button>
        </div>
        <datalist id="fix_lm_list">${lmOptions}</datalist>
        <div id="fix_lm_chips" class="chip-box"></div>
        <small class="hint" id="fix_lm_hint"></small></div>
      <div class="form-group"><label>库位 <span class="req">*</span></label>
        <input type="text" id="fix_loc" list="fix_loc_list" placeholder="如 ZP1-U-1-1（4 段式，≤${MAX_LOCATION} 字符）"
          maxlength="${MAX_LOCATION}" value="${esc(f ? f.location || '' : '')}">
        <datalist id="fix_loc_list">${locList}</datalist></div>
      <div class="form-group"><label>分类</label>
        <select id="fix_cat" onchange="fixFormCategoryChange()">${catOpts}<option value="__NEW__">＋ 新增分类…</option></select>
        <div id="fix_cat_new_box" style="display:none;margin-top:6px;">
          <input type="text" id="fix_cat_new" maxlength="${MAX_CATEGORY}" placeholder="输入新分类名称（如 碳纤维）"
            onkeydown="if(event.key==='Enter'){event.preventDefault();fixFormAddCategory();}">
          <button type="button" class="btn sm" style="margin-left:6px;" onclick="fixFormAddCategory()">确定新增</button>
          <button type="button" class="btn sm ghost" style="margin-left:6px;" onclick="fixFormCancelCategory()">取消</button>
        </div>
        <small class="hint">预设常用材质，也可自行新增；新增的分类保存后会出现在后续下拉中。</small></div>
      <div class="form-group form-group-row"><label>关联产线 <span class="req">*</span>（≥1 条 · ≤${MAX_LINES} 条）</label>
        <div id="fix_ls_box" class="ls-box"></div>
        <small class="hint">从下拉选择产线，点「+ 添加」加入标签区；一条夹具可关联多条产线。</small></div>
      <div class="form-group"><label>备注</label>
        <input type="text" id="fix_remark" placeholder="可选备注" value="${esc(f ? f.remark || '' : '')}"></div>
      ${f ? `<div class="tip">序号 <b>${esc(f.code)}</b> 由系统分配，不可修改（改则断流水与产线绑定）。</div>` : ''}
      <div class="form-actions">
        <button class="btn primary" onclick="submitFixForm()">${f ? '保存修改' : '建档'}</button>
        <button class="btn ghost" onclick="closeModal(); resetFixForm()">取消</button>
      </div>`;
    openModal(f ? '编辑夹具 · ' + (f.serialNo || f.code) : '新建夹具', html);
    renderLineModelChips();
    renderLineSectors();
    fixFormCheckSerial();
  }

  /* ---- 分类：下拉选择 + 自定义新增 ----
   * 选中「＋ 新增分类…」时在下方就地展开输入框（不另开弹窗 —— openModal 会覆盖当前表单 DOM）。
   * 新增值只插入本表单的 <select>，保存后由 categoryCandidates() 从现有夹具自动收集。 */
  window.fixFormCategoryChange = function () {
    const sel = $('#fix_cat');
    const box = $('#fix_cat_new_box');
    if (!sel || !box) return;
    const isNew = sel.value === '__NEW__';
    box.style.display = isNew ? 'block' : 'none';
    if (isNew) {
      const inp = $('#fix_cat_new');
      if (inp) { inp.value = ''; inp.focus(); }
    }
  };

  window.fixFormCancelCategory = function () {
    const sel = $('#fix_cat');
    const box = $('#fix_cat_new_box');
    if (sel) sel.value = '';
    if (box) box.style.display = 'none';
  };

  window.fixFormAddCategory = function () {
    const sel = $('#fix_cat');
    const inp = $('#fix_cat_new');
    const box = $('#fix_cat_new_box');
    if (!sel || !inp) return;
    const v = String(inp.value || '').trim();
    if (!v) { toast('请输入分类名称', 'err'); return; }
    if (!isValidCategory(v)) { toast('分类名称最多 ' + MAX_CATEGORY + ' 字符，且不能含 | 或换行', 'err'); return; }
    const exists = Array.prototype.some.call(sel.options, (o) => o.value === v);
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      const newOpt = sel.querySelector('option[value="__NEW__"]');
      sel.insertBefore(opt, newOpt || null);
    }
    sel.value = v;
    if (box) box.style.display = 'none';
    inp.value = '';
  };

  window.fixtureNew = function () { openFixForm(0); };
  window.fixtureEdit = function (id) { openFixForm(id); };

  /* 重号提示：夹具编号允许重复，但要让用户知道现有持有量 */
  window.fixFormCheckSerial = function () {
    const el = $('#fix_serial_hint');
    if (!el) return;
    const v = (($('#fix_serial') || {}).value || '').trim();
    if (!v) { el.textContent = ''; return; }
    const s = serialNoSummary(v);
    el.textContent = s || '该编号为首次登记';
    el.className = 'hint' + (s ? ' hint-warn' : '');
  };

  /* 提交：7 条强校验（规则 3/4/6/7 已在控件层即时约束，这里再兜一次） */
  window.submitFixForm = async function () {
    const editId = state.fixForm.editId;
    const serialNo = (($('#fix_serial') || {}).value || '').trim();
    const name = (($('#fix_name') || {}).value || '').trim();
    const location = (($('#fix_loc') || {}).value || '').trim();
    const category = (($('#fix_cat') || {}).value || '').trim();
    const remark = (($('#fix_remark') || {}).value || '').trim();
    if ($('#fix_lm_text')) window.fixFormModelsInput();   // 兜底：从输入框重新解析，防止有未触发的 input 事件
    const lineModels = state.fixForm.lineModels.slice();
    const lines = state.fixForm.lines.map(Number);

    if (!isValidSerialNo(serialNo)) { toast('请填写夹具编号（≤' + MAX_SERIAL_NO + ' 字符，不能含 | 或换行）', 'err'); return; }
    if (!name) { toast('请填写夹具名称', 'err'); return; }
    if (!lineModels.length) { toast('请至少选择 1 个机种名称', 'err'); return; }
    if (lineModels.length > MAX_LINE_MODELS) { toast('机种名称最多 ' + MAX_LINE_MODELS + ' 个', 'err'); return; }
    if (!lines.length) { toast('请至少选择 1 条产线', 'err'); return; }
    if (lines.length > MAX_LINES) { toast('一件夹具最多关联 ' + MAX_LINES + ' 条产线', 'err'); return; }
    if (!isValidLocation(location)) { toast('库位号需为 4 段式（如 ZP1-U-1-1），且不超过 ' + MAX_LOCATION + ' 字符', 'err'); return; }
    if (!isValidCategory(category)) { toast('分类名称最多 ' + MAX_CATEGORY + ' 字符，且不能含 | 或换行', 'err'); return; }

    try {
      if (editId) {
        await DB.fixtureUpdate({ id: editId, serialNo, name, location, category, remark, lineModels, lines });
      } else {
        await DB.fixtureAdd({ serialNo, name, location, category, remark, lineModels, lines });
      }
      closeModal();
      resetFixForm();
      await reloadAll();
      renderFixtures();
      toast(editId ? '夹具已更新' : '夹具建档成功', 'ok');
    } catch (e) { toast((editId ? '保存失败：' : '建档失败：') + (e && e.message ? e.message : e), 'err'); }
  };

  /* ---------------- 夹具列表检索与导出 ---------------- */
  window.fixtureSearch = function () {
    const q = ($('#fix_search') || {}).value.trim();
    const list = $('#fixture_list');
    if (!list) return;
    /* 换了关键字就把「已显示条数」收回到首页上限，避免上次点开的 2000 条继续全量渲染 */
    state.fixShown = FIX_RENDER_LIMIT;
    const filtered = q ? state.fixtures.filter((f) => matchFixture(f, q)) : state.fixtures;
    renderFixtureArea(list, filtered, state.fixSelectedId || 0);
  };

  /* 「显示更多」：每次再放 300 条，避免一次 innerHTML 上万张卡片把渲染进程拖死 */
  window.showMoreFixtures = function () {
    state.fixShown = (state.fixShown || FIX_RENDER_LIMIT) + FIX_RENDER_LIMIT;
    const list = $('#fixture_list');
    if (!list) return;
    const q = ($('#fix_search') || {}).value.trim();
    const filtered = q ? state.fixtures.filter((f) => matchFixture(f, q)) : state.fixtures;
    renderFixtureArea(list, filtered, state.fixSelectedId || 0);
  };

  /* 夹具清单导出：
   * 列定义与「下载模板」**完全同一份** FIX_IMPORT_HEADERS（22 列、同顺序、同 CSV 编码/换行），
   * 只是模板多几行示例数据 ⇒ 导出的文件改完可直接用「⬆ 导入Excel/CSV」回灌（BUG-009）。
   * ⚠️ 机种必须按「机种名称1~N」拆成分列（N = MAX_LINE_MODELS），不能合成一格，否则导出→导入会改变行结构；
   *    序号 / 状态 / 累计出库 / 累计回库 / 维修次数都是系统内部派生值，模板里没有，
   *    导出也不带（要看状态请到「夹具查询」或「流水记录」）。
   * ⚠️ v5.0.0 起模板与导出**不再有工位列**，只保留「产线1~产线5」。 */
  window.fixtureExportCSV = async function () {
    try { await reloadLineConfig(); } catch (e) { /* 读不到按空配置处理，产线名退化为 #id */ }
    const headers = FIX_IMPORT_HEADERS.slice();
    const rows = state.fixtures.map((f) => {
      const models = [];
      const lms = Array.isArray(f.lineModels) ? f.lineModels : [];
      for (let i = 0; i < MAX_LINE_MODELS; i++) models.push(lms[i] == null ? '' : String(lms[i]));
      const lineCols = [];
      for (let i = 0; i < MAX_LINES; i++) lineCols.push(fixtureLineNamesForExport(f)[i] || '');
      return [
        f.serialNo || '', f.name, ...models, f.category || '', f.location || '',
        ...lineCols, f.remark || ''
      ];
    });
    const csv = buildCsvText(headers, rows);
    download('夹具清单_' + new Date().toISOString().slice(0, 10) + '.csv', csv);
    toast('已导出 ' + rows.length + ' 套夹具（列结构与导入模板一致，可直接回灌）', 'ok');
  };

  /* ============================================================
   * 夹具批量导入（Excel .xlsx / CSV）
   *
   * 设计要点（v4.0.0）：
   *   - 桥梁编号 code 不由表格提供，一律由系统自动分配（1001 起顺延填补空洞）
   *   - 实物编号 serialNo 为必填，允许重复（同机种多套）
   *   - 产线按「名称」引用；若未建档则**导入时自动补建**（同名复用，不重复创建），
   *     不再因产线未建档而整行跳过，确保符合其它条件的表格可正常导入
   *   - 机种名称支持 1~N 独立列（N = MAX_LINE_MODELS），也可只给一列「机种名称」用分隔符写多个
   *   - 预览确认后才落库，避免误导入
   * ============================================================ */
  /* 模板结构（v5.0.0 去工位；v5.4.0 机种列 7 → 12 列）：
   *   夹具编号 | 名称 | 机种名称1…机种名称12 | 分类 | 库位 | 产线1…产线5 | 备注 = 22 列
   *   一行 = 一套夹具；机种上限由 MAX_LINE_MODELS 决定、产线上限由 MAX_LINES 决定，
   *   **列数组由上限常量生成**，改上限时这里自动跟随（不再手动数表头 —— BUG-009 的教训）。
   *   旧版扁平「产线」单列仍兼容（多个产线用分隔符写在同一格）。
   *   旧模板里的「工位1…工位5」「工位」列会被**静默忽略**（表头不在别名表内），不影响产线导入。
   *   旧 17 列（机种只到 7）模板**仍可直接导入**：按表头名映射、不依赖列号，缺的机种列按空处理。 */
  const FIX_IMPORT_HEADERS = [
    '夹具编号', '名称',
    ...Array.from({ length: MAX_LINE_MODELS }, (_, i) => '机种名称' + (i + 1)),
    '分类', '库位',
    ...Array.from({ length: MAX_LINES }, (_, i) => '产线' + (i + 1)),
    '备注'
  ];
  /* 中文数字（机种/产线的表头别名要用，最多到「十二」） */
  const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

  /* CSV 文本生成：模板下载与清单导出**共用**，保证两者只有示例行不同、结构逐字节同构 */
  function buildCsvText(headers, rows) {
    const line = (r) => r.map((v) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
    return '\ufeff' + [headers.join(','), ...rows.map(line)].join('\r\n');
  }

  // 表头别名 → 字段名。键为归一化后的表头（去空格/全角括号内容/标点）
  const FIX_IMPORT_ALIAS = {
    '实物编号': 'serialNo', '夹具编号': 'serialNo', '实物夹具编号': 'serialNo', '资产编号': 'serialNo', 'serialno': 'serialNo',
    '名称': 'name', '夹具名称': 'name', '品名': 'name', 'name': 'name',
    '机种名称': 'lms', '机种': 'lms', '适用机种': 'lms', '机型': 'lms',
    '分类': 'category', '类别': 'category', 'category': 'category',
    '库位': 'location', '库位号': 'location', '存放位置': 'location', '位置': 'location', '货位': 'location', 'location': 'location',
    /* 旧版扁平列（兼容保留）：一格写多条，用分隔符隔开 */
    '产线': 'lines', '线体': 'lines', '产线名称': 'lines', '线体名称': 'lines',
    '备注': 'remark', '备注或用途': 'remark', '说明': 'remark', 'remark': 'remark'
  };
  /* 机种名称N / 机种N / 机型N（N=1..MAX_LINE_MODELS，另兼容中文数字）与
   * 产线N / 线体N（N=1..MAX_LINES）的别名**按上限常量自动补齐** ——
   * 加机种位只改 MAX_LINE_MODELS 一处，别名表与表头自动跟随。 */
  for (let i = 1; i <= MAX_LINE_MODELS; i++) {
    const key = 'lm' + i;
    const cn = CN_NUM[i - 1];
    FIX_IMPORT_ALIAS['机种名称' + i] = key;
    FIX_IMPORT_ALIAS['机种' + i] = key;
    FIX_IMPORT_ALIAS['机型' + i] = key;
    if (cn) FIX_IMPORT_ALIAS['机种名称' + cn] = key;
  }
  for (let i = 1; i <= MAX_LINES; i++) {
    const key = 'line' + i;
    const cn = CN_NUM[i - 1];
    FIX_IMPORT_ALIAS['产线' + i] = key;
    FIX_IMPORT_ALIAS['线体' + i] = key;
    if (cn) FIX_IMPORT_ALIAS['产线' + cn] = key;
  }

  // 表头归一化：去 BOM/空白/全角空格，忽略括号注释与常见标点
  function normalizeHeader(h) {
    return String(h == null ? '' : h)
      .replace(/^﻿/, '')
      .replace(/[　\s]/g, '')
      .replace(/[（(].*?[)）]/g, '')
      .replace(/[:：*＊]/g, '')
      .toLowerCase();
  }

  // 把二维数组的首行解析成 { 字段 → 列号 }，并返回数据行起点
  function mapImportHeader(headerRow) {
    const idx = {};
    headerRow.forEach((h, i) => {
      const key = FIX_IMPORT_ALIAS[normalizeHeader(h)];
      if (key && idx[key] == null) idx[key] = i;
    });
    return idx;
  }

  /* 机种取值列顺序：分列的 lm1…lmN 优先，扁平「机种名称」列（lms）最后合并。
   * 由 MAX_LINE_MODELS 生成，加机种位无需改这里。 */
  const IMPORT_LM_KEYS = Array.from({ length: MAX_LINE_MODELS }, (_, i) => 'lm' + (i + 1)).concat('lms');

  // 从一行数据提取夹具入参；返回 { ok, fixture } 或 { ok:false, reason }
  function parseImportRow(row, idx) {
    const get = (key) => (idx[key] == null ? '' : String(row[idx[key]] == null ? '' : row[idx[key]]).trim());

    const name = get('name');
    if (!name) return { ok: false, reason: '名称为空' };
    const serialNo = get('serialNo');
    if (!isValidSerialNo(serialNo)) return { ok: false, reason: '夹具编号为空或格式不合法' };
    const location = get('location');
    if (!isValidLocation(location)) return { ok: false, reason: '库位为空或不是 4 段式（如 ZP1-U-1-1）' };

    const lms = [];
    IMPORT_LM_KEYS.forEach((k) => {
      String(get(k)).split(/[,，;；/、]/).forEach((v) => {
        const s = v.trim();
        if (s && !lms.includes(s) && lms.length < MAX_LINE_MODELS) lms.push(s);
      });
    });
    if (!lms.length) return { ok: false, reason: '机种名称为空' };

    /* 产线两种列结构：
     *   ① 分列（产线1 … 产线5）
     *   ② 旧版扁平单列（产线）—— 一格可写多条，用分隔符隔开
     * 工位相关列（工位N / 工位）自 v5.0.0 起不再映射，出现也只会被忽略。 */
    const lineNames = [];
    for (let i = 1; i <= MAX_LINES; i++) {
      const ln = get('line' + i);
      if (ln && lineNames.indexOf(ln) < 0) lineNames.push(ln);
    }
    if (!lineNames.length) {
      splitNames(get('lines')).forEach((ln) => { if (lineNames.indexOf(ln) < 0) lineNames.push(ln); });
    }

    return {
      ok: true,
      fixture: {
        serialNo,
        name,
        lineModels: lms,
        category: get('category'),
        location,
        remark: get('remark'),
        lineNames
      }
    };
  }

  function splitNames(v) {
    return String(v == null ? '' : v)
      .split(/[,，;；/、\n\r]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .filter((s, i, a) => a.indexOf(s) === i);
  }

  /* ---------------- 导入查重：一整条记录的「签名」 ----------------
   * 签名 = 夹具编号 + 名称 + 库位 + 分类 + 机种集合 + 产线集合 + 备注 全部一致。
   * ⚠️ 只跟「库内已有记录」比对，**绝不做批次内去重**：
   *    同一个库位放 2 套同号夹具是合法业务（真实台账里有 236 组 / 578 行完全相同的行），
   *    批次内去重会把这 578 行真实数据直接吞掉。
   * ⚠️ 与库内比对必须用「多重集 1:1 配对」（命中一条就减 1）：库内有 1 套、本次带来 2 行时，
   *    应判定为「1 行重复 + 1 行新增」，而不是两行都算重复。 */
  const SIG_SEP = '\u0000';
  function _sigOfNames(serialNo, name, location, category, lineModels, lineNames, remark) {
    const models = (lineModels || []).map((s) => String(s).trim()).filter(Boolean).sort();
    const lns = (lineNames || []).map((n) => String(n == null ? '' : n).trim()).filter(Boolean).sort();
    return [
      String(serialNo == null ? '' : serialNo).trim(),
      String(name == null ? '' : name).trim(),
      String(location == null ? '' : location).trim(),
      String(category == null ? '' : category).trim(),
      models.join('|'),
      lns.join(';'),
      String(remark == null ? '' : remark).trim()
    ].join(SIG_SEP);
  }
  /* 把库内已有夹具还原成同一签名：fixtures 只存 lines 的 id 数组，需反查成产线名。 */
  function _sigOfFixture(f, lines) {
    const lineNameById = new Map((lines || []).map((l) => [l.id, l.name]));
    const lineNames = (f.lines || []).map((id) => lineNameById.get(Number(id))).filter(Boolean);
    return _sigOfNames(f.serialNo, f.name, f.location, f.category, f.lineModels, lineNames, f.remark);
  }

  /* 把二维数组解析为待导入列表。
   * ctx = { fixtures, lines }，用于编号占用判断与产线名反查。
   * 返回 { ok, plan:[{row,fixture,dupHint}], skipped:[{row,reason}], hasSerialColumn, hasLineColumn } */
  function buildImportPlan(rows, ctx) {
    if (!rows || rows.length < 2) return { ok: false, error: '文件中没有数据行' };
    const c = ctx || { fixtures: state.fixtures, lines: state.lines };
    const idx = mapImportHeader(rows[0]);
    if (idx.name == null) {
      return { ok: false, error: '模板缺少「名称」列（表头需含：夹具编号 / 名称 / 机种名称 / 库位 / 产线）' };
    }
    if (idx.serialNo == null) return { ok: false, error: '模板缺少「夹具编号」列' };
    if (idx.location == null) return { ok: false, error: '模板缺少「库位」列' };
    const hasAnyLineCol = [idx.line1, idx.line2, idx.line3, idx.line4, idx.line5, idx.lines].some((v) => v != null);
    if (!hasAnyLineCol) return { ok: false, error: '模板缺少「产线」列（新版「产线1…产线5」或旧版「产线」）' };

    const linesByName = new Map((c.lines || []).map((l) => [l.name, l]));
    /* 产线名归并表（BUG-010）：归一化名 -> 正式名。库内已有名称优先，其次本次文件里首个出现的写法。
     * 只影响「落库用哪个名字」，不改动用户文件；归并结果会在预览顶部明示。 */
    const normToLine = new Map();
    (c.lines || []).forEach((l) => {
      const k = normalizeLineName(l.name);
      if (k && !normToLine.has(k)) normToLine.set(k, l.name);
    });
    const lineHints = new Map();   // 原文写法 -> { to, rows: Set<行号> }
    const remapLineName = (n, rowNo) => {
      const k = normalizeLineName(n);
      if (!k) return n;
      if (!normToLine.has(k)) { normToLine.set(k, n); return n; }
      const target = normToLine.get(k);
      if (target === n) return n;
      const h = lineHints.get(n) || { to: target, rows: new Set() };
      h.rows.add(rowNo);
      lineHints.set(n, h);
      return target;
    };
    // 待自动补建的产线（同名只登记一次，落库时复用）
    const autoLines = new Map();      // lineName -> true
    /* 库内已有记录的签名计数（多重集）。每命中一行就减 1，保证「库内 1 套 + 本次 2 行」判成 1 重复 + 1 新增。
     * ⚠️ 产线 id→名称 只建一次 Map（v5.6.0）：原实现每条夹具都 new Map 一遍，
     *    9000 条夹具 × 100 多条产线 = 近百万次建表，导入预览会明显卡顿。 */
    const lineNameById = new Map((c.lines || []).map((l) => [l.id, l.name]));
    const existingSig = new Map();
    (c.fixtures || []).forEach((f) => {
      const lns = (f.lines || []).map((id) => lineNameById.get(Number(id))).filter(Boolean);
      const sig = _sigOfNames(f.serialNo, f.name, f.location, f.category, f.lineModels, lns, f.remark);
      existingSig.set(sig, (existingSig.get(sig) || 0) + 1);
    });

    /* 同编号统计预计算（v5.6.0）：原来每行都 filter 一遍全表，
     * 4000 行 × 9000 条 ≈ 3600 万次比较，是预览阶段的主要耗时来源之一。 */
    const serialStat = new Map();   // serialNo -> { total, stocked }
    (c.fixtures || []).forEach((x) => {
      const k = String(x.serialNo == null ? '' : x.serialNo);
      const s = serialStat.get(k) || { total: 0, stocked: 0 };
      s.total++;
      if ((x.status || 'stocked') === 'stocked') s.stocked++;
      serialStat.set(k, s);
    });
    const batchSerial = new Map();  // 本次文件内已出现的同编号行数

    /* v5.7.0：未导入行也要能被定位到具体实物，所以跳过行带上表格里的
     * 夹具编号 / 名称 / 库位三列原始值（解析失败时它们仍在表里，只是不合规）。
     * ⚠️ 只读取、不做任何归一化，纯粹用于「未导入明细」展示与导出。 */
    const cellOf = (row, i) => (i == null ? '' : String(row[Number(i)] == null ? '' : row[Number(i)]).trim());

    const plan = [];
    const skipped = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row.some((x) => String(x == null ? '' : x).trim() !== '')) continue; // 全空行
      const parsed = parseImportRow(row, idx);
      if (!parsed.ok) {
        skipped.push({
          row: r + 1, reason: parsed.reason,
          serialNo: cellOf(row, idx.serialNo), name: cellOf(row, idx.name), location: cellOf(row, idx.location)
        });
        continue;
      }
      const f = parsed.fixture;
      const ctxCells = { serialNo: f.serialNo, name: f.name, location: f.location };

      /* 产线名归并（BUG-010）：把「1#」「1 」这类同义写法并到同一条产线上。 */
      {
        const merged = [];
        (f.lineNames || []).forEach((n) => {
          const to = remapLineName(n, r + 1);
          if (merged.indexOf(to) < 0) merged.push(to);
        });
        f.lineNames = merged;
      }

      if (!f.lineNames.length) { skipped.push(Object.assign({ row: r + 1, reason: '产线为空' }, ctxCells)); continue; }
      if (f.lineNames.length > MAX_LINES) { skipped.push(Object.assign({ row: r + 1, reason: '产线超过 ' + MAX_LINES + ' 条' }, ctxCells)); continue; }

      // 登记需要新建的产线（同名只建一次）
      f.lineNames.forEach((n) => { if (!linesByName.has(n) && !autoLines.has(n)) autoLines.set(n, true); });

      /* 重号提示：夹具编号允许重复（v4「每套一条记录」），但要告知现有持有量。 */
      const serialKey = String(f.serialNo == null ? '' : f.serialNo);
      const sstat = serialStat.get(serialKey) || { total: 0, stocked: 0 };
      const inBatch = batchSerial.get(serialKey) || 0;
      batchSerial.set(serialKey, inBatch + 1);
      const dupTotal = sstat.total + inBatch;
      const dupInStock = sstat.stocked;
      const dupHint = dupTotal
        ? `该编号已有 ${dupTotal} 套（在库 ${dupInStock} 套，在外 ${dupTotal - dupInStock} 套）`
        : '';

      /* 与库内已有记录做 1:1 配对：命中即判「疑似重复导入」（只提示 + 默认跳过，绝不静默丢行） */
      const sig = _sigOfNames(f.serialNo, f.name, f.location, f.category, f.lineModels, f.lineNames, f.remark);
      const remain = existingSig.get(sig) || 0;
      const isDup = remain > 0;
      if (isDup) existingSig.set(sig, remain - 1);

      plan.push({
        row: r + 1,
        fixture: {
          serialNo: f.serialNo, name: f.name, lineModels: f.lineModels,
          category: f.category, location: f.location, remark: f.remark,
          lineNames: f.lineNames
        },
        dupHint,
        isDup,
        sig
      });
    }
    // 把「待自动补建」清单挂在 plan 上，供预览展示与落库时使用
    plan._autoLines = Array.from(autoLines.keys());
    // 归并了哪些写法（预览顶部明示，避免用户以为文件写错了）
    plan._lineHints = Array.from(lineHints.entries()).map(([from, v]) => ({ from, to: v.to, rows: v.rows.size }));
    plan._dupCount = plan.filter((p) => p.isDup).length;
    // 每行缺哪些产线（供跳过 / 新建对话框使用）
    plan._missing = plan.map((p) => (p.fixture.lineNames || [])
      .filter((n) => !linesByName.has(n))
      .map((n) => ({ key: n, label: n, kind: 'line', type: 'new' })));
    /* ⚠️ 全部被跳过时必须把 skipped 一起返回：否则前端只弹「没有可导入的有效数据行」，
     * 用户完全不知道是「产线为空」还是「库位不合规」，只能猜（BUG-007）。 */
    if (!plan.length) return { ok: false, error: '没有可导入的有效数据行', skipped };
    return {
      ok: true, plan, skipped,
      hasSerialColumn: idx.serialNo != null,
      hasLineColumn: hasAnyLineCol
    };
  }

  /* 导入前弹窗：收集用户「新建」/「跳过」选择
   * 遍历 plan._missing 所有条目，逐行让用户决定。
   * 返回 Map<key, 'add'|'skip'>，供 confirmImportPlan 使用。
   * 全部跳过时返回 null。 */
  window.showModalMissingLines = function (plan) {
    const allMissing = plan._missing || [];
    if (!allMissing.length) return Promise.resolve(new Map());

    const tableRows = [];
    let rowIdx = 0;
    allMissing.forEach((items) => {
      items.forEach((m) => {
        if (tableRows.some((x) => x.key === m.key)) return;
        tableRows.push({ key: m.key, label: esc(m.label), kind: 'line', type: m.type, idx: rowIdx++ });
      });
    });

    const body = `
      <div class="tip" style="margin-bottom:10px;">
        检测到 <b>${tableRows.length}</b> 条未建档产线。请选择每条目：<b>「新建」</b> 或 <b>「跳过该行」</b>（跳过 = 整行不导入）。</div>
      <div style="max-height:360px;overflow:auto;border:1px solid var(--border);border-radius:6px;">
        <table class="table" style="margin:0;">
          <thead><tr><th>编号</th><th>名称</th><th>操作</th></tr></thead>
          <tbody>
            ${tableRows.map((r) => `<tr>
              <td>${r.idx + 1}</td>
              <td>【新建产线】${r.label}</td>
              <td>
                <label><input type="radio" name="mls_${r.idx}" value="add" checked> 新建</label>
                <label><input type="radio" name="mls_${r.idx}" value="skip"> 跳过该行</label>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="form-actions" style="margin-top:10px;">
        <button class="btn primary" onclick="confirmMissingSelection()">确认</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    openModal('未建档产线处理', body);
    return new Promise((resolve) => {
      window.__collectMissingSelection = () => {
        const result = new Map();
        tableRows.forEach((r) => {
          const radios = document.querySelectorAll(`input[name="mls_${r.idx}"]`);
          let val = 'add';
          radios.forEach((rb) => { if (rb.checked) val = rb.value; });
          result.set(r.key, val);
        });
        window.__collectMissingSelection = null;
        resolve(result);
      };
    });
  };

  window.confirmMissingSelection = function () {
    if (typeof window.__collectMissingSelection === 'function') {
      window.__collectMissingSelection();
    }
  };

  /* 导入预览模态框：先看清楚要写什么，再点确认 */
  window.showImportPreview = function (result, sourceName) {
    if (!result || !Array.isArray(result.plan)) { toast('导入计划无效', 'err'); return; }
    const plan = result.plan;
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    const rows = plan.slice(0, 60);
    const autoLines = Array.isArray(plan._autoLines) ? plan._autoLines : [];
    const dupCount = plan._dupCount || 0;
    const newCount = plan.length - dupCount;
    const lineHints = Array.isArray(plan._lineHints) ? plan._lineHints : [];
    const aliasBanner = lineHints.length ? `
      <div class="tip" style="margin-bottom:10px;border-color:#5b8def;background:#eef4ff;color:#1e4b9c;">
        🔗 已自动归并<b>同名产线</b>：${lineHints.map((h) => `「${esc(h.from)}」→「${esc(h.to)}」（${h.rows} 行）`).join('、')}
        <br>这些写法只差 <b>#</b> / 空格 / 全角半角，按同一条产线处理，避免把夹具拆到两条同义线上。
        如需分别建档，请改成能区分的名称（如「1号线」「1号备用线」）后再导入。
      </div>` : '';
    const dupBanner = dupCount ? `
      <div class="tip" style="margin-bottom:10px;border-color:#e0b34d;background:#fff8e6;color:#8a5a00;">
        ⚠️ 本次 <b>${plan.length}</b> 行中，有 <b>${dupCount}</b> 行与库内已有记录<b>完全一致</b>
        （同夹具编号 + 名称 + 库位 + 分类 + 机种 + 产线 + 备注）。<br>
        若这是同一份表重复导入，请选「跳过重复」；若确实又增加了实物（同库位放多套同号），请选「全部导入」。
      </div>` : '';
    const body = `
      ${aliasBanner}
      ${dupBanner}
      <div class="tip" style="margin-bottom:10px;">
        来源：<b>${esc(sourceName)}</b> ｜ 待导入 <b>${plan.length}</b> 条${skipped.length ? ` ｜ 跳过 <b>${skipped.length}</b> 条` : ''}${autoLines.length ? ` ｜ 自动补建 <b>${autoLines.length}</b> 条产线` : ''}
      </div>
      <div style="max-height:360px;overflow:auto;border:1px solid var(--border);border-radius:6px;">
        <table class="table" style="margin:0;">
          <thead><tr><th>行号</th><th>状态</th><th>夹具编号</th><th>名称</th><th>机种名称</th><th>分类</th><th>库位</th><th>产线</th></tr></thead>
          <tbody>
            ${rows.map((p) => `<tr>
              <td>${p.row}</td>
              <td>${p.isDup ? '<span class="badge warn">重复</span>' : '<span class="badge ok">新增</span>'}</td>
              <td>${esc(p.fixture.serialNo)}</td>
              <td>${esc(p.fixture.name)}</td>
              <td>${esc((p.fixture.lineModels || []).join(' / ') || '—')}</td>
              <td>${esc(p.fixture.category || '—')}</td>
              <td>${esc(p.fixture.location || '—')}</td>
              <td>${esc((p.fixture.lineNames || []).join(' / ') || '—')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${plan.length > rows.length ? `<p class="muted" style="margin:8px 0 0;">仅预览前 ${rows.length} 条，实际将导入全部 ${plan.length} 条。</p>` : ''}
      ${skipped.length ? `<div class="tip" style="margin-top:8px;">跳过 ${skipped.length} 行：${esc(skipped.slice(0, 10).map((s) => '第 ' + s.row + ' 行(' + s.reason + ')').join('、'))}${skipped.length > 10 ? ' 等' : ''}<br>导入完成后，结果窗口会列出<b>全部未导入明细</b>并可导出 CSV。</div>` : ''}
      <p class="muted" style="margin:8px 0 0;">序号由系统自动分配；夹具编号允许重复。引用的产线若未建档，将自动补建（同名复用，不重复创建）。导入后可在结果窗口「撤销本次导入」。</p>
      <div class="form-actions">
        ${dupCount
          ? `<button class="btn primary" onclick="confirmImportPlan('skip')">跳过重复，导入 ${newCount} 条</button>
             <button class="btn ghost" onclick="confirmImportPlan('all')">全部导入 ${plan.length} 条</button>`
          : `<button class="btn primary" onclick="confirmImportPlan('all')">确认导入 ${plan.length} 条</button>`}
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    window.__importPlan = plan;
    /* v5.7.0：把解析阶段被跳过的行一起交给结果窗口，导入后统一出「未导入明细」 */
    window.__importSkipped = skipped.slice();
    openModal('导入预览', body);
  };

  /* 某行是否被用户在「未建档产线」对话框里选了「跳过该行」 */
  function _rowSkipByKeys(p, keys) {
    if (!keys || !keys.size) return false;
    return (p.fixture.lineNames || []).some((n) => keys.has(n));
  }

  /* 确认导入
   * mode = 'skip'（默认）：跳过与库内已有记录完全一致的重复行（防同一份表重复导入）
   *        'all'        ：全部导入（确实又增加了同类实物时用） */
  /* ---------------- 导入落库的分片与进度（v5.6.0） ----------------
   * 每片 500 条：主进程每片只全量写一次盘，4114 行的整批导入 ≈ 9 次写盘（原来 4114 次）。
   * 片数太多则写盘次数回升，太少则进度条跳动、单片耗时过长，500 是实测折中值。 */
  const IMPORT_CHUNK = 500;

  function showImportProgress(total) {
    openModal('正在导入', `
      <div class="tip">正在写入 <b id="imp_done">0</b> / <b>${total}</b> 条，请勿关闭窗口或重复点「确认导入」…</div>
      <div style="height:10px;background:#e6e8ec;border-radius:5px;overflow:hidden;margin-top:12px;">
        <div id="imp_bar" style="height:100%;width:0;background:#2f6fed;transition:width .15s;"></div>
      </div>
      <p class="muted" style="margin:10px 0 0;">写入期间界面会短暂无响应属正常现象；进度条走完会自动弹出结果。</p>
    `);
  }

  function setImportProgress(done, total) {
    const t = $('#imp_done'); if (t) t.textContent = String(done);
    const b = $('#imp_bar'); if (b) b.style.width = Math.round((done / Math.max(1, total)) * 100) + '%';
  }

  /* ---------------- 未导入明细（v5.7.0） ----------------
   * 旧版只给「失败 N 条 / 跳过 M 条」的数字，落库失败更是仅 console.warn ——
   * 用户拿不到「哪一行没进来、为什么」，只能凭猜重试。
   * 这里把四类未导入行汇成一张统一明细（行号升序），供结果窗口展示与 CSV 导出：
   *   ① 解析未通过（产线为空 / 库位不合规 / 名称为空…）
   *   ② 与库内记录完全一致，按「跳过重复」处理
   *   ③ 产线未建档，用户在弹窗里选了「跳过该行」
   *   ④ 落库失败（校验不通过或被主进程拒绝） */
  function collectNotImported(parts) {
    const out = [];
    const push = (p, reason) => out.push({
      row: Number(p.row) || 0,
      serialNo: p.serialNo != null ? p.serialNo : ((p.fixture && p.fixture.serialNo) || ''),
      name: p.name != null ? p.name : ((p.fixture && p.fixture.name) || ''),
      location: p.location != null ? p.location : ((p.fixture && p.fixture.location) || ''),
      reason: reason || '未导入'
    });
    (parts.parseSkipped || []).forEach((s) => push(s, s.reason || '解析未通过'));
    (parts.dupRows || []).forEach((p) => push(p, '与库内记录完全一致（选了「跳过重复」）'));
    (parts.userSkipRows || []).forEach((p) => push(p, '产线未建档，按选择跳过'));
    (parts.failRows || []).forEach((f) => push(f, f.reason || '落库失败'));
    return out.sort((a, b) => (a.row || 0) - (b.row || 0));
  }

  window.confirmImportPlan = async function (mode) {
    const plan = window.__importPlan || [];
    if (!plan.length) { closeModal(); return; }
    const skipDup = mode !== 'all';
    const skipKeys = new Set(plan._skipKeys || []);
    const parseSkipped = window.__importSkipped || [];
    const dupRows = skipDup ? plan.filter((p) => p.isDup) : [];
    const userSkipRows = plan.filter((p) => !(skipDup && p.isDup) && _rowSkipByKeys(p, skipKeys));
    const effective = plan.filter((p) => !(skipDup && p.isDup) && !_rowSkipByKeys(p, skipKeys));
    if (!effective.length) {
      window.__importPlan = null;
      window.__importSkipped = null;
      closeModal();
      /* 一行都没进库时也要能导出明细，否则「全部跳过」同样是黑盒 */
      const noneIn = collectNotImported({ parseSkipped, dupRows, userSkipRows });
      if (!noneIn.length) {
        toast(`没有需要导入的行（重复 ${dupRows.length} 条 / 选择跳过 ${userSkipRows.length} 条）`, 'warn');
        return;
      }
      showImportResult({ added: 0, failed: 0, dup: dupRows.length, userSkip: userSkipRows.length, batchId: '', notImported: noneIn });
      return;
    }

    /* ① 只对「真正要落库」的行补建产线：被跳过的不建，避免留下空壳字典项 */
    const lineIdByName = new Map((state.lines || []).map((l) => [l.name, l.id]));
    const createdLineIds = [];      // 本批新建的产线，撤销时回收（BUG-011）
    const needLines = [];
    effective.forEach((p) => (p.fixture.lineNames || []).forEach((n) => {
      if (!lineIdByName.has(n) && !needLines.includes(n)) needLines.push(n);
    }));
    for (const name of needLines) {
      const id = await DB.add('lines', { name, remark: '导入自动建档', createdAt: Date.now() });
      lineIdByName.set(name, id);
      createdLineIds.push(id);
    }

    /* ② 分片批量落库（v5.6.0，BUG-014）
     *
     * 原实现：for 每一行 await DB.fixtureAdd() ⇒ 主进程每条都 fs.writeFileSync 整个
     * fixture-data.json。实测单次写盘 ~50ms（9000 条库 / 4.8MB 文件），4114 行累计要写
     * 十几 GB，窗口几分钟无响应，用户以为卡死 → 反复重试 → 数据翻倍（实测被堆到 8999 条）。
     *
     * 现在：按 IMPORT_CHUNK 分片交给主进程一次落盘（每片 1 次写），片间 await 让出一帧，
     * 进度条可见、窗口不假死。整批 4114 行从「4000+ 次写盘」降到「9 次写盘」。 */
    const batchId = 'b' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    /* 记录本批新建的结构项 —— 撤销时若已无人引用就一并回收（BUG-011）。 */
    window.__importCreatedByBatch = window.__importCreatedByBatch || {};
    window.__importCreatedByBatch[batchId] = { lineIds: createdLineIds.slice() };
    let added = 0, failed = 0;
    const canBatch = typeof DB.fixtureAddBatch === 'function';
    /* v5.7.0：落库失败的行必须逐条留证（行号 + 编号 + 原因），供结果窗口展示与导出 */
    const failRows = [];
    const noteFail = (p, msg) => failRows.push({
      row: p && p.row,
      serialNo: p && p.fixture ? p.fixture.serialNo : '',
      name: p && p.fixture ? p.fixture.name : '',
      location: p && p.fixture ? p.fixture.location : '',
      reason: '落库失败：' + (msg || '未知原因')
    });
    showImportProgress(effective.length);
    for (let base = 0; base < effective.length; base += IMPORT_CHUNK) {
      const chunk = effective.slice(base, base + IMPORT_CHUNK);
      const payload = chunk.map((p) => {
        const lineIds = [];
        (p.fixture.lineNames || []).forEach((n) => {
          const id = lineIdByName.get(n);
          if (id != null && !lineIds.includes(id)) lineIds.push(id);
        });
        return {
          serialNo: p.fixture.serialNo,
          name: p.fixture.name,
          lineModels: p.fixture.lineModels,
          category: p.fixture.category,
          location: p.fixture.location,
          remark: p.fixture.remark,
          lines: lineIds,
          importBatch: batchId
        };
      });
      if (canBatch) {
        try {
          const res = await DB.fixtureAddBatch(payload);
          added += (res && res.added) || 0;
          failed += (res && Array.isArray(res.failed)) ? res.failed.length : 0;
          if (res && res.failed) res.failed.forEach((f) => noteFail(chunk[f.index], f.message));
        } catch (err) {
          /* 整片失败：逐行登记，避免只留一个数字 */
          failed += chunk.length;
          chunk.forEach((p) => noteFail(p, (err && err.message) || '分片写入异常'));
        }
      } else {
        /* 兜底：老 preload 没有批量通道时退回逐条（慢，但不会崩） */
        for (let i = 0; i < payload.length; i++) {
          try { await DB.fixtureAdd(payload[i]); added++; }
          catch (err) { failed++; noteFail(chunk[i], err && err.message); }
        }
      }
      setImportProgress(Math.min(base + chunk.length, effective.length), effective.length);
      /* 主进程写盘是同步的：不主动让出一帧，进度条根本不会刷新 */
      await new Promise((r) => setTimeout(r, 0));
    }
    const notImported = collectNotImported({ parseSkipped, dupRows, userSkipRows, failRows });
    window.__importPlan = null;
    window.__importSkipped = null;
    closeModal();
    await reloadAll();
    renderFixtures();
    showImportResult({ added, failed, dup: dupRows.length, userSkip: userSkipRows.length, batchId, notImported });
  };

  /* 导出未导入明细（v5.7.0）：结果窗口的按钮与「一行都没进库」的分支共用。
   * CSV 与其它导出同为 UTF-8 BOM + CRLF，Excel 双击直接乱码免疫。 */
  window.exportImportNotImported = function () {
    const list = window.__importNotImported || [];
    if (!list.length) { toast('本次没有未导入的数据行', 'warn'); return; }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes());
    const rows = list.map((x) => [x.row, x.serialNo, x.name, x.location, x.reason]);
    download('未导入明细_' + stamp + '.csv', buildCsvText(['行号', '夹具编号', '名称', '库位', '未导入原因'], rows));
    toast('已导出 ' + list.length + ' 条未导入明细（含未导入原因）', 'ok');
  };

  /* 导入结果弹窗：给出本次统计 + 未导入明细 + 「撤销本次导入」入口
   * （toast 会消失，撤回就没机会点了） */
  function showImportResult(r) {
    const parts = [`新增 <b>${r.added}</b> 条`];
    if (r.failed) parts.push(`失败 <b>${r.failed}</b> 条`);
    if (r.dup) parts.push(`跳过重复 <b>${r.dup}</b> 条`);
    if (r.userSkip) parts.push(`按选择跳过 <b>${r.userSkip}</b> 条`);
    const notIn = Array.isArray(r.notImported) ? r.notImported : [];
    window.__importNotImported = notIn;
    /* ⚠️ 表格只渲染前 200 行，避免几千条未导入时又把窗口拖死（导出 CSV 才是完整版） */
    const PREVIEW_MAX = 200;
    const rowsHtml = notIn.slice(0, PREVIEW_MAX).map((x) => `<tr>
        <td>${x.row || '—'}</td>
        <td>${esc(x.serialNo || '—')}</td>
        <td>${esc(x.name || '—')}</td>
        <td>${esc(x.location || '—')}</td>
        <td>${esc(x.reason)}</td>
      </tr>`).join('');
    const notInBlock = notIn.length ? `
      <div class="tip" style="margin-top:12px;border-color:#e0b34d;background:#fff8e6;color:#8a5a00;">
        有 <b>${notIn.length}</b> 行<b>没有导入</b>，逐行明细如下（按行号升序）。
      </div>
      <div style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:6px;margin-top:8px;">
        <table class="table" style="margin:0;">
          <thead><tr><th style="width:70px;">行号</th><th>夹具编号</th><th>名称</th><th>库位</th><th>未导入原因</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      ${notIn.length > PREVIEW_MAX ? `<p class="muted" style="margin:6px 0 0;">窗口内仅列前 ${PREVIEW_MAX} 行；导出 CSV 可拿到全部 ${notIn.length} 行。</p>` : ''}
    ` : '';
    const body = `
      <div class="tip">导入完成：${parts.join('，')}。</div>
      ${r.added ? `<p class="muted" style="margin:10px 0 0;">如需回退，可点「撤销本次导入」精确移除本次新增的 ${r.added} 条，
        不影响此前导入或手工建档的记录。该按钮关窗后失效，也可以在「夹具管理」里逐条删除。</p>` : ''}
      ${notInBlock}
      <div class="form-actions">
        ${notIn.length ? `<button class="btn" onclick="exportImportNotImported()">⬇ 导出未导入明细 CSV（${notIn.length} 条）</button>` : ''}
        ${r.added ? `<button class="btn danger" onclick="undoFixtureImport('${r.batchId}')">↩ 撤销本次导入 ${r.added} 条</button>` : ''}
        <button class="btn primary" onclick="closeModal()">完成</button>
      </div>
    `;
    openModal('导入结果', body);
  }

  /* 撤销导入时该回收哪些「本批自动补建」的产线（纯函数，便于测试）。
   * 规则：只回收本批新建、且撤销后已没有任何夹具引用的产线。
   * created = { lineIds:[] }，由 confirmImportPlan 记录（BUG-011）。 */
  function planStructureRecycle(created, fixtures) {
    const usedLine = new Set();
    (fixtures || []).forEach((f) => (f.lines || []).forEach((l) => usedLine.add(Number(l))));
    const createdLine = ((created && created.lineIds) || []).map(Number);
    return createdLine.filter((lid) => !usedLine.has(lid));
  }

  /* 撤销本次导入：按批次号删除本批记录（连带清理其流水），
   * 并回收本批「自动补建」且撤销后已无人引用的产线（BUG-011）。 */
  window.undoFixtureImport = async function (batchId) {
    if (!batchId) return;
    const list = state.fixtures.filter((f) => f.importBatch === batchId);
    if (!list.length) { closeModal(); toast('没有可撤销的记录（可能已被删除）', 'warn'); return; }
    if (!confirm(`确认撤销本次导入的 ${list.length} 条夹具？\n只删除这一批，不影响其它记录。`)) return;
    let ok = 0, fail = 0;
    for (const f of list) {
      try { await DB.fixtureDel(f.id); ok++; } catch (err) { fail++; console.warn('撤销失败', f.id, err && err.message); }
    }
    closeModal();
    await reloadAll();
    /* ③ 回收结构项：只回收本批新建、且已无任何夹具引用的产线。
     * 不能只看 lineIds —— 同一产线可能同时被别的批次或手工建档的夹具使用。 */
    const created = (window.__importCreatedByBatch || {})[batchId];
    let recycledLine = 0;
    if (created) {
      try {
        const lineIds = planStructureRecycle(created, state.fixtures || []);
        for (const lid of lineIds) {
          try { await DB.lineDel(lid); recycledLine++; } catch (e) { /* 已不存在则忽略 */ }
        }
        if (recycledLine) await reloadAll();
      } catch (e) {
        console.warn('回收本次导入新建的产线失败', e);
      }
      delete window.__importCreatedByBatch[batchId];
    }
    renderFixtures();
    const recycled = recycledLine ? `，并回收自动补建的 ${recycledLine} 条产线` : '';
    toast(fail ? `已撤销 ${ok} 条，${fail} 条失败${recycled}` : `已撤销本次导入，删除 ${ok} 条${recycled}`, fail ? 'warn' : 'ok');
  };

  /* 整份表都不可导入时的详细说明（BUG-007：原来只弹一句「没有可导入的有效数据行」，用户无法定位） */
  function showImportFailure(result, sourceName) {
    const sk = Array.isArray(result && result.skipped) ? result.skipped : [];
    const cnt = new Map();
    sk.forEach((s) => cnt.set(s.reason, (cnt.get(s.reason) || 0) + 1));
    const ranked = Array.from(cnt.entries()).sort((a, b) => b[1] - a[1]);
    const body = `
      <div class="tip" style="border-color:#d9534f;background:#fdf0ef;color:#a12622;">
        <b>${esc(sourceName || '该文件')}</b> 中没有任何一行可以导入${sk.length ? `：共 <b>${sk.length}</b> 行被跳过` : ''}。
      </div>
      ${ranked.length ? `
      <table class="table" style="margin:10px 0 0;">
        <thead><tr><th>跳过原因</th><th style="width:90px;">行数</th></tr></thead>
        <tbody>
          ${ranked.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}
        </tbody>
      </table>` : ''}
      ${sk.length ? `<p class="muted" style="margin:10px 0 0;">前 10 条明细：${esc(sk.slice(0, 10).map((s) => '第 ' + s.row + ' 行(' + s.reason + ')').join('、'))}${sk.length > 10 ? ' 等' : ''}</p>` : ''}
      <p class="muted" style="margin:10px 0 0;">常见原因：<b>产线为空</b>（建档要求至少 1 条产线）；<b>库位不是 4 段式</b>（如 ZP1-U-1-1）；名称为空；机种全部为空。</p>
      <div class="form-actions">
        ${sk.length ? `<button class="btn" onclick="exportImportNotImported()">⬇ 导出全部跳过明细 CSV（${sk.length} 条）</button>` : ''}
        <button class="btn primary" onclick="closeModal()">知道了</button>
      </div>
    `;
    /* v5.7.0：整表不可导入时，同样把完整明细交给导出按钮（原来只有前 10 条文字） */
    window.__importNotImported = collectNotImported({ parseSkipped: sk });
    openModal('导入失败：没有可用的行', body);
  }

  /* 导入入口：弹系统文件框 → 读取 → 解析 → 预览 → 确认 */
  window.fixtureImport = async function () {
    const api = window.api;
    if (!api || typeof api.pickSpreadsheet !== 'function') {
      toast('当前环境不支持文件选择，请用 CSV 方式导入', 'err');
      return;
    }
    try { await reloadLineConfig(); } catch (e) { /* 读不到按空配置处理 */ }
    let picked;
    try { picked = await api.pickSpreadsheet(); }
    catch (e) { toast('读取文件失败：' + e.message, 'err'); return; }
    if (!picked || picked.ok === false) {
      if (picked && picked.error) toast('读取失败：' + picked.error, 'err');
      return;
    }

    let rows = null;
    try {
      if (picked.kind === 'csv') {
        rows = parseCSV(picked.text);
      } else {
        const r = await api.readSpreadsheet(picked.bytes);
        if (!r || !r.ok) { toast('解析 Excel 失败：' + ((r && r.error) || '未知错误'), 'err'); return; }
        if (r.sheetNames && r.sheetNames.length > 1) {
          toast(`「${picked.name}」含 ${r.sheetNames.length} 张工作表，默认读取第 1 张（${r.sheetName}）`, 'warn');
        }
        rows = r.rows;
      }
    } catch (e) { toast('解析失败：' + e.message, 'err'); return; }

    const result = buildImportPlan(rows, { fixtures: state.fixtures, lines: state.lines });
    if (!result.ok) { showImportFailure(result, picked.name); return; }

    // 先处理「产线未建档」对话框，确认后再进预览
    const missingMap = await window.showModalMissingLines(result.plan);
    if (missingMap === null) return; // 用户取消

    // 应用用户的选择（skip 的行写入 plan._skipKeys，不再补建）
    const skipKeys = [];
    missingMap.forEach((v, k) => { if (v === 'skip') skipKeys.push(k); });
    result.plan._skipKeys = skipKeys;

    window.showImportPreview(result, picked.name);
  };

  /* 下载导入模板（CSV，含示例行，Excel 可直接打开另存为 xlsx）
   * 列定义与「导出CSV」共用 FIX_IMPORT_HEADERS / buildCsvText ⇒ 两文件除示例行外完全一致。
   * v5.0.0 起只填产线（产线1~产线5），没有工位列。 */
  window.downloadFixtureTemplate = function () {
    /* 示例行**按表头位置生成**，机种/产线列数随 MAX_LINE_MODELS / MAX_LINES 自动变化 ——
     * 不再手写固定列数的数组（v5.4.0 机种 7→12 时踩过：改了表头却漏改示例行，模板与模板列数不一致）。 */
    const mkSample = (o) => {
      const r = FIX_IMPORT_HEADERS.map(() => '');
      const base = 2, lmEnd = base + MAX_LINE_MODELS, lineStart = lmEnd + 2;
      r[0] = o.serialNo || '';
      r[1] = o.name || '';
      (o.models || []).slice(0, MAX_LINE_MODELS).forEach((m, i) => { r[base + i] = m; });
      r[lmEnd] = o.category || '';
      r[lmEnd + 1] = o.location || '';
      (o.lines || []).slice(0, MAX_LINES).forEach((ln, i) => { r[lineStart + i] = ln; });
      r[r.length - 1] = o.remark || '';
      return r;
    };
    const sample = [
      /* 一套夹具 = 一行；本例机种填满 12 位、关联 2 条产线 */
      mkSample({
        serialNo: 'DH40MC-921-001-001', name: '定位销压板',
        models: ['DH40MC', 'DH40MC-B', 'DH40MC-C', 'DH40MC-D', 'DH40MC-E', 'DH40MC-F',
          'DH40MC-G', 'DH40MC-H', 'DH40MC-I', 'DH40MC-J', 'DH40MC-K', 'DH40MC-L'],
        category: '金属', location: 'ZP1-U-1-1',
        lines: ['3 号线', 'L2 U型线'],
        remark: '满机种示例：12 个机种位全部填满，一条夹具挂在两条线上'
      }),
      /* 同编号的第 2 套：单机种单产线 */
      mkSample({
        serialNo: 'DH40MC-921-001-001', name: '定位销压板',
        models: ['DH40MC'], category: '金属', location: 'ZP1-U-1-2',
        lines: ['3 号线'], remark: '同编号的第 2 套；没用到的机种列留空即可'
      }),
      /* 分类可用预设值（金属 / PVC / 亚克力 / 橡胶…），也可自行填写新分类 */
      mkSample({
        serialNo: 'XXK-D10VG-002', name: '焊接夹具',
        models: ['XXK-D10VG'], category: 'PVC', location: 'ZP1-U-2-1',
        lines: ['L2 U型线'], remark: ''
      })
    ];
    download('夹具导入模板.csv', buildCsvText(FIX_IMPORT_HEADERS, sample));
    toast('模板已下载：列结构与「导出CSV」一致；机种最多填 12 个（机种名称1~12），产线最多填 5 条', 'ok');
  };

  window.fixtureRetire = function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) { toast('夹具不存在', 'err'); return; }
    if (f.status === 'retired') { toast('夹具已报废', 'warn'); return; }
    openModal(`报废 — ${f.serialNo || (f.code)} ${f.name}`, `
      <div class="form-group"><label>夹具</label><input type="text" value="${esc(f.serialNo || '')} ${esc(f.name)}（序号 ${esc(f.code)}）" disabled></div>
      <div class="form-group"><label>报废时间</label><input type="datetime-local" id="fix_retire_time" value="${nowInput()}"></div>
      <div class="form-group"><label>报废原因</label><input type="text" id="fix_retire_remark" placeholder="如：精度超差无法修复"></div>
      <p class="muted" style="color:var(--danger);margin:8px 0 0;">报废后不可恢复，请谨慎操作。</p>
      <div class="form-actions">
        <button class="btn danger" onclick="submitFixtureRetire(${id})">确认报废</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `);
  };

  window.submitFixtureRetire = async function (id) {
    const time = inputToMs($('#fix_retire_time').value);
    const remark = (($('#fix_retire_remark') || {}).value || '').trim();
    const operator = '';   // v5.6.0：不再采集经办人
    try {
      await DB.fixtureAddTransaction({ fixtureId: id, type: 'retire', operator, time, remark: remark || '报废' });
      closeModal();
      await reloadAll();
      renderFixtures();
      toast('夹具已报废', 'ok');
    } catch (e) { toast('报废失败：' + e.message, 'err'); }
  };

  /* ---------------- 删除夹具（纠正录错 / 重复建档） ----------------
   * 与「报废」的分工：报废 = 业务状态流转，记录留档可追溯；
   * 删除 = 抹掉这条记录本身，不可恢复，仅用于「本来就不该有这条」的场景。
   * 删除会连带清掉该夹具的流水，因此确认弹窗必须先把代价讲清楚。 */
  window.fixtureDelete = function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) { toast('夹具不存在', 'err'); return; }
    const st = FIX_STATUS[f.status] || { label: f.status || '—' };
    const txCount = (state.fixTransactions || []).filter((t) => t.fixtureId === id).length;
    const riskyText = f.status === 'checked_out'
      ? '该夹具当前<b>已出库未回库</b>，删除会丢掉这条借出记录，借用人将无法再通过系统查到它。'
      : (f.status === 'repair' ? '该夹具当前<b>处于维修中</b>，删除会丢掉未完成的维修记录。' : '');
    openModal(`删除 — ${f.serialNo || f.code} ${f.name}`, `
      <div class="form-group"><label>夹具编号</label><input type="text" value="${esc(f.serialNo || '（未填编号）')}" disabled></div>
      <div class="form-group"><label>名称 / 序号</label><input type="text" value="${esc(f.name)}（序号 ${esc(f.code)}）" disabled></div>
      <div class="form-group"><label>状态 / 库位</label><input type="text" value="${esc(st.label)} ｜ ${esc(f.location || '无库位')}" disabled></div>
      <div class="form-group"><label>关联流水</label><input type="text" value="${txCount} 条${txCount ? '（将一并删除）' : '（无流水）'}" disabled></div>
      ${riskyText ? `<p style="color:var(--danger);margin:8px 0 0;">⚠️ ${riskyText}</p>` : ''}
      <p style="color:var(--danger);margin:8px 0 0;">删除后<b>不可恢复</b>。若只是夹具损坏或停用，请改用「报废」保留记录。</p>
      <div class="form-actions">
        <button class="btn danger" onclick="fixtureDeleteConfirm(${id})">确认删除</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `);
  };

  window.fixtureDeleteConfirm = async function (id) {
    try {
      await DB.fixtureDel(id);
      closeModal();
      if (state.fixSelectedId === id) state.fixSelectedId = 0;
      await reloadAll();
      /* 在「夹具查询」页删除时就地重跑查询，避免整页被切回夹具管理 */
      if ($('#query_results')) renderQueryResults(applyQueryFilters(state.query));
      else renderFixtures();
      toast('夹具已删除', 'ok');
    } catch (e) { toast('删除失败：' + (e && e.message ? e.message : e), 'err'); }
  };

  function renderFixtureCards(container, fixtures, selectedId = 0) {
    if (!fixtures.length) { container.innerHTML = '<div class="empty-tip">暂无夹具记录</div>'; return; }
    const html = fixtures.map((f) => {
      const isSelected = f.id === selectedId;
      const status = FIX_STATUS[f.status] || { label: f.status, cls: '' };
      return `
        <div class="fixture-card ${isSelected ? 'selected' : ''}" data-id="${f.id}" onclick="fixtureSelect(${f.id})">
          <div class="fixture-card-header">
            <span class="fixture-serial" title="夹具编号">${esc(f.serialNo || '（未填编号）')}</span>
            <span class="status-badge status-${status.cls}">${status.label}</span>
          </div>
          <div class="fixture-card-body">
            <div class="fixture-name">${esc(f.name)} <span class="bridge-code" title="序号（系统自动分配）">${esc(f.code)}</span></div>
            <div class="fixture-spec" title="${esc(fullLineModels(f, '—'))}">机种：${esc(formatLineModels(f, '—', { collapse: 2 }))}</div>
            <div class="fixture-spec fixture-ls" title="产线：${esc(lineNamesLabel(f, '—'))}">产线：${esc(lineNamesLabel(f, '—'))}</div>
            <div class="fixture-meta"><span>库位 ${esc(f.location || '—')}</span><span>出库 ${f.totalOutCount || 0} 次</span><span>回库 ${f.totalReturnCount || 0} 次</span></div>
          </div>
          <div class="fixture-card-footer">
            ${f.status === 'stocked' ? `
              <button class="btn sm" onclick="event.stopPropagation(); fixtureOut(${f.id})">出库</button>
              <button class="btn sm" onclick="event.stopPropagation(); fixtureRepair(${f.id})">送修</button>
            ` : ''}
            ${f.status === 'checked_out' ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureReturn(${f.id})">回库</button>` : ''}
            ${f.status === 'repair' ? `<button class="btn sm primary" onclick="event.stopPropagation(); fixtureRepairComplete(${f.id})">维修完成</button>` : ''}
            <button class="btn sm ghost" onclick="event.stopPropagation(); fixtureEdit(${f.id})">编辑</button>
            ${f.status !== 'retired' ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureRetire(${f.id})">报废</button>` : ''}
            <button class="btn sm ghost" onclick="event.stopPropagation(); openFixtureQR(${f.id})">二维码</button>
            <button class="btn sm danger" title="仅用于录错 / 重复建档；报废请用「报废」" onclick="event.stopPropagation(); fixtureDelete(${f.id})">删除</button>
          </div>
        </div>
      `;
    }).join('');
    container.innerHTML = `<div class="fixture-grid">${html}</div>`;
  }

  /* 列表视图（表格）：紧凑展示全部夹具字段 + 操作按钮 */
  function renderFixtureList(container, fixtures, selectedId = 0) {
    if (!fixtures.length) { container.innerHTML = '<div class="empty-tip">暂无夹具记录</div>'; return; }
    const html = `
      <div class="table-wrap"><table>
        <thead><tr><th style="width:64px">序号</th><th style="width:150px">夹具编号</th><th>名称</th><th>机种名称</th><th>产线</th><th>分类</th><th>库位</th><th>状态</th><th>累计出库</th><th>累计回库</th><th style="width:190px">操作</th></tr></thead>
        <tbody>
          ${fixtures.map((f) => {
            const st = FIX_STATUS[f.status] || { label: f.status, cls: 'muted' };
            const isSelected = f.id === selectedId;
            return `<tr class="${isSelected ? 'selected' : ''}" data-id="${f.id}" onclick="fixtureSelect(${f.id})">
              <td class="muted">${esc(f.code)}</td><td>${esc(f.serialNo || '—')}</td><td>${esc(f.name)}</td>
              <td title="${esc(fullLineModels(f, '—'))}">${esc(formatLineModels(f, '—', { collapse: 2 }))}</td>
              <td title="${esc(lineNamesLabel(f, '—'))}">${esc(lineNamesLabel(f, '—'))}</td>
              <td>${esc(f.category || '—')}</td><td>${esc(f.location || '—')}</td>
              <td><span class="badge ${st.cls}">${st.label}</span></td>
              <td>${f.totalOutCount || 0}</td><td>${f.totalReturnCount || 0}</td>
              <td><span class="row-actions">
                ${f.status === 'stocked' ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureOut(${f.id})">出库</button><button class="btn sm" onclick="event.stopPropagation(); fixtureRepair(${f.id})">送修</button>` : ''}
                ${f.status === 'checked_out' ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureReturn(${f.id})">回库</button>` : ''}
                ${f.status === 'repair' ? `<button class="btn sm primary" onclick="event.stopPropagation(); fixtureRepairComplete(${f.id})">维修完成</button>` : ''}
                <button class="btn sm ghost" onclick="event.stopPropagation(); fixtureEdit(${f.id})">编辑</button>
                ${f.status !== 'retired' ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureRetire(${f.id})">报废</button>` : ''}
                <button class="btn sm ghost" onclick="event.stopPropagation(); openFixtureQR(${f.id})">二维码</button>
                <button class="btn sm danger" title="仅用于录错 / 重复建档；报废请用「报废」" onclick="event.stopPropagation(); fixtureDelete(${f.id})">删除</button>
              </span></td></tr>`;
          }).join('')}
        </tbody>
      </table></div>`;
    container.innerHTML = html;
  }

  /* 统一渲染入口：按视图模式渲染卡片或列表
   *
   * ⚠️ 必须限流（v5.6.0，BUG-014）：导入 4000+ 条后一次渲染 9000 张卡片
   *    （每张 6~7 个按钮 + 大量样式）会让渲染进程长时间无响应，看起来就是「卡死」。
   *    默认只渲染前 FIX_RENDER_LIMIT 条，底部给「显示更多」与全文条数提示。 */
  const FIX_RENDER_LIMIT = 300;

  function renderFixtureArea(container, fixtures, selectedId = 0) {
    const total = fixtures.length;
    const limit = Math.max(FIX_RENDER_LIMIT, state.fixShown || 0);
    const shown = total > limit ? fixtures.slice(0, limit) : fixtures;
    if (state.fixViewMode === 'list') renderFixtureList(container, shown, selectedId);
    else renderFixtureCards(container, shown, selectedId);
    if (total > shown.length) {
      const more = document.createElement('div');
      more.className = 'render-more';
      more.innerHTML = `
        <span>共 <b>${total}</b> 条，当前只渲染前 <b>${shown.length}</b> 条（避免上万条一次渲染拖死界面）。</span>
        <button class="btn sm" onclick="showMoreFixtures()">再显示 ${Math.min(FIX_RENDER_LIMIT, total - shown.length)} 条</button>
        <span class="muted">用上方搜索框缩小范围最快</span>`;
      container.appendChild(more);
    }
  }

  window.setFixViewMode = function (mode) {
    if (mode !== 'card' && mode !== 'list') return;
    state.fixViewMode = mode;
    renderFixtures();
  };

  function renderFixTransactions(container, txs, filterId = null) {
    if (!txs.length) { container.innerHTML = '<div class="empty-tip">暂无流水记录</div>'; return; }
    const filtered = filterId ? txs.filter((t) => t.fixtureId === filterId) : txs;
    if (!filtered.length) { container.innerHTML = '<div class="empty-tip">无匹配记录</div>'; return; }
    const html = `
      <div class="tx-list">
        <div class="tx-row tx-header">
          <div>类型</div><div>夹具</div><div>状态</div><div>经办人</div><div>领用人</div><div>时间</div><div>备注</div><div>出库原因</div>
        </div>
        ${filtered.map((t) => {
          const tc = FIX_TX_TYPE[t.type] || { label: t.type, icon: '📋' };
          const fs = FIX_STATUS[t.fromStatus] || { label: t.fromStatus };
          const ts = FIX_STATUS[t.toStatus] || { label: t.toStatus };
          const reasonLabel = t.outReason ? (() => {
            if (t.outReason === 'other' && t.outReasonText) return '其它（' + esc(t.outReasonText) + '）';
            return OUT_REASON_LABEL[t.outReason] || t.outReason;
          })() : '';
          return `
            <div class="tx-row">
              <div class="tx-type">${tc.icon} ${tc.label}</div>
              <div class="tx-fixture">${esc(t.fixtureCode)} ${esc(t.fixtureName)}${t.fixtureSerialNo ? `<span class="tx-serial">${esc(t.fixtureSerialNo)}</span>` : ''}</div>
              <div class="tx-status">${fs.label} → ${ts.label}</div>
              <div class="tx-operator">${esc(t.operator || '-')}</div>
              <div class="tx-party">${esc(t.counterparty || '-')}</div>
              <div class="tx-time">${fmtTime(t.time)}</div>
              <div class="tx-remark">${esc(t.remark || '-')}</div>
              <div class="tx-reason">${reasonLabel || '-'}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
    container.innerHTML = html;
  }

  function renderFixtures() {
    const container = $('#content');
    if (!container) return;
    state.fixShown = FIX_RENDER_LIMIT;   // 整页重绘 = 重新从第一页开始渲染
    const inStock = state.fixtures.filter((f) => f.status === 'stocked').length;
    const outStock = state.fixtures.filter((f) => f.status === 'checked_out').length;
    const repair = state.fixtures.filter((f) => f.status === 'repair').length;
    const retired = state.fixtures.filter((f) => f.status === 'retired').length;
    container.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          夹具管理
          <span class="panel-actions">
            <button class="btn sm" onclick="fixtureNew()">➕ 新建夹具</button>
            <button class="btn sm" onclick="fixtureImport()">⬆ 导入Excel/CSV</button>
            <button class="btn sm" onclick="downloadFixtureTemplate()">📄 下载模板</button>
            <button class="btn sm" onclick="batchPrintLabels()">🏷 批量打印标签</button>
            <button class="btn sm" onclick="fixtureExportCSV()">📊 导出CSV</button>
          </span>
        </div>
        <div class="stats-bar">
          <div class="stat-item"><span class="stat-label">总计</span><span class="stat-value">${state.fixtures.length}</span></div>
          <div class="stat-item"><span class="stat-label">在库</span><span class="stat-value stat-ok">${inStock}</span></div>
          <div class="stat-item"><span class="stat-label">已出库</span><span class="stat-value stat-warn">${outStock}</span></div>
          <div class="stat-item"><span class="stat-label">维修中</span><span class="stat-value stat-danger">${repair}</span></div>
          <div class="stat-item"><span class="stat-label">已报废</span><span class="stat-value stat-muted">${retired}</span></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">
          夹具列表
          <span class="panel-actions">
            <button class="btn sm ${state.fixViewMode === 'card' ? 'primary' : 'ghost'}" onclick="setFixViewMode('card')">▦ 卡片</button>
            <button class="btn sm ${state.fixViewMode === 'list' ? 'primary' : 'ghost'}" onclick="setFixViewMode('list')">☰ 列表</button>
          </span>
        </div>
        <div class="search-bar"><input type="text" id="fix_search" placeholder="搜索夹具编号 / 名称 / 机种 / 库位 / 产线…（序号需完整输入）" oninput="fixtureSearch()"></div>
        <div id="fixture_list"></div>
      </div>
      <div class="panel">
        <div class="panel-title">流水记录（点击夹具查看）</div>
        <div id="fix_tx_list"></div>
      </div>
    `;
    imeGuard($('#fix_search'), fixtureSearch);
    renderFixtureArea($('#fixture_list'), state.fixtures, state.fixSelectedId || 0);
    if (state.fixSelectedId) {
      renderFixTransactions($('#fix_tx_list'), state.fixTransactions, state.fixSelectedId);
    }
  }

  /* ============================================================
   * 夹具出库（快速操作页面）
   * ============================================================ */
  function renderOutbound() {
    $('#content').innerHTML = `
      <div class="fix-nav-out-wrap">
        <aside class="fix-nav">
          <h3>出库流程导航</h3>
          <ol>
            <li>确定夹具：扫码 / 编号 / 名称 / 机种 / 库位检索</li>
            <li>选择数量：默认 1 件，可在右侧调整</li>
            <li>刷卡录入：刷领用人工牌</li>
            <li>提交出库</li>
          </ol>
        </aside>
        <div class="fix-out-col">
          <div class="panel-title">📤 夹具出库</div>
          <div class="info-tip">
            在「夹具编号 / 名称 / 机种名称 / 库位」任一栏输入即可互查；同一夹具编号下有多套时，
            在结果区<b>勾选具体序号</b>即可一次出库多套。
          </div>
          <div class="multi-search search-row">
            <div class="input-scan">
              <input type="text" id="out_code" placeholder="夹具编号 / 序号（扫描枪直接扫码）" oninput="outSearch()">
              <button class="btn-scan" title="拍照扫码" onclick="scanForFixOut()">📷</button>
            </div>
            <input type="text" id="out_name" placeholder="名称（可检索并自动回填）" oninput="outSearch()">
            <input type="text" id="out_spec" placeholder="机种名称" oninput="outSearch()">
            <div class="input-scan">
              <input type="text" id="out_location" placeholder="库位（扫码反查夹具）" oninput="outSearch()">
              <button class="btn-scan" title="拍照扫码" onclick="scanForFixOut()">📷</button>
            </div>
          </div>
          <div class="stock-bar">可出库：<b id="out_avail">0</b> 套
            <span class="muted">同一夹具编号可能有多套，下方按「名称 + 机种」分组，勾选具体序号区分</span>
            <span class="muted" id="out_loc_tip"></span>
            <label class="pick-all-bar" id="out_pick_all_wrap" title="全选当前检索到的可出库夹具，回车即提交出库">
              <input type="checkbox" id="out_pick_all" onchange="outToggleAll(this)">
              <span id="out_pick_all_text">全选</span>
            </label>
          </div>
          <div id="out_candidates" class="pick-list"></div>
          <div id="out_picked_summary" class="picked-summary"><span class="muted">未选择夹具</span></div>
          <div class="fix-form">
            <div class="form-row">
              <div class="form-group">
                <label>出库数量（套）</label>
                <input type="number" id="out_qty" value="1" min="1" step="1" oninput="outQtyChange()">
                <small class="hint">默认 1 套，可手动调整；不能超过上方可出库套数</small>
              </div>
              <div class="form-group">
                <label>出库时间</label>
                <input type="datetime-local" id="out_time" value="${nowInput()}">
              </div>
            </div>
            <div class="form-row">
              ${swipeFieldHtml('out')}
            </div>
            <div class="form-row form-row-inline">
              <div class="form-group">
                <label>用途</label>
                <select id="out_reason">
                  <option value="use">使用</option>
                  <option value="repair">维修</option>
                  <option value="other">其它</option>
                </select>
                <input type="text" id="out_reason_text" placeholder="如选「其它」，请填写具体内容" style="display:none;">
              </div>
              <div class="form-group" style="flex: 2;">
                <label>备注</label>
                <input type="text" id="out_remark" placeholder="可选备注">
              </div>
            </div>
            <div class="form-actions">
              <button class="btn primary" onclick="submitOutDo()">提交出库</button>
              <button class="btn ghost" onclick="clearOutSelection()">清除已选内容</button>
            </div>
          </div>
          <div id="fix_scan_out_area" style="margin-top:16px;"></div>
        </div>
      </div>
    `;
    bindOutPage();
    outSearch();
  }

  function renderReturn() {
    $('#content').innerHTML = `
      <div class="fix-nav-out-wrap">
        <aside class="fix-nav">
          <h3>回库流程导航</h3>
          <ol>
            <li>确定夹具：扫码 / 编号 / 名称 / 机种 / 库位检索</li>
            <li>选择数量：默认 1 件，可在右侧调整</li>
            <li>刷卡录入：刷退库人工牌</li>
            <li>提交回库</li>
          </ol>
        </aside>
        <div class="fix-out-col">
          <div class="panel-title">📥 夹具回库</div>
          <div class="info-tip">
            在「夹具编号 / 名称 / 机种名称 / 库位」任一栏输入即可互查已出库夹具；同一夹具编号下有多套时，
            在结果区<b>勾选具体序号</b>即可一次回库多套。
          </div>
          <div class="multi-search search-row">
            <div class="input-scan">
              <input type="text" id="return_code" placeholder="夹具编号 / 序号（扫描枪直接扫码）" oninput="returnSearch()">
              <button class="btn-scan" title="拍照扫码" onclick="scanForFixReturn()">📷</button>
            </div>
            <input type="text" id="return_name" placeholder="名称（可检索并自动回填）" oninput="returnSearch()">
            <input type="text" id="return_spec" placeholder="机种名称" oninput="returnSearch()">
            <div class="input-scan">
              <input type="text" id="return_location" placeholder="库位（扫码反查夹具）" oninput="returnSearch()">
              <button class="btn-scan" title="拍照扫码" onclick="scanForFixReturn()">📷</button>
            </div>
          </div>
          <div class="stock-bar">待回库：<b id="return_avail">0</b> 套
            <span class="muted">同一夹具编号可能有多套，下方按「名称 + 机种」分组，勾选具体序号区分</span>
            <span class="muted" id="return_loc_tip"></span>
            <label class="pick-all-bar" id="return_pick_all_wrap" title="全选当前检索到的待回库夹具，回车即提交回库">
              <input type="checkbox" id="return_pick_all" onchange="returnToggleAll(this)">
              <span id="return_pick_all_text">全选</span>
            </label>
          </div>
          <div id="return_candidates" class="pick-list"></div>
          <div id="return_picked_summary" class="picked-summary"><span class="muted">未选择夹具</span></div>
          <div class="fix-form">
            <div class="form-row">
              <div class="form-group">
                <label>回库数量（套）</label>
                <input type="number" id="return_qty" value="1" min="1" step="1" oninput="returnQtyChange()">
                <small class="hint">默认 1 套，可手动调整；不能超过上方待回库套数</small>
              </div>
              <div class="form-group">
                <label>回库时间</label>
                <input type="datetime-local" id="return_time" value="${nowInput()}">
              </div>
            </div>
            <div class="form-row">
              ${swipeFieldHtml('ret')}
            </div>
            <div class="form-row form-row-inline">
              <div class="form-group">
                <label>用途</label>
                <select id="return_reason">
                  <option value="use">使用</option>
                  <option value="repair">维修</option>
                  <option value="other">其它</option>
                </select>
                <input type="text" id="return_reason_text" placeholder="如选「其它」，请填写具体内容" style="display:none;">
              </div>
              <div class="form-group" style="flex: 2;">
                <label>备注</label>
                <input type="text" id="return_remark" placeholder="可选备注">
              </div>
            </div>
            <div class="form-actions">
              <button class="btn primary" onclick="submitReturnDo()">提交回库</button>
              <button class="btn ghost" onclick="clearReturnSelection()">清除已选内容</button>
            </div>
          </div>
          <div id="fix_scan_return_area" style="margin-top:16px;"></div>
        </div>
      </div>
    `;
    bindReturnPage();
    returnSearch();
  }

  /* 页面重绘后重新绑定：输入法守卫 + 扫码枪前缀解析 + 表单“不丢输入” */
  function bindOutPage() {
    const wrapFixes = (id) => {
      const el = $(id); if (!el) return;
      if (!el.dataset.bound) {
        imeGuard(el, outSearch);
        el.addEventListener('change', () => {
          if (id === '#out_code') {
            const code = parseQRToken(el.value);
            if (code && code !== el.value.trim()) { el.value = code; outSearch(); }
          } else {
            outSearch();
          }
        });
        el.dataset.bound = '1';
      }
    };
    ['#out_code', '#out_name', '#out_spec', '#out_location'].forEach(wrapFixes);
    /* v5.6.0 刷卡位：只剩「领用人」一个位，刷一张卡即可提交 */
    bindSwipe('out');
    // 用途下拉变化时显示/隐藏自填框
    const outReasonEl = $('#out_reason');
    if (outReasonEl) {
      outReasonEl.addEventListener('change', () => {
        const textEl = $('#out_reason_text');
        if (textEl) textEl.style.display = (outReasonEl.value === 'other') ? '' : 'none';
      });
    }
  }

  function bindReturnPage() {
    const wrapFixes = (id) => {
      const el = $(id); if (!el) return;
      if (!el.dataset.bound) {
        imeGuard(el, returnSearch);
        el.addEventListener('change', () => {
          if (id === '#return_code') {
            const code = parseQRToken(el.value);
            if (code && code !== el.value.trim()) { el.value = code; returnSearch(); }
          } else {
            returnSearch();
          }
        });
        el.dataset.bound = '1';
      }
    };
    ['#return_code', '#return_name', '#return_spec', '#return_location'].forEach(wrapFixes);
    /* v5.6.0 刷卡位：只剩「退库人」一个位，刷一张卡即可提交 */
    bindSwipe('ret');
    // 用途下拉变化时显示/隐藏自填框
    const returnReasonEl = $('#return_reason');
    if (returnReasonEl) {
      returnReasonEl.addEventListener('change', () => {
        const textEl = $('#return_reason_text');
        if (textEl) textEl.style.display = (returnReasonEl.value === 'other') ? '' : 'none';
      });
    }
  }

  /* ============================================================
   * 出库 / 回库通用：按「名称 + 机种名称」分组选择 + 数量控制
   * 同一种夹具可能登记多台（只是编号不同），在此归为一组一次性勾选。
   * ============================================================ */
  function groupFixtures(list) {
    const map = new Map();
    const order = [];
    list.forEach((f) => {
      const models = Array.isArray(f.lineModels) ? f.lineModels.slice().sort() : [];
      const key = (f.name || '') + '||' + models.join('+');
      let g = map.get(key);
      if (!g) { g = { name: f.name || '（未命名）', models, items: [] }; map.set(key, g); order.push(g); }
      g.items.push(f);
    });
    order.forEach((g) => g.items.sort((a, b) => natCompare(a.code, b.code)));
    return order;
  }

  function renderPickGroups(container, list, prefix, emptyTip, unit) {
    if (!container) return;
    if (!list.length) { container.innerHTML = `<div class="empty-tip">${esc(emptyTip)}</div>`; return; }
    const groups = groupFixtures(list);
    container.innerHTML = `
      <div class="pick-groups">
        ${groups.map((g, gi) => `
          <div class="pick-group">
            <div class="pick-group-head">
              <label class="pick-all">
                <input type="checkbox" class="${prefix}-pick-all" data-gi="${gi}" onchange="${prefix}ToggleGroup(this)">
                <b>${esc(g.name)}</b>
                ${g.models.length ? `<span class="muted">${esc(g.models.join(' / '))}</span>` : ''}
              </label>
              <span class="pick-group-count">${g.items.length} ${esc(unit)}</span>
            </div>
            <div class="pick-codes">
              ${g.items.map((f) => `
                <label class="pick-code" title="${esc(f.serialNo || '')} ${esc(f.name)}">
                  <input type="checkbox" class="${prefix}-pick" data-id="${f.id}" data-gi="${gi}" onchange="${prefix}ToggleOne()">
                  <span class="pick-code-no">${esc(f.serialNo || '（未填编号）')}</span>
                  <span class="muted">${esc(f.code)} · ${esc(f.location || '未分配')}</span>
                </label>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>`;
  }

  function pickedIds(prefix) {
    return $$('.' + prefix + '-pick').filter((c) => c.checked).map((c) => Number(c.dataset.id));
  }

  /* 组标题复选框状态随组内编号联动（全选 / 半选 / 未选） */
  function syncGroupHead(prefix) {
    $$('.' + prefix + '-pick-all').forEach((all) => {
      const gi = all.dataset.gi;
      const items = $$('.' + prefix + '-pick[data-gi="' + gi + '"]');
      all.checked = items.length > 0 && items.every((i) => i.checked);
      all.indeterminate = !all.checked && items.some((i) => i.checked);
    });
  }

  /* v5.5.0 顶栏「全选」：作用于当前检索结果的全部夹具（跨分组），配合回车即一键出库/回库 */
  function togglePickAll(prefix, checked) {
    $$('.' + prefix + '-pick').forEach((c) => { c.checked = !!checked; });
    syncGroupHead(prefix);
    syncPickToQty(prefix);
  }

  /* 顶栏全选框状态与结果区联动（全选 / 半选 / 未选），无候选时禁用 */
  function syncPickAll(prefix) {
    const box = $('#' + prefix + '_pick_all');
    const wrap = $('#' + prefix + '_pick_all_wrap');
    const textEl = $('#' + prefix + '_pick_all_text');
    const items = $$('.' + prefix + '-pick');
    const total = items.length;
    const on = items.filter((c) => c.checked).length;
    if (box) {
      box.checked = total > 0 && on === total;
      box.indeterminate = on > 0 && on < total;
      box.disabled = total === 0;
    }
    if (wrap) {
      wrap.classList.toggle('is-disabled', total === 0);
      wrap.classList.toggle('is-on', total > 0 && on === total);
    }
    if (textEl) {
      if (!total) textEl.textContent = '全选';
      else if (on === total) textEl.textContent = `已全选 ${total} 套`;
      else if (on > 0) textEl.textContent = `已选 ${on} / ${total}`;
      else textEl.textContent = `全选 ${total} 套`;
    }
  }

  /* 已选摘要：自动带出所选夹具的关联字段（名称 / 机种 / 库位），避免“选了却看不到值” */
  function renderPickedSummary(prefix) {
    const el = $('#' + prefix + '_picked_summary');
    if (!el) return;
    const list = pickedIds(prefix)
      .map((id) => state.fixtures.find((f) => f.id === id))
      .filter(Boolean);
    if (!list.length) { el.innerHTML = '<span class="muted">未选择夹具</span>'; return; }
    const first = list[0];
    const models = formatLineModels(first, '');
    const detail = [
      first.name || '',
      models,
      first.location ? '库位 ' + first.location : ''
    ].filter(Boolean).join(' · ');
    el.innerHTML = `
      <div class="summary-line">
        <b>已选 ${list.length} 套</b>
        <span class="summary-codes">${list.map((f) => esc(f.serialNo || f.code) + '(' + esc(f.code) + ')').join('、')}</span>
        <span class="muted">${esc(detail)}${list.length > 1 ? '（同编号多套，按序号区分）' : ''}</span>
      </div>
    `;
  }

  /* 勾选 → 数量（勾选为唯一数据源，数量随之自动回填） */
  function syncPickToQty(prefix) {
    const n = pickedIds(prefix).length;
    const input = $('#' + prefix + '_qty'); if (input) input.value = String(n);
    renderPickedSummary(prefix);
    syncPickAll(prefix);
  }

  /* v5.7.1（BUG-017）：提交前只校验、绝不改写勾选。
     旧实现在 submitOutDo / submitReturnDo 里无条件调用 syncQtyToPick()，
     那句会按「候选列表前 N 个」重勾 ⇒ 用户手勾的几件被整片抹掉，
     出库的变成列表最前面那几件，而界面没有任何提示。
     现在勾选是唯一数据源：数量框只跟随勾选回填，两者不一致时明确告知「按勾选提交」。 */
  function prepareSubmitPicks(prefix) {
    const ids = pickedIds(prefix);
    const input = $('#' + prefix + '_qty');
    const typed = input ? parseInt(input.value, 10) : NaN;
    if (!ids.length) return ids;
    if (input && !isNaN(typed) && typed !== ids.length) {
      toast(`数量框填的是 ${typed} 套，实际勾选 ${ids.length} 套，已按勾选提交`, 'warn');
    }
    if (input) input.value = String(ids.length);
    renderPickedSummary(prefix);
    syncPickAll(prefix);
    return ids;
  }

  /* 数量输入 → 自动勾选前 N 台（超上限归正到上限并提示）
     ⚠️ 只允许在「用户主动改数量框」时调用（outQtyChange / returnQtyChange）。
     提交路径**不得**调用本函数，否则会覆盖用户的手动勾选（BUG-017）。 */
  function syncQtyToPick(prefix) {
    const input = $('#' + prefix + '_qty');
    const items = $$('.' + prefix + '-pick');
    if (!input || !items.length) return;
    const max = items.length;
    let n = parseInt(input.value, 10);
    /* v5.5.0：0 / 负数 / 空串 = 「一套都不选」，即「取消全选」后的正常状态。
       旧实现会强行补成 1 套 ⇒ 用户取消全选后直接回车会莫名提交 1 套。 */
    if (isNaN(n) || n < 0) n = 0;
    if (n > max) {
      input.value = String(max);
      toast(`数量不能超过当前可操作 ${max} 套`, 'warn');
      n = max;
    }
    items.forEach((c, i) => { c.checked = i < n; });
    syncGroupHead(prefix);
  }

  function clearPickState(prefix) {
    $$('.' + prefix + '-pick').forEach((c) => { c.checked = false; });
    $$('.' + prefix + '-pick-all').forEach((c) => { c.checked = false; c.indeterminate = false; });
    const input = $('#' + prefix + '_qty'); if (input) input.value = '1';
    renderPickedSummary(prefix);
    syncPickAll(prefix);
  }

  /* ============================================================
   * 出库页面逻辑
   * ============================================================ */
  window.outSearch = function () {
    const code = ($('#out_code') || {}).value.trim().toLowerCase();
    const name = ($('#out_name') || {}).value.trim().toLowerCase();
    const lm = ($('#out_spec') || {}).value.trim().toLowerCase();
    const location = ($('#out_location') || {}).value.trim().toLowerCase();
    const nav = $('#out_nav'); if (nav) nav.hidden = false;
    const inStock = state.fixtures.filter((f) => f.status === 'stocked');
    const filtered = inStock.filter((f) =>
      matchCodeField(f, code) &&
      (!name || (f.name || '').toLowerCase().includes(name)) &&
      (!lm || lineModelsMatch(f, lm)) &&
      (!location || (f.location || '').toLowerCase().includes(location))
    );
    state.outAvailable = filtered.length;
    const availEl = $('#out_avail'); if (availEl) availEl.textContent = String(filtered.length);
    const locTip = $('#out_loc_tip');
    if (locTip) locTip.textContent = location ? `（库位含「${location}」的在库 ${filtered.length} 套）` : '';
    const container = $('#out_candidates');
    if (!container) return;
    if (!code && !name && !lm && !location) {
      container.innerHTML = '<div class="empty-tip">在上方任一栏输入即可检索在库夹具</div>';
      renderPickedSummary('out');
      syncPickAll('out');
      return;
    }
    renderPickGroups(container, filtered, 'out', '未找到匹配的在库夹具', '台在库');
    syncPickToQty('out');
  };

  window.outToggleOne = function () { syncGroupHead('out'); syncPickToQty('out'); };

  window.outToggleGroup = function (el) {
    const gi = el.dataset.gi;
    $$('.out-pick[data-gi="' + gi + '"]').forEach((c) => { c.checked = el.checked; });
    syncGroupHead('out');
    syncPickToQty('out');
  };

  /* 顶栏全选：一次勾上当前检索结果的全部在库夹具 ⇒ 回车（或点「提交出库」）即一键出库 */
  window.outToggleAll = function (el) { togglePickAll('out', el.checked); };

  window.outQtyChange = function () {
    syncQtyToPick('out');
    syncPickToQty('out');
  };

  /* 页面表单：清空与夹具相关的选择结果，避免残留上一次内容 */
  window.clearOutSelection = function () {
    const codeEl = $('#out_code'); if (codeEl) codeEl.value = '';
    const nameEl = $('#out_name'); if (nameEl) nameEl.value = '';
    const specEl = $('#out_spec'); if (specEl) specEl.value = '';
    const locEl = $('#out_location'); if (locEl) locEl.value = '';
    const reasonEl = $('#out_reason'); if (reasonEl) reasonEl.value = 'use';
    const reasonTextEl = $('#out_reason_text'); if (reasonTextEl) reasonTextEl.value = '';
    const remarkEl = $('#out_remark'); if (remarkEl) remarkEl.value = '';
    clearPickState('out');
    outSearch();
    $('#out_code') && $('#out_code').focus();
  };

  /* 一次提交多台：每台各出库 1 件，共用领用人/时间/备注 */
  window.submitOutDo = async function () {
    /* v5.7.1：以勾选为唯一数据源，提交时不再按数量框反推勾选（BUG-017：曾把用户勾的件换成列表前 N 件） */
    const ids = prepareSubmitPicks('out');
    if (!ids.length) { toast('请先勾选要出库的夹具，或填写出库数量', 'err'); return; }
    /* v5.6.0 校验：领用人必须刷已登记且启用的卡 */
    const v = validateSwipe('out');
    if (!v.ok) { toast(v.msg, 'err'); return; }
    /* v5.6.0：经办位取消，只记一个人；operator / operatorCard 留空以兼容历史字段与旧流水 */
    const operator = '';
    const operatorCard = '';
    const counterparty = v.party.name;
    const partyCard = normCard(v.party.cardNo);
    const time = inputToMs(($('#out_time') || {}).value);
    const outReason = ($('#out_reason') || {}).value || 'use';
    const outReasonText = ($('#out_reason_text') || {}).value.trim();
    const remark = ($('#out_remark') || {}).value.trim();
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        await DB.fixtureAddTransaction({ fixtureId: id, type: 'out', operator, counterparty, operatorCard, partyCard, time, remark, outReason, outReasonText });
        ok++;
      } catch (e) { fail++; }
    }
    await reloadAll();
    // 只清理本次的选择结果，保留领用人/时间便于连续录入
    clearPickState('out');
    const remarkEl = $('#out_remark'); if (remarkEl) remarkEl.value = '';
    const reasonTextEl = $('#out_reason_text'); if (reasonTextEl) reasonTextEl.value = '';
    outSearch();
    if (ok) toast(`出库成功 ${ok} 套${fail ? `，失败 ${fail} 套` : ''}`, fail ? 'warn' : 'ok');
    else toast('出库失败，请检查夹具状态', 'err');
  };

  /* ============================================================
   * 回库页面逻辑（与出库保持一致：同样的数据源规则、数量默认值与校验）
   * ============================================================ */
  window.returnSearch = function () {
    const code = ($('#return_code') || {}).value.trim().toLowerCase();
    const name = ($('#return_name') || {}).value.trim().toLowerCase();
    const lm = ($('#return_spec') || {}).value.trim().toLowerCase();
    const location = ($('#return_location') || {}).value.trim().toLowerCase();
    const outStock = state.fixtures.filter((f) => f.status === 'checked_out');
    const filtered = outStock.filter((f) =>
      matchCodeField(f, code) &&
      (!name || (f.name || '').toLowerCase().includes(name)) &&
      (!lm || lineModelsMatch(f, lm)) &&
      (!location || (f.location || '').toLowerCase().includes(location))
    );
    state.returnAvailable = filtered.length;
    const availEl = $('#return_avail'); if (availEl) availEl.textContent = String(filtered.length);
    const locTip = $('#return_loc_tip');
    if (locTip) locTip.textContent = location ? `（库位含「${location}」的待回库 ${filtered.length} 套）` : '';
    const container = $('#return_candidates');
    if (!container) return;
    if (!code && !name && !lm && !location) {
      container.innerHTML = '<div class="empty-tip">在上方任一栏输入即可检索已出库夹具</div>';
      renderPickedSummary('return');
      syncPickAll('return');
      return;
    }
    renderPickGroups(container, filtered, 'return', '未找到匹配的已出库夹具', '台待回库');
    syncPickToQty('return');
  };

  window.returnToggleOne = function () { syncGroupHead('return'); syncPickToQty('return'); };

  window.returnToggleGroup = function (el) {
    const gi = el.dataset.gi;
    $$('.return-pick[data-gi="' + gi + '"]').forEach((c) => { c.checked = el.checked; });
    syncGroupHead('return');
    syncPickToQty('return');
  };

  /* 顶栏全选：一次勾上当前检索结果的全部待回库夹具 ⇒ 回车（或点「提交回库」）即一键回库 */
  window.returnToggleAll = function (el) { togglePickAll('return', el.checked); };

  window.returnQtyChange = function () {
    syncQtyToPick('return');
    syncPickToQty('return');
  };

  window.clearReturnSelection = function () {
    const codeEl = $('#return_code'); if (codeEl) codeEl.value = '';
    const nameEl = $('#return_name'); if (nameEl) nameEl.value = '';
    const specEl = $('#return_spec'); if (specEl) specEl.value = '';
    const locEl = $('#return_location'); if (locEl) locEl.value = '';
    const reasonEl = $('#return_reason'); if (reasonEl) reasonEl.value = 'use';
    const reasonTextEl = $('#return_reason_text'); if (reasonTextEl) reasonTextEl.value = '';
    const remarkEl = $('#return_remark'); if (remarkEl) remarkEl.value = '';
    clearPickState('return');
    returnSearch();
    $('#return_code') && $('#return_code').focus();
  };

  window.submitReturnDo = async function () {
    /* v5.7.1：同出库，以勾选为唯一数据源，提交时不再按数量框反推勾选（BUG-017） */
    const ids = prepareSubmitPicks('return');
    if (!ids.length) { toast('请先勾选要回库的夹具，或填写回库数量', 'err'); return; }
    /* v5.6.0 校验：退库人必须刷已登记且启用的卡 */
    const v = validateSwipe('ret');
    if (!v.ok) { toast(v.msg, 'err'); return; }
    /* v5.6.0：经办位取消，只记一个人；operator / operatorCard 留空以兼容历史字段与旧流水 */
    const operator = '';
    const operatorCard = '';
    const counterparty = v.party.name;
    const partyCard = normCard(v.party.cardNo);
    const time = inputToMs(($('#return_time') || {}).value);
    const returnReason = ($('#return_reason') || {}).value || 'use';
    const returnReasonText = ($('#return_reason_text') || {}).value.trim();
    const remark = ($('#return_remark') || {}).value.trim();
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        await DB.fixtureAddTransaction({ fixtureId: id, type: 'return', operator, counterparty, operatorCard, partyCard, time, remark, outReason: returnReason, outReasonText: returnReasonText });
        ok++;
      } catch (e) { fail++; }
    }
    await reloadAll();
    clearPickState('return');
    const remarkEl = $('#return_remark'); if (remarkEl) remarkEl.value = '';
    const reasonTextEl = $('#return_reason_text'); if (reasonTextEl) reasonTextEl.value = '';
    returnSearch();
    if (ok) toast(`回库成功 ${ok} 套${fail ? `，失败 ${fail} 套` : ''}`, fail ? 'warn' : 'ok');
    else toast('回库失败，请检查夹具状态', 'err');
  };

  /* ============================================================
   * 库位管理（10 列网格总览 + 点击筛选 + 手工盘点 CSV 导出）
   * 与备件仓库管理系统 v2.32 库位模块保持一致
   * ============================================================ */
  const LOC_UNASSIGNED = '（未分配）';

  /* 最近动态：取该夹具最后一条流水的时间与类型 */
  function lastMove(fixtureId) {
    const txs = state.fixTransactions.filter((t) => t.fixtureId === fixtureId);
    if (!txs.length) return '—';
    const t = txs[txs.length - 1];
    const label = (FIX_TX_TYPE[t.type] || { label: t.type }).label;
    return `${label} · ${fmtTime(t.time)}`;
  }

  /* 最近操作时间戳（用于排序）：最后一条流水时间，无流水则用 updatedAt/createdAt */
  function fixtureLastTime(f) {
    const txs = state.fixTransactions.filter((t) => t.fixtureId === f.id);
    if (txs.length) return txs[txs.length - 1].time || 0;
    return f.updatedAt || f.createdAt || 0;
  }

  /* 当前借用人：仅「已出库」时取最近一条 out 交易的领用人（外借单位） */
  function fixtureCurrentBorrower(f) {
    if (f.status !== 'checked_out') return '';
    const txs = state.fixTransactions.filter((t) => t.fixtureId === f.id && (t.type === 'out' || t.type === 'return'));
    for (let i = txs.length - 1; i >= 0; i--) {
      if (txs[i].type === 'out') return txs[i].counterparty || '';
    }
    return '';
  }

  /* 责任人/借用人展示：
   * - 已出库：借用人（领用部门/外借单位）即当前责任人
   * - 其他状态：最近一次经手人（v5.6.0 起经办位取消，回库流水只有退库人，故回落到 counterparty） */
  function fixtureResponsible(f) {
    if (f.status === 'checked_out') return fixtureCurrentBorrower(f) || '—';
    const txs = state.fixTransactions.filter((t) => t.fixtureId === f.id);
    const last = txs.length ? txs[txs.length - 1] : null;
    const op = last ? (last.operator || last.counterparty || '') : '';
    return op || '—';
  }

  /* 当前所在位置（车间 / 仓库 / 现场 / 外借单位）：
   * - 在库：库位
   * - 已出库：外借单位（领用人）
   * - 维修中：库位 + （维修中）
   * - 已报废：已报废 */
  function fixtureLocationLabel(f) {
    if (f.status === 'checked_out') return '外借 · ' + (fixtureCurrentBorrower(f) || '（未知）');
    if (f.status === 'repair') return (f.location || LOC_UNASSIGNED) + '（维修中）';
    if (f.status === 'retired') return '已报废';
    return f.location || LOC_UNASSIGNED;
  }

  function uniqueSorted(arr) {
    return [...new Set(arr.filter((x) => x != null && String(x).trim() !== ''))].sort((a, b) => natCompare(a, b));
  }

  function renderLocation() {
    const container = $('#content');
    if (!container) return;

    /* ⚠️ 卡片数字 = **在库套数**（必须过滤 status）。出库/维修中/已报废的不计入在库，
     *    其数量只放在 hover 提示里 —— 这正是「数量为派生值」的口径。
     *    历史写法 `locs[k]++` 未过滤 status，会把出库中的也算成在库，必须避免。 */
    const locs = {};       // 在库套数
    const locsAll = {};    // 台账套数（不限状态）
    state.fixtures.forEach((f) => {
      const k = f.location || LOC_UNASSIGNED;
      locsAll[k] = (locsAll[k] || 0) + 1;
      if (f.status === 'stocked') locs[k] = (locs[k] || 0) + 1;
    });
    const locKeys = locSort(Object.keys(locsAll));
    const filter = state.locFilter;

    let list = state.fixtures.slice();
    if (filter) list = list.filter((f) => (f.location || LOC_UNASSIGNED) === filter);
    list.sort((a, b) => natCompare(a.serialNo || '', b.serialNo || '') || natCompare(a.code, b.code));

    // 重渲染前保留纵向滚动位置，避免点选库位后跳回开头
    let prevScroll = 0;
    const prevGrid = $('.loc-grid10');
    if (prevGrid) prevScroll = prevGrid.scrollTop;

    const cards = locKeys.length ? locKeys.map((k) => {
      const cnt = locs[k] || 0;
      const totalCnt = locsAll[k] || 0;
      const away = totalCnt - cnt;
      const active = k === filter;
      const isUn = k === LOC_UNASSIGNED;
      const tip = `库位 ${k}：在库 ${cnt} 套${away ? '，不在库 ' + away + ' 套（出库/维修中/已报废）' : ''}`;
      return `<button type="button" class="loc-card ${active ? 'active' : ''} ${isUn ? 'unassigned' : ''}" data-loc="${esc(k)}" onclick="selectLocation(this.dataset.loc)" title="${esc(tip)}">
        <span class="loc-card-no">${esc(k)}</span>
        <span class="loc-card-num">${cnt}</span>
      </button>`;
    }).join('') : `<div class="empty" style="grid-column:1/-1;">暂无库位信息</div>`;

    const html = `
      <div class="loc-split">
        <div class="panel loc-top">
          <div class="panel-title">库位总览（10 列网格 · 三行可视 · 上下滑动浏览，点击查看明细）</div>
          <div class="loc-grid10">${cards}</div>
          <div class="loc-top-bar">
            ${filter
              ? `<button class="btn sm ghost" onclick="selectLocation('')">清除筛选</button><span class="ml">当前库位：<b>${esc(filter)}</b>（在库 ${list.filter((f) => f.status === 'stocked').length} / 共 ${list.length} 套）</span>`
              : '<span class="muted">未选择库位，下方显示全部夹具（卡片数字 = 在库套数）</span>'}
            <span class="spacer"></span>
            <button class="btn ghost sm" onclick="exportFixtureLocationCSV()">📋 手工盘点（导出 CSV）</button>
          </div>
          <div class="tip mt">点击库位卡片可在下方查看该库位对应的夹具明细；在「夹具管理」中编辑夹具可修改其库位。</div>
        </div>
        <div class="panel loc-bottom" style="margin-bottom:0">
          <div class="panel-title">${filter ? '库位「' + esc(filter) + '」下夹具' : '全部夹具'}（${list.length} 套）</div>
          <div class="table-wrap"><table>
            <thead><tr><th>序号</th><th>夹具编号</th><th>名称</th><th>机种名称</th><th>产线</th><th>分类</th><th>库位</th><th>状态</th><th>累计出库</th><th>最近动态</th></tr></thead>
            <tbody>
              ${list.length ? list.map((f) => {
                const st = FIX_STATUS[f.status] || { label: f.status, cls: 'muted' };
                return `<tr>
                  <td class="muted">${esc(f.code)}</td><td>${esc(f.serialNo || '—')}</td>
                  <td>${esc(f.name)}</td><td title="${esc(fullLineModels(f, '—'))}">${esc(formatLineModels(f, '—', { collapse: 2 }))}</td>
                  <td title="${esc(lineNamesLabel(f, '—'))}">${esc(lineNamesLabel(f, '—'))}</td>
                  <td>${esc(f.category || '—')}</td><td>${esc(f.location || '—')}</td>
                  <td><span class="badge ${st.cls}">${st.label}</span></td>
                  <td>${f.totalOutCount || 0}</td><td>${esc(lastMove(f.id))}</td></tr>`;
              }).join('') : `<tr><td colspan="10" class="empty">无夹具</td></tr>`}
            </tbody>
          </table></div>
        </div>
      </div>`;
    container.innerHTML = html;

    const grid = $('.loc-grid10');
    if (grid) grid.scrollTop = prevScroll;
  }

  window.selectLocation = function (loc) { state.locFilter = loc; renderLocation(); };

  /* 手工盘点：导出当前库位（或全部）夹具逐项明细 CSV；盘点人导出时录入 */
  window.exportFixtureLocationCSV = function () {
    const filter = state.locFilter;
    let list = state.fixtures.slice();
    if (filter) list = list.filter((f) => (f.location || LOC_UNASSIGNED) === filter);
    list.sort((a, b) => natCompare(a.serialNo || '', b.serialNo || '') || natCompare(a.code, b.code));

    openModal('手工盘点 — 导出 CSV', `
      <div class="form-group"><label>盘点范围</label>
        <input type="text" value="${filter ? esc(filter) + '（' + list.length + ' 套）' : '全部夹具（' + list.length + ' 套）'}" disabled></div>
      <div class="form-group"><label>盘点人</label>
        <input type="text" id="loc_audit_op" placeholder="请输入盘点人" value="${esc(state.lastAuditOperator || '')}"></div>
      <div class="form-actions">
        <button class="btn primary" onclick="submitFixtureLocationCSV()">确认导出</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `);
    setTimeout(() => { const el = $('#loc_audit_op'); el && el.focus(); }, 60);
  };

  window.submitFixtureLocationCSV = function () {
    const op = ($('#loc_audit_op') || {}).value.trim();
    if (!op) { toast('请输入盘点人', 'err'); return; }
    state.lastAuditOperator = op;
    closeModal();

    const filter = state.locFilter;
    let list = state.fixtures.slice();
    if (filter) list = list.filter((f) => (f.location || LOC_UNASSIGNED) === filter);
    list.sort((a, b) => natCompare(a.serialNo || '', b.serialNo || '') || natCompare(a.code, b.code));

    // 导出顺序：序号(code) 在前，方便盘点回对数；物理编号(serialNo)紧随其后
    const headers = ['序号', '夹具编号', '名称', '机种名称', '产线', '分类', '库位', '状态', '累计出库', '累计回库', '维修次数', '最近动态', '盘点人', '实盘数量'];
    const rows = list.map((f) => [
      f.code, f.serialNo || '', f.name, formatLineModels(f, ''), lineNamesLabel(f, ''), f.category || '', f.location || '',
      (FIX_STATUS[f.status] || { label: f.status }).label,
      f.totalOutCount || 0, f.totalReturnCount || 0, f.repairCount || 0, lastMove(f.id), op, ''
    ]);
    const csv = '\uFEFF' + [headers.join(','), ...rows.map((r) =>
      r.map((v) => (/[",\n\r]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v))).join(',')
    )].join('\r\n');
    download('夹具手工盘点_' + new Date().toISOString().slice(0, 10) + (filter ? '_' + filter : '') + '.csv', csv);
    toast('已导出 ' + list.length + ' 套', 'ok');
  };

  /* ============================================================
   * 流水记录（独立页面）
   * ============================================================ */
  function renderRecords() {
    const container = $('#content');
    if (!container) return;
    container.innerHTML = `
      <div class="panel">
        <div class="panel-title">🔍 流水记录查询</div>
        <div class="search-bar"><input type="text" id="rec_search" placeholder="搜索编号/名称/领用人/退库人..." oninput="searchRecords()"></div>
        <div id="rec_list"></div>
      </div>
    `;
    imeGuard($('#rec_search'), searchRecords);
    renderAllRecords(state.fixTransactions);
  }

  window.searchRecords = function () {
    let raw = ($('#rec_search') || {}).value.trim();
    // 兼容旧二维码前缀：SPMS1|2001 / SPMS|2001（现二维码内容已是纯序号，此处仅为旧码容错）
    const code = parseQRToken(raw);
    const q = (code || raw).toLowerCase();
    const filtered = q ? state.fixTransactions.filter((t) =>
      codeLike(t.fixtureCode, q)
      || (t.fixtureName || '').toLowerCase().includes(q)
      || (t.operator || '').toLowerCase().includes(q)
      /* v5.6.0：经办位取消后，流水里唯一的「人」是领用人 / 退库人（counterparty），必须能搜到 */
      || (t.counterparty || '').toLowerCase().includes(q)
    ) : state.fixTransactions;
    renderAllRecords(filtered);
  };

  function renderAllRecords(txs) {
    const container = $('#rec_list');
    if (!container) return;
    if (!txs.length) { container.innerHTML = '<div class="empty-tip">暂无流水记录</div>'; return; }
    const html = `
      <div class="tx-list">
        <div class="tx-row tx-header">
          <div>类型</div><div>夹具</div><div>状态</div><div>经办人</div><div>领用人</div><div>时间</div><div>备注</div><div>出库原因</div>
        </div>
        ${txs.map((t) => {
          const tc = FIX_TX_TYPE[t.type] || { label: t.type, icon: '📋' };
          const fs = FIX_STATUS[t.fromStatus] || { label: t.fromStatus };
          const ts = FIX_STATUS[t.toStatus] || { label: t.toStatus };
          const reasonLabel = t.outReason ? (() => {
            if (t.outReason === 'other' && t.outReasonText) return '其它（' + esc(t.outReasonText) + '）';
            return OUT_REASON_LABEL[t.outReason] || t.outReason;
          })() : '';
          return `
            <div class="tx-row">
              <div class="tx-type">${tc.icon} ${tc.label}</div>
              <div class="tx-fixture">${esc(t.fixtureCode)} ${esc(t.fixtureName)}${t.fixtureSerialNo ? `<span class="tx-serial">${esc(t.fixtureSerialNo)}</span>` : ''}</div>
              <div class="tx-status">${fs.label} → ${ts.label}</div>
              <div class="tx-operator">${esc(t.operator || '-')}</div>
              <div class="tx-party">${esc(t.counterparty || '-')}</div>
              <div class="tx-time">${fmtTime(t.time)}</div>
              <div class="tx-remark">${esc(t.remark || '-')}</div>
              <div class="tx-reason">${reasonLabel || '-'}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
    container.innerHTML = html;
  }

  /* ============================================================
   * 夹具查询（多条件组合检索）
   *
   * ⚠️ v5.0.0：原「① 按夹具编号查询（数量与合计）」整块面板已移除
   *   （含 serialQuery 状态、renderSerialAgg、serialQueryInput/Clear），
   *   页面只保留下方「🔎 夹具查询」多条件组合检索。
   * ============================================================ */
  function renderQuery() {
    const container = $('#content');
    if (!container) return;
    const q = state.query;
    const locations = uniqueSorted(state.fixtures.map((f) => f.location).filter(Boolean));
    const categories = categoryCandidates();
    const lineModels = uniqueSorted(state.fixtures.flatMap((f) => (Array.isArray(f.lineModels) ? f.lineModels : [])));
    const borrowers = uniqueSorted(state.fixTransactions
      .filter((t) => t.type === 'out' && t.counterparty)
      .map((t) => t.counterparty));

    const opt = (val, sel) => `<option value="${esc(val)}"${sel === val ? ' selected' : ''}>${esc(val)}</option>`;
    const locOpts = ['<option value="">全部</option>'].concat(locations.map((v) => opt(v, q.location))).join('');
    const lmOpts = ['<option value="">全部</option>'].concat(lineModels.map((v) => opt(v, q.lineModel))).join('');
    const brOpts = ['<option value="">全部</option>'].concat(borrowers.map((v) => opt(v, q.borrower))).join('');
    const catOpts = ['<option value="">全部</option>'].concat(categories.map((v) => opt(v, q.category))).join('');

    const chip = (st) => {
      const active = q.statuses.includes(st);
      const label = (FIX_STATUS[st] || { label: st }).label;
      return `<button type="button" class="chip ${active ? 'active' : ''}" data-status="${st}" onclick="queryToggleStatus('${st}')">${label}</button>`;
    };
    const sortOpt = (f) => opt(f, q.sortBy);
    const outReasonOpts = ['<option value="">全部</option>',
      '<option value="use"' + (q.outReason === 'use' ? ' selected' : '') + '>使用</option>',
      '<option value="repair"' + (q.outReason === 'repair' ? ' selected' : '') + '>维修</option>',
      '<option value="other"' + (q.outReason === 'other' ? ' selected' : '') + '>其它</option>'].join('');

    container.innerHTML = `
      <div class="panel">
        <div class="panel-title">🔎 夹具查询
          <span class="panel-actions"><span id="query_count" class="muted"></span></span>
        </div>
        <div class="query-bar">
          <div class="query-field"><label>关键字</label><input type="text" id="q_keyword" placeholder="夹具编号/名称/机种/库位/产线/责任人…" value="${esc(q.keyword)}" oninput="queryApply()"></div>
          <div class="query-field"><label>序号</label><input type="text" id="q_code" placeholder="如 1001（需完整）" value="${esc(q.code)}" oninput="queryApply()"></div>
          <div class="query-field"><label>名称/机种</label><input type="text" id="q_name" placeholder="名称或机种" value="${esc(q.name)}" oninput="queryApply()"></div>
          <div class="query-field"><label>存放位置</label><select id="q_location" class="query-select" onchange="queryApply()">${locOpts}</select></div>
          <div class="query-field"><label>关联机种</label><select id="q_lm" class="query-select" onchange="queryApply()">${lmOpts}</select></div>
          <div class="query-field"><label>借用人</label><select id="q_borrower" class="query-select" onchange="queryApply()">${brOpts}</select></div>
          <div class="query-field"><label>出库原因</label><select id="q_out_reason" class="query-select" onchange="queryApply()">${outReasonOpts}</select></div>
          <div class="query-field"><label>分类</label><select id="q_category" class="query-select" onchange="queryApply()">${catOpts}</select></div>
        </div>
        <div class="query-bar">
          <div class="query-field"><label>使用状态</label>
            <span class="chip-row">
              ${chip('stocked')}${chip('checked_out')}${chip('repair')}${chip('retired')}
              ${q.statuses.length ? '<button type="button" class="chip-clear" onclick="queryClearStatus()">清除状态</button>' : ''}
            </span>
          </div>
          <div class="query-field"><label>排序</label>
            <div class="query-control-row">
              <select id="q_sort" class="query-select" onchange="querySortSel()">
                ${sortOpt('serial')}${sortOpt('code')}${sortOpt('name')}${sortOpt('status')}${sortOpt('repair')}${sortOpt('time')}
              </select>
              <button type="button" class="btn sm ghost" onclick="querySortDir()" id="q_sortdir" title="切换升/降序">${q.sortDir === 'asc' ? '↑' : '↓'}</button>
            </div>
          </div>
          <div class="query-field"><label>&nbsp;</label>
            <button type="button" class="btn sm ghost" onclick="queryReset()">重置筛选</button>
          </div>
        </div>
        <div class="tip">支持多条件组合；状态可多选；序号为系统自动分配的 4 位数字，<b>需完整输入</b>才命中（不参与模糊搜索）。点击表头可排序。</div>
        <div id="query_results"></div>
      </div>
    `;
    imeGuard($('#q_keyword'), queryApply);
    const sd = $('#q_sortdir'); if (sd) sd.textContent = q.sortDir === 'asc' ? '↑' : '↓';
    queryApply();
  }

  /* 某夹具是否存在指定出库原因的流水（outReason === repair 时含「送修」流水，与 repairCount 同口径） */
  function fixtureHasOutReason(f, reason) {
    const list = (state.fixTransactions || []).filter((t) => t.fixtureId === f.id);
    if (reason === 'repair') {
      return list.some((t) => (t.type === 'out' && t.outReason === 'repair') || t.type === 'repair');
    }
    if (reason === 'use') {
      return list.some((t) => t.type === 'out' && (!t.outReason || t.outReason === 'use'));
    }
    if (reason === 'other') {
      return list.some((t) => t.type === 'out' && t.outReason === 'other');
    }
    return true;
  }

  /* 应用筛选条件，返回结果数组（不触及 DOM） */
  function applyQueryFilters(q) {
    const kw = (q.keyword || '').trim();
    const code = (q.code || '').trim();
    const name = (q.name || '').trim().toLowerCase();
    const location = q.location || '';
    const lineModel = (q.lineModel || '').trim().toLowerCase();
    const borrower = q.borrower || '';
    const statuses = q.statuses || [];
    const outReason = q.outReason || '';
    const category = q.category || '';
    const list = state.fixtures.filter((f) => {
      if (kw && !matchFixture(f, kw)) return false;
      // 桥梁编号不参与模糊搜索：必须归一化后完全相等
      if (code && !(DB.codeEq ? DB.codeEq(f.code, code) : String(f.code) === code)) return false;
      if (name) {
        if (!((f.name || '').toLowerCase().includes(name) || lineModelsMatch(f, name))) return false;
      }
      if (location && (f.location || '') !== location) return false;
      if (statuses.length && !statuses.includes(f.status)) return false;
      if (borrower) {
        if (f.status !== 'checked_out') return false;
        if (fixtureCurrentBorrower(f).indexOf(borrower) < 0) return false;
      }
      if (lineModel && !lineModelsMatch(f, lineModel)) return false;
      if (outReason && !fixtureHasOutReason(f, outReason)) return false;
      if (category && (f.category || '') !== category) return false;
      return true;
    });
    const dir = q.sortDir === 'desc' ? -1 : 1;
    const sb = q.sortBy;
    list.sort((a, b) => {
      let cmp = 0;
      if (sb === 'serial') cmp = natCompare(a.serialNo || '', b.serialNo || '');
      else if (sb === 'code') cmp = natCompare(a.code, b.code);
      else if (sb === 'name') cmp = natCompare(a.name, b.name);
      else if (sb === 'status') cmp = natCompare(a.status, b.status);
      else if (sb === 'repair') cmp = (a.repairCount || 0) - (b.repairCount || 0);
      else if (sb === 'time') cmp = fixtureLastTime(a) - fixtureLastTime(b);
      return cmp * dir;
    });
    return list;
  }

  function renderQueryResults(list) {
    const box = $('#query_results');
    if (!box) return;
    const cnt = $('#query_count');
    if (cnt) cnt.textContent = '命中 ' + list.length + ' / ' + state.fixtures.length + ' 套';
    if (!list.length) {
      box.innerHTML = '<div class="empty-tip">未找到匹配的夹具，请调整查询条件</div>';
      return;
    }
    const q = state.query;
    const sortInd = (f) => q.sortBy === f ? (q.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    const thSort = (f, label) => `<th class="th-sort" onclick="querySortCol('${f}')">${label}${sortInd(f)}</th>`;
    box.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>
          <th style="width:64px">序号</th>${thSort('serial', '夹具编号')}${thSort('name', '名称')}<th>关联机种</th>
          <th>产线</th><th>分类</th><th>库位</th><th>责任人/借用人</th>
          ${thSort('status', '状态')}${thSort('repair', '维修次数')}${thSort('time', '最近操作时间')}<th style="width:130px">操作</th>
        </tr></thead>
        <tbody>
          ${list.map((f) => {
            const st = FIX_STATUS[f.status] || { label: f.status, cls: 'muted' };
            const canLocate = !!f.location && f.status !== 'retired';
            return `<tr>
              <td class="muted">${esc(f.code)}</td>
              <td>${esc(f.serialNo || '—')}</td>
              <td>${esc(f.name)}</td>
              <td title="${esc(fullLineModels(f, '—'))}">${esc(formatLineModels(f, '—', { collapse: 2 }))}</td>
              <td title="${esc(lineNamesLabel(f, '—'))}">${esc(lineNamesLabel(f, '—'))}</td>
              <td>${esc(f.category || '—')}</td>
              <td>${esc(f.location || '—')}</td>
              <td>${esc(fixtureResponsible(f))}</td>
              <td><span class="badge ${st.cls}">${st.label}</span></td>
              <td class="num">${f.repairCount || 0}</td>
              <td>${esc(lastMove(f.id))}</td>
              <td><span class="row-actions">
                <button class="btn sm ghost" onclick="fixtureEdit(${f.id})">编辑</button>
                <button class="btn sm" onclick="openQueryDetail(${f.id})">详情</button>
                ${canLocate ? `<button class="btn sm ghost" onclick="queryGotoLocationById(${f.id})">定位</button>` : ''}
                <button class="btn sm danger" title="仅用于录错 / 重复建档；报废请用「报废」" onclick="fixtureDelete(${f.id})">删除</button>
              </span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`;
  }

  window.queryApply = function () {
    const q = state.query;
    q.keyword = ($('#q_keyword') || {}).value || '';
    q.code = ($('#q_code') || {}).value || '';
    q.name = ($('#q_name') || {}).value || '';
    q.location = ($('#q_location') || {}).value || '';
    q.lineModel = ($('#q_lm') || {}).value || '';
    q.borrower = ($('#q_borrower') || {}).value || '';
    q.outReason = ($('#q_out_reason') || {}).value || '';
    q.category = ($('#q_category') || {}).value || '';
    renderQueryResults(applyQueryFilters(q));
  };

  window.queryToggleStatus = function (st) {
    const q = state.query;
    const i = q.statuses.indexOf(st);
    if (i >= 0) q.statuses.splice(i, 1); else q.statuses.push(st);
    const chipEl = $('.chip[data-status="' + st + '"]');
    if (chipEl) chipEl.classList.toggle('active', q.statuses.includes(st));
    queryApply();
  };

  window.queryClearStatus = function () {
    state.query.statuses = [];
    $$('.chip[data-status]').forEach((c) => c.classList.remove('active'));
    queryApply();
  };

  window.querySortSel = function () {
    state.query.sortBy = ($('#q_sort') || {}).value || 'code';
    queryApply();
  };

  window.querySortDir = function () {
    state.query.sortDir = state.query.sortDir === 'asc' ? 'desc' : 'asc';
    const sd = $('#q_sortdir'); if (sd) sd.textContent = state.query.sortDir === 'asc' ? '↑' : '↓';
    queryApply();
  };

  window.querySortCol = function (field) {
    const q = state.query;
    if (q.sortBy === field) q.sortDir = q.sortDir === 'asc' ? 'desc' : 'asc';
    else { q.sortBy = field; q.sortDir = 'asc'; }
    const sel = $('#q_sort'); if (sel) sel.value = field;
    const sd = $('#q_sortdir'); if (sd) sd.textContent = q.sortDir === 'asc' ? '↑' : '↓';
    queryApply();
  };

  window.queryReset = function () {
    state.query = { keyword: '', code: '', name: '', location: '', lineModel: '', borrower: '', category: '', statuses: [], sortBy: 'code', sortDir: 'asc', outReason: '' };
    renderQuery();
  };

  window.openQueryDetail = function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) return;
    const st = FIX_STATUS[f.status] || { label: f.status, cls: '' };
    const loc = fixtureLocationLabel(f);
    const holder = fixtureResponsible(f);
    const canLocate = !!f.location && f.status !== 'retired';
    const html = `
      <div class="form-group"><label>夹具编号</label><input type="text" value="${esc(f.serialNo || '—')}" disabled></div>
      <div class="form-group"><label>序号（系统分配 · 不可改）</label><input type="text" value="${esc(f.code)}" disabled></div>
      <div class="form-group"><label>名称</label><input type="text" value="${esc(f.name)}" disabled></div>
      <div class="form-group"><label>机种名称</label><input type="text" value="${esc(fullLineModels(f, '—'))}" disabled></div>
      <div class="form-group"><label>产线</label><input type="text" value="${esc(lineNamesLabel(f, '—'))}" disabled></div>
      <div class="form-group"><label>分类</label><input type="text" value="${esc(f.category || '—')}" disabled></div>
      <div class="form-group"><label>存放位置（库位）</label><input type="text" value="${esc(f.location || '（未分配）')}" disabled></div>
      <div class="form-group"><label>当前所在位置</label><input type="text" value="${esc(loc)}" disabled></div>
      <div class="form-group"><label>责任人/借用人</label><input type="text" value="${esc(holder)}" disabled></div>
      <div class="form-group"><label>状态</label><input type="text" value="${esc(st.label)}" disabled></div>
      <div class="form-group"><label>累计出库 / 回库 / 维修</label><input type="text" value="${esc((f.totalOutCount || 0) + ' / ' + (f.totalReturnCount || 0) + ' / ' + (f.repairCount || 0))}" disabled></div>
      ${f.serialNo ? `<div class="tip">同编号持有量：${esc(serialNoSummary(f.serialNo) || '—')}</div>` : ''}
      ${f.remark ? `<div class="form-group"><label>备注</label><input type="text" value="${esc(f.remark)}" disabled></div>` : ''}
      <div class="form-actions">
        <button class="btn primary" onclick="closeModal(); fixtureEdit(${f.id})">✎ 编辑夹具</button>
        ${canLocate ? `<button class="btn" onclick="queryGotoLocationById(${f.id})">🗺 在库位管理中定位</button>` : ''}
        <button class="btn danger" onclick="fixtureDelete(${f.id})">🗑 删除该夹具</button>
      </div>
      <div class="panel-title mt">最近动态</div>
      <div id="q_detail_tx"></div>
    `;
    openModal('夹具详情 · ' + (f.serialNo || f.code) + ' ' + f.name, html);
    renderFixTransactions($('#q_detail_tx'), state.fixTransactions, id);
  };

  window.queryGotoLocationById = function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    closeModal();
    if (f && f.location) state.locFilter = f.location;
    showView('location');
  };

  /* ============================================================
   * 机种管理（productions）
   *
   * 机种是 fixtures.lineModels 的**受控字典**：{ id, name, order }。
   * ⚠️ 机种**不隶属任何产线**（旧 products 的 lineId 已删除）——
   *    「哪些产线在用到这个机种的夹具」由夹具记录反查得出，见「机种管理」页点机种名称展开的明细。
   * 删除保护：仍被夹具引用时禁止删除；重命名自动写穿全部夹具记录。
   * ============================================================ */
  function productionNames() {
    return uniqueSorted((state.productions || []).map((p) => p.name));
  }
  /* 夹具正在使用、但字典里还没登记的机种名称（孤儿） */
  function orphanLineModels() {
    const known = new Set(productionNames());
    const used = new Set();
    (state.fixtures || []).forEach((f) => (Array.isArray(f.lineModels) ? f.lineModels : []).forEach((n) => {
      const s = String(n == null ? '' : n).trim();
      if (s && !known.has(s)) used.add(s);
    }));
    return Array.from(used).sort(natCompare);
  }

  async function renderProduction() {
    const container = $('#content');
    if (!container) return;
    container.innerHTML = `<div class="panel"><div class="panel-title">🏷 机种管理</div>
      <div class="loading-tip"><span class="spinner"></span>正在加载机种字典…</div></div>`;
    try { await reloadAll(); await reloadLineConfig(); } catch (e) {
      container.innerHTML = `<div class="panel"><div class="panel-title" style="color:var(--danger)">加载失败</div><p>${esc(e && e.message ? e.message : String(e))}</p></div>`;
      return;
    }
    if (state.view !== 'prod') return;
    paintProduction();
  }

  /* 纯渲染（不读盘）：点机种展开/收起时调用，避免转圈与滚动条跳动。
   * v4.5.0：「按机种查询」页合并到这里 —— 点机种名称 → 下方展开该机种的
   * 「线体 → 夹具」明细（v5.0.0 起工位模型移除，明细只到线体）。 */
  function paintProduction() {
    const container = $('#content');
    if (!container) return;
    const list = (state.productions || []).slice().sort((a, b) =>
      (Number(a.order) || 0) - (Number(b.order) || 0) || natCompare(a.name || '', b.name || ''));
    const orphans = orphanLineModels();

    // 机种被删除/改名后，展开态自动失效
    const pickedId = Number(state.prodPick) || 0;
    const pickedProd = list.find((p) => p.id === pickedId) || null;
    state.prodPick = pickedProd ? pickedProd.id : 0;

    container.innerHTML = `
      <div class="panel">
        <div class="panel-title">🏷 机种管理（${list.length} 个）
          <span class="panel-actions">
            <button class="btn sm" onclick="prodForm(0)">➕ 新建机种</button>
          </span>
        </div>
        <div class="tip">机种是夹具「适用机种」标签的受控字典，<b>不隶属任何产线</b>。点<b>机种名称</b>即可在下方展开：这个机种有哪些夹具、分别装在哪条线体上。</div>
        <div class="tip"><b>线体</b>列是<b>派生值</b>：把使用该机种的全部夹具的关联产线汇总去重，多条线体用 <code>/</code> 分隔，<b>不单独存储</b>；一条线体都没有时显示「—」。</div>
        ${orphans.length ? `<div class="tip hint-warn">发现 ${orphans.length} 个夹具正在使用、但字典里没有的机种：<b>${esc(orphans.join('、'))}</b>
          <button class="btn sm" style="margin-left:8px" onclick="prodAdoptOrphans()">一键补登</button></div>` : ''}
        ${list.length ? `<div class="table-wrap"><table>
          <thead><tr><th>机种名称</th><th style="width:210px">线体</th><th style="width:110px">关联夹具</th><th style="width:100px">在库套数</th>
            <th style="width:90px">排序号</th><th style="width:150px">操作</th></tr></thead>
          <tbody>
            ${list.map((p) => {
              const refs = productionRefCount(p.name);
              const stocked = (state.fixtures || []).filter((f) => f.status === 'stocked' && (Array.isArray(f.lineModels) ? f.lineModels : []).includes(p.name)).length;
              const on = pickedProd && pickedProd.id === p.id;
              return `<tr class="${on ? 'pick-row' : ''}">
                <td><a href="javascript:;" class="prod-pick" title="点击查看该机种的夹具 / 线体分布"
                  onclick="prodPick(${p.id})">${esc(p.name)}</a>${on ? '<span class="pick-mark">▼ 已展开</span>' : ''}</td>
                <td>${slashCell(lineNamesOfModel(p.name))}</td>
                <td>${refs} 套</td>
                <td>${stocked} 套</td>
                <td>${esc(p.order == null ? '—' : String(p.order))}</td>
                <td><span class="row-actions">
                  <button class="btn sm" onclick="prodForm(${p.id})">重命名 / 排序</button>
                  <button class="btn sm danger" onclick="prodDel(${p.id})">删除</button>
                </span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>` : '<div class="empty-tip">机种字典为空，点「➕ 新建机种」开始（也可在新建夹具时现场新增）</div>'}
      </div>
      ${pickedProd ? prodDetailHtml(pickedProd.name) : ''}`;
  }

  /* 机种明细：按「线体」分组列出该机种的全部夹具（含未关联产线的兜底行） */
  function prodDetailHtml(name) {
    const rows = buildProdDetailRows(state.fixtures, state.lines, [name]);
    const fxIds = new Set(rows.map((r) => r.fixtureId));
    const stockedIds = new Set(rows.filter((r) => r.status === 'stocked').map((r) => r.fixtureId));
    const lineIds = new Set(rows.filter((r) => r.lineId).map((r) => r.lineId));

    const head = `<div class="panel-title">📋 机种：<span style="color:var(--primary-dark)">${esc(name)}</span>
      <span class="panel-actions">
        <span class="muted">夹具 ${fxIds.size} 套 ｜ 在库 ${stockedIds.size} 套 ｜ 线体 ${lineIds.size} 条</span>
        <button class="btn sm ghost" onclick="prodPick(0)">收起</button>
      </span></div>`;

    if (!rows.length) {
      return `<div class="panel" id="prod_detail">${head}
        <div class="empty-tip">该机种下还没有夹具记录。到「夹具管理」新建或编辑夹具，把「适用机种」选上它即可。</div></div>`;
    }

    // 按线体分组（rows 已按 机种 → 线体 排好序）
    const groups = new Map();
    rows.forEach((r) => {
      const key = r.lineId ? String(r.lineId) : '0';
      if (!groups.has(key)) groups.set(key, { name: r.lineName, rows: [] });
      groups.get(key).rows.push(r);
    });

    const sections = Array.from(groups.values()).map((g) => {
      const gFx = new Set(g.rows.map((r) => r.fixtureId)).size;
      return `<div class="pq-group">
        <div class="pq-head"><b>${esc(g.name)}</b>
          <span class="muted">夹具 ${gFx} 套</span></div>
        <div class="table-wrap"><table>
          <thead><tr>
            <th style="width:190px">夹具编号</th>
            <th>名称</th>
            <th style="width:170px">库位</th>
            <th style="width:100px">状态</th>
            <th style="width:90px">操作</th>
          </tr></thead>
          <tbody>
            ${g.rows.map((r) => {
              const st = FIX_STATUS[r.status] || { label: r.status, cls: 'muted' };
              return `<tr>
                <td><a href="javascript:;" onclick="fixtureEdit(${r.fixtureId})" title="编辑该夹具">${esc(r.serialNo || '—')}</a>
                  <span class="muted">${esc(r.code)}</span></td>
                <td>${esc(r.name || '—')}</td>
                <td>${esc(r.location || '—')}</td>
                <td><span class="badge ${st.cls}">${st.label}</span></td>
                <td><button class="btn sm ghost" onclick="fixtureEdit(${r.fixtureId})">编辑</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>
      </div>`;
    }).join('');

    return `<div class="panel" id="prod_detail">${head}${sections}</div>`;
  }

  /* 点机种名称：展开 / 再点收起（0 = 收起） */
  window.prodPick = function (id) {
    const nid = Number(id) || 0;
    state.prodPick = state.prodPick === nid ? 0 : nid;
    paintProduction();
  };


  window.prodForm = function (id) {
    const p = (state.productions || []).find((x) => x.id === id) || null;
    const refs = p ? productionRefCount(p.name) : 0;
    openModal(p ? '重命名 / 排序机种' : '新建机种', `
      <div class="form-group"><label>机种名称 <span class="req">*</span></label>
        <input type="text" id="prod_name" maxlength="${MAX_PROD_NAME}" placeholder="如 DH40MC" value="${esc(p ? p.name : '')}"></div>
      <div class="form-group"><label>排序号</label>
        <input type="number" id="prod_order" placeholder="数字，越小越靠前（可空）" value="${p && p.order != null ? esc(String(p.order)) : ''}"></div>
      ${refs ? `<p class="muted" style="margin:4px 0 0;">重命名会同步写穿到正在使用该名称的 <b>${refs}</b> 套夹具记录，不会丢关联。</p>` : ''}
      <div class="form-actions">
        <button class="btn primary" onclick="prodSave(${id})">保存</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>`);
  };

  window.prodSave = async function (id) {
    const name = ($('#prod_name') || {}).value.trim();
    const orderRaw = ($('#prod_order') || {}).value.trim();
    if (!name) { toast('请填写机种名称', 'err'); return; }
    if (!isValidProductionName(name)) { toast('机种名称需为 1~' + MAX_PROD_NAME + ' 字符，且不含竖线', 'err'); return; }
    if ((state.productions || []).some((x) => x.name === name && x.id !== id)) { toast('已存在同名机种', 'err'); return; }
    const order = orderRaw === '' ? null : Number(orderRaw);
    if (orderRaw !== '' && !Number.isFinite(order)) { toast('排序号需为数字', 'err'); return; }
    try {
      if (id) {
        const p = state.productions.find((x) => x.id === id);
        // 名称变了先写穿（store 侧会同步重命名全部 fixtures.lineModels）
        if (p && p.name !== name) await DB.productionRename({ id, name });
        const cur = state.productions.find((x) => x.id === id) || { id };
        await DB.put('productions', { ...cur, name, order, updatedAt: Date.now() });
      } else {
        await DB.add('productions', { name, order, createdAt: Date.now() });
      }
      closeModal();
      await renderProduction();
      toast(id ? '机种已更新' : '机种已创建', 'ok');
    } catch (e) { toast('保存失败：' + (e && e.message ? e.message : e), 'err'); }
  };

  window.prodDel = function (id) {
    const p = (state.productions || []).find((x) => x.id === id);
    if (!p) return;
    const refs = productionRefCount(p.name);
    if (refs) {
      openModal('无法删除机种', `
        <p>机种「<b>${esc(p.name)}</b>」仍被 <b>${refs}</b> 套夹具引用，不能删除。</p>
        <p class="muted">请先到「夹具管理」把这些夹具的机种改掉，或使用「重命名」保留该机种。</p>
        <div class="form-actions">
          <button class="btn primary" onclick="closeModal(); showView('fixtures')">去夹具管理</button>
          <button class="btn ghost" onclick="closeModal()">关闭</button>
        </div>`);
      return;
    }
    openModal('删除机种', `
      <p>确定删除机种「<b>${esc(p.name)}</b>」吗？当前没有夹具引用它，此操作不可撤销。</p>
      <div class="form-actions">
        <button class="btn danger" onclick="prodDelConfirm(${id})">确认删除</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>`);
  };
  window.prodDelConfirm = async function (id) {
    try {
      await DB.productionDel(id);
      closeModal();
      await renderProduction();
      toast('机种已删除', 'ok');
    } catch (e) { toast('删除失败：' + (e && e.message ? e.message : e), 'err'); }
  };

  /* 把夹具在用但未登记的机种名称补进字典 */
  window.prodAdoptOrphans = async function () {
    const orphans = orphanLineModels();
    if (!orphans.length) { toast('没有待补登的机种', 'warn'); return; }
    let ok = 0, fail = 0;
    for (const n of orphans) {
      try { await DB.add('productions', { name: n, order: null, createdAt: Date.now(), remark: '自夹具自动补登' }); ok++; }
      catch (e) { fail++; }
    }
    await renderProduction();
    toast(fail ? `补登完成：成功 ${ok} 个，失败 ${fail} 个` : `已补登 ${ok} 个机种`, fail ? 'warn' : 'ok');
  };

  /* ============================================================
   * 机种 → 产线 反查（纯函数层）
   *
   * v4.5.0：「按机种查询」页已合并进「机种管理」，界面入口不再单独存在，
   * 但两个纯函数保留并被机种管理页复用 / 供回归测试：
   *   - buildProdQueryRows：机种 × 产线 的轻量投影
   *   - buildProdDetailRows：机种 × 线体 的明细（明细面板用这个；v5.0.0 去工位）
   * 提醒：机种与产线之间**没有**直接绑定关系，全部由夹具记录反查。
   * ============================================================ */
  /* 纯函数：把夹具表摊平成 { 机种 × 产线 } 的行（不触 DOM，便于测试） */
  function buildProdQueryRows(fixtures, lines, names) {
    const set = new Set(names || []);
    const lineById = new Map((lines || []).map((l) => [l.id, l]));
    const out = [];
    (fixtures || []).forEach((f) => {
      const lms = (Array.isArray(f.lineModels) ? f.lineModels : []).filter((n) => set.has(n));
      if (!lms.length) return;
      const ls = (Array.isArray(f.lines) ? f.lines : [])
        .map((id) => lineById.get(Number(id)) || null).filter(Boolean);
      const lineList = ls.length ? ls : [null];
      lms.forEach((pn) => {
        lineList.forEach((l) => {
          out.push({
            production: pn,
            lineName: l ? l.name : '（未关联产线）',
            serialNo: f.serialNo || '',
            code: String(f.code),
            location: f.location || '',
            status: f.status || '',
            fixtureId: f.id
          });
        });
      });
    });
    out.sort((a, b) =>
      natCompare(a.production, b.production) || natCompare(a.lineName, b.lineName) ||
      natCompare(a.serialNo, b.serialNo) || natCompare(a.code, b.code));
    return out;
  }

  /* 纯函数（v5.0.0）：机种 → 夹具 → 线体 明细
   * 工位模型已移除，夹具只关联到产线（f.lines）；
   * 夹具完全没有关联产线时出一行「（未关联产线）」，保证「有夹具就一定看得见」。
   * 不触 DOM，便于测试。 */
  function buildProdDetailRows(fixtures, lines, names) {
    const set = new Set(names || []);
    const lineById = new Map((lines || []).map((l) => [Number(l.id), l]));
    const out = [];
    (fixtures || []).forEach((f) => {
      const lms = (Array.isArray(f.lineModels) ? f.lineModels : []).filter((n) => set.has(n));
      if (!lms.length) return;
      const lineIds = [];
      (Array.isArray(f.lines) ? f.lines : []).forEach((id) => {
        const n = Number(id);
        if (!Number.isFinite(n) || lineIds.indexOf(n) >= 0) return;
        lineIds.push(n);
      });
      lineIds.sort((a, b) => a - b);

      const base = {
        fixtureId: f.id, code: String(f.code), serialNo: f.serialNo || '',
        name: f.name || '', location: f.location || '', status: f.status || ''
      };
      const pushRow = (pn, lid, lineName) => {
        out.push(Object.assign({ production: pn, lineId: lid, lineName }, base));
      };

      lms.forEach((pn) => {
        if (!lineIds.length) { pushRow(pn, 0, '（未关联产线）'); return; }
        lineIds.forEach((lid) => {
          const line = lineById.get(lid);
          pushRow(pn, lid, line ? line.name : '（产线已删除 #' + lid + '）');
        });
      });
    });
    out.sort((a, b) =>
      natCompare(a.production, b.production) || natCompare(a.lineName, b.lineName) ||
      natCompare(a.serialNo, b.serialNo) || natCompare(a.code, b.code));
    return out;
  }

  /* v4.5.0：「按机种查询」独立页已**合并进「机种管理」**——
   * 点机种名称即在表格下方展开该机种的「线体 / 夹具」明细。
   * 保留本函数名，旧入口（历史按钮或 showView('prodquery')）平滑落到机种管理。 */
  async function renderProdQuery() {
    showView('prod');
  }


  /* ============================================================
   * 人员卡库（v5.1.0）
   *
   * 用途：进出库「刷卡」时按卡号反查姓名与角色，取代手打姓名。
   * 业务规则：一张卡只能登记一个人（卡号归一化后唯一）；停用比删除更安全。
   * 卡号来源：USB 读卡器（键盘模拟，末尾自动回车）或手工输入。
   * ============================================================ */
  const STAFF_ROLE_LABEL = { borrower: '领用人', operator: '经办人（历史）', both: '两者皆可' };
  /* v5.6.0：经办位整块取消，刷卡位不再按角色设限 —— 已登记且启用的卡都能刷领用/退库位。
   * 角色字段保留只为兼容历史数据与台账标注，不再参与刷卡校验。 */
  const STAFF_ROLE_HINT = {
    borrower: '可刷「领用人 / 退库人」位',
    operator: '历史角色，刷卡时按「领用人 / 退库人」对待',
    both: '所有刷卡位通用'
  };
  const STAFF_IMPORT_HEADERS = ['卡号', '姓名', '部门', '角色', '状态', '备注'];
  const STAFF_IMPORT_ALIAS = {
    '卡号': 'cardNo', '卡编号': 'cardNo', '工卡号': 'cardNo', '工号': 'cardNo', '员工号': 'cardNo',
    'ic卡号': 'cardNo', '卡片号': 'cardNo', '卡号id': 'cardNo', 'cardno': 'cardNo', 'card': 'cardNo', '编号': 'cardNo',
    '姓名': 'name', '名字': 'name', '人员': 'name', '人员姓名': 'name', '员工姓名': 'name', 'name': 'name',
    '部门': 'dept', '部门名称': 'dept', '所属部门': 'dept', '车间': 'dept', '班组': 'dept', 'dept': 'dept',
    '角色': 'role', '角色权限': 'role', '权限': 'role', '类型': 'role', 'role': 'role',
    '状态': 'active', '是否启用': 'active', '启用': 'active', 'status': 'active', 'active': 'active',
    '备注': 'remark', '说明': 'remark', 'remark': 'remark'
  };

  /* 卡号归一化（与 DB.normalizeCardNo 同源；DB 在浏览器/主进程两种后端都提供该纯函数） */
  function normCard(v) {
    if (typeof DB.normalizeCardNo === 'function') return DB.normalizeCardNo(v);
    return String(v == null ? '' : v).replace(/[\s\u3000\-_]/g, '').toUpperCase();
  }

  /* 按卡号在本地已加载的人员里查（刷卡走这里，避免每次刷都走 IPC） */
  function findStaffLocal(cardNo) {
    const n = normCard(cardNo);
    if (!n) return null;
    return (state.staffs || []).find((s) => normCard(s.cardNo) === n) || null;
  }

  function staffFiltered() {
    const kw = String(state.staffQuery || '').trim().toLowerCase();
    return (state.staffs || [])
      .filter((s) => {
        if (!kw) return true;
        return [s.cardNo, s.name, s.dept, s.remark, STAFF_ROLE_LABEL[s.role]]
          .some((v) => String(v == null ? '' : v).toLowerCase().indexOf(kw) >= 0);
      })
      .sort((a, b) => natCompare(a.cardNo || '', b.cardNo || ''));
  }

  function staffTableHtml() {
    const all = state.staffs || [];
    const list = staffFiltered();
    const activeCount = all.filter((s) => s.active !== false).length;
    if (!all.length) {
      return `<div class="empty-tip">还没有登记任何人员。点上方「＋ 新增人员」录入，或用「⬆ 导入Excel/CSV」批量导入。</div>`;
    }
    return `
      <div class="table-meta">共 <b>${all.length}</b> 人，启用 <b>${activeCount}</b> 人${state.staffQuery ? `，命中 <b>${list.length}</b> 条` : ''}</div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th style="width:190px">卡号</th>
          <th style="width:120px">姓名</th>
          <th style="width:170px">部门</th>
          <th style="width:110px">角色</th>
          <th style="width:90px">状态</th>
          <th>备注</th>
          <th style="width:150px">操作</th>
        </tr></thead>
        <tbody>
          ${list.length ? list.map((s) => `
            <tr>
              <td class="cell-code">${esc(s.cardNo || '—')}</td>
              <td><b>${esc(s.name || '—')}</b></td>
              <td>${esc(s.dept || '—')}</td>
              <td title="${esc(STAFF_ROLE_HINT[s.role] || '')}">${esc(STAFF_ROLE_LABEL[s.role] || s.role || '—')}</td>
              <td><span class="badge ${s.active === false ? 'muted' : 'ok'}">${s.active === false ? '停用' : '启用'}</span></td>
              <td>${esc(s.remark || '—')}</td>
              <td>
                <button class="btn sm ghost" onclick="staffForm(${s.id})">编辑</button>
                <button class="btn sm danger" onclick="staffDelConfirm(${s.id})">删除</button>
              </td>
            </tr>`).join('') : `<tr><td colspan="7"><div class="empty-tip">没有匹配的人员</div></td></tr>`}
        </tbody>
      </table></div>`;
  }

  async function renderStaff() {
    try { await reloadStaff(); } catch (e) { /* 读不到按空库展示 */ }
    if (state.view !== 'staff') return;
    $('#content').innerHTML = `
      <div class="panel">
        <div class="panel-title">👤 人员卡库
          <span class="panel-actions">
            <button class="btn sm primary" onclick="staffForm(0)">＋ 新增人员</button>
            <button class="btn sm" onclick="staffImport()">⬆ 导入Excel/CSV</button>
            <button class="btn sm ghost" onclick="downloadStaffTemplate()">📄 下载模板</button>
            <button class="btn sm ghost" onclick="exportStaffCsv()">📊 导出CSV</button>
          </span>
        </div>
        <div class="info-tip">
          进出库<b>刷卡</b>时，程序按卡号在这里反查姓名与角色：<b>一张卡只能登记一个人</b>。
          卡号用 USB 读卡器刷入（读卡器相当于键盘，末尾自动带回车），也支持手工输入。
        </div>
        <div class="query-bar">
          <div class="query-field" style="flex:1;min-width:260px;">
            <label>搜索</label>
            <input type="text" id="staff_kw" placeholder="卡号 / 姓名 / 部门 / 备注" value="${esc(state.staffQuery || '')}" autocomplete="off">
          </div>
          <div class="query-field"><label>&nbsp;</label>
            <button type="button" class="btn sm ghost" onclick="staffQueryClear()">清空搜索</button>
          </div>
        </div>
        <div id="staff_table_box">${staffTableHtml()}</div>
        <div class="tip">
          <b>v5.6.0 起出入库只刷一张卡</b>：出库刷「领用人」、回库刷「退库人」，不再要求第二个经办人。
          卡片上的<b>角色</b>现仅作台账标注，不再限制能刷哪个位（任何已登记且启用的卡都能刷）。
          离职或丢卡请用<b>停用</b>而不是删除 —— 停用后刷卡会被拒绝，历史流水仍可追溯到人。
        </div>
      </div>`;
    const kwEl = $('#staff_kw');
    if (kwEl) {
      imeGuard(kwEl, () => {
        state.staffQuery = kwEl.value || '';
        const box = $('#staff_table_box');
        if (box) box.innerHTML = staffTableHtml();
      });
      kwEl.focus();
    }
  }
  window.renderStaff = renderStaff;

  window.staffQueryClear = function () {
    state.staffQuery = '';
    const box = $('#staff_table_box');
    if (box) box.innerHTML = staffTableHtml();
    const kwEl = $('#staff_kw');
    if (kwEl) { kwEl.value = ''; kwEl.focus(); }
  };

  /* 新增 / 编辑表单（id = 0 表示新增） */
  window.staffForm = function (id) {
    const s = id ? (state.staffs || []).find((x) => x.id === Number(id)) : null;
    if (id && !s) { toast('人员不存在，请刷新后重试', 'err'); return; }
    const roleOpts = Object.keys(STAFF_ROLE_LABEL)
      .map((k) => `<option value="${k}"${(s ? s.role : 'both') === k ? ' selected' : ''}>${STAFF_ROLE_LABEL[k]} — ${STAFF_ROLE_HINT[k]}</option>`)
      .join('');
    openModal(id ? `编辑人员 · ${s.name || s.cardNo}` : '新增人员', `
      <div class="form-row">
        <div class="form-group">
          <label>卡号 *</label>
          <div class="swipe-box">
            <input type="text" id="st_card" data-swipe="staff" maxlength="64" autocomplete="off"
              value="${esc(s ? s.cardNo : '')}" placeholder="光标停在此处刷卡，或手工输入卡号">
            <span class="swipe-state" id="st_card_state">待录入</span>
          </div>
          <small class="hint">刷卡后自动跳到「姓名」；卡号不区分大小写与连字符（A1B2-C3D4 = a1b2c3d4）</small>
        </div>
        <div class="form-group">
          <label>姓名 *</label>
          <input type="text" id="st_name" maxlength="30" value="${esc(s ? s.name : '')}" placeholder="如：张三">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>部门</label>
          <input type="text" id="st_dept" maxlength="30" value="${esc(s ? s.dept : '')}" placeholder="如：装配一车间">
        </div>
        <div class="form-group">
          <label>角色 *</label>
          <select id="st_role">${roleOpts}</select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>状态</label>
          <label class="chk-line"><input type="checkbox" id="st_active"${(!s || s.active !== false) ? ' checked' : ''}> 启用（停用后刷卡会被拒绝）</label>
        </div>
        <div class="form-group">
          <label>备注</label>
          <input type="text" id="st_remark" maxlength="60" value="${esc(s ? s.remark : '')}" placeholder="可选">
        </div>
      </div>
      <div class="form-actions">
        <button class="btn primary" onclick="submitStaffForm(${id || 0})">保存</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `);
    /* 卡号框：回车（= 刷卡结束）只做校验与跳转，不提交表单 */
    const cardEl = $('#st_card');
    if (cardEl) {
      cardEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault(); e.stopPropagation();
        const v = cardEl.value.trim();
        const st = $('#st_card_state');
        if (!v) { if (st) { st.className = 'swipe-state err'; st.textContent = '卡号为空'; } return; }
        const dup = findStaffLocal(v);
        if (st) {
          st.className = 'swipe-state ' + (dup && dup.id !== Number(id) ? 'err' : 'ok');
          st.textContent = dup && dup.id !== Number(id) ? `已登记给 ${dup.name}` : '卡号可用';
        }
        const nameEl = $('#st_name');
        if (nameEl) nameEl.focus();
      });
      cardEl.addEventListener('input', () => {
        const st = $('#st_card_state');
        if (st) { st.className = 'swipe-state'; st.textContent = cardEl.value.trim() ? '待确认' : '待录入'; }
      });
      cardEl.focus();
    }
  };

  window.submitStaffForm = async function (id) {
    const cardNo = (($('#st_card') || {}).value || '').trim();
    const name = (($('#st_name') || {}).value || '').trim();
    const dept = (($('#st_dept') || {}).value || '').trim();
    const role = (($('#st_role') || {}).value || 'both');
    const active = !!($('#st_active') || {}).checked;
    const remark = (($('#st_remark') || {}).value || '').trim();
    if (!cardNo) { toast('请刷卡或填写卡号', 'err'); return; }
    if (!name) { toast('请填写姓名', 'err'); return; }
    const payload = { cardNo, name, dept, role, active, remark };
    if (id) payload.id = Number(id);
    try {
      if (id) await DB.staffUpdate(payload); else await DB.staffAdd(payload);
      closeModal();
      await reloadStaff();
      renderStaff();
      toast(id ? '已保存修改' : `已登记「${name}」`, 'ok');
    } catch (e) {
      toast('保存失败：' + (e && e.message ? e.message : e), 'err');
    }
  };

  window.staffDelConfirm = function (id) {
    const s = (state.staffs || []).find((x) => x.id === Number(id));
    if (!s) { toast('人员不存在', 'err'); return; }
    openModal(`删除人员 · ${s.name || s.cardNo}`, `
      <p style="color:var(--danger);font-weight:600;margin:0 0 12px;">⚠️ 删除后这张卡将无法再刷卡，且不保留任何提示。</p>
      <p class="muted" style="margin:0 0 8px;">
        卡号 <b>${esc(s.cardNo)}</b> ｜ 姓名 <b>${esc(s.name)}</b> ｜ 角色 <b>${esc(STAFF_ROLE_LABEL[s.role] || s.role)}</b>
      </p>
      <p class="muted" style="margin:0 0 12px;">
        已发生的出入库流水<b>不会受影响</b>（流水里存的是姓名与卡号快照）。
        若只是离职或丢卡，建议改用<b>编辑 → 取消勾选「启用」</b>，这样刷卡时能明确提示「卡已停用」。
      </p>
      <div class="form-actions">
        <button class="btn danger" onclick="submitStaffDel(${s.id})">确认删除</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `);
  };

  window.submitStaffDel = async function (id) {
    try {
      await DB.staffDel(Number(id));
      closeModal();
      await reloadStaff();
      renderStaff();
      toast('已删除该人员', 'ok');
    } catch (e) { toast('删除失败：' + (e && e.message ? e.message : e), 'err'); }
  };

  /* ---- 导入：解析（纯函数，供测试切片复用） ---- */
  function staffHeaderIndex(headerRow) {
    const idx = {};
    (headerRow || []).forEach((h, i) => {
      const key = STAFF_IMPORT_ALIAS[normalizeHeader(h)];
      if (key && idx[key] == null) idx[key] = i;
    });
    return idx;
  }

  function parseStaffRole(raw) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) return 'both';
    if (/两者|皆|都|全部|both|all/i.test(t)) return 'both';
    if (/经办|操作|仓管|operator/i.test(t)) return 'operator';
    if (/领|借|使用|borrower|user/i.test(t)) return 'borrower';
    return '';
  }

  function parseStaffActive(raw) {
    const t = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!t) return true;
    return !/^(停用|禁用|否|不启用|离职|false|0|no|inactive|disabled)$/.test(t);
  }

  /* 逐行解析 → { ok, staff } / { ok:false, reason } */
  function parseStaffRow(row, idx) {
    const get = (k) => (idx[k] == null ? '' : String(row[idx[k]] == null ? '' : row[idx[k]]).trim());
    const cardNo = get('cardNo');
    const name = get('name');
    if (!cardNo) return { ok: false, reason: '卡号为空' };
    if (!name) return { ok: false, reason: '姓名为空' };
    const role = parseStaffRole(get('role'));
    if (!role) return { ok: false, reason: '角色无法识别（可填 领用人 / 两者皆可）' };
    if (!DB.isValidCardNo(cardNo)) return { ok: false, reason: '卡号含竖线/逗号或超长' };
    if (!DB.isValidStaffName(name)) return { ok: false, reason: '姓名超长或含非法字符' };
    return {
      ok: true,
      staff: {
        cardNo, name,
        dept: get('dept'),
        role,
        active: parseStaffActive(get('active')),
        remark: get('remark')
      }
    };
  }

  /* 导入计划：文件内查重 + 库内查重（已登记的卡直接跳过，不覆盖别人） */
  function buildStaffImportPlan(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return { ok: false, error: '文件是空的，没有可导入的行' };
    const idx = staffHeaderIndex(list[0]);
    if (idx.cardNo == null && idx.name == null) {
      return { ok: false, error: '没找到「卡号」或「姓名」列，请核对表头（可下载模板对照）' };
    }
    if (idx.cardNo == null) return { ok: false, error: '缺少「卡号」列，无法导入' };
    if (idx.name == null) return { ok: false, error: '缺少「姓名」列，无法导入' };

    const existing = new Map();
    (state.staffs || []).forEach((s) => existing.set(normCard(s.cardNo), s));
    const seen = new Map();
    const plan = [], skipped = [];
    for (let i = 1; i < list.length; i++) {
      const row = list[i];
      if (!row || !row.some((c) => String(c == null ? '' : c).trim() !== '')) continue;
      const r = parseStaffRow(row, idx);
      const rowNo = i + 1;
      if (!r.ok) { skipped.push({ row: rowNo, reason: r.reason }); continue; }
      const key = normCard(r.staff.cardNo);
      if (seen.has(key)) { skipped.push({ row: rowNo, reason: `与第 ${seen.get(key)} 行卡号重复` }); continue; }
      if (existing.has(key)) {
        skipped.push({ row: rowNo, reason: `卡号已登记给「${existing.get(key).name}」` });
        continue;
      }
      seen.set(key, rowNo);
      plan.push({ row: rowNo, staff: r.staff });
    }
    return { ok: true, plan, skipped };
  }

  let staffImportPlan = [];

  window.staffImport = async function () {
    const api = window.api;
    if (!api || typeof api.pickSpreadsheet !== 'function') {
      toast('当前环境不支持文件选择（浏览器调试模式），请用 CSV 方式或手工录入', 'err');
      return;
    }
    let picked;
    try { picked = await api.pickSpreadsheet(); }
    catch (e) { toast('读取文件失败：' + (e && e.message ? e.message : e), 'err'); return; }
    if (!picked || picked.ok === false) {
      if (picked && picked.error) toast('读取失败：' + picked.error, 'err');
      return;
    }
    let rows = null;
    try {
      if (picked.kind === 'csv') {
        rows = parseCSV(picked.text);
      } else {
        const r = await api.readSpreadsheet(picked.bytes);
        if (!r || !r.ok) { toast('解析 Excel 失败：' + ((r && r.error) || '未知错误'), 'err'); return; }
        rows = r.rows;
      }
    } catch (e) { toast('解析失败：' + (e && e.message ? e.message : e), 'err'); return; }

    await reloadStaff();
    const result = buildStaffImportPlan(rows);
    if (!result.ok) { toast(result.error, 'err'); return; }
    staffImportPlan = result.plan;
    window.showStaffImportPreview(result, picked.name);
  };

  window.showStaffImportPreview = function (result, filename) {
    const { plan, skipped } = result;
    openModal(`导入预览 · ${filename || ''}`, `
      <p style="margin:0 0 10px;">可导入 <b style="color:var(--ok)">${plan.length}</b> 人；跳过 <b style="color:var(--warn)">${skipped.length}</b> 行。</p>
      ${plan.length ? `
        <div class="table-wrap" style="max-height:300px; overflow:auto;">
          <table>
            <thead><tr><th style="width:60px">行</th><th>卡号</th><th>姓名</th><th>部门</th><th>角色</th><th>状态</th></tr></thead>
            <tbody>
              ${plan.slice(0, 200).map((p) => `<tr>
                <td class="muted">${p.row}</td>
                <td class="cell-code">${esc(p.staff.cardNo)}</td>
                <td>${esc(p.staff.name)}</td>
                <td>${esc(p.staff.dept || '—')}</td>
                <td>${esc(STAFF_ROLE_LABEL[p.staff.role] || p.staff.role)}</td>
                <td>${p.staff.active ? '启用' : '停用'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${plan.length > 200 ? '<p class="muted">仅展示前 200 行…</p>' : ''}` : '<div class="empty-tip">没有可导入的行</div>'}
      ${skipped.length ? `
        <p class="muted" style="margin:12px 0 0;">跳过明细（前 10 条）：${esc(skipped.slice(0, 10).map((s) => `第 ${s.row} 行(${s.reason})`).join('、'))}${skipped.length > 10 ? ' 等' : ''}</p>` : ''}
      <div class="form-actions">
        <button class="btn primary" onclick="confirmStaffImport()"${plan.length ? '' : ' disabled'}>确认导入 ${plan.length} 人</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `);
  };

  window.confirmStaffImport = async function () {
    if (!staffImportPlan.length) { toast('没有可导入的行', 'err'); return; }
    let ok = 0, fail = 0;
    const errs = [];
    for (const p of staffImportPlan) {
      try { await DB.staffAdd(p.staff); ok++; }
      catch (e) { fail++; if (errs.length < 5) errs.push(`${p.staff.cardNo}：${e && e.message ? e.message : e}`); }
    }
    staffImportPlan = [];
    closeModal();
    await reloadStaff();
    renderStaff();
    if (ok) toast(`导入完成：新增 ${ok} 人${fail ? `，失败 ${fail} 人（${errs.join('；')}）` : ''}`, fail ? 'warn' : 'ok');
    else toast('导入失败：' + (errs.join('；') || '未知原因'), 'err');
  };

  /* 模板与导出共用同一份列定义，保证「导出 → 改 → 导入」可原样回灌 */
  window.downloadStaffTemplate = function () {
    const sample = [
      ['A1B2C3D4', '张三', '装配一车间', '两者皆可', '启用', '班组长'],
      ['A1B2C3D5', '李四', '装配一车间', '领用人', '启用', ''],
      ['A1B2C3D6', '王五', '仓库', '经办人', '启用', '仓管员'],
      ['A1B2C3D7', '赵六', '冲压车间', '领用人', '停用', '已离职，保留备查']
    ];
    download('人员卡库导入模板.csv', buildCsvText(STAFF_IMPORT_HEADERS, sample));
    toast('模板已下载（角色可填：领用人 / 经办人 / 两者皆可；状态可填：启用 / 停用）', 'ok');
  };

  window.exportStaffCsv = function () {
    const list = (state.staffs || []).slice().sort((a, b) => natCompare(a.cardNo || '', b.cardNo || ''));
    if (!list.length) { toast('还没有人员可导出', 'warn'); return; }
    const rows = list.map((s) => [
      s.cardNo || '', s.name || '', s.dept || '',
      STAFF_ROLE_LABEL[s.role] || '两者皆可',
      s.active === false ? '停用' : '启用',
      s.remark || ''
    ]);
    download('人员卡库_' + new Date().toISOString().slice(0, 10) + '.csv', buildCsvText(STAFF_IMPORT_HEADERS, rows));
    toast(`已导出 ${rows.length} 人（列结构与导入模板一致）`, 'ok');
  };

  /* ============================================================
   * 异常工装（v5.8.0）
   *
   * 背景：一次导入 4114 条后，按「工装号-套号」规则治理（套号唯一化 + 去重），
   * 剩 3911 条。用户确认的异常口径：
   *   - 一工装多机种是正常设计（机种不一致不列异常）；
   *   - 名称应一致（不一致 = 异常，标红，人工确认/修改）；
   *   - 一套工装一个库位，多套应同库位（不一致 = 异常，需人工修改）。
   * 本页用于**修改导入的数据**：统一名称 / 逐条编辑（复用编辑表单，改编号/名称/库位/机种）。
   * ============================================================ */

  /* 与 clean_fixture_data.py 的 SERIAL_RE 同源：工装号-3位套号 */
  const FIX_SERIAL_RE = /^(.+?)-(\d{3})$/;
  function parseFixSerial(serialNo) {
    const m = FIX_SERIAL_RE.exec(String(serialNo == null ? '' : serialNo).trim());
    return m ? { base: m[1], seq: Number(m[2]) } : null;
  }

  /* v5.8.1：异常工装页「逐条编辑」——展开的工装号集合（点击 toggle 时增删，重渲染） */
  const anomExpanded = new Set();

  function renderFixAnomaly() {
    const list = state.fixtures || [];

    /* ---- 聚合：按工装号分组（格式异常单独列出） ---- */
    const groups = new Map();      // base -> fixtures[]
    const unparsed = [];           // serialNo 无法解析
    list.forEach((f) => {
      const p = parseFixSerial(f.serialNo);
      if (!p) { unparsed.push(f); return; }
      if (!groups.has(p.base)) groups.set(p.base, []);
      groups.get(p.base).push(f);
    });

    /* ---- 异常判定 ---- */
    // 库位按「套」管理：同一工装号多套可分布在多个库位（正常存储），不再视为异常；
    // 此处仅把多库位工装号收进 locInfo 作「库位分布」信息展示（便于快速找套）。
    const nameAnoms = [];       // 名称不一致组（异常）
    const missingAnoms = [];    // 套号缺失组（异常）
    const locInfo = [];         // 库位分布组（信息，非异常）
    groups.forEach((items, base) => {
      const names = uniqueSorted(items.map((f) => f.name).filter(Boolean));
      const locs = uniqueSorted(items.map((f) => f.location).filter(Boolean));
      if (names.length > 1) nameAnoms.push({ base, items, names });
      if (locs.length > 1) locInfo.push({ base, items, locs });
      // 套号缺失：**多套**工装号下套号不连续（1..max 中有空洞）→ 标黄待确认。
      // 仅建 1 套且套号非 001（如 C9U3-921-030 只有 -002）不算缺号：该工装确实只建了那一套。
      if (items.length < 2) return;
      const seqs = items.map((f) => parseFixSerial(f.serialNo).seq).sort((a, b) => a - b);
      const max = seqs[seqs.length - 1];
      const miss = [];
      for (let s = 1; s < max; s++) if (!seqs.includes(s)) miss.push(s);
      if (miss.length) missingAnoms.push({ base, items, miss });
    });
    /* 按问题严重度排序：套数多/问题多的组靠前 */
    nameAnoms.sort((a, b) => b.items.length - a.items.length);
    missingAnoms.sort((a, b) => b.items.length - a.items.length);
    locInfo.sort((a, b) => b.items.length - a.items.length);

    /* ---- v5.8.1「逐条编辑」：展开某工装号下所有记录，逐条编辑完整信息 ---- */
    const anomDetailRow = (base, colspan) => {
      if (!anomExpanded.has(base)) return '';
      const items = (state.fixtures || []).filter((f) => {
        const p = parseFixSerial(f.serialNo);
        return p && p.base === base;
      }).sort((a, b) => Number(a.code) - Number(b.code));
      const sub = items.map((f) => {
        const p = parseFixSerial(f.serialNo);
        return `<tr>
          <td class="mono">${p ? String(p.seq).padStart(3, '0') : ''}</td>
          <td class="mono">${esc(f.code)}</td>
          <td class="mono">${esc(f.serialNo)}</td>
          <td>${esc(f.name)}</td>
          <td>${esc(f.location)}</td>
          <td>${esc((f.lineModels || []).join(' / '))}</td>
          <td class="anom-ops">
            <button class="btn sm" onclick="fixtureEdit(${f.id})">✏️ 编辑</button>
            <button class="btn sm" onclick="fixAnomalyJumpCardEdit(${f.id})">🔍 卡片编辑</button>
          </td>
        </tr>`;
      }).join('');
      return `<tr class="anom-detail"><td colspan="${colspan}">
        <table class="anom-table sub"><thead><tr>
          <th>套号</th><th>序号</th><th>编号</th><th>名称</th><th>库位</th><th>机种</th><th>操作</th>
        </tr></thead><tbody>${sub}</tbody></table>
      </td></tr>`;
    };
    const detailToggleBtn = (base, label) =>
      `<button class="btn sm" onclick="fixAnomalyToggleDetail('${escAttr(base)}')">${anomExpanded.has(base) ? '▲ 收起明细' : '📝 ' + label}</button>`;

    /* ---- 概览 ---- */
    const totalAnom = nameAnoms.length + unparsed.length + missingAnoms.length;
    const summary = `
      <div class="info-tip">
        <b>异常工装（修改导入数据）</b>：按「工装号-套号」规则核对。<br>
        ① 名称不一致 <b class="stat-danger">${nameAnoms.length}</b> 组 · ② 编号格式异常 <b class="stat-danger">${unparsed.length}</b> 条
        · ③ 套号缺失 <b class="stat-warn">${missingAnoms.length}</b> 组<br>
        库位分布 <b>${locInfo.length}</b> 个工装号（信息：同一工装号多套分布在多个库位属正常存储，不作异常）。
        共 <b>${totalAnom}</b> 项待处理。机种不一致属正常设计（一工装多机种），不列异常。
        修改后即时写回 <code>fixture-data.json</code>。
      </div>`;

    /* ---- 名称不一致 ---- */
    const nameRows = nameAnoms.length
      ? nameAnoms.map((g) => {
          const listHtml = g.names.map((n) => `<span class="anom-val">${esc(n)}</span>`).join('');
          const count = g.items.length;
          return `<tr>
            <td class="mono">${esc(g.base)}</td>
            <td>${count} 套</td>
            <td>${listHtml}</td>
            <td class="anom-ops">
              <button class="btn sm primary" onclick="fixAnomalyUnifyName('${escAttr(g.base)}')">⚡ 统一名称</button>
              ${detailToggleBtn(g.base, '逐条编辑')}
            </td>
          </tr>${anomDetailRow(g.base, 4)}`;
        }).join('')
      : '<tr><td colspan="4" class="empty">无名称不一致的工装</td></tr>';

    /* ---- 库位分布（信息，非异常） ---- */
    const locRows = locInfo.length
      ? locInfo.map((g) => {
          const locCount = new Map();
          g.items.forEach((f) => { const l = f.location || ''; locCount.set(l, (locCount.get(l) || 0) + 1); });
          const listHtml = [...locCount.entries()].map(([l, c]) => `<span class="anom-val">${esc(l)}（${c}套）</span>`).join('');
          return `<tr>
            <td class="mono">${esc(g.base)}</td>
            <td>${g.items.length} 套</td>
            <td>${listHtml}</td>
            <td class="anom-ops">
              <button class="btn sm" onclick="fixAnomalyJumpFixtures('${escAttr(g.base)}')">🔍 去夹具管理核对</button>
              ${detailToggleBtn(g.base, '逐条编辑')}
            </td>
          </tr>${anomDetailRow(g.base, 4)}`;
        }).join('')
      : '<tr><td colspan="4" class="empty">无多库位工装</td></tr>';

    /* ---- 格式异常 ---- */
    const fmtRows = unparsed.length
      ? unparsed.map((f) => `<tr>
          <td class="mono">${esc(f.code)}</td>
          <td class="mono anom-bad">${esc(f.serialNo)}</td>
          <td>${esc(f.name)}</td>
          <td>${esc(f.location)}</td>
          <td class="anom-ops">
            <button class="btn sm" onclick="fixtureEdit(${f.id})">✏️ 修正编号</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="empty">无编号格式异常</td></tr>';

    /* ---- 套号缺失 ---- */
    const missRows = missingAnoms.length
      ? missingAnoms.map((g) => `<tr>
          <td class="mono">${esc(g.base)}</td>
          <td>${g.items.length} 套</td>
          <td>现有 ${g.items.map((f) => String(parseFixSerial(f.serialNo).seq).padStart(3, '0')).join('、')}</td>
          <td class="anom-bad">缺 ${g.miss.map((m) => String(m).padStart(3, '0')).join('、')}</td>
          <td class="anom-ops">
            <button class="btn sm" onclick="fixAnomalyJumpFixtures('${escAttr(g.base)}')">🔍 去夹具管理核对</button>
            ${detailToggleBtn(g.base, '逐条编辑')}
          </td>
        </tr>${anomDetailRow(g.base, 5)}`).join('')
      : '<tr><td colspan="5" class="empty">无套号缺失的工装</td></tr>';

    $('#content').innerHTML = `
      <div class="panel">
        <div class="panel-title">⚠️ 异常工装
          <span class="panel-actions">
            <button class="btn sm" onclick="renderFixAnomaly()">🔄 刷新</button>
          </span>
        </div>
        ${summary}
        <div class="anom-section">
          <div class="anom-sec-title">① 名称不一致（同工装号下多套名称不同，需人工确认主名称）</div>
          <table class="anom-table"><thead><tr><th>工装号</th><th>套数</th><th>现有名称</th><th>操作</th></tr></thead><tbody>${nameRows}</tbody></table>
        </div>
        <div class="anom-section">
          <div class="anom-sec-title">② 编号格式异常（末尾不是 3 位套号，无法套用「工装号-套号」规则，请人工修正）</div>
          <table class="anom-table"><thead><tr><th>序号</th><th>编号</th><th>名称</th><th>库位</th><th>操作</th></tr></thead><tbody>${fmtRows}</tbody></table>
        </div>
        <div class="anom-section">
          <div class="anom-sec-title">③ 套号缺失（同工装号下套号不连续，可能漏建档或另套编号体系，请人工核对）</div>
          <table class="anom-table"><thead><tr><th>工装号</th><th>套数</th><th>现有套号</th><th>缺失套号</th><th>操作</th></tr></thead><tbody>${missRows}</tbody></table>
        </div>
        <div class="anom-section">
          <div class="anom-sec-title">库位分布（信息）：同一工装号多套分布在多个库位属正常存储，此处仅便于快速找套，不作异常</div>
          <table class="anom-table"><thead><tr><th>工装号</th><th>套数</th><th>库位分布</th><th>操作</th></tr></thead><tbody>${locRows}</tbody></table>
        </div>
        <div class="tip">
          「📝 逐条编辑」可展开该工装号下每条记录，直接改编号/名称/库位/机种等完整信息（✏️ 编辑就地弹窗；
          🔍 卡片编辑跳到「夹具管理」定位该卡并打开编辑）；若整套名称确实录错，也可用「⚡ 统一名称」。
          机种不一致不在此列（一工装多机种是正常设计）；库位按套管理，多套散放不同库位属正常。
        </div>
      </div>`;
  }
  window.renderFixAnomaly = renderFixAnomaly;

  /* 「统一名称」：该工装号下所有套批量改成指定名称 */
  window.fixAnomalyUnifyName = function (base) {
    const items = (state.fixtures || []).filter((f) => {
      const p = parseFixSerial(f.serialNo);
      return p && p.base === base;
    });
    if (!items.length) { toast('未找到该工装号', 'err'); return; }
    const cur = uniqueSorted(items.map((f) => f.name).filter(Boolean));
    const opts = cur.map((n) => `<option value="${escAttr(n)}">${esc(n)}（${items.filter((f) => f.name === n).length} 套）</option>`).join('');
    openModal('统一名称 · ' + base, `
      <div class="form-group"><label>选择主名称（该工装号全部 ${items.length} 套将统一为此名称）</label>
        <select id="anom_unify_name_sel">${opts}</select>
        <small class="hint">也可在下框直接输入新名称</small></div>
      <div class="form-group"><label>或输入新名称</label>
        <input type="text" id="anom_unify_name_new" maxlength="64" placeholder="留空则用上方下拉所选"></div>
      <div class="form-actions">
        <button class="btn primary" onclick="fixAnomalyDoUnifyName('${escAttr(base)}')">✔ 统一修改</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>`);
  };

  window.fixAnomalyDoUnifyName = async function (base) {
    const sel = $('#anom_unify_name_sel');
    const inp = $('#anom_unify_name_new');
    const name = (inp && String(inp.value).trim()) || (sel && sel.value) || '';
    if (!name) { toast('请选择或输入名称', 'err'); return; }
    const items = (state.fixtures || []).filter((f) => {
      const p = parseFixSerial(f.serialNo);
      return p && p.base === base && f.name !== name;
    });
    if (!items.length) { toast('无需修改（名称已一致）', 'ok'); closeModal(); return; }
    try {
      const res = await DB.fixtureUpdateBatch(items.map((f) => ({ id: f.id, patch: { name } })));
      if (res && res.failed && res.failed.length) { toast('部分失败：' + res.failed[0].message, 'err'); return; }
      await reloadAll();
      closeModal();
      renderFixAnomaly();
      toast(`已将 ${items.length} 套名称统一为「${name}」`, 'ok');
    } catch (e) { toast('统一失败：' + (e && e.message ? e.message : e), 'err'); }
  };

  /* 「去夹具管理核对」：跳转到夹具管理并按工装号检索 */
  window.fixAnomalyJumpFixtures = function (base) {
    showView('fixtures');
    const kw = $('#fix_search');
    if (kw) { kw.value = base; fixtureSearch(); }
  };

  /* v5.8.1「逐条编辑」：展开 / 收起某工装号的记录明细 */
  window.fixAnomalyToggleDetail = function (base) {
    if (anomExpanded.has(base)) anomExpanded.delete(base); else anomExpanded.add(base);
    renderFixAnomaly();
  };

  /* v5.8.1「卡片编辑」：跳到夹具管理，定位该记录并直接打开其编辑表单 */
  window.fixAnomalyJumpCardEdit = function (id) {
    const f = (state.fixtures || []).find((x) => x.id === id);
    if (!f) { toast('未找到该夹具', 'err'); return; }
    showView('fixtures');
    const kw = $('#fix_search');
    if (kw) { kw.value = f.serialNo || String(f.code || ''); fixtureSearch(); }
    fixtureEdit(id);
  };

  /* ============================================================
   * 数据备份
   * ============================================================ */
  function renderData() {
    $('#content').innerHTML = `
      <div class="panel">
        <div class="panel-title">💾 数据备份与恢复</div>
        <div style="padding:20px; line-height:2;">
          <p>数据文件：<code>fixture-data.json</code>（程序同目录）</p>
          <p>备份方法：复制该文件到安全位置即可。</p>
          <p>恢复方法：将备份文件覆盖回程序同目录。</p>
          <hr style="margin:20px 0; border:none; border-top:1px solid var(--border);">
          <button class="btn" onclick="exportData()">📥 导出数据</button>
          <button class="btn danger" onclick="clearAllData()" style="margin-left:10px;">🗑️ 清空数据</button>
        </div>
      </div>
    `;
  }

  window.exportData = function () {
    const data = {
      fixtures: state.fixtures,
      fixTransactions: state.fixTransactions,
      exportTime: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '夹具数据备份_' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('数据导出成功', 'ok');
  };

  window.clearAllData = function () {
    const n = state.fixtures.length;
    const m = state.fixTransactions.length;
    openModal('清空所有数据', `
      <p style="color:var(--danger);font-weight:600;margin:0 0 12px;">⚠️ 此操作不可恢复！</p>
      <p class="muted" style="margin:0 0 12px;">
        将永久删除 <b>${n}</b> 个夹具与 <b>${m}</b> 条流水记录，并写入数据文件（重启后不会恢复）。
      </p>
      <p class="muted" style="margin:0 0 8px;">请先导出备份，再输入 <code>清空</code> 以确认：</p>
      <div class="form-group"><input type="text" id="fix_clear_confirm" placeholder="在此输入：清空"></div>
      <div class="form-actions">
        <button class="btn danger" onclick="submitClearAllData()">确认清空</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `);
  };

  window.submitClearAllData = async function () {
    const typed = (($('#fix_clear_confirm') || {}).value || '').trim();
    if (typed !== '清空') { toast('请输入「清空」以确认', 'err'); return; }
    try {
      await DB.clear('fixtures');
      await DB.clear('fixTransactions');
      closeModal();
      await reloadAll();
      renderDashboard();
      toast('数据已清空（已写入文件）', 'ok');
    } catch (e) { toast('清空失败：' + e.message, 'err'); }
  };

  /* ============================================================
   * 二维码 + 标签打印（v1.7）
   * ============================================================ */
  /* 二维码内容 = **序号本身**（纯 4 位数字，如 1001）。
   * 历史版本曾编码为 'SPMS1|1001'（前缀沿用备件系统 SPMS 的命名空间，对本程序无实际意义），
   * v4.0.2 起去掉前缀；`parseQRToken` 仍会剥离旧前缀，保证**已打印的旧标签继续可扫**。 */
  function makeQRToken(f) { return (f && f.code) ? String(f.code) : ''; }
  function drawQR(canvas, text, opts) {
    opts = opts || {};
    const qr = qrcode(opts.type || 0, opts.ec || 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const scale = opts.scale || 6, margin = (opts.margin == null ? 4 : opts.margin);
    const size = (count + margin * 2) * scale;
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    }
    return size;
  }

  /* ---- 单夹具二维码 ---- */
  window.openFixtureQR = function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) return;
    state.qrFixture = f;
    const token = makeQRToken(f);
    openModal('夹具二维码 · ' + (f.serialNo || f.code), `
      <div class="qr-block">
        <canvas id="qrCanvas" class="qr-canvas"></canvas>
        <div class="qr-info">
          <div><b>夹具编号：</b>${esc(f.serialNo || '（未填编号）')}</div>
          <div><b>名称：</b>${esc(f.name)}</div>
          <div><b>序号：</b>${esc(f.code)}<span class="muted">（系统分配 · 二维码内容）</span></div>
          <div><b>机种名称：</b>${esc(formatLineModels(f, '—'))}</div>
          <div><b>产线：</b>${esc(lineNamesLabel(f, '—'))}</div>
          <div><b>库位：</b>${esc(f.location || '（未分配）')}</div>
          <div class="muted">二维码内容：${esc(token)}</div>
          <div class="muted">标签卡只打印「夹具编号 + 名称」两项。</div>
        </div>
      </div>
      <div class="btn-row mt">
        <button class="btn" onclick="downloadFixtureQR()">下载 PNG</button>
        <button class="btn" onclick="printSingleLabel()">🖨 打印</button>
        <button class="btn ghost" onclick="closeModal()">关闭</button>
      </div>`);
    drawQR($('#qrCanvas'), token, { scale: 6, margin: 4 });
  };
  window.downloadFixtureQR = function () {
    const c = $('#qrCanvas'); if (!c) return;
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = '二维码_' + (state.qrFixture ? state.qrFixture.code : 'fixture') + '.png';
    a.click();
  };

  /* ===================== 打印：纸张尺寸 / 对齐 / 边距 / 预览 ===================== */
  const PAPER_PRESETS = {
    A4:           { name: 'A4', w: 210, h: 297, m: 5 },
    A5:           { name: 'A5', w: 148, h: 210, m: 5 },
    receipt58:    { label: '小票纸 58mm',      w: 58,  h: 100, m: 0 },
    receipt80:    { label: '小票纸 80mm',      w: 80,  h: 100, m: 0 },
    label100x150: { label: '标签纸 100×150mm', w: 100, h: 150, m: 0 },
    custom:       { label: '自定义尺寸…',       w: 0,   h: 0,   m: 0 }
  };
  function defaultPrintSettings() {
    return { paper: 'A4', wmm: 210, hmm: 297, ha: 'center', va: 'center', mt: 5, mr: 5, mb: 5, ml: 5, copies: 1 };
  }
  function loadPrintSettings() {
    try { const s = JSON.parse(localStorage.getItem('fixture-print-settings') || 'null'); if (s && s.paper) return s; } catch (e) {}
    return defaultPrintSettings();
  }
  function savePrintSettings(s) { try { localStorage.setItem('fixture-print-settings', JSON.stringify(s)); } catch (e) {} }
  const mapH = (a) => (a === 'left' ? 'flex-start' : a === 'right' ? 'flex-end' : 'center');
  const mapV = (a) => (a === 'top' ? 'flex-start' : a === 'bottom' ? 'flex-end' : 'center');

  /* 标签卡（打印用）：按定稿**只印「夹具编号 + 夹具名称」**
   * ⚠️ 刻意不印桥梁编号 code —— 二维码里已含 code，标签保持简洁；
   *    代价是「码磨损后无法人工反查」，接受重打。 */
  function labelCardHTML(f) {
    const token = makeQRToken(f);
    return `<div class="label-card">
      <canvas class="label-qr" data-token="${esc(token)}"></canvas>
      <div class="label-text">
        <div class="lc-code">${esc(f.serialNo || '（未填编号）')}</div>
        <div class="lc-name">${esc(f.name)}</div>
      </div></div>`;
  }
  function renderLabels(container, list) {
    container.innerHTML = list.map(labelCardHTML).join('');
    container.querySelectorAll('.label-qr').forEach((cv) => drawQR(cv, cv.dataset.token, { scale: 4, margin: 3 }));
  }
  let printList = [];
  function applyPrintVars(s) {
    const area = $('#printArea');
    area.style.setProperty('--ph', mapH(s.ha));
    area.style.setProperty('--pv', mapV(s.va));
    area.style.setProperty('--pm', `${s.mt}mm ${s.mr}mm ${s.mb}mm ${s.ml}mm`);
  }
  function resolvePageSize(s) {
    const p = PAPER_PRESETS[s.paper];
    if (p && p.name) return p.name;                       // 标准尺寸名（A4/A5）直接传名
    const w = s.paper === 'custom' ? (Number(s.wmm) || 0) : (p ? p.w : 0);
    const h = s.paper === 'custom' ? (Number(s.hmm) || 0) : (p ? p.h : 0);
    const wm = Math.max(10, w) * 1000;                     // 兜底最小 10mm，避免非法页
    const hm = Math.max(10, h) * 1000;
    return { width: Math.round(wm), height: Math.round(hm) }; // 微米
  }
  window.ppOnPaperChange = function () {
    const k = $('#ppPaper').value;
    const p = PAPER_PRESETS[k];
    $('#ppCustom').style.display = k === 'custom' ? 'inline-flex' : 'none';
    if (p && p.w) { $('#ppCW').value = p.w; $('#ppCH').value = p.h; }
    const m = (p && p.m != null) ? p.m : 0;
    $('#ppMT').value = m; $('#ppMR').value = m; $('#ppMB').value = m; $('#ppML').value = m;
    renderPreview();
  };
  function readPrintUI() {
    const k = $('#ppPaper').value;
    const p = PAPER_PRESETS[k] || {};
    return {
      paper: k,
      wmm: k === 'custom' ? (Number($('#ppCW').value) || 0) : (p.w || 0),
      hmm: k === 'custom' ? (Number($('#ppCH').value) || 0) : (p.h || 0),
      ha: $('#ppHa').value,
      va: $('#ppVa').value,
      mt: Number($('#ppMT').value) || 0,
      mr: Number($('#ppMR').value) || 0,
      mb: Number($('#ppMB').value) || 0,
      ml: Number($('#ppML').value) || 0,
      copies: Math.max(1, Number($('#ppCopies').value) || 1)
    };
  }
  function renderPreview() {
    const page = $('#ppPage'); if (!page) return;
    const s = readPrintUI();
    savePrintSettings(s);
    applyPrintVars(s);
    const PXPM = 96 / 25.4;                 // 每毫米对应像素（96dpi）
    const pw = Math.max(1, s.wmm) * PXPM;
    const ph = Math.max(1, s.hmm) * PXPM;
    const scale = Math.min(1, 360 / pw);    // 适配预览舞台宽度
    page.style.width = pw + 'px';
    page.style.height = ph + 'px';
    page.style.transform = 'scale(' + scale + ')';
    page.style.padding = `${s.mt}mm ${s.mr}mm ${s.mb}mm ${s.ml}mm`;
    page.style.justifyContent = mapH(s.ha);
    page.style.alignItems = mapV(s.va);
    page.style.alignContent = mapV(s.va);
    const fit = $('#ppFit');
    fit.style.width = (pw * scale) + 'px';
    fit.style.height = (ph * scale) + 'px';
    renderLabels(page, printList);
    const lbl = $('#ppPaperLabel'); if (lbl) lbl.textContent = `${s.wmm} × ${s.hmm} mm`;
  }
  function buildPrintModal(title, list) {
    printList = list;
    const s = loadPrintSettings();
    const paperOpts = Object.keys(PAPER_PRESETS).map((k) => {
      const p = PAPER_PRESETS[k];
      const t = p.label || p.name || k;
      return `<option value="${k}"${k === s.paper ? ' selected' : ''}>${esc(t)}</option>`;
    }).join('');
    openModal(title, `
      <div class="print-cfg">
        <div class="pc-row">
          <label>纸张尺寸</label>
          <select id="ppPaper" onchange="ppOnPaperChange()">${paperOpts}</select>
          <span id="ppCustom" class="pp-custom" style="display:${s.paper === 'custom' ? 'inline-flex' : 'none'}">
            <input id="ppCW" type="number" min="10" step="1" value="${s.wmm}" style="width:64px"> mm ×
            <input id="ppCH" type="number" min="10" step="1" value="${s.hmm}" style="width:64px"> mm
          </span>
        </div>
        <div class="pc-row">
          <label>水平对齐</label>
          <select id="ppHa">
            <option value="left"${s.ha === 'left' ? ' selected' : ''}>左对齐</option>
            <option value="center"${s.ha === 'center' ? ' selected' : ''}>水平居中</option>
            <option value="right"${s.ha === 'right' ? ' selected' : ''}>右对齐</option>
          </select>
          <label style="margin-left:14px">垂直对齐</label>
          <select id="ppVa">
            <option value="top"${s.va === 'top' ? ' selected' : ''}>顶部</option>
            <option value="center"${s.va === 'center' ? ' selected' : ''}>垂直居中</option>
            <option value="bottom"${s.va === 'bottom' ? ' selected' : ''}>底部</option>
          </select>
        </div>
        <div class="pc-row">
          <label>页边距(mm)</label>
          <span class="pp-margins">上<input id="ppMT" type="number" min="0" step="1" value="${s.mt}" style="width:52px"> 右<input id="ppMR" type="number" min="0" step="1" value="${s.mr}" style="width:52px"> 下<input id="ppMB" type="number" min="0" step="1" value="${s.mb}" style="width:52px"> 左<input id="ppML" type="number" min="0" step="1" value="${s.ml}" style="width:52px"></span>
          <label style="margin-left:14px">份数</label>
          <input id="ppCopies" type="number" min="1" step="1" value="${s.copies}" style="width:52px">
        </div>
      </div>
      <div class="print-preview-title">打印预览（<span id="ppPaperLabel"></span>，按所选纸张比例与对齐实时模拟）</div>
      <div class="pp-stage"><div class="pp-fit" id="ppFit"><div class="pp-page" id="ppPage"></div></div></div>
      <div class="btn-row mt">
        <button class="btn" onclick="ppDoPrint()">🖨 打印</button>
        <button class="btn ghost" onclick="closeModal()">关闭</button>
      </div>`);
    ['ppHa', 'ppVa', 'ppMT', 'ppMR', 'ppMB', 'ppML', 'ppCopies', 'ppCW', 'ppCH'].forEach((id) => {
      const el = $('#' + id); if (el) el.addEventListener('change', renderPreview);
    });
    renderPreview();
  }
  function fallbackPrint() { window.print(); }
  window.ppDoPrint = function () {
    const s = readPrintUI();
    if (!printList || !printList.length) { toast('没有可打印的标签'); return; }
    savePrintSettings(s);
    applyPrintVars(s);
    renderLabels($('#printArea'), printList);   // 确保 #printArea 含最新标签与二维码
    // 与「产线清单」打印互斥：清掉表格区，避免两页内容混在一起送出
    const sheet = $('#printListArea');
    if (sheet) sheet.innerHTML = '';
    const opts = { pageSize: resolvePageSize(s), copies: s.copies };
    const done = (r) => {
      if (r && r.ok) toast('已发送打印任务');
      else if (r && (r.reason === 'cancelled' || ('' + (r.error || '')).indexOf('cancel') >= 0)) { /* 用户取消，不提示 */ }
      else toast('打印失败：' + ((r && (r.error || r.reason)) || '未知错误'));
    };
    if (window.api && window.api.printLabels) {
      Promise.resolve(window.api.printLabels(opts)).then(done).catch(() => fallbackPrint());
    } else { fallbackPrint(); }
  };
  window.printSingleLabel = function () {
    const f = state.qrFixture; if (!f) return;
    buildPrintModal('打印标签 · ' + (f.serialNo || f.code), [f]);
  };
  /* ---- 批量打印标签 ---- */
  window.batchPrintLabels = function () {
    const list = state.fixtures.slice().sort((a, b) => String(a.code).localeCompare(String(b.code)));
    if (!list.length) { toast('暂无夹具，请先录入'); return; }
    buildPrintModal('批量打印标签（共 ' + list.length + ' 张）', list);
  };

  /* ============================================================
   * 扫码功能
   * ============================================================ */
  let scanStream = null;
  let scanAnimFrame = null;

  window.startScan = function (containerId, onScanned) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const video = document.createElement('video');
    video.style.cssText = 'width:100%; max-width:400px; border-radius:8px; background:#000;';
    const scanArea = document.createElement('div');
    scanArea.id = containerId + '_area';
    scanArea.style.cssText = 'text-align:center; padding:20px;';
    scanArea.appendChild(video);
    container.innerHTML = '';
    container.appendChild(scanArea);

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then((stream) => {
        scanStream = stream;
        video.srcObject = stream;
        video.play();
        const canvas = document.createElement('canvas');
        canvas.style.display = 'none';
        container.appendChild(canvas);

        function scan() {
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.height = video.videoHeight;
            canvas.width = video.videoWidth;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
              inversionAttempts: 'dontInvert'
            });
            if (code && code.data) {
              const parsed = parseQRToken(code.data);
              if (parsed) {
                onScanned(parsed);
                stopScan(containerId);
              }
            }
          }
          scanAnimFrame = requestAnimationFrame(scan);
        }
        scan();
      })
      .catch((err) => {
        container.innerHTML = '<div class="empty-tip">无法访问摄像头：' + esc(err.message) + '</div>';
      });
  };

  window.stopScan = function (containerId) {
    if (scanAnimFrame) cancelAnimationFrame(scanAnimFrame);
    if (scanStream) {
      scanStream.getTracks().forEach((t) => t.stop());
      scanStream = null;
    }
  };

  function parseQRToken(str) {
    if (!str) return null;
    let s = String(str).trim();
    // 兼容旧前缀：SPMS1|<code> 或 SPMS|<code>（容忍竖线两侧空格与大小写）；现二维码内容为纯序号，不带前缀
    s = s.replace(/^SPMS1?\s*\|\s*/i, '');
    // 归一化：忽略连字符/下划线/空格，统一大写
    const code = s.replace(/[-_\s]/g, '').toUpperCase();
    if (/^\d{4}$/.test(code)) return code;
    return null;
  };

  /* 扫码命中：自动填入编号并勾选该台（不再额外弹窗，与新表单流程统一）
   * v4.0.0：二维码内容仍是序号 code（归一化比较，容错大小写/连字符差异）
   * v4.0.2：二维码内容改为**纯序号**（去掉 SPMS1| 前缀） */
  function scanPickOne(code, type) {
    const key = String(code == null ? '' : code).trim();
    const f = state.fixtures.find((x) => (DB.codeEq ? DB.codeEq(x.code, key) : String(x.code) === key));
    if (!f) { toast('未找到夹具 ' + key, 'err'); return false; }
    const who = f.serialNo || (f.code);
    const want = type === 'out' ? 'stocked' : 'checked_out';
    if (f.status !== want) {
      toast(type === 'out' ? '夹具 ' + who + ' 不在库' : '夹具 ' + who + ' 未出库', 'err');
      return false;
    }
    const prefix = type === 'out' ? 'out' : 'return';
    /* v5.7.1：先记下已勾选项。旧实现改写编号后立即重绘候选区，
       此前勾的件被整片清空 ⇒ 连扫多件只剩最后一件，数量也随之变成 1。 */
    const before = pickedIds(prefix);
    const codeEl = $('#' + prefix + '_code'); if (codeEl) codeEl.value = f.code;
    const q = type === 'out' ? outSearch : returnSearch;
    q();
    let kept = 0, lost = 0;
    before.forEach((id) => {
      if (id === f.id) return;
      const box = $('.' + prefix + '-pick[data-id="' + id + '"]');
      if (box) { box.checked = true; kept++; } else lost++;
    });
    const cb = $('.' + prefix + '-pick[data-id="' + f.id + '"]');
    if (cb) cb.checked = true;
    syncGroupHead(prefix);
    syncPickToQty(prefix);
    const total = pickedIds(prefix).length;
    if (lost) toast(`${who} 已选中；另有 ${lost} 套不在当前检索结果内，未计入本次勾选`, 'warn');
    else toast(`已选中 ${who}${total > 1 ? `（共 ${total} 套）` : ''}`, 'ok');
    return true;
  }

  window.scanForFixOut = function () {
    const container = $('#fix_scan_out_area');
    if (!container) return;
    startScan('fix_scan_out_area', (code) => scanPickOne(code, 'out'));
  };

  window.scanForFixReturn = function () {
    const container = $('#fix_scan_return_area');
    if (!container) return;
    startScan('fix_scan_return_area', (code) => scanPickOne(code, 'return'));
  };

  /* v5.7.1（BUG-018）：原「📷 批量扫码出库」入口已移除。
     它指向的 #fix_scan_batch_area 从未出现在出库页，点击必无反应；
     而且 startScan() 识别到第一件就停，本就不是批量。摄像头扫码统一走编号栏的 📷。 */

  /* ============================================================
   * 夹具回库
   * ============================================================ */
  window.fixtureReturn = function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) { toast('夹具不存在', 'err'); return; }
    if (f.status !== 'checked_out') { toast('夹具当前不在已出库状态', 'err'); return; }
    const locList = locationCandidates().map((v) => `<option value="${esc(v)}"></option>`).join('');
    const html = `
      <div class="form-group"><label>夹具</label><input type="text" value="${esc(f.serialNo || '（未填编号）')} ${esc(f.name)}（序号 ${esc(f.code)}）" disabled></div>
      <div class="form-group"><label>库位 <span class="req">*</span></label>
        <input type="text" id="fix_return_loc" list="fix_return_loc_list" placeholder="如 ZP1-U-1-1"
          maxlength="${MAX_LOCATION}" value="${esc(f.location || '')}">
        <datalist id="fix_return_loc_list">${locList}</datalist>
        <small class="hint">默认预填出库前的库位，可改为实际归还位置（改则写回并留痕流水）</small></div>
      ${swipeFieldHtml('rdlg')}
      <div class="form-group"><label>回库时间</label><input type="datetime-local" id="fix_return_time" value="${nowInput()}"></div>
      <div class="form-group"><label>备注</label><input type="text" id="fix_return_remark" placeholder="可选备注"></div>
      <div class="form-actions">
        <button class="btn primary" onclick="submitFixtureReturn(${id})">确认回库</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    openModal(`回库 — ${f.serialNo || f.code} ${f.name}`, html);
    /* 弹窗渲染完再绑刷卡（openModal 会整体替换 modalBody） */
    state.swipePick.rdlg = { party: 0 };
    bindSwipe('rdlg');
    const partyEl = $('#swipe_rdlg_party');
    if (partyEl) partyEl.focus();
  };

  window.submitFixtureReturn = async function (id) {
    /* v5.6.0 校验：退库人必须刷已登记且启用的卡 */
    const v = validateSwipe('rdlg');
    if (!v.ok) { toast(v.msg, 'err'); return; }
    /* v5.6.0：经办位取消，只记一个人；operator / operatorCard 留空以兼容历史字段与旧流水 */
    const operator = '';
    const operatorCard = '';
    const counterparty = v.party.name;
    const partyCard = normCard(v.party.cardNo);
    const time = inputToMs($('#fix_return_time').value);
    const remark = ($('#fix_return_remark') || {}).value.trim();
    const location = (($('#fix_return_loc') || {}).value || '').trim();
    if (!isValidLocation(location)) { toast('库位号需为 4 段式（如 ZP1-U-1-1），且不超过 ' + MAX_LOCATION + ' 字符', 'err'); return; }
    try {
      await DB.fixtureAddTransaction({ fixtureId: id, type: 'return', operator, counterparty, operatorCard, partyCard, time, remark, location });
      closeModal();
      await reloadAll();
      renderFixtures();
      toast('回库成功', 'ok');
    } catch (e) { toast('回库失败：' + e.message, 'err'); }
  };

  /* ============================================================
   * 夹具维修
   * ============================================================ */
  window.fixtureRepair = function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) { toast('夹具不存在', 'err'); return; }
    const html = `
      <div class="form-group"><label>夹具</label><input type="text" value="${esc(f.serialNo || '')} ${esc(f.name)}（序号 ${esc(f.code)}）" disabled></div>
      <div class="form-group"><label>维修类型</label>
        <select id="fix_repair_type" style="width:100%; padding:8px; border:1px solid var(--border); border-radius:6px;">
          <option value="repair">普通维修</option>
          <option value="calibrate">校准</option>
          <option value="replace">更换配件</option>
          <option value="maintain">保养</option>
        </select>
      </div>
      <div class="form-group"><label>维修说明</label><input type="text" id="fix_repair_remark" placeholder="维修说明"></div>
      <div class="form-actions">
        <button class="btn primary" onclick="submitFixtureRepair(${id})">确认送修</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    openModal(`送修 — ${f.serialNo || (f.code)} ${f.name}`, html);
  };

  window.submitFixtureRepair = async function (id) {
    const type = ($('#fix_repair_type') || {}).value;
    const remark = ($('#fix_repair_remark') || {}).value.trim();
    const operator = '';   // v5.6.0：不再采集经办人
    try {
      // repairType 独立保存维修子类型，避免填写说明后子类型丢失
      await DB.fixtureAddTransaction({ fixtureId: id, type: 'repair', operator, repairType: type, remark: remark, time: Date.now() });
      closeModal();
      await reloadAll();
      renderFixtures();
      toast('夹具已送修', 'ok');
    } catch (e) { toast('送修失败：' + e.message, 'err'); }
  };

  /* ============================================================
   * 夹具维修完成（从维修状态回库）
   * ============================================================ */
  window.fixtureRepairComplete = function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) { toast('夹具不存在', 'err'); return; }
    if (f.status !== 'repair') { toast('夹具不在维修中状态', 'err'); return; }
    openModal(`维修完成 — ${f.serialNo || (f.code)} ${f.name}`, `
      <div class="form-group"><label>夹具</label><input type="text" value="${esc(f.serialNo || '')} ${esc(f.name)}（序号 ${esc(f.code)}）" disabled></div>
      <div class="form-group"><label>完成时间</label><input type="datetime-local" id="fix_rdone_time" value="${nowInput()}"></div>
      <div class="form-group"><label>维修说明</label><input type="text" id="fix_rdone_remark" placeholder="处理结果（可选）"></div>
      <div class="form-actions">
        <button class="btn primary" onclick="submitFixtureRepairComplete(${id})">确认完成并回库</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `);
  };

  window.submitFixtureRepairComplete = async function (id) {
    const time = inputToMs($('#fix_rdone_time').value);
    const remark = (($('#fix_rdone_remark') || {}).value || '').trim();
    const operator = '';   // v5.6.0：不再采集经办人
    try {
      await DB.fixtureAddTransaction({ fixtureId: id, type: 'repair_done', operator, time, remark: remark || '维修完成' });
      closeModal();
      await reloadAll();
      renderFixtures();
      toast('维修完成，已回库', 'ok');
    } catch (e) { toast('操作失败：' + e.message, 'err'); }
  };

  /* ============================================================
   * 模态框
   * ============================================================ */
  window.openModal = function (title, bodyHtml) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    $('#modalOverlay').hidden = false;
  };

  window.closeModal = function () {
    $('#modalOverlay').hidden = true;
    $('#modalBody').innerHTML = '';
  };

  /* ============================================================
   * 产线使用 / 产线配置（v5.0.0）
   *
   * 数据层级：line（唯一结构表）→ 由 fixtures.lines 反查该产线上装了哪些夹具。
   * ⚠️ v5.0.0：工位（station）与产线示意图（工位图）已整体移除，夹具只关联到产线；
   *   机种（productions）是独立字典，不隶属任何产线。
   * ============================================================ */

  /* 线体形态只有两种：直线形 / U型。未知值一律按直线形处理。
   * 历史数据兼容：早期版本用过 loop / circle / ring 表示「环形」，一律折算为 U型，
   *   保证旧 fixture-data.json 直接打开不会丢形态（不写回文件，只影响显示）。 */
  const LINE_TYPES = [
    { key: 'linear', label: '直线形', icon: '▬' },
    { key: 'u', label: 'U型', icon: '⌣' }
  ];
  const LINE_TYPE_ALIAS = {
    u: 'u', U: 'u', 'u型': 'u', 'U型': 'u', 'u形': 'u', 'U形': 'u',
    loop: 'u', circle: 'u', ring: 'u', 环形: 'u', 圆线: 'u', 环线: 'u'
  };
  function lineTypeKey(type) {
    if (type === 'linear') return 'linear';
    const raw = String(type == null ? '' : type).trim();
    if (raw === 'linear' || raw === '直线形' || raw === '直线') return 'linear';
    if (LINE_TYPE_ALIAS[raw]) return LINE_TYPE_ALIAS[raw];
    // 兜底：含「u / 环 / 圆」视为 U 型，其余直线形
    return /^u$|环|圆|loop|circle|ring/i.test(raw) ? 'u' : 'linear';
  }
  function lineTypeLabel(type) {
    const t = LINE_TYPES.find((x) => x.key === lineTypeKey(type));
    return t ? t.label : '直线形';
  }

  /* 某条产线当前关联的夹具（fixtures.lines 含该线体 id），按夹具编号自然序 */
  function fixturesOfLine(lineId) {
    return (state.fixtures || [])
      .filter((f) => Array.isArray(f.lines) && f.lines.map(Number).indexOf(Number(lineId)) >= 0)
      .sort((a, b) => natCompare(a.serialNo || '', b.serialNo || '') || natCompare(a.code, b.code));
  }

  /* ---------------- 线体 ↔ 机种 互查（v5.2.0） ----------------
   * 机种与线体之间**没有直接绑定**，两条关系都挂在夹具记录上
   * （`fixtures.lines` 存线体 id、`fixtures.lineModels` 存机种名称）。
   * 因此这两列都是**派生值**：现算，不落库，夹具一改两列立刻跟着变。
   * 纯函数（显式传参，便于测试）：不传则退回 state。 */
  function lineModelNamesOfLine(lineId, fixtures) {
    const src = Array.isArray(fixtures) ? fixtures : (state.fixtures || []);
    const want = Number(lineId);
    const set = new Set();
    src.forEach((f) => {
      if (!Array.isArray(f.lines) || f.lines.map(Number).indexOf(want) < 0) return;
      (Array.isArray(f.lineModels) ? f.lineModels : []).forEach((n) => {
        const s = String(n == null ? '' : n).trim();
        if (s) set.add(s);
      });
    });
    return Array.from(set).sort(natCompare);
  }

  function lineNamesOfModel(name, fixtures, lines) {
    const src = Array.isArray(fixtures) ? fixtures : (state.fixtures || []);
    const ls = Array.isArray(lines) ? lines : (state.lines || []);
    const want = String(name == null ? '' : name).trim();
    if (!want) return [];
    const byId = new Map();
    ls.forEach((l) => { if (l && l.id != null) byId.set(Number(l.id), l); });
    const set = new Set();
    src.forEach((f) => {
      const models = (Array.isArray(f.lineModels) ? f.lineModels : [])
        .map((n) => String(n == null ? '' : n).trim());
      if (models.indexOf(want) < 0) return;
      (Array.isArray(f.lines) ? f.lines : []).forEach((id) => {
        const l = byId.get(Number(id));
        if (!l) return;                       // 线体已被删除 → 忽略，不显示幽灵线体
        const nm = String(l.name || '').trim();
        if (nm) set.add(nm);
      });
    });
    return Array.from(set).sort(natCompare);
  }

  /* 把名称数组渲染成「A / B / C」单元格；空数组给破折号。
   * title 里放完整文本，列被压窄时鼠标悬停仍能看全。 */
  function slashCell(names) {
    const arr = (Array.isArray(names) ? names : []).filter(Boolean);
    if (!arr.length) return '<span class="muted">—</span>';
    const text = arr.join(' / ');
    return `<span class="slash-text" title="${esc(text)}">${esc(text)}</span>`;
  }

  /* ---------------- 产线使用页 ----------------
   * v5.0.0：产品级联已废除（机种不隶属产线）；工位模型移除，直接按 fixtures.lines 反查该线的夹具。 */
  async function renderLineQuery() {
    const container = $('#content');
    if (!container) return;
    const q = state.lineQuery;
    // 加载中状态
    container.innerHTML = `
      <div class="panel">
        <div class="panel-title">🔗 产线使用</div>
        <div class="loading-tip"><span class="spinner"></span>正在加载产线配置…</div>
      </div>`;
    try {
      await reloadLineConfig();
    } catch (e) {
      container.innerHTML = `<div class="panel">
        <div class="panel-title" style="color:var(--danger)">加载失败</div>
        <p>${esc(e && e.message ? e.message : String(e))}</p>
      </div>`;
      return;
    }
    if (state.view !== 'linequery') return; // 用户已切走，避免覆盖其他页面

    const lines = (state.lines || []).slice().sort((a, b) => natCompare(a.name || '', b.name || ''));
    // 线体选择：默认落在第一个（或维持原选择）
    if (!lines.some((l) => l.id === q.lineId)) q.lineId = lines.length ? lines[0].id : 0;

    const opt = (val, label, sel) => `<option value="${val}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
    const lineOpts = ['<option value="0">请选择线体</option>']
      .concat(lines.map((l) => opt(l.id, `${l.name}（${lineTypeLabel(l.type)}）`, l.id === q.lineId))).join('');

    // 机种下拉框：从所有夹具的 lineModels 去重生成；未选线体时禁用
    const allModels = new Set();
    (state.fixtures || []).forEach((f) => {
      (f.lineModels || []).forEach((m) => { if (m) allModels.add(m); });
    });
    const modelSorted = Array.from(allModels).sort((a, b) => natCompare(a, b));
    /* v5.2.1：若当前选中机种已从全局机种集合中消失（删改夹具所致），下拉会回落显示
       「全部机种」，但 state 仍保留旧值继续过滤 ⇒ 界面与结果脱节。此处自动复位。 */
    if (q.lineModel && modelSorted.indexOf(q.lineModel) < 0) q.lineModel = '';
    const modelOpts = ['<option value="">全部机种</option>']
      .concat(modelSorted.map((m) => opt(m, m, m === q.lineModel))).join('');

    container.innerHTML = `
      <div class="panel">
        <div class="panel-title">🔗 产线使用
          <span class="panel-actions"><span id="lq_count" class="muted"></span></span>
        </div>
        <div class="query-bar">
          <div class="query-field"><label>线体</label>
            <select id="lq_line" class="query-select" onchange="lineQueryChangeLine()">${lineOpts}</select>
          </div>
          <div class="query-field"><label>机种</label>
            <select id="lq_model" class="query-select" onchange="lineQueryChangeModel()"${q.lineId === 0 ? ' disabled' : ''}>${modelOpts}</select>
          </div>
          <div class="query-field"><label>&nbsp;</label>
            <button type="button" class="btn sm ghost" onclick="lineQueryReset()">重置筛选</button>
          </div>
          <div class="query-field"><label>&nbsp;</label>
            <button type="button" class="btn sm" onclick="printLineQueryList()" title="按当前线体 + 机种筛选结果打印 A4 横向清单">🖨 打印清单</button>
          </div>
          <div class="query-field"><label>&nbsp;</label>
            <button type="button" class="btn sm" onclick="showView('linecfg')">⚙ 去配置产线</button>
          </div>
          <div class="query-field"><label>&nbsp;</label>
            <button type="button" class="btn sm ghost" onclick="showView('prod')">🏷 机种管理</button>
          </div>
        </div>
        ${lines.length ? '' : '<div class="tip">尚未配置任何线体。请先到「产线配置」新建线体，或用「导入」批量铺底。</div>'}
        <div id="lq_body"></div>
      </div>`;
    renderLineQueryBody();
  }

  /* 当前筛选（线体 + 机种）下的夹具行。
   * ⚠️ 屏幕渲染与打印**必须共用这一份计算**，否则两处口径一旦分叉，
   *   就会出现「屏幕 12 套、打印出来 15 套」这种无法自证的问题。 */
  function lineQueryRows() {
    const q = state.lineQuery;
    const line = state.lines.find((l) => l.id === q.lineId) || null;
    if (!line) return { line: null, lineModel: '', rows: [], stocked: 0 };
    const lineModel = q.lineModel || '';
    let rows = fixturesOfLine(line.id);
    /* v5.2.1：下拉是精确枚举值，用等值匹配（大小写 / 首尾空格不敏感）。
       旧实现传原始大写值进 lineModelsMatch 做 includes ⇒ 恒 0 条（BUG-012）。 */
    if (lineModel) rows = rows.filter((f) => lineModelsExact(f, lineModel));
    return { line, lineModel, rows: rows, stocked: rows.filter((f) => f.status === 'stocked').length };
  }

  /* 结果区：该产线上装的夹具清单（只读） */
  function renderLineQueryBody() {
    const box = $('#lq_body');
    if (!box) return;
    const q = state.lineQuery;
    const cnt = $('#lq_count');
    const snap = lineQueryRows();
    const line = snap.line;
    const lineModel = snap.lineModel;
    const rows = snap.rows;
    const stocked = snap.stocked;

    if (!line) {
      if (cnt) cnt.textContent = '';
      box.innerHTML = '<div class="empty-tip">请选择线体以查看该产线上的夹具</div>';
      return;
    }
    if (cnt) cnt.textContent = `${line.name}（${lineTypeLabel(line.type)}） ｜ 夹具 ${rows.length} 套，在库 ${stocked} 套`;

    if (!rows.length) {
      box.innerHTML = `<div class="empty-tip">线体「${esc(line.name)}」上还没有夹具${lineModel ? `（机种「${esc(lineModel)}」下）` : ''}</div>`;
      return;
    }

    box.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>
          <th style="width:80px">序号</th>
          <th style="width:190px">夹具编号</th>
          <th>名称</th>
          <th style="width:200px">机种名称</th>
          <th style="width:150px">库位</th>
          <th style="width:100px">状态</th>
          <th style="width:90px">操作</th>
        </tr></thead>
        <tbody>
          ${rows.map((f) => {
            const st = FIX_STATUS[f.status] || { label: f.status, cls: 'muted' };
            return `<tr>
              <td class="muted">${esc(f.code)}</td>
              <td>${esc(f.serialNo || '—')}</td>
              <td><a href="javascript:;" onclick="fixtureEdit(${f.id})" title="编辑该夹具">${esc(f.name || '—')}</a></td>
              <td>${esc(formatLineModels(f, '—', { collapse: 2 }))}</td>
              <td>${esc(f.location || '—')}</td>
              <td><span class="badge ${st.cls}">${st.label}</span></td>
              <td><button class="btn sm ghost" onclick="fixtureEdit(${f.id})">编辑</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
      <div class="tip">本表为<b>只读</b>视图：夹具归属哪条产线，由「夹具管理 → 新建/编辑夹具」里的<b>关联产线</b>决定。点击夹具名称可直接编辑。</div>
      <div class="tip">「🖨 打印清单」按<b>当前线体 + 当前机种</b>筛选结果出单（A4 横向，列与上表一致，仅去掉「操作」列），套数与上表完全相同。</div>`;
  }

  /* ============================================================
   * 打印产线夹具清单（v5.1.0）
   *
   * 内容来源 = lineQueryRows()，与屏幕表格同一份数据、同一种排序，
   * 因此「屏幕上看到几套，纸上就是几套」。
   * 纸张：A4 横向（仓库/车间常见打印方式），边距用系统默认值避免贴边被裁。
   * ============================================================ */
  window.printLineQueryList = function () {
    const snap = lineQueryRows();
    if (!snap.line) { toast('请先选择线体', 'err'); return; }
    if (!snap.rows.length) { toast('当前筛选没有夹具，无法打印', 'warn'); return; }
    const area = $('#printListArea');
    if (!area) { toast('打印容器缺失，请重启程序后重试', 'err'); return; }
    // 与标签打印互斥：清空另一侧，避免两个容器同时有内容被一起送印
    const labelArea = $('#printArea');
    if (labelArea) labelArea.innerHTML = '';

    const now = new Date();
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const ver = (window.api && window.api.version) || DB.APP_VERSION || '';

    area.innerHTML = `
      <h1>产线夹具清单</h1>
      <div class="ps-meta">线体：<b>${esc(snap.line.name)}</b>（${esc(lineTypeLabel(snap.line.type))}） ｜ 机种：<b>${esc(snap.lineModel || '全部机种')}</b> ｜ 夹具 <b>${snap.rows.length}</b> 套，其中在库 <b>${snap.stocked}</b> 套</div>
      <div class="ps-meta">打印时间：${stamp} ｜ 工装夹具管理程序 v${esc(ver)}</div>
      <table>
        <thead><tr>
          <th style="width:12%">序号</th>
          <th style="width:24%">夹具编号</th>
          <th style="width:20%">名称</th>
          <th style="width:18%">机种名称</th>
          <th style="width:14%">库位</th>
          <th style="width:12%">状态</th>
        </tr></thead>
        <tbody>
          ${snap.rows.map((f) => {
            const st = FIX_STATUS[f.status] || { label: f.status };
            return `<tr>
              <td>${esc(f.code)}</td>
              <td>${esc(f.serialNo || '—')}</td>
              <td>${esc(f.name || '—')}</td>
              <td>${esc(formatLineModels(f, '—'))}</td>
              <td>${esc(f.location || '—')}</td>
              <td>${esc(st.label)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <div class="ps-foot">
        <span>合计 ${snap.rows.length} 套（在库 ${snap.stocked} 套）</span>
        <span>线体：${esc(snap.line.name)}${snap.lineModel ? ' ／ ' + esc(snap.lineModel) : ''}</span>
      </div>
      <div class="ps-sign"><span>制表人：____________</span><span>审核：____________</span><span>日期：____________</span></div>`;

    const done = (r) => {
      if (r && r.ok) toast(`已发送打印任务（${snap.rows.length} 套）`, 'ok');
      else if (r && (r.reason === 'cancelled' || String(r.error || '').indexOf('cancel') >= 0)) { /* 用户取消，不提示 */ }
      else toast('打印失败：' + ((r && (r.error || r.reason)) || '未知错误'), 'err');
    };
    if (window.api && window.api.printLabels) {
      Promise.resolve(window.api.printLabels({
        pageSize: 'A4',
        landscape: true,                          // A4 横向
        margins: { marginType: 'default' }        // 清单用系统默认边距，留白由 CSS 再补
      })).then(done).catch(() => window.print());
    } else {
      window.print();   // 浏览器调试模式
    }
  };

  window.lineQueryChangeLine = function () {
    const newLineId = parseInt(($('#lq_line') || {}).value || '0', 10) || 0;
    state.lineQuery.lineId = newLineId;
    state.lineQuery.lineModel = '';
    const modelSelect = $('#lq_model');
    if (modelSelect) {
      modelSelect.value = '';
      modelSelect.disabled = newLineId === 0;
    }
    renderLineQueryBody();
  };

  window.lineQueryChangeModel = function () {
    state.lineQuery.lineModel = ($('#lq_model') || {}).value || '';
    renderLineQueryBody();
  };

  window.lineQueryReset = function () {
    state.lineQuery.lineId = 0;
    state.lineQuery.lineModel = '';
    const modelSelect = $('#lq_model');
    if (modelSelect) modelSelect.value = '';
    renderLineQuery();
  };

  /* ============================================================
   * 产线配置管理页（线体）
   *
   * v5.0.0 结构变化：
   *   - 「工位」面板与工位 CRUD 整体移除（工位模型已废弃，夹具只关联产线）
   *   - 线体是唯一结构表；夹具归属由 fixtures.lines 反查，此处只读展示数量
   * ============================================================ */
  async function renderLineConfig() {
    const container = $('#content');
    if (!container) return;
    container.innerHTML = `
      <div class="panel">
        <div class="panel-title">⚙ 产线配置</div>
        <div class="loading-tip"><span class="spinner"></span>正在加载产线配置…</div>
      </div>`;
    try {
      await reloadLineConfig();
    } catch (e) {
      container.innerHTML = `<div class="panel">
        <div class="panel-title" style="color:var(--danger)">加载失败</div>
        <p>${esc(e && e.message ? e.message : String(e))}</p>
      </div>`;
      return;
    }
    if (state.view !== 'linecfg') return;

    const cfg = state.lineCfg;
    const lines = (state.lines || []).slice().sort((a, b) => natCompare(a.name || '', b.name || ''));
    if (!lines.some((l) => l.id === cfg.lineId)) cfg.lineId = lines.length ? lines[0].id : 0;

    container.innerHTML = `
      <div class="panel">
        <div class="panel-title">线体
          <span class="panel-actions">
            <button class="btn sm" onclick="lineCfgLineForm(0)">➕ 新建线体</button>
            <button class="btn sm ghost" onclick="lineCfgImport()">⬆ 导入Excel/CSV</button>
            <button class="btn sm ghost" onclick="downloadLineTemplate()">📄 下载模板</button>
          </span>
        </div>
        ${lines.length ? `<div class="table-wrap"><table>
          <thead><tr><th style="width:64px">选用</th><th>线体名称</th><th style="width:110px">形态</th>
            <th style="width:110px">关联夹具</th><th style="width:210px">机种名称</th><th>备注</th><th style="width:150px">操作</th></tr></thead>
          <tbody>
            ${lines.map((l) => {
              const sel = l.id === cfg.lineId;
              return `<tr class="${sel ? 'row-selected' : ''}">
                <td><button class="btn sm ${sel ? 'primary' : 'ghost'}" onclick="lineCfgPickLine(${l.id})">${sel ? '已选' : '选择'}</button></td>
                <td>${esc(l.name)}</td>
                <td>${lineTypeLabel(l.type)}</td>
                <td>${fixturesOfLine(l.id).length} 套</td>
                <td>${slashCell(lineModelNamesOfLine(l.id))}</td>
                <td>${esc(l.remark || '—')}</td>
                <td><span class="row-actions">
                  <button class="btn sm" onclick="lineCfgLineForm(${l.id})">编辑</button>
                  <button class="btn sm danger" onclick="lineCfgDelLine(${l.id})">删除</button>
                </span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>` : '<div class="empty-tip">还没有线体，点「➕ 新建线体」开始</div>'}
        <div class="tip">夹具归属哪条产线，由「夹具管理 → 新建/编辑夹具」里的<b>关联产线</b>决定；这里只统计数量。选中的线体可在「🔗 产线使用」页查看其上的全部夹具。</div>
        <div class="tip"><b>机种名称</b>列是<b>派生值</b>：把该线体上所有夹具的「适用机种」汇总去重，多个机种用 <code>/</code> 分隔，<b>不单独存储</b>。改夹具的机种或关联产线后，这一列会自动跟着变。</div>
      </div>`;
  }

  window.lineCfgPickLine = function (id) {
    state.lineCfg.lineId = id;
    renderLineConfig();
  };

  /* ---- 线体表单 ---- */
  window.lineCfgLineForm = function (id) {
    const l = state.lines.find((x) => x.id === id) || null;
    const typeOpts = LINE_TYPES.map((t) =>
      `<option value="${t.key}"${lineTypeKey(l ? l.type : 'linear') === t.key ? ' selected' : ''}>${t.label}</option>`).join('');
    openModal(l ? '编辑线体' : '新建线体', `
      <div class="form-group"><label>线体名称</label>
        <input type="text" id="lc_line_name" placeholder="如 L1 总装线" value="${esc(l ? l.name : '')}"></div>
      <div class="form-group"><label>产线形态</label>
        <select id="lc_line_type" class="query-select">${typeOpts}</select></div>
      <div class="form-group"><label>备注</label>
        <input type="text" id="lc_line_remark" placeholder="可选" value="${esc(l ? (l.remark || '') : '')}"></div>
      <p class="muted" style="margin:4px 0 0;">产线形态为线体自身属性（<b>直线形</b> / <b>U型</b>），仅作标识展示，不影响夹具关联。</p>
      <div class="form-actions">
        <button class="btn primary" onclick="lineCfgSaveLine(${id})">保存</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>`);
  };

  window.lineCfgSaveLine = async function (id) {
    const name = ($('#lc_line_name') || {}).value.trim();
    const type = ($('#lc_line_type') || {}).value || 'linear';
    const remark = ($('#lc_line_remark') || {}).value.trim();
    if (!name) { toast('请填写线体名称', 'err'); return; }
    const dup = state.lines.some((x) => x.name === name && x.id !== id);
    if (dup) { toast('已存在同名线体', 'err'); return; }
    try {
      if (id) {
        const l = state.lines.find((x) => x.id === id);
        await DB.put('lines', { ...l, name, type, remark, updatedAt: Date.now() });
      } else {
        await DB.add('lines', { name, type, remark, createdAt: Date.now() });
      }
      closeModal();
      await renderLineConfig();
      toast(id ? '线体已更新' : '线体已创建', 'ok');
    } catch (e) { toast('保存失败：' + (e && e.message ? e.message : e), 'err'); }
  };

  /* 删除线体：从全部夹具记录的 lines 中摘除该 id —— 破坏性操作，先说清楚 */
  window.lineCfgDelLine = async function (id) {
    const l = state.lines.find((x) => x.id === id);
    if (!l) return;
    const nf = fixturesOfLine(id).length;
    openModal('删除线体', `
      <p>确定删除线体「<b>${esc(l.name)}</b>」吗？</p>
      <p class="muted">将把 <b>${nf}</b> 套夹具从该产线上摘除（夹具本身保留），此操作不可撤销。</p>
      ${nf ? `<p class="muted" style="color:var(--danger)">⚠️ 摘除后若某套夹具再无任何产线，将被视为「未关联产线」，请随后到「夹具管理」补填。</p>` : ''}
      <div class="form-actions">
        <button class="btn danger" onclick="lineCfgDelLineConfirm(${id})">确认删除</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>`);
  };
  window.lineCfgDelLineConfirm = async function (id) {
    try {
      await DB.lineDel(id);
      if (state.lineCfg.lineId === id) state.lineCfg.lineId = 0;
      closeModal();
      await reloadAll();
      await renderLineConfig();
      toast('线体已删除', 'ok');
    } catch (e) { toast('删除失败：' + (e && e.message ? e.message : e), 'err'); }
  };

  /* ============================================================
   * 产线配置导入（Excel .xlsx / CSV）
   *
   * 语义：一行 = 「把某套夹具**关联**到某条产线」—— 关联的真身在夹具记录里（fixtures.lines）。
   *
   * 表格形态：一张平坦表，每行 = 「某线体 · 一个夹具编号」
   *   线体 | 线体形态 | 夹具编号 | 备注
   * 规则：
   *   - 线体：按名称自动补建（同名复用，不重复创建）
   *   - 夹具编号：按 **实物编号 serialNo** 匹配夹具记录（唯一匹配才写；0 或 >1 条计入跳过）
   *   - 写库为**追加 + 去重**（push 前先查重），绝不覆盖该夹具原有的产线
   *   - 超过产线 5 条上限的行计入跳过
   *   - 导入完成后可在提示里点「撤销本次导入」，精确回滚本次追加的产线
   *
   * ⚠️ v5.0.0：工位模型已废弃，模板不再有「工位 / 工位顺序」列；
   *   旧模板里带工位的表格仍可导入 —— 那两列会被**静默忽略**，不影响线体与夹具关联。
   * ============================================================ */
  const LINE_IMPORT_HEADERS = ['线体', '线体形态', '夹具编号', '备注'];
  const LINE_IMPORT_ALIAS = {
    '线体': 'line', '产线': 'line', '线体名称': 'line', '产线名称': 'line', 'line': 'line',
    '线体形态': 'lineType', '线体类型': 'lineType', '产线形态': 'lineType', '产线类型': 'lineType',
    '形态': 'lineType', '类型': 'lineType', 'type': 'lineType', 'layout': 'lineType',
    '夹具编号': 'fixtureSerial', '实物编号': 'fixtureSerial', '实物夹具编号': 'fixtureSerial',
    '夹具': 'fixtureSerial', '夹具号': 'fixtureSerial', '编号': 'fixtureSerial',
    '备注': 'remark', 'remark': 'remark'
  };

  function mapLineImportHeader(headerRow) {
    const idx = {};
    (headerRow || []).forEach((h, i) => {
      const key = LINE_IMPORT_ALIAS[normalizeHeader(h)];
      if (key && idx[key] == null) idx[key] = i;
    });
    return idx;
  }

  /* 线体形态文本 → 类型键。只有 U型 / 直线形两种：
   * 「U / 环 / 圆 / loop」等写法一律归到 U型（兼容老表格里写的「环形」），其余直线形。 */
  function parseLineType(v) {
    const s2 = String(v == null ? '' : v).trim();
    if (!s2) return 'linear';
    // 只认「U / U型 / U形」开头，避免 "Unit"/"Double" 这类含 u 的词被误判
    if (/^u\s*[型形]?$|^u\s*[型形]|环|圆|loop|circle|ring/i.test(s2)) return 'u';
    return 'linear';
  }

  /* 生成导入计划（纯函数，不写库、不触 DOM）。
   * rows     二维数组（首行表头）
   * existing { lines, fixtures }
   * 返回 { ok, newLines, appends, skipped, error }
   *   newLines  待新建线体 [{ name, type }]
   *   appends   待追加关联 [{ row, fixtureId, code, serialNo, lineName }]
   *
   * ⚠️ 以「线体名」为键，避免依赖尚未生成的真实 id；
   *    产线上限（≤5 条）用「名称集合」预演，故计划阶段即可拦住越界行。 */
  function buildLineImportPlan(rows, existing) {
    if (!rows || rows.length < 2) return { ok: false, error: '文件中没有数据行' };
    const idx = mapLineImportHeader(rows[0]);
    if (idx.line == null) return { ok: false, error: '模板缺少「线体」列' };
    if (idx.fixtureSerial == null) return { ok: false, error: '模板缺少「夹具编号」列（填夹具编号）' };

    const ex = existing || {};
    const lineByName = new Map((ex.lines || []).map((l) => [l.name, l]));
    const lineIdToName = new Map((ex.lines || []).map((l) => [l.id, l.name]));
    // 实物编号 → 夹具记录（允许重复，重复时无法唯一定位）
    const fixBySerial = new Map();
    (ex.fixtures || []).forEach((f) => {
      const k = String(f.serialNo == null ? '' : f.serialNo).trim();
      if (!k) return;
      if (!fixBySerial.has(k)) fixBySerial.set(k, []);
      fixBySerial.get(k).push(f);
    });

    const newLines = new Map();     // lineName -> { name, type }
    const appends = [];
    const skipped = [];
    const planSeen = new Set();     // 「文件内重复行」判定

    /* 每套夹具的「虚拟产线名集合」（含计划内新增） */
    const vstate = new Map();
    const stateOf = (f) => {
      if (!vstate.has(f.id)) {
        const lineNames = new Set((Array.isArray(f.lines) ? f.lines : [])
          .map((id) => lineIdToName.get(Number(id))).filter(Boolean));
        vstate.set(f.id, { lineNames });
      }
      return vstate.get(f.id);
    };

    const val = (row, key) => (idx[key] == null ? '' : String(row[idx[key]] == null ? '' : row[idx[key]]).trim());

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row.some((c) => String(c == null ? '' : c).trim() !== '')) continue; // 全空行
      const lineName = val(row, 'line');
      const serialNo = val(row, 'fixtureSerial');
      if (!lineName) { skipped.push({ row: r + 1, reason: '线体为空' }); continue; }
      if (!serialNo) { skipped.push({ row: r + 1, reason: '夹具编号为空' }); continue; }

      const hits = fixBySerial.get(serialNo) || [];
      if (!hits.length) { skipped.push({ row: r + 1, reason: '夹具「' + serialNo + '」未建档' }); continue; }
      if (hits.length > 1) {
        skipped.push({ row: r + 1, reason: '夹具编号「' + serialNo + '」对应 ' + hits.length + ' 套夹具，无法唯一定位（请改为在「夹具管理」里直接编辑）' });
        continue;
      }
      const f = hits[0];
      const rowKey = f.id + '\u0000' + lineName;
      if (planSeen.has(rowKey)) { skipped.push({ row: r + 1, reason: '文件中重复行' }); continue; }
      planSeen.add(rowKey);

      const vs = stateOf(f);
      if (vs.lineNames.has(lineName)) {
        skipped.push({ row: r + 1, reason: '夹具「' + serialNo + '」已关联产线「' + lineName + '」（无新增，已忽略）' });
        continue;
      }
      if (vs.lineNames.size >= MAX_LINES) {
        skipped.push({ row: r + 1, reason: '夹具「' + serialNo + '」关联产线已达上限 ' + MAX_LINES + ' 条' });
        continue;
      }

      // 结构补建（同名复用；计划内只登记一次）
      const lineType = parseLineType(val(row, 'lineType'));
      if (!lineByName.has(lineName) && !newLines.has(lineName)) {
        newLines.set(lineName, { name: lineName, type: lineType });
      }

      vs.lineNames.add(lineName);
      appends.push({ row: r + 1, fixtureId: f.id, code: f.code, serialNo, lineName });
    }

    if (!newLines.size && !appends.length) {
      return {
        ok: false,
        skipped,
        error: '没有可导入的有效数据行（需「线体 / 已建档的夹具编号」两者齐全且能定位到唯一一套夹具）'
      };
    }
    return { ok: true, newLines: Array.from(newLines.values()), appends, skipped };
  }

  /* 落库：① 补建线体（名称复用）② 把产线追加进对应夹具记录（去重）
   * ⚠️ 全程只做 **push**，绝不覆盖夹具原有的 lines。
   * 返回的对象里带 undo 信息，供「撤销本次导入」精确回滚。 */
  async function applyLineImportPlan(plan) {
    const lineIdByName = new Map((state.lines || []).map((l) => [l.name, l.id]));
    const createdLineIds = [];
    for (const l of plan.newLines) {
      const id = await DB.add('lines', { name: l.name, type: l.type, remark: '导入创建', createdAt: Date.now() });
      lineIdByName.set(l.name, id);
      createdLineIds.push(id);
    }

    // 按夹具聚合要追加的 lineId
    const byFix = new Map();
    for (const a of plan.appends) {
      const lineId = lineIdByName.get(a.lineName);
      if (!lineId) continue;
      if (!byFix.has(a.fixtureId)) byFix.set(a.fixtureId, { lineIds: new Set(), code: a.code, serialNo: a.serialNo });
      byFix.get(a.fixtureId).lineIds.add(lineId);
    }

    const undo = [];   // [{ id, code, serialNo, lineIds:[] }]
    let applied = 0, linesAdded = 0;
    for (const [fid, g] of byFix.entries()) {
      const f = (state.fixtures || []).find((x) => x.id === fid);
      if (!f) continue;
      const lines = (Array.isArray(f.lines) ? f.lines : []).map(Number).slice();
      const addL = [];
      g.lineIds.forEach((id) => {
        if (lines.indexOf(id) < 0 && lines.length < MAX_LINES) { lines.push(id); addL.push(id); }
      });
      if (!addL.length) continue;
      await DB.fixtureUpdate({ id: f.id, lines });
      // 同步本地快照，保证同一批内多行继续追加时读到的是最新值
      f.lines = lines;
      applied++;
      linesAdded += addL.length;
      undo.push({ id: f.id, code: f.code, serialNo: f.serialNo || '', lineIds: addL });
    }

    return {
      lines: plan.newLines.length,
      appends: plan.appends.length,
      applied, linesAdded,
      undo: { fixtures: undo, createdLineIds }
    };
  }

  window.showLineImportPreview = function (plan, sourceName) {
    const rowsPreview = plan.appends.slice(0, 40);
    const body = `
      <div class="tip" style="margin-bottom:10px;">来源：<b>${esc(sourceName)}</b> ｜ 待追加 <b>${plan.appends.length}</b> 行${plan.skipped.length ? ` ｜ 跳过 <b>${plan.skipped.length}</b> 行` : ''}</div>
      <div class="table-wrap" style="border:1px solid var(--border);border-radius:6px;max-height:150px;overflow:auto;">
        <table style="margin:0;">
          <thead><tr><th>项目</th><th style="width:70px">数量</th><th>说明</th></tr></thead>
          <tbody>
            <tr><td>新建线体</td><td>${plan.newLines.length}</td><td>${esc(plan.newLines.map((l) => l.name).join('、') || '—')}</td></tr>
            <tr><td>追加关联</td><td>${plan.appends.length}</td><td>向夹具记录<b>追加</b>产线，不覆盖原有内容</td></tr>
          </tbody>
        </table>
      </div>
      <div style="margin-top:10px;max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:6px;">
        <table style="margin:0;">
          <thead><tr><th>行号</th><th>夹具编号</th><th>名称</th><th>线体</th><th style="width:110px">动作</th></tr></thead>
          <tbody>
            ${rowsPreview.map((a) => `<tr>
              <td>${a.row}</td>
              <td>${esc(a.serialNo)}</td>
              <td>${esc(((state.fixtures || []).find((x) => x.id === a.fixtureId) || {}).name || '—')}</td>
              <td>${esc(a.lineName)}</td>
              <td class="muted">新增产线</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${plan.appends.length > rowsPreview.length ? `<p class="muted" style="margin:6px 0 0;">仅预览前 ${rowsPreview.length} 行，实际将处理全部 ${plan.appends.length} 行。</p>` : ''}
      ${plan.skipped.length ? `<div class="tip" style="margin-top:8px;">跳过 ${plan.skipped.length} 行：${esc(plan.skipped.slice(0, 10).map((x) => '第 ' + x.row + ' 行(' + x.reason + ')').join('、'))}${plan.skipped.length > 10 ? ' 等' : ''}</div>` : ''}
      <p class="muted" style="margin:8px 0 0;">同名线体已存在时直接复用。「夹具编号」按<b>夹具编号</b>匹配，重复导入同一文件不会产生重复关联。旧模板里的「工位 / 工位顺序」列会被忽略。</p>
      <div class="form-actions">
        <button class="btn primary" onclick="confirmLineImport()">确认导入</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>`;
    window.__lineImportPlan = plan;
    openModal('产线配置导入预览', body);
  };

  window.confirmLineImport = async function () {
    const plan = window.__lineImportPlan;
    if (!plan) { closeModal(); return; }
    try {
      const st = await applyLineImportPlan(plan);
      window.__lineImportPlan = null;
      closeModal();
      await reloadAll();
      if (state.view === 'linecfg') await renderLineConfig();
      else if (state.view === 'linequery') await renderLineQuery();
      else if (state.view === 'fixtures') renderFixtures();
      // 记录撤销信息，供「撤销本次导入」精确回滚
      window.__lineImportUndo = (st.applied && st.linesAdded) ? st.undo : null;
      if (st.applied) {
        openModal('导入完成', `
          <p>已为 <b>${st.applied}</b> 套夹具追加关联：新增产线 <b>${st.linesAdded}</b> 条；新建线体 <b>${st.lines}</b> 个。</p>
          <p class="muted">如需回退，可点「撤销本次导入」精确移除本次追加的关联（不会影响夹具原有的产线）。</p>
          <div class="form-actions">
            <button class="btn danger" onclick="undoLineImport()">↩ 撤销本次导入</button>
            <button class="btn primary" onclick="closeModal()">知道了</button>
          </div>`);
      } else {
        toast('导入完成：没有需要新增的关联（均为已存在）', 'warn');
      }
    } catch (e) {
      toast('导入失败：' + (e && e.message ? e.message : e), 'err');
    }
  };

  /* 撤销本次导入：精确摘除本次追加的产线，并回收本次新建且已无人使用的线体 */
  window.undoLineImport = async function () {
    const u = window.__lineImportUndo;
    if (!u) { toast('没有可撤销的导入记录', 'warn'); return; }
    window.__lineImportUndo = null;
    try {
      // ① 按产线批量摘除本次追加的关联
      const removedLines = Array.from(new Set(u.fixtures.flatMap((f) => f.lineIds)));
      for (const lineId of removedLines) {
        const codes = u.fixtures.filter((f) => f.lineIds.indexOf(lineId) >= 0).map((f) => f.code);
        if (codes.length) await DB.removeFixtureLinesByBatch({ codes, lineId });
      }
      // ② 回收本次新建的线体（此时若无任何夹具引用即删除）
      await reloadAll();
      for (const lid of u.createdLineIds) {
        const used = (state.fixtures || []).some((f) => Array.isArray(f.lines) && f.lines.map(Number).indexOf(Number(lid)) >= 0);
        if (!used) { try { await DB.lineDel(lid); } catch (e) { /* 忽略 */ } }
      }
      closeModal();
      await reloadAll();
      if (state.view === 'linecfg') await renderLineConfig();
      else if (state.view === 'linequery') await renderLineQuery();
      else if (state.view === 'fixtures') renderFixtures();
      toast('已撤销本次导入', 'ok');
    } catch (e) {
      toast('撤销失败：' + (e && e.message ? e.message : e), 'err');
    }
  };

  /* 产线配置导入入口：弹系统文件框 → 读取 → 解析 → 预览 → 确认 */
  window.lineCfgImport = async function () {
    const api = window.api;
    if (!api || typeof api.pickSpreadsheet !== 'function') {
      toast('当前环境不支持文件选择，请用 CSV 方式导入', 'err');
      return;
    }
    // 先刷新现有配置，避免用过期快照判断「是否需要新建」
    try { await reloadLineConfig(); } catch (e) { /* 读不到就按空库处理 */ }
    let picked;
    try { picked = await api.pickSpreadsheet(); }
    catch (e) { toast('读取文件失败：' + (e && e.message ? e.message : e), 'err'); return; }
    if (!picked || picked.ok === false) {
      if (picked && picked.error) toast('读取失败：' + picked.error, 'err');
      return;
    }
    let rows = null;
    try {
      if (picked.kind === 'csv') {
        rows = parseCSV(picked.text);
      } else {
        const r = await api.readSpreadsheet(picked.bytes);
        if (!r || !r.ok) { toast('解析 Excel 失败：' + ((r && r.error) || '未知错误'), 'err'); return; }
        if (r.sheetNames && r.sheetNames.length > 1) {
          toast(`「${picked.name}」含 ${r.sheetNames.length} 张工作表，默认读取第 1 张（${r.sheetName}）`, 'warn');
        }
        rows = r.rows;
      }
    } catch (e) { toast('解析失败：' + (e && e.message ? e.message : e), 'err'); return; }

    const plan = buildLineImportPlan(rows, { lines: state.lines, fixtures: state.fixtures });
    if (!plan.ok) { toast(plan.error, 'err'); return; }
    window.showLineImportPreview(plan, picked.name);
  };

  /* 下载产线配置导入模板
   * 语义：一行 = 「把某套夹具关联到某条产线」（追加式） */
  window.downloadLineTemplate = function () {
    const sample = [
      ['L1 总装线', '直线形', 'DH40MC-921-001-001', '夹具编号填夹具编号'],
      ['L1 总装线', '直线形', 'XXK-D10VG-002', ''],
      ['L2 U型线', 'U型', 'XXK-D10VG-002', '同一套夹具再关联到另一条产线']
    ];
    const lines = [LINE_IMPORT_HEADERS.join(','), ...sample.map((r) => r.map((v) => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','))];
    download('产线配置导入模板.csv', '\ufeff' + lines.join('\r\n'));
    toast('模板已下载，填好后用「⬆ 导入Excel/CSV」导入', 'ok');
  };

  /* ============================================================
   * CSV 解析（与备件系统同款，支持 BOM / 引号 / 换行）
   * ============================================================ */
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    const rows = []; let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\r') { /* skip */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  /* ============================================================
   * CSV 下载
   * ============================================================ */
  function download(filename, content) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  /* ============================================================
   * 初始化
   * ============================================================ */

  /* 全局键盘：Esc 关闭模态；出库 / 回库表单内回车直接提交（扫描枪作业习惯）。
   * 用具名函数注册，便于页面卸载时移除，避免 Electron 窗口重载后重复绑定。 */
  function handleKeyDown(e) {
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key !== 'Enter') return;
    const id = (e.target && e.target.id) || '';
    /* 刷卡框的回车由 bindSwipe 自己处理（识别卡号 + 跳到另一位）；
       这里再兜一层：只要带 data-swipe 就绝不触发提交。 */
    if (e.target && e.target.dataset && e.target.dataset.swipe) return;
    if (/^out_/.test(id)) { e.preventDefault(); submitOutDo(); }
    else if (/^return_/.test(id)) { e.preventDefault(); submitReturnDo(); }
  }

  async function init() {
    try {
      await DB.open();
      await reloadAll();
    } catch (e) {
      $('#content').innerHTML = `<div class="panel">
        <div class="panel-title" style="color:var(--danger)">无法启动</div>
        <p>${esc(e.message)}</p>
      </div>`;
      return;
    }
    $$('.nav-item').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalOverlay').addEventListener('click', (e) => { if (e.target === $('#modalOverlay')) closeModal(); });
    document.addEventListener('keydown', handleKeyDown);
    showView('dashboard');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 页面卸载时清理 keydown 监听，避免 Electron 窗口重载后重复绑定导致 Enter 多次提交
  window.addEventListener('beforeunload', () => {
    document.removeEventListener('keydown', handleKeyDown);
  });
})();
