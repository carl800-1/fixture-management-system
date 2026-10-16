'use strict';
/* ============================================================
 * preload.js — 渲染进程桥（v3.0.1）
 * ============================================================ */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  version: '3.0.1',
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  // 打印二维码标签：opts = { pageSize, copies }，返回 { ok, reason? }
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
  // 产线配置（v3.0.1）
  lineDel: (id) => ipcRenderer.invoke('line-del', id),
  productDel: (id) => ipcRenderer.invoke('product-del', id),
  stationDel: (id) => ipcRenderer.invoke('station-del', id),
  setStationFixtures: (payload) => ipcRenderer.invoke('set-station-fixtures', payload)
});
