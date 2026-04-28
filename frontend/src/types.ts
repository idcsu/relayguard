export type Role = 'super_admin' | 'admin' | 'user' | string;

export interface User {
  id: string;
  username: string;
  role: Role;
  disabled?: boolean;
  must_change?: boolean;
  rule_limit?: number;
  traffic_limit?: number;
  traffic_used?: number;
  port_range_start?: number;
  port_range_end?: number;
  expires_at?: string;
  allowed_node_ids?: string[];
  totp_enabled?: boolean;
}

export interface Metrics {
  cpu_percent?: number;
  memory_used?: number;
  memory_total?: number;
  disk_used?: number;
  disk_total?: number;
  network_rx?: number;
  network_tx?: number;
}

export interface NodeItem {
  id: string;
  name: string;
  status?: string;
  hostname?: string;
  os?: string;
  arch?: string;
  public_ip?: string;
  private_ips?: string[];
  agent_version?: string;
  last_seen_at?: string;
  port_range_start?: number;
  port_range_end?: number;
  max_rules?: number;
  firewall_mode?: string;
  firewall_state?: string;
  firewall_error?: string;
  last_error?: string;
  last_metrics?: Metrics;
}

export interface RuleStatus {
  state?: string;
  active_connections?: number;
  last_error?: string;
  updated_at?: string;
}

export interface RuleItem {
  id: string;
  name: string;
  description?: string;
  user_id?: string;
  node_id: string;
  protocol: 'tcp' | 'udp' | 'both' | string;
  listen_port: number;
  target_host: string;
  target_port: number;
  enabled?: boolean;
  traffic_used?: number;
  traffic_limit?: number;
  speed_limit_mbps?: number;
  max_connections?: number;
  expire_at?: string;
  source_cidrs?: string[];
  firewall_managed?: boolean;
  created_at?: string;
}

export interface ConnectivityTest {
  id: string;
  rule_id: string;
  node_id: string;
  status: string;
  local_listen_ok?: boolean;
  target_tcp_ok?: boolean;
  target_udp_ok?: boolean;
  ping_ok?: boolean;
  ping_latency_ms?: number;
  error?: string;
  details?: string[];
  created_at?: string;
  finished_at?: string;
}

export interface SessionItem {
  id: string;
  ip?: string;
  user_agent?: string;
  created_at?: string;
  expires_at?: string;
}

export interface BackupItem {
  name: string;
  size?: number;
  created_at?: string;
}


export interface TrafficPoint { time: string; total: number; delta?: number; }
