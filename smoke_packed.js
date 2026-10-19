'use strict';
/* ============================================================
 * smoke_packed.js — 打包产物冒烟测试（自包含，无外部依赖）
 *
 * 直接启动**打包后的真实 exe**（不是开发态 Electron），通过 Chrome DevTools
 * Protocol 连接其渲染进程，验证「开发态能跑 ≠ 打包后能跑」这一层：
 *   - 程序能正常启动、标题 / 品牌 / 导航项 / CSS 正确
 *   - 全部视图可切换
 *   - v4 新增的关键全局函数已挂载
 *   - 打包模式数据在 exe 同目录落盘（dataDir = exeDir）
 *   - v4 业务链路：建产线 → 建工位 → 建档（含产线工位）→ 出库派生数量
 *   - 建档强校验：零产线被拒
 *   - 落盘结构：无 products / stationFixtures / qrToken / quantity
 *   - 无 console.error / 致命 stderr
 *
 * ── 指定被测 exe 的三种方式（优先级从高到低）──
 *   1. 命令行：node smoke_packed.js "D:/project/fixture/v4.0.0/工装夹具管理程序.exe"
 *   2. 环境变量：FMS_EXE=... node smoke_packed.js
 *   3. 自动探测：扫描 release 开头的构建目录下的 win-unpacked，以及 D:/project/fixture/
 *      下 v 开头的版本目录，取修改时间最新的那个 exe
 *
 * ⚠️ 运行前必须 unset ELECTRON_RUN_AS_NODE 且清空 NODE_OPTIONS，
 *    否则 exe 会退化成 Node 并「退出码 0 秒退」（假象）。
 *
 * ⚠️ 测试会临时写入数据文件，结束后**自动恢复原状**（原文件存在则回写，不存在则删除）。
 * ============================================================ */
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

/* ============================================================
 * 内联极简 CDP（Chrome DevTools Protocol）客户端
 * 仅依赖 Node 原生 net/crypto/http，实现 WebSocket 握手与文本帧收发，
 * 以便在无 ws 依赖的环境下通过 Runtime.evaluate 操作 Electron 渲染进程。
 * ============================================================ */
function httpGetJSON(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

/* 极简 WebSocket 客户端：仅支持服务端→客户端的文本帧（CDP 响应均为文本帧） */
class MiniWS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = Number(u.port) || 80;
    this.path = u.pathname + u.search;
    this.key = crypto.randomBytes(16).toString('base64');
    this.buf = Buffer.alloc(0);
    this.handlers = { open: [], message: [], error: [], close: [] };
    this.opened = false;
    this._connect();
  }
  on(ev, fn) { this.handlers[ev].push(fn); return this; }
  _emit(ev, a) { (this.handlers[ev] || []).forEach((f) => f(a)); }
  _connect() {
    this.sock = net.connect(this.port, this.host, () => {
      this.sock.write(
        'GET ' + this.path + ' HTTP/1.1\r\n' +
        'Host: ' + this.host + ':' + this.port + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + this.key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    this.sock.on('error', (e) => this._emit('error', e));

    let handshaken = false;
    this.sock.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (!handshaken) {
        const idx = this.buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = this.buf.slice(0, idx).toString();
        if (!/HTTP\/1\.1 101/.test(head)) {
          this._emit('error', new Error('握手失败：\n' + head));
          this.sock.destroy();
          return;
        }
        handshaken = true;
        this.opened = true;
        this.buf = this.buf.slice(idx + 4);
        this._emit('open');
      }
      this._parse();
    });
    this.sock.on('close', () => this._emit('close'));
  }
  _parse() {
    /* CDP 响应可能分片，循环解析完整帧 */
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const opcode = b0 & 0x0f;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      if (opcode === 0x1 || opcode === 0x2) this._emit('message', payload.toString('utf8'));
      else if (opcode === 0x8) { this.close(); return; }
    }
  }
  send(str) {
    const data = Buffer.from(str, 'utf8');
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x81; // FIN + text
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  close() { try { this.sock.destroy(); } catch (e) { /* ignore */ } }
}

/* 返回一个 CDP 会话：{ evaluate(expr), close() } */
async function connectCDP(port) {
  const list = await httpGetJSON(port, '/json/list');
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到 page 目标');

  const ws = new MiniWS(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });

  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (r) => res(r));
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP 超时：' + method)); } }, 15000);
  });

  await send('Runtime.enable');

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      const ex = r.result.exceptionDetails.exception || {};
      throw new Error(ex.description || ex.value || 'evaluate 异常');
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  return {
    page,
    send,
    evaluate,
    close: () => ws.close()
  };
}

/* ============================================================
 * 定位被测 exe
 * ============================================================ */
function findExe() {
  const explicit = process.argv[2] || process.env.FMS_EXE;
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    console.error('指定的 exe 不存在：' + explicit);
    process.exit(1);
  }

  const cands = [];
  const addFromDir = (dir) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/\.exe$/i.test(f)) continue;
        const p = path.join(dir, f);
        try { cands.push({ p, m: fs.statSync(p).mtimeMs }); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  };

  /* 1) 源码目录 / 上级目录下，release 开头的构建目录里的 win-unpacked */
  for (const base of [__dirname, path.join(__dirname, '..')]) {
    let names = [];
    try { names = fs.readdirSync(base); } catch (e) { continue; }
    for (const d of names) {
      if (!/^release/i.test(d)) continue;
      addFromDir(path.join(base, d, 'win-unpacked'));
    }
  }

  /* 2) D:/project/fixture/ 下 v 开头的版本化发布目录 */
  const pubRoot = 'D:/project/fixture';
  try {
    for (const d of fs.readdirSync(pubRoot)) {
      if (!/^v\d/.test(d)) continue;
      const p = path.join(pubRoot, d);
      try { if (!fs.statSync(p).isDirectory()) continue; } catch (e) { continue; }
      addFromDir(p);
    }
  } catch (e) { /* ignore */ }

  if (!cands.length) {
    console.error('未找到任何打包后的 exe。请用 node smoke_packed.js "<exe路径>" 指定，或设置 FMS_EXE。');
    process.exit(1);
  }
  cands.sort((a, b) => b.m - a.m);
  return cands[0].p;
}

const EXE = findExe();
const EXE_DIR = path.dirname(EXE);
const DATA_FILE = path.join(EXE_DIR, 'fixture-data.json');
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; }
  catch (e) { return '0.0.0'; }
})();

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (extra != null ? ' -> ' + extra : '')); console.log('  ❌ ' + name + (extra != null ? ' -> ' + extra : '')); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log('被测程序：' + EXE);
  console.log('源码版本：v' + VERSION);
  if (!fs.existsSync(EXE)) { console.error('找不到 exe：' + EXE); process.exit(1); }

  const backup = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE) : null;
  console.log('发布目录：' + EXE_DIR);
  console.log('数据文件原状：' + (backup ? '已存在（已备份，测后恢复）' : '不存在（全新环境）'));

  const port = 9500 + Math.floor(Math.random() * 300);
  const proc = spawn(EXE, [
    '--remote-debugging-port=' + port,
    '--disable-gpu', '--no-sandbox', '--disable-software-rasterizer'
  ], { cwd: EXE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });

  const stderrLines = [];
  proc.stderr.on('data', (d) => stderrLines.push(d.toString()));

  try {
    /* ---- 1. 启动 ---- */
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const list = await httpGetJSON(port, '/json/list');
        if (list.some((t) => t.type === 'page')) { ready = true; break; }
      } catch (e) { /* retry */ }
    }
    ok('打包程序启动并开放调试端口', ready);
    if (!ready) throw new Error('程序未能在 30s 内启动');

    const session = await connectCDP(port);
    const evaluate = session.evaluate;
    await sleep(1500);

    /* ---- 2. 标题 / 品牌 / 导航 / CSS ---- */
    const info = JSON.parse(await evaluate(`JSON.stringify({
      title: document.title,
      brand: (document.querySelector('.brand-name')||{}).textContent || '',
      foot: (document.querySelector('.foot-version')||{}).textContent || '',
      navCount: document.querySelectorAll('.nav-item').length,
      views: [...document.querySelectorAll('.nav-item')].map(b=>b.dataset.view),
      bg: getComputedStyle(document.body).backgroundColor
    })`));
    console.log('\n  ── 页面信息 ──');
    console.log('  标题：' + info.title);
    console.log('  导航：' + info.views.join(' / '));

    /* v4.0.4 起 title / 品牌名统一为程序名，界面版本号只在页脚显示 */
    ok('窗口标题为程序名（v4.0.4 起不再带版本号）', info.title.trim() === '工装夹具管理程序', info.title);
    ok('品牌栏为程序名（v4.0.4 起不再带版本号）', info.brand.trim() === '工装夹具管理程序', info.brand);
    ok('页脚版本号 = v' + VERSION, info.foot.indexOf('v' + VERSION) >= 0, info.foot);
    const EX_VIEWS = ['dashboard', 'fixtures', 'outbound', 'return', 'location', 'records',
      'query', 'prod', 'linequery', 'linecfg', 'data'];
    const missView = EX_VIEWS.filter((v) => !info.views.includes(v));
    ok('11 个导航项齐备（按机种查询已并入机种管理）', info.navCount >= EX_VIEWS.length && missView.length === 0,
      'count=' + info.navCount + ' missing=' + missView.join(','));
    ok('CSS 已生效', info.bg !== 'rgba(0, 0, 0, 0)' && info.bg !== 'transparent', info.bg);

    /* ---- 3. 视图切换 ---- */
    const sv = JSON.parse(await evaluate(`JSON.stringify((() => {
      const out = {};
      for (const v of ${JSON.stringify(EX_VIEWS)}) {
        try { window.showView(v); out[v]='OK'; } catch(e){ out[v]='FAIL:'+e.message; }
      }
      return out;
    })())`));
    Object.entries(sv).forEach(([v, r]) => ok('showView(' + v + ')', r === 'OK', r));

    /* ---- 4. 全局函数挂载 ---- */
    const fns = ['fixtureNew','fixtureEdit','fixtureOut','fixtureReturn','fixtureRepair',
      'fixtureRepairComplete','fixtureRetire','fixtureSearch','submitFixForm',
      'fixFormLinePicked','fixFormStationPicked','fixFormAddStation','fixFormRemoveStation',
      'fixFormModelsInput','fixFormRemoveModel','fixFormCheckSerial','fixFormGotoLineCfg',
      'lineCfgLineForm','lineCfgSaveLine','lineCfgPickLine','lineCfgStationForm','lineCfgSaveStation',
      'lineCfgDelLine','lineCfgImport','lineQueryChangeLine','lineQueryChangeModel','lineQueryReset',
      'openFixtureQR','printSingleLabel','batchPrintLabels','clearAllData','exportData'];
    const missing = JSON.parse(await evaluate('JSON.stringify(' + JSON.stringify(fns) + '.filter(f => typeof window[f] !== "function"))'));
    ok('v4 关键全局函数全部挂载（' + fns.length + ' 个）', missing.length === 0, missing.join(', '));

    /* ---- 5. 建产线 + 工位 ---- */
    const setup = await evaluate(`(async () => {
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      const $=(s)=>document.querySelector(s);
      const log=[];
      window.showView('linecfg'); await sleep(500);
      /* 新建线体 */
      window.lineCfgLineForm(0); await sleep(250);
      if (!$('#lc_line_name')) return JSON.stringify({step:'no-line-form'});
      $('#lc_line_name').value='冒烟-L1'; $('#lc_line_type').value='linear';
      window.lineCfgSaveLine(0); await sleep(900);
      /* 从 DOM 反查线体 id */
      const pb=[...document.querySelectorAll('[onclick*="lineCfgPickLine("]')];
      const lid = pb.length ? Number(pb[0].getAttribute('onclick').match(/lineCfgPickLine\\((\\d+)\\)/)[1]) : 0;
      log.push('lid='+lid);
      if(!lid) return JSON.stringify({step:'no-lid',log});
      window.lineCfgPickLine(lid); await sleep(400);
      /* 新建工位 */
      window.lineCfgStationForm(0); await sleep(300);
      if (!$('#lc_st_name')) return JSON.stringify({step:'no-station-form',log});
      $('#lc_st_name').value='冒烟工位A'; $('#lc_st_seq').value='10';
      window.lineCfgSaveStation(0); await sleep(900);
      /* 反查工位 id */
      const sb=[...document.querySelectorAll('[onclick*="lineCfgDelStation("]')];
      const sid = sb.length ? Number(sb[0].getAttribute('onclick').match(/lineCfgDelStation\\((\\d+)\\)/)[1]) : 0;
      log.push('sid='+sid);
      return JSON.stringify({ step:'ok', lid, sid, log });
    })()`);
    const sj = JSON.parse(setup);
    ok('新建线体成功（lineCfgSaveLine）', sj.step === 'ok', setup);
    ok('新建工位成功（lineCfgSaveStation）', sj.step === 'ok' && !!sj.sid, setup);
    if (sj.step !== 'ok') throw new Error('产线配置阶段失败：' + setup);
    const LID = sj.lid, SID = sj.sid;

    /* ---- 6. 建档强校验：零产线被拒 ---- */
    const reject = await evaluate(`(async () => {
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      const $=(s)=>document.querySelector(s);
      window.showView('fixtures'); await sleep(400);
      window.fixtureNew(); await sleep(600);
      if (!$('#fix_serial')) return JSON.stringify({step:'no-form'});
      $('#fix_serial').value='SMOKE-NOLINE-001';
      $('#fix_name').value='零产线夹具';
      $('#fix_loc').value='ZP1-U-1-1';
      const lm=$('#fix_lm_text'); if(lm){ lm.value='冒烟机种X'; window.fixFormModelsInput(); }
      await sleep(300);
      window.submitFixForm(); await sleep(700);
      const t=$('#toast');
      const txt=(t&&!t.hidden)?t.textContent:'';
      const cls=t?t.className:'';
      const modalOpen = $('#modalOverlay') ? !$('#modalOverlay').hidden : false;
      window.closeModal && window.closeModal();
      return JSON.stringify({ toast: txt, cls, modalOpen });
    })()`);
    const rj = JSON.parse(reject);
    ok('零产线建档被拒（提示「请至少选择 1 条产线」）', /至少选择 1 条产线/.test(rj.toast), reject);
    ok('被拒时错误样式 err', /\berr\b/.test(rj.cls || ''), rj.cls);
    ok('被拒时表单未被关闭（可继续填）', rj.modalOpen === true, String(rj.modalOpen));

    /* ---- 7. 正常建档：含产线 + 工位 ---- */
    const build = await evaluate(`(async () => {
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      const $=(s)=>document.querySelector(s);
      window.showView('fixtures'); await sleep(400);
      window.fixtureNew(); await sleep(700);
      if (!$('#fix_serial')) return JSON.stringify({step:'no-form'});
      $('#fix_serial').value='SMOKE-921-001-001';
      $('#fix_name').value='冒烟测试夹具';
      $('#fix_loc').value='ZP1-U-1-1';
      $('#fix_cat').value='测试';
      /* 机种 */
      $('#fix_lm_text').value='冒烟机种X';
      window.fixFormModelsInput(); await sleep(300);
      /* 产线（两级下拉：先选产线） */
      const pick=$('#fix_line_pick');
      if(!pick) return JSON.stringify({step:'no-line-pick'});
      pick.value='${LID}'; window.fixFormLinePicked(); await sleep(400);
      /* 工位（选该产线下的工位 → 点「+ 添加」） */
      const spick=$('#fix_st_pick');
      if(!spick) return JSON.stringify({step:'no-st-pick'});
      spick.value='${SID}'; window.fixFormStationPicked(); await sleep(200);
      window.fixFormAddStation(); await sleep(400);
      const cnt=$('#fix_ls_count')?$('#fix_ls_count').textContent:'';
      window.submitFixForm(); await sleep(1100);
      const t=$('#toast');
      const txt=(t&&!t.hidden)?t.textContent:'';
      const cards=[...document.querySelectorAll('.fixture-card')];
      return JSON.stringify({ step:'ok', cnt, toast: txt,
        cards: cards.length,
        hit: cards.some(c=>c.textContent.includes('冒烟测试夹具')) });
    })()`);
    const bj = JSON.parse(build);
    ok('产线/工位已选入表单（计数文案）', /1\s*\/\s*5\s*条产线/.test(bj.cnt || ''), bj.cnt);
    ok('建档成功（toast 提示）', /建档成功/.test(bj.toast || ''), build);
    ok('列表出现新夹具', bj.hit === true, build);

    /* ---- 8. 落盘结构（exe 同目录 + v4 集合） ---- */
    await sleep(900);
    ok('打包模式数据在 exe 同目录落盘', fs.existsSync(DATA_FILE), DATA_FILE);
    if (fs.existsSync(DATA_FILE)) {
      const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      ok('落盘含 lines / stations / productions',
        Array.isArray(db.lines) && Array.isArray(db.stations) && Array.isArray(db.productions));
      ok('落盘无 products（v4 已移除）', db.products === undefined, JSON.stringify(Object.keys(db)));
      ok('落盘无 stationFixtures（v4 已废弃）', db.stationFixtures === undefined);
      ok('落盘无 qrToken（派生值不落库）', (db.fixtures || []).every((f) => f.qrToken === undefined));
      ok('落盘无 quantity 字段（数量为派生值）', (db.fixtures || []).every((f) => f.quantity === undefined));
      const f = (db.fixtures || []).find((x) => x.serialNo === 'SMOKE-921-001-001');
      ok('新夹具已写入 JSON', !!f, JSON.stringify((db.fixtures || []).map((x) => x.serialNo)));
      ok('序号为 4 位纯数字', f && /^\d{4}$/.test(f.code), f && f.code);
      ok('夹具携带 lines 数组', f && Array.isArray(f.lines) && f.lines.length === 1, f && JSON.stringify(f.lines));
      ok('夹具携带 stations 数组', f && Array.isArray(f.stations) && f.stations.length === 1, f && JSON.stringify(f.stations));
      ok('机种存名称数组', f && Array.isArray(f.lineModels) && f.lineModels.includes('冒烟机种X'), f && JSON.stringify(f.lineModels));
      ok('初始状态 stocked', f && f.status === 'stocked', f && f.status);
      ok('零产线那条未被写入（强校验生效）',
        !(db.fixtures || []).some((x) => x.serialNo === 'SMOKE-NOLINE-001'));
      console.log('  夹具 ' + (db.fixtures || []).length + ' 套 · 产线 ' + (db.lines || []).length
        + ' 条 · 工位 ' + (db.stations || []).length + ' 个');
    }

    /* ---- 8.5 二维码内容 = 纯序号（无 SPMS1| 前缀） ---- */
    const qrCheck = await evaluate(`(async () => {
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      const $=(s)=>document.querySelector(s);
      window.showView('fixtures'); await sleep(400);
      const card=[...document.querySelectorAll('.fixture-card')].find(c=>c.textContent.includes('冒烟测试夹具'));
      if(!card) return JSON.stringify({step:'no-card'});
      const qrBtn=[...card.querySelectorAll('button')].find(b=>b.textContent.includes('二维码'));
      if(!qrBtn) return JSON.stringify({step:'no-qr-btn'});
      qrBtn.click(); await sleep(500);
      const txt=(($('#modalBody')||{}).textContent||'');
      const m=txt.match(/二维码内容：\\s*(\\S+)/);
      const cv=$('#qrCanvas');
      const out={step:'ok', token:m?m[1]:'', drawn:!!cv && cv.width>0};
      window.closeModal(); await sleep(120);
      return JSON.stringify(out);
    })()`);
    const qj = JSON.parse(qrCheck);
    ok('二维码弹窗可打开并绘制', qj.step === 'ok' && qj.drawn === true, qrCheck);
    ok('二维码内容为纯序号（4 位数字）', /^\d{4}$/.test(qj.token || ''), qj.token);
    ok('二维码内容不含 SPMS 前缀', !/SPMS/i.test(qj.token || ''), qj.token);

    /* ---- 9. 派生数量：出库 → 状态与库位 ---- */
    const derive = await evaluate(`(async () => {
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      const $=(s)=>document.querySelector(s);
      window.showView('fixtures'); await sleep(400);
      const card=[...document.querySelectorAll('.fixture-card')].find(c=>c.textContent.includes('冒烟测试夹具'));
      if(!card) return JSON.stringify({step:'no-card'});
      const outBtn=[...card.querySelectorAll('button')].find(b=>b.textContent.trim()==='出库');
      if(!outBtn) return JSON.stringify({step:'no-out-btn'});
      outBtn.click(); await sleep(500);
      const op=$('#fix_out_op')||$('#out_operator');
      if(!op) return JSON.stringify({step:'no-out-form'});
      op.value='冒烟测试员';
      const locInput=$('#fix_out_loc')||$('#out_location');
      if(locInput && !locInput.value) locInput.value='ZP1-U-1-1';
      const okBtn=[...document.querySelectorAll('button')].find(b=>/确认出库/.test(b.textContent));
      if(!okBtn) return JSON.stringify({step:'no-confirm'});
      okBtn.click(); await sleep(1100);
      return JSON.stringify({ step:'ok' });
    })()`);
    const dj = JSON.parse(derive);
    ok('出库流程可在打包程序中执行', dj.step === 'ok', derive);
    await sleep(700);
    if (fs.existsSync(DATA_FILE)) {
      const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const f = (db.fixtures || []).find((x) => x.serialNo === 'SMOKE-921-001-001');
      ok('出库后状态 checked_out', f && f.status === 'checked_out', f && f.status);
      ok('出库冻结库位（location 保留）', f && f.location === 'ZP1-U-1-1', f && f.location);
      const tx = (db.fixTransactions || []).filter((t) => t.fixtureCode === (f && f.code));
      ok('生成出库流水 1 条', tx.length === 1, String(tx.length));
    }

    /* ---- 10. 运行期错误 ---- */
    const errText = stderrLines.join('');
    const bad = errText.split('\n').filter((l) => /FATAL|Uncaught|is not defined|Cannot read propert/i.test(l));
    ok('无致命运行期错误', bad.length === 0, bad.slice(0, 3).join(' | '));

    session.close();
  } catch (e) {
    fail++;
    failures.push('测试异常：' + e.message);
    console.log('  ❌ 测试异常：' + e.message);
  } finally {
    try { proc.kill(); } catch (e) { /* ignore */ }
    await sleep(600);
    try { spawn('taskkill', ['/F', '/IM', path.basename(EXE)], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    await sleep(800);
    try {
      if (backup) fs.writeFileSync(DATA_FILE, backup);
      else if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
      console.log('\n（测试数据已清理，发布目录恢复原状）');
    } catch (e) { console.log('\n⚠️ 数据恢复失败：' + e.message); }
  }

  console.log('\n' + '='.repeat(56));
  console.log('打包产物冒烟测试（v' + VERSION + '）：通过 ' + pass + ' / 失败 ' + fail);
  if (failures.length) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
  console.log('='.repeat(56));
  process.exit(fail > 0 ? 1 : 0);
})();
