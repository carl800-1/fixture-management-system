'use strict';
/* ============================================================
 * store.js — 工装夹具管理程序数据层（Node fs，本地 JSON 文件）v4.0.4
 * ============================================================ */
const fs = require('fs');
const path = require('path');

let DATA_DIR = null;
let data = { fixtures: [], fixTransactions: [], meta: {} };
let loaded = false;
let seq = 1;

/* 数据集合清单：新增集合只需在此登记，load / save / 通用 CRUD 自动覆盖。
 * v4.0.0 起业务表收敛为 3 张 + 1 张候选字典 + 1 张流水：
 *   fixture    { id, code, serialNo, name, lineModels[], lines[], stations[], location, ... }
 *   line       { id, name, type:'linear'|'u', remark }
 *   station    { id, lineId, seq, name, remark }
 *   production { id, name, order }          ← 机种候选字典（不隶属线体）
 *   fixTransaction { ... }                  ← 出入库/维修流水
 *
 * ⚠️ v4.0.0 已废弃 stationFixtures（工位↔夹具绑定改为 fixtures.stations 扁平字段）、
 *    已废弃 products（改为 productions，且不再隶属线体）。旧数据文件自动迁移。
 */
const COLLECTIONS = ['fixtures', 'fixTransactions', 'lines', 'productions', 'stations'];

/* ---------------- 业务上限与格式约束（与文档第七节一致） ---------------- */
const MAX_LINE_MODELS = 7;    // 一件夹具最多关联机种数（原 4）
const MAX_LINES = 5;          // 一件夹具最多涉及产线数
const MAX_STATIONS = 10;      // 一件夹具最多安装工位数
const MAX_SERIAL_NO = 64;     // 实物夹具编号最大字符数
const MAX_LOCATION = 20;      // 库位号最大字符数（真实样例 ZP1-U-1-1 = 10）
/* 库位号形态：4 段、短横线分隔、每段非空（如 ZP1-U-1-1 / ZP10-U-12-15） */
const LOCATION_RE = /^[A-Za-z0-9]+(-[A-Za-z0-9]+){3}$/;

function emptyData() {
  const d = { meta: {} };
  COLLECTIONS.forEach((c) => { d[c] = []; });
  return d;
}

function setDataDir(dir) {
  DATA_DIR = dir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function file() { return path.join(DATA_DIR, 'fixture-data.json'); }

/* ---------------- 字段校验（导出给 UI 复用，保证两侧口径一致） ---------------- */
/* 编号归一化：忽略大小写 / 连字符 / 下划线 / 空格，用于扫码枪录入差异容错 */
function normalizeCode(str) {
  return String(str == null ? '' : str)
    .replace(/^SPMS1?\s*\|\s*/i, '')   // 兼容旧二维码前缀（v4.0.2 起二维码内容已是纯序号）
    .replace(/[\s\-_]/g, '')
    .toUpperCase();
}
/* 编号等值比较：归一化后比较（建档判重、扫码命中统一走这里） */
function codeEq(a, b) { return normalizeCode(a) === normalizeCode(b); }

/* 桥梁编号：4 位纯数字（自动分配，用户不可填） */
function isBridgeCode(c) { return typeof c === 'string' && /^\d{4}$/.test(c); }
/* 实物夹具编号：手动输入，允许重复（同机种多套共用一个编号），禁 | 与换行 */
function isValidSerialNo(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t || t.length > MAX_SERIAL_NO) return false;
  return !/[|\r\n]/.test(t);
}
/* 库位号：4 段式、≤20 字符 */
function isValidLocation(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t || t.length > MAX_LOCATION) return false;
  return LOCATION_RE.test(t);
}
/* 机种名称：≤30 字符、非空 */
function isValidProductionName(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return !!t && t.length <= 30 && !/[|\r\n]/.test(t);
}

function bad(msg, name) {
  const e = new Error(msg);
  e.name = name || 'ValidationError';
  throw e;
}

/* ---------------- 旧数据迁移（v1.x / v2.x / v3.0.x → v4.0.0） ---------------- */
function migrate() {
  let changed = false;

  // 1) 机种数组：spec / lineNo 合并 → lineModels，上限 4 → 7
  (data.fixtures || []).forEach((f) => {
    if (!Array.isArray(f.lineModels)) {
      const models = [];
      [f.lineNo, f.spec].forEach((v) => {
        const s = typeof v === 'string' ? v.trim() : '';
        if (s && !models.includes(s)) models.push(s);
      });
      f.lineModels = models.slice(0, MAX_LINE_MODELS);
      changed = true;
    }
    if (f.lineModels.length > MAX_LINE_MODELS) { f.lineModels = f.lineModels.slice(0, MAX_LINE_MODELS); changed = true; }
    // 2) v4.0.0 新增扁平关联字段
    if (!Array.isArray(f.lines)) { f.lines = []; changed = true; }
    if (!Array.isArray(f.stations)) { f.stations = []; changed = true; }
    // 3) 实物编号字段
    if (typeof f.serialNo !== 'string') { f.serialNo = ''; changed = true; }
    // 4) qrToken 改为派生值，不再落库（避免与 code 不一致的脏数据）
    if (f.qrToken !== undefined) { delete f.qrToken; changed = true; }
  });

  // 5) products → productions（去掉 lineId / code，按名称去重，保序）
  const raw = data.__rawProducts;
  if (Array.isArray(raw)) {
    const names = [];
    raw.forEach((p) => {
      const n = p && typeof p.name === 'string' ? p.name.trim() : '';
      if (n && !names.includes(n)) names.push(n);
    });
    const exists = new Set((data.productions || []).map((p) => p && p.name));
    names.forEach((n) => {
      if (!exists.has(n)) { data.productions.push({ id: nextId(), name: n, order: data.productions.length + 1 }); exists.add(n); }
    });
    delete data.__rawProducts;
    changed = true;
  }
  (data.productions || []).forEach((p, i) => {
    if (!Number.isFinite(Number(p.order))) { p.order = i + 1; changed = true; }
  });

  // 6) 废弃集合直接丢弃
  if (data.stationFixtures) { delete data.stationFixtures; changed = true; }
  if (data.products) { delete data.products; changed = true; }

  // 7) 补齐缺失的主键 id（旧样本/旧版数据夹具未带 id，会导致编辑/删除/出入库
  //    按 id 查找全部失效 → 卡片「编辑」误开「新建」）。seq 已在 load 阶段按现有
  //    最大 id 初始化，nextId() 不会与现有 id 冲突；已带 id 的条目跳过，幂等。
  COLLECTIONS.forEach((c) => {
    (data[c] || []).forEach((x) => {
      if (x && (x.id == null || typeof x.id !== 'number')) {
        x.id = nextId();
        changed = true;
      }
    });
  });

  return changed;
}

function load() {
  if (loaded) return;
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    const j = JSON.parse(raw);
    data = emptyData();
    // 旧数据文件缺少新集合时退回空数组，向后兼容
    COLLECTIONS.forEach((c) => { if (Array.isArray(j[c])) data[c] = j[c]; });
    if (Array.isArray(j.products)) data.__rawProducts = j.products;   // 迁移用中转
    data.meta = j.meta || {};
    let maxId = 0;
    COLLECTIONS.forEach((c) => {
      data[c].forEach((x) => { if (x && typeof x.id === 'number' && x.id > maxId) maxId = x.id; });
    });
    if (Array.isArray(j.products)) j.products.forEach((x) => { if (x && typeof x.id === 'number' && x.id > maxId) maxId = x.id; });
    seq = maxId + 1;
  } catch (e) {
    data = emptyData();
  }
  if (migrate()) save();
  loaded = true;
}

function save() {
  fs.writeFileSync(file(), JSON.stringify(data, null, 2), 'utf8');
}

function nextId() { return seq++; }

/* 分配下一个空闲 4 位桥梁编号：从 1001 起顺延，填补空洞 */
function nextFreeCode() {
  load();
  const used = new Set((data.fixtures || []).map((f) => String(f.code)));
  let n = 1001;
  while (used.has(String(n))) n++;
  return String(n);
}

function open() { load(); return { ok: true }; }
function getAll(name) { load(); return name === 'meta' ? data.meta : (data[name] || []); }
function get(name, id) {
  load();
  if (name === 'meta') return data.meta[id] != null ? data.meta[id] : null;
  return (data[name] || []).find((x) => x.id === id) || null;
}
/* 按编号（归一化）查找夹具 */
function findFixtureByCode(code) {
  load();
  return (data.fixtures || []).find((f) => codeEq(f.code, code)) || null;
}
function add(name, item) {
  load();
  if (name === 'fixtures') return addFixture(item);
  if (!data[name]) data[name] = [];
  item.id = nextId();
  data[name].push(item);
  save();
  return item.id;
}
function put(name, item) {
  load();
  if (name === 'meta') { data.meta[item.key] = item.value; save(); return item.key; }
  const arr = data[name];
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) arr[i] = item; else arr.push(item);
  save();
  return item.id;
}
function del(name, id) {
  load();
  if (name === 'meta') { delete data.meta[id]; save(); return; }
  if (name === 'productions') return delProduction(id);
  if (name === 'lines') return delLine(id);
  if (name === 'stations') return delStation(id);
  data[name] = data[name].filter((x) => x.id !== id);
  save();
}
function clear(name) {
  load();
  if (name === 'meta') data.meta = {};
  else data[name] = [];
  save();
}
function count(name) { load(); return (data[name] || []).length; }
function getByIndex(name, index, value) { load(); return (data[name] || []).filter((x) => x[index] === value); }
function getByRange(name, index, range) {
  load();
  const lo = range && range.lower != null ? range.lower : -Infinity;
  const hi = range && range.upper != null ? range.upper : Infinity;
  return (data[name] || []).filter((x) => x[index] >= lo && x[index] <= hi);
}
function getMeta(key) { load(); return data.meta[key] != null ? data.meta[key] : null; }
function setMeta(key, value) { load(); data.meta[key] = value; save(); }

/* ============================================================
 * 夹具管理专用函数
 * ============================================================ */

/* 建档前的业务校验（v4.0.0 强校验 7 条里的 5 条落在这里，UI 另有即时校验） */
function validateFixture(f, opts) {
  const skipCode = !!(opts && opts.skipCode);
  if (!skipCode && !isBridgeCode(f.code)) bad('序号必须是 4 位纯数字');
  if (!isValidSerialNo(f.serialNo)) bad('请填写实物夹具编号（≤' + MAX_SERIAL_NO + ' 字符，不能含 | 或换行）');
  if (!f.name || !String(f.name).trim()) bad('请填写夹具名称');
  const lms = Array.isArray(f.lineModels) ? f.lineModels.filter((x) => String(x).trim() !== '') : [];
  if (lms.length > MAX_LINE_MODELS) bad('机种名称最多 ' + MAX_LINE_MODELS + ' 个');
  const lines = Array.isArray(f.lines) ? f.lines : [];
  const sts = Array.isArray(f.stations) ? f.stations : [];
  if (!lines.length) bad('请至少选择 1 条产线');
  if (lines.length > MAX_LINES) bad('一件夹具最多关联 ' + MAX_LINES + ' 条产线');
  if (!sts.length) bad('请至少选择 1 个工位');
  if (sts.length > MAX_STATIONS) bad('一件夹具最多安装 ' + MAX_STATIONS + ' 个工位');
  if (!isValidLocation(f.location)) {
    bad('库位号需为 4 段式（如 ZP1-U-1-1），且不超过 ' + MAX_LOCATION + ' 字符');
  }
  if (f.serialNo !== undefined && f.serialNo !== null && /[|]/.test(String(f.serialNo))) bad('实物编号不能包含竖线');
}

function addFixture(fixture) {
  load();
  const f = Object.assign({}, fixture);
  // 桥梁编号由系统分配；入参给了且未被占用则沿用（导入场景需要保留指定编号）
  if (!isBridgeCode(f.code)) f.code = nextFreeCode();
  else if (data.fixtures.some((x) => String(x.code) === String(f.code))) bad('编号已存在', 'ConstraintError');

  f.serialNo = String(f.serialNo == null ? '' : f.serialNo).trim();
  f.name = String(f.name == null ? '' : f.name).trim();
  const rawLms = dedupeStrings(f.lineModels);
  if (rawLms.length > MAX_LINE_MODELS) bad('机种名称最多 ' + MAX_LINE_MODELS + ' 个');
  f.lineModels = rawLms.slice(0, MAX_LINE_MODELS);
  f.lines = dedupeNumbers(f.lines);
  f.stations = dedupeNumbers(f.stations);
  f.location = String(f.location == null ? '' : f.location).trim();
  f.category = String(f.category == null ? '' : f.category).trim();
  f.remark = String(f.remark == null ? '' : f.remark).trim();

  validateFixture(f);

  f.id = nextId();
  f.status = 'stocked';
  f.totalOutCount = 0;
  f.totalReturnCount = 0;
  f.repairCount = 0;
  f.createdAt = Date.now();
  f.updatedAt = Date.now();
  data.fixtures.push(f);
  save();
  return f.id;
}

function dedupeStrings(arr) {
  const out = [];
  (Array.isArray(arr) ? arr : []).forEach((v) => {
    const s = String(v == null ? '' : v).trim();
    if (s && !out.includes(s)) out.push(s);
  });
  return out;
}
function dedupeNumbers(arr) {
  const out = [];
  (Array.isArray(arr) ? arr : []).forEach((v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  });
  return out;
}

function updateFixture(fixture) {
  load();
  const i = data.fixtures.findIndex((f) => f.id === fixture.id);
  if (i < 0) bad('夹具不存在', 'NotFoundError');
  const old = data.fixtures[i];
  const f = Object.assign({}, old, fixture);
  // code 不可改：改则断流水与绑定
  f.code = old.code;
  f.serialNo = String(f.serialNo == null ? '' : f.serialNo).trim();
  f.name = String(f.name == null ? '' : f.name).trim();
  const rawLms = dedupeStrings(f.lineModels);
  if (rawLms.length > MAX_LINE_MODELS) bad('机种名称最多 ' + MAX_LINE_MODELS + ' 个');
  f.lineModels = rawLms.slice(0, MAX_LINE_MODELS);
  f.lines = dedupeNumbers(f.lines);
  f.stations = dedupeNumbers(f.stations);
  f.location = String(f.location == null ? '' : f.location).trim();
  f.category = String(f.category == null ? '' : f.category).trim();
  f.remark = String(f.remark == null ? '' : f.remark).trim();
  validateFixture(f, { skipCode: true });
  f.updatedAt = Date.now();
  data.fixtures[i] = f;
  save();
  return f.id;
}

function delFixture(id) {
  load();
  data.fixtures = data.fixtures.filter((f) => f.id !== id);
  save();
}

/* 出库：只改 status（派生数量自动减 1），location 冻结保留。
 * 若建档时漏填库位，允许在本次出库补填（补填即「出库必选库位」的落地）。 */
function addFixTransaction(tx) {
  load();
  const i = data.fixtures.findIndex((f) => f.id === tx.fixtureId);
  if (i < 0) bad('夹具不存在', 'NotFoundError');
  const fixture = data.fixtures[i];

  if (tx.type === 'out' && fixture.status !== 'stocked') bad('夹具当前不在库，无法出库');
  if (tx.type === 'return' && fixture.status !== 'checked_out') bad('夹具未处于已出库状态');
  if (tx.type === 'repair' && fixture.status !== 'stocked' && fixture.status !== 'checked_out') bad('夹具当前状态不允许维修登记');
  if (tx.type === 'repair_done' && fixture.status !== 'repair') bad('夹具未处于维修中状态');
  if (tx.type === 'retire' && fixture.status === 'retired') bad('夹具已报废');

  const fromStatus = fixture.status;
  let toStatus = fixture.status;
  const fromLocation = fixture.location || '';
  let toLocation = fromLocation;

  /* ⚠️ 参数校验必须早于任何内存改动：fixture 是 data.fixtures 里的引用，
   * 若先自增计数再抛错，会出现「文件未落盘但内存已脏」的不一致状态。 */
  const wantLoc = String(tx.location == null ? '' : tx.location).trim();
  if (tx.type === 'out' && !fromLocation && !isValidLocation(wantLoc)) {
    bad('该夹具尚未设置库位，请先补填库位号（如 ZP1-U-1-1）');
  }
  // 出库原因校验：仅允许 use / repair / other，缺省按 use（使用）
  const outReason = (tx.outReason === 'repair' || tx.outReason === 'other') ? tx.outReason : 'use';
  const outReasonText = (tx.outReason === 'other') ? (tx.outReasonText || '') : '';
  if (tx.type === 'return' && wantLoc && wantLoc !== fromLocation && !isValidLocation(wantLoc)) {
    bad('库位号需为 4 段式（如 ZP1-U-1-1），且不超过 ' + MAX_LOCATION + ' 字符');
  }

  if (tx.type === 'out') {
    toStatus = 'checked_out';
    fixture.totalOutCount = (fixture.totalOutCount || 0) + 1;
    // 出库原因为「维修」时记一次维修（与 repair 事件一致口径：每次送修出库 +1）
    if (outReason === 'repair') fixture.repairCount = (fixture.repairCount || 0) + 1;
    // 库位为空时必须由本次出库补齐；已有库位则冻结不动
    if (!fromLocation) { fixture.location = wantLoc; toLocation = wantLoc; }
  } else if (tx.type === 'return') {
    toStatus = 'stocked';
    fixture.totalReturnCount = (fixture.totalReturnCount || 0) + 1;
    // 回库预填原库位，允许改；改则写回 location
    if (wantLoc && wantLoc !== fromLocation) { fixture.location = wantLoc; toLocation = wantLoc; }
  } else if (tx.type === 'repair') {
    toStatus = 'repair';
    fixture.repairCount = (fixture.repairCount || 0) + 1;
  } else if (tx.type === 'repair_done') {
    toStatus = 'stocked';
  } else if (tx.type === 'retire') {
    toStatus = 'retired';
  }

  fixture.status = toStatus;
  fixture.updatedAt = Date.now();

  const record = {
    id: nextId(),
    fixtureId: fixture.id,
    fixtureCode: fixture.code,
    fixtureSerialNo: fixture.serialNo || '',
    fixtureName: fixture.name,
    type: tx.type,
    operator: tx.operator || '',
    counterparty: tx.counterparty || '',
    outReason: tx.type === 'out' ? outReason : '',
    outReasonText: tx.type === 'out' ? outReasonText : '',
    time: tx.time,
    remark: tx.remark || '',
    repairType: tx.repairType || '',
    fromStatus: fromStatus,
    toStatus: toStatus,
    fromLocation: fromLocation,
    toLocation: toLocation,
    createdAt: Date.now()
  };

  data.fixTransactions.push(record);
  save();
  return record.id;
}

/* ============================================================
 * 关联维护：产线 / 工位 / 机种
 *
 * v4.0.0 起「夹具 ↔ 工位」「夹具 ↔ 产线」是 fixtures 上的扁平数组字段，
 * 因此删除父级必须遍历 fixtures 全表摘 id（旧版只需清 stationFixtures 少量记录）。
 * ============================================================ */

/* 撤销接口：从某夹具上摘掉一条产线（连带摘掉该产线下的已选工位） */
function removeFixtureLine(code, lineId) {
  load();
  const f = findFixtureByCode(code);
  if (!f) bad('夹具不存在', 'NotFoundError');
  const lid = Number(lineId);
  const stIds = new Set((data.stations || []).filter((s) => s.lineId === lid).map((s) => s.id));
  f.lines = (f.lines || []).filter((x) => Number(x) !== lid);
  f.stations = (f.stations || []).filter((x) => !stIds.has(Number(x)));
  f.updatedAt = Date.now();
  save();
  return { lines: f.lines.length, stations: f.stations.length };
}

/* 撤销接口：从某夹具上摘掉一个工位（产线保留 —— 单条产线允许 0 工位） */
function removeFixtureStation(code, stationId) {
  load();
  const f = findFixtureByCode(code);
  if (!f) bad('夹具不存在', 'NotFoundError');
  const sid = Number(stationId);
  f.stations = (f.stations || []).filter((x) => Number(x) !== sid);
  f.updatedAt = Date.now();
  save();
  return { lines: (f.lines || []).length, stations: f.stations.length };
}

/* 撤销接口：批量（一次导入批次的回滚）——按同一产线批量摘除 */
function removeFixtureLinesByBatch(codes, lineId) {
  load();
  let n = 0;
  (Array.isArray(codes) ? codes : []).forEach((c) => {
    const f = findFixtureByCode(c);
    if (!f) return;
    const before = (f.lines || []).length;
    removeFixtureLine(c, lineId);
    if ((f.lines || []).length < before) n++;
  });
  return n;
}

function delLine(id) {
  load();
  const lid = Number(id);
  const stSet = new Set(data.stations.filter((s) => s.lineId === lid).map((s) => s.id));
  // 从所有夹具上摘掉该产线与其工位
  data.fixtures.forEach((f) => {
    const before = (f.lines || []).length + (f.stations || []).length;
    f.lines = (f.lines || []).filter((x) => Number(x) !== lid);
    f.stations = (f.stations || []).filter((x) => !stSet.has(Number(x)));
    if ((f.lines || []).length + (f.stations || []).length !== before) f.updatedAt = Date.now();
  });
  data.stations = data.stations.filter((s) => s.lineId !== lid);
  data.lines = data.lines.filter((l) => l.id !== lid);
  save();
}

function delStation(id) {
  load();
  const sid = Number(id);
  data.fixtures.forEach((f) => {
    const before = (f.stations || []).length;
    f.stations = (f.stations || []).filter((x) => Number(x) !== sid);
    if ((f.stations || []).length !== before) f.updatedAt = Date.now();
  });
  data.stations = data.stations.filter((s) => s.id !== sid);
  save();
}

/* 删除机种：被 fixtures.lineModels 引用时禁止删除（存的是名称数组，删名即孤立） */
function delProduction(id) {
  load();
  const p = data.productions.find((x) => x.id === id);
  if (!p) return;
  const refs = data.fixtures.filter((f) => (f.lineModels || []).includes(p.name)).length;
  if (refs > 0) {
    const e = new Error('机种「' + p.name + '」仍被 ' + refs + ' 台夹具引用，请先解除关联');
    e.name = 'ConstraintError';
    throw e;
  }
  data.productions = data.productions.filter((x) => x.id !== id);
  save();
}

/* 机种重命名必须批量写穿 fixtures.lineModels（存的是名称数组） */
function renameProduction(id, newName) {
  load();
  if (!isValidProductionName(newName)) bad('机种名称需为 1~30 字符，且不含竖线');
  const name = newName.trim();
  const p = data.productions.find((x) => x.id === id);
  if (!p) bad('机种不存在', 'NotFoundError');
  if (data.productions.some((x) => x.id !== id && x.name === name)) bad('已存在同名机种');
  const old = p.name;
  p.name = name;
  let n = 0;
  data.fixtures.forEach((f) => {
    if (!Array.isArray(f.lineModels)) return;
    const i = f.lineModels.indexOf(old);
    if (i >= 0) { f.lineModels[i] = name; f.updatedAt = Date.now(); n++; }
  });
  save();
  return n;
}

/* 建档时按名称自动补建机种字典（导入场景），已存在则复用 */
function ensureProduction(name) {
  load();
  const n = String(name == null ? '' : name).trim();
  if (!isValidProductionName(n)) return null;
  const hit = data.productions.find((x) => x.name === n);
  if (hit) return hit.id;
  const id = nextId();
  data.productions.push({ id, name: n, order: data.productions.length + 1 });
  save();
  return id;
}

/* ---------------- 只读派生量（数量为派生值，不落库） ---------------- */
/* 在库套数：按实物编号 + 库位分组统计（status === 'stocked'） */
function stockCountBySerial(serialNo, location) {
  load();
  return data.fixtures.filter((f) =>
    f.serialNo === serialNo &&
    f.status === 'stocked' &&
    (location == null || (f.location || '') === location)
  ).length;
}

module.exports = {
  setDataDir, open, getAll, get, add, put, del, clear, count,
  getByIndex, getByRange, getMeta, setMeta,
  // 夹具管理
  addFixture, updateFixture, delFixture, findFixtureByCode,
  addFixTransaction,
  // 关联维护（v4.0.0）
  delLine, delStation, delProduction, renameProduction, ensureProduction,
  removeFixtureLine, removeFixtureStation, removeFixtureLinesByBatch,
  // 校验 / 工具
  nextFreeCode, normalizeCode, codeEq,
  isValidSerialNo, isValidLocation, isValidProductionName, isBridgeCode,
  stockCountBySerial,
  // 常量
  MAX_LINE_MODELS, MAX_LINES, MAX_STATIONS, MAX_SERIAL_NO, MAX_LOCATION, LOCATION_RE,
  COLLECTIONS
};
