'use strict';
/* ============================================================
 * preload.js — 渲染进程桥（v5.5.0）
 * ============================================================ */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  version: '5.5.0',
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  // 打印：opts = { pageSize, copies, landscape, margins }，返回 { ok, reason? }
  printLabels: (opts) => ipcRenderer.invoke('print-labels', opts),
  // 表格导入：弹出系统文件框读取 .xlsx/.csv，返回 { ok, name, kind, text|bytes }
  pickSpreadsheet: () => ipcRenderer.invoke('pick-spreadsheet'),
  // 主进程解析 xlsx 字节流，返回 { ok, rows, sheetName, sheetNames } 或 { ok:false, error }
  readSpreadsheet: (bytes) => ipcRenderer.invoke('read-spreadsheet', bytes),
  // 夹具管理
  fixtureAdd: (fixture) => ipcRenderer.invoke('fixture-add', fixture),
  fixtureUpdate: (fixture) => ipcRenderer.invoke('fixture-update', fixture),
  fixtureDel: (id) => ipcRenderer.invoke('fixture-del', id),
  fixtureGetAll: () => ipcRenderer.invoke('fixture-getAll'),
  fixtureAddTransaction: (tx) => ipcRenderer.invoke('fixture-addTransaction', tx),
  fixtureGetTransactions: () => ipcRenderer.invoke('fixture-getTransactions'),
  nextFreeCode: () => ipcRenderer.invoke('next-free-code'),
  // 关联维护
  lineDel: (id) => ipcRenderer.invoke('line-del', id),
  productionDel: (id) => ipcRenderer.invoke('production-del', id),
  productionRename: (payload) => ipcRenderer.invoke('production-rename', payload),
  removeFixtureLine: (payload) => ipcRenderer.invoke('fixture-line-remove', payload),
  removeFixtureLinesByBatch: (payload) => ipcRenderer.invoke('fixture-lines-removeBatch', payload),
  // 人员卡库（v5.1.0）
  staffAdd: (staff) => ipcRenderer.invoke('staff-add', staff),
  staffUpdate: (staff) => ipcRenderer.invoke('staff-update', staff),
  staffDel: (id) => ipcRenderer.invoke('staff-del', id)
});
