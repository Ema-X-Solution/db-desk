// Read-only server status over SSH: RAM, CPU, disk, network and (optionally) nginx request counts.
// Only a fixed shell script runs on the server (cat/df/tail/cut). Nothing is written or changed there.
import { Client } from 'ssh2';
import { SshConfig } from './db/types';
import { sshConnectOptions } from './ssh';

export const DEFAULT_NGINX_LOG = '/var/log/nginx/access.log';
const NGINX_LINES = 20000;

export interface DiskInfo { mount: string; fs: string; total: number; used: number }
export interface NginxStats {
  path: string;
  /** Requests in the last 1 minute / 5 minutes / 60 minutes, by the server's clock. */
  last1m: number; last5m: number; last1h: number;
  classes: { c2xx: number; c3xx: number; c4xx: number; c5xx: number };
  /** Requests per minute for the last 30 minutes, oldest first. */
  perMinute: number[];
  /** true when the log tail we read does not reach back a full hour. */
  windowShort: boolean;
}
export interface ServerStatus {
  hostname: string; os: string; uptimeSec: number; cores: number;
  cpuPercent: number; load: [number, number, number];
  mem: { total: number; used: number; available: number; swapTotal: number; swapUsed: number };
  disks: DiskInfo[];
  net: { rxBytes: number; txBytes: number; rxRate: number; txRate: number };
  /** null when nginx was not requested this time. */
  nginx: NginxStats | 'nolog' | null;
  takenAt: number;
}

export function buildScript(nginxLog: string | null): string {
  if (nginxLog !== null && !/^\/[\w./-]+$/.test(nginxLog)) throw new Error('Invalid nginx log path');
  const nginx = nginxLog === null ? '' :
    `; echo '##nginx'; date +%s; if [ -r '${nginxLog}' ]; then tail -n ${NGINX_LINES} '${nginxLog}' | cut -d' ' -f4,5,9; else echo __NOLOG__; fi`;
  return [
    "echo '##cpu1'; head -1 /proc/stat", "echo '##net1'; cat /proc/net/dev", 'sleep 1',
    "echo '##cpu2'; head -1 /proc/stat", "echo '##net2'; cat /proc/net/dev",
    "echo '##mem'; cat /proc/meminfo", "echo '##load'; cat /proc/loadavg", "echo '##up'; cat /proc/uptime",
    "echo '##cores'; grep -c ^processor /proc/cpuinfo",
    "echo '##disk'; df -PB1 -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null",
    `echo '##os'; (. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"); hostname${nginx}`,
  ].join('; ');
}

function sections(out: string): Record<string, string[]> {
  const res: Record<string, string[]> = {}; let cur = '';
  for (const line of out.split('\n')) {
    const m = line.match(/^##(\w+)$/);
    if (m) { cur = m[1]; res[cur] = []; } else if (cur) res[cur].push(line);
  }
  return res;
}

const cpuTimes = (line: string) => {
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  return { total: n.reduce((a, b) => a + b, 0), idle: (n[3] || 0) + (n[4] || 0) };
};
const netTotals = (lines: string[]) => {
  let rx = 0, tx = 0;
  for (const l of lines) {
    const m = l.match(/^\s*([^:\s]+):\s*(.*)$/); if (!m || m[1] === 'lo') continue;
    const f = m[2].trim().split(/\s+/).map(Number); rx += f[0] || 0; tx += f[8] || 0;
  }
  return { rx, tx };
};
const kb = (lines: string[], key: string) => {
  const l = lines.find((x) => x.startsWith(key + ':')); return l ? Number(l.split(/\s+/)[1]) * 1024 : 0;
};
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

export function parseNginx(lines: string[], now: number, path: string): NginxStats {
  const out: NginxStats = { path, last1m: 0, last5m: 0, last1h: 0, classes: { c2xx: 0, c3xx: 0, c4xx: 0, c5xx: 0 }, perMinute: new Array(30).fill(0), windowShort: false };
  let oldest = Infinity, parsed = 0;
  for (const l of lines) {
    const m = l.match(/^\[(\d+)\/(\w+)\/(\d+):(\d+):(\d+):(\d+) ([+-])(\d\d)(\d\d)\] (\d{3})$/);
    if (!m || !(m[2] in MONTHS)) continue;
    let t = Date.UTC(+m[3], MONTHS[m[2]], +m[1], +m[4], +m[5], +m[6]) / 1000;
    t -= (m[7] === '-' ? -1 : 1) * (+m[8] * 3600 + +m[9] * 60);
    parsed++; oldest = Math.min(oldest, t);
    const age = now - t; if (age < 0 || age >= 3600) continue;
    out.last1h++; if (age < 300) out.last5m++; if (age < 60) out.last1m++;
    const k = Math.floor(+m[10][0]); if (k === 2) out.classes.c2xx++; else if (k === 3) out.classes.c3xx++; else if (k === 4) out.classes.c4xx++; else if (k === 5) out.classes.c5xx++;
    if (age < 1800) out.perMinute[29 - Math.floor(age / 60)]++;
  }
  out.windowShort = lines.length >= NGINX_LINES - 5 && oldest > now - 3600 && parsed > 0;
  return out;
}

export function parseStatus(out: string, nginxLog: string | null): ServerStatus {
  const s = sections(out);
  if (!s.cpu1?.length || !s.mem?.length) throw new Error('The server did not return Linux status data (is it a Linux server?).');
  const c1 = cpuTimes(s.cpu1[0]), c2 = cpuTimes(s.cpu2[0]);
  const dt = c2.total - c1.total;
  const n1 = netTotals(s.net1), n2 = netTotals(s.net2);
  const load = (s.load[0] || '').split(/\s+/).slice(0, 3).map(Number) as [number, number, number];
  const memTotal = kb(s.mem, 'MemTotal'), memAvail = kb(s.mem, 'MemAvailable');
  const swapTotal = kb(s.mem, 'SwapTotal');
  const seen = new Set<string>();
  const disks: DiskInfo[] = [];
  for (const l of (s.disk || []).slice(1)) {
    const f = l.trim().split(/\s+/); if (f.length < 6) continue;
    const mount = f.slice(5).join(' '); if (seen.has(f[0]) || +f[1] <= 0) continue; seen.add(f[0]);
    disks.push({ fs: f[0], mount, total: +f[1], used: +f[2] });
  }
  let nginx: ServerStatus['nginx'] = null;
  if (nginxLog !== null && s.nginx) {
    const now = Number(s.nginx[0]);
    nginx = s.nginx[1] === '__NOLOG__' ? 'nolog' : parseNginx(s.nginx.slice(1).filter(Boolean), now, nginxLog);
  }
  return {
    hostname: (s.os?.[1] || '').trim(), os: (s.os?.[0] || 'Linux').trim(),
    uptimeSec: Math.floor(Number((s.up?.[0] || '0').split(' ')[0])), cores: Number(s.cores?.[0]) || 1,
    cpuPercent: dt > 0 ? Math.max(0, Math.min(100, (1 - (c2.idle - c1.idle) / dt) * 100)) : 0,
    load: load.map((x) => x || 0) as [number, number, number],
    mem: { total: memTotal, available: memAvail, used: memTotal - memAvail, swapTotal, swapUsed: swapTotal - kb(s.mem, 'SwapFree') },
    disks,
    net: { rxBytes: n2.rx, txBytes: n2.tx, rxRate: Math.max(0, n2.rx - n1.rx), txRate: Math.max(0, n2.tx - n1.tx) },
    nginx, takenAt: Date.now(),
  };
}

/** One SSH connection kept open while the Server status view is showing. */
export class ServerSession {
  private constructor(private ssh: Client) {}

  static open(cfg: SshConfig): Promise<ServerSession> {
    return new Promise((resolve, reject) => {
      const ssh = new Client();
      ssh.on('ready', () => resolve(new ServerSession(ssh)));
      ssh.on('error', (e) => reject(new Error('SSH connection failed: ' + e.message)));
      try { ssh.connect(sshConnectOptions(cfg)); } catch (e) { reject(e); }
    });
  }

  run(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.ssh.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = ''; stream.on('data', (d: Buffer) => (out += d.toString('utf8')));
        stream.stderr.on('data', () => {});
        stream.on('close', () => resolve(out));
      });
    });
  }

  async status(nginxLog: string | null): Promise<ServerStatus> {
    return parseStatus(await this.run(buildScript(nginxLog)), nginxLog);
  }

  close() { this.ssh.end(); }
}
