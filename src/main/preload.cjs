'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aster', Object.freeze({
  invoke: (command, payload = {}) => ipcRenderer.invoke('aster:command', command, payload),
  onState: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('aster:state', listener); return () => ipcRenderer.removeListener('aster:state', listener); },
  onCommand: callback => { const listener = (_event, command) => callback(command); ipcRenderer.on('aster:ui', listener); return () => ipcRenderer.removeListener('aster:ui', listener); },
  platform: process.platform
}));
