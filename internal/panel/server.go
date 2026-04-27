package panel

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/idcsu/relayguard/internal/common"
)

type Server struct {
	store   *Store
	addr    string
	limiter *loginLimiter
}

type loginAttempt struct {
	Count       int
	LockedUntil time.Time
}

type loginLimiter struct {
	mu       sync.Mutex
	attempts map[string]loginAttempt
}

func newLoginLimiter() *loginLimiter { return &loginLimiter{attempts: map[string]loginAttempt{}} }

func (l *loginLimiter) key(ip, username string) string {
	return ip + "|" + strings.ToLower(strings.TrimSpace(username))
}

func (l *loginLimiter) allowed(ip, username string) (time.Time, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	a := l.attempts[l.key(ip, username)]
	if !a.LockedUntil.IsZero() && time.Now().Before(a.LockedUntil) {
		return a.LockedUntil, false
	}
	return time.Time{}, true
}

func (l *loginLimiter) success(ip, username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, l.key(ip, username))
}

func (l *loginLimiter) fail(ip, username string) (time.Time, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	k := l.key(ip, username)
	a := l.attempts[k]
	a.Count++
	locked := false
	if a.Count >= 5 {
		a.LockedUntil = time.Now().Add(15 * time.Minute)
		locked = true
	}
	l.attempts[k] = a
	return a.LockedUntil, locked
}

func NewServer(store *Store, addr string) *Server {
	return &Server{store: store, addr: addr, limiter: newLoginLimiter()}
}

func (s *Server) ListenAndServe() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "version": common.Version})
	})
	mux.HandleFunc("/api/auth/login", s.handleLogin)
	mux.HandleFunc("/api/auth/logout", s.requireAuth(s.handleLogout))
	mux.HandleFunc("/api/me", s.requireAuth(s.handleMe))
	mux.HandleFunc("/api/account/password", s.requireAuth(s.handleAccountPassword))
	mux.HandleFunc("/api/account/totp/setup", s.requireAuth(s.handleTOTPSetup))
	mux.HandleFunc("/api/account/totp/enable", s.requireAuth(s.handleTOTPEnable))
	mux.HandleFunc("/api/account/totp/disable", s.requireAuth(s.handleTOTPDisable))
	mux.HandleFunc("/api/account/sessions", s.requireAuth(s.handleAccountSessions))
	mux.HandleFunc("/api/account/sessions/logout-others", s.requireAuth(s.handleLogoutOtherSessions))
	mux.HandleFunc("/api/dashboard", s.requireAuth(s.handleDashboard))
	mux.HandleFunc("/api/users", s.requireAuth(s.handleUsers))
	mux.HandleFunc("/api/users/", s.requireAuth(s.handleUserByID))
	mux.HandleFunc("/api/nodes", s.requireAuth(s.handleNodes))
	mux.HandleFunc("/api/nodes/", s.requireAuth(s.handleNodeByID))
	mux.HandleFunc("/api/node-tokens", s.requireAuth(s.handleNodeTokens))
	mux.HandleFunc("/api/rules", s.requireAuth(s.handleRules))
	mux.HandleFunc("/api/rules/", s.requireAuth(s.handleRuleByID))
	mux.HandleFunc("/api/statuses", s.requireAuth(s.handleStatuses))
	mux.HandleFunc("/api/connectivity-tests", s.requireAuth(s.handleConnectivityTests))
	mux.HandleFunc("/api/audit-logs", s.requireAuth(s.handleAuditLogs))
	mux.HandleFunc("/api/backups/", s.requireAuth(s.handleBackupByName))
	mux.HandleFunc("/api/backups", s.requireAuth(s.handleBackups))
	mux.HandleFunc("/api/agent/register", s.handleAgentRegister)
	mux.HandleFunc("/api/agent/heartbeat", s.handleAgentHeartbeat)
	mux.HandleFunc("/api/agent/install.sh", s.handleAgentInstallScript)
	mux.HandleFunc("/install.sh", s.handlePanelInstallScript)
	mux.Handle("/", s.webHandler())

	log.Printf("RelayGuard Panel 正在监听 %s", s.addr)
	return http.ListenAndServe(s.addr, securityHeaders(mux))
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if isStateChangingMethod(r.Method) && !originAllowed(r) {
			writeError(w, http.StatusForbidden, "来源校验失败")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isStateChangingMethod(method string) bool {
	return method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch || method == http.MethodDelete
}

func originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	return origin == scheme+"://"+r.Host
}

type authHandler func(http.ResponseWriter, *http.Request, common.User)

func (s *Server) requireAuth(next authHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("rg_session")
		if err != nil || cookie.Value == "" {
			writeError(w, http.StatusUnauthorized, "未登录")
			return
		}
		u, ok := s.store.UserBySession(cookie.Value)
		if !ok {
			writeError(w, http.StatusUnauthorized, "会话已过期，请重新登录")
			return
		}
		if u.MustChange && !isMustChangeAllowedPath(r.URL.Path) {
			writeError(w, http.StatusForbidden, "必须先修改初始密码")
			return
		}
		next(w, r, u)
	}
}

func isMustChangeAllowedPath(path string) bool {
	return path == "/api/me" || path == "/api/auth/logout" || path == "/api/account/password"
}

func sanitizeUser(u common.User) common.User {
	u.PasswordHash = ""
	u.TOTPSecret = ""
	return u
}

func isAdminUser(u common.User) bool {
	return u.Role == "super_admin" || u.Role == "admin"
}

func requireAdmin(w http.ResponseWriter, u common.User) bool {
	if !isAdminUser(u) {
		writeError(w, http.StatusForbidden, "需要管理员权限")
		return false
	}
	return true
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		TOTPCode string `json:"totp_code"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	ip := clientIP(r)
	if until, ok := s.limiter.allowed(ip, req.Username); !ok {
		writeError(w, http.StatusTooManyRequests, "登录失败次数过多，请在 "+until.Format("15:04:05")+" 后再试")
		return
	}
	u, ok := s.store.Login(req.Username, req.Password)
	if !ok {
		until, locked := s.limiter.fail(ip, req.Username)
		if locked {
			writeError(w, http.StatusTooManyRequests, "登录失败次数过多，已临时锁定 15 分钟，解锁时间："+until.Format("15:04:05"))
			return
		}
		writeError(w, http.StatusUnauthorized, "用户名或密码错误")
		return
	}
	if u.TOTPEnabled {
		if !common.VerifyTOTP(u.TOTPSecret, req.TOTPCode, time.Now()) {
			s.limiter.fail(ip, req.Username)
			writeError(w, http.StatusUnauthorized, "两步验证码错误或已过期")
			return
		}
	}
	s.limiter.success(ip, req.Username)
	sess, err := s.store.CreateSession(u, ip, r.UserAgent())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "创建会话失败")
		return
	}
	cookie := &http.Cookie{Name: "rg_session", Value: sess.Token, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Expires: sess.ExpiresAt}
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		cookie.Secure = true
	}
	http.SetCookie(w, cookie)
	u = sanitizeUser(u)
	s.store.AddAudit(u.ID, "login", "panel", ip, "登录面板")
	writeJSON(w, map[string]any{"user": u})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, u common.User) {
	if c, err := r.Cookie("rg_session"); err == nil {
		_ = s.store.DeleteSession(c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: "rg_session", Value: "", Path: "/", HttpOnly: true, MaxAge: -1})
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request, u common.User) {
	writeJSON(w, map[string]any{"user": sanitizeUser(u), "version": common.Version})
}

func (s *Server) handleAccountPassword(w http.ResponseWriter, r *http.Request, u common.User) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	var req struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if err := s.store.UpdateOwnPassword(u.ID, req.OldPassword, req.NewPassword); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if c, err := r.Cookie("rg_session"); err == nil {
		_ = s.store.DeleteOtherSessions(u.ID, c.Value)
	}
	s.store.AddAudit(u.ID, "change_password", u.ID, clientIP(r), "修改当前账号密码并退出其他会话")
	fresh, _ := s.store.GetUser(u.ID)
	writeJSON(w, map[string]any{"ok": true, "user": sanitizeUser(fresh)})
}

func (s *Server) handleTOTPSetup(w http.ResponseWriter, r *http.Request, u common.User) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	secret, err := common.GenerateTOTPSecret()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "生成两步验证密钥失败")
		return
	}
	uri := common.TOTPURI(common.ProjectName, u.Username, secret)
	writeJSON(w, map[string]any{"secret": secret, "uri": uri})
}

func (s *Server) handleTOTPEnable(w http.ResponseWriter, r *http.Request, u common.User) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	var req struct {
		Secret string `json:"secret"`
		Code   string `json:"code"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !common.VerifyTOTP(req.Secret, req.Code, time.Now()) {
		writeError(w, http.StatusBadRequest, "验证码错误或已过期")
		return
	}
	if err := s.store.SetUserTOTP(u.ID, req.Secret, true); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.store.AddAudit(u.ID, "enable_totp", u.ID, clientIP(r), "启用两步验证")
	fresh, _ := s.store.GetUser(u.ID)
	writeJSON(w, map[string]any{"ok": true, "user": sanitizeUser(fresh)})
}

func (s *Server) handleTOTPDisable(w http.ResponseWriter, r *http.Request, u common.User) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	var req struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	full, ok := s.store.VerifyUserPassword(u.ID, req.Password)
	if !ok {
		writeError(w, http.StatusBadRequest, "密码不正确")
		return
	}
	if full.TOTPEnabled && !common.VerifyTOTP(full.TOTPSecret, req.Code, time.Now()) {
		writeError(w, http.StatusBadRequest, "两步验证码错误或已过期")
		return
	}
	if err := s.store.SetUserTOTP(u.ID, "", false); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.store.AddAudit(u.ID, "disable_totp", u.ID, clientIP(r), "关闭两步验证")
	fresh, _ := s.store.GetUser(u.ID)
	writeJSON(w, map[string]any{"ok": true, "user": sanitizeUser(fresh)})
}

func (s *Server) handleAccountSessions(w http.ResponseWriter, r *http.Request, u common.User) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	writeJSON(w, map[string]any{"items": s.store.ListSessionsForUser(u.ID)})
}

func (s *Server) handleLogoutOtherSessions(w http.ResponseWriter, r *http.Request, u common.User) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	keep := ""
	if c, err := r.Cookie("rg_session"); err == nil {
		keep = c.Value
	}
	if err := s.store.DeleteOtherSessions(u.ID, keep); err != nil {
		writeError(w, http.StatusInternalServerError, "退出其他会话失败")
		return
	}
	s.store.AddAudit(u.ID, "logout_other_sessions", u.ID, clientIP(r), "退出当前账号其他会话")
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request, u common.User) {
	writeJSON(w, s.store.Dashboard())
}

type userPayload struct {
	ID             string   `json:"id"`
	Username       string   `json:"username"`
	Password       string   `json:"password"`
	Role           string   `json:"role"`
	TrafficLimit   uint64   `json:"traffic_limit"`
	RuleLimit      int      `json:"rule_limit"`
	AllowedNodeIDs []string `json:"allowed_node_ids"`
	PortRangeStart int      `json:"port_range_start"`
	PortRangeEnd   int      `json:"port_range_end"`
	ExpiresAt      string   `json:"expires_at"`
	Disabled       bool     `json:"disabled"`
	MustChange     bool     `json:"must_change"`
}

func payloadToUser(req userPayload) (common.User, error) {
	var exp *time.Time
	if strings.TrimSpace(req.ExpiresAt) != "" {
		t, err := time.Parse("2006-01-02", strings.TrimSpace(req.ExpiresAt))
		if err != nil {
			return common.User{}, fmt.Errorf("到期日期格式应为 YYYY-MM-DD")
		}
		t = t.Add(24*time.Hour - time.Nanosecond)
		exp = &t
	}
	return common.User{
		ID:             req.ID,
		Username:       strings.TrimSpace(req.Username),
		Role:           req.Role,
		TrafficLimit:   req.TrafficLimit,
		RuleLimit:      req.RuleLimit,
		AllowedNodeIDs: req.AllowedNodeIDs,
		PortRangeStart: req.PortRangeStart,
		PortRangeEnd:   req.PortRangeEnd,
		ExpiresAt:      exp,
		Disabled:       req.Disabled,
		MustChange:     req.MustChange,
	}, nil
}

func (s *Server) handleUsers(w http.ResponseWriter, r *http.Request, u common.User) {
	if !requireAdmin(w, u) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, map[string]any{"items": s.store.ListUsers()})
	case http.MethodPost:
		var req userPayload
		if err := readJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "请求格式错误")
			return
		}
		item, err := payloadToUser(req)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		saved, err := s.store.SaveUser(item, req.Password)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.store.AddAudit(u.ID, "create_user", saved.ID, clientIP(r), saved.Username)
		writeJSON(w, map[string]any{"item": saved})
	default:
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

func (s *Server) handleUserByID(w http.ResponseWriter, r *http.Request, u common.User) {
	if !requireAdmin(w, u) {
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/users/")
	if id == "" {
		writeError(w, http.StatusNotFound, "用户不存在")
		return
	}
	switch r.Method {
	case http.MethodPut:
		var req userPayload
		if err := readJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "请求格式错误")
			return
		}
		item, err := payloadToUser(req)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		item.ID = id
		saved, err := s.store.SaveUser(item, req.Password)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.store.AddAudit(u.ID, "update_user", id, clientIP(r), saved.Username)
		writeJSON(w, map[string]any{"item": saved})
	case http.MethodDelete:
		if id == u.ID {
			writeError(w, http.StatusBadRequest, "不能删除当前登录用户")
			return
		}
		if err := s.store.DeleteUser(id); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.store.AddAudit(u.ID, "delete_user", id, clientIP(r), "删除用户并停用其规则")
		writeJSON(w, map[string]any{"ok": true})
	default:
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

func (s *Server) handleNodes(w http.ResponseWriter, r *http.Request, u common.User) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, map[string]any{"items": s.store.ListNodes()})
	default:
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

func (s *Server) handleNodeByID(w http.ResponseWriter, r *http.Request, u common.User) {
	id := strings.TrimPrefix(r.URL.Path, "/api/nodes/")
	if id == "" {
		writeError(w, http.StatusNotFound, "节点不存在")
		return
	}
	switch r.Method {
	case http.MethodDelete:
		if !requireAdmin(w, u) {
			return
		}
		if err := s.store.DeleteNode(id); err != nil {
			writeError(w, http.StatusInternalServerError, "删除节点失败")
			return
		}
		s.store.AddAudit(u.ID, "delete_node", id, clientIP(r), "删除节点")
		writeJSON(w, map[string]any{"ok": true})
	case http.MethodPut:
		if !requireAdmin(w, u) {
			return
		}
		var req struct {
			Name           string `json:"name"`
			PortRangeStart int    `json:"port_range_start"`
			PortRangeEnd   int    `json:"port_range_end"`
			FirewallMode   string `json:"firewall_mode"`
			MaxRules       int    `json:"max_rules"`
		}
		if err := readJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "请求格式错误")
			return
		}
		n, ok := s.store.GetNode(id)
		if !ok {
			writeError(w, http.StatusNotFound, "节点不存在")
			return
		}
		if req.Name != "" {
			n.Name = req.Name
		}
		n.PortRangeStart = req.PortRangeStart
		n.PortRangeEnd = req.PortRangeEnd
		if req.FirewallMode == "" {
			req.FirewallMode = "loose"
		} else if req.FirewallMode != "off" && req.FirewallMode != "loose" && req.FirewallMode != "strict" && req.FirewallMode != "strict-pending" {
			req.FirewallMode = "loose"
		}
		if req.FirewallMode == "strict" && n.FirewallMode != "strict" && n.FirewallMode != "strict-pending" {
			req.FirewallMode = "strict-pending"
		}
		n.FirewallMode = req.FirewallMode
		n.MaxRules = req.MaxRules
		if err := s.store.SaveNode(n); err != nil {
			writeError(w, http.StatusInternalServerError, "保存节点失败")
			return
		}
		s.store.AddAudit(u.ID, "update_node", id, clientIP(r), "更新节点设置")
		writeJSON(w, map[string]any{"item": n})
	default:
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

func (s *Server) handleNodeTokens(w http.ResponseWriter, r *http.Request, u common.User) {
	if !requireAdmin(w, u) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, map[string]any{"items": s.store.ListNodeTokens()})
	case http.MethodPost:
		var req struct {
			Name  string `json:"name"`
			Hours int    `json:"hours"`
		}
		_ = readJSON(r, &req)
		if req.Name == "" {
			req.Name = "新节点"
		}
		t, err := s.store.CreateNodeToken(req.Name, req.Hours)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "创建节点 Token 失败")
			return
		}
		s.store.AddAudit(u.ID, "create_node_token", t.ID, clientIP(r), "创建节点注册 Token")
		writeJSON(w, map[string]any{"item": t})
	default:
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

func (s *Server) handleRules(w http.ResponseWriter, r *http.Request, u common.User) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, map[string]any{"items": s.store.ListRulesForUser(u), "statuses": s.store.StatusMap()})
	case http.MethodPost:
		var req common.ForwardRule
		if err := readJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "请求格式错误")
			return
		}
		if req.ID == "" {
			req.ID = common.RandomID("fr")
		}
		if !isAdminUser(u) || req.UserID == "" {
			req.UserID = u.ID
		}
		if req.Protocol == "" {
			req.Protocol = "tcp"
		}
		req.CreatedAt = time.Now()
		req.UpdatedAt = time.Now()
		req.FirewallManaged = true
		if err := s.store.ValidateRule(req, u); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := s.store.SaveRule(req); err != nil {
			writeError(w, http.StatusInternalServerError, "保存规则失败")
			return
		}
		s.store.AddAudit(u.ID, "create_rule", req.ID, clientIP(r), fmt.Sprintf("%s:%d -> %s:%d", req.Protocol, req.ListenPort, req.TargetHost, req.TargetPort))
		writeJSON(w, map[string]any{"item": req})
	default:
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

func (s *Server) handleRuleByID(w http.ResponseWriter, r *http.Request, u common.User) {
	path := strings.TrimPrefix(r.URL.Path, "/api/rules/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusNotFound, "规则不存在")
		return
	}
	id := parts[0]
	if len(parts) == 2 && parts[1] == "test" {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "方法不允许")
			return
		}
		item, err := s.store.CreateConnectivityTest(id, u)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, map[string]any{"item": item, "message": "连通性检测已提交，等待节点 Agent 执行"})
		return
	}

	if len(parts) == 2 && parts[1] == "toggle" {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "方法不允许")
			return
		}
		var req struct {
			Enabled bool `json:"enabled"`
		}
		if err := readJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "请求格式错误")
			return
		}
		target, found := s.store.GetRule(id)
		if !found {
			writeError(w, http.StatusNotFound, "规则不存在")
			return
		}
		if !isAdminUser(u) && target.UserID != u.ID {
			writeError(w, http.StatusForbidden, "无权操作该规则")
			return
		}
		target.Enabled = req.Enabled
		if err := s.store.SaveRule(target); err != nil {
			writeError(w, http.StatusInternalServerError, "保存规则失败")
			return
		}
		s.store.AddAudit(u.ID, "toggle_rule", id, clientIP(r), fmt.Sprintf("enabled=%v", req.Enabled))
		writeJSON(w, map[string]any{"item": target})
		return
	}

	switch r.Method {
	case http.MethodPut:
		var req common.ForwardRule
		if err := readJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "请求格式错误")
			return
		}
		req.ID = id
		old, oldFound := s.store.GetRule(id)
		if !oldFound {
			writeError(w, http.StatusNotFound, "规则不存在")
			return
		}
		if !isAdminUser(u) && old.UserID != u.ID {
			writeError(w, http.StatusForbidden, "无权操作该规则")
			return
		}
		if req.CreatedAt.IsZero() {
			req.CreatedAt = old.CreatedAt
		}
		if !isAdminUser(u) || req.UserID == "" {
			req.UserID = old.UserID
		}
		if err := s.store.ValidateRule(req, u); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := s.store.SaveRule(req); err != nil {
			writeError(w, http.StatusInternalServerError, "保存规则失败")
			return
		}
		s.store.AddAudit(u.ID, "update_rule", id, clientIP(r), "更新转发规则")
		writeJSON(w, map[string]any{"item": req})
	case http.MethodDelete:
		if !s.store.UserCanAccessRule(u, id) {
			writeError(w, http.StatusForbidden, "无权删除该规则")
			return
		}
		if err := s.store.DeleteRule(id); err != nil {
			writeError(w, http.StatusInternalServerError, "删除规则失败")
			return
		}
		s.store.AddAudit(u.ID, "delete_rule", id, clientIP(r), "删除转发规则")
		writeJSON(w, map[string]any{"ok": true})
	default:
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

func (s *Server) handleStatuses(w http.ResponseWriter, r *http.Request, u common.User) {
	writeJSON(w, map[string]any{"items": s.store.ListStatuses()})
}

func (s *Server) handleConnectivityTests(w http.ResponseWriter, r *http.Request, u common.User) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	writeJSON(w, map[string]any{"items": s.store.ListConnectivityTests(u, r.URL.Query().Get("rule_id"), r.URL.Query().Get("id"), limit)})
}

func (s *Server) handleAuditLogs(w http.ResponseWriter, r *http.Request, u common.User) {
	if !requireAdmin(w, u) {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	writeJSON(w, map[string]any{"items": s.store.ListAuditLogs(limit)})
}

func (s *Server) handleBackups(w http.ResponseWriter, r *http.Request, u common.User) {
	if !requireAdmin(w, u) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, map[string]any{"items": s.store.ListBackups("")})
	case http.MethodPost:
		path, err := s.store.Backup("")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "创建备份失败："+err.Error())
			return
		}
		s.store.AddAudit(u.ID, "backup", "database", clientIP(r), "手动创建数据库备份")
		writeJSON(w, map[string]any{"ok": true, "path": path})
	default:
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

func (s *Server) handleBackupByName(w http.ResponseWriter, r *http.Request, u common.User) {
	if !requireAdmin(w, u) {
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/backups/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) != 2 || parts[1] != "restore" {
		writeError(w, http.StatusNotFound, "备份接口不存在")
		return
	}
	name, err := url.PathUnescape(parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, "备份文件名不合法")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	result, err := s.store.RestoreBackup(name, "", u.ID, clientIP(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "恢复备份失败："+err.Error())
		return
	}
	writeJSON(w, map[string]any{"ok": true, "result": result, "message": "数据库已恢复；如果当前会话失效，请重新登录"})
}
func (s *Server) handleAgentRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	var req common.AgentRegisterRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	tok, err := s.store.ConsumeNodeToken(req.Token)
	if err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}
	secret, err := common.RandomToken(32)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "生成节点密钥失败")
		return
	}
	now := time.Now()
	name := tok.Name
	if req.Name != "" {
		name = req.Name
	}
	n := common.Node{
		ID:             common.RandomID("node"),
		Name:           name,
		Secret:         secret,
		Status:         "online",
		Hostname:       req.Hostname,
		OS:             req.OS,
		Arch:           req.Arch,
		AgentVersion:   req.AgentVersion,
		PublicIP:       clientIP(r),
		PrivateIPs:     req.PrivateIPs,
		PortRangeStart: 20000,
		PortRangeEnd:   50000,
		FirewallMode:   "loose",
		MaxRules:       0,
		LastSeenAt:     &now,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := s.store.SaveNode(n); err != nil {
		writeError(w, http.StatusInternalServerError, "保存节点失败")
		return
	}
	s.store.AddAudit("agent", "register_node", n.ID, clientIP(r), n.Name)
	writeJSON(w, common.AgentRegisterResponse{NodeID: n.ID, NodeSecret: secret, PanelName: common.ProjectNameCN, Version: common.Version})
}

func (s *Server) handleAgentHeartbeat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	nodeID := r.Header.Get("X-Node-ID")
	timestamp := r.Header.Get("X-Timestamp")
	sig := r.Header.Get("X-Signature")
	if nodeID == "" || timestamp == "" || sig == "" {
		writeError(w, http.StatusUnauthorized, "缺少节点签名")
		return
	}
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || time.Since(time.Unix(ts, 0)) > 5*time.Minute || time.Until(time.Unix(ts, 0)) > 5*time.Minute {
		writeError(w, http.StatusUnauthorized, "节点请求时间异常")
		return
	}
	secret, ok := s.store.NodeSecret(nodeID)
	if !ok {
		writeError(w, http.StatusUnauthorized, "节点不存在或未注册")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, "读取请求失败")
		return
	}
	signData := append([]byte(timestamp+"\n"), body...)
	if !common.VerifyHMACSHA256Hex(secret, signData, sig) {
		writeError(w, http.StatusUnauthorized, "节点签名错误")
		return
	}
	var req common.AgentHeartbeatRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if req.NodeID != nodeID {
		writeError(w, http.StatusUnauthorized, "节点 ID 不匹配")
		return
	}
	s.store.SaveConnectivityTestResults(nodeID, req.TestResults)
	if err := s.store.UpdateNodeHeartbeat(nodeID, req, clientIP(r)); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	node, _ := s.store.GetNode(nodeID)
	mode := node.FirewallMode
	if mode == "" {
		mode = "loose"
	}
	writeJSON(w, common.AgentHeartbeatResponse{ServerTime: time.Now(), Rules: s.store.RulesForNode(nodeID), Message: "ok", FirewallMode: mode, TestRequests: s.store.PullConnectivityTestsForNode(nodeID, 5)})
}

func (s *Server) handleAgentInstallScript(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	_, _ = w.Write([]byte(agentInstallScript))
}

func (s *Server) handlePanelInstallScript(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	_, _ = w.Write([]byte(panelInstallScript))
}

func readJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return nil
	}
	return json.Unmarshal(body, v)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(common.APIError{Error: msg})
}

func clientIP(r *http.Request) string {
	if h := r.Header.Get("X-Forwarded-For"); h != "" {
		return strings.TrimSpace(strings.Split(h, ",")[0])
	}
	if h := r.Header.Get("X-Real-IP"); h != "" {
		return strings.TrimSpace(h)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
