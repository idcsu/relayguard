#!/usr/bin/env python3
from pathlib import Path

FILES = [
    Path('web/dist/app.js'),
    Path('internal/panel/webdist/app.js'),
]

FIREWALL_REPLACEMENT = r'''function firewallDisplay(n) {
  const mode = n.firewall_mode || 'loose';
  const st = n.firewall_state || '';
  if (mode === 'strict-pending') return { cls: 'warn', text: '严格待确认', pending: true };
  if (mode === 'strict' && st === 'strict-pending') return { cls: 'warn', text: '严格确认中', pending: false };
  if (st === 'error' || n.firewall_error) return { cls: 'err', text: '异常', pending: false };
  if (st === 'unsupported') return { cls: 'warn', text: '不支持', pending: false };
  if (st === 'rollback') return { cls: 'warn', text: '已回滚', pending: false };
  if (mode === 'strict') return { cls: 'ok', text: '严格托管', pending: false };
  if (mode === 'loose') return { cls: 'off', text: '宽松托管', pending: false };
  if (mode === 'off') return { cls: 'off', text: '未托管', pending: false };
  return { cls: 'off', text: st || mode || '未知', pending: false };
}
function firewallText(n) {
  const d = firewallDisplay(n);
  return badge(d.cls, d.text);
}
function firewallPendingNotice(n) {
  if (!n || n.firewall_mode !== 'strict-pending') return '';
  return `<div class="notice warn firewall-pending-notice">
    <strong>严格防火墙待确认</strong>
    <p>Agent 已进入 60 秒严格防火墙试运行。请确认当前 SSH 和面板访问正常后点击“确认严格”，否则 Agent 会自动回滚。</p>
  </div>`;
}
'''

TOKENS_REPLACEMENT = r'''function tokensPage() {
  if (!isAdmin()) return `<div class="empty">需要管理员权限。</div>`;
  return `
  <div class="section-head">
    <div>
      <h2>节点接入</h2>
      <p>生成一次性接入 Token，然后在转发节点服务器执行安装命令。Token 只显示一次。</p>
    </div>
    <button class="primary" data-action="create-token">生成接入 Token</button>
  </div>
  <div class="card guide-card">
    <h3>接入说明</h3>
    <div class="guide-grid">
      <div><b>1. 生成 Token</b><p>建议按节点用途命名，例如“香港中转-01”。</p></div>
      <div><b>2. 节点执行命令</b><p>Agent 会主动注册并定期心跳，不需要面板保存 SSH 密钥。</p></div>
      <div><b>3. 防火墙保护</b><p>Agent 会自动识别当前 SSH 端口，严格模式支持 60 秒确认和自动回滚。</p></div>
    </div>
    <p class="muted">节点本地救援命令：<code>relayguard-agent firewall rescue</code></p>
  </div>
  <div id="tokenBox"></div>`;
}
async function createToken() {
  modal(`
    <div class="modal-head">
      <div>
        <h2>生成节点接入 Token</h2>
        <p>Token 默认只显示一次，请生成后立即复制安装命令。</p>
      </div>
      <button class="ghost" data-action="close-modal">关闭</button>
    </div>
    <form id="tokenForm" class="form-grid">
      <label>节点名称
        <input name="name" value="新转发节点" placeholder="例如：香港中转-01" required>
      </label>
      <label>有效期
        <select name="hours">
          <option value="1">1 小时</option>
          <option value="6">6 小时</option>
          <option value="24" selected>24 小时</option>
          <option value="72">3 天</option>
          <option value="168">7 天</option>
        </select>
      </label>
      <div class="notice warn">
        Token 创建后只展示一次。请不要把包含 Token 的安装命令发给无关人员。
      </div>
      <div class="form-actions">
        <button type="button" class="ghost" data-action="close-modal">取消</button>
        <button class="primary" id="tokenSubmitBtn">生成 Token</button>
      </div>
    </form>
    <div id="tokenResult"></div>
  `);
  $('#tokenForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const btn = $('#tokenSubmitBtn');
    btn.disabled = true;
    btn.textContent = '生成中...';
    try {
      const d = await api('/api/node-tokens', {
        method:'POST',
        body: JSON.stringify({ name: fd.name || '新转发节点', hours: Number(fd.hours || 24) })
      });
      const origin = location.origin;
      const cmd = `curl -fsSL ${origin}/api/agent/install.sh | bash -s -- --panel ${origin} --token ${d.item.plain_token}`;
      $('#tokenResult').innerHTML = `
        <div class="token-result">
          <h3>接入 Token 已生成</h3>
          <p class="muted">以下内容只显示一次。请复制安装命令到节点服务器执行。</p>
          <label>一次性 Token
            <textarea readonly rows="3">${esc(d.item.plain_token)}</textarea>
          </label>
          <label>节点安装命令
            <textarea readonly rows="5">${esc(cmd)}</textarea>
          </label>
        </div>`;
      e.target.remove();
      toast('Token 已生成，仅显示一次');
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = '生成 Token';
    }
  });
}
'''

CONFIRM_REPLACEMENT = r'''async function confirmStrict(n) {
  if (!n) return;
  if (n.firewall_mode !== 'strict-pending') {
    toast('该节点当前不处于严格待确认状态');
    return;
  }
  if (!confirm('确认该节点严格防火墙模式工作正常？确认后将长期保持严格模式。')) return;
  const payload = { name:n.name, port_range_start:n.port_range_start, port_range_end:n.port_range_end, firewall_mode:'strict', max_rules:n.max_rules || 0 };
  try {
    await api(`/api/nodes/${n.id}`, { method:'PUT', body: JSON.stringify(payload) });
    n.firewall_mode = 'strict';
    n.firewall_state = 'strict-pending';
    renderContent();
    toast('已提交严格模式确认，等待 Agent 下一次心跳确认状态');
    setTimeout(async () => { await refreshAll(); renderContent(); }, 2500);
  } catch(e) { toast(e.message); }
}
'''

APPEND_CSS = r'''

/* v0.11.1 UX fixes */
.notice.warn.firewall-pending-notice{margin-top:10px;border:1px solid rgba(245,158,11,.35);background:rgba(245,158,11,.10);border-radius:16px;padding:12px 14px;color:#92400e}
.notice.warn.firewall-pending-notice strong{display:block;margin-bottom:4px;color:#78350f}
.notice.warn.firewall-pending-notice p{margin:0;line-height:1.6}
.guide-card{margin-top:16px}.guide-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.guide-grid p{margin:.35rem 0 0;color:var(--muted)}
.token-result{margin-top:18px;border:1px solid var(--border);background:var(--card);border-radius:18px;padding:18px;box-shadow:var(--shadow)}
.token-result textarea{width:100%;margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace;resize:vertical}
.form-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:10px}
@media (max-width:900px){.guide-grid{grid-template-columns:1fr}}
'''


def replace_between(s, start_marker, end_marker, replacement, keep_end=True):
    start = s.index(start_marker)
    end = s.index(end_marker, start)
    return s[:start] + replacement + (s[end:] if keep_end else s[end+len(end_marker):])

for path in FILES:
    s = path.read_text()
    if 'function firewallDisplay(n)' not in s:
        s = replace_between(s, 'function firewallText(n) {', 'function toast(msg)', FIREWALL_REPLACEMENT)
    if 'function createToken()' in s and '生成节点接入 Token' not in s:
        s = replace_between(s, 'function tokensPage() {', 'function usersPage()', TOKENS_REPLACEMENT)
    if 'async function confirmStrict(n) {' in s and '等待 Agent 下一次心跳确认状态' not in s:
        s = replace_between(s, 'async function confirmStrict(n) {', 'function userModal(', CONFIRM_REPLACEMENT)
    s = s.replace('${nodeBadge(n)}${firewallText(n)}${n.firewall_error?', '${nodeBadge(n)}${firewallText(n)}${firewallPendingNotice(n)}${n.firewall_error?')
    s = s.replace('防火墙：${firewallText(n)}\n', '防火墙：${firewallText(n)}${firewallPendingNotice(n)}\n')
    path.write_text(s)

# Append css to both style files if present.
for css_path in [Path('web/dist/style.css'), Path('internal/panel/webdist/style.css')]:
    if css_path.exists():
        css = css_path.read_text()
        if 'v0.11.1 UX fixes' not in css:
            css_path.write_text(css + APPEND_CSS)

# Update version strings conservatively.
for p in [Path('internal/common/version.go'), Path('README.md')]:
    if p.exists():
        txt = p.read_text()
        txt = txt.replace('0.11.0', '0.11.1').replace('v0.11.0', 'v0.11.1')
        p.write_text(txt)

print('patched RelayGuard UI fixes for v0.11.1')
