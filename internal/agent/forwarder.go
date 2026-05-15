package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/idcsu/relayguard/internal/common"
)

type Manager struct {
	mu            sync.Mutex
	tcp           map[string]*tcpForwarder
	udp           map[string]*udpForwarder
	fw            *FirewallManager
	lastRulesPath string
	stopped       bool
}

func NewManager(dataDir string, fwCfg FirewallConfig) *Manager {
	path := ""
	if dataDir != "" {
		path = filepath.Join(dataDir, "last_rules.json")
	}
	m := &Manager{tcp: map[string]*tcpForwarder{}, udp: map[string]*udpForwarder{}, fw: NewFirewallManager(fwCfg), lastRulesPath: path}
	return m
}

func (m *Manager) Apply(rules []common.ForwardRule, firewallMode string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	wantTCP := map[string]common.ForwardRule{}
	wantUDP := map[string]common.ForwardRule{}
	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		if r.Protocol == "tcp" || r.Protocol == "both" {
			wantTCP[r.ID] = r
		}
		if r.Protocol == "udp" || r.Protocol == "both" {
			wantUDP[r.ID] = r
		}
	}
	for id, f := range m.tcp {
		if r, ok := wantTCP[id]; !ok || !sameRule(f.rule, r) {
			f.Stop()
			delete(m.tcp, id)
		}
	}
	for id, f := range m.udp {
		if r, ok := wantUDP[id]; !ok || !sameRule(f.rule, r) {
			f.Stop()
			delete(m.udp, id)
		}
	}
	for id, r := range wantTCP {
		if _, ok := m.tcp[id]; !ok {
			f := newTCPForwarder(r)
			m.tcp[id] = f
			go f.Run()
		}
	}
	for id, r := range wantUDP {
		if _, ok := m.udp[id]; !ok {
			f := newUDPForwarder(r)
			m.udp[id] = f
			go f.Run()
		}
	}
	if m.fw != nil {
		if err := m.fw.Apply(firewallMode, rules); err != nil {
			return err
		}
	}
	m.persistRules(rules)
	return nil
}

func (m *Manager) Statuses() []common.RuleRuntimeStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []common.RuleRuntimeStatus
	for _, f := range m.tcp {
		out = append(out, f.Status())
	}
	for _, f := range m.udp {
		out = append(out, f.Status())
	}
	return out
}

func (m *Manager) LoadLastRules() []common.ForwardRule {
	if m.lastRulesPath == "" {
		return nil
	}
	b, err := os.ReadFile(m.lastRulesPath)
	if err != nil {
		return nil
	}
	var rules []common.ForwardRule
	if json.Unmarshal(b, &rules) != nil {
		return nil
	}
	return rules
}

func (m *Manager) persistRules(rules []common.ForwardRule) {
	if m.lastRulesPath == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(m.lastRulesPath), 0700)
	b, err := json.MarshalIndent(rules, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(m.lastRulesPath, b, 0600)
}

func (m *Manager) RuleRunning(id string, protocol string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if protocol == "tcp" || protocol == "both" {
		if f, ok := m.tcp[id]; ok {
			if st, _ := f.state.Load().(string); st == "running" {
				return true
			}
		}
	}
	if protocol == "udp" || protocol == "both" {
		if f, ok := m.udp[id]; ok {
			if st, _ := f.state.Load().(string); st == "running" {
				return true
			}
		}
	}
	return false
}

func (m *Manager) FirewallStatus() (mode, state, lastErr string) {
	if m.fw == nil {
		return "off", "not-managed", ""
	}
	return m.fw.Status()
}

func (m *Manager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, f := range m.tcp {
		f.Stop()
	}
	for _, f := range m.udp {
		f.Stop()
	}
}

func sameRule(a, b common.ForwardRule) bool {
	if a.Protocol != b.Protocol || a.ListenPort != b.ListenPort || a.TargetHost != b.TargetHost || a.TargetPort != b.TargetPort || a.SpeedLimitMbps != b.SpeedLimitMbps || a.MaxConnections != b.MaxConnections {
		return false
	}
	if len(a.SourceCIDRs) != len(b.SourceCIDRs) {
		return false
	}
	aSorted := make([]string, len(a.SourceCIDRs))
	copy(aSorted, a.SourceCIDRs)
	bSorted := make([]string, len(b.SourceCIDRs))
	copy(bSorted, b.SourceCIDRs)
	sort.Strings(aSorted)
	sort.Strings(bSorted)
	for i := range aSorted {
		if aSorted[i] != bSorted[i] {
			return false
		}
	}
	return true
}

type tcpForwarder struct {
	rule     common.ForwardRule
	ln       net.Listener
	stop     chan struct{}
	state    atomic.Value
	err      atomic.Value
	active   int64
	bytesIn  uint64
	bytesOut uint64
	prefix   []netip.Prefix
	limiter  *rateLimiter // per-rule 限速器
}

type rateLimiter struct {
	bw         int64 // bytes per second, 0 = unlimited
	mu         sync.Mutex
	available  int64
	lastRefill time.Time
}

func newRateLimiter(mbps int) *rateLimiter {
	var bw int64
	if mbps > 0 {
		bw = int64(mbps) * 1024 * 1024 / 8
	}
	return &rateLimiter{bw: bw, available: bw, lastRefill: time.Now()}
}

func (rl *rateLimiter) wait(n int) {
	if rl.bw == 0 {
		return
	}
	rl.mu.Lock()
	now := time.Now()
	elapsed := now.Sub(rl.lastRefill)
	if elapsed > 0 {
		rl.available += int64(elapsed.Seconds() * float64(rl.bw))
		if rl.available > rl.bw {
			rl.available = rl.bw
		}
		rl.lastRefill = now
	}
	rl.mu.Unlock()

	for n > 0 {
		chunk := n
		if chunk > 32*1024 {
			chunk = 32 * 1024
		}
		rl.mu.Lock()
		for rl.available < int64(chunk) {
			rl.mu.Unlock()
			time.Sleep(time.Duration(float64(int64(chunk)-rl.available) / float64(rl.bw) * float64(time.Second)))
			rl.mu.Lock()
			now := time.Now()
			elapsed := now.Sub(rl.lastRefill)
			if elapsed > 0 {
				rl.available += int64(elapsed.Seconds() * float64(rl.bw))
				if rl.available > rl.bw {
					rl.available = rl.bw
				}
				rl.lastRefill = now
			}
		}
		rl.available -= int64(chunk)
		rl.mu.Unlock()
		n -= chunk
	}
}

func newTCPForwarder(rule common.ForwardRule) *tcpForwarder {
	f := &tcpForwarder{rule: rule, stop: make(chan struct{}), prefix: parsePrefixes(rule.SourceCIDRs), limiter: newRateLimiter(rule.SpeedLimitMbps)}
	f.state.Store("starting")
	return f
}

func (f *tcpForwarder) Run() {
	addr := ":" + strconv.Itoa(f.rule.ListenPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		f.state.Store("error")
		f.err.Store(err.Error())
		log.Printf("TCP 规则 %s 监听失败：%v", f.rule.ID, err)
		return
	}
	f.ln = ln
	f.state.Store("running")
	f.err.Store("")
	log.Printf("TCP 规则 %s 已启动：%s -> %s:%d", f.rule.ID, addr, f.rule.TargetHost, f.rule.TargetPort)
	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-f.stop:
				f.state.Store("stopped")
				return
			default:
				f.state.Store("error")
				f.err.Store(err.Error())
				continue
			}
		}
		if !f.allowed(conn.RemoteAddr()) {
			_ = conn.Close()
			continue
		}
		if f.rule.MaxConnections > 0 && atomic.LoadInt64(&f.active) >= int64(f.rule.MaxConnections) {
			_ = conn.Close()
			continue
		}
		atomic.AddInt64(&f.active, 1)
		go f.handle(conn)
	}
}

func (f *tcpForwarder) handle(client net.Conn) {
	defer atomic.AddInt64(&f.active, -1)
	defer client.Close()
	target := net.JoinHostPort(f.rule.TargetHost, strconv.Itoa(f.rule.TargetPort))
	remote, err := net.DialTimeout("tcp", target, 10*time.Second)
	if err != nil {
		f.err.Store(err.Error())
		return
	}
	defer remote.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{}, 2)
	go func() { f.limitedCopy(ctx, remote, client, &f.bytesIn); done <- struct{}{} }()
	go func() { f.limitedCopy(ctx, client, remote, &f.bytesOut); done <- struct{}{} }()
	<-done
	cancel()
}

func (f *tcpForwarder) limitedCopy(ctx context.Context, dst io.Writer, src io.Reader, counter *uint64) {
	buf := make([]byte, 32*1024)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		nr, er := src.Read(buf)
		if nr > 0 {
			f.limiter.wait(nr)
			nw, ew := dst.Write(buf[0:nr])
			if nw > 0 {
				atomic.AddUint64(counter, uint64(nw))
			}
			if ew != nil || nr != nw {
				return
			}
		}
		if er != nil {
			return
		}
	}
}

func (f *tcpForwarder) allowed(addr net.Addr) bool {
	if len(f.prefix) == 0 {
		return true
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return false
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	for _, p := range f.prefix {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

func (f *tcpForwarder) Stop() {
	select {
	case <-f.stop:
		return
	default:
		close(f.stop)
		if f.ln != nil {
			_ = f.ln.Close()
		}
		f.state.Store("stopped")
	}
}

func (f *tcpForwarder) Status() common.RuleRuntimeStatus {
	st, _ := f.state.Load().(string)
	err, _ := f.err.Load().(string)
	return common.RuleRuntimeStatus{RuleID: f.rule.ID, Protocol: "tcp", ListenPort: f.rule.ListenPort, State: st, ActiveConnections: int(atomic.LoadInt64(&f.active)), BytesIn: atomic.LoadUint64(&f.bytesIn), BytesOut: atomic.LoadUint64(&f.bytesOut), LastError: err, UpdatedAt: time.Now()}
}

type udpForwarder struct {
	rule     common.ForwardRule
	conn     *net.UDPConn
	stop     chan struct{}
	state    atomic.Value
	err      atomic.Value
	bytesIn  uint64
	bytesOut uint64
	active   int64
	prefix   []netip.Prefix
	mu       sync.Mutex
	sessions map[string]*udpSession
	limiter  *rateLimiter // per-rule 限速器
}

type udpSession struct {
	client   *net.UDPAddr
	remote   *net.UDPConn
	lastSeen time.Time
}

func newUDPForwarder(rule common.ForwardRule) *udpForwarder {
	f := &udpForwarder{rule: rule, stop: make(chan struct{}), prefix: parsePrefixes(rule.SourceCIDRs), sessions: map[string]*udpSession{}, limiter: newRateLimiter(rule.SpeedLimitMbps)}
	f.state.Store("starting")
	return f
}

func (f *udpForwarder) Run() {
	addr := &net.UDPAddr{IP: net.IPv4zero, Port: f.rule.ListenPort}
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		f.state.Store("error")
		f.err.Store(err.Error())
		log.Printf("UDP 规则 %s 监听失败：%v", f.rule.ID, err)
		return
	}
	f.conn = conn
	f.state.Store("running")
	f.err.Store("")
	go f.cleaner()
	buf := make([]byte, 64*1024)
	for {
		n, client, err := conn.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-f.stop:
				f.state.Store("stopped")
				return
			default:
				f.state.Store("error")
				f.err.Store(err.Error())
				continue
			}
		}
		if !f.allowedUDP(client) {
			continue
		}
		f.limiter.wait(n)
		atomic.AddUint64(&f.bytesIn, uint64(n))
		sess, err := f.session(client)
		if err != nil {
			f.err.Store(err.Error())
			continue
		}
		_, _ = sess.remote.Write(buf[:n])
	}
}

func (f *udpForwarder) session(client *net.UDPAddr) (*udpSession, error) {
	key := client.String()
	f.mu.Lock()
	if s, ok := f.sessions[key]; ok {
		s.lastSeen = time.Now()
		f.mu.Unlock()
		return s, nil
	}
	if f.rule.MaxConnections > 0 && len(f.sessions) >= f.rule.MaxConnections {
		f.mu.Unlock()
		return nil, errors.New("UDP 会话数超过限制")
	}
	// 预占位防止并发绕过 MaxConnections 限制
	sess := &udpSession{client: client, lastSeen: time.Now()}
	f.sessions[key] = sess
	atomic.StoreInt64(&f.active, int64(len(f.sessions)))
	f.mu.Unlock()

	remoteAddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(f.rule.TargetHost, strconv.Itoa(f.rule.TargetPort)))
	if err != nil {
		f.mu.Lock()
		delete(f.sessions, key)
		atomic.StoreInt64(&f.active, int64(len(f.sessions)))
		f.mu.Unlock()
		return nil, err
	}
	remote, err := net.DialUDP("udp", nil, remoteAddr)
	if err != nil {
		f.mu.Lock()
		delete(f.sessions, key)
		atomic.StoreInt64(&f.active, int64(len(f.sessions)))
		f.mu.Unlock()
		return nil, err
	}
	sess.remote = remote
	go f.readRemote(key, sess)
	return sess, nil
}

func (f *udpForwarder) readRemote(key string, sess *udpSession) {
	if sess.remote == nil {
		return
	}
	defer sess.remote.Close()
	buf := make([]byte, 64*1024)
	for {
		_ = sess.remote.SetReadDeadline(time.Now().Add(2 * time.Minute))
		n, err := sess.remote.Read(buf)
		if err != nil {
			f.removeSession(key)
			return
		}
		if n > 0 {
			f.limiter.wait(n)
		}
		atomic.AddUint64(&f.bytesOut, uint64(n))
		_, _ = f.conn.WriteToUDP(buf[:n], sess.client)
	}
}

func (f *udpForwarder) cleaner() {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-f.stop:
			return
		case <-t.C:
			f.mu.Lock()
			for key, sess := range f.sessions {
				if time.Since(sess.lastSeen) > 2*time.Minute {
					_ = sess.remote.Close()
					delete(f.sessions, key)
				}
			}
			atomic.StoreInt64(&f.active, int64(len(f.sessions)))
			f.mu.Unlock()
		}
	}
}

func (f *udpForwarder) removeSession(key string) {
	f.mu.Lock()
	delete(f.sessions, key)
	atomic.StoreInt64(&f.active, int64(len(f.sessions)))
	f.mu.Unlock()
}

func (f *udpForwarder) allowedUDP(addr *net.UDPAddr) bool {
	if len(f.prefix) == 0 {
		return true
	}
	ip, ok := netip.AddrFromSlice(addr.IP)
	if !ok {
		return false
	}
	for _, p := range f.prefix {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

func (f *udpForwarder) Stop() {
	select {
	case <-f.stop:
		return
	default:
		close(f.stop)
		if f.conn != nil {
			_ = f.conn.Close()
		}
		f.mu.Lock()
		for _, sess := range f.sessions {
			_ = sess.remote.Close()
		}
		f.sessions = map[string]*udpSession{}
		f.mu.Unlock()
		f.state.Store("stopped")
	}
}

func (f *udpForwarder) Status() common.RuleRuntimeStatus {
	st, _ := f.state.Load().(string)
	err, _ := f.err.Load().(string)
	return common.RuleRuntimeStatus{RuleID: f.rule.ID, Protocol: "udp", ListenPort: f.rule.ListenPort, State: st, ActiveConnections: int(atomic.LoadInt64(&f.active)), BytesIn: atomic.LoadUint64(&f.bytesIn), BytesOut: atomic.LoadUint64(&f.bytesOut), LastError: err, UpdatedAt: time.Now()}
}

func parsePrefixes(cidrs []string) []netip.Prefix {
	var out []netip.Prefix
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
		p, err := netip.ParsePrefix(raw)
		if err == nil {
			out = append(out, p)
		}
	}
	return out
}

func (m *Manager) Debug() string {
	return fmt.Sprintf("tcp=%d udp=%d", len(m.tcp), len(m.udp))
}
