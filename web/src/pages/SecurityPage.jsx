import { Shield, Lock, Eye, Key, Server } from 'lucide-react';

const items = [
  { icon: Lock, title: '密码安全', desc: '密码使用 bcrypt 哈希存储，服务器无法读取明文密码。建议使用 12 位以上密码，包含大小写字母、数字和特殊字符。' },
  { icon: Key, title: '两步验证 (TOTP)', desc: '推荐所有管理员账号启用两步验证。登录时除密码外还需要验证器生成的 6 位数字，显著提高账号安全性。' },
  { icon: Eye, title: '会话管理', desc: '修改密码或角色后，旧会话将自动失效。可在「账号安全」页面查看所有活跃会话并注销其他设备。' },
  { icon: Shield, title: 'SSRF 防护', desc: '非管理员用户创建转发规则时，目标地址受限制，不允许指向内部网络（127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16）地址。' },
  { icon: Server, title: '写入速率限制', desc: '所有写操作 API（POST/PUT/DELETE）受速率限制保护，每 IP 每分钟最多 60 次请求。' },
  { icon: Shield, title: '审计日志', desc: '所有管理操作均被记录，包括登录、创建/修改/删除操作。日志默认保留 90 天，可在系统设置中调整。' },
];

export default function SecurityPage() {
  return (
    <div className="space-y-6 max-w-3xl">
      <h2 className="text-2xl font-bold">安全说明</h2>
      <p className="text-slate-500">RelayGuard 中转卫士安全机制介绍和建议。</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {items.map((item, i) => (
          <div key={i} className="card p-5">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl bg-brand-500/10 flex items-center justify-center text-brand-600">
                <item.icon className="w-5 h-5" />
              </div>
              <h3 className="font-bold">{item.title}</h3>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">{item.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}