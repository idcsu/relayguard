export class APIError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const BASE = '';

async function request(path, opts = {}) {
  const { body, method, ...rest } = opts;
  const res = await fetch(`${BASE}${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
    ...rest,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new APIError(data?.error || res.statusText, res.status);
  return data;
}

export const api = {
  // Auth
  login: (username, password, totp_code) => request('/api/auth/login', { body: { username, password, totp_code } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/me'),

  // Dashboard
  dashboard: () => request('/api/dashboard'),

  // Nodes
  nodes: () => request('/api/nodes').then(r => r.items || []),
  updateNode: (id, data) => request(`/api/nodes/${id}`, { method: 'PUT', body: data }),
  deleteNode: (id) => request(`/api/nodes/${id}`, { method: 'DELETE' }),

  // Rules
  rules: () => request('/api/rules').then(r => r.items || []),
  createRule: (data) => request('/api/rules', { body: data }),
  updateRule: (id, data) => request(`/api/rules/${id}`, { method: 'PUT', body: data }),
  deleteRule: (id) => request(`/api/rules/${id}`, { method: 'DELETE' }),
  toggleRule: (id) => request(`/api/rules/${id}/toggle`, { method: 'POST' }),
  testRule: (id) => request(`/api/rules/${id}/test`, { method: 'POST' }),
  cloneRule: (id) => request(`/api/rules/${id}/clone`, { method: 'POST' }),
  resetRuleTraffic: (id) => request(`/api/rules/reset-traffic/${id}`, { method: 'POST' }),
  rulesByTags: (tags) => request(`/api/rules/tags?tags=${encodeURIComponent(tags.join(','))}`).then(r => r.items || []),

  // Users
  users: () => request('/api/users').then(r => r.items || []),
  createUser: (data) => request('/api/users', { body: data }),
  updateUser: (id, data) => request(`/api/users/${id}`, { method: 'PUT', body: data }),
  deleteUser: (id) => request(`/api/users/${id}`, { method: 'DELETE' }),
  resetUserTraffic: (id) => request(`/api/users/reset-traffic/${id}`, { method: 'POST' }),

  // Node tokens
  nodeTokens: () => request('/api/node-tokens').then(r => r.items || []),
  createNodeToken: (data) => request('/api/node-tokens', { body: data }),

  // Statuses
  statuses: () => request('/api/statuses').then(r => r.items || []),
  connectivityTests: (params) => request(`/api/connectivity-tests?${new URLSearchParams(params)}`).then(r => r.items || []),

  // Traffic
  trafficTimeseries: (range) => request(`/api/traffic/timeseries?range=${range}`),

  // Audit
  auditLogs: (limit = 200) => request(`/api/audit-logs?limit=${limit}`).then(r => r.items || []),

  // Backups
  backups: () => request('/api/backups').then(r => r.items || []),
  createBackup: () => request('/api/backups', { method: 'POST' }),
  restoreBackup: (name) => request(`/api/backups/${name}/restore`, { method: 'POST' }),

  // Settings
  settings: () => request('/api/settings').then(r => r.items || {}),
  updateSettings: (data) => request('/api/settings', { method: 'PUT', body: data }),

  // Account
  changePassword: (data) => request('/api/account/password', { body: data }),
  sessions: () => request('/api/account/sessions').then(r => r.items || []),
  logoutOthers: () => request('/api/account/sessions/logout-others', { method: 'POST' }),
  totpSetup: () => request('/api/account/totp/setup', { method: 'POST' }),
  totpEnable: (code, password) => request('/api/account/totp/enable', { body: { code, password } }),
  totpDisable: (code) => request('/api/account/totp/disable', { body: { code } }),
};