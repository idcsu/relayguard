import type { NodeItem, RuleStatus } from './types';

export function cn(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(' ');
}

export function fmtDate(v?: string) {
  if (!v) return '-';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('zh-CN', { hour12: false });
}

export function fmtShortDate(v?: string) {
  if (!v) return '-';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('zh-CN');
}

export function fmtBytes(input?: number) {
  let n = Number(input || 0);
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 2 : 0)} ${u[i]}`;
}

export function pct(used?: number, total?: number) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(used || 0) / Number(total || 1)) * 100)));
}

export function roleText(r?: string) {
  return ({ super_admin: '超级管理员', admin: '管理员', user: '普通用户' } as Record<string, string>)[r || ''] || r || '-';
}

export function protocolText(p?: string) {
  return ({ tcp: 'TCP', udp: 'UDP', both: 'TCP + UDP' } as Record<string, string>)[p || ''] || String(p || '-').toUpperCase();
}

export function online(n: NodeItem) {
  return n.status === 'online';
}

export function statusText(st?: RuleStatus) {
  if (!st || !st.state) return { tone: 'muted' as const, text: '未上报' };
  const map: Record<string, any> = {
    running: { tone: 'ok', text: '运行中' },
    stopped: { tone: 'muted', text: '已停止' },
    error: { tone: 'danger', text: '异常' },
    unsupported: { tone: 'warn', text: '不支持' }
  };
  return map[st.state] || { tone: 'muted', text: st.state };
}

export function firewallStatus(n: NodeItem) {
  const mode = n.firewall_mode || 'loose';
  const runtime = n.firewall_state || '';
  let text = '宽松托管';
  let tone: 'ok' | 'warn' | 'danger' | 'muted' = 'muted';
  let note = '';

  if (mode === 'off') {
    text = '未托管';
    tone = 'muted';
  } else if (mode === 'loose') {
    text = runtime === 'unsupported' ? '不支持' : '宽松托管';
    tone = runtime === 'unsupported' ? 'warn' : 'muted';
  } else if (mode === 'strict-pending') {
    text = '严格待确认';
    tone = 'warn';
    note = '严格防火墙待确认：请在 60 秒内于面板点击确认，否则 Agent 会自动回滚。';
  } else if (mode === 'strict') {
    if (runtime === 'strict-pending') {
      text = '严格确认中';
      tone = 'warn';
      note = '已点击确认，等待 Agent 下一次心跳确认状态。';
    } else if (runtime === 'rollback') {
      text = '已自动回滚';
      tone = 'warn';
    } else if (runtime === 'unsupported') {
      text = '不支持';
      tone = 'warn';
    } else if (runtime === 'error') {
      text = '异常';
      tone = 'danger';
    } else {
      text = '严格托管';
      tone = 'ok';
    }
  } else if (runtime === 'rollback') {
    text = '已自动回滚';
    tone = 'warn';
  } else if (runtime === 'error') {
    text = '异常';
    tone = 'danger';
  }
  if (n.firewall_error) tone = 'danger';
  return { text, tone, note };
}
