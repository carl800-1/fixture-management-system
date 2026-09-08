/* ============================================================
 * db.js v2.1 — 工装夹具出入库管理系统数据层
 * ============================================================ */
const DB = (function () {
  const APP_VERSION = '2.1';
  const electronApi = (typeof window !== 'undefined' && window.api) ? window.api : null;

  if (electronApi) {
    const invoke = (channel, payload) => electronApi.invoke(channel, payload);
    return {
      APP_VERSION,
      open: () => invoke('db-open'),
      getAll: (name) => invoke('db-getAll', name),
      get: (name, id) => invoke('db-get', { name, id }),
      add: (name, item) => invoke('db-add', { name, item }),
      put: (name, item) => invoke('db-put', { name, item }),
      del: (name, id) => invoke('db-del', { name, id }),
      clear: (name) => invoke('db-clear', name),
      count: (name) => invoke('db-count', name),
      getMeta: (key) => invoke('db-getMeta', key),
      setMeta: (key, value) => invoke('db-setMeta', { key, value }),
      // 夹具管理
      fixtureAdd: (fixture) => invoke('fixture-add', fixture),
      fixtureUpdate: (fixture) => invoke('fixture-update', fixture),
      fixtureDel: (id) => invoke('fixture-del', id),
      fixtureGetAll: () => invoke('fixture-getAll'),
      fixtureAddTransaction: (tx) => invoke('fixture-addTransaction', tx),
      fixtureGetTransactions: () => invoke('fixture-getTransactions'),
      currentBackend: () => 'electron-file'
    };
  }

  // 浏览器模式（调试用）
  const LS_FIXTURES = 'fixture_fixtures';
  const LS_FIX_TX = 'fixture_tx';
  const LS_SEQ = 'fixture_seq';
  const LS_META = 'fixture_meta';

  function lsRead(k, def) {
    try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); }
    catch (e) { return def; }
  }
  function lsWrite(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function lsSeq() { let s = lsRead(LS_SEQ, 0) + 1; lsWrite(LS_SEQ, s); return s; }

  async function open() { return; }
  function getAll(name) { return Promise.resolve(name === 'meta' ? lsRead(LS_META, {}) : lsRead(name, [])); }
  function getMeta(key) { const m = lsRead(LS_META, {}); return m[key] != null ? m[key] : null; }
  function setMeta(key, value) { const m = lsRead(LS_META, {}); m[key] = value; lsWrite(LS_META, m); }

  async function fixtureAdd(fixture) {
    const fixtures = lsRead(LS_FIXTURES, []);
    if (fixtures.some((f) => f.code === fixture.code)) throw new Error('编号已存在');
    fixture.id = lsSeq();
    fixture.qrToken = 'SPMS1|' + fixture.code;
    fixture.status = 'stocked';
    fixture.totalOutCount = 0;
    fixture.totalReturnCount = 0;
    fixture.repairCount = 0;
    fixture.createdAt = Date.now();
    fixture.updatedAt = Date.now();
    fixtures.push(fixture);
    lsWrite(LS_FIXTURES, fixtures);
    return fixture.id;
  }

  async function fixtureUpdate(fixture) {
    const fixtures = lsRead(LS_FIXTURES, []);
    const i = fixtures.findIndex((f) => f.id === fixture.id);
    if (i < 0) throw new Error('夹具不存在');
    fixture.updatedAt = Date.now();
    fixtures[i] = fixture;
    lsWrite(LS_FIXTURES, fixtures);
    return fixture.id;
  }

  async function fixtureDel(id) {
    const fixtures = lsRead(LS_FIXTURES, []);
    lsWrite(LS_FIXTURES, fixtures.filter((f) => f.id !== id));
  }

  async function fixtureGetAll() { return lsRead(LS_FIXTURES, []); }
  async function fixtureGetTransactions() { return lsRead(LS_FIX_TX, []); }

  async function fixtureAddTransaction(tx) {
    const fixtures = lsRead(LS_FIXTURES, []);
    const i = fixtures.findIndex((f) => f.id === tx.fixtureId);
    if (i < 0) throw new Error('夹具不存在');
    const fixture = fixtures[i];

    if (tx.type === 'out' && fixture.status !== 'stocked') {
      throw new Error('夹具当前不在库，无法出库');
    }
    if (tx.type === 'return' && fixture.status !== 'checked_out') {
      throw new Error('夹具未处于已出库状态');
    }
    if (tx.type === 'repair_done' && fixture.status !== 'repair') {
      throw new Error('夹具未处于维修中状态');
    }

    const fromStatus = fixture.status;
    let toStatus = fixture.status;
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
    lsWrite(LS_FIXTURES, fixtures);

    const record = {
      id: lsSeq(),
      fixtureId: fixture.id,
      fixtureCode: fixture.code,
      fixtureName: fixture.name,
      type: tx.type,
      operator: tx.operator || '',
      counterparty: tx.counterparty || '',
      time: tx.time,
      remark: tx.remark || '',
      repairType: tx.repairType || '',
      fromStatus,
      toStatus,
      createdAt: Date.now()
    };
    const txs = lsRead(LS_FIX_TX, []);
    txs.push(record);
    lsWrite(LS_FIX_TX, txs);
    return record.id;
  }

  return {
    APP_VERSION,
    open, getAll, get, getMeta, setMeta,
    fixtureAdd, fixtureUpdate, fixtureDel,
    fixtureGetAll, fixtureGetTransactions, fixtureAddTransaction,
    currentBackend: () => 'browser'
  };
})();
