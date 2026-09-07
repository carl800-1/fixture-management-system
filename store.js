'use strict';
/* ============================================================
 * store.js — 夹具管理系统数据层（Node fs，本地 JSON 文件）
 * ============================================================ */
const fs = require('fs');
const path = require('path');

let DATA_DIR = null;
let data = { fixtures: [], fixTransactions: [], meta: {} };
let loaded = false;
let seq = 1;

function setDataDir(dir) {
  DATA_DIR = dir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function file() { return path.join(DATA_DIR, 'fixture-data.json'); }

function load() {
  if (loaded) return;
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    const j = JSON.parse(raw);
    data = {
      fixtures: j.fixtures || [],
      fixTransactions: j.fixTransactions || [],
      meta: j.meta || {}
    };
    let maxId = 0;
    (j.fixtures || []).forEach((f) => { if (f && f.id > maxId) maxId = f.id; });
    (j.fixTransactions || []).forEach((t) => { if (t && t.id > maxId) maxId = t.id; });
    seq = maxId + 1;
  } catch (e) {
    data = { fixtures: [], fixTransactions: [], meta: {} };
  }
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

module.exports = {
  setDataDir, open, getAll, get, add, put, del, clear, count,
  getByIndex, getByRange, getMeta, setMeta,
  // 夹具管理
  addFixture, updateFixture, delFixture,
  addFixTransaction
};
