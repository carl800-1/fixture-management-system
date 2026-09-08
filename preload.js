'use strict';
/* ============================================================
 * preload.js — 渲染进程桥（v2.0）
 * ============================================================ */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  version: '2.1',
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  // 打印二维码标签：opts = { pageSize, copies }，返回 { ok, reason? }
  printLabels: (opts) => ipcRenderer.invoke('print-labels', opts),
  // 夹具管理
  fixtureAdd: (fixture) => ipcRenderer.invoke('fixture-add', fixture),
  fixtureUpdate: (fixture) => ipcRenderer.invoke('fixture-update', fixture),
  fixtureDel: (id) => ipcRenderer.invoke('fixture-del', id),
  fixtureGetAll: () => ipcRenderer.invoke('fixture-getAll'),
  fixtureAddTransaction: (tx) => ipcRenderer.invoke('fixture-addTransaction', tx),
  fixtureGetTransactions: () => ipcRenderer.invoke('fixture-getTransactions')
});
