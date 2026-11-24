import { contextBridge, ipcRenderer } from 'electron';

const call = (ch: string, ...a: unknown[]) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  listConnections: () => call('conn:list'),
  saveConnection: (c: unknown) => call('conn:save', c),
  removeConnection: (id: string) => call('conn:remove', id),
  open: (id: string) => call('conn:open', id),
  close: () => call('conn:close'),
  tables: () => call('db:tables'),
  data: (s: string, t: string, limit: number, offset: number) => call('db:data', s, t, limit, offset),
  insert: (s: string, t: string, v: unknown) => call('db:insert', s, t, v),
  del: (s: string, t: string, key: unknown) => call('db:delete', s, t, key),
  drop: (s: string, t: string) => call('db:drop', s, t),
  backup: () => call('db:backup'),
});
