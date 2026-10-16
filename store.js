'use strict';
/* ============================================================
 * store.js — 工装夹具管理程序数据层（Node fs，本地 JSON 文件）
 * ============================================================ */
const fs = require('fs');
const path = require('path');

let DATA_DIR = null;
let data = { fixtures: [], fixTransactions: [], meta: {} };
let loaded = false;
let seq = 1;

/* 数据集合清单：新增集合只需在此登记，load / save / 通用 CRUD 自动覆盖。
 * lines / products / stations / stationFixtures 为 v3.0.1 产线配置新增：
 *   line          { id, name, type:'linear'|'u', remark }   // u = U型（历史 'loop' 自动折算）
 *   product       { id, lineId, name, code, remark }
 *   station       { id, lineId, seq, name, remark }
 *   stationFixture{ id, productId, stationId, fixtureCode }  ← 一个工位可有多条（一对多）
 */
const COLLECTIONS = ['fixtures', 'fixTransactions', 'lines', 'products', 'stations', 'stationFixtures'];

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

function migrateFixtureLineModels() {
  let changed = false;
  (data.fixtures || []).forEach((f) => {
    if (!Array.isArray(f.lineModels)) {
      const models = [];
      [f.lineNo, f.spec].forEach((v) => {
        const s = typeof v === 'string' ? v.trim() : '';
        if (s && !models.includes(s)) models.push(s);
      });
      f.lineModels = models.slice(0, 4);
      changed = true;
    }
    // 保证数组长度<=4，且元素为字符串
    if (f.lineModels.length > 4) { f.lineModels = f.lineModels.slice(0, 4); changed = true; }
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
    data.meta = j.meta || {};
    let maxId = 0;
    COLLECTIONS.forEach((c) => {
      data[c].forEach((x) => { if (x && typeof x.id === 'number' && x.id > maxId) maxId = x.id; });
    });
    seq = maxId + 1;
  } catch (e) {
    data = emptyData();
  }
  if (migrateFixtureLineModels()) save();
  loaded = true;
}

function save() {
  fs.writeFileSync(file(), JSON.stringify(data, null, 2), 'utf8');
}

function nextId() { return seq++; }

/* 合法编号：4 位纯数字（如 2001） */
function isValidCode(c) { return typeof c === 'string' && /^\d{4}$/.test(c); }

function open() { load(); return { ok: true }; }
function getAll(name) { load(); return name === 'meta' ? data.meta : (data[name] || []); }
function get(name, id) {
  load();
  if (name === 'meta') return data.meta[id] != null ? data.meta[id] : null;
  return (data[name] || []).find((x) => x.id === id) || null;
}
function add(name, item) {
  load();
  if (name === 'fixtures' && item.code && data.fixtures.some((f) => f.code === item.code)) {
    const e = new Error('编号已存在'); e.name = 'ConstraintError'; throw e;
  }
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
function addFixture(fixture) {
  load();
  if (fixture.code && data.fixtures.some((f) => f.code === fixture.code)) {
    const e = new Error('编号已存在'); e.name = 'ConstraintError'; throw e;
  }
  fixture.id = nextId();
  fixture.qrToken = 'SPMS1|' + fixture.code;
  fixture.status = 'stocked';
  fixture.totalOutCount = 0;
  fixture.totalReturnCount = 0;
  fixture.repairCount = 0;
  fixture.createdAt = Date.now();
  fixture.updatedAt = Date.now();
  data.fixtures.push(fixture);
  save();
  return fixture.id;
}

function updateFixture(fixture) {
  load();
  const i = data.fixtures.findIndex((f) => f.id === fixture.id);
  if (i < 0) throw new Error('夹具不存在');
  fixture.updatedAt = Date.now();
  data.fixtures[i] = fixture;
  save();
  return fixture.id;
}

function delFixture(id) {
  load();
  data.fixtures = data.fixtures.filter((f) => f.id !== id);
  save();
}

function addFixTransaction(tx) {
  load();
  const i = data.fixtures.findIndex((f) => f.id === tx.fixtureId);
  if (i < 0) throw new Error('夹具不存在');
  const fixture = data.fixtures[i];

  // 状态校验
  if (tx.type === 'out' && fixture.status !== 'stocked') {
    throw new Error('夹具当前不在库，无法出库');
  }
  if (tx.type === 'return' && fixture.status !== 'checked_out') {
    throw new Error('夹具未处于已出库状态');
  }
  if (tx.type === 'repair' && fixture.status !== 'stocked' && fixture.status !== 'checked_out') {
    throw new Error('夹具当前状态不允许维修登记');
  }
  if (tx.type === 'repair_done' && fixture.status !== 'repair') {
    throw new Error('夹具未处于维修中状态');
  }
  if (tx.type === 'retire' && fixture.status === 'retired') {
    throw new Error('夹具已报废');
  }

  const fromStatus = fixture.status;
  let toStatus = fixture.status;

  // 更新状态和计数
  if (tx.type === 'out') {
    toStatus = 'checked_out';
    fixture.totalOutCount = (fixture.totalOutCount || 0) + 1;
  } else if (tx.type === 'return') {
    toStatus = 'stocked';
    fixture.totalReturnCount = (fixture.totalReturnCount || 0) + 1;
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

  // 创建流水记录
  const record = {
    id: nextId(),
    fixtureId: fixture.id,
    fixtureCode: fixture.code,
    fixtureName: fixture.name,
    type: tx.type,
    operator: tx.operator || '',
    counterparty: tx.counterparty || '',
    time: tx.time,
    remark: tx.remark || '',
    repairType: tx.repairType || '',
    fromStatus: fromStatus,
    toStatus: toStatus,
    createdAt: Date.now()
  };

  data.fixTransactions.push(record);
  save();
  return record.id;
}

/* ============================================================
 * 产线配置专用函数（v3.0.1）
 * 层级：line ─┬─ product   （产品隶属线体，用于筛选级联）
 *             └─ station   （工位隶属线体，按 seq 排序）
 *   stationFixture 绑定「某产品的某工位 → 一个夹具编号」，一个工位可多条（一对多）。
 *   删除父级时级联清理子级与绑定，避免留下悬空引用。
 * ============================================================ */
function delLine(id) {
  load();
  const pidSet = new Set(data.products.filter((p) => p.lineId === id).map((p) => p.id));
  const stSet = new Set(data.stations.filter((s) => s.lineId === id).map((s) => s.id));
  data.stationFixtures = data.stationFixtures.filter(
    (sf) => !pidSet.has(sf.productId) && !stSet.has(sf.stationId)
  );
  data.products = data.products.filter((p) => p.lineId !== id);
  data.stations = data.stations.filter((s) => s.lineId !== id);
  data.lines = data.lines.filter((l) => l.id !== id);
  save();
}

function delProduct(id) {
  load();
  data.stationFixtures = data.stationFixtures.filter((sf) => sf.productId !== id);
  data.products = data.products.filter((p) => p.id !== id);
  save();
}

function delStation(id) {
  load();
  data.stationFixtures = data.stationFixtures.filter((sf) => sf.stationId !== id);
  data.stations = data.stations.filter((s) => s.id !== id);
  save();
}

/* 覆盖式设置某「产品 × 工位」的夹具绑定（一对多）。
 * 传空数组即清空该工位的配置；整体一次落盘。 */
function setStationFixtures(payload) {
  load();
  const productId = payload.productId;
  const stationId = payload.stationId;
  const codes = Array.isArray(payload.codes) ? payload.codes : [];
  data.stationFixtures = data.stationFixtures.filter(
    (sf) => !(sf.productId === productId && sf.stationId === stationId)
  );
  codes.forEach((c) => {
    const code = String(c == null ? '' : c).trim();
    if (!code) return;
    data.stationFixtures.push({ id: nextId(), productId, stationId, fixtureCode: code });
  });
  save();
  return data.stationFixtures.length;
}

module.exports = {
  setDataDir, open, getAll, get, add, put, del, clear, count,
  getByIndex, getByRange, getMeta, setMeta,
  // 夹具管理
  addFixture, updateFixture, delFixture,
  addFixTransaction,
  // 产线配置（v3.0.1）
  delLine, delProduct, delStation, setStationFixtures
};
