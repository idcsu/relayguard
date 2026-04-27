package agent

import (
	"bytes"
	"errors"
	"fmt"
	"net/netip"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/idcsu/relayguard/internal/common"
)

const relayGuardInputChain = "RELAYGUARD-INPUT"

const (
	firewallModeOff           = "off"
	firewallModeLoose         = "loose"
	firewallModeStrict        = "strict"
	firewallModeStrictPending = "strict-pending"
	firewallStateRollback     = "rollback"
)

type FirewallConfig struct {
	SSHPorts        []int `json:"ssh_ports"`
	ExtraAllowTCP   []int `json:"extra_allow_tcp,omitempty"`
	ExtraAllowUDP   []int `json:"extra_allow_udp,omitempty"`
	AllowICMP       bool  `json:"allow_icmp"`
	RollbackSeconds int   `json:"rollback_seconds,omitempty"`
}

type FirewallManager struct {
	mu       sync.Mutex
	bin      string
	cfg      FirewallConfig
	mode     string
	state    string
	lastErr  string
	lastHash string

	rollbackTimer  *time.Timer
	rollbackActive bool
	rollbackFired  bool
	rollbackUntil  time.Time
	pendingHash    string
}

type firewallPortRule struct {
	Proto string
	Port  int
	CIDRs []string
}

func NewFirewallManager(cfg FirewallConfig) *FirewallManager {
	cfg = normalizeFirewallConfig(cfg)
	fw := &FirewallManager{cfg: cfg, mode: firewallModeOff, state: firewallModeOff}
	if runtime.GOOS != "linux" {
		fw.state = "unsupported"
		fw.lastErr = "当前系统不是 Linux，暂不支持防火墙托管"
		return fw
	}
	if p, err := exec.LookPath("iptables"); err == nil {
		fw.bin = p
	} else {
		fw.state = "unsupported"
		fw.lastErr = "未找到 iptables，无法启用防火墙托管"
	}
	return fw
}

func normalizeFirewallConfig(cfg FirewallConfig) FirewallConfig {
	if len(cfg.SSHPorts) == 0 {
		cfg.SSHPorts = []int{22}
	}
	cfg.SSHPorts = uniquePorts(cfg.SSHPorts)
	cfg.ExtraAllowTCP = uniquePorts(cfg.ExtraAllowTCP)
	cfg.ExtraAllowUDP = uniquePorts(cfg.ExtraAllowUDP)
	if !cfg.AllowICMP {
		// 默认允许 ping，避免严格模式下排障困难。历史配置中零值视为允许。
		cfg.AllowICMP = true
	}
	if cfg.RollbackSeconds <= 0 {
		cfg.RollbackSeconds = 60
	}
	return cfg
}

func uniquePorts(in []int) []int {
	seen := map[int]bool{}
	out := make([]int, 0, len(in))
	for _, p := range in {
		if p < 1 || p > 65535 || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	sort.Ints(out)
	return out
}

func (fw *FirewallManager) Apply(mode string, rules []common.ForwardRule) error {
	fw.mu.Lock()
	defer fw.mu.Unlock()

	mode = normalizeFirewallMode(mode)
	if fw.bin == "" {
		fw.mode = mode
		if mode == firewallModeOff {
			fw.state = firewallModeOff
			fw.lastErr = ""
			return nil
		}
		fw.state = "unsupported"
		if fw.lastErr == "" {
			fw.lastErr = "未找到可用的 iptables"
		}
		return errors.New(fw.lastErr)
	}

	if mode != firewallModeStrictPending {
		fw.cancelRollbackLocked()
		fw.rollbackFired = false
		fw.pendingHash = ""
	}

	if mode == firewallModeOff {
		fw.mode = mode
		if err := fw.disableLocked(); err != nil {
			fw.state = "error"
			fw.lastErr = err.Error()
			return err
		}
		fw.state = firewallModeOff
		fw.lastErr = ""
		fw.lastHash = ""
		return nil
	}

	portRules := buildFirewallPortRules(rules)
	actualMode := mode
	if mode == firewallModeStrictPending {
		actualMode = firewallModeStrict
	}
	hash := mode + "|" + fmt.Sprint(fw.cfg.SSHPorts, fw.cfg.ExtraAllowTCP, fw.cfg.ExtraAllowUDP, fw.cfg.AllowICMP, portRules)

	if mode == firewallModeStrictPending && fw.rollbackFired && hash == fw.pendingHash {
		fw.mode = firewallModeStrictPending
		fw.state = firewallStateRollback
		if fw.lastErr == "" {
			fw.lastErr = "严格防火墙模式未在确认窗口内确认，已自动回滚；请在面板切换到宽松/关闭后再重新尝试严格模式"
		}
		return nil
	}

	if hash == fw.lastHash && fw.state == mode && fw.lastErr == "" {
		return nil
	}
	if err := fw.ensureChainLocked(); err != nil {
		fw.state = "error"
		fw.lastErr = err.Error()
		return err
	}
	if err := fw.flushChainLocked(); err != nil {
		fw.state = "error"
		fw.lastErr = err.Error()
		return err
	}
	if err := fw.populateChainLocked(actualMode, portRules); err != nil {
		fw.state = "error"
		fw.lastErr = err.Error()
		return err
	}
	fw.mode = mode
	fw.state = mode
	fw.lastHash = hash
	if mode == firewallModeStrictPending {
		fw.pendingHash = hash
		fw.startRollbackLocked(hash)
		fw.lastErr = fmt.Sprintf("严格防火墙待确认：请在 %d 秒内于面板点击确认，否则 Agent 会自动回滚", fw.cfg.RollbackSeconds)
	} else {
		fw.lastErr = ""
	}
	return nil
}

func normalizeFirewallMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case firewallModeLoose, firewallModeStrict, firewallModeStrictPending, firewallModeOff:
		return strings.ToLower(strings.TrimSpace(mode))
	case "", "not-managed":
		return firewallModeOff
	default:
		return firewallModeOff
	}
}

func buildFirewallPortRules(rules []common.ForwardRule) []firewallPortRule {
	out := []firewallPortRule{}
	for _, r := range rules {
		if !r.Enabled || !r.FirewallManaged {
			continue
		}
		cidrs := normalizeCIDRStrings(r.SourceCIDRs)
		if r.Protocol == "tcp" || r.Protocol == "both" {
			out = append(out, firewallPortRule{Proto: "tcp", Port: r.ListenPort, CIDRs: cidrs})
		}
		if r.Protocol == "udp" || r.Protocol == "both" {
			out = append(out, firewallPortRule{Proto: "udp", Port: r.ListenPort, CIDRs: cidrs})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Proto == out[j].Proto {
			return out[i].Port < out[j].Port
		}
		return out[i].Proto < out[j].Proto
	})
	return out
}

func normalizeCIDRStrings(cidrs []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, raw := range cidrs {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if !strings.Contains(raw, "/") {
			if ip, err := netip.ParseAddr(raw); err == nil {
				if ip.Is4() {
					raw += "/32"
				} else {
					raw += "/128"
				}
			}
		}
		if p, err := netip.ParsePrefix(raw); err == nil {
			s := p.String()
			if !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
	}
	sort.Strings(out)
	return out
}

func (fw *FirewallManager) ensureChainLocked() error {
	if err := fw.run("-N", relayGuardInputChain); err != nil && !strings.Contains(err.Error(), "Chain already exists") && !strings.Contains(err.Error(), "链已存在") {
		return err
	}
	if err := fw.run("-C", "INPUT", "-j", relayGuardInputChain); err != nil {
		// 插在第一条，让严格模式能先保护入口；链内会保留 SSH、已建立连接和托管端口。
		if err := fw.run("-I", "INPUT", "1", "-j", relayGuardInputChain); err != nil {
			return err
		}
	}
	return nil
}

func (fw *FirewallManager) flushChainLocked() error {
	return fw.run("-F", relayGuardInputChain)
}

func (fw *FirewallManager) populateChainLocked(mode string, rules []firewallPortRule) error {
	// 放行已经建立的连接，避免严格模式影响 Agent 到面板的回包和已有 SSH 会话。
	_ = fw.run("-A", relayGuardInputChain, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT")
	_ = fw.run("-A", relayGuardInputChain, "-m", "state", "--state", "ESTABLISHED,RELATED", "-j", "ACCEPT")
	_ = fw.run("-A", relayGuardInputChain, "-i", "lo", "-j", "ACCEPT")
	if fw.cfg.AllowICMP {
		_ = fw.run("-A", relayGuardInputChain, "-p", "icmp", "-j", "ACCEPT")
	}
	for _, p := range fw.cfg.SSHPorts {
		if err := fw.addAcceptPort("tcp", p, nil); err != nil {
			return err
		}
	}
	for _, p := range fw.cfg.ExtraAllowTCP {
		if err := fw.addAcceptPort("tcp", p, nil); err != nil {
			return err
		}
	}
	for _, p := range fw.cfg.ExtraAllowUDP {
		if err := fw.addAcceptPort("udp", p, nil); err != nil {
			return err
		}
	}
	for _, r := range rules {
		if err := fw.addAcceptPort(r.Proto, r.Port, r.CIDRs); err != nil {
			return err
		}
	}
	if mode == firewallModeStrict {
		// 严格托管：未命中上述放行规则的入站流量全部丢弃。
		return fw.run("-A", relayGuardInputChain, "-j", "DROP")
	}
	// 宽松托管：只确保转发端口被放行，其他入站流量继续交给系统原有防火墙规则处理。
	return fw.run("-A", relayGuardInputChain, "-j", "RETURN")
}

func (fw *FirewallManager) addAcceptPort(proto string, port int, cidrs []string) error {
	if port < 1 || port > 65535 {
		return nil
	}
	if len(cidrs) == 0 {
		return fw.run("-A", relayGuardInputChain, "-p", proto, "--dport", strconv.Itoa(port), "-j", "ACCEPT")
	}
	for _, cidr := range cidrs {
		if err := fw.run("-A", relayGuardInputChain, "-p", proto, "-s", cidr, "--dport", strconv.Itoa(port), "-j", "ACCEPT"); err != nil {
			return err
		}
	}
	return nil
}

func (fw *FirewallManager) startRollbackLocked(hash string) {
	if fw.rollbackActive && fw.pendingHash == hash {
		return
	}
	fw.cancelRollbackLocked()
	fw.rollbackActive = true
	fw.rollbackFired = false
	fw.rollbackUntil = time.Now().Add(time.Duration(fw.cfg.RollbackSeconds) * time.Second)
	fw.rollbackTimer = time.AfterFunc(time.Duration(fw.cfg.RollbackSeconds)*time.Second, func() {
		fw.mu.Lock()
		defer fw.mu.Unlock()
		if !fw.rollbackActive || fw.pendingHash != hash || fw.mode != firewallModeStrictPending {
			return
		}
		_ = fw.disableLocked()
		fw.rollbackActive = false
		fw.rollbackFired = true
		fw.state = firewallStateRollback
		fw.lastErr = "严格防火墙模式未在确认窗口内确认，已自动回滚并移除 RelayGuard 托管链"
	})
}

func (fw *FirewallManager) cancelRollbackLocked() {
	if fw.rollbackTimer != nil {
		fw.rollbackTimer.Stop()
		fw.rollbackTimer = nil
	}
	fw.rollbackActive = false
	fw.rollbackUntil = time.Time{}
}

func (fw *FirewallManager) Disable() error {
	fw.mu.Lock()
	defer fw.mu.Unlock()
	if fw.bin == "" {
		return errors.New("未找到 iptables，无法清理防火墙托管规则")
	}
	fw.cancelRollbackLocked()
	return fw.disableLocked()
}

func (fw *FirewallManager) disableLocked() error {
	for i := 0; i < 20; i++ {
		if err := fw.run("-C", "INPUT", "-j", relayGuardInputChain); err != nil {
			break
		}
		if err := fw.run("-D", "INPUT", "-j", relayGuardInputChain); err != nil {
			return err
		}
	}
	_ = fw.run("-F", relayGuardInputChain)
	_ = fw.run("-X", relayGuardInputChain)
	fw.state = firewallModeOff
	fw.lastHash = ""
	return nil
}

func (fw *FirewallManager) Status() (mode, state, lastErr string) {
	fw.mu.Lock()
	defer fw.mu.Unlock()
	return fw.mode, fw.state, fw.lastErr
}

func (fw *FirewallManager) Dump() string {
	fw.mu.Lock()
	defer fw.mu.Unlock()
	if fw.bin == "" {
		return fw.lastErr
	}
	out, err := fw.output("-S", relayGuardInputChain)
	if err != nil {
		return err.Error()
	}
	return out
}

func (fw *FirewallManager) run(args ...string) error {
	_, err := fw.output(args...)
	return err
}

func (fw *FirewallManager) output(args ...string) (string, error) {
	cmdArgs := append([]string{"-w"}, args...)
	cmd := exec.Command(fw.bin, cmdArgs...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("iptables %s: %s", strings.Join(args, " "), strings.TrimSpace(out.String()))
	}
	return out.String(), nil
}

func FirewallCLI(args []string) error {
	cmd := "status"
	if len(args) > 0 {
		cmd = args[0]
	}
	fw := NewFirewallManager(FirewallConfig{SSHPorts: []int{22}, AllowICMP: true})
	switch cmd {
	case "status":
		mode, state, lastErr := fw.Status()
		fmt.Printf("模式：%s\n状态：%s\n", mode, state)
		if lastErr != "" {
			fmt.Printf("错误：%s\n", lastErr)
		}
		if fw.bin != "" {
			fmt.Println("当前 RelayGuard 托管链：")
			fmt.Println(strings.TrimSpace(fw.Dump()))
		}
		return nil
	case "rescue", "disable-managed", "disable":
		if err := fw.Disable(); err != nil {
			return err
		}
		fmt.Println("已移除 RelayGuard 防火墙托管链入口，并清理托管规则。")
		return nil
	case "help", "-h", "--help":
		fmt.Println("用法：relayguard-agent firewall status|rescue|disable-managed")
		return nil
	default:
		return fmt.Errorf("未知防火墙命令：%s，可用：status、rescue、disable-managed", cmd)
	}
}
