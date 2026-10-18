/* ============================================================
 * app.js — 工装夹具管理程序主逻辑（v4.0.6）
 *
 * v4.0.0 数据模型要点（详见工作区根《夹具管理系统_五项决策实施方案.md》）：
 *   · 追踪单元 = 每套一条 fixtures 记录；数量是派生值，不落库
 *   · code        4 位纯数字，唯一、自动分配，是各环节的「桥梁」+ 二维码内容，不参与模糊搜索
 *   · serialNo    实物夹具编号，手动输入、可重复（同机种多套共用一个编号），主搜索键
 *   · lines[]     涉及的产线 id（≥1、≤5）；单条产线允许 0 工位
 *   · stations[]  安装的工位 id（≥1、≤10）；必须 ⊆ ∪(lines 各自的工位集合)
 *   · 出库只改 status（location 冻结保留）；回库预填原库位、允许改（改则写回 location）
 * ============================================================ */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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
  const MAX_LINE_MODELS = 7;    // 一件夹具最多关联机种数（原 4）
  const MAX_LINES = 5;          // 一件夹具最多涉及产线数
  const MAX_STATIONS = 10;      // 一件夹具最多安装工位数
  const MAX_SERIAL_NO = 64;
  const MAX_LOCATION = 20;
  const LOCATION_RE = /^[A-Za-z0-9]+(-[A-Za-z0-9]+){3}$/;
  const MAX_PROD_NAME = 30;
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
  function lineModelsMatch(f, q) {
    const arr = Array.isArray(f.lineModels) ? f.lineModels : [];
    return arr.some((lm) => String(lm).toLowerCase().includes(q));
  }
  /* 一件夹具关联的机种数（去重后） */
  function lineModelCount(f) {
    return (Array.isArray(f.lineModels) ? f.lineModels : []).filter((x) => String(x).trim() !== '').length;
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
  /* 工位名列表：fixtures.stations([stationId]) → stations.name（跨产线重名时补产线前缀） */
  function stationNamesOf(f) {
    const ids = Array.isArray(f && f.stations) ? f.stations.map(Number) : [];
    return ids.map((id) => state.stations.find((s) => s.id === id)).filter(Boolean);
  }
  function stationNamesLabel(f, emptyMark = '—') {
    const sts = stationNamesOf(f);
    if (!sts.length) return emptyMark;
    const dup = (name) => state.stations.filter((s) => s.name === name).length > 1;
    const labelOf = (s) => {
      if (!dup(s.name)) return s.name;
      const ln = (state.lines.find((l) => l.id === s.lineId) || {}).name || '';
      return ln ? ln + '·' + s.name : s.name;
    };
    return sts.map(labelOf).join(' / ');
  }
  /* 「产线 / 工位」合并显示（v4.0.2）：按工位所属产线分组，
   * 同一产线的工位收进一段，段内用 / 连接，段间用 ；连接。
   *   单产线单工位  → 1 号线 · 4号工位
   *   单产线多工位  → 1 号线 · 4号工位 / 7号工位
   *   跨产线        → 1 号线 · 4号工位；2 号线 · 1号工位
   * 产线名已在行内出现，故这里不再给工位名补「线号·」前缀（避免重复）。 */
  function lineStationPairsOf(f) {
    const sts = stationNamesOf(f);
    if (!sts.length) return [];
    const order = Array.isArray(f && f.lines) ? f.lines.map(Number) : [];
    const groups = new Map();
    sts.forEach((s) => {
      const lid = Number(s.lineId);
      if (!groups.has(lid)) groups.set(lid, []);
      groups.get(lid).push(s.name || '');
    });
    const rank = (lid) => { const i = order.indexOf(lid); return i < 0 ? 9999 : i; };
    return Array.from(groups.keys()).sort((a, b) => rank(a) - rank(b)).map((lid) => ({
      line: (state.lines.find((l) => l.id === lid) || {}).name || '',
      stations: groups.get(lid)
    }));
  }
  function lineStationLabel(f, emptyMark = '—') {
    const pairs = lineStationPairsOf(f);
    if (!pairs.length) return emptyMark;
    return pairs.map((p) => {
      const st = p.stations.join(' / ');
      return p.line ? p.line + ' · ' + st : st;
    }).join('；');
  }
  /* 某产线下已选的工位（用于扇区头部「已选 N 个工位」与撤销确认） */
  function stationsOfLineInForm(lineId, stationIds) {
    const set = new Set((stationIds || []).map(Number));
    return state.stations.filter((s) => s.lineId === Number(lineId) && set.has(s.id));
  }
  /* 产线/工位 id 是否越界（校验规则 5）：stations 必须 ⊆ ∪(lines 各自工位集合) */
  function outOfScopeStations(lineIds, stationIds) {
    const allow = new Set();
    (lineIds || []).forEach((lid) => {
      state.stations.filter((s) => s.lineId === Number(lid)).forEach((s) => allow.add(s.id));
    });
    return (stationIds || []).map(Number).filter((sid) => !allow.has(sid));
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

  /* 出库/回库页第一栏（扫码枪）：桥梁编号精确命中 + 夹具编号模糊命中 */
  function matchCodeField(f, q) {
    if (!q) return true;
    if (DB.codeEq ? DB.codeEq(f.code, q) : String(f.code) === String(q)) return true;
    return String(f.serialNo || '').toLowerCase().includes(String(q).toLowerCase());
  }

  /* 统一夹具检索谓词：serialNo/名称/库位/机种/分类/产线/工位 模糊；
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
    if (stationNamesOf(f).some((n) => n.name.toLowerCase().includes(s))) return true;
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
    outAvailable: 0,        // 出库页：当前检索结果中的可出库台数（数量上限）
    returnAvailable: 0,     // 回库页：当前检索结果中的可回库台数（数量上限）
    outSelectedId: 0,       // 出库页当前选中的夹具（0 = 未选）
    returnSelectedId: 0,    // 回库页当前选中的夹具（0 = 未选）
    // 出库/回库页的常驻录入项：切换选项或提交后仍保留，便于连续作业
    outForm: { operator: '', counterparty: '', remark: '', time: '' },
    returnForm: { operator: '', remark: '', time: '' },
    // 夹具查询：筛选/排序状态（切换视图后保留，便于连续检索）
    query: { keyword: '', code: '', name: '', location: '', lineModel: '', borrower: '', statuses: [], sortBy: 'code', sortDir: 'asc', outReason: '' },
    serialQuery: '',          // 夹具查询页：按夹具编号聚合（数量与合计）的输入值
    // 关联配置数据（v4.0.0）
    lines: [],
    stations: [],
    productions: [],
    lineCfg: { lineId: 0 },                          // 产线配置页：当前选中的线体
    lineQuery: { lineId: 0, lineModel: '' },                    // 产线使用页：当前选中的线体 + 机种（为空=全部）
    prodQuery: { name: '' },                         // 按机种查询页：当前选中的机种
    // 建档 / 编辑夹具表单的暂存（产线工位选择用，退出表单即清空）
    fixForm: { editId: 0, lineModels: [], lines: [], stations: [] }
  };

  /* ---------------- 数据加载 ---------------- */
  async function reloadAll() {
    state.fixtures = await DB.fixtureGetAll();
    state.fixTransactions = await DB.fixtureGetTransactions();
  }

  /* 产线配置数据加载（独立于夹具数据，按需刷新） */
  async function reloadLineConfig() {
    state.lines = await DB.getAll('lines');
    state.stations = await DB.getAll('stations');
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
    prodquery: '按机种查询',
    linequery: '产线使用',
    linecfg: '产线配置',
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
    prodquery: renderProdQuery,
    linequery: renderLineQuery,
    linecfg: renderLineConfig,
    data: renderData
  };

  function showView(name) {
    state.view = name;
    $('#viewTitle').textContent = VIEW_TITLES[name] || '';
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $('#content').scrollTop = 0;
    renderTopStats();
    (RENDERERS[name] || renderDashboard)();
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
    // 仪表盘要展示机种/产线/工位数量，需按需补拉一次结构数据
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
          <div class="stat-item"><span class="stat-label">工位</span><span class="stat-value">${(state.stations || []).length}</span></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">🧮 数据模型说明（v4.0.0）</div>
        <div style="padding:16px; line-height:2;">
          <p>📦 <b>一套一条记录</b>：同一夹具编号可以有多套，分布在不同库位；<b>数量不存储</b>，一律按「夹具编号 + 库位」分组实时统计。</p>
          <p>🔗 <b>序号</b>：系统自动分配的 4 位数字，唯一标识每一套，也是二维码内容；<b>不参与模糊搜索</b>。</p>
          <p>📝 <b>夹具编号</b>：手工录入、允许重复（同机种多套共用），是日常检索的主键。</p>
          <p>🏭 <b>产线与工位</b>：在夹具建档时选择（1~5 条产线、1~10 个工位）；机种是独立字典，<b>不隶属产线</b>。</p>
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
      <div class="form-group"><label>经办人</label><input type="text" id="fix_out_op" placeholder="经办人（拼音联想）"></div>
      <div class="form-group"><label>领用人</label><input type="text" id="fix_out_party" placeholder="领用人/使用部门"></div>
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
  };

  window.submitFixtureOut = async function (id) {
    const operator = ($('#fix_out_op') || {}).value.trim();
    const counterparty = ($('#fix_out_party') || {}).value.trim();
    const time = inputToMs($('#fix_out_time').value);
    const remark = ($('#fix_out_remark') || {}).value.trim();
    const locEl = $('#fix_out_loc');
    const location = locEl ? locEl.value.trim() : '';
    const reasonEl = $('#fix_out_reason');
    const outReason = reasonEl && reasonEl.value === 'repair' ? 'repair' : 'use';
    if (!operator) { toast('请填写经办人', 'err'); return; }
    if (locEl && !isValidLocation(location)) { toast('库位号需为 4 段式（如 ZP1-U-1-1）', 'err'); return; }
    try {
      await DB.fixtureAddTransaction({ fixtureId: id, type: 'out', operator, counterparty, time, remark, location: location || undefined, outReason });
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
   *         ② 机种名称（≤7，输入框 +「添加」→ 标签区，多个用 / 分隔）
   *         ③ 产线工位（产线/工位两级下拉 +「添加」→ 标签区；≥1 产线 ≥1 工位，≤5 产线 ≤10 工位）
   *
   * ⚠️ 表单内的「产线 / 工位 / 机种」暂存在 state.fixForm，重绘只重写
   *    #fix_ls_box / #fix_lm_chips 两个容器，其余输入框不受影响（不丢已填内容）。
   * ⚠️ 桥梁编号 code 由系统自动分配（4 位纯数字），用户不可填、编辑时不可改。
   * ============================================================ */
  function resetFixForm() {
    state.fixForm = { editId: 0, lineModels: [], lines: [], stations: [] };
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

  /* ---- 产线工位：两级下拉（产线 / 工位）+「添加」→ 下方标签区 ----
   * 为节省表单纵向空间，不再为每条产线铺开整片工位复选框，改为：
   *   [选择产线 ▾] [选择工位 ▾] [+ 添加]      已选 1/5 条产线 · 1/10 个工位
   *   1号线 · 4号工位 ×    1号线 · 7号工位 ×
   * 工位下拉只列「当前产线中尚未选入」的工位；添加后保留产线选择，便于连续
   * 加入同产线的多个工位。标签区（state.fixForm.stations）是唯一数据源，
   * lines 由其派生（有工位才有产线），移除某产线最后一个工位即连带移除该产线。 */
  let lsPick = { lineId: 0 };   // 工具区「选择产线」的当前选择（工位选择不做记忆）
  let lsHintMsg = { text: '', warn: false };   // 提示文案（随重绘一起输出，避免被 innerHTML 冲掉）

  function lsResetPick() { lsPick = { lineId: 0 }; lsHintMsg = { text: '', warn: false }; }

  /* 工位 → 所属产线 id（找不到按 0） */
  function lsLineOfStation(sid) {
    const s = state.stations.find((x) => x.id === Number(sid));
    return s ? Number(s.lineId) : 0;
  }

  /* 由工位集合派生关联产线（去重、保序） */
  function lsLinesOfStations(sids) {
    const out = [];
    (sids || []).forEach((sid) => {
      const lid = lsLineOfStation(sid);
      if (lid && !out.includes(lid)) out.push(lid);
    });
    return out;
  }

  /* 某产线在表单中已选的工位 id 列表 */
  function lsChosenOfLine(lid) {
    return stationsOfLineInForm(lid, state.fixForm.stations).map((s) => Number(s.id));
  }

  /* 工位显示名：未填名称时退化为「工位 + 顺序号/id」 */
  function lsStationLabel(s) {
    const nm = String((s && s.name) || '').trim();
    if (nm) return nm;
    const seq = (s && s.seq != null && s.seq !== '') ? s.seq : (s ? s.id : '');
    return '工位 ' + seq;
  }

  /* 取工位名称里的工位号（"X号工位" 的 X）用于下拉排序：
   * 让下拉按用户可识别的 1、2、3… 顺序呈现，而不是按内部 seq。
   * 名称里没有数字时回退 seq，再回退 id，保证总有可比值（无数字的排末尾）。 */
  function lsStNameNum(s) {
    const nm = String((s && s.name) || '');
    const m = nm.match(/(\d+)/);
    if (m) return parseInt(m[1], 10);
    const sq = (s && s.seq != null && s.seq !== '') ? Number(s.seq) : null;
    if (sq != null && Number.isFinite(sq)) return sq;
    return s ? Number(s.id) : Infinity;
  }

  /* 提示只记录到 lsHintMsg，由 renderLineSectors 随重绘一起输出 */
  function lsHint(msg, warn) { lsHintMsg = { text: msg || '', warn: !!warn }; }

  /* 产线下拉：已关联的产线恒列出；未达产线上限时附上其余产线 */
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

  /* 工位下拉：只列「当前产线」中尚未选入的工位 */
  function lsStOptions() {
    const lid = Number(lsPick.lineId);
    if (!lid || !(state.lines || []).some((l) => Number(l.id) === lid)) {
      return '<option value="">— 请先选择产线 —</option>';
    }
    const all = (state.stations || [])
      .filter((s) => Number(s.lineId) === lid)
      .slice()
      .sort((a, b) => {
        const na = lsStNameNum(a), nb = lsStNameNum(b);
        if (na !== nb) return na - nb;
        return natCompare((a && a.name) || '', (b && b.name) || '');
      });
    if (!all.length) return '<option value="">— 该产线尚未配置工位 —</option>';
    const chosen = new Set(lsChosenOfLine(lid));
    const rest = all.filter((s) => !chosen.has(Number(s.id)));
    if (!rest.length) return '<option value="">— 该产线工位已全部选入 —</option>';
    return ['<option value="">— 选择工位 —</option>']
      .concat(rest.map((s) => `<option value="${s.id}">${esc(lsStationLabel(s))}</option>`)).join('');
  }

  /* 「+ 添加」按钮可用态：产线/工位都已选，且未触及产线/工位上限 */
  function syncLsAddBtn() {
    const btn = $('#fix_ls_addbtn');
    if (!btn) return;
    const lp = $('#fix_line_pick');
    const sp = $('#fix_st_pick');
    const lid = lp && lp.value ? Number(lp.value) : 0;
    const sid = sp && sp.value ? Number(sp.value) : 0;
    const fullSts = state.fixForm.stations.length >= MAX_STATIONS;
    const newLine = !!lid && !state.fixForm.lines.map(Number).includes(lid);
    const fullLines = newLine && state.fixForm.lines.length >= MAX_LINES;
    btn.disabled = !(lid && sid) || fullSts || fullLines;
    btn.title = fullSts ? ('已达工位上限（' + MAX_STATIONS + ' 个）')
      : (fullLines ? ('已达产线上限（' + MAX_LINES + ' 条）')
        : (!sid ? '请先选择工位' : '加入下方标签区'));
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
    const selSts = state.fixForm.stations.map(Number);
    const fullLines = selLines.length >= MAX_LINES;
    const fullSts = selSts.length >= MAX_STATIONS;

    const chips = selSts.length
      ? selSts.map((sid, i) => {
        const s = state.stations.find((x) => x.id === sid);
        if (!s) return '';
        const l = (state.lines || []).find((x) => Number(x.id) === Number(s.lineId));
        return `<span class="chip-tag chip-ls">${l ? '<b>' + esc(l.name) + '</b> · ' : ''}${esc(lsStationLabel(s))}`
          + `<button type="button" class="chip-x" title="移除" onclick="fixFormRemoveStation(${i})">×</button></span>`;
      }).join('')
      : '<span class="chip-ls-empty muted">尚未选择工位</span>';

    box.innerHTML = `
      <div class="ls-toolbar">
        <select id="fix_line_pick" class="query-select" onchange="fixFormLinePicked()">${lsLineOptions()}</select>
        <select id="fix_st_pick" class="query-select" onchange="fixFormStationPicked()"${lsPick.lineId ? '' : ' disabled'}>${lsStOptions()}</select>
        <button type="button" class="btn sm" id="fix_ls_addbtn" onclick="fixFormAddStation()" disabled>+ 添加</button>
        <span class="muted" id="fix_ls_count">已选 ${selLines.length} / ${MAX_LINES} 条产线 · ${selSts.length} / ${MAX_STATIONS} 个工位</span>
      </div>
      <div id="fix_ls_chips" class="chip-box${selSts.length ? '' : ' chip-box-empty'}">${chips}</div>
      <small class="hint${lsHintMsg.text && lsHintMsg.warn ? ' hint-warn' : ''}" id="fix_ls_hint">${esc(lsHintMsg.text)}</small>
      ${fullSts ? '<div class="tip">已达工位上限（' + MAX_STATIONS + ' 个）。</div>' : ''}
      ${fullLines ? '<div class="tip">已达产线上限（' + MAX_LINES + ' 条）。</div>' : ''}`;

    syncLsAddBtn();
  }

  /* 选了产线 → 重算工位下拉 */
  window.fixFormLinePicked = function () {
    const sel = $('#fix_line_pick');
    lsPick.lineId = sel && sel.value ? Number(sel.value) : 0;
    lsHint('', false);
    renderLineSectors();
  };

  /* 选了工位 → 只刷新「+ 添加」可用态（不重绘，保住下拉选择） */
  window.fixFormStationPicked = function () { syncLsAddBtn(); };

  /* 添加：把「产线 + 工位」并入标签区；保留产线选择，便于连续添加工位 */
  window.fixFormAddStation = function () {
    const lp = $('#fix_line_pick');
    const sp = $('#fix_st_pick');
    const lid = lp && lp.value ? Number(lp.value) : 0;
    const sid = sp && sp.value ? Number(sp.value) : 0;
    if (!lid) { lsHint('请先选择产线', true); return; }
    if (!sid) { lsHint('请选择要加入的工位', true); return; }
    const s = state.stations.find((x) => x.id === sid);
    if (!s || Number(s.lineId) !== lid) { lsHint('该工位不属于所选产线，请重新选择', true); renderLineSectors(); return; }
    if (state.fixForm.stations.map(Number).includes(sid)) { lsHint('该工位已在下方标签区中', true); renderLineSectors(); return; }
    if (state.fixForm.stations.length >= MAX_STATIONS) { lsHint('一件夹具最多安装 ' + MAX_STATIONS + ' 个工位', true); renderLineSectors(); return; }
    if (!state.fixForm.lines.map(Number).includes(lid) && state.fixForm.lines.length >= MAX_LINES) {
      lsHint('一件夹具最多关联 ' + MAX_LINES + ' 条产线', true); renderLineSectors(); return;
    }
    state.fixForm.stations.push(sid);
    if (!state.fixForm.lines.map(Number).includes(lid)) state.fixForm.lines.push(lid);
    lsHint('', false);
    renderLineSectors();
  };

  /* 移除一个工位标签；该产线已无工位时连带移除产线（规则 7 的新形态） */
  window.fixFormRemoveStation = function (i) {
    const idx = Number(i);
    if (!(idx >= 0 && idx < state.fixForm.stations.length)) return;
    const sid = Number(state.fixForm.stations[idx]);
    const lid = lsLineOfStation(sid);
    state.fixForm.stations.splice(idx, 1);
    if (lid && !lsChosenOfLine(lid).length) {
      state.fixForm.lines = state.fixForm.lines.map(Number).filter((x) => x !== lid);
      if (Number(lsPick.lineId) === lid) lsPick.lineId = 0;
      toast('已移除该产线下的最后一个工位，产线一并移除', 'warn');
    }
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
      const allow = new Set(state.fixForm.lines.flatMap((lid) => state.stations.filter((s) => s.lineId === lid).map((s) => s.id)));
      state.fixForm.stations = (Array.isArray(f.stations) ? f.stations : []).map(Number).filter((sid) => allow.has(sid));
      /* 表单内 lines 与工位保持一致（新 UI 下产线由工位派生，避免出现「看不见的空产线」） */
      state.fixForm.lines = lsLinesOfStations(state.fixForm.stations);
    }
    /* 默认把「选择产线」停在第一条已关联产线，便于继续增补同线工位 */
    const pickedLines = lsLinesOfStations(state.fixForm.stations);
    lsPick.lineId = pickedLines.length ? pickedLines[0] : 0;
    const locList = locationCandidates().map((v) => `<option value="${esc(v)}"></option>`).join('');
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
        <input type="text" id="fix_cat" placeholder="分类（如 冲压/焊接/装配）" value="${esc(f ? f.category || '' : '')}"></div>
      <div class="form-group form-group-row"><label>产线工位 <span class="req">*</span>（≥1 产线 ≥1 工位 · ≤${MAX_LINES} 产线 ≤${MAX_STATIONS} 工位）</label>
        <div id="fix_ls_box" class="ls-box"></div>
        <small class="hint">先选产线，再选该产线下的工位，点「+ 添加」加入；同一产线可连续添加多个工位。</small></div>
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
    const stations = state.fixForm.stations.map(Number);

    if (!isValidSerialNo(serialNo)) { toast('请填写夹具编号（≤' + MAX_SERIAL_NO + ' 字符，不能含 | 或换行）', 'err'); return; }
    if (!name) { toast('请填写夹具名称', 'err'); return; }
    if (!lineModels.length) { toast('请至少选择 1 个机种名称', 'err'); return; }
    if (lineModels.length > MAX_LINE_MODELS) { toast('机种名称最多 ' + MAX_LINE_MODELS + ' 个', 'err'); return; }
    if (!lines.length) { toast('请至少选择 1 条产线', 'err'); return; }
    if (!stations.length) { toast('请至少选择 1 个工位', 'err'); return; }
    if (lines.length > MAX_LINES) { toast('一件夹具最多关联 ' + MAX_LINES + ' 条产线', 'err'); return; }
    if (stations.length > MAX_STATIONS) { toast('一件夹具最多安装 ' + MAX_STATIONS + ' 个工位', 'err'); return; }
    const outScope = outOfScopeStations(lines, stations);
    if (outScope.length) {
      const names = outScope.map((sid) => (state.stations.find((s) => s.id === sid) || {}).name || ('#' + sid));
      toast('以下工位不属于已选产线：' + names.join('、'), 'err');
      return;
    }
    if (!isValidLocation(location)) { toast('库位号需为 4 段式（如 ZP1-U-1-1），且不超过 ' + MAX_LOCATION + ' 字符', 'err'); return; }

    try {
      if (editId) {
        await DB.fixtureUpdate({ id: editId, serialNo, name, location, category, remark, lineModels, lines, stations });
      } else {
        await DB.fixtureAdd({ serialNo, name, location, category, remark, lineModels, lines, stations });
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
    const filtered = q ? state.fixtures.filter((f) => matchFixture(f, q)) : state.fixtures;
    renderFixtureArea(list, filtered, state.fixSelectedId || 0);
  };

  window.fixtureExportCSV = function () {
    const headers = ['序号', '夹具编号', '名称', '机种名称', '分类', '库位', '产线', '工位', '状态', '累计出库', '累计回库', '维修次数', '备注'];
    const rows = state.fixtures.map((f) => [
      f.code, f.serialNo || '', f.name,
      (Array.isArray(f.lineModels) ? f.lineModels : []).join(' / '),
      f.category || '', f.location || '',
      lineNamesLabel(f, ''), stationNamesLabel(f, ''),
      (FIX_STATUS[f.status] || { label: f.status }).label,
      f.totalOutCount || 0, f.totalReturnCount || 0, f.repairCount || 0, f.remark || ''
    ]);
    const csv = '﻿' + [headers.join(','), ...rows.map((r) => r.map((v) => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','))].join('\r\n');
    download('夹具清单_' + new Date().toISOString().slice(0, 10) + '.csv', csv);
  };

  /* ============================================================
   * 夹具批量导入（Excel .xlsx / CSV）
   *
   * 设计要点（v4.0.0）：
   *   - 桥梁编号 code 不由表格提供，一律由系统自动分配（1001 起顺延填补空洞）
   *   - 实物编号 serialNo 为必填，允许重复（同机种多套）
   *   - 产线 / 工位按「名称」引用；若未建档则**导入时自动补建**（同名复用，不重复创建），
   *     不再因产线/工位未建档而整行跳过，确保符合其它条件的表格可正常导入
   *   - 机种名称支持 1~7 独立列，也可只给一列「机种名称」用分隔符写多个
   *   - 预览确认后才落库，避免误导入
   * ============================================================ */
  const FIX_IMPORT_HEADERS = [
    '夹具编号', '名称', '机种名称1', '机种名称2', '机种名称3', '机种名称4', '机种名称5', '机种名称6', '机种名称7',
    '分类', '库位', '产线', '工位', '备注'
  ];

  // 表头别名 → 字段名。键为归一化后的表头（去空格/全角括号内容/标点）
  const FIX_IMPORT_ALIAS = {
    '实物编号': 'serialNo', '夹具编号': 'serialNo', '实物夹具编号': 'serialNo', '资产编号': 'serialNo', 'serialno': 'serialNo',
    '名称': 'name', '夹具名称': 'name', '品名': 'name', 'name': 'name',
    '机种名称1': 'lm1', '机种1': 'lm1', '机种名称一': 'lm1', '机型1': 'lm1',
    '机种名称2': 'lm2', '机种2': 'lm2', '机种名称二': 'lm2', '机型2': 'lm2',
    '机种名称3': 'lm3', '机种3': 'lm3', '机种名称三': 'lm3', '机型3': 'lm3',
    '机种名称4': 'lm4', '机种4': 'lm4', '机种名称四': 'lm4', '机型4': 'lm4',
    '机种名称5': 'lm5', '机种5': 'lm5', '机种名称五': 'lm5', '机型5': 'lm5',
    '机种名称6': 'lm6', '机种6': 'lm6', '机种名称六': 'lm6', '机型6': 'lm6',
    '机种名称7': 'lm7', '机种7': 'lm7', '机种名称七': 'lm7', '机型7': 'lm7',
    '机种名称': 'lms', '机种': 'lms', '适用机种': 'lms', '机型': 'lms',
    '分类': 'category', '类别': 'category', 'category': 'category',
    '库位': 'location', '库位号': 'location', '存放位置': 'location', '位置': 'location', '货位': 'location', 'location': 'location',
    '产线': 'lines', '线体': 'lines', '产线名称': 'lines', '线体名称': 'lines',
    '工位': 'stations', '工位名称': 'stations', '工位号': 'stations',
    '备注': 'remark', '备注或用途': 'remark', '说明': 'remark', 'remark': 'remark'
  };

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

  const IMPORT_LM_KEYS = ['lm1', 'lm2', 'lm3', 'lm4', 'lm5', 'lm6', 'lm7', 'lms'];

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

    return {
      ok: true,
      fixture: {
        serialNo,
        name,
        lineModels: lms,
        category: get('category'),
        location,
        remark: get('remark'),
        lineNames: splitNames(get('lines')),
        stationNames: splitNames(get('stations'))
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

  /* 把二维数组解析为待导入列表。
   * ctx = { fixtures, lines, stations }，用于编号占用判断与产线/工位名称反查。
   * 返回 { ok, plan:[{row,fixture,dupHint}], skipped:[{row,reason}], hasSerialColumn, hasLineColumn, hasStationColumn } */
  function buildImportPlan(rows, ctx) {
    if (!rows || rows.length < 2) return { ok: false, error: '文件中没有数据行' };
    const c = ctx || { fixtures: state.fixtures, lines: state.lines, stations: state.stations };
    const idx = mapImportHeader(rows[0]);
    if (idx.name == null) {
      return { ok: false, error: '模板缺少「名称」列（表头需含：夹具编号 / 名称 / 机种名称 / 库位 / 产线 / 工位）' };
    }
    if (idx.serialNo == null) return { ok: false, error: '模板缺少「夹具编号」列' };
    if (idx.location == null) return { ok: false, error: '模板缺少「库位」列' };
    if (idx.lines == null) return { ok: false, error: '模板缺少「产线」列（建档要求至少 1 条产线）' };
    if (idx.stations == null) return { ok: false, error: '模板缺少「工位」列（建档要求至少 1 个工位）' };

    const linesByName = new Map((c.lines || []).map((l) => [l.name, l]));
    const lineIdToName = new Map((c.lines || []).map((l) => [l.id, l.name]));
    // 工位键 = 产线名 + \u0000 + 工位名（工位从属于产线）
    const stationByKey = new Map();
    (c.stations || []).forEach((s) => {
      stationByKey.set((lineIdToName.get(s.lineId) || '') + '\u0000' + s.name, s);
    });
    // 待自动补建的产线 / 工位（同名只登记一次，落库时复用）
    const autoLines = new Map();      // lineName -> true
    const autoStations = new Map();   // lineName\u0000stationName -> { lineName, name }

    const plan = [];
    const skipped = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row.some((x) => String(x == null ? '' : x).trim() !== '')) continue; // 全空行
      const parsed = parseImportRow(row, idx);
      if (!parsed.ok) { skipped.push({ row: r + 1, reason: parsed.reason }); continue; }
      const f = parsed.fixture;

      // 产线 / 工位按名称引用：未建档的记入「待自动补建」，不再整行跳过
      if (!f.lineNames.length) { skipped.push({ row: r + 1, reason: '产线为空' }); continue; }
      if (f.lineNames.length > MAX_LINES) { skipped.push({ row: r + 1, reason: '产线超过 ' + MAX_LINES + ' 条' }); continue; }
      if (!f.stationNames.length) { skipped.push({ row: r + 1, reason: '工位为空' }); continue; }
      if (f.stationNames.length > MAX_STATIONS) { skipped.push({ row: r + 1, reason: '工位超过 ' + MAX_STATIONS + ' 个' }); continue; }

      // 登记需要新建的产线（同名只建一次）
      f.lineNames.forEach((n) => { if (!linesByName.has(n) && !autoLines.has(n)) autoLines.set(n, true); });
      // 登记需要新建的工位：每个 产线 × 工位 组合独立判定是否已存在
      f.lineNames.forEach((ln) => {
        f.stationNames.forEach((sn) => {
          const key = ln + '\u0000' + sn;
          if (!stationByKey.has(key) && !autoStations.has(key)) autoStations.set(key, { lineName: ln, name: sn });
        });
      });

      /* 重号提示：夹具编号允许重复（v4「每套一条记录」），但要告知现有持有量。
         ⚠️ v4 重构时该字段曾丢失，导入预览不再提示重号，此处补齐。 */
      const sameNo = (c.fixtures || []).filter((x) => x.serialNo === f.serialNo);
      const inBatch = plan.filter((p) => p.fixture.serialNo === f.serialNo).length;
      const dupTotal = sameNo.length + inBatch;
      const dupInStock = sameNo.filter((x) => (x.status || 'stocked') === 'stocked').length;
      const dupHint = dupTotal
        ? `该编号已有 ${dupTotal} 套（在库 ${dupInStock} 套，在外 ${dupTotal - dupInStock} 套）`
        : '';

      plan.push({
        row: r + 1,
        fixture: {
          serialNo: f.serialNo, name: f.name, lineModels: f.lineModels,
          category: f.category, location: f.location, remark: f.remark,
          lineNames: f.lineNames,
          stationNames: f.stationNames
        },
        dupHint
      });
    }
    // 把「待自动补建」清单挂在 plan 上，供预览展示与落库时使用
    plan._autoLines = Array.from(autoLines.keys());
    plan._autoStations = Array.from(autoStations.values());
    // 每行逐条记录缺少的产线 / 工位（供跳过 / 新建对话框使用）
    plan._missing = plan.map((p) => {
      const missing = [];
      (p.fixture.lineNames || []).forEach((n) => {
        if (!linesByName.has(n)) {
          missing.push({ key: n, label: n, kind: 'line', type: 'new' });
        }
      });
      (p.fixture.lineNames || []).forEach((ln) => {
        (p.fixture.stationNames || []).forEach((sn) => {
          const key = ln + '\u0000' + sn;
          if (!stationByKey.has(key)) {
            const curLine = (c.lines || []).find((l) => l.name === ln);
            if (curLine) {
              missing.push({ key, label: sn, kind: 'station', type: 'old', lineId: curLine.id });
            } else {
              missing.push({ key, label: sn, kind: 'station', type: 'new', lineId: ln });
            }
          }
        });
      });
      return missing;
    });
    if (!plan.length) return { ok: false, error: '没有可导入的有效数据行' };
    return {
      ok: true, plan, skipped,
      hasSerialColumn: idx.serialNo != null,
      hasLineColumn: idx.lines != null,
      hasStationColumn: idx.stations != null
    };
  }

  /* 导入前弹窗：收集用户「新建」/「跳过」选择
   * 遍历 plan._missing 所有条目，逐行让用户决定。
   * 返回 Map<key, 'add'|'skip'>，供 confirmImportPlan 使用。
   * 全部跳过时返回 null。 */
  window.showModalMissingLineStation = function (plan) {
    const allMissing = plan._missing || [];
    if (!allMissing.length) return Promise.resolve(new Map());

    // 按产线归类（同名产线合并为一行）
    const lineGroups = new Map();  // displayLineName -> Array<{key,label,kind,type,lineId,idx}>
    allMissing.forEach((m) => {
      let displayLine;
      if (m.kind === 'line') {
        displayLine = m.key;
      } else {
        // station: lineId may be string (new line) or numeric id (old line)
        if (typeof m.lineId === 'string') {
          displayLine = m.lineId;
        } else {
          const l = (state.lines || []).find((l) => l.id === m.lineId);
          displayLine = l ? l.name : '未知';
        }
      }
      if (!lineGroups.has(displayLine)) lineGroups.set(displayLine, []);
      lineGroups.get(displayLine).push(m);
    });

    const tableRows = [];
    let rowIdx = 0;
    lineGroups.forEach((items, lineName) => {
      if (items[0].kind === 'line') {
        tableRows.push({ key: items[0].key, label: '【新建产线】' + esc(lineName), lineName, kind: 'line', type: 'new', idx: rowIdx++ });
      }
      items.forEach((m) => {
        if (m.kind === 'station') {
          tableRows.push({ key: m.key, label: lineName + ' · ' + esc(m.label), lineName, kind: 'station', type: m.type, lineId: m.lineId, idx: rowIdx++ });
        }
      });
    });

    const body = `
      <div class="tip" style="margin-bottom:10px;">
        检测到 <b>${allMissing.length}</b> 条未建档产线/工位。请选择每条目：<b>「新建」</b> 或 <b>「跳过该行」</b>（跳过 = 整行不导入）。</div>
      <div style="max-height:360px;overflow:auto;border:1px solid var(--border);border-radius:6px;">
        <table class="table" style="margin:0;">
          <thead><tr><th>编号</th><th>名称</th><th>操作</th></tr></thead>
          <tbody>
            ${tableRows.map((r) => `<tr>
              <td>${r.idx + 1}</td>
              <td>${r.label}</td>
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
    openModal('未建档产线/工位处理', body);
    // 返回 promise，收集选择结果
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
    const autoStations = Array.isArray(plan._autoStations) ? plan._autoStations : [];
    const body = `
      <div class="tip" style="margin-bottom:10px;">
        来源：<b>${esc(sourceName)}</b> ｜ 待导入 <b>${plan.length}</b> 条${skipped.length ? ` ｜ 跳过 <b>${skipped.length}</b> 条` : ''}${(autoLines.length || autoStations.length) ? ` ｜ 自动补建 <b>${autoLines.length}</b> 产线 / <b>${autoStations.length}</b> 工位` : ''}
      </div>
      <div style="max-height:360px;overflow:auto;border:1px solid var(--border);border-radius:6px;">
        <table class="table" style="margin:0;">
          <thead><tr><th>行号</th><th>夹具编号</th><th>名称</th><th>机种名称</th><th>库位</th><th>产线</th><th>工位</th></tr></thead>
          <tbody>
            ${rows.map((p) => `<tr>
              <td>${p.row}</td>
              <td>${esc(p.fixture.serialNo)}</td>
              <td>${esc(p.fixture.name)}</td>
              <td>${esc((p.fixture.lineModels || []).join(' / ') || '—')}</td>
              <td>${esc(p.fixture.location || '—')}</td>
              <td>${esc((p.fixture.lineNames || []).join(' / ') || '—')}</td>
              <td>${esc((p.fixture.stationNames || []).join(' / ') || '—')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${plan.length > rows.length ? `<p class="muted" style="margin:8px 0 0;">仅预览前 ${rows.length} 条，实际将导入全部 ${plan.length} 条。</p>` : ''}
      ${skipped.length ? `<div class="tip" style="margin-top:8px;">跳过 ${skipped.length} 行：${esc(skipped.slice(0, 10).map((s) => '第 ' + s.row + ' 行(' + s.reason + ')').join('、'))}${skipped.length > 10 ? ' 等' : ''}</div>` : ''}
      <p class="muted" style="margin:8px 0 0;">序号由系统自动分配；夹具编号允许重复。引用的产线 / 工位若未建档，将自动补建（同名复用，不重复创建）。</p>
      <div class="form-actions">
        <button class="btn primary" onclick="confirmImportPlan()">确认导入 ${plan.length} 条</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    window.__importPlan = plan;
    openModal('导入预览', body);
  };

  window.confirmImportPlan = async function () {
    const plan = window.__importPlan || [];
    if (!plan.length) { closeModal(); return; }
    let added = 0, failed = 0;

    // ① 先按导入计划补建缺失的产线 / 工位（同名复用，不重复创建）
    // 被用户选为 skip 的不再补建，直接跳过对应行
    const skippedKeys = new Set(plan._skipKeys || []);
    const lineIdByName = new Map((state.lines || []).map((l) => [l.name, l.id]));
    for (const name of (plan._autoLines || [])) {
      if (lineIdByName.has(name)) continue;
      const id = await DB.add('lines', { name, type: 'linear', remark: '导入自动建档', createdAt: Date.now() });
      lineIdByName.set(name, id);
    }
    const lineIdToName = new Map((state.lines || []).map((l) => [l.id, l.name]));
    lineIdByName.forEach((id, name) => lineIdToName.set(id, name));
    const stIdByKey = new Map();
    (state.stations || []).forEach((s) => stIdByKey.set((lineIdToName.get(s.lineId) || '') + '\u0000' + s.name, s.id));
    for (const s of (plan._autoStations || [])) {
      const lineId = lineIdByName.get(s.lineName);
      if (!lineId) continue;
      const key = s.lineName + '\u0000' + s.name;
      if (stIdByKey.has(key)) continue;
      const id = await DB.add('stations', { lineId, name: s.name, seq: null, remark: '导入自动建档', createdAt: Date.now() });
      stIdByKey.set(key, id);
    }

    // ② 逐行落库夹具，产线 / 工位引用用刚建好的 id 解析
    for (const p of plan) {
      try {
        const lineIds = [];
        p.fixture.lineNames.forEach((n) => {
          const id = lineIdByName.get(n);
          if (id != null && !lineIds.includes(id)) lineIds.push(id);
        });
        const stationIds = [];
        p.fixture.lineNames.forEach((ln) => {
          p.fixture.stationNames.forEach((sn) => {
            const id = stIdByKey.get(ln + '\u0000' + sn);
            if (id != null && !stationIds.includes(id)) stationIds.push(id);
          });
        });
        await DB.fixtureAdd({
          serialNo: p.fixture.serialNo,
          name: p.fixture.name,
          lineModels: p.fixture.lineModels,
          category: p.fixture.category,
          location: p.fixture.location,
          remark: p.fixture.remark,
          lines: lineIds,
          stations: stationIds
        });
        added++;
      } catch (err) {
        failed++;
        console.warn('导入失败行', p.row, err && err.message);
      }
    }
    window.__importPlan = null;
    closeModal();
    await reloadAll();
    renderFixtures();
    toast(failed ? `导入完成：成功 ${added} 条，失败 ${failed} 条` : `导入完成：新增 ${added} 条`, failed ? 'warn' : 'ok');
  };

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

    const result = buildImportPlan(rows, { fixtures: state.fixtures, lines: state.lines, stations: state.stations });
    if (!result.ok) { toast(result.error, 'err'); return; }

    // 先处理「产线 / 工位未建档」对话框，确认后再进预览
    const missingMap = await window.showModalMissingLineStation(result.plan);
    if (missingMap === null) return; // 用户取消

    // 应用用户的选择（skip 的行写入 plan._skipKeys，不再补建）
    const skipKeys = [];
    missingMap.forEach((v, k) => { if (v === 'skip') skipKeys.push(k); });
    result.plan._skipKeys = skipKeys;

    window.showImportPreview(result, picked.name);
  };

  /* 下载导入模板（CSV，含示例行，Excel 可直接打开另存为 xlsx） */
  window.downloadFixtureTemplate = function () {
    const sample = [
      ['DH40MC-921-001-001', '定位销压板', 'DH40MC', 'DH40MC-B', 'DH40MC-C', 'DH40MC-D', 'DH40MC-E', 'DH40MC-F', 'DH40MC-G', '冲压', 'ZP1-U-1-1', '3 号线', '1号工位', '用于冲压定位'],
      ['DH40MC-921-001-001', '定位销压板', 'DH40MC', '', '', '', '', '', '', '冲压', 'ZP1-U-1-2', '3 号线', '2号工位', '同编号的第 2 套'],
      ['XXK-D10VG-002', '焊接夹具', 'XXK-D10VG', '', '', '', '', '', '', '焊接', 'ZP1-U-2-1', 'L2 U型线', '1号工位', '']
    ];
    const lines = [FIX_IMPORT_HEADERS.join(','), ...sample.map((r) => r.map((v) => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','))];
    download('夹具导入模板.csv', '﻿' + lines.join('\r\n'));
    toast('模板已下载，填好后用「⬆ 导入Excel/CSV」导入', 'ok');
  };

  window.fixtureRetire = function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) { toast('夹具不存在', 'err'); return; }
    if (f.status === 'retired') { toast('夹具已报废', 'warn'); return; }
    openModal(`报废 — ${f.serialNo || (f.code)} ${f.name}`, `
      <div class="form-group"><label>夹具</label><input type="text" value="${esc(f.serialNo || '')} ${esc(f.name)}（序号 ${esc(f.code)}）" disabled></div>
      <div class="form-group"><label>经办人</label><input type="text" id="fix_retire_op" placeholder="经办人"></div>
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
    const operator = (($('#fix_retire_op') || {}).value || '').trim();
    const time = inputToMs($('#fix_retire_time').value);
    const remark = (($('#fix_retire_remark') || {}).value || '').trim();
    if (!operator) { toast('请填写经办人', 'err'); return; }
    try {
      await DB.fixtureAddTransaction({ fixtureId: id, type: 'retire', operator, time, remark: remark || '报废' });
      closeModal();
      await reloadAll();
      renderFixtures();
      toast('夹具已报废', 'ok');
    } catch (e) { toast('报废失败：' + e.message, 'err'); }
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
            <div class="fixture-spec fixture-ls" title="产线 / 工位：${esc(lineStationLabel(f, '—'))}">产线/工位：${esc(lineStationLabel(f, '—'))}</div>
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
            ${f.status !== 'retired' ? `<button class="btn sm btn-danger" onclick="event.stopPropagation(); fixtureRetire(${f.id})">报废</button>` : ''}
            <button class="btn sm ghost" onclick="event.stopPropagation(); openFixtureQR(${f.id})">二维码</button>
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
        <thead><tr><th style="width:64px">序号</th><th style="width:150px">夹具编号</th><th>名称</th><th>机种名称</th><th>产线 / 工位</th><th>分类</th><th>库位</th><th>状态</th><th>累计出库</th><th>累计回库</th><th style="width:190px">操作</th></tr></thead>
        <tbody>
          ${fixtures.map((f) => {
            const st = FIX_STATUS[f.status] || { label: f.status, cls: 'muted' };
            const isSelected = f.id === selectedId;
            return `<tr class="${isSelected ? 'selected' : ''}" data-id="${f.id}" onclick="fixtureSelect(${f.id})">
              <td class="muted">${esc(f.code)}</td><td>${esc(f.serialNo || '—')}</td><td>${esc(f.name)}</td>
              <td title="${esc(fullLineModels(f, '—'))}">${esc(formatLineModels(f, '—', { collapse: 2 }))}</td>
              <td title="${esc(stationNamesLabel(f, '—'))}">${esc(lineNamesLabel(f, '—'))} / ${esc(stationNamesLabel(f, '—'))}</td>
              <td>${esc(f.category || '—')}</td><td>${esc(f.location || '—')}</td>
              <td><span class="badge ${st.cls}">${st.label}</span></td>
              <td>${f.totalOutCount || 0}</td><td>${f.totalReturnCount || 0}</td>
              <td><span class="row-actions">
                ${f.status === 'stocked' ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureOut(${f.id})">出库</button><button class="btn sm" onclick="event.stopPropagation(); fixtureRepair(${f.id})">送修</button>` : ''}
                ${f.status === 'checked_out' ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureReturn(${f.id})">回库</button>` : ''}
                ${f.status === 'repair' ? `<button class="btn sm primary" onclick="event.stopPropagation(); fixtureRepairComplete(${f.id})">维修完成</button>` : ''}
                <button class="btn sm ghost" onclick="event.stopPropagation(); fixtureEdit(${f.id})">编辑</button>
                ${f.status !== 'retired' ? `<button class="btn sm btn-danger" onclick="event.stopPropagation(); fixtureRetire(${f.id})">报废</button>` : ''}
                <button class="btn sm ghost" onclick="event.stopPropagation(); openFixtureQR(${f.id})">二维码</button>
              </span></td></tr>`;
          }).join('')}
        </tbody>
      </table></div>`;
    container.innerHTML = html;
  }

  /* 统一渲染入口：按视图模式渲染卡片或列表 */
  function renderFixtureArea(container, fixtures, selectedId = 0) {
    if (state.fixViewMode === 'list') renderFixtureList(container, fixtures, selectedId);
    else renderFixtureCards(container, fixtures, selectedId);
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
              <div class="tx-fixture">${esc(t.fixtureCode)} ${esc(t.fixtureName)}</div>
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
        <div class="search-bar"><input type="text" id="fix_search" placeholder="搜索夹具编号 / 名称 / 机种 / 库位 / 产线 / 工位…（序号需完整输入）" oninput="fixtureSearch()"></div>
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
            <li>填写领用信息：领用人、经办人</li>
            <li>提交出库</li>
          </ol>
        </aside>
        <div class="fix-out-col">
          <div class="panel-title">
            📤 夹具出库
            <span class="panel-actions">
              <button class="btn sm" onclick="scanForFixBatch()">📷 批量扫码出库</button>
            </span>
          </div>
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
              <div class="form-group">
                <label>领用人 / 使用部门 *</label>
                <input type="text" id="out_party" placeholder="领用人">
              </div>
              <div class="form-group">
                <label>经办人 *</label>
                <input type="text" id="out_operator" placeholder="经办人">
              </div>
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
            <li>填写归还信息：退库人、经办人</li>
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
              <div class="form-group">
                <label>退库人 / 使用部门</label>
                <input type="text" id="return_party" placeholder="退库人">
              </div>
              <div class="form-group">
                <label>经办人 *</label>
                <input type="text" id="return_operator" placeholder="经办人">
              </div>
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
  }

  /* 数量输入 → 自动勾选前 N 台（超上限归正到上限并提示） */
  function syncQtyToPick(prefix) {
    const input = $('#' + prefix + '_qty');
    const items = $$('.' + prefix + '-pick');
    if (!input || !items.length) return;
    const max = items.length;
    let n = parseInt(input.value, 10);
    if (isNaN(n) || n < 1) { input.value = String(Math.min(1, max)); n = 1; }
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

  /* 一次提交多台：每台各出库 1 件，共用经办人/领用人/时间/备注 */
  window.submitOutDo = async function () {
    // 提交前按数量框同步一次勾选，确保「数量 = 实际出库台数」且不超过可用库存
    syncQtyToPick('out');
    const ids = pickedIds('out');
    if (!ids.length) { toast('请先勾选要出库的夹具，或填写出库数量', 'err'); return; }
    const operator = ($('#out_operator') || {}).value.trim();
    const counterparty = ($('#out_party') || {}).value.trim();
    const time = inputToMs(($('#out_time') || {}).value);
    const outReason = ($('#out_reason') || {}).value || 'use';
    const outReasonText = ($('#out_reason_text') || {}).value.trim();
    const remark = ($('#out_remark') || {}).value.trim();
    if (!operator) { toast('请填写经办人', 'err'); return; }
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        await DB.fixtureAddTransaction({ fixtureId: id, type: 'out', operator, counterparty, time, remark, outReason, outReasonText });
        ok++;
      } catch (e) { fail++; }
    }
    await reloadAll();
    // 只清理本次的选择结果，保留经办人/领用人/时间便于连续录入
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
    // 提交前按数量框同步一次勾选，确保「数量 = 实际回库台数」且不超过可回库台数
    syncQtyToPick('return');
    const ids = pickedIds('return');
    if (!ids.length) { toast('请先勾选要回库的夹具，或填写回库数量', 'err'); return; }
    const operator = ($('#return_operator') || {}).value.trim();
    const counterparty = ($('#return_party') || {}).value.trim();
    const time = inputToMs(($('#return_time') || {}).value);
    const returnReason = ($('#return_reason') || {}).value || 'use';
    const returnReasonText = ($('#return_reason_text') || {}).value.trim();
    const remark = ($('#return_remark') || {}).value.trim();
    if (!operator) { toast('请填写经办人', 'err'); return; }
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        await DB.fixtureAddTransaction({ fixtureId: id, type: 'return', operator, counterparty, time, remark, outReason: returnReason, outReasonText: returnReasonText });
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
   * - 其他状态：最近一次操作的经办人 */
  function fixtureResponsible(f) {
    if (f.status === 'checked_out') return fixtureCurrentBorrower(f) || '—';
    const txs = state.fixTransactions.filter((t) => t.fixtureId === f.id);
    const op = txs.length ? (txs[txs.length - 1].operator || '') : '';
    return op || '—';
  }

  /* 当前所在位置（车间/仓库/工位/外借单位）：
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
            <thead><tr><th>序号</th><th>夹具编号</th><th>名称</th><th>机种名称</th><th>产线 / 工位</th><th>分类</th><th>库位</th><th>状态</th><th>累计出库</th><th>最近动态</th></tr></thead>
            <tbody>
              ${list.length ? list.map((f) => {
                const st = FIX_STATUS[f.status] || { label: f.status, cls: 'muted' };
                return `<tr>
                  <td class="muted">${esc(f.code)}</td><td>${esc(f.serialNo || '—')}</td>
                  <td>${esc(f.name)}</td><td title="${esc(fullLineModels(f, '—'))}">${esc(formatLineModels(f, '—', { collapse: 2 }))}</td>
                  <td title="${esc(stationNamesLabel(f, '—'))}">${esc(lineNamesLabel(f, '—'))} / ${esc(stationNamesLabel(f, '—'))}</td>
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
    const headers = ['序号', '夹具编号', '名称', '机种名称', '产线', '工位', '分类', '库位', '状态', '累计出库', '累计回库', '维修次数', '最近动态', '盘点人', '实盘数量'];
    const rows = list.map((f) => [
      f.code, f.serialNo || '', f.name, formatLineModels(f, ''), lineNamesLabel(f, ''), stationNamesLabel(f, ''), f.category || '', f.location || '',
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
        <div class="search-bar"><input type="text" id="rec_search" placeholder="搜索编号/名称/经办人..." oninput="searchRecords()"></div>
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
      codeLike(t.fixtureCode, q) || (t.fixtureName || '').toLowerCase().includes(q) || (t.operator || '').toLowerCase().includes(q)
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
              <div class="tx-fixture">${esc(t.fixtureCode)} ${esc(t.fixtureName)}</div>
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
   * 夹具查询（多条件组合检索 + 按实物编号聚合的数量/合计视图）
   *
   * 两段：
   *   ① 按实物编号查询 —— 数量为派生值，按「实物编号 × 库位」分组，行内分列「在库 / 在外」（方式 A），
   *      合计行沿用同两列求和，台账总数作小字补充
   *   ② 多条件组合检索 —— 与既有查询页一致，另加实物编号/产线/工位维度
   * ============================================================ */
  function renderQuery() {
    const container = $('#content');
    if (!container) return;
    const q = state.query;
    const locations = uniqueSorted(state.fixtures.map((f) => f.location).filter(Boolean));
    const lineModels = uniqueSorted(state.fixtures.flatMap((f) => (Array.isArray(f.lineModels) ? f.lineModels : [])));
    const borrowers = uniqueSorted(state.fixTransactions
      .filter((t) => t.type === 'out' && t.counterparty)
      .map((t) => t.counterparty));

    const opt = (val, sel) => `<option value="${esc(val)}"${sel === val ? ' selected' : ''}>${esc(val)}</option>`;
    const locOpts = ['<option value="">全部</option>'].concat(locations.map((v) => opt(v, q.location))).join('');
    const lmOpts = ['<option value="">全部</option>'].concat(lineModels.map((v) => opt(v, q.lineModel))).join('');
    const brOpts = ['<option value="">全部</option>'].concat(borrowers.map((v) => opt(v, q.borrower))).join('');

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
        <div class="panel-title">🔢 按夹具编号查询（数量与合计）</div>
        <div class="query-bar">
          <div class="query-field" style="flex:1">
            <label>夹具编号</label>
            <input type="text" id="q_serial" placeholder="如 DH40MC-921-001-001（可只输入片段）" value="${esc(state.serialQuery)}" oninput="serialQueryInput()">
          </div>
          <div class="query-field"><label>&nbsp;</label>
            <button type="button" class="btn sm ghost" onclick="serialQueryClear()">清空</button>
          </div>
        </div>
        <div class="tip">数量是<b>派生值</b>（按「夹具编号 + 库位」分组的记录条数），出库后自动减 1，无需手工维护。</div>
        <div id="serial_agg"></div>
      </div>

      <div class="panel">
        <div class="panel-title">🔎 夹具查询
          <span class="panel-actions"><span id="query_count" class="muted"></span></span>
        </div>
        <div class="query-bar">
          <div class="query-field"><label>关键字</label><input type="text" id="q_keyword" placeholder="夹具编号/名称/机种/库位/产线/工位/责任人…" value="${esc(q.keyword)}" oninput="queryApply()"></div>
          <div class="query-field"><label>序号</label><input type="text" id="q_code" placeholder="如 1001（需完整）" value="${esc(q.code)}" oninput="queryApply()"></div>
          <div class="query-field"><label>名称/机种</label><input type="text" id="q_name" placeholder="名称或机种" value="${esc(q.name)}" oninput="queryApply()"></div>
          <div class="query-field"><label>存放位置</label><select id="q_location" class="query-select" onchange="queryApply()">${locOpts}</select></div>
          <div class="query-field"><label>关联机种</label><select id="q_lm" class="query-select" onchange="queryApply()">${lmOpts}</select></div>
          <div class="query-field"><label>借用人</label><select id="q_borrower" class="query-select" onchange="queryApply()">${brOpts}</select></div>
          <div class="query-field"><label>出库原因</label><select id="q_out_reason" class="query-select" onchange="queryApply()">${outReasonOpts}</select></div>
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
    renderSerialAgg();
  }

  /* ---- 按夹具编号聚合（方式 A：合计行内分列 在库 / 在外，台账作小字） ---- */
  window.serialQueryInput = function () {
    state.serialQuery = ($('#q_serial') || {}).value || '';
    renderSerialAgg();
  };
  window.serialQueryClear = function () {
    state.serialQuery = '';
    const el = $('#q_serial'); if (el) el.value = '';
    renderSerialAgg();
  };

  function renderSerialAgg() {
    const box = $('#serial_agg');
    if (!box) return;
    const q = String(state.serialQuery || '').trim();
    if (!q) {
      box.innerHTML = '<div class="empty-tip">输入夹具编号，查看各库位的在库/在外数量与合计</div>';
      return;
    }
    const ql = q.toLowerCase();
    const list = state.fixtures.filter((f) => String(f.serialNo || '').toLowerCase().includes(ql));
    if (!list.length) {
      box.innerHTML = `<div class="empty-tip">未找到夹具编号含「${esc(q)}」的夹具</div>`;
      return;
    }
    /* 分组键 = 夹具编号 + 库位（这就是「一套」的归属；数量即该组内记录条数） */
    const map = new Map();
    list.forEach((f) => {
      const sn = f.serialNo || '（未填编号）';
      const key = sn + '\u0000' + (f.location || '');
      if (!map.has(key)) map.set(key, { serialNo: sn, location: f.location || '—', stock: 0, out: 0, repair: 0, retired: 0 });
      const g = map.get(key);
      if (f.status === 'stocked') g.stock++;
      else if (f.status === 'checked_out') g.out++;
      else if (f.status === 'repair') g.repair++;
      else g.retired++;
    });
    const groups = Array.from(map.values()).sort((a, b) =>
      natCompare(a.serialNo, b.serialNo) || natCompare(a.location, b.location));
    const sum = (k) => groups.reduce((s, g) => s + g[k], 0);
    const sumStock = sum('stock');
    const sumOut = sum('out');
    const sumRepair = sum('repair');
    const sumRetired = sum('retired');
    const sumTotal = sumStock + sumOut + sumRepair + sumRetired;
    const locCount = new Set(groups.map((g) => g.location)).size;

    box.innerHTML = `
      <div class="agg-head">
        <span>匹配 <b>${groups.length}</b> 个「夹具编号 × 库位」组合</span>
        <span class="agg-tag">在库 <b>${sumStock}</b> · 在外 <b>${sumOut}</b> · 台账 <b>${sumTotal}</b></span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>夹具编号</th><th style="width:150px">库位</th>
          <th style="width:100px">在库</th><th style="width:100px">在外</th>
          <th style="width:100px">维修中</th><th style="width:100px">已报废</th>
          <th style="width:100px">台账</th>
        </tr></thead>
        <tbody>
          ${groups.map((g) => `<tr>
            <td>${esc(g.serialNo)}</td>
            <td>${esc(g.location)}</td>
            <td class="num">${g.stock}</td>
            <td class="num">${g.out}</td>
            <td class="num">${g.repair}</td>
            <td class="num">${g.retired}</td>
            <td class="num">${g.stock + g.out + g.repair + g.retired}</td>
          </tr>`).join('')}
          <tr class="agg-total">
            <td>合计</td>
            <td>${locCount} 个库位</td>
            <td class="num">在库 ${sumStock}</td>
            <td class="num">在外 ${sumOut}</td>
            <td class="num">${sumRepair}</td>
            <td class="num">${sumRetired}</td>
            <td class="num">台账 ${sumTotal}</td>
          </tr>
        </tbody>
      </table></div>
      <p class="muted" style="margin:6px 0 0;">
        「在库」= 现在能领的套数；「在外」= 已出库未回；台账 = 不限状态总数（含维修 / 报废）。
      </p>`;
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
          <th>产线 / 工位</th><th>分类</th><th>库位</th><th>责任人/借用人</th>
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
              <td title="${esc(stationNamesLabel(f, '—'))}">${esc(lineNamesLabel(f, '—'))} / ${esc(stationNamesLabel(f, '—'))}</td>
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
    state.query = { keyword: '', code: '', name: '', location: '', lineModel: '', borrower: '', statuses: [], sortBy: 'code', sortDir: 'asc', outReason: '' };
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
      <div class="form-group"><label>产线 / 工位</label><input type="text" value="${esc(lineStationLabel(f, '—'))}" disabled></div>
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
   *    「哪些产线在用到这个机种的夹具」由夹具记录反查得出，见「按机种查询」。
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

    const list = (state.productions || []).slice().sort((a, b) =>
      (Number(a.order) || 0) - (Number(b.order) || 0) || natCompare(a.name || '', b.name || ''));
    const orphans = orphanLineModels();

    container.innerHTML = `
      <div class="panel">
        <div class="panel-title">🏷 机种管理（${list.length} 个）
          <span class="panel-actions">
            <button class="btn sm" onclick="prodForm(0)">➕ 新建机种</button>
            <button class="btn sm ghost" onclick="showView('prodquery')">🔗 按机种查询</button>
          </span>
        </div>
        <div class="tip">机种是夹具「适用机种」标签的受控字典，<b>不隶属任何产线</b>。夹具与产线的关联只看产线；「哪些产线在用这个机种的夹具」由夹具记录反查得出。</div>
        ${orphans.length ? `<div class="tip hint-warn">发现 ${orphans.length} 个夹具正在使用、但字典里没有的机种：<b>${esc(orphans.join('、'))}</b>
          <button class="btn sm" style="margin-left:8px" onclick="prodAdoptOrphans()">一键补登</button></div>` : ''}
        ${list.length ? `<div class="table-wrap"><table>
          <thead><tr><th>机种名称</th><th style="width:110px">关联夹具</th><th style="width:100px">在库套数</th>
            <th style="width:90px">排序号</th><th style="width:150px">操作</th></tr></thead>
          <tbody>
            ${list.map((p) => {
              const refs = productionRefCount(p.name);
              const stocked = (state.fixtures || []).filter((f) => f.status === 'stocked' && (Array.isArray(f.lineModels) ? f.lineModels : []).includes(p.name)).length;
              return `<tr>
                <td>${esc(p.name)}</td>
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
      </div>`;
  }

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
   * 按机种查询
   *
   * 推导链（1 跳）：机种 → fixtures.lineModels 反查 → 展开该夹具的 lines
   * 输出固定列：产线 / 夹具编号（实物编号 + 桥梁号）/ 库位 / 状态，按机种分组。
   * 提醒：机种与产线之间**没有**直接绑定关系，「涉及产线」完全来自夹具记录。
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

  async function renderProdQuery() {
    const container = $('#content');
    if (!container) return;
    container.innerHTML = `<div class="panel"><div class="panel-title">🔗 按机种查询</div>
      <div class="loading-tip"><span class="spinner"></span>正在加载…</div></div>`;
    try { await reloadAll(); await reloadLineConfig(); } catch (e) {
      container.innerHTML = `<div class="panel"><div class="panel-title" style="color:var(--danger)">加载失败</div><p>${esc(e && e.message ? e.message : String(e))}</p></div>`;
      return;
    }
    if (state.view !== 'prodquery') return;

    // 候选机种 = 字典 ∪ 夹具在用（孤儿也能查）
    const names = uniqueSorted([].concat(productionNames(), orphanLineModels()));
    const cur = state.prodQuery.name;
    if (cur && names.indexOf(cur) < 0) state.prodQuery.name = '';

    const opts = ['<option value="">全部机种（按机种分组）</option>']
      .concat(names.map((n) => `<option value="${esc(n)}"${n === state.prodQuery.name ? ' selected' : ''}>${esc(n)}</option>`)).join('');

    container.innerHTML = `
      <div class="panel">
        <div class="panel-title">🔗 按机种查询
          <span class="panel-actions"><span id="pq_count" class="muted"></span></span>
        </div>
        <div class="query-bar">
          <div class="query-field" style="min-width:260px"><label>机种</label>
            <select id="pq_name" class="query-select" onchange="prodQueryChange()">${opts}</select>
          </div>
          <div class="query-field"><label>&nbsp;</label>
            <button type="button" class="btn sm ghost" onclick="prodQueryReset()">重置筛选</button>
          </div>
          <div class="query-field"><label>&nbsp;</label>
            <button type="button" class="btn sm" onclick="showView('prod')">🏷 机种管理</button>
          </div>
          <div class="query-field"><label>&nbsp;</label>
            <button type="button" class="btn sm ghost" onclick="showView('linequery')">🔗 产线使用</button>
          </div>
        </div>
        <div class="tip">本页按「机种」分组列出夹具落在<b>哪条产线</b>、放在哪个库位。机种与产线之间没有直接绑定，这里的产线全部由夹具记录（产线字段）反查得出。</div>
        <div id="pq_body"></div>
      </div>`;
    renderProdQueryBody();
  }

  function renderProdQueryBody() {
    const box = $('#pq_body');
    if (!box) return;
    const cnt = $('#pq_count');
    const names = uniqueSorted([].concat(productionNames(), orphanLineModels()));
    const sel = state.prodQuery.name;
    if (!names.length) {
      if (cnt) cnt.textContent = '';
      box.innerHTML = '<div class="empty-tip">还没有任何机种。请先到「机种管理」新建，或新建夹具时录入机种名称。</div>';
      return;
    }
    const target = sel ? [sel] : names;
    const rows = buildProdQueryRows(state.fixtures, state.lines, target);
    if (cnt) cnt.textContent = `${target.length} 个机种 ｜ ${rows.length} 条「机种 × 产线」记录`;

    if (!rows.length) {
      box.innerHTML = `<div class="empty-tip">所选机种下还没有夹具记录</div>`;
      return;
    }

    // 按机种分组渲染
    const groups = new Map();
    rows.forEach((r) => {
      if (!groups.has(r.production)) groups.set(r.production, []);
      groups.get(r.production).push(r);
    });

    const sections = Array.from(groups.entries()).map(([pn, list]) => {
      const stock = list.filter((r) => r.status === 'stocked').length;
      const linesN = new Set(list.map((r) => r.lineName)).size;
      return `
        <div class="pq-group">
          <div class="pq-head">
            <b>${esc(pn)}</b>
            <span class="muted">涉及产线 ${linesN} 条 ｜ 记录 ${list.length} 条 ｜ 在库 ${stock} 套</span>
          </div>
          <div class="table-wrap"><table>
            <thead><tr>
              <th style="width:180px">产线</th>
              <th>夹具编号</th>
              <th style="width:190px">库位</th>
              <th style="width:100px">状态</th>
            </tr></thead>
            <tbody>
              ${list.map((r) => {
                const st = FIX_STATUS[r.status] || { label: r.status, cls: 'muted' };
                return `<tr>
                  <td>${esc(r.lineName)}</td>
                  <td><a href="javascript:;" onclick="fixtureEdit(${r.fixtureId})" title="编辑该夹具">${esc(r.serialNo || '—')}</a>
                    <span class="muted">${esc(r.code)}</span></td>
                  <td>${esc(r.location || '—')}</td>
                  <td><span class="badge ${st.cls}">${st.label}</span></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table></div>
        </div>`;
    }).join('');

    box.innerHTML = sections;
  }

  window.prodQueryChange = function () {
    state.prodQuery.name = ($('#pq_name') || {}).value || '';
    renderProdQueryBody();
  };
  window.prodQueryReset = function () {
    state.prodQuery.name = '';
    renderProdQuery();
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
          <div><b>产线 / 工位：</b>${esc(lineNamesLabel(f, '—'))} / ${esc(stationNamesLabel(f, '—'))}</div>
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
    if (!f) { toast('未找到夹具 ' + key, 'err'); return; }
    const who = f.serialNo || (f.code);
    const want = type === 'out' ? 'stocked' : 'checked_out';
    if (f.status !== want) {
      toast(type === 'out' ? '夹具 ' + who + ' 不在库' : '夹具 ' + who + ' 未出库', 'err');
      return;
    }
    const prefix = type === 'out' ? 'out' : 'return';
    const codeEl = $('#' + prefix + '_code'); if (codeEl) codeEl.value = f.code;
    const q = type === 'out' ? outSearch : returnSearch;
    q();
    const cb = $('.' + prefix + '-pick[data-id="' + f.id + '"]');
    if (cb) cb.checked = true;
    syncGroupHead(prefix);
    syncPickToQty(prefix);
    toast('已选中 ' + who, 'ok');
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

  /* 批量扫码：逐台加入勾选，最后统一提交（不再逐个弹窗） */
  window.scanForFixBatch = function () {
    const container = $('#fix_scan_batch_area');
    if (!container) return;
    let picked = 0;
    startScan('fix_scan_batch_area', (code) => scanPickOne(code, 'out') && picked++);
    setTimeout(() => {
      const tip = $('#fix_scan_batch_tip');
      if (tip) tip.textContent = '已扫码 ' + picked + ' 个夹具';
    }, 100);
  };

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
      <div class="form-group"><label>经办人</label><input type="text" id="fix_return_op" placeholder="经办人（拼音联想）"></div>
      <div class="form-group"><label>回库时间</label><input type="datetime-local" id="fix_return_time" value="${nowInput()}"></div>
      <div class="form-group"><label>备注</label><input type="text" id="fix_return_remark" placeholder="可选备注"></div>
      <div class="form-actions">
        <button class="btn primary" onclick="submitFixtureReturn(${id})">确认回库</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    openModal(`回库 — ${f.serialNo || f.code} ${f.name}`, html);
  };

  window.submitFixtureReturn = async function (id) {
    const operator = ($('#fix_return_op') || {}).value.trim();
    const time = inputToMs($('#fix_return_time').value);
    const remark = ($('#fix_return_remark') || {}).value.trim();
    const location = (($('#fix_return_loc') || {}).value || '').trim();
    if (!operator) { toast('请填写经办人', 'err'); return; }
    if (!isValidLocation(location)) { toast('库位号需为 4 段式（如 ZP1-U-1-1），且不超过 ' + MAX_LOCATION + ' 字符', 'err'); return; }
    try {
      await DB.fixtureAddTransaction({ fixtureId: id, type: 'return', operator, time, remark, location });
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
      <div class="form-group"><label>经办人</label><input type="text" id="fix_repair_op" placeholder="经办人"></div>
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
    const operator = ($('#fix_repair_op') || {}).value.trim();
    const type = ($('#fix_repair_type') || {}).value;
    const remark = ($('#fix_repair_remark') || {}).value.trim();
    if (!operator) { toast('请填写经办人', 'err'); return; }
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
      <div class="form-group"><label>经办人</label><input type="text" id="fix_rdone_op" placeholder="经办人"></div>
      <div class="form-group"><label>完成时间</label><input type="datetime-local" id="fix_rdone_time" value="${nowInput()}"></div>
      <div class="form-group"><label>维修说明</label><input type="text" id="fix_rdone_remark" placeholder="处理结果（可选）"></div>
      <div class="form-actions">
        <button class="btn primary" onclick="submitFixtureRepairComplete(${id})">确认完成并回库</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `);
  };

  window.submitFixtureRepairComplete = async function (id) {
    const operator = (($('#fix_rdone_op') || {}).value || '').trim();
    const time = inputToMs($('#fix_rdone_time').value);
    const remark = (($('#fix_rdone_remark') || {}).value || '').trim();
    if (!operator) { toast('请填写经办人', 'err'); return; }
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
   * 产线使用 / 产线配置（v3.0.1）
   *
   * 数据层级：line ─┬─ product（产品隶属线体，用于筛选级联）
   *                 └─ station（工位隶属线体，按 seq 排序）
   *   stationFixture 绑定「某产品的某工位 → 一个夹具编号」，一个工位可多条（一对多）。
   * ============================================================ */

  /* 线体形态只有两种：直线形 / U型。未知值一律按直线形处理。
   * 历史数据兼容：早期版本用过 loop / circle / ring 表示「环形」，一律折算为 U型，
   *   保证旧 fixture-data.json 直接打开不会丢形态（不写回文件，只影响显示与绘图）。 */
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

  /* 产线示意图画布（归一化坐标，渲染时经 px() 映射到像素）。
   * 布局与绘图共用同一组常量，避免两处各写一套导致节点与轨迹错位。 */
  const LINE_W = 1000;
  const LINE_H = 520;                  // 画布高度（直线形与 U 型统一）
  const LINE_PER_ROW = 6;              // 直线形每行工位数

  /* 产线布局布点（直线形 / U 型共用，v4.0.2 改版；v4.1.0 重排 U 型纵坐标与底横排横坐标）：
   *   左列 = ceil((n-底部)/2)（竖排，x=0.22，从上到下，y 0.08→0.72）
   *   底部 = round(n/3)（横排，y=0.90，x 从 0.22 到 0.78 —— 与左右竖列**同 x**）
   *   右列 = n - 左列 - 底部（竖排，x=0.78，从下到上，y 0.72→0.08）
   * 三段依次拼接、严格顺序递增。19 个工位 → 底 6 / 左 7 / 右 6
   *（左 1~7、底 8~13、右 14~19）；6 个工位 → 底 2 / 左 2 / 右 2。
   *
   * ⚠️ v4.1.0：竖列末端由 0.80 收到 0.72、底横排由 0.88 下移到 0.90，给转角留白
   *   （文字分列圆两侧后，竖列外侧编号会横向伸出去，否则与底排工位名相撞）。
   * ⚠️ v4.1.0：底横排的 x 跨度由 0.08→0.92 收窄到 0.22→0.78，与左右竖列对齐——
   *   原来底排比竖列还宽，5 号工位到 6 号工位只能斜着连；收窄后转角是**竖直**下落（→ 直角 U）。
   *   代价是底排横向更挤，靠 lineDiagramWidth() 拉长画布 + 允许底排间距更密来消化。 */
  function lineLayoutPoints(n) {
    if (n <= 0) return [];
    const bottomCount = Math.max(1, Math.round(n / 3));
    const leftCount = Math.ceil((n - bottomCount) / 2);
    const rightCount = n - bottomCount - leftCount;

    // seg 标记该点落在 U 型的哪一段（left 左竖边 / bottom 底横边 / right 右竖边）。
    // v4.1.0 渲染时据此决定文字排在哪一侧：U 的内侧永远是画布中心方向，外侧相反。
    const pts = [];
    // 左列：从上到下，x=0.22，y 从 0.08 到 0.72
    for (let i = 0; i < leftCount; i++) {
      const y = leftCount === 1 ? 0.08 : 0.08 + (0.64 * i) / (leftCount - 1);
      pts.push({ x: 0.22, y, seg: 'left' });
    }
    // 底部横排：从左到右，y=0.90，x 从 0.22 到 0.78（与左右竖列同 x，转角才能竖直下落）
    for (let i = 0; i < bottomCount; i++) {
      const x = bottomCount === 1 ? 0.5 : 0.22 + (0.56 * i) / (bottomCount - 1);
      pts.push({ x, y: 0.90, seg: 'bottom' });
    }
    // 右列：从下到上，x=0.78，y 从 0.72 到 0.08
    for (let i = 0; i < rightCount; i++) {
      const y = rightCount === 1 ? 0.08 : 0.72 - (0.64 * i) / (rightCount - 1);
      pts.push({ x: 0.78, y, seg: 'right' });
    }
    return pts;
  }

  /* 工位排序：顺序号（seq）数值升序；无顺序号的置末尾；同号按名称自然序。
   * 注意返回新数组，不改动入参顺序（排序安全）。
   * 无顺序号包含 null / undefined / ''——不能直接用 Number()，
   *   因为 Number(null) === 0 会把它们排到最前面。 */
  function sortStations(list) {
    const seqOf = (o) => {
      const raw = o ? o.seq : null;
      if (raw === null || raw === undefined || raw === '') return Infinity;
      const n = Number(raw);
      return Number.isFinite(n) ? n : Infinity;
    };
    return (list || []).slice().sort((a, b) => {
      const va = seqOf(a);
      const vb = seqOf(b);
      if (va !== vb) return va - vb;
      return natCompare((a && a.name) || '', (b && b.name) || '');
    });
  }

  /* 工位夹具配置表的数据构建（纯函数，不触及 DOM，便于测试）。
   *
   * ⚠️ v4.0.0：`stationFixtures` 集合已整体废弃，「工位 ↔ 夹具」的关联扁平进夹具记录
   *    （`fixtures.stations = [stationId]`），因此这里改为**从夹具全表反查**。
   *    工位必须归属唯一产线，所以只按 stationId 命中即可，无需再带产线/产品筛选。
   *
   * 入参：
   *   stations  该线体的全部工位 [{id, lineId, seq, name}]
   *   fixtures  夹具全表 [{id, code, serialNo, name, status, lineModels, stations}]
   * 返回：[{ station, seq, fixtures: [{id, code, serialNo, name, status, spec}] }]，
   *       按工位顺序排列；该工位上无夹具的，fixtures 为空数组（渲染时显示「— / 无」）。 */
  function buildStationRows(stations, fixtures) {
    const all = (fixtures || []).filter((f) => f && f.code != null);
    return sortStations(stations).map((st) => {
      const list = all
        .filter((f) => Array.isArray(f.stations) && f.stations.map(Number).indexOf(Number(st.id)) >= 0)
        .sort((a, b) => natCompare(a.serialNo || '', b.serialNo || '') || natCompare(a.code, b.code))
        .map((f) => ({
          id: f.id,
          code: String(f.code),
          serialNo: f.serialNo || '',
          name: f.name || '',
          status: f.status || 'stocked',
          spec: formatLineModels(f, '')
        }));
      return { station: st, seq: st.seq, fixtures: list };
    });
  }

  /* 某条产线当前关联的夹具（fixtures.lines 含该线体 id） */
  function fixturesOfLine(lineId) {
    return (state.fixtures || []).filter((f) => Array.isArray(f.lines) && f.lines.map(Number).indexOf(Number(lineId)) >= 0);
  }
  /* 某个工位当前安装的夹具（fixtures.stations 含该工位 id） */
  function fixturesOnStation(stationId) {
    return (state.fixtures || [])
      .filter((f) => Array.isArray(f.stations) && f.stations.map(Number).indexOf(Number(stationId)) >= 0)
      .sort((a, b) => natCompare(a.serialNo || '', b.serialNo || '') || natCompare(a.code, b.code));
  }

  /* 产线图布局计算（纯函数）：返回各工位的归一化坐标（0~1），渲染时再乘容器尺寸。
   *   linear 直线形：按每行 perRow 个折行排布（蛇形不启用，保持从左到右）；
   *   u      U型：沿左侧竖边下行 → 底部横边 → 沿右侧竖边上行（lineLayoutPoints）。 */
  function computeLineLayout(count, type, perRow) {
    const n = Number(count) || 0;
    if (n <= 0) return [];
    if (lineTypeKey(type) === 'u') return lineLayoutPoints(n);
    const per = Math.max(1, Number(perRow) || LINE_PER_ROW);
    const rows = Math.ceil(n / per);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / per);
      const c = i % per;
      const inRow = Math.min(per, n - r * per);
      const x = inRow === 1 ? 0.5 : 0.08 + (0.84 * c) / (inRow - 1);
      const y = rows === 1 ? 0.5 : 0.16 + (0.68 * r) / (rows - 1);
      pts.push({ x, y });
    }
    return pts;
  }

  /* 查询条件：某线体下的工位列表（已按 seq 排序） */
  function stationsOfLine(stations, lineId) {
    return sortStations((stations || []).filter((s) => s && s.lineId === lineId));
  }

  /* 工位显示名统一为「N号工位」：去掉「X号线」等线体前缀（线体名已在示意图标题处显示）。
   * 工位号的取法：优先从名称中解析（"1号线3号工位"→3、"4号工位"→4、"4工位"→4），
   * 名称里解析不到数字时退回工位顺序号 seq，seq 也没有则用列表位置兜底。 */
  function stationLabel(station, fallbackNo) {
    const raw = String((station && station.name) || '').trim();
    const m = raw.match(/(\d+)\s*号?\s*工位/);
    if (m) return m[1] + '号工位';
    const seq = station ? station.seq : null;
    if (seq !== null && seq !== undefined && seq !== '' && Number.isFinite(Number(seq))) {
      return Number(seq) + '号工位';
    }
    return String(fallbackNo) + '号工位';
  }

  /* 产线图高度自适应。
   * 纵向跨度：直线形「圆上名称 + 圆下编号」74px；U 型竖列文字改到圆两侧后只剩单行高度（约 16px）。
   *   固定 LINE_H=520 时，U 型 5 工位/列竖列间距只有 75.6px、直线形 4 行只有 95.2px，
   *   上下两行的文字会挤在一起，因此按「最小节点间距」反推高度：
   *   直线形：纵向可用比例 0.68 → H = 100 + 100×(行数-1)/0.68（节点跨度 74px，需 ≥100px 行距）
   *   U 型：竖列可用比例 0.64 → H = 100 + 72×(单列最多工位数-1)/0.64（圆 38px + 34px 间隙）
   * 算出来比 LINE_H 小的（工位很少时）仍取 LINE_H，避免画布过矮。 */
  function lineDiagramHeight(n, type) {
    const count = Number(n) || 0;
    if (count <= 1) return LINE_H;
    if (lineTypeKey(type) === 'u') {
      const bottomCount = Math.max(1, Math.round(count / 3));
      const leftCount = Math.ceil((count - bottomCount) / 2);
      const rightCount = count - bottomCount - leftCount;
      const maxCol = Math.max(leftCount, rightCount);
      if (maxCol <= 1) return LINE_H;
      return Math.max(LINE_H, Math.ceil(100 + (72 * (maxCol - 1)) / 0.64));
    }
    const rowsN = Math.ceil(count / LINE_PER_ROW);
    if (rowsN <= 1) return LINE_H;
    return Math.max(LINE_H, Math.ceil(100 + (100 * (rowsN - 1)) / 0.68));
  }

  /* ---------------- 示意图节点文字排布（v4.1.0） ----------------
   * U 型：工位名放**内侧**、夹具号放**外侧**。U 的轨迹是「左竖边下行 → 底横边 → 右竖边上行」，
   *   围出来的内侧恒为画布中心方向：
   *     左列（seg=left） ：内侧＝右 → 名称在圆右（anchor=start），编号在圆左（anchor=end）
   *     右列（seg=right）：内侧＝左 → 名称在圆左（anchor=end），编号在圆右（anchor=start）
   *     底横边（seg=bottom）：内侧＝上 → 名称在圆上、编号在圆下（居中）
   * 直线形没有内外之分，沿用 v4.0.7 的「圆上工位名 / 圆下夹具号」上下结构。
   * 侧排时文字压圆心基线（y+4），与圆心的水平间隙 LD_GAP。
   *
   * v4.1.0（用户截图反馈：底部夹具号粘连）：底横排节点密、编号长时，同一条基线上的编号会首尾相接。
   *   底排改为**相邻标签上下错开**——偶数位贴圆（y+CODE_NEAR）、奇数位下沉（y+CODE_FAR），
   *   两条基线相差 20px；于是同一条基线上的相邻编号相隔 2 个节点间距，横向空间翻倍。 */
  const LD_R = 19;          // 节点圆半径
  const LD_GAP = 8;         // 文字与圆之间的间隙
  const LD_MIN_TEXT_GAP = 16;   // 相邻节点文字的横向呼吸
  const LINE_MAX_W = 2600;      // 画布自动拉长的上限（超过就靠截断，避免无限变宽）
  const LD_CODE_NEAR = 46;      // 底排编号：贴圆基线（与圆心差 46）
  const LD_CODE_FAR = 66;       // 底排编号：错行后的基线（与圆心差 66，与 NEAR 相距 20）

  function nodeTextPos(seg, p, stagger) {
    if (seg === 'left') {
      return {
        name: { x: p.x + LD_R + LD_GAP, y: p.y + 4, anchor: 'start' },
        code: { x: p.x - LD_R - LD_GAP, y: p.y + 4, anchor: 'end' }
      };
    }
    if (seg === 'right') {
      return {
        name: { x: p.x - LD_R - LD_GAP, y: p.y + 4, anchor: 'end' },
        code: { x: p.x + LD_R + LD_GAP, y: p.y + 4, anchor: 'start' }
      };
    }
    return {
      name: { x: p.x, y: p.y - 28, anchor: 'middle' },
      code: { x: p.x, y: p.y + (stagger ? LD_CODE_FAR : LD_CODE_NEAR), anchor: 'middle' }
    };
  }

  /* SVG 文本宽度估算（中文≈字号宽，ASCII≈0.56×字号），只用于反推画布要拉多长。 */
  function svgTextWidth(str, fontSize) {
    let w = 0;
    for (const ch of String(str == null ? '' : str)) {
      w += ch.codePointAt(0) > 0x2e80 ? fontSize : fontSize * 0.56;
    }
    return w;
  }

  /* 节点下方/外侧显示的夹具号：优先实物编号（主搜索键），无实物编号退回桥梁号，超 22 字截断。 */
  function fixtureBadgeText(row) {
    const list = (row && row.fixtures) || [];
    if (!list.length) return '无';
    const codes = list.map((f) => f.serialNo || f.code).join(' / ');
    return codes.length > 22 ? codes.slice(0, 21) + '…' : codes;
  }

  /* 画布宽度自适应（v4.1.0 底排按错行折算）：位置不够就把示意图**拉长**，不让文字互相压。
   * 归一化横坐标 0~1 映射到 [60, W-60]，相邻节点像素间距 = 跨度 × (W-120)：
   *   直线形：跨度 0.84/(每行数量-1)，需容下 max(工位名宽, 夹具号宽) + 16
   *   U 型底横边：跨度 0.56/(底排数量-1)；编号**两行错开**，同一条基线上的相邻编号隔了 2 个节点间距，
   *     所以只需 codeW+16 的一半；工位名仍是一行一个，按 nameW+16 卡
   *   U 型左右列（左右结构）：0.22 的比例位置要容下「间隙 + 编号宽」，两侧各留 8px 边距
   * 画布只加宽、不缩小（不足 LINE_W 仍按 LINE_W）。 */
  function lineDiagramWidth(rows, type) {
    const list = rows || [];
    if (!list.length) return LINE_W;
    let nameW = 0;
    let codeW = 0;
    list.forEach((r) => {
      nameW = Math.max(nameW, svgTextWidth(stationLabel(r.station, 1), 12));
      codeW = Math.max(codeW, svgTextWidth(fixtureBadgeText(r), 11));
    });
    const need = Math.max(nameW, codeW) + LD_MIN_TEXT_GAP;
    let W = LINE_W;
    if (lineTypeKey(type) === 'u') {
      const bottomCount = Math.max(1, Math.round(list.length / 3));
      if (bottomCount > 1) {
        // 底排编号错行 → 同基线相邻编号相隔 2 个间距
        const pitchNeed = Math.max(nameW + LD_MIN_TEXT_GAP, (codeW + LD_MIN_TEXT_GAP) / 2);
        W = Math.max(W, 120 + Math.ceil((pitchNeed * (bottomCount - 1)) / 0.56));
      }
      // 外侧编号左缘 = 60 + 0.22×(W-120) - (LD_R+LD_GAP) - codeW ≥ 8
      W = Math.max(W, 120 + Math.ceil(Math.max(0, codeW - 25) / 0.22));
    } else {
      const per = Math.min(LINE_PER_ROW, list.length);
      if (per > 1) W = Math.max(W, 120 + Math.ceil((need * (per - 1)) / 0.84));
    }
    return Math.min(W, LINE_MAX_W);
  }

  /* 产线图渲染：SVG。U型画「左竖边 → 底横边 → 右竖边」的折线轨迹；直线形画折行连线。
   * v4.1.0 节点排布：U 型——工位名在圆**内侧**、夹具号在圆**外侧**（见 nodeTextPos）；
   *   直线形——圆上工位名（统一「N号工位」）、圆下夹具号，基线相距 74px。
   *   圆圈本身只表示夹具状态——实心主色＝已配置夹具，空心灰＝无配置（与右上图例一一对应）。
   * 画布高见 lineDiagramHeight()、宽见 lineDiagramWidth()（文字放不下就自动拉长）。 */
  function renderLineDiagram(line, rows) {
    if (!line || !rows.length) {
      return '<div class="empty-tip">该线体尚未配置工位</div>';
    }
    const isU = lineTypeKey(line.type) === 'u';
    const W = lineDiagramWidth(rows, line.type);
    const H = lineDiagramHeight(rows.length, line.type);
    const pts = computeLineLayout(rows.length, line.type, LINE_PER_ROW);
    const px = (p) => ({ x: 60 + p.x * (W - 120), y: 50 + p.y * (H - 100) });
    // 画布已是「按文字宽度算出的自然尺寸」：给 svg 不低于自然宽度的 min-width，
    // 窄窗口下靠容器横向滚动查看，而不是把整张图等比缩到字号看不清（宽窗口仍撑满）。
    const minW = W;

    /* v4.1.0：U 型底横排的首/末节点与左右竖列同 x，转角处连线**竖直**穿过该节点的居中标签。
     * 给这两个标签垫一块与文字等宽的白底（.ld-plate），连线看起来从标签后面穿过，不会割字。
     * v4.1.0：底排相邻标签上下错开，避免长编号首尾粘连（见 nodeTextPos）。 */
    const bottomIdx = [];
    pts.forEach((q, k) => { if (q.seg === 'bottom') bottomIdx.push(k); });
    const cornerSet = new Set();
    const bottomPos = new Map();
    bottomIdx.forEach((k, pos) => bottomPos.set(k, pos));
    if (isU && bottomIdx.length) {
      cornerSet.add(bottomIdx[0]);
      if (bottomIdx.length > 1) cornerSet.add(bottomIdx[bottomIdx.length - 1]);
    }

    const nodes = rows.map((r, i) => {
      const p = px(pts[i]);
      const has = r.fixtures.length > 0;
      // 工位名统一「N号工位」，去掉「X号线」前缀（线体名已在示意图标题处显示）
      const label = stationLabel(r.station, i + 1);
      const codeTxt = fixtureBadgeText(r);
      // 底横排：奇数位编号下沉一行（两条基线相差 20px），同基线相邻编号隔 2 个节点间距
      const stagger = isU && bottomPos.has(i) ? bottomPos.get(i) % 2 === 1 : false;
      const pos = nodeTextPos(pts[i].seg, p, stagger);
      const tipName = has ? r.fixtures.map((f) => f.name || f.code).join(' / ') : '无夹具';
      const wName = svgTextWidth(label, 12);
      const plate = cornerSet.has(i)
        ? `<rect x="${(pos.name.x - wName / 2 - 2).toFixed(1)}" y="${(pos.name.y - 11).toFixed(1)}" width="${(wName + 4).toFixed(1)}" height="15" rx="3" class="ld-plate"/>`
        : '';
      return `
        <g class="ld-node ${has ? 'ld-on' : 'ld-off'}">
          <title>${esc(label + ' · ' + tipName)}</title>
          ${plate}
          <text x="${pos.name.x.toFixed(1)}" y="${pos.name.y.toFixed(1)}" text-anchor="${pos.name.anchor}" class="ld-name">${esc(label)}</text>
          <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="19" class="${has ? 'ld-dot-on' : 'ld-dot-off'}"/>
          <text x="${pos.code.x.toFixed(1)}" y="${pos.code.y.toFixed(1)}" text-anchor="${pos.code.anchor}" class="ld-code${has ? '' : ' ld-none'}">${esc(codeTxt)}</text>
        </g>`;
    }).join('');

    // 连线：U 型 = 按工位顺序逐点连线（左上→左下→底部→右上，自动形成 U 形轨迹）；
    // 直线形 = 按行分段折线 + 行间折返。
    let path = '';
    if (isU) {
      const c = pts.map((p) => px(p));
      path = `<polyline points="${c.map((p) => `${p.x},${p.y}`).join(' ')}" class="ld-track" fill="none"/>`;
    } else {
      const per = LINE_PER_ROW;
      const rowsN = Math.ceil(rows.length / per);
      for (let r = 0; r < rowsN; r++) {
        const seg = rows.slice(r * per, r * per + per);
        if (seg.length < 2) continue;
        const a = px(pts[r * per]);
        const b = px(pts[r * per + seg.length - 1]);
        path += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="ld-track"/>`;
      }
      // 行间折返连接（第 1 行末 → 第 2 行首）
      for (let r = 1; r < rowsN; r++) {
        const prev = px(pts[r * per - 1]);
        const cur = px(pts[r * per]);
        path += `<line x1="${prev.x}" y1="${prev.y}" x2="${cur.x}" y2="${cur.y}" class="ld-track ld-link"/>`;
      }
    }

    return `
      <div class="line-diagram">
        <div class="line-diagram-head">
          <span class="ld-title">${esc(line.name)} · ${lineTypeLabel(line.type)}产线示意图</span>
          <span class="ld-legend">
            <i class="ld-lg ld-lg-on"></i>已配置夹具
            <i class="ld-lg ld-lg-off"></i>无配置
          </span>
        </div>
        <div class="ld-canvas">
          <svg class="ld-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"
               style="min-width:${minW}px" aria-label="${esc(line.name)}产线布局示意图">
            ${path}
            ${nodes}
          </svg>
        </div>
      </div>`;
  }

  /* ---------------- 产线使用页 ----------------
   * v4.0.0：产品级联已废除（机种不隶属产线）；工位↔夹具关联从 fixtures 反查。 */
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
            <button type="button" class="btn sm" onclick="showView('linecfg')">⚙ 去配置产线</button>
          </div>
          <div class="query-field"><label>&nbsp;</label>
            <button type="button" class="btn sm ghost" onclick="showView('prodquery')">🏷 按机种查询</button>
          </div>
        </div>
        ${lines.length ? '' : '<div class="tip">尚未配置任何线体。请先到「产线配置」新建线体与工位，或用「导入」批量铺底。</div>'}
        <div id="lq_body"></div>
      </div>`;
    renderLineQueryBody();
  }

  /* 结果区：工位夹具配置表（只读）+ 产线示意图 */
  function renderLineQueryBody() {
    const box = $('#lq_body');
    if (!box) return;
    const q = state.lineQuery;
    const line = state.lines.find((l) => l.id === q.lineId) || null;
    const cnt = $('#lq_count');

    // 无数据状态
    if (!line) {
      if (cnt) cnt.textContent = '';
      box.innerHTML = '<div class="empty-tip">请选择线体以查看工位夹具配置</div>';
      return;
    }

    const stations = stationsOfLine(state.stations, line.id);
    if (!stations.length) {
      if (cnt) cnt.textContent = '';
      box.innerHTML = `<div class="empty-tip">线体「${esc(line.name)}」下还没有工位，请先到「产线配置」添加工位</div>`;
      return;
    }

    const lineModel = state.lineQuery.lineModel || '';
    let fixtures = state.fixtures || [];
    if (lineModel) {
      fixtures = fixtures.filter((f) => lineModelsMatch(f, lineModel));
    }
    const rows = buildStationRows(stations, fixtures);
    const withFix = rows.filter((r) => r.fixtures.length > 0).length;
    const fixCount = rows.reduce((s, r) => s + r.fixtures.length, 0);
    const lineFix = fixturesOfLine(line.id).length;
    if (cnt) cnt.textContent = `${line.name} ｜ 工位 ${rows.length} 个，已装夹具 ${withFix} 个，夹具 ${fixCount} 套（本线关联 ${lineFix} 套）`;

    box.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>
          <th style="width:130px">工位名称</th>
          <th style="width:80px">工位顺序</th>
          <th style="width:70px">序号</th>
          <th style="width:170px">夹具编号</th>
          <th>夹具名称</th>
          <th style="width:100px">状态</th>
          <th>备注</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => {
            const remark = esc((r.station && r.station.remark) || '—');
            if (!r.fixtures.length) {
              return `<tr class="row-empty">
                <td>${esc(r.station.name || '—')}</td>
                <td>${esc(r.seq == null ? '—' : String(r.seq))}</td>
                <td class="muted">—</td><td class="muted">—</td><td class="muted">无</td>
                <td class="muted">—</td>
                <td class="muted">${remark}</td>
              </tr>`;
            }
            return r.fixtures.map((f, i) => {
              const st = FIX_STATUS[f.status] || { label: f.status, cls: 'muted' };
              return `<tr>
                ${i === 0 ? `<td rowspan="${r.fixtures.length}">${esc(r.station.name || '—')}</td>
                  <td rowspan="${r.fixtures.length}">${esc(r.seq == null ? '—' : String(r.seq))}</td>` : ''}
                <td class="muted">${esc(f.code)}</td>
                <td>${esc(f.serialNo || '—')}</td>
                <td><a href="javascript:;" onclick="fixtureEdit(${f.id})" title="编辑该夹具">${esc(f.name || '—')}</a></td>
                <td><span class="badge ${st.cls}">${st.label}</span></td>
                ${i === 0 ? `<td rowspan="${r.fixtures.length}">${remark}</td>` : ''}
              </tr>`;
            }).join('');
          }).join('')}
        </tbody>
      </table></div>
      <div class="tip">本表为<b>只读</b>视图：工位上的夹具由「夹具管理 → 编辑夹具」中的产线/工位选择决定。点击夹具名称可直接编辑。</div>
      ${renderLineDiagram(line, rows)}`;
  }

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
   * 产线配置管理页（线体 / 工位）
   *
   * v4.0.0 结构变化：
   *   - 「产品」面板整体移除 —— 机种（productions）不隶属线体，已独立成「机种管理」页
   *   - 「工位夹具」由「配置夹具」按钮改为**只读视图**：关联的真身在夹具记录里
   *     （fixtures.stations），此处只展示 + 提供「编辑夹具」跳转
   *   - 工位是唯一结构表（工位名跨产线可重名，必须靠 lineId 区分归属）
   * 两块面板自上而下：① 线体 ② 工位与夹具（只读）
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

    const line = lines.find((l) => l.id === cfg.lineId) || null;

    container.innerHTML = `
      <div class="panel">
        <div class="panel-title">① 线体
          <span class="panel-actions">
            <button class="btn sm" onclick="lineCfgLineForm(0)">➕ 新建线体</button>
            <button class="btn sm ghost" onclick="lineCfgImport()">⬆ 导入Excel/CSV</button>
            <button class="btn sm ghost" onclick="downloadLineTemplate()">📄 下载模板</button>
          </span>
        </div>
        ${lines.length ? `<div class="table-wrap"><table>
          <thead><tr><th style="width:64px">选用</th><th>线体名称</th><th style="width:110px">形态</th>
            <th style="width:90px">工位数</th><th style="width:110px">关联夹具</th><th>备注</th><th style="width:150px">操作</th></tr></thead>
          <tbody>
            ${lines.map((l) => {
              const sel = l.id === cfg.lineId;
              return `<tr class="${sel ? 'row-selected' : ''}">
                <td><button class="btn sm ${sel ? 'primary' : 'ghost'}" onclick="lineCfgPickLine(${l.id})">${sel ? '已选' : '选择'}</button></td>
                <td>${esc(l.name)}</td>
                <td>${lineTypeLabel(l.type)}</td>
                <td>${stationsOfLine(state.stations, l.id).length}</td>
                <td>${fixturesOfLine(l.id).length} 套</td>
                <td>${esc(l.remark || '—')}</td>
                <td><span class="row-actions">
                  <button class="btn sm" onclick="lineCfgLineForm(${l.id})">编辑</button>
                  <button class="btn sm danger" onclick="lineCfgDelLine(${l.id})">删除</button>
                </span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>` : '<div class="empty-tip">还没有线体，点「➕ 新建线体」开始</div>'}
      </div>

      <div class="panel">
        <div class="panel-title">② 工位与夹具（只读关联）${line ? `（${esc(line.name)}）` : ''}
          <span class="panel-actions">
            <button class="btn sm" onclick="lineCfgStationForm(0)"${line ? '' : ' disabled'}>➕ 新建工位</button>
          </span>
        </div>
        ${!line ? '<div class="empty-tip">请先在上方选择或新建线体</div>'
          : (() => {
            const sts = stationsOfLine(state.stations, line.id);
            if (!sts.length) return '<div class="empty-tip">该线体下还没有工位</div>';
            const rows = buildStationRows(sts, state.fixtures);
            return `<div class="table-wrap"><table>
              <thead><tr><th style="width:150px">工位名称</th><th style="width:80px">顺序</th>
                <th>该工位上的夹具（只读）</th><th>备注</th><th style="width:150px">操作</th></tr></thead>
              <tbody>
                ${rows.map((r) => `<tr>
                  <td>${esc(r.station.name || '—')}</td>
                  <td>${esc(r.seq == null ? '—' : String(r.seq))}</td>
                  <td class="fx-cell">${r.fixtures.length
                    ? r.fixtures.map((f) => {
                      const st = FIX_STATUS[f.status] || { label: f.status, cls: 'muted' };
                      const title = `${f.name} ｜ 状态：${st.label}`;
                      return `<span class="fx-tag" title="${esc(title)}" onclick="fixtureEdit(${f.id})" style="cursor:pointer">${esc(f.serialNo || (f.code))} <i class="muted">${esc(f.code)}</i></span>`;
                    }).join('')
                    : '<span class="muted">—</span>'}</td>
                  <td>${esc(r.station.remark || '—')}</td>
                  <td><span class="row-actions">
                    <button class="btn sm ghost" onclick="lineCfgStationEditFixtures(${r.station.id})">编辑夹具</button>
                    <button class="btn sm" onclick="lineCfgStationForm(${r.station.id})">编辑工位</button>
                    <button class="btn sm danger" onclick="lineCfgDelStation(${r.station.id})">删除</button>
                  </span></td>
                </tr>`).join('')}
              </tbody>
            </table></div>
            <div class="tip">工位上的夹具由<b>夹具记录</b>决定，这里只读展示。点「编辑夹具」选中该工位上的夹具进行修改；若工位为空，请到「夹具管理 → 新建/编辑夹具」勾选本工位。</div>`;
          })()}
      </div>`;
  }

  /* 只读视图的「编辑夹具」：该工位上仅 1 套时直接打开，多套时先让用户挑 */
  window.lineCfgStationEditFixtures = function (stationId) {
    const list = fixturesOnStation(stationId);
    if (!list.length) {
      toast('该工位暂无夹具，请到「夹具管理 → 新建夹具」勾选本工位', 'warn');
      return;
    }
    if (list.length === 1) { fixtureEdit(list[0].id); return; }
    openModal('选择要编辑的夹具', `
      <div class="table-wrap"><table>
        <thead><tr><th>序号</th><th>夹具编号</th><th>名称</th><th>状态</th><th style="width:90px">操作</th></tr></thead>
        <tbody>${list.map((f) => {
          const st = FIX_STATUS[f.status] || { label: f.status, cls: 'muted' };
          return `<tr>
            <td class="muted">${esc(f.code)}</td><td>${esc(f.serialNo || '—')}</td>
            <td>${esc(f.name)}</td><td><span class="badge ${st.cls}">${st.label}</span></td>
            <td><button class="btn sm primary" onclick="closeModal(); fixtureEdit(${f.id})">编辑</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      <div class="form-actions"><button class="btn ghost" onclick="closeModal()">取消</button></div>`);
  };

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
      <p class="muted" style="margin:4px 0 0;">产线形态只有两种，决定查询页示意图的画法：<b>直线形</b>按工位顺序横向折行；<b>U型</b>沿左侧竖边下行、经底部横边、再沿右侧竖边上行。</p>
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

  /* 删除线体：连带删除其工位，并从全部夹具记录的 lines / stations 中摘除 —— 破坏性操作，先说清楚 */
  window.lineCfgDelLine = async function (id) {
    const l = state.lines.find((x) => x.id === id);
    if (!l) return;
    const ns = stationsOfLine(state.stations, id).length;
    const nf = fixturesOfLine(id).length;
    openModal('删除线体', `
      <p>确定删除线体「<b>${esc(l.name)}</b>」吗？</p>
      <p class="muted">将同时删除其 <b>${ns}</b> 个工位，并把 <b>${nf}</b> 套夹具从该产线（及其工位）上摘除，此操作不可撤销。</p>
      ${nf ? `<p class="muted" style="color:var(--danger)">⚠️ 摘除后若某套夹具既无产线也无工位，将被视为「未配置关联」，请随后到「夹具管理」补填。</p>` : ''}
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

  /* ---- 工位表单 ---- */
  window.lineCfgStationForm = function (id) {
    const s = state.stations.find((x) => x.id === id) || null;
    const lineId = s ? s.lineId : state.lineCfg.lineId;
    if (!lineId) { toast('请先选择线体', 'err'); return; }
    openModal(s ? '编辑工位' : '新建工位', `
      <div class="form-group"><label>所属线体</label>
        <input type="text" value="${esc((state.lines.find((l) => l.id === lineId) || {}).name || '')}" disabled></div>
      <div class="form-group"><label>工位名称</label>
        <input type="text" id="lc_st_name" placeholder="如 上料工位" value="${esc(s ? s.name : '')}"></div>
      <div class="form-group"><label>工位顺序</label>
        <input type="number" id="lc_st_seq" placeholder="数字，越小越靠前（如 10 / 20 / 30）" value="${s && s.seq != null ? esc(String(s.seq)) : ''}"></div>
      <div class="form-group"><label>备注</label>
        <input type="text" id="lc_st_remark" placeholder="可选" value="${esc(s ? (s.remark || '') : '')}"></div>
      <div class="form-actions">
        <button class="btn primary" onclick="lineCfgSaveStation(${id})">保存</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>`);
  };

  window.lineCfgSaveStation = async function (id) {
    const name = ($('#lc_st_name') || {}).value.trim();
    const seqRaw = ($('#lc_st_seq') || {}).value.trim();
    const remark = ($('#lc_st_remark') || {}).value.trim();
    if (!name) { toast('请填写工位名称', 'err'); return; }
    const seq = seqRaw === '' ? null : Number(seqRaw);
    if (seqRaw !== '' && !Number.isFinite(seq)) { toast('工位顺序需为数字', 'err'); return; }
    try {
      if (id) {
        const s = state.stations.find((x) => x.id === id);
        await DB.put('stations', { ...s, name, seq, remark, updatedAt: Date.now() });
      } else {
        await DB.add('stations', { lineId: state.lineCfg.lineId, name, seq, remark, createdAt: Date.now() });
      }
      closeModal();
      await renderLineConfig();
      toast(id ? '工位已更新' : '工位已创建', 'ok');
    } catch (e) { toast('保存失败：' + (e && e.message ? e.message : e), 'err'); }
  };

  window.lineCfgDelStation = function (id) {
    const s = state.stations.find((x) => x.id === id);
    if (!s) return;
    const n = fixturesOnStation(id).length;
    openModal('删除工位', `
      <p>确定删除工位「<b>${esc(s.name)}</b>」吗？</p>
      <p class="muted">将把 <b>${n}</b> 套夹具从该工位上摘除（夹具本身保留），此操作不可撤销。</p>
      ${n ? '<p class="muted" style="color:var(--danger)">⚠️ 若某套夹具因此失去全部工位，其「工位」栏将变空，请到「夹具管理」重新指派工位。</p>' : ''}
      <div class="form-actions">
        <button class="btn danger" onclick="lineCfgDelStationConfirm(${id})">确认删除</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>`);
  };
  window.lineCfgDelStationConfirm = async function (id) {
    try {
      await DB.stationDel(id);
      closeModal();
      await reloadAll();
      await renderLineConfig();
      toast('工位已删除', 'ok');
    } catch (e) { toast('删除失败：' + (e && e.message ? e.message : e), 'err'); }
  };

  /* ============================================================
   * 产线配置导入（Excel .xlsx / CSV）
   *
   * ⚠️ v4.0.0 语义反转：旧版「夹具编号」列是「给工位绑夹具」，本版改成
   *    「给某个夹具**追加**这条产线与这个工位」—— 因为关联的真身已扁平进夹具记录。
   *
   * 表格形态：一张平坦表，每行 = 「某线体 · 某工位 · 一个夹具编号」
   *   线体 | 线体形态 | 工位 | 工位顺序 | 夹具编号 | 备注
   * 规则：
   *   - 线体 / 工位：按名称自动补建（同名复用，不重复创建）
   *   - 夹具编号：按 **实物编号 serialNo** 匹配夹具记录（唯一匹配才写；0 或 >1 条计入跳过）
   *   - 写库为**追加 + 去重**（push 前先查重），绝不覆盖该夹具原有的产线/工位
   *   - 超过产线 5 条 / 工位 10 个上限的行计入跳过
   *   - 导入完成后可在提示里点「撤销本次导入」，精确回滚本次追加的产线/工位
   * ============================================================ */
  const LINE_IMPORT_HEADERS = ['线体', '线体形态', '工位', '工位顺序', '夹具编号', '备注'];
  const LINE_IMPORT_ALIAS = {
    '线体': 'line', '产线': 'line', '线体名称': 'line', '产线名称': 'line', 'line': 'line',
    '线体形态': 'lineType', '线体类型': 'lineType', '产线形态': 'lineType', '产线类型': 'lineType',
    '形态': 'lineType', '类型': 'lineType', 'type': 'lineType', 'layout': 'lineType',
    '工位': 'station', '工位名称': 'station', '工位号': 'station', 'station': 'station',
    '工位顺序': 'seq', '工位序号': 'seq', '顺序': 'seq', '序号': 'seq', 'seq': 'seq',
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
    const s = String(v == null ? '' : v).trim();
    if (!s) return 'linear';
    // 只认「U / U型 / U形」开头，避免 "Unit"/"Double" 这类含 u 的词被误判
    if (/^u\s*[型形]?$|^u\s*[型形]|环|圆|loop|circle|ring/i.test(s)) return 'u';
    return 'linear';
  }

  /* 生成导入计划（纯函数，不写库、不触 DOM）。
   * rows     二维数组（首行表头）
   * existing { lines, stations, fixtures }
   * 返回 { ok, newLines, newStations, appends, skipped, error }
   *   newLines    待新建线体 [{ name, type }]
   *   newStations 待新建工位 [{ lineName, name, seq }]
   *   appends     待追加关联 [{ row, fixtureId, code, serialNo, lineName, stationName, addLine, addStation }]
   *
   * ⚠️ 全程以「线体名 + 工位名」为键，避免依赖尚未生成的真实 id；
   *    上限（产线 ≤5 / 工位 ≤10）用「名称集合」预演，故计划阶段即可拦住越界行。 */
  function buildLineImportPlan(rows, existing) {
    if (!rows || rows.length < 2) return { ok: false, error: '文件中没有数据行' };
    const idx = mapLineImportHeader(rows[0]);
    if (idx.line == null) return { ok: false, error: '模板缺少「线体」列' };
    if (idx.station == null) return { ok: false, error: '模板缺少「工位」列' };
    if (idx.fixtureSerial == null) return { ok: false, error: '模板缺少「夹具编号」列（填夹具编号）' };

    const ex = existing || {};
    const lineByName = new Map((ex.lines || []).map((l) => [l.name, l]));
    const lineIdToName = new Map((ex.lines || []).map((l) => [l.id, l.name]));
    const stByKey = new Map((ex.stations || []).map((s) => [(lineIdToName.get(s.lineId) || '') + '\u0000' + s.name, s]));
    const stById = new Map((ex.stations || []).map((s) => [s.id, s]));
    // 实物编号 → 夹具记录（允许重复，重复时无法唯一定位）
    const fixBySerial = new Map();
    (ex.fixtures || []).forEach((f) => {
      const k = String(f.serialNo == null ? '' : f.serialNo).trim();
      if (!k) return;
      if (!fixBySerial.has(k)) fixBySerial.set(k, []);
      fixBySerial.get(k).push(f);
    });

    const newLines = new Map();     // lineName -> { name, type }
    const newStations = new Map();  // lineName|stationName -> { lineName, name, seq }
    const appends = [];
    const skipped = [];
    const planSeen = new Set();     // 「文件内重复行」判定

    /* 每套夹具的「虚拟状态」：现有产线名集合 + 工位键集合（含计划内新增） */
    const vstate = new Map();
    const stateOf = (f) => {
      if (!vstate.has(f.id)) {
        const lineNames = new Set((Array.isArray(f.lines) ? f.lines : [])
          .map((id) => lineIdToName.get(Number(id))).filter(Boolean));
        const stKeys = new Set((Array.isArray(f.stations) ? f.stations : [])
          .map((id) => {
            const o = stById.get(Number(id));
            return o ? ((lineIdToName.get(o.lineId) || '') + '\u0000' + o.name) : null;
          }).filter(Boolean));
        vstate.set(f.id, { lineNames, stKeys });
      }
      return vstate.get(f.id);
    };

    const val = (row, key) => (idx[key] == null ? '' : String(row[idx[key]] == null ? '' : row[idx[key]]).trim());

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row.some((c) => String(c == null ? '' : c).trim() !== '')) continue; // 全空行
      const lineName = val(row, 'line');
      const stationName = val(row, 'station');
      const serialNo = val(row, 'fixtureSerial');
      if (!lineName || !stationName) { skipped.push({ row: r + 1, reason: '线体 / 工位 有空缺' }); continue; }
      if (!serialNo) { skipped.push({ row: r + 1, reason: '夹具编号（夹具编号）为空' }); continue; }

      const hits = fixBySerial.get(serialNo) || [];
      if (!hits.length) { skipped.push({ row: r + 1, reason: '夹具「' + serialNo + '」未建档' }); continue; }
      if (hits.length > 1) {
        skipped.push({ row: r + 1, reason: '夹具编号「' + serialNo + '」对应 ' + hits.length + ' 套夹具，无法唯一定位（请改为在「夹具管理」里直接编辑）' });
        continue;
      }
      const f = hits[0];
      const sKey = lineName + '\u0000' + stationName;
      const rowKey = f.id + '\u0000' + sKey;
      if (planSeen.has(rowKey)) { skipped.push({ row: r + 1, reason: '文件中重复行' }); continue; }
      planSeen.add(rowKey);

      const vs = stateOf(f);
      const addLine = !vs.lineNames.has(lineName);
      const addStation = !vs.stKeys.has(sKey);
      if (!addLine && !addStation) {
        skipped.push({ row: r + 1, reason: '夹具「' + serialNo + '」已关联该产线/工位（无新增，已忽略）' });
        continue;
      }
      if (addLine && vs.lineNames.size >= MAX_LINES) {
        skipped.push({ row: r + 1, reason: '夹具「' + serialNo + '」关联产线已达上限 ' + MAX_LINES + ' 条' });
        continue;
      }
      if (addStation && vs.stKeys.size >= MAX_STATIONS) {
        skipped.push({ row: r + 1, reason: '夹具「' + serialNo + '」关联工位已达上限 ' + MAX_STATIONS + ' 个' });
        continue;
      }

      // 结构补建（同名复用；计划内只登记一次）
      const lineType = parseLineType(val(row, 'lineType'));
      if (!lineByName.has(lineName) && !newLines.has(lineName)) {
        newLines.set(lineName, { name: lineName, type: lineType });
      }
      if (!stByKey.has(sKey) && !newStations.has(sKey)) {
        const seqRaw = val(row, 'seq');
        const seq = seqRaw === '' ? null : Number(seqRaw);
        newStations.set(sKey, { lineName, name: stationName, seq: Number.isFinite(seq) ? seq : null });
      }

      if (addLine) vs.lineNames.add(lineName);
      if (addStation) vs.stKeys.add(sKey);
      appends.push({
        row: r + 1, fixtureId: f.id, code: f.code, serialNo,
        lineName, stationName, addLine, addStation
      });
    }

    if (!newLines.size && !newStations.size && !appends.length) {
      return {
        ok: false,
        skipped,
        error: '没有可导入的有效数据行（需「线体 / 工位 / 已建档的夹具编号」三者齐全且能定位到唯一一套夹具）'
      };
    }
    return {
      ok: true,
      newLines: Array.from(newLines.values()),
      newStations: Array.from(newStations.values()),
      appends,
      skipped
    };
  }

  /* 落库：① 补建线体/工位（名称复用）② 把「产线 + 工位」追加进对应夹具记录（去重）
   * ⚠️ 全程只做 **push**，绝不覆盖夹具原有的 lines / stations。
   * 返回的对象里带 undo 信息，供「撤销本次导入」精确回滚。 */
  async function applyLineImportPlan(plan) {
    const lineIdByName = new Map((state.lines || []).map((l) => [l.name, l.id]));
    const createdLineIds = [];
    for (const l of plan.newLines) {
      const id = await DB.add('lines', { name: l.name, type: l.type, remark: '导入创建', createdAt: Date.now() });
      lineIdByName.set(l.name, id);
      createdLineIds.push(id);
    }

    const lineIdToName = new Map((state.lines || []).map((l) => [l.id, l.name]));
    lineIdByName.forEach((id, name) => lineIdToName.set(id, name));

    const stIdByKey = new Map();
    (state.stations || []).forEach((s) => stIdByKey.set((lineIdToName.get(s.lineId) || '') + '\u0000' + s.name, s.id));
    const createdStationIds = [];
    for (const s of plan.newStations) {
      const lineId = lineIdByName.get(s.lineName);
      if (!lineId) continue;
      const id = await DB.add('stations', { lineId, name: s.name, seq: s.seq, remark: '导入创建', createdAt: Date.now() });
      stIdByKey.set(s.lineName + '\u0000' + s.name, id);
      createdStationIds.push(id);
    }

    // 按夹具聚合要追加的 lineId / stationId
    const byFix = new Map();
    for (const a of plan.appends) {
      const lineId = lineIdByName.get(a.lineName);
      const sid = stIdByKey.get(a.lineName + '\u0000' + a.stationName);
      if (!lineId || !sid) continue;
      if (!byFix.has(a.fixtureId)) byFix.set(a.fixtureId, { lineIds: new Set(), stationIds: new Set(), code: a.code, serialNo: a.serialNo });
      const g = byFix.get(a.fixtureId);
      if (a.addLine) g.lineIds.add(lineId);
      if (a.addStation) g.stationIds.add(sid);
    }

    const undo = [];   // [{ id, code, serialNo, lineIds:[], stationIds:[] }]
    let applied = 0, linesAdded = 0, stationsAdded = 0;
    for (const [fid, g] of byFix.entries()) {
      const f = (state.fixtures || []).find((x) => x.id === fid);
      if (!f) continue;
      const lines = (Array.isArray(f.lines) ? f.lines : []).map(Number).slice();
      const stations = (Array.isArray(f.stations) ? f.stations : []).map(Number).slice();
      const addL = [], addS = [];
      g.lineIds.forEach((id) => {
        if (lines.indexOf(id) < 0 && lines.length < MAX_LINES) { lines.push(id); addL.push(id); }
      });
      g.stationIds.forEach((id) => {
        if (stations.indexOf(id) < 0 && stations.length < MAX_STATIONS) { stations.push(id); addS.push(id); }
      });
      if (!addL.length && !addS.length) continue;
      await DB.fixtureUpdate({ id: f.id, lines, stations });
      // 同步本地快照，保证同一批内多行继续追加时读到的是最新值
      f.lines = lines; f.stations = stations;
      applied++;
      linesAdded += addL.length;
      stationsAdded += addS.length;
      undo.push({ id: f.id, code: f.code, serialNo: f.serialNo || '', lineIds: addL, stationIds: addS });
    }

    return {
      lines: plan.newLines.length,
      stations: plan.newStations.length,
      appends: plan.appends.length,
      applied, linesAdded, stationsAdded,
      undo: { fixtures: undo, createdLineIds, createdStationIds }
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
            <tr><td>新建工位</td><td>${plan.newStations.length}</td><td>${esc(plan.newStations.map((s) => s.lineName + '/' + s.name).join('、') || '—')}</td></tr>
            <tr><td>追加关联</td><td>${plan.appends.length}</td><td>向夹具记录<b>追加</b>产线/工位，不覆盖原有内容</td></tr>
          </tbody>
        </table>
      </div>
      <div style="margin-top:10px;max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:6px;">
        <table style="margin:0;">
          <thead><tr><th>行号</th><th>夹具编号</th><th>名称</th><th>线体</th><th>工位</th><th style="width:150px">动作</th></tr></thead>
          <tbody>
            ${rowsPreview.map((a) => `<tr>
              <td>${a.row}</td>
              <td>${esc(a.serialNo)}</td>
              <td>${esc(((state.fixtures || []).find((x) => x.id === a.fixtureId) || {}).name || '—')}</td>
              <td>${esc(a.lineName)}</td>
              <td>${esc(a.stationName)}</td>
              <td class="muted">${[a.addLine ? '新增产线' : '', a.addStation ? '新增工位' : ''].filter(Boolean).join(' + ') || '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${plan.appends.length > rowsPreview.length ? `<p class="muted" style="margin:6px 0 0;">仅预览前 ${rowsPreview.length} 行，实际将处理全部 ${plan.appends.length} 行。</p>` : ''}
      ${plan.skipped.length ? `<div class="tip" style="margin-top:8px;">跳过 ${plan.skipped.length} 行：${esc(plan.skipped.slice(0, 10).map((s) => '第 ' + s.row + ' 行(' + s.reason + ')').join('、'))}${plan.skipped.length > 10 ? ' 等' : ''}</div>` : ''}
      <p class="muted" style="margin:8px 0 0;">同名线体/工位已存在时直接复用。「夹具编号」按<b>夹具编号</b>匹配，重复导入同一文件不会产生重复关联。</p>
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
      window.__lineImportUndo = (st.applied && (st.linesAdded || st.stationsAdded)) ? st.undo : null;
      if (st.applied) {
        openModal('导入完成', `
          <p>已为 <b>${st.applied}</b> 套夹具追加关联：新增产线 <b>${st.linesAdded}</b> 条、新增工位 <b>${st.stationsAdded}</b> 个；新建线体 <b>${st.lines}</b> 个、新建工位 <b>${st.stations}</b> 个。</p>
          <p class="muted">如需回退，可点「撤销本次导入」精确移除本次追加的关联（不会影响夹具原有的产线与工位）。</p>
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

  /* 撤销本次导入：精确摘除本次追加的产线/工位，并回收本次新建且已无人使用的结构项 */
  window.undoLineImport = async function () {
    const u = window.__lineImportUndo;
    if (!u) { toast('没有可撤销的导入记录', 'warn'); return; }
    window.__lineImportUndo = null;
    const removedLines = new Set(u.fixtures.flatMap((f) => f.lineIds));
    try {
      // ① 先摘产线（连带摘掉该产线下本次新加的工位）
      for (const lineId of removedLines) {
        const codes = u.fixtures.filter((f) => f.lineIds.includes(lineId)).map((f) => f.code);
        if (codes.length) await DB.removeFixtureLinesByBatch({ codes, lineId });
      }
      // ② 再摘「不属于已移除产线」的工位
      for (const f of u.fixtures) {
        for (const sid of f.stationIds) {
          if (removedLines.has(sid)) continue;
          const st = (state.stations || []).find((s) => s.id === sid);
          if (st && removedLines.has(st.lineId)) continue;
          try { await DB.removeFixtureStation({ code: f.code, stationId: sid }); } catch (e) { /* 已不存在则忽略 */ }
        }
      }
      // ③ 回收本次新建的结构项（此时若无任何夹具引用即删除）
      await reloadAll();
      for (const sid of u.createdStationIds) {
        const used = (state.fixtures || []).some((f) => Array.isArray(f.stations) && f.stations.map(Number).includes(Number(sid)));
        if (!used) { try { await DB.stationDel(sid); } catch (e) { /* 忽略 */ } }
      }
      for (const lid of u.createdLineIds) {
        const used = (state.fixtures || []).some((f) => Array.isArray(f.lines) && f.lines.map(Number).includes(Number(lid)))
          || (state.stations || []).some((s) => Number(s.lineId) === Number(lid));
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

    const plan = buildLineImportPlan(rows, { lines: state.lines, stations: state.stations, fixtures: state.fixtures });
    if (!plan.ok) { toast(plan.error, 'err'); return; }
    window.showLineImportPreview(plan, picked.name);
  };

  /* 下载产线配置导入模板
   * 语义：一行 = 「把某套夹具挂到某条产线的某个工位上」（追加式） */
  window.downloadLineTemplate = function () {
    const sample = [
      ['L1 总装线', '直线形', '上料工位', '10', 'DH40MC-921-001-001', '夹具编号填夹具编号'],
      ['L1 总装线', '直线形', '压装工位', '20', 'DH40MC-921-001-001', '同一套夹具挂到第二个工位（追加）'],
      ['L1 总装线', '直线形', '检测工位', '30', 'XXK-D10VG-002', ''],
      ['L2 U型线', 'U型', '工位一', '10', 'XXK-D10VG-002', '同一套夹具再挂到另一条产线']
    ];
    const lines = [LINE_IMPORT_HEADERS.join(','), ...sample.map((r) => r.map((v) => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','))];
    download('产线配置导入模板.csv', '﻿' + lines.join('\r\n'));
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
