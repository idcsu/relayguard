const styles = {
  ok: 'badge-ok', online: 'badge-ok', active: 'badge-ok', enabled: 'badge-ok', running: 'badge-ok',
  warn: 'badge-warn', warning: 'badge-warn', pending: 'badge-warn', degraded: 'badge-warn',
  danger: 'badge-danger', error: 'badge-danger', offline: 'badge-danger', disabled: 'badge-danger', stopped: 'badge-danger',
  muted: 'badge-muted', unknown: 'badge-muted', inactive: 'badge-muted',
};
export default function Badge({ status, label }) {
  const cls = styles[(status||'').toLowerCase()] || 'badge-muted';
  return <span className={cls}>{label || status}</span>;
}
