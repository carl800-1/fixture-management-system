/* ============================================================
 * db.js v4.0.1 — 工装夹具管理程序数据层
 *
 * 双后端：
 *   ① Electron：全部走 IPC（主进程 store.js 读写 fixture-data.json）
 *   ② 浏览器调试：localStorage，语义与主进程保持一致
 * 两侧的校验规则、编号分配、级联清理口径必须一致，否则测试与实机行为会漂移。
 * ============================================================ */
const DB = (function () {
  const APP_VERSION = '4.0.1';
  const electronApi = (typeof window !== 'undefined' && window.api) ? window.api : null;

  /* ---------------- 常量（与 store.js 同源） ---------------- */
  const MAX_LINE_MODELS = 7;
  const MAX_LINES = 5;
  const MAX_STATIONS = 10;
  const MAX_SERIAL_NO = 64;
  const MAX_LOCATION = 20;
  const LOCATION_RE = /^[A-Za-z0-9]+(-[A-Za-z0-9]+){3}$/;

  if (electronApi) {
    const invoke = (channel, payload) => electronApi.invoke(channel, payload);
    return {
      APP_VERSION, MAX_LINE_MODELS, MAX_LINES, MAX_STATIONS, MAX_SERIAL_NO, MAX_LOCATION, LOCATION_RE,
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
      nextFreeCode: () => invoke('next-free-code'),
      // 关联维护（v4.0.0）
      lineDel: (id) => invoke('line-del', id),
      stationDel: (id) => invoke('station-del', id),
      productionDel: (id) => invoke('production-del', id),
      productionRename: (payload) => invoke('production-rename', payload),
      removeFixtureLine: (payload) => invoke('fixture-line-remove', payload),
      removeFixtureStation: (payload) => invoke('fixture-station-remove', payload),
      removeFixtureLinesByBatch: (payload) => invoke('fixture-lines-removeBatch', payload),
      /* 纯函数（不依赖后端，两侧行为一致，渲染层也直接调用） */
      normalizeCode: normalizeCode,
      codeEq: codeEq,
      isBridgeCode: isBridgeCode,
      isValidSerialNo: isValidSerialNo,
      isValidLocation: isValidLocation,
      isValidProductionName: isValidProductionName,
      currentBackend: () => 'electron-file'
    };
  }

  /* ================= 浏览器模式（localStorage） ================= */
  const LS_FIXTURES = 'fixture_fixtures';
  const LS_FIX_TX = 'fixture_tx';
  const LS_SEQ = 'fixture_seq';
  const LS_META = 'fixture_meta';

  function lsRead(k, def) {
    try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); }
    catch (e) { return def; }
  }
  function lsWrite(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function lsSeq() { const s = lsRead(LS_SEQ, 0) + 1; lsWrite(LS_SEQ, s); return s; }

  function bad(msg, name) { const e = new Error(msg); e.name = name || 'ValidationError'; throw e; }
  function normalizeCode(str) {
    return String(str == null ? '' : str)
      .replace(/^SPMS1?\s*\|\s*/i, '')
      .replace(/[\s\-_]/g, '')
      .toUpperCase();
  }
  function codeEq(a, b) { return normalizeCode(a) === normalizeCode(b); }
  function isBridgeCode(c) { return typeof c === 'string' && /^\d{4}$/.test(c); }
  function isValidSerialNo(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    if (!t || t.length > MAX_SERIAL_NO) return false;
    return !/[|\r\n]/.test(t);
  }
  function isValidLocation(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    if (!t || t.length > MAX_LOCATION) return false;
    return LOCATION_RE.test(t);
  }
  function isValidProductionName(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    return !!t && t.length <= 30 && !/[|\r\n]/.test(t);
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
  function nextFreeCodeSync() {
    const used = new Set(lsRead(LS_FIXTURES, []).map((f) => String(f.code)));
    let n = 1001;
    while (used.has(String(n))) n++;
    return String(n);
  }

  async function open() { return; }
  function getAll(name) { return Promise.resolve(name === 'meta' ? lsRead(LS_META, {}) : lsRead(name, [])); }
  function getMeta(key) { const m = lsRead(LS_META, {}); return m[key] != null ? m[key] : null; }
  function setMeta(key, value) { const m = lsRead(LS_META, {}); m[key] = value; lsWrite(LS_META, m); }
  function get(name, id) {
    if (name === 'meta') return Promise.resolve(getMeta(id));
    return Promise.resolve(lsRead(name, []).find((x) => x.id === id) || null);
  }
  /* 通用 CRUD（与主进程 store.js 同名同语义，供产线/工位/机种等集合复用） */
  function add(name, item) {
    if (name === 'fixtures') return fixtureAdd(item);
    const arr = lsRead(name, []);
    item.id = lsSeq();
    arr.push(item);
    lsWrite(name, arr);
    return Promise.resolve(item.id);
  }
  function put(name, item) {
    if (name === 'fixtures') return fixtureUpdate(item);
    const arr = lsRead(name, []);
    const i = arr.findIndex((x) => x.id === item.id);
    if (i >= 0) arr[i] = item; else arr.push(item);
    lsWrite(name, arr);
    return Promise.resolve(item.id);
  }
  function del(name, id) {
    if (name === 'lines') return lineDel(id);
    if (name === 'stations') return stationDel(id);
    if (name === 'productions') return productionDel(id);
    lsWrite(name, lsRead(name, []).filter((x) => x.id !== id));
    return Promise.resolve();
  }
  function clearColl(name) { lsWrite(name, []); return Promise.resolve(); }

  function validateFixture(f) {
    if (!isBridgeCode(f.code)) bad('序号必须是 4 位纯数字');
    if (!isValidSerialNo(f.serialNo)) bad('请填写夹具编号（≤' + MAX_SERIAL_NO + ' 字符，不能含 | 或换行）');
    if (!f.name) bad('请填写夹具名称');
    if (f.lineModels.length > MAX_LINE_MODELS) bad('机种名称最多 ' + MAX_LINE_MODELS + ' 个');
    if (!f.lines.length) bad('请至少选择 1 条产线');
    if (f.lines.length > MAX_LINES) bad('一件夹具最多关联 ' + MAX_LINES + ' 条产线');
    if (!f.stations.length) bad('请至少选择 1 个工位');
    if (f.stations.length > MAX_STATIONS) bad('一件夹具最多安装 ' + MAX_STATIONS + ' 个工位');
    if (!isValidLocation(f.location)) bad('库位号需为 4 段式（如 ZP1-U-1-1），且不超过 ' + MAX_LOCATION + ' 字符');
  }

  async function fixtureAdd(fixture) {
    const fixtures = lsRead(LS_FIXTURES, []);
    const f = Object.assign({}, fixture);
    if (!isBridgeCode(f.code)) f.code = nextFreeCodeSync();
    else if (fixtures.some((x) => String(x.code) === String(f.code))) bad('编号已存在', 'ConstraintError');
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
    f.id = lsSeq();
    f.status = 'stocked';
    f.totalOutCount = 0;
    f.totalReturnCount = 0;
    f.repairCount = 0;
    f.createdAt = Date.now();
    f.updatedAt = Date.now();
    fixtures.push(f);
    lsWrite(LS_FIXTURES, fixtures);
    return f.id;
  }

  async function fixtureUpdate(fixture) {
    const fixtures = lsRead(LS_FIXTURES, []);
    const i = fixtures.findIndex((f) => f.id === fixture.id);
    if (i < 0) bad('夹具不存在', 'NotFoundError');
    const old = fixtures[i];
    const f = Object.assign({}, old, fixture);
    f.code = old.code;   // code 不可改
    f.serialNo = String(f.serialNo == null ? '' : f.serialNo).trim();
    f.name = String(f.name == null ? '' : f.name).trim();
    const rawLms = dedupeStrings(f.lineModels);
    if (rawLms.length > MAX_LINE_MODELS) bad('机种名称最多 ' + MAX_LINE_MODELS + ' 个');
    f.lineModels = rawLms.slice(0, MAX_LINE_MODELS);
    f.lines = dedupeNumbers(f.lines);
    f.stations = dedupeNumbers(f.stations);
    f.location = String(f.location == null ? '' : f.location).trim();
    validateFixture(f);
    f.updatedAt = Date.now();
    fixtures[i] = f;
    lsWrite(LS_FIXTURES, fixtures);
    return f.id;
  }

  async function fixtureDel(id) {
    lsWrite(LS_FIXTURES, lsRead(LS_FIXTURES, []).filter((f) => f.id !== id));
  }

  async function fixtureGetAll() { return lsRead(LS_FIXTURES, []); }
  async function fixtureGetTransactions() { return lsRead(LS_FIX_TX, []); }

  async function fixtureAddTransaction(tx) {
    const fixtures = lsRead(LS_FIXTURES, []);
    const i = fixtures.findIndex((f) => f.id === tx.fixtureId);
    if (i < 0) bad('夹具不存在', 'NotFoundError');
    const fixture = fixtures[i];

    if (tx.type === 'out' && fixture.status !== 'stocked') bad('夹具当前不在库，无法出库');
    if (tx.type === 'return' && fixture.status !== 'checked_out') bad('夹具未处于已出库状态');
    if (tx.type === 'repair' && fixture.status !== 'stocked' && fixture.status !== 'checked_out') bad('夹具当前状态不允许维修登记');
    if (tx.type === 'repair_done' && fixture.status !== 'repair') bad('夹具未处于维修中状态');
    if (tx.type === 'retire' && fixture.status === 'retired') bad('夹具已报废');

    const fromStatus = fixture.status;
    let toStatus = fixture.status;
    const fromLocation = fixture.location || '';
    let toLocation = fromLocation;

    /* 参数校验早于内存改动（fixture 是数组内引用，先自增再抛错会留下脏内存） */
    const wantLoc = String(tx.location == null ? '' : tx.location).trim();
    if (tx.type === 'out' && !fromLocation && !isValidLocation(wantLoc)) {
      bad('该夹具尚未设置库位，请先补填库位号（如 ZP1-U-1-1）');
    }
    if (tx.type === 'return' && wantLoc && wantLoc !== fromLocation && !isValidLocation(wantLoc)) {
      bad('库位号需为 4 段式（如 ZP1-U-1-1），且不超过 ' + MAX_LOCATION + ' 字符');
    }

    if (tx.type === 'out') {
      toStatus = 'checked_out';
      fixture.totalOutCount = (fixture.totalOutCount || 0) + 1;
      if (!fromLocation) { fixture.location = wantLoc; toLocation = wantLoc; }
    } else if (tx.type === 'return') {
      toStatus = 'stocked';
      fixture.totalReturnCount = (fixture.totalReturnCount || 0) + 1;
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
    lsWrite(LS_FIXTURES, fixtures);

    const record = {
      id: lsSeq(),
      fixtureId: fixture.id,
      fixtureCode: fixture.code,
      fixtureSerialNo: fixture.serialNo || '',
      fixtureName: fixture.name,
      type: tx.type,
      operator: tx.operator || '',
      counterparty: tx.counterparty || '',
      time: tx.time,
      remark: tx.remark || '',
      repairType: tx.repairType || '',
      fromStatus,
      toStatus,
      fromLocation,
      toLocation,
      createdAt: Date.now()
    };
    const txs = lsRead(LS_FIX_TX, []);
    txs.push(record);
    lsWrite(LS_FIX_TX, txs);
    return record.id;
  }

  /* ---- 关联维护（v4.0.0）：与主进程 store.js 语义保持一致 ---- */
  function findFixtureSync(code) {
    return lsRead(LS_FIXTURES, []).find((f) => codeEq(f.code, code)) || null;
  }
  function writeFixtures(list) { lsWrite(LS_FIXTURES, list); }

  async function removeFixtureLine(payload) {
    const { code, lineId } = payload;
    const fixtures = lsRead(LS_FIXTURES, []);
    const f = fixtures.find((x) => codeEq(x.code, code));
    if (!f) bad('夹具不存在', 'NotFoundError');
    const lid = Number(lineId);
    const stIds = new Set(lsRead('stations', []).filter((s) => s.lineId === lid).map((s) => s.id));
    f.lines = (f.lines || []).filter((x) => Number(x) !== lid);
    f.stations = (f.stations || []).filter((x) => !stIds.has(Number(x)));
    f.updatedAt = Date.now();
    writeFixtures(fixtures);
    return { lines: f.lines.length, stations: f.stations.length };
  }

  async function removeFixtureStation(payload) {
    const { code, stationId } = payload;
    const fixtures = lsRead(LS_FIXTURES, []);
    const f = fixtures.find((x) => codeEq(x.code, code));
    if (!f) bad('夹具不存在', 'NotFoundError');
    const sid = Number(stationId);
    f.stations = (f.stations || []).filter((x) => Number(x) !== sid);
    f.updatedAt = Date.now();
    writeFixtures(fixtures);
    return { lines: (f.lines || []).length, stations: f.stations.length };
  }

  async function removeFixtureLinesByBatch(payload) {
    const codes = Array.isArray(payload && payload.codes) ? payload.codes : [];
    const lineId = payload && payload.lineId;
    let n = 0;
    for (const c of codes) {
      const f = findFixtureSync(c);
      if (!f) continue;
      const before = (f.lines || []).length;
      await removeFixtureLine({ code: c, lineId });
      if (before > (findFixtureSync(c).lines || []).length) n++;
    }
    return n;
  }

  async function lineDel(id) {
    const lid = Number(id);
    const stSet = new Set(lsRead('stations', []).filter((s) => s.lineId === lid).map((s) => s.id));
    const fixtures = lsRead(LS_FIXTURES, []);
    fixtures.forEach((f) => {
      f.lines = (f.lines || []).filter((x) => Number(x) !== lid);
      f.stations = (f.stations || []).filter((x) => !stSet.has(Number(x)));
    });
    writeFixtures(fixtures);
    lsWrite('stations', lsRead('stations', []).filter((s) => s.lineId !== lid));
    lsWrite('lines', lsRead('lines', []).filter((l) => l.id !== lid));
  }

  async function stationDel(id) {
    const sid = Number(id);
    const fixtures = lsRead(LS_FIXTURES, []);
    fixtures.forEach((f) => { f.stations = (f.stations || []).filter((x) => Number(x) !== sid); });
    writeFixtures(fixtures);
    lsWrite('stations', lsRead('stations', []).filter((s) => s.id !== sid));
  }

  async function productionDel(id) {
    const p = lsRead('productions', []).find((x) => x.id === id);
    if (!p) return;
    const refs = lsRead(LS_FIXTURES, []).filter((f) => (f.lineModels || []).includes(p.name)).length;
    if (refs > 0) {
      const e = new Error('机种「' + p.name + '」仍被 ' + refs + ' 台夹具引用，请先解除关联');
      e.name = 'ConstraintError';
      throw e;
    }
    lsWrite('productions', lsRead('productions', []).filter((x) => x.id !== id));
  }

  async function productionRename(payload) {
    const { id, name: rawName } = payload;
    if (!isValidProductionName(rawName)) bad('机种名称需为 1~30 字符，且不含竖线');
    const name = rawName.trim();
    const list = lsRead('productions', []);
    const p = list.find((x) => x.id === id);
    if (!p) bad('机种不存在', 'NotFoundError');
    if (list.some((x) => x.id !== id && x.name === name)) bad('已存在同名机种');
    const old = p.name;
    p.name = name;
    lsWrite('productions', list);
    let n = 0;
    const fixtures = lsRead(LS_FIXTURES, []);
    fixtures.forEach((f) => {
      if (!Array.isArray(f.lineModels)) return;
      const i = f.lineModels.indexOf(old);
      if (i >= 0) { f.lineModels[i] = name; f.updatedAt = Date.now(); n++; }
    });
    writeFixtures(fixtures);
    return n;
  }

  async function nextFreeCode() { return nextFreeCodeSync(); }

  return {
    APP_VERSION, MAX_LINE_MODELS, MAX_LINES, MAX_STATIONS, MAX_SERIAL_NO, MAX_LOCATION, LOCATION_RE,
    open, getAll, get, add, put, del, getMeta, setMeta,
    clear: clearColl,
    fixtureAdd, fixtureUpdate, fixtureDel,
    fixtureGetAll, fixtureGetTransactions, fixtureAddTransaction,
    nextFreeCode,
    lineDel, stationDel, productionDel, productionRename,
    removeFixtureLine, removeFixtureStation, removeFixtureLinesByBatch,
    // 浏览器模式下的纯函数（供测试复用）
    normalizeCode, codeEq, isValidSerialNo, isValidLocation, isValidProductionName, isBridgeCode,
    currentBackend: () => 'browser'
  };
})();
