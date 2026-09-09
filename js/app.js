/* ============================================================
 * app.js — 工装夹具出入库管理系统主逻辑（v2.1）
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
      .replace(/^SPMS1?\s*\|\s*/i, '')   // 兜底剥离二维码前缀
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

  /* 机种名称：展示 / 搜索 helpers */
  function formatLineModels(f, emptyMark = '—') {
    const arr = (Array.isArray(f.lineModels) ? f.lineModels : []).filter((x) => String(x).trim() !== '');
    return arr.length ? arr.join(' / ') : emptyMark;
  }
  function lineModelsMatch(f, q) {
    const arr = Array.isArray(f.lineModels) ? f.lineModels : [];
    return arr.some((lm) => String(lm).toLowerCase().includes(q));
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
    query: { keyword: '', code: '', name: '', location: '', lineModel: '', borrower: '', statuses: [], sortBy: 'code', sortDir: 'asc' }
  };

  /* ---------------- 数据加载 ---------------- */
  async function reloadAll() {
    state.fixtures = await DB.fixtureGetAll();
    state.fixTransactions = await DB.fixtureGetTransactions();
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

  /* ---------------- 变更日志（关于面板） ---------------- */
  const CHANGELOG = [
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
  function renderDashboard() {
    const stocked = state.fixtures.filter((f) => f.status === 'stocked').length;
    const out = state.fixtures.filter((f) => f.status === 'checked_out').length;
    const repair = state.fixtures.filter((f) => f.status === 'repair').length;
    const retired = state.fixtures.filter((f) => f.status === 'retired').length;
    const totalOut = state.fixtures.reduce((s, f) => s + (f.totalOutCount || 0), 0);
    const totalReturn = state.fixtures.reduce((s, f) => s + (f.totalReturnCount || 0), 0);

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
          <div class="stat-item"><span class="stat-label">流水记录</span><span class="stat-value">${state.fixTransactions.length}</span></div>
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
    const html = `
      <div class="form-group"><label>夹具</label><input type="text" value="${esc(f.code)} ${esc(f.name)}" disabled></div>
      <div class="form-group"><label>经办人</label><input type="text" id="fix_out_op" placeholder="经办人（拼音联想）"></div>
      <div class="form-group"><label>领用人</label><input type="text" id="fix_out_party" placeholder="领用人/使用部门"></div>
      <div class="form-group"><label>出库时间</label><input type="datetime-local" id="fix_out_time" value="${nowInput()}"></div>
      <div class="form-group"><label>备注</label><input type="text" id="fix_out_remark" placeholder="可选备注"></div>
      <div class="form-actions">
        <button class="btn primary" onclick="submitFixtureOut(${id})">确认出库</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    openModal(`出库 — ${f.code} ${f.name}`, html);
  };

  window.submitFixtureOut = async function (id) {
    const operator = ($('#fix_out_op') || {}).value.trim();
    const counterparty = ($('#fix_out_party') || {}).value.trim();
    const time = inputToMs($('#fix_out_time').value);
    const remark = ($('#fix_out_remark') || {}).value.trim();
    if (!operator) { toast('请填写经办人', 'err'); return; }
    try {
      await DB.fixtureAddTransaction({ fixtureId: id, type: 'out', operator, counterparty, time, remark });
      closeModal();
      await reloadAll();
      renderFixtures();
      toast('出库成功', 'ok');
    } catch (e) { toast('出库失败：' + e.message, 'err'); }
  };

  function collectNewLineModels() {
    const arr = [];
    for (let i = 1; i <= 4; i++) {
      const v = ($('#fix_new_lm' + i) || {}).value.trim();
      if (v && !arr.includes(v)) arr.push(v);
      if (arr.length >= 4) break;
    }
    return arr;
  }

  window.fixtureNew = function () {
    const html = `
      <div class="form-group"><label>编号</label><input type="text" id="fix_new_code" placeholder="4位数字编号（如 2001）" maxlength="4"></div>
      <div class="form-group"><label>名称</label><input type="text" id="fix_new_name" placeholder="夹具名称"></div>
      <div class="form-group"><label>机种名称1</label><input type="text" id="fix_new_lm1" placeholder="机种名称（如 Model-A，可选）"></div>
      <div class="form-group"><label>机种名称2</label><input type="text" id="fix_new_lm2" placeholder="机种名称（可选）"></div>
      <div class="form-group"><label>机种名称3</label><input type="text" id="fix_new_lm3" placeholder="机种名称（可选）"></div>
      <div class="form-group"><label>机种名称4</label><input type="text" id="fix_new_lm4" placeholder="机种名称（可选）"></div>
      <div class="form-group"><label>分类</label><input type="text" id="fix_new_cat" placeholder="分类（如 冲压/焊接/装配）"></div>
      <div class="form-group"><label>库位</label><input type="text" id="fix_new_loc" placeholder="存放位置（可选）"></div>
      <div class="form-group"><label>备注</label><input type="text" id="fix_new_remark" placeholder="可选备注"></div>
      <div class="form-actions">
        <button class="btn primary" onclick="submitFixtureNew()">建档</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    openModal('新建夹具', html);
  };

  window.submitFixtureNew = async function () {
    const code = ($('#fix_new_code') || {}).value.trim();
    const name = ($('#fix_new_name') || {}).value.trim();
    const lineModels = collectNewLineModels();
    const category = ($('#fix_new_cat') || {}).value.trim();
    const location = ($('#fix_new_loc') || {}).value.trim();
    const remark = ($('#fix_new_remark') || {}).value.trim();
    if (!code || !/^\d{4}$/.test(code)) { toast('编号为4位纯数字（如 2001）', 'err'); return; }
    if (!name) { toast('请填写夹具名称', 'err'); return; }
    try {
      await DB.fixtureAdd({ code, name, lineModels, category, location, remark, status: 'stocked', totalOutCount: 0, totalReturnCount: 0, repairCount: 0 });
      closeModal();
      await reloadAll();
      renderFixtures();
      toast('夹具建档成功', 'ok');
    } catch (e) { toast('建档失败：' + e.message, 'err'); }
  };

  window.fixtureSearch = function () {
    const q = ($('#fix_search') || {}).value.trim().toLowerCase();
    const list = $('#fixture_list');
    if (!list) return;
    const filtered = q ? state.fixtures.filter((f) =>
      codeLike(f.code, q) ||
      (f.name || '').toLowerCase().includes(q) ||
      (f.location || '').toLowerCase().includes(q) ||
      lineModelsMatch(f, q) ||
      (f.category || '').toLowerCase().includes(q)
    ) : state.fixtures;
    renderFixtureArea(list, filtered, state.fixSelectedId || 0);
  };

  window.fixtureExportCSV = function () {
    const headers = ['编号', '名称', '机种名称1', '机种名称2', '机种名称3', '机种名称4', '分类', '库位', '状态', '累计出库', '累计回库', '维修次数', '备注'];
    const rows = state.fixtures.map((f) => {
      const lms = Array.isArray(f.lineModels) ? f.lineModels : [];
      return [
        f.code, f.name,
        lms[0] || '', lms[1] || '', lms[2] || '', lms[3] || '',
        f.category || '', f.location || '',
        (FIX_STATUS[f.status] || { label: f.status }).label,
        f.totalOutCount || 0, f.totalReturnCount || 0, f.repairCount || 0, f.remark || ''
      ];
    });
    const csv = '﻿' + [headers.join(','), ...rows.map((r) => r.map((v) => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','))].join('\r\n');
    download('夹具清单_' + new Date().toISOString().slice(0, 10) + '.csv', csv);
  };

  window.fixtureRetire = function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) { toast('夹具不存在', 'err'); return; }
    if (f.status === 'retired') { toast('夹具已报废', 'warn'); return; }
    openModal(`报废 — ${f.code} ${f.name}`, `
      <div class="form-group"><label>夹具</label><input type="text" value="${esc(f.code)} ${esc(f.name)}" disabled></div>
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
            <span class="fixture-code">${esc(f.code)}</span>
            <span class="status-badge status-${status.cls}">${status.label}</span>
          </div>
          <div class="fixture-card-body">
            <div class="fixture-name">${esc(f.name)}</div>
            <div class="fixture-spec">机种：${esc(formatLineModels(f, '—'))}</div>
            <div class="fixture-meta"><span>出库 ${f.totalOutCount || 0} 次</span><span>回库 ${f.totalReturnCount || 0} 次</span></div>
          </div>
          <div class="fixture-card-footer">
            ${f.status === 'stocked' ? `
              <button class="btn sm" onclick="event.stopPropagation(); fixtureOut(${f.id})">出库</button>
              <button class="btn sm" onclick="event.stopPropagation(); fixtureRepair(${f.id})">送修</button>
            ` : ''}
            ${f.status === 'checked_out' ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureReturn(${f.id})">回库</button>` : ''}
            ${f.status === 'repair' ? `<button class="btn sm primary" onclick="event.stopPropagation(); fixtureRepairComplete(${f.id})">维修完成</button>` : ''}
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
        <thead><tr><th>编号</th><th>名称</th><th>机种名称</th><th>分类</th><th>库位</th><th>状态</th><th>累计出库</th><th>累计回库</th><th>操作</th></tr></thead>
        <tbody>
          ${fixtures.map((f) => {
            const st = FIX_STATUS[f.status] || { label: f.status, cls: 'muted' };
            const isSelected = f.id === selectedId;
            return `<tr class="${isSelected ? 'selected' : ''}" data-id="${f.id}" onclick="fixtureSelect(${f.id})">
              <td>${esc(f.code)}</td><td>${esc(f.name)}</td><td>${esc(formatLineModels(f, '—'))}</td>
              <td>${esc(f.category)}</td><td>${esc(f.location)}</td>
              <td><span class="badge ${st.cls}">${st.label}</span></td>
              <td>${f.totalOutCount || 0}</td><td>${f.totalReturnCount || 0}</td>
              <td><span class="row-actions">
                ${f.status === 'stocked' ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureOut(${f.id})">出库</button><button class="btn sm" onclick="event.stopPropagation(); fixtureRepair(${f.id})">送修</button>` : ''}
                ${f.status === 'checked_out' ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureReturn(${f.id})">回库</button>` : ''}
                ${f.status === 'repair' ? `<button class="btn sm primary" onclick="event.stopPropagation(); fixtureRepairComplete(${f.id})">维修完成</button>` : ''}
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
          <div>类型</div><div>夹具</div><div>状态</div><div>经办人</div><div>领用人</div><div>时间</div><div>备注</div>
        </div>
        ${filtered.map((t) => {
          const tc = FIX_TX_TYPE[t.type] || { label: t.type, icon: '📋' };
          const fs = FIX_STATUS[t.fromStatus] || { label: t.fromStatus };
          const ts = FIX_STATUS[t.toStatus] || { label: t.toStatus };
          return `
            <div class="tx-row">
              <div class="tx-type">${tc.icon} ${tc.label}</div>
              <div class="tx-fixture">${esc(t.fixtureCode)} ${esc(t.fixtureName)}</div>
              <div class="tx-status">${fs.label} → ${ts.label}</div>
              <div class="tx-operator">${esc(t.operator || '-')}</div>
              <div class="tx-party">${esc(t.counterparty || '-')}</div>
              <div class="tx-time">${fmtTime(t.time)}</div>
              <div class="tx-remark">${esc(t.remark || '-')}</div>
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
        <div class="search-bar"><input type="text" id="fix_search" placeholder="搜索编号/名称/规格/库位..." oninput="fixtureSearch()"></div>
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
            在「编号 / 名称 / 机种名称 / 库位」任一栏输入即可互查；同一名称下有多台时，
            在结果区<b>勾选具体编号</b>即可一次出库多台。
          </div>
          <div class="multi-search search-row">
            <div class="input-scan">
              <input type="text" id="out_code" placeholder="编号（扫描枪直接扫码）" oninput="outSearch()">
              <button class="btn-scan" title="拍照扫码" onclick="scanForFixOut()">📷</button>
            </div>
            <input type="text" id="out_name" placeholder="名称（可检索并自动回填）" oninput="outSearch()">
            <input type="text" id="out_spec" placeholder="机种名称" oninput="outSearch()">
            <div class="input-scan">
              <input type="text" id="out_location" placeholder="库位（扫码反查夹具）" oninput="outSearch()">
              <button class="btn-scan" title="拍照扫码" onclick="scanForFixOut()">📷</button>
            </div>
          </div>
          <div class="stock-bar">可出库库存：<b id="out_avail">0</b> 台
            <span class="muted">同种夹具只是编号不同，下方按名称分组显示</span>
          </div>
          <div id="out_candidates" class="pick-list"></div>
          <div id="out_picked_summary" class="picked-summary"><span class="muted">未选择夹具</span></div>
          <div class="fix-form">
            <div class="form-row">
              <div class="form-group">
                <label>出库数量（件）</label>
                <input type="number" id="out_qty" value="1" min="1" step="1" oninput="outQtyChange()">
                <small class="hint">默认 1 件，可手动调整；不能超过上方库存</small>
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
            <div class="form-group">
              <label>备注或用途</label>
              <input type="text" id="out_remark" placeholder="可选备注">
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
            在「编号 / 名称 / 机种名称 / 库位」任一栏输入即可互查已出库夹具；同一名称下有多台时，
            在结果区<b>勾选具体编号</b>即可一次回库多台。
          </div>
          <div class="multi-search search-row">
            <div class="input-scan">
              <input type="text" id="return_code" placeholder="编号（扫描枪直接扫码）" oninput="returnSearch()">
              <button class="btn-scan" title="拍照扫码" onclick="scanForFixReturn()">📷</button>
            </div>
            <input type="text" id="return_name" placeholder="名称（可检索并自动回填）" oninput="returnSearch()">
            <input type="text" id="return_spec" placeholder="机种名称" oninput="returnSearch()">
            <div class="input-scan">
              <input type="text" id="return_location" placeholder="库位（扫码反查夹具）" oninput="returnSearch()">
              <button class="btn-scan" title="拍照扫码" onclick="scanForFixReturn()">📷</button>
            </div>
          </div>
          <div class="stock-bar">待回库：<b id="return_avail">0</b> 台
            <span class="muted">同种夹具只是编号不同，下方按名称分组显示</span>
          </div>
          <div id="return_candidates" class="pick-list"></div>
          <div id="return_picked_summary" class="picked-summary"><span class="muted">未选择夹具</span></div>
          <div class="fix-form">
            <div class="form-row">
              <div class="form-group">
                <label>回库数量（件）</label>
                <input type="number" id="return_qty" value="1" min="1" step="1" oninput="returnQtyChange()">
                <small class="hint">默认 1 件，可手动调整；不能超过上方待回库台数</small>
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
            <div class="form-group">
              <label>备注或用途</label>
              <input type="text" id="return_remark" placeholder="可选备注">
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
                <label class="pick-code" title="${esc(f.name)}">
                  <input type="checkbox" class="${prefix}-pick" data-id="${f.id}" data-gi="${gi}" onchange="${prefix}ToggleOne()">
                  <span class="pick-code-no">${esc(f.code)}</span>
                  <span class="muted">${esc(f.location || '未分配')}</span>
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
        <b>已选 ${list.length} 台</b>
        <span class="summary-codes">${list.map((f) => esc(f.code)).join('、')}</span>
        <span class="muted">${esc(detail)}${list.length > 1 ? '（多台同名夹具，编号如上）' : ''}</span>
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
      toast(`数量不能超过当前可操作 ${max} 台`, 'warn');
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
      (!code || codeLike(f.code, code)) &&
      (!name || (f.name || '').toLowerCase().includes(name)) &&
      (!lm || lineModelsMatch(f, lm)) &&
      (!location || (f.location || '').toLowerCase().includes(location))
    );
    state.outAvailable = filtered.length;
    const availEl = $('#out_avail'); if (availEl) availEl.textContent = String(filtered.length);
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
    const remark = ($('#out_remark') || {}).value.trim();
    if (!operator) { toast('请填写经办人', 'err'); return; }
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        await DB.fixtureAddTransaction({ fixtureId: id, type: 'out', operator, counterparty, time, remark });
        ok++;
      } catch (e) { fail++; }
    }
    await reloadAll();
    // 只清理本次的选择结果，保留经办人/领用人/时间便于连续录入
    clearPickState('out');
    const remarkEl = $('#out_remark'); if (remarkEl) remarkEl.value = '';
    outSearch();
    if (ok) toast(`出库成功 ${ok} 台${fail ? `，失败 ${fail} 台` : ''}`, fail ? 'warn' : 'ok');
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
      (!code || codeLike(f.code, code)) &&
      (!name || (f.name || '').toLowerCase().includes(name)) &&
      (!lm || lineModelsMatch(f, lm)) &&
      (!location || (f.location || '').toLowerCase().includes(location))
    );
    state.returnAvailable = filtered.length;
    const availEl = $('#return_avail'); if (availEl) availEl.textContent = String(filtered.length);
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
    const remark = ($('#return_remark') || {}).value.trim();
    if (!operator) { toast('请填写经办人', 'err'); return; }
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        await DB.fixtureAddTransaction({ fixtureId: id, type: 'return', operator, counterparty, time, remark });
        ok++;
      } catch (e) { fail++; }
    }
    await reloadAll();
    clearPickState('return');
    const remarkEl = $('#return_remark'); if (remarkEl) remarkEl.value = '';
    returnSearch();
    if (ok) toast(`回库成功 ${ok} 台${fail ? `，失败 ${fail} 台` : ''}`, fail ? 'warn' : 'ok');
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

    // 按库位聚合（以其适配器用的 KEY 存储），统计件数与「异常」件数（出库/维修视为需关注）
    const locs = {};
    state.fixtures.forEach((f) => { const k = f.location || LOC_UNASSIGNED; locs[k] = (locs[k] || 0) + 1; });
    const locKeys = locSort(Object.keys(locs));
    const filter = state.locFilter;

    let list = state.fixtures.slice();
    if (filter) list = list.filter((f) => (f.location || LOC_UNASSIGNED) === filter);
    list.sort((a, b) => natCompare(a.code, b.code));

    // 重渲染前保留纵向滚动位置，避免点选库位后跳回开头
    let prevScroll = 0;
    const prevGrid = $('.loc-grid10');
    if (prevGrid) prevScroll = prevGrid.scrollTop;

    const cards = locKeys.length ? locKeys.map((k) => {
      const cnt = locs[k];
      const abnormal = state.fixtures.filter((f) => (f.location || LOC_UNASSIGNED) === k && (f.status === 'checked_out' || f.status === 'repair')).length;
      const active = k === filter;
      const isUn = k === LOC_UNASSIGNED;
      const tip = `库位 ${k}：${cnt} 件${abnormal ? '，' + abnormal + ' 件不在库（出库/维修中）' : ''}`;
      return `<button type="button" class="loc-card ${active ? 'active' : ''} ${isUn ? 'unassigned' : ''}" data-loc="${esc(k)}" onclick="selectLocation(this.dataset.loc)" title="${esc(tip)}">
        <span class="loc-card-no">${esc(k)}</span>
      </button>`;
    }).join('') : `<div class="empty" style="grid-column:1/-1;">暂无库位信息</div>`;

    const html = `
      <div class="loc-split">
        <div class="panel loc-top">
          <div class="panel-title">库位总览（10 列网格 · 三行可视 · 上下滑动浏览，点击查看明细）</div>
          <div class="loc-grid10">${cards}</div>
          <div class="loc-top-bar">
            ${filter
              ? `<button class="btn sm ghost" onclick="selectLocation('')">清除筛选</button><span class="ml">当前库位：<b>${esc(filter)}</b>（${list.length} 件）</span>`
              : '<span class="muted">未选择库位，下方显示全部夹具</span>'}
            <span class="spacer"></span>
            <button class="btn ghost sm" onclick="exportFixtureLocationCSV()">📋 手工盘点（导出 CSV）</button>
          </div>
          <div class="tip mt">点击库位卡片可在下方查看该库位对应的夹具明细；在「夹具管理」中编辑夹具可修改其库位。</div>
        </div>
        <div class="panel loc-bottom" style="margin-bottom:0">
          <div class="panel-title">${filter ? '库位「' + esc(filter) + '」下夹具' : '全部夹具'}（${list.length} 件）</div>
          <div class="table-wrap"><table>
            <thead><tr><th>编号</th><th>名称</th><th>机种名称</th><th>分类</th><th>库位</th><th>状态</th><th>累计出库</th><th>最近动态</th></tr></thead>
            <tbody>
              ${list.length ? list.map((f) => {
                const st = FIX_STATUS[f.status] || { label: f.status, cls: 'muted' };
                return `<tr>
                  <td>${esc(f.code)}</td><td>${esc(f.name)}</td><td>${esc(formatLineModels(f, '—'))}</td>
                  <td>${esc(f.category)}</td><td>${esc(f.location)}</td>
                  <td><span class="badge ${st.cls}">${st.label}</span></td>
                  <td>${f.totalOutCount || 0}</td><td>${esc(lastMove(f.id))}</td></tr>`;
              }).join('') : `<tr><td colspan="8" class="empty">无夹具</td></tr>`}
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
    list.sort((a, b) => natCompare(a.code, b.code));

    openModal('手工盘点 — 导出 CSV', `
      <div class="form-group"><label>盘点范围</label>
        <input type="text" value="${filter ? esc(filter) + '（' + list.length + ' 件）' : '全部夹具（' + list.length + ' 件）'}" disabled></div>
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
    list.sort((a, b) => natCompare(a.code, b.code));

    const headers = ['编号', '名称', '机种名称', '分类', '库位', '状态', '累计出库', '累计回库', '最近动态', '盘点人', '实盘数量'];
    const rows = list.map((f) => [
      f.code, f.name, formatLineModels(f, ''), f.category || '', f.location || '',
      (FIX_STATUS[f.status] || { label: f.status }).label,
      f.totalOutCount || 0, f.totalReturnCount || 0, lastMove(f.id), op, ''
    ]);
    const csv = '\uFEFF' + [headers.join(','), ...rows.map((r) =>
      r.map((v) => (/[",\n\r]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v))).join(',')
    )].join('\r\n');
    download('夹具手工盘点_' + new Date().toISOString().slice(0, 10) + (filter ? '_' + filter : '') + '.csv', csv);
    toast('已导出 ' + list.length + ' 件', 'ok');
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
        <div class="search-bar"><input type="text" id="rec_search" placeholder="搜索编号/名称/经办人...（支持 SPMS1|2001 二维码前缀）" oninput="searchRecords()"></div>
        <div id="rec_list"></div>
      </div>
    `;
    imeGuard($('#rec_search'), searchRecords);
    renderAllRecords(state.fixTransactions);
  }

  window.searchRecords = function () {
    let raw = ($('#rec_search') || {}).value.trim();
    // 兼容二维码前缀：SPMS1|2001 / SPMS|2001
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
          <div>类型</div><div>夹具</div><div>状态</div><div>经办人</div><div>领用人</div><div>时间</div><div>备注</div>
        </div>
        ${txs.map((t) => {
          const tc = FIX_TX_TYPE[t.type] || { label: t.type, icon: '📋' };
          const fs = FIX_STATUS[t.fromStatus] || { label: t.fromStatus };
          const ts = FIX_STATUS[t.toStatus] || { label: t.toStatus };
          return `
            <div class="tx-row">
              <div class="tx-type">${tc.icon} ${tc.label}</div>
              <div class="tx-fixture">${esc(t.fixtureCode)} ${esc(t.fixtureName)}</div>
              <div class="tx-status">${fs.label} → ${ts.label}</div>
              <div class="tx-operator">${esc(t.operator || '-')}</div>
              <div class="tx-party">${esc(t.counterparty || '-')}</div>
              <div class="tx-time">${fmtTime(t.time)}</div>
              <div class="tx-remark">${esc(t.remark || '-')}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
    container.innerHTML = html;
  }

  /* ============================================================
   * 夹具查询（多条件组合检索：编号/名称/机种/库位/状态/借用人/关联设备）
   * 沿用夹具列表的 panel / table-wrap / badge 风格，结果可直接查看详情或在库位中定位
   * ============================================================ */
  function renderQuery() {
    const container = $('#content');
    if (!container) return;
    const q = state.query;
    const locations = uniqueSorted(state.fixtures.map((f) => f.location || LOC_UNASSIGNED));
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

    container.innerHTML = `
      <div class="panel">
        <div class="panel-title">🔎 夹具查询
          <span class="panel-actions"><span id="query_count" class="muted"></span></span>
        </div>
        <div class="query-bar">
          <div class="query-field"><label>关键字</label><input type="text" id="q_keyword" placeholder="编号/名称/机种/库位/责任人…" value="${esc(q.keyword)}" oninput="queryApply()"></div>
          <div class="query-field"><label>编号</label><input type="text" id="q_code" placeholder="如 2001" value="${esc(q.code)}" oninput="queryApply()"></div>
          <div class="query-field"><label>名称/规格</label><input type="text" id="q_name" placeholder="名称或机种" value="${esc(q.name)}" oninput="queryApply()"></div>
          <div class="query-field"><label>存放位置</label><select id="q_location" class="query-select" onchange="queryApply()">${locOpts}</select></div>
          <div class="query-field"><label>关联设备/产品</label><select id="q_lm" class="query-select" onchange="queryApply()">${lmOpts}</select></div>
          <div class="query-field"><label>借用人</label><select id="q_borrower" class="query-select" onchange="queryApply()">${brOpts}</select></div>
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
                ${sortOpt('code')}${sortOpt('name')}${sortOpt('status')}${sortOpt('time')}
              </select>
              <button type="button" class="btn sm ghost" onclick="querySortDir()" id="q_sortdir" title="切换升/降序">${q.sortDir === 'asc' ? '↑' : '↓'}</button>
            </div>
          </div>
          <div class="query-field"><label>&nbsp;</label>
            <button type="button" class="btn sm ghost" onclick="queryReset()">重置筛选</button>
          </div>
        </div>
        <div class="tip">支持多条件组合；状态可多选；「关联设备/产品」即夹具关联机种。点击表头可排序。</div>
        <div id="query_results"></div>
      </div>
    `;
    imeGuard($('#q_keyword'), queryApply);
    const sd = $('#q_sortdir'); if (sd) sd.textContent = q.sortDir === 'asc' ? '↑' : '↓';
    queryApply();
  }

  /* 应用筛选条件，返回结果数组（不触及 DOM） */
  function applyQueryFilters(q) {
    const kw = (q.keyword || '').trim().toLowerCase();
    const code = (q.code || '').trim();
    const name = (q.name || '').trim().toLowerCase();
    const location = q.location || '';
    const lineModel = (q.lineModel || '').trim().toLowerCase();
    const borrower = q.borrower || '';
    const statuses = q.statuses || [];
    let list = state.fixtures.filter((f) => {
      if (kw) {
        const hit = codeLike(f.code, kw) ||
          (f.name || '').toLowerCase().includes(kw) ||
          lineModelsMatch(f, kw) ||
          (f.category || '').toLowerCase().includes(kw) ||
          (f.location || '').toLowerCase().includes(kw) ||
          (fixtureResponsible(f) || '').toLowerCase().includes(kw);
        if (!hit) return false;
      }
      if (code && !codeLike(f.code, code)) return false;
      if (name) {
        if (!((f.name || '').toLowerCase().includes(name) || lineModelsMatch(f, name))) return false;
      }
      if (location && (f.location || LOC_UNASSIGNED) !== location) return false;
      if (statuses.length && !statuses.includes(f.status)) return false;
      if (borrower) {
        if (f.status !== 'checked_out') return false;
        if (fixtureCurrentBorrower(f).indexOf(borrower) < 0) return false;
      }
      if (lineModel && !lineModelsMatch(f, lineModel)) return false;
      return true;
    });
    const dir = q.sortDir === 'desc' ? -1 : 1;
    const sb = q.sortBy;
    list.sort((a, b) => {
      let cmp = 0;
      if (sb === 'code') cmp = natCompare(a.code, b.code);
      else if (sb === 'name') cmp = natCompare(a.name, b.name);
      else if (sb === 'status') cmp = natCompare(a.status, b.status);
      else if (sb === 'time') cmp = fixtureLastTime(a) - fixtureLastTime(b);
      return cmp * dir;
    });
    return list;
  }

  function renderQueryResults(list) {
    const box = $('#query_results');
    if (!box) return;
    const cnt = $('#query_count');
    if (cnt) cnt.textContent = '命中 ' + list.length + ' / ' + state.fixtures.length + ' 件';
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
          ${thSort('code', '编号')}${thSort('name', '名称')}<th>关联机种</th><th>分类</th><th>当前位置</th><th>责任人/借用人</th>
          ${thSort('status', '状态')}${thSort('time', '最近操作时间')}<th>操作</th>
        </tr></thead>
        <tbody>
          ${list.map((f) => {
            const st = FIX_STATUS[f.status] || { label: f.status, cls: 'muted' };
            const canLocate = !!f.location && f.status !== 'retired';
            return `<tr>
              <td>${esc(f.code)}</td>
              <td>${esc(f.name)}</td>
              <td>${esc(formatLineModels(f, '—'))}</td>
              <td>${esc(f.category || '—')}</td>
              <td>${esc(fixtureLocationLabel(f))}</td>
              <td>${esc(fixtureResponsible(f))}</td>
              <td><span class="badge ${st.cls}">${st.label}</span></td>
              <td>${esc(lastMove(f.id))}</td>
              <td><span class="row-actions">
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
    state.query = { keyword: '', code: '', name: '', location: '', lineModel: '', borrower: '', statuses: [], sortBy: 'code', sortDir: 'asc' };
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
      <div class="form-group"><label>编号</label><input type="text" value="${esc(f.code)}" disabled></div>
      <div class="form-group"><label>名称</label><input type="text" value="${esc(f.name)}" disabled></div>
      <div class="form-group"><label>机种名称</label><input type="text" value="${esc(formatLineModels(f, '—'))}" disabled></div>
      <div class="form-group"><label>分类</label><input type="text" value="${esc(f.category || '—')}" disabled></div>
      <div class="form-group"><label>存放位置（库位）</label><input type="text" value="${esc(f.location || '（未分配）')}" disabled></div>
      <div class="form-group"><label>当前所在位置</label><input type="text" value="${esc(loc)}" disabled></div>
      <div class="form-group"><label>责任人/借用人</label><input type="text" value="${esc(holder)}" disabled></div>
      <div class="form-group"><label>状态</label><input type="text" value="${esc(st.label)}" disabled></div>
      <div class="form-group"><label>累计出库 / 回库</label><input type="text" value="${esc((f.totalOutCount || 0) + ' / ' + (f.totalReturnCount || 0))}" disabled></div>
      ${f.remark ? `<div class="form-group"><label>备注</label><input type="text" value="${esc(f.remark)}" disabled></div>` : ''}
      ${canLocate ? `<div class="form-actions"><button class="btn" onclick="queryGotoLocationById(${f.id})">🗺 在库位管理中定位</button></div>` : ''}
      <div class="panel-title mt">最近动态</div>
      <div id="q_detail_tx"></div>
    `;
    openModal('夹具详情 · ' + f.code + ' ' + f.name, html);
    renderFixTransactions($('#q_detail_tx'), state.fixTransactions, id);
  };

  window.queryGotoLocationById = function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    closeModal();
    if (f && f.location) state.locFilter = f.location;
    showView('location');
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
  const QR_PREFIX = 'SPMS1|';
  function makeQRToken(f) { return QR_PREFIX + (f && f.code ? f.code : ''); }
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
    openModal('夹具二维码 · ' + f.code, `
      <div class="qr-block">
        <canvas id="qrCanvas" class="qr-canvas"></canvas>
        <div class="qr-info">
          <div><b>编号：</b>${esc(f.code)}</div>
          <div><b>名称：</b>${esc(f.name)}</div>
          <div><b>机种名称：</b>${esc(formatLineModels(f, '—'))}</div>
          <div><b>库位：</b>${esc(f.location || '（未分配）')}</div>
          <div class="muted">二维码内容：${esc(token)}</div>
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

  function labelCardHTML(f) {
    const token = makeQRToken(f);
    return `<div class="label-card">
      <canvas class="label-qr" data-token="${esc(token)}"></canvas>
      <div class="label-text">
        <div class="lc-code">${esc(f.code)}</div>
        <div class="lc-name">${esc(f.name)}</div>
        <div class="lc-lineModels">机种：${esc(formatLineModels(f, '—'))}</div>
        <div class="lc-loc">库位：${esc(f.location || '—')}</div>
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
    buildPrintModal('打印标签 · ' + f.code, [f]);
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
    // 剥前缀：SPMS1|<code> 或 SPMS|<code>，容忍竖线两侧空格与大小写
    s = s.replace(/^SPMS1?\s*\|\s*/i, '');
    // 归一化：忽略连字符/下划线/空格，统一大写
    const code = s.replace(/[-_\s]/g, '').toUpperCase();
    if (/^\d{4}$/.test(code)) return code;
    return null;
  };

  /* 扫码命中：自动填入编号并勾选该台（不再额外弹窗，与新表单流程统一） */
  function scanPickOne(code, type) {
    const f = state.fixtures.find((x) => x.code === code);
    if (!f) { toast('未找到夹具 ' + code, 'err'); return; }
    const want = type === 'out' ? 'stocked' : 'checked_out';
    if (f.status !== want) {
      toast(type === 'out' ? '夹具 ' + f.code + ' 不在库' : '夹具 ' + f.code + ' 未出库', 'err');
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
    toast('已选中 ' + f.code, 'ok');
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
    const html = `
      <div class="form-group"><label>夹具</label><input type="text" value="${esc(f.code)} ${esc(f.name)}" disabled></div>
      <div class="form-group"><label>经办人</label><input type="text" id="fix_return_op" placeholder="经办人（拼音联想）"></div>
      <div class="form-group"><label>回库时间</label><input type="datetime-local" id="fix_return_time" value="${nowInput()}"></div>
      <div class="form-group"><label>备注</label><input type="text" id="fix_return_remark" placeholder="可选备注"></div>
      <div class="form-actions">
        <button class="btn primary" onclick="submitFixtureReturn(${id})">确认回库</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    openModal(`回库 — ${f.code} ${f.name}`, html);
  };

  window.submitFixtureReturn = async function (id) {
    const operator = ($('#fix_return_op') || {}).value.trim();
    const time = inputToMs($('#fix_return_time').value);
    const remark = ($('#fix_return_remark') || {}).value.trim();
    if (!operator) { toast('请填写经办人', 'err'); return; }
    try {
      await DB.fixtureAddTransaction({ fixtureId: id, type: 'return', operator, time, remark });
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
      <div class="form-group"><label>夹具</label><input type="text" value="${esc(f.code)} ${esc(f.name)}" disabled></div>
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
    openModal(`送修 — ${f.code} ${f.name}`, html);
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
    openModal(`维修完成 — ${f.code} ${f.name}`, `
      <div class="form-group"><label>夹具</label><input type="text" value="${esc(f.code)} ${esc(f.name)}" disabled></div>
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
