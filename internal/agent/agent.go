package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/idcsu/relayguard/internal/common"
)

type Config struct {
	PanelURL      string `json:"panel_url"`
	Token         string `json:"token,omitempty"`
	NodeID        string `json:"node_id"`
	NodeSecret    string `json:"node_secret"`
	Name          string `json:"name"`
	SSHPorts      []int  `json:"ssh_ports"`
	ExtraAllowTCP []int  `json:"extra_allow_tcp,omitempty"`
	ExtraAllowUDP []int  `json:"extra_allow_udp,omitempty"`
	FirewallICMP  bool   `json:"firewall_allow_icmp"`
	DataDir       string `json:"-"`
}

type Agent struct {
	cfg         Config
	mgr         *Manager
	client      *http.Client
	lastErr     string
	stopCh      chan struct{}
	testMu      sync.Mutex
	testResults []common.ConnectivityTestResult
}

func New(cfg Config) *Agent {
	fwCfg := FirewallConfig{SSHPorts: cfg.SSHPorts, ExtraAllowTCP: cfg.ExtraAllowTCP, ExtraAllowUDP: cfg.ExtraAllowUDP, AllowICMP: cfg.FirewallICMP}
	return &Agent{cfg: cfg, mgr: NewManager(cfg.DataDir, fwCfg), client: &http.Client{Timeout: 20 * time.Second}, stopCh: make(chan struct{})}
}

func LoadConfig(dataDir string) (Config, error) {
	b, err := os.ReadFile(filepath.Join(dataDir, "agent.json"))
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		return Config{}, err
	}
	cfg.DataDir = dataDir
	return cfg, nil
}

func (a *Agent) SaveConfig() error {
	if err := os.MkdirAll(a.cfg.DataDir, 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(a.cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(a.cfg.DataDir, "agent.json"), b, 0600)
}

func (a *Agent) Stop() {
	close(a.stopCh)
}

func (a *Agent) Run() error {
	if a.cfg.PanelURL == "" {
		return fmt.Errorf("缺少面板地址")
	}
	a.cfg.PanelURL = strings.TrimRight(a.cfg.PanelURL, "/")
	if len(a.cfg.SSHPorts) == 0 {
		a.cfg.SSHPorts = []int{22}
	}
	if !a.cfg.FirewallICMP {
		a.cfg.FirewallICMP = true
	}
	if a.cfg.NodeID == "" || a.cfg.NodeSecret == "" {
		if err := a.Register(); err != nil {
			return err
		}
	}
	if err := a.SaveConfig(); err != nil {
		return err
	}
	if last := a.mgr.LoadLastRules(); len(last) > 0 {
		if err := a.mgr.Apply(last, "off"); err != nil {
			log.Printf("恢复上次规则时防火墙处理失败：%v", err)
		}
		log.Printf("已按上次成功配置恢复 %d 条转发规则", len(last))
	}
	log.Printf("RelayGuard Agent 已启动，节点 ID：%s，面板：%s", a.cfg.NodeID, a.cfg.PanelURL)
	const baseInterval = 10 * time.Second
	const maxInterval = 5 * time.Minute
	interval := baseInterval
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := a.heartbeatOnce(); err != nil {
				a.lastErr = err.Error()
				log.Printf("心跳失败：%v", err)
				interval = interval * 2
				if interval > maxInterval {
					interval = maxInterval
				}
				ticker.Reset(interval)
			} else {
				a.lastErr = ""
				if interval != baseInterval {
					interval = baseInterval
					ticker.Reset(baseInterval)
				}
			}
		case <-a.stopCh:
			log.Printf("Agent 正在关闭...")
			a.mgr.Stop()
			return nil
		}
	}
}

func (a *Agent) Register() error {
	if a.cfg.Token == "" {
		return fmt.Errorf("缺少节点注册 Token")
	}
	host, _ := os.Hostname()
	if a.cfg.Name == "" {
		a.cfg.Name = host
	}
	req := common.AgentRegisterRequest{Token: a.cfg.Token, Name: a.cfg.Name, Hostname: host, OS: runtime.GOOS, Arch: runtime.GOARCH, AgentVersion: common.Version, PrivateIPs: privateIPs()}
	var resp common.AgentRegisterResponse
	if err := a.postJSON("/api/agent/register", req, &resp, false); err != nil {
		return err
	}
	a.cfg.NodeID = resp.NodeID
	a.cfg.NodeSecret = resp.NodeSecret
	a.cfg.Token = ""
	log.Printf("节点注册成功：%s", resp.NodeID)
	return nil
}

func (a *Agent) heartbeatOnce() error {
	host, _ := os.Hostname()
	mode, fwState, fwErr := a.mgr.FirewallStatus()
	req := common.AgentHeartbeatRequest{NodeID: a.cfg.NodeID, AgentVersion: common.Version, Hostname: host, OS: runtime.GOOS, Arch: runtime.GOARCH, PrivateIPs: privateIPs(), Metrics: CollectMetrics(), RuleStatuses: a.mgr.Statuses(), TestResults: a.drainTestResults(), FirewallMode: mode, FirewallState: fwState, FirewallError: fwErr, LastError: a.lastErr}
	var resp common.AgentHeartbeatResponse
	if err := a.postJSON("/api/agent/heartbeat", req, &resp, true); err != nil {
		return err
	}
	if err := a.mgr.Apply(resp.Rules, resp.FirewallMode); err != nil {
		a.lastErr = err.Error()
		log.Printf("应用规则或防火墙警告：%v", err)
	}
	if len(resp.TestRequests) > 0 {
		go a.runConnectivityTests(resp.TestRequests)
	}
	return nil
}

func (a *Agent) postJSON(path string, payload any, out any, signed bool) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, a.cfg.PanelURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if signed {
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		sig := common.HMACSHA256Hex(a.cfg.NodeSecret, append([]byte(ts+"\n"), body...))
		req.Header.Set("X-Node-ID", a.cfg.NodeID)
		req.Header.Set("X-Timestamp", ts)
		req.Header.Set("X-Signature", sig)
	}
	res, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	resBody, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode >= 300 {
		var apiErr common.APIError
		if json.Unmarshal(resBody, &apiErr) == nil && apiErr.Error != "" {
			return fmt.Errorf("%s", apiErr.Error)
		}
		return fmt.Errorf("面板返回 HTTP %d: %s", res.StatusCode, string(resBody))
	}
	if out != nil {
		return json.Unmarshal(resBody, out)
	}
	return nil
}

func privateIPs() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var ips []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			ips = append(ips, ip.String())
		}
	}
	return ips
}

func CollectMetrics() common.NodeMetrics {
	m := common.NodeMetrics{}
	m.Load1 = readLoad()
	m.CPUPercent = readCPU()
	m.MemoryTotal, m.MemoryUsed = readMem()
	m.DiskTotal, m.DiskUsed = readDisk("/")
	m.NetIn, m.NetOut = readNet()
	m.Uptime = readUptime()
	return m
}

func readLoad() float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(fields[0], 64)
	return v
}

// readCPU returns the CPU usage percentage based on /proc/stat.
// It reads two successive snapshots (100ms apart) to compute the active ratio.
func readCPU() float64 {
	readStat := func() (idle, total uint64) {
		b, err := os.ReadFile("/proc/stat")
		if err != nil {
			return 0, 1
		}
		lines := strings.Split(string(b), "\n")
		if len(lines) == 0 {
			return 0, 1
		}
		fields := strings.Fields(lines[0])
		if len(fields) < 5 || fields[0] != "cpu" {
			return 0, 1
		}
		var vals [8]uint64
		for i := 1; i < len(fields) && i <= 8; i++ {
			v, _ := strconv.ParseUint(fields[i], 10, 64)
			vals[i-1] = v
		}
		idle = vals[3] + vals[6] // idle + steal
		for _, v := range vals {
			total += v
		}
		return
	}
	idle1, total1 := readStat()
	time.Sleep(100 * time.Millisecond)
	idle2, total2 := readStat()
	dIdle := idle2 - idle1
	dTotal := total2 - total1
	if dTotal == 0 {
		return 0
	}
	return float64(dTotal-dIdle) / float64(dTotal) * 100
}

func readMem() (total, used uint64) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	vals := map[string]uint64{}
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			key := strings.TrimSuffix(fields[0], ":")
			v, _ := strconv.ParseUint(fields[1], 10, 64)
			vals[key] = v * 1024
		}
	}
	total = vals["MemTotal"]
	available := vals["MemAvailable"]
	if total > available {
		used = total - available
	}
	return
}

func readDisk(path string) (total, used uint64) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0
	}
	total = stat.Blocks * uint64(stat.Bsize)
	available := stat.Bavail * uint64(stat.Bsize)
	if total > available {
		used = total - available
	}
	return
}

func readNet() (in, out uint64) {
	b, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.Contains(line, ":") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		name := strings.TrimSpace(parts[0])
		if name == "lo" {
			continue
		}
		fields := strings.Fields(parts[1])
		if len(fields) >= 16 {
			rx, _ := strconv.ParseUint(fields[0], 10, 64)
			tx, _ := strconv.ParseUint(fields[8], 10, 64)
			in += rx
			out += tx
		}
	}
	return
}

func readUptime() uint64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	f, _ := strconv.ParseFloat(fields[0], 64)
	return uint64(f)
}

func (a *Agent) drainTestResults() []common.ConnectivityTestResult {
	a.testMu.Lock()
	defer a.testMu.Unlock()
	if len(a.testResults) == 0 {
		return nil
	}
	out := append([]common.ConnectivityTestResult(nil), a.testResults...)
	a.testResults = nil
	return out
}

func (a *Agent) appendTestResult(result common.ConnectivityTestResult) {
	a.testMu.Lock()
	defer a.testMu.Unlock()
	a.testResults = append(a.testResults, result)
}

func (a *Agent) runConnectivityTests(reqs []common.ConnectivityTestRequest) {
	for _, req := range reqs {
		result := RunConnectivityTest(req)
		if a.mgr.RuleRunning(req.RuleID, req.Protocol) {
			result.LocalListenOK = true
			result.Details = append([]string{"Agent 运行状态：本地转发器已运行"}, result.Details...)
		}
		a.appendTestResult(result)
	}
}
