import { contextBridge, ipcRenderer } from 'electron';

const call = (ch: string, ...a: unknown[]) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  listConnections: () => call('conn:list'),
  saveConnection: (c: unknown) => call('conn:save', c),
  removeConnection: (id: string) => call('conn:remove', id),
  open: (id: string) => call('conn:open', id),
  close: () => call('conn:close'),
  tables: () => call('db:tables'),
  data: (s: string, t: string, limit: number, offset: number, search?: string) => call('db:data', s, t, limit, offset, search),
  insert: (s: string, t: string, v: unknown) => call('db:insert', s, t, v),
  del: (s: string, t: string, key: unknown) => call('db:delete', s, t, key),
  script: (sql: string, commit: boolean) => call('db:script', sql, commit),
  dbStats: () => call('stats:db'),
  serverSettings: (v?: unknown) => call('server:settings', v),
  serverStatus: (withNginx: boolean) => call('server:status', withNginx),
  serverClose: () => call('server:close'),
  gitInfo: () => call('server:git:info'),
  gitFetch: () => call('server:git:fetch'),
  gitPull: () => call('server:git:pull'),
  drop: (s: string, t: string) => call('db:drop', s, t),
  backup: () => call('db:backup'),
  toolStatus: () => call('tool:status'),
  pickTool: (t: string) => call('tool:pick', t),
});
