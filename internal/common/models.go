package common

import "time"

const (
	ProjectName   = "RelayGuard"
	ProjectNameCN = "中转卫士"
	Version       = "0.19.1"
)

type User struct {
	ID             string     `json:"id"`
	Username       string     `json:"username"`
	PasswordHash   string     `json:"password_hash,omitempty"`
	Role           string     `json:"role"`
	TrafficLimit   uint64     `json:"traffic_limit"`
	TrafficUsed    uint64     `json:"traffic_used"`
	RuleLimit      int        `json:"rule_limit"`
	AllowedNodeIDs []string   `json:"allowed_node_ids"`
	PortRangeStart int        `json:"port_range_start"`
	PortRangeEnd   int        `json:"port_range_end"`
	ExpiresAt      *time.Time `json:"expires_at,omitempty"`
	Disabled       bool       `json:"disabled"`
	MustChange     bool       `json:"must_change"`
	TOTPEnabled    bool       `json:"totp_enabled"`
	TOTPSecret     string     `json:"totp_secret,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

type Session struct {
	Token     string    `json:"token"`
	UserID    string    `json:"user_id"`
	IP        string    `json:"ip"`
	UserAgent string    `json:"user_agent"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

type Node struct {
	ID             string      `json:"id"`
	Name           string      `json:"name"`
	Secret         string      `json:"secret,omitempty"`
	Status         string      `json:"status"`
	Hostname       string      `json:"hostname"`
	OS             string      `json:"os"`
	Arch           string      `json:"arch"`
	AgentVersion   string      `json:"agent_version"`
	PublicIP       string      `json:"public_ip"`
	PrivateIPs     []string    `json:"private_ips"`
	PortRangeStart int         `json:"port_range_start"`
	PortRangeEnd   int         `json:"port_range_end"`
	FirewallMode   string      `json:"firewall_mode"`
	MaxRules       int         `json:"max_rules"`
	LastSeenAt     *time.Time  `json:"last_seen_at,omitempty"`
	LastMetrics    NodeMetrics `json:"last_metrics"`
	LastError      string      `json:"last_error"`
	FirewallState  string      `json:"firewall_state"`
	FirewallError  string      `json:"firewall_error"`
	CreatedAt      time.Time   `json:"created_at"`
	UpdatedAt      time.Time   `json:"updated_at"`
}

type NodeToken struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	TokenHash  string     `json:"token_hash"`
	PlainToken string     `json:"plain_token,omitempty"`
	UsedByNode string     `json:"used_by_node,omitempty"`
	UsedAt     *time.Time `json:"used_at,omitempty"`
	MaxUses    int        `json:"max_uses"`
	UsedCount  int        `json:"used_count"`
	ExpiresAt  time.Time  `json:"expires_at"`
	CreatedAt  time.Time  `json:"created_at"`
}

type ForwardRule struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	UserID          string     `json:"user_id"`
	NodeID          string     `json:"node_id"`
	Protocol        string     `json:"protocol"` // tcp, udp, both
	ListenPort      int        `json:"listen_port"`
	TargetHost      string     `json:"target_host"`
	TargetPort      int        `json:"target_port"`
	Enabled         bool       `json:"enabled"`
	SourceCIDRs     []string   `json:"source_cidrs"`
	SpeedLimitMbps  int        `json:"speed_limit_mbps"`
	MaxConnections  int        `json:"max_connections"`
	TrafficLimit    uint64     `json:"traffic_limit"`
	TrafficUsed     uint64     `json:"traffic_used"`
	ExpireAt        *time.Time `json:"expire_at,omitempty"`
	Description     string     `json:"description"`
	FirewallManaged bool       `json:"firewall_managed"`
	Tags            []string   `json:"tags"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

type RuleRuntimeStatus struct {
	RuleID            string    `json:"rule_id"`
	State             string    `json:"state"` // running, stopped, error, unsupported
	Protocol          string    `json:"protocol"`
	ListenPort        int       `json:"listen_port"`
	ActiveConnections int       `json:"active_connections"`
	BytesIn           uint64    `json:"bytes_in"`
	BytesOut          uint64    `json:"bytes_out"`
	LastError         string    `json:"last_error"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type NodeMetrics struct {
	Load1       float64 `json:"load1"`
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryTotal uint64  `json:"memory_total"`
	MemoryUsed  uint64  `json:"memory_used"`
	DiskTotal   uint64  `json:"disk_total"`
	DiskUsed    uint64  `json:"disk_used"`
	NetIn       uint64  `json:"net_in"`
	NetOut      uint64  `json:"net_out"`
	Uptime      uint64  `json:"uptime"`
}

type AgentRegisterRequest struct {
	Token        string   `json:"token"`
	Name         string   `json:"name"`
	Hostname     string   `json:"hostname"`
	OS           string   `json:"os"`
	Arch         string   `json:"arch"`
	AgentVersion string   `json:"agent_version"`
	PrivateIPs   []string `json:"private_ips"`
}

type AgentRegisterResponse struct {
	NodeID     string `json:"node_id"`
	NodeSecret string `json:"node_secret"`
	PanelName  string `json:"panel_name"`
	Version    string `json:"version"`
}

type AgentHeartbeatRequest struct {
	NodeID        string                   `json:"node_id"`
	AgentVersion  string                   `json:"agent_version"`
	Hostname      string                   `json:"hostname"`
	OS            string                   `json:"os"`
	Arch          string                   `json:"arch"`
	PrivateIPs    []string                 `json:"private_ips"`
	Metrics       NodeMetrics              `json:"metrics"`
	RuleStatuses  []RuleRuntimeStatus      `json:"rule_statuses"`
	TestResults   []ConnectivityTestResult `json:"test_results"`
	FirewallMode  string                   `json:"firewall_mode"`
	FirewallState string                   `json:"firewall_state"`
	FirewallError string                   `json:"firewall_error"`
	LastError     string                   `json:"last_error"`
}

type AgentHeartbeatResponse struct {
	ServerTime   time.Time                 `json:"server_time"`
	Rules        []ForwardRule             `json:"rules"`
	Message      string                    `json:"message"`
	FirewallMode string                    `json:"firewall_mode"`
	TestRequests []ConnectivityTestRequest `json:"test_requests"`
}

type ConnectivityTestRequest struct {
	ID         string    `json:"id"`
	RuleID     string    `json:"rule_id"`
	NodeID     string    `json:"node_id"`
	Protocol   string    `json:"protocol"`
	ListenPort int       `json:"listen_port"`
	TargetHost string    `json:"target_host"`
	TargetPort int       `json:"target_port"`
	CreatedAt  time.Time `json:"created_at"`
}

type ConnectivityTestResult struct {
	ID            string     `json:"id"`
	RuleID        string     `json:"rule_id"`
	NodeID        string     `json:"node_id"`
	RequestedBy   string     `json:"requested_by,omitempty"`
	Protocol      string     `json:"protocol"`
	ListenPort    int        `json:"listen_port"`
	TargetHost    string     `json:"target_host"`
	TargetPort    int        `json:"target_port"`
	Status        string     `json:"status"`
	LocalListenOK bool       `json:"local_listen_ok"`
	TargetTCPOK   bool       `json:"target_tcp_ok"`
	TargetUDPOK   bool       `json:"target_udp_ok"`
	PingOK        bool       `json:"ping_ok"`
	PingLatencyMS int        `json:"ping_latency_ms"`
	Error         string     `json:"error"`
	Details       []string   `json:"details"`
	CreatedAt     time.Time  `json:"created_at"`
	StartedAt     *time.Time `json:"started_at,omitempty"`
	FinishedAt    *time.Time `json:"finished_at,omitempty"`
}

type APIError struct {
	Error string `json:"error"`
}
