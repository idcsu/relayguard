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
	return a.Protocol == b.Protocol && a.ListenPort == b.ListenPort && a.TargetHost == b.TargetHost && a.TargetPort == b.TargetPort && a.SpeedLimitMbps == b.SpeedLimitMbps && a.MaxConnections == b.MaxConnections && strings.Join(a.SourceCIDRs, ",") == strings.Join(b.SourceCIDRs, ",")
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
}

func newTCPForwarder(rule common.ForwardRule) *tcpForwarder {
	f := &tcpForwarder{rule: rule, stop: make(chan struct{}), prefix: parsePrefixes(rule.SourceCIDRs)}
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
	go func() { copyWithLimit(ctx, remote, client, f.rule.SpeedLimitMbps, &f.bytesIn); done <- struct{}{} }()
	go func() { copyWithLimit(ctx, client, remote, f.rule.SpeedLimitMbps, &f.bytesOut); done <- struct{}{} }()
	<-done
	cancel()
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
}

type udpSession struct {
	client   *net.UDPAddr
	remote   *net.UDPConn
	lastSeen time.Time
}

func newUDPForwarder(rule common.ForwardRule) *udpForwarder {
	f := &udpForwarder{rule: rule, stop: make(chan struct{}), prefix: parsePrefixes(rule.SourceCIDRs), sessions: map[string]*udpSession{}}
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
	f.mu.Unlock()

	remoteAddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(f.rule.TargetHost, strconv.Itoa(f.rule.TargetPort)))
	if err != nil {
		return nil, err
	}
	remote, err := net.DialUDP("udp", nil, remoteAddr)
	if err != nil {
		return nil, err
	}
	sess := &udpSession{client: client, remote: remote, lastSeen: time.Now()}
	f.mu.Lock()
	f.sessions[key] = sess
	atomic.StoreInt64(&f.active, int64(len(f.sessions)))
	f.mu.Unlock()
	go f.readRemote(key, sess)
	return sess, nil
}

func (f *udpForwarder) readRemote(key string, sess *udpSession) {
	defer sess.remote.Close()
	buf := make([]byte, 64*1024)
	for {
		_ = sess.remote.SetReadDeadline(time.Now().Add(2 * time.Minute))
		n, err := sess.remote.Read(buf)
		if err != nil {
			f.removeSession(key)
			return
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

func copyWithLimit(ctx context.Context, dst io.Writer, src io.Reader, mbps int, counter *uint64) {
	buf := make([]byte, 32*1024)
	var start time.Time
	var transferred int64
	limitBytesPerSec := int64(mbps) * 1024 * 1024 / 8
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		nr, er := src.Read(buf)
		if nr > 0 {
			if limitBytesPerSec > 0 {
				if start.IsZero() {
					start = time.Now()
				}
				transferred += int64(nr)
				expected := time.Duration(float64(transferred) / float64(limitBytesPerSec) * float64(time.Second))
				if sleep := start.Add(expected).Sub(time.Now()); sleep > 0 {
					time.Sleep(sleep)
				}
			}
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

func (m *Manager) Debug() string {
	return fmt.Sprintf("tcp=%d udp=%d", len(m.tcp), len(m.udp))
}
