/* ============================================================
 * db.js v3.0.1 — 工装夹具管理程序数据层
 * ============================================================ */
const DB = (function () {
  const APP_VERSION = '3.0.1';
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
      // 产线配置（v3.0.1）
      lineDel: (id) => invoke('line-del', id),
      productDel: (id) => invoke('product-del', id),
      stationDel: (id) => invoke('station-del', id),
      setStationFixtures: (payload) => invoke('set-station-fixtures', payload),
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
  function get(name, id) {
    if (name === 'meta') return Promise.resolve(getMeta(id));
    return Promise.resolve(lsRead(name, []).find((x) => x.id === id) || null);
  }
  /* 通用 CRUD（与主进程 store.js 同名同语义，供产线配置等集合复用） */
  function add(name, item) {
    const arr = lsRead(name, []);
    item.id = lsSeq();
    arr.push(item);
    lsWrite(name, arr);
    return Promise.resolve(item.id);
  }
  function put(name, item) {
    const arr = lsRead(name, []);
    const i = arr.findIndex((x) => x.id === item.id);
    if (i >= 0) arr[i] = item; else arr.push(item);
    lsWrite(name, arr);
    return Promise.resolve(item.id);
  }
  function del(name, id) {
    lsWrite(name, lsRead(name, []).filter((x) => x.id !== id));
    return Promise.resolve();
  }
  function clearColl(name) { lsWrite(name, []); return Promise.resolve(); }

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

  /* ---- 产线配置（v3.0.1）：与主进程 store.js 语义保持一致 ---- */
  async function lineDel(id) {
    const pidSet = new Set(lsRead('products', []).filter((p) => p.lineId === id).map((p) => p.id));
    const stSet = new Set(lsRead('stations', []).filter((s) => s.lineId === id).map((s) => s.id));
    lsWrite('stationFixtures', lsRead('stationFixtures', [])
      .filter((sf) => !pidSet.has(sf.productId) && !stSet.has(sf.stationId)));
    lsWrite('products', lsRead('products', []).filter((p) => p.lineId !== id));
    lsWrite('stations', lsRead('stations', []).filter((s) => s.lineId !== id));
    lsWrite('lines', lsRead('lines', []).filter((l) => l.id !== id));
  }
  async function productDel(id) {
    lsWrite('stationFixtures', lsRead('stationFixtures', []).filter((sf) => sf.productId !== id));
    lsWrite('products', lsRead('products', []).filter((p) => p.id !== id));
  }
  async function stationDel(id) {
    lsWrite('stationFixtures', lsRead('stationFixtures', []).filter((sf) => sf.stationId !== id));
    lsWrite('stations', lsRead('stations', []).filter((s) => s.id !== id));
  }
  async function setStationFixtures(payload) {
    const { productId, stationId } = payload;
    const codes = Array.isArray(payload.codes) ? payload.codes : [];
    const rest = lsRead('stationFixtures', [])
      .filter((sf) => !(sf.productId === productId && sf.stationId === stationId));
    codes.forEach((c) => {
      const code = String(c == null ? '' : c).trim();
      if (!code) return;
      rest.push({ id: lsSeq(), productId, stationId, fixtureCode: code });
    });
    lsWrite('stationFixtures', rest);
    return rest.length;
  }

  return {
    APP_VERSION,
    open, getAll, get, add, put, del, getMeta, setMeta,
    clear: clearColl,
    fixtureAdd, fixtureUpdate, fixtureDel,
    fixtureGetAll, fixtureGetTransactions, fixtureAddTransaction,
    lineDel, productDel, stationDel, setStationFixtures,
    currentBackend: () => 'browser'
  };
})();
