import type { NodeItem, RuleStatus, User } from './types';

export function cn(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(' ');
}

// 审计动作码 → 中文说明（让小白也能看懂日志里发生了什么）
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  login: '登录面板',
  change_password: '修改密码',
  enable_totp: '开启两步验证',
  disable_totp: '关闭两步验证',
  logout_other_sessions: '退出其他登录',
  create_user: '新增用户',
  update_user: '修改用户',
  delete_user: '删除用户',
  reset_user_traffic: '重置用户流量',
  create_node_token: '生成节点接入 Token',
  register_node: '节点接入',
  update_node: '修改节点设置',
  delete_node: '删除节点',
  create_rule: '新增转发规则',
  update_rule: '修改转发规则',
  delete_rule: '删除转发规则',
  toggle_rule: '启用/停用规则',
  clone_rule: '克隆规则',
  reset_rule_traffic: '重置规则流量',
  connectivity_test: '发起连通性检测',
  backup: '创建备份',
  restore_backup: '恢复备份',
  update_settings: '修改系统设置',
  reset_admin_password: '重置管理员密码',
};

export function actionText(action?: string) {
  if (!action) return '-';
  return AUDIT_ACTION_LABELS[action] || action;
}

// 把操作者 ID 翻译成可读名称：用户名 / 系统 / 节点 Agent
export function actorText(id: string | undefined, users: User[]) {
  if (!id) return '-';
  if (id === 'system') return '系统';
  if (id === 'agent') return '节点 Agent';
  const u = users.find(x => x.id === id);
  return u ? u.username : id;
}

// 把操作目标 ID 翻译成可读名称（规则名 / 节点名 / 用户名），找不到再回退原值
export function targetText(
  target: string | undefined,
  ctx: { users: User[]; nodes: NodeItem[]; ruleName?: (id: string) => string | undefined }
) {
  if (!target) return '-';
  const u = ctx.users.find(x => x.id === target);
  if (u) return u.username;
  const n = ctx.nodes.find(x => x.id === target);
  if (n) return n.name;
  const rn = ctx.ruleName?.(target);
  if (rn) return rn;
  return target;
}

export function fmtDate(v?: string) {
  if (!v) return '-';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('zh-CN', { hour12: false });
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
