package panel

/*
#cgo LDFLAGS: -lsqlite3
#include <stdlib.h>
#include <sqlite3.h>
*/
import "C"

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/idcsu/relayguard/internal/common"
)

type Store struct {
	mu   sync.Mutex // TODO: Consider sync.RWMutex for better read concurrency. However, CGO SQLite operations (s.db.query/s.db.exec) are NOT thread-safe with the same connection, so exclusive locking is required for all DB access. Migrate away from CGO SQLite before using RWMutex.
	path string
	db   *sqliteDB
}

// Data 只用于从 v0.1/v0.2 的 JSON 原型存储迁移到 SQLite。
type Data struct {
	Users        map[string]common.User              `json:"users"`
	Sessions     map[string]common.Session           `json:"sessions"`
	Nodes        map[string]common.Node              `json:"nodes"`
	NodeTokens   map[string]common.NodeToken         `json:"node_tokens"`
	Rules        map[string]common.ForwardRule       `json:"rules"`
	RuleStatuses map[string]common.RuleRuntimeStatus `json:"rule_statuses"`
	Settings     map[string]string                   `json:"settings"`
	AuditLogs    []AuditLog                          `json:"audit_logs"`
}

type AuditLog struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Action    string    `json:"action"`
	Target    string    `json:"target"`
	IP        string    `json:"ip"`
	Detail    string    `json:"detail"`
	CreatedAt time.Time `json:"created_at"`
}

type sqliteDB struct {
	db *C.sqlite3
}

func sqliteTransient() *[0]byte {
	return (*[0]byte)(unsafe.Pointer(^uintptr(0)))
}

func openSQLite(path string) (*sqliteDB, error) {
	cpath := C.CString(path)
	defer C.free(unsafe.Pointer(cpath))
	var raw *C.sqlite3
	rc := C.sqlite3_open_v2(cpath, &raw, C.SQLITE_OPEN_READWRITE|C.SQLITE_OPEN_CREATE|C.SQLITE_OPEN_FULLMUTEX, nil)
	if rc != C.SQLITE_OK {
		msg := "unknown"
		if raw != nil {
			msg = C.GoString(C.sqlite3_errmsg(raw))
			C.sqlite3_close(raw)
		}
		return nil, fmt.Errorf("打开 SQLite 失败：%s", msg)
	}
	return &sqliteDB{db: raw}, nil
}

func (d *sqliteDB) close() error {
	if d == nil || d.db == nil {
		return nil
	}
	if rc := C.sqlite3_close(d.db); rc != C.SQLITE_OK {
		return fmt.Errorf("关闭 SQLite 失败：%s", C.GoString(C.sqlite3_errmsg(d.db)))
	}
	d.db = nil
	return nil
}

func (d *sqliteDB) execRaw(sql string) error {
	csql := C.CString(sql)
	defer C.free(unsafe.Pointer(csql))
	var errMsg *C.char
	rc := C.sqlite3_exec(d.db, csql, nil, nil, &errMsg)
	if rc != C.SQLITE_OK {
		defer C.sqlite3_free(unsafe.Pointer(errMsg))
		return fmt.Errorf("SQLite 执行失败：%s", C.GoString(errMsg))
	}
	return nil
}

func (d *sqliteDB) prepare(sql string) (*C.sqlite3_stmt, error) {
	csql := C.CString(sql)
	defer C.free(unsafe.Pointer(csql))
	var stmt *C.sqlite3_stmt
	rc := C.sqlite3_prepare_v2(d.db, csql, -1, &stmt, nil)
	if rc != C.SQLITE_OK {
		return nil, fmt.Errorf("SQLite 准备语句失败：%s", C.GoString(C.sqlite3_errmsg(d.db)))
	}
	return stmt, nil
}

func (d *sqliteDB) bind(stmt *C.sqlite3_stmt, args ...any) error {
	for i, arg := range args {
		idx := C.int(i + 1)
		var rc C.int
		switch v := arg.(type) {
		case nil:
			rc = C.sqlite3_bind_null(stmt, idx)
		case string:
			cs := C.CString(v)
			rc = C.sqlite3_bind_text(stmt, idx, cs, C.int(len(v)), sqliteTransient())
			C.free(unsafe.Pointer(cs))
		case bool:
			if v {
				rc = C.sqlite3_bind_int64(stmt, idx, 1)
			} else {
				rc = C.sqlite3_bind_int64(stmt, idx, 0)
			}
		case int:
			rc = C.sqlite3_bind_int64(stmt, idx, C.sqlite3_int64(v))
		case int64:
			rc = C.sqlite3_bind_int64(stmt, idx, C.sqlite3_int64(v))
		case uint64:
			rc = C.sqlite3_bind_int64(stmt, idx, C.sqlite3_int64(v))
		case float64:
			rc = C.sqlite3_bind_double(stmt, idx, C.double(v))
		case time.Time:
			s := timeToDB(v)
			cs := C.CString(s)
			rc = C.sqlite3_bind_text(stmt, idx, cs, C.int(len(s)), sqliteTransient())
			C.free(unsafe.Pointer(cs))
		default:
			s := fmt.Sprint(v)
			cs := C.CString(s)
			rc = C.sqlite3_bind_text(stmt, idx, cs, C.int(len(s)), sqliteTransient())
			C.free(unsafe.Pointer(cs))
		}
		if rc != C.SQLITE_OK {
			return fmt.Errorf("SQLite 绑定参数失败：%s", C.GoString(C.sqlite3_errmsg(d.db)))
		}
	}
	return nil
}

func (d *sqliteDB) exec(sql string, args ...any) error {
	stmt, err := d.prepare(sql)
	if err != nil {
		return err
	}
	defer C.sqlite3_finalize(stmt)
	if err := d.bind(stmt, args...); err != nil {
		return err
	}
	rc := C.sqlite3_step(stmt)
	if rc != C.SQLITE_DONE {
		return fmt.Errorf("SQLite 执行失败：%s", C.GoString(C.sqlite3_errmsg(d.db)))
	}
	return nil
}

func (d *sqliteDB) query(sql string, args ...any) ([]map[string]string, error) {
	stmt, err := d.prepare(sql)
	if err != nil {
		return nil, err
	}
	defer C.sqlite3_finalize(stmt)
	if err := d.bind(stmt, args...); err != nil {
		return nil, err
	}
	cols := int(C.sqlite3_column_count(stmt))
	rows := []map[string]string{}
	for {
		rc := C.sqlite3_step(stmt)
		if rc == C.SQLITE_DONE {
			break
		}
		if rc != C.SQLITE_ROW {
			return nil, fmt.Errorf("SQLite 查询失败：%s", C.GoString(C.sqlite3_errmsg(d.db)))
		}
		row := make(map[string]string, cols)
		for i := 0; i < cols; i++ {
			name := C.GoString(C.sqlite3_column_name(stmt, C.int(i)))
			if C.sqlite3_column_type(stmt, C.int(i)) == C.SQLITE_NULL {
				row[name] = ""
				continue
			}
			text := C.sqlite3_column_text(stmt, C.int(i))
			row[name] = C.GoString((*C.char)(unsafe.Pointer(text)))
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func (d *sqliteDB) querySingleInt(sql string, args ...any) (int, error) {
	rows, err := d.query(sql, args...)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	return atoi(rows[0]["COUNT(*)"]), nil
}

func OpenStore(path string, adminUser string, adminPassword string) (*Store, string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, "", err
	}
	if strings.HasSuffix(path, ".json") {
		path = strings.TrimSuffix(path, ".json") + ".db"
	}
	existed := fileExists(path)
	db, err := openSQLite(path)
	if err != nil {
		return nil, "", err
	}
	_ = os.Chmod(path, 0600)
	s := &Store{path: path, db: db}
	if err := s.initSchema(); err != nil {
		_ = db.close()
		return nil, "", err
	}
	if !existed {
		oldJSON := filepath.Join(filepath.Dir(path), "relayguard.json")
		if fileExists(oldJSON) {
			if err := s.importJSON(oldJSON); err != nil {
				_ = db.close()
				return nil, "", fmt.Errorf("迁移旧 JSON 数据失败：%w", err)
			}
			_ = os.Rename(oldJSON, oldJSON+".migrated")
		}
	}
	_ = s.cleanupExpiredSessions()
	if s.userCount() > 0 {
		return s, "", nil
	}
	plain := adminPassword
	if plain == "" {
		var err error
		plain, err = common.RandomToken(18)
		if err != nil {
			return nil, "", err
		}
	}
	if adminUser == "" {
		adminUser = "admin"
	}
	if len(plain) < 8 {
		return nil, "", fmt.Errorf("管理员初始密码至少需要 8 位")
	}
	hash, err := common.HashPassword(plain)
	if err != nil {
		return nil, "", err
	}
	now := time.Now()
	adminID := common.RandomID("usr")
	admin := common.User{ID: adminID, Username: adminUser, PasswordHash: hash, Role: "super_admin", RuleLimit: 0, MustChange: adminPassword == "", CreatedAt: now, UpdatedAt: now}
	s.mu.Lock()
	err = s.upsertUserLocked(admin)
	if err == nil {
		err = s.setDefaultSettingsLocked()
	}
	s.mu.Unlock()
	if err != nil {
		return nil, "", err
	}
	return s, plain, nil
}

func (s *Store) initSchema() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, q := range []string{
		`PRAGMA journal_mode=WAL;`,
		`PRAGMA synchronous=NORMAL;`,
		`PRAGMA busy_timeout=5000;`,
		`PRAGMA foreign_keys=ON;`,
		`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, traffic_limit INTEGER NOT NULL DEFAULT 0, traffic_used INTEGER NOT NULL DEFAULT 0, rule_limit INTEGER NOT NULL DEFAULT 0, allowed_node_ids TEXT, port_range_start INTEGER NOT NULL DEFAULT 0, port_range_end INTEGER NOT NULL DEFAULT 0, expires_at TEXT, disabled INTEGER NOT NULL DEFAULT 0, must_change INTEGER NOT NULL DEFAULT 0, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_secret TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
		`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, ip TEXT, user_agent TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);`,
		`CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, secret TEXT NOT NULL, status TEXT, hostname TEXT, os TEXT, arch TEXT, agent_version TEXT, public_ip TEXT, private_ips TEXT, port_range_start INTEGER, port_range_end INTEGER, firewall_mode TEXT, max_rules INTEGER, last_seen_at TEXT, last_metrics TEXT, last_error TEXT, firewall_state TEXT, firewall_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
		`CREATE TABLE IF NOT EXISTS node_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, used_by_node TEXT, used_at TEXT, max_uses INTEGER, used_count INTEGER, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);`,
		`CREATE INDEX IF NOT EXISTS idx_node_tokens_hash ON node_tokens(token_hash);`,
		`CREATE TABLE IF NOT EXISTS forward_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT, node_id TEXT NOT NULL, protocol TEXT NOT NULL, listen_port INTEGER NOT NULL, target_host TEXT NOT NULL, target_port INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, source_cidrs TEXT, speed_limit_mbps INTEGER, max_connections INTEGER, traffic_limit INTEGER, traffic_used INTEGER, expire_at TEXT, description TEXT, firewall_managed INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
		`CREATE INDEX IF NOT EXISTS idx_forward_rules_node_port ON forward_rules(node_id, listen_port);`,
		`CREATE INDEX IF NOT EXISTS idx_forward_rules_user_id ON forward_rules(user_id);`,
		`CREATE TABLE IF NOT EXISTS rule_statuses (rule_id TEXT PRIMARY KEY, state TEXT, protocol TEXT, listen_port INTEGER, active_connections INTEGER, bytes_in INTEGER, bytes_out INTEGER, last_error TEXT, updated_at TEXT NOT NULL);`,
		`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`,
		`CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, target TEXT, ip TEXT, detail TEXT, created_at TEXT NOT NULL);`,
		`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);`,
		`CREATE TABLE IF NOT EXISTS connectivity_tests (id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, node_id TEXT NOT NULL, requested_by TEXT, protocol TEXT, listen_port INTEGER, target_host TEXT, target_port INTEGER, status TEXT NOT NULL, local_listen_ok INTEGER NOT NULL DEFAULT 0, target_tcp_ok INTEGER NOT NULL DEFAULT 0, target_udp_ok INTEGER NOT NULL DEFAULT 0, ping_ok INTEGER NOT NULL DEFAULT 0, ping_latency_ms INTEGER NOT NULL DEFAULT 0, error TEXT, details TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);`,
		`CREATE INDEX IF NOT EXISTS idx_connectivity_tests_rule_created ON connectivity_tests(rule_id, created_at);`,
		`CREATE INDEX IF NOT EXISTS idx_connectivity_tests_node_status ON connectivity_tests(node_id, status);`,
	} {
		if err := s.db.execRaw(q); err != nil {
			return err
		}
	}
	// v0.4 起用户表增加配额、节点范围、端口范围和到期时间字段；旧库升级时自动补列。
	for _, q := range []string{
		`ALTER TABLE users ADD COLUMN allowed_node_ids TEXT;`,
		`ALTER TABLE users ADD COLUMN port_range_start INTEGER NOT NULL DEFAULT 0;`,
		`ALTER TABLE users ADD COLUMN port_range_end INTEGER NOT NULL DEFAULT 0;`,
		`ALTER TABLE users ADD COLUMN expires_at TEXT;`,
		`ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;`,
		`ALTER TABLE users ADD COLUMN totp_secret TEXT;`,
		`ALTER TABLE forward_rules ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';`,
	} {
		if err := s.db.execRaw(q); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
			return err
		}
	}
	return s.setDefaultSettingsLocked()
}

func (s *Store) setDefaultSettingsLocked() error {
	defaults := map[string]string{
		"site_name":            "RelayGuard 中转卫士",
		"agent_interval":      "10",
		"install_base_url":    "",
		"storage_engine":      "sqlite",
		"session_ttl_hours":   "24",
		"audit_retention_days": "90",
		"webhook_url":         "",
		"webhook_secret":      "",
	}
	for k, v := range defaults {
		if err := s.db.exec(`INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)`, k, v); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) importJSON(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var d Data
	if err := json.Unmarshal(b, &d); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.db.execRaw("BEGIN IMMEDIATE;"); err != nil {
		return err
	}
	rollback := true
	defer func() {
		if rollback {
			_ = s.db.execRaw("ROLLBACK;")
		}
	}()
	for _, u := range d.Users {
		if err := s.upsertUserLocked(u); err != nil {
			return err
		}
	}
	for _, sess := range d.Sessions {
		if err := s.upsertSessionLocked(sess); err != nil {
			return err
		}
	}
	for _, n := range d.Nodes {
		if err := s.upsertNodeLocked(n); err != nil {
			return err
		}
	}
	for _, t := range d.NodeTokens {
		if err := s.upsertNodeTokenLocked(t); err != nil {
			return err
		}
	}
	for _, r := range d.Rules {
		if err := s.upsertRuleLocked(r); err != nil {
			return err
		}
	}
	for _, st := range d.RuleStatuses {
		if err := s.upsertStatusLocked(st); err != nil {
			return err
		}
	}
	for k, v := range d.Settings {
		if err := s.db.exec(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, k, v); err != nil {
			return err
		}
	}
	for _, l := range d.AuditLogs {
		if err := s.insertAuditLocked(l); err != nil {
			return err
		}
	}
	if err := s.db.execRaw("COMMIT;"); err != nil {
		return err
	}
	rollback = false
	return nil
}

func (s *Store) ResetAdminPassword(username, password string) error {
	if strings.TrimSpace(username) == "" {
		username = "admin"
	}
	if password == "" {
		return fmt.Errorf("新密码不能为空")
	}
	if len(password) < 8 {
		return fmt.Errorf("密码至少需要 8 位")
	}
	hash, err := common.HashPassword(password)
	if err != nil {
		return err
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT * FROM users WHERE username=?`, username)
	if err != nil {
		return err
	}
	if len(rows) > 0 {
		u := rowToUser(rows[0])
		u.PasswordHash = hash
		u.Disabled = false
		u.MustChange = false
		u.UpdatedAt = now
		if err := s.upsertUserLocked(u); err != nil {
			return err
		}
	} else {
		u := common.User{ID: common.RandomID("usr"), Username: username, PasswordHash: hash, Role: "super_admin", RuleLimit: 0, Disabled: false, MustChange: false, CreatedAt: now, UpdatedAt: now}
		if err := s.upsertUserLocked(u); err != nil {
			return err
		}
	}
	_ = s.db.exec(`DELETE FROM sessions`)
	return s.insertAuditLocked(AuditLog{ID: common.RandomID("log"), UserID: "system", Action: "reset_admin_password", Target: username, IP: "local", Detail: "重置管理员密码并清空登录会话", CreatedAt: now})
}

// SessionTTL returns the configured session time-to-live duration.
// It reads the "session_ttl_hours" setting (default 24 hours) and clamps
// the value to [1, 8760] hours (1 hour to ~1 year).
func (s *Store) SessionTTL() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT value FROM settings WHERE key=?`, "session_ttl_hours")
	if err != nil || len(rows) == 0 {
		return 24 * time.Hour
	}
	hours := atoi(rows[0]["value"])
	if hours <= 0 {
		hours = 24
	}
	if hours > 8760 {
		hours = 8760
	}
	return time.Duration(hours) * time.Hour
}

func (s *Store) CreateSession(user common.User, ip, ua string) (common.Session, error) {
	token, err := common.RandomToken(32)
	if err != nil {
		return common.Session{}, err
	}
	now := time.Now()
	ttl := s.SessionTTL()
	sess := common.Session{Token: token, UserID: user.ID, IP: ip, UserAgent: ua, CreatedAt: now, ExpiresAt: now.Add(ttl)}
	s.mu.Lock()
	defer s.mu.Unlock()
	return sess, s.upsertSessionLocked(sess)
}

func (s *Store) DeleteSession(token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.exec(`DELETE FROM sessions WHERE token=?`, token)
}

func (s *Store) UserBySession(token string) (common.User, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT * FROM sessions WHERE token=?`, token)
	if err != nil || len(rows) == 0 {
		return common.User{}, false
	}
	sess := rowToSession(rows[0])
	if time.Now().After(sess.ExpiresAt) {
		_ = s.db.exec(`DELETE FROM sessions WHERE token=?`, token)
		return common.User{}, false
	}
	u, ok := s.userByIDLocked(sess.UserID)
	if !ok || u.Disabled {
		return common.User{}, false
	}
	return u, true
}

func (s *Store) Login(username, password string) (common.User, bool) {
	s.mu.Lock()
	rows, err := s.db.query(`SELECT * FROM users WHERE username=? AND disabled=0`, username)
	if err != nil || len(rows) == 0 {
		s.mu.Unlock()
		return common.User{}, false
	}
	u := rowToUser(rows[0])
	s.mu.Unlock()

	// PBKDF2 verification is CPU-intensive (~800ms), release the lock during computation
	// to avoid blocking all other store operations.
	if !common.VerifyPassword(password, u.PasswordHash) {
		return common.User{}, false
	}
	return u, true
}

func (s *Store) ListUsers() []common.User {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT * FROM users ORDER BY created_at DESC`)
	if err != nil {
		return nil
	}
	users := make([]common.User, 0, len(rows))
	for _, row := range rows {
		u := rowToUser(row)
		u.PasswordHash = ""
		u.TOTPSecret = ""
		users = append(users, u)
	}
	return users
}

func (s *Store) GetUser(id string) (common.User, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.userByIDLocked(id)
	if ok {
		u.PasswordHash = ""
		u.TOTPSecret = ""
	}
	return u, ok
}

func (s *Store) GetUserByID(id string) (common.User, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.userByIDLocked(id)
}

func (s *Store) SaveUser(u common.User, password string) (common.User, error) {
	now := time.Now()
	if strings.TrimSpace(u.Username) == "" {
		return common.User{}, fmt.Errorf("用户名不能为空")
	}
	if u.Role == "" {
		u.Role = "user"
	}
	if u.Role != "super_admin" && u.Role != "admin" && u.Role != "user" {
		return common.User{}, fmt.Errorf("角色不正确")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if u.ID != "" {
		old, ok := s.userByIDLocked(u.ID)
		if !ok {
			return common.User{}, fmt.Errorf("用户不存在")
		}
		u.PasswordHash = old.PasswordHash
		u.CreatedAt = old.CreatedAt
		u.TrafficUsed = old.TrafficUsed
		u.TOTPEnabled = old.TOTPEnabled
		u.TOTPSecret = old.TOTPSecret
		if password != "" {
		if err := validatePasswordStrength(password); err != nil {
			return common.User{}, err
		}
		hash, err := common.HashPassword(password)
		if err != nil {
			return common.User{}, err
		}
		u.PasswordHash = hash
		u.MustChange = false
	}
} else {
		if password == "" {
			return common.User{}, fmt.Errorf("新建用户必须设置密码")
		}
		if err := validatePasswordStrength(password); err != nil {
			return common.User{}, err
		}
		hash, err := common.HashPassword(password)
		if err != nil {
			return common.User{}, err
		}
		u.ID = common.RandomID("usr")
		u.PasswordHash = hash
		u.CreatedAt = now
	}
	u.UpdatedAt = now
	if err := s.upsertUserLocked(u); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return common.User{}, fmt.Errorf("用户名已存在")
		}
		return common.User{}, err
	}
	u.PasswordHash = ""
	u.TOTPSecret = ""
	return u, nil
}

func (s *Store) DeleteUser(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.userByIDLocked(id)
	if !ok {
		return fmt.Errorf("用户不存在")
	}
	if u.Role == "super_admin" {
		rows, _ := s.db.query(`SELECT COUNT(*) AS c FROM users WHERE role='super_admin' AND disabled=0`)
		if len(rows) > 0 && atoi(rows[0]["c"]) <= 1 {
			return fmt.Errorf("不能删除最后一个超级管理员")
		}
	}
	if err := s.db.execRaw("BEGIN IMMEDIATE;"); err != nil {
		return err
	}
	rollback := true
	defer func() {
		if rollback {
			_ = s.db.execRaw("ROLLBACK;")
		}
	}()
	if err := s.db.exec(`DELETE FROM users WHERE id=?`, id); err != nil {
		return err
	}
	if err := s.db.exec(`UPDATE forward_rules SET enabled=0 WHERE user_id=?`, id); err != nil {
		return err
	}
	if err := s.db.exec(`DELETE FROM sessions WHERE user_id=?`, id); err != nil {
		return err
	}
	if err := s.db.execRaw("COMMIT;"); err != nil {
		return err
	}
	rollback = false
	return nil
}

func (s *Store) ListNodes() []common.Node {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT * FROM nodes`)
	if err != nil {
		return nil
	}
	nodes := make([]common.Node, 0, len(rows))
	now := time.Now()
	for _, row := range rows {
		n := rowToNode(row)
		if n.LastSeenAt == nil || now.Sub(*n.LastSeenAt) > 35*time.Second {
			n.Status = "offline"
		}
		n.Secret = ""
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].CreatedAt.After(nodes[j].CreatedAt) })
	return nodes
}

func (s *Store) GetNode(id string) (common.Node, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getNodeLocked(id)
}

func (s *Store) SaveNode(n common.Node) error {
	n.UpdatedAt = time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.upsertNodeLocked(n)
}

func (s *Store) DeleteNode(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.db.execRaw("BEGIN IMMEDIATE;"); err != nil {
		return err
	}
	rollback := true
	defer func() {
		if rollback {
			_ = s.db.execRaw("ROLLBACK;")
		}
	}()
	for _, q := range []string{`DELETE FROM nodes WHERE id=?`, `DELETE FROM forward_rules WHERE node_id=?`, `DELETE FROM rule_statuses WHERE rule_id NOT IN (SELECT id FROM forward_rules)`} {
		if err := s.db.exec(q, id); err != nil {
			return err
		}
	}
	if err := s.db.execRaw("COMMIT;"); err != nil {
		return err
	}
	rollback = false
	return nil
}

func (s *Store) CreateNodeToken(name string, hours int) (common.NodeToken, error) {
	if hours <= 0 {
		hours = 24
	}
	plain, err := common.RandomToken(28)
	if err != nil {
		return common.NodeToken{}, err
	}
	now := time.Now()
	t := common.NodeToken{ID: common.RandomID("ntk"), Name: name, TokenHash: common.HashToken(plain), PlainToken: plain, MaxUses: 1, ExpiresAt: now.Add(time.Duration(hours) * time.Hour), CreatedAt: now}
	s.mu.Lock()
	defer s.mu.Unlock()
	return t, s.upsertNodeTokenLocked(t)
}

func (s *Store) ConsumeNodeToken(plain string) (common.NodeToken, error) {
	h := common.HashToken(plain)
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT * FROM node_tokens WHERE token_hash=?`, h)
	if err != nil {
		return common.NodeToken{}, err
	}
	if len(rows) == 0 {
		return common.NodeToken{}, fmt.Errorf("注册 Token 无效")
	}
	t := rowToNodeToken(rows[0])
	if now.After(t.ExpiresAt) {
		return common.NodeToken{}, fmt.Errorf("注册 Token 已过期")
	}
	if t.MaxUses > 0 && t.UsedCount >= t.MaxUses {
		return common.NodeToken{}, fmt.Errorf("注册 Token 已被使用")
	}
	t.UsedCount++
	t.UsedAt = &now
	if err := s.upsertNodeTokenLocked(t); err != nil {
		return common.NodeToken{}, err
	}
	return t, nil
}

func (s *Store) ListNodeTokens() []common.NodeToken {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT * FROM node_tokens`)
	if err != nil {
		return nil
	}
	items := make([]common.NodeToken, 0, len(rows))
	for _, row := range rows {
		t := rowToNodeToken(row)
		t.PlainToken = ""
		items = append(items, t)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	return items
}

func (s *Store) ListRules() []common.ForwardRule {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.listRulesLocked("", nil)
}

func (s *Store) ListRulesForUser(u common.User) []common.ForwardRule {
	s.mu.Lock()
	defer s.mu.Unlock()
	if isAdminRole(u.Role) {
		return s.listRulesLocked("", nil)
	}
	return s.listRulesLocked("WHERE user_id=?", []any{u.ID})
}

func (s *Store) GetRule(id string) (common.ForwardRule, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getRuleLocked(id)
}

func (s *Store) UserCanAccessRule(u common.User, ruleID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.getRuleLocked(ruleID)
	if !ok {
		return false
	}
	return isAdminRole(u.Role) || r.UserID == u.ID
}

func (s *Store) RulesForNode(nodeID string) []common.ForwardRule {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT * FROM forward_rules WHERE node_id=? AND enabled=1`, nodeID)
	if err != nil {
		return nil
	}
	rules := make([]common.ForwardRule, 0, len(rows))
	now := time.Now()
	for _, row := range rows {
		r := rowToRule(row)
		if r.ExpireAt != nil && now.After(*r.ExpireAt) {
			continue
		}
		if r.TrafficLimit > 0 && r.TrafficUsed >= r.TrafficLimit {
			continue
		}
		if r.UserID != "" {
			u, ok := s.userByIDLocked(r.UserID)
			if !ok || !s.userUsableLocked(u, now) {
				continue
			}
		}
		rules = append(rules, r)
	}
	return rules
}

func (s *Store) SaveRule(r common.ForwardRule) error {
	r.UpdatedAt = time.Now()
	if r.CreatedAt.IsZero() {
		r.CreatedAt = r.UpdatedAt
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.upsertRuleLocked(r)
}

func (s *Store) DeleteRule(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.db.exec(`DELETE FROM forward_rules WHERE id=?`, id); err != nil {
		return err
	}
	return s.db.exec(`DELETE FROM rule_statuses WHERE rule_id=?`, id)
}

// P3-27: CloneRule creates a copy of an existing rule with a new ID.
func (s *Store) CloneRule(ruleID string, actor common.User) (common.ForwardRule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	orig, ok := s.getRuleLocked(ruleID)
	if !ok {
		return common.ForwardRule{}, fmt.Errorf("规则不存在")
	}
	if !isAdminRole(actor.Role) && orig.UserID != actor.ID {
		return common.ForwardRule{}, fmt.Errorf("无权克隆该规则")
	}
	clone := orig
	clone.ID = common.RandomID("fr")
	clone.Name = orig.Name + " (副本)"
	clone.TrafficUsed = 0
	clone.CreatedAt = time.Now()
	clone.UpdatedAt = time.Now()
	if err := s.upsertRuleLocked(clone); err != nil {
		return common.ForwardRule{}, err
	}
	return clone, nil
}

func (s *Store) ResetUserTraffic(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if err := s.db.exec(`UPDATE users SET traffic_used=0, updated_at=? WHERE id=?`, timeToDB(now), id); err != nil {
		return err
	}
	return nil
}

func (s *Store) ResetRuleTraffic(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if err := s.db.exec(`UPDATE forward_rules SET traffic_used=0, updated_at=? WHERE id=?`, timeToDB(now), id); err != nil {
		return err
	}
	return nil
}

func (s *Store) ValidateRule(r common.ForwardRule, actor common.User) error {
	if r.Name == "" {
		return fmt.Errorf("规则名称不能为空")
	}
	if r.NodeID == "" {
		return fmt.Errorf("必须选择节点")
	}
	if r.Protocol != "tcp" && r.Protocol != "udp" && r.Protocol != "both" {
		return fmt.Errorf("协议只能是 tcp、udp 或 both")
	}
	if r.ListenPort < 1 || r.ListenPort > 65535 || r.TargetPort < 1 || r.TargetPort > 65535 {
		return fmt.Errorf("端口必须在 1-65535 之间")
	}
	if r.TargetHost == "" {
		return fmt.Errorf("目标地址不能为空")
	}
	// SSRF protection: non-admin users cannot target private/reserved IPs
	if !isAdminRole(actor.Role) && isPrivateIP(r.TargetHost) {
		return fmt.Errorf("非管理员不能使用内网/保留地址作为目标")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	n, ok := s.getNodeLocked(r.NodeID)
	if !ok {
		return fmt.Errorf("节点不存在")
	}
	if n.PortRangeStart > 0 && r.ListenPort < n.PortRangeStart {
		return fmt.Errorf("入站端口不在节点允许范围内")
	}
	if n.PortRangeEnd > 0 && r.ListenPort > n.PortRangeEnd {
		return fmt.Errorf("入站端口不在节点允许范围内")
	}
	rows, err := s.db.query(`SELECT * FROM forward_rules WHERE node_id=? AND listen_port=? AND id<>?`, r.NodeID, r.ListenPort, r.ID)
	if err != nil {
		return err
	}
	for _, row := range rows {
		old := rowToRule(row)
		if old.Protocol == r.Protocol || old.Protocol == "both" || r.Protocol == "both" {
			return fmt.Errorf("该节点端口已被其他规则使用")
		}
	}
	if n.MaxRules > 0 {
		countRows, _ := s.db.query(`SELECT COUNT(*) AS c FROM forward_rules WHERE node_id=? AND id<>?`, r.NodeID, r.ID)
		if len(countRows) > 0 && atoi(countRows[0]["c"]) >= n.MaxRules {
			return fmt.Errorf("该节点规则数量已达到上限")
		}
	}
	ownerID := r.UserID
	if ownerID == "" {
		ownerID = actor.ID
	}
	owner, ok := s.userByIDLocked(ownerID)
	if !ok {
		return fmt.Errorf("所属用户不存在")
	}
	now := time.Now()
	if !s.userUsableLocked(owner, now) {
		return fmt.Errorf("所属用户已禁用、过期或流量已用尽")
	}
	if !isAdminRole(actor.Role) && owner.ID != actor.ID {
		return fmt.Errorf("普通用户只能创建自己的规则")
	}
	if len(owner.AllowedNodeIDs) > 0 && !containsString(owner.AllowedNodeIDs, r.NodeID) {
		return fmt.Errorf("该用户无权使用所选节点")
	}
	if owner.PortRangeStart > 0 && r.ListenPort < owner.PortRangeStart {
		return fmt.Errorf("入站端口不在用户允许范围内")
	}
	if owner.PortRangeEnd > 0 && r.ListenPort > owner.PortRangeEnd {
		return fmt.Errorf("入站端口不在用户允许范围内")
	}
	if owner.RuleLimit > 0 {
		countRows, _ := s.db.query(`SELECT COUNT(*) AS c FROM forward_rules WHERE user_id=? AND id<>?`, owner.ID, r.ID)
		if len(countRows) > 0 && atoi(countRows[0]["c"]) >= owner.RuleLimit {
			return fmt.Errorf("该用户规则数量已达到上限")
		}
	}
	return nil
}

func (s *Store) UpdateNodeHeartbeat(nodeID string, req common.AgentHeartbeatRequest, remoteIP string) error {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	n, ok := s.getNodeLocked(nodeID)
	if !ok {
		return fmt.Errorf("节点不存在")
	}
	n.Status = "online"
	n.Hostname = req.Hostname
	n.OS = req.OS
	n.Arch = req.Arch
	n.AgentVersion = req.AgentVersion
	n.PrivateIPs = req.PrivateIPs
	n.PublicIP = remoteIP
	n.LastSeenAt = &now
	n.LastMetrics = req.Metrics
	n.LastError = req.LastError
	n.FirewallState = req.FirewallState
	n.FirewallError = req.FirewallError
	n.UpdatedAt = now
	if err := s.db.execRaw("BEGIN IMMEDIATE;"); err != nil {
		return err
	}
	rollback := true
	defer func() {
		if rollback {
			_ = s.db.execRaw("ROLLBACK;")
		}
	}()
	if err := s.upsertNodeLocked(n); err != nil {
		return err
	}
	for _, st := range req.RuleStatuses {
		old, _ := s.getStatusLocked(st.RuleID)
		if r, ok := s.getRuleLocked(st.RuleID); ok {
			var delta uint64
			if old.RuleID == "" {
				delta = st.BytesIn + st.BytesOut
			} else if st.BytesIn >= old.BytesIn && st.BytesOut >= old.BytesOut {
				delta = (st.BytesIn - old.BytesIn) + (st.BytesOut - old.BytesOut)
			} else {
				delta = st.BytesIn + st.BytesOut
			}
			if delta > 0 {
				r.TrafficUsed += delta
				r.UpdatedAt = now
				if err := s.upsertRuleLocked(r); err != nil {
					return err
				}
				if r.UserID != "" {
					if u, ok := s.userByIDLocked(r.UserID); ok {
						u.TrafficUsed += delta
						u.UpdatedAt = now
						if err := s.upsertUserLocked(u); err != nil {
							return err
						}
					}
				}
			}
		}
		st.UpdatedAt = now
		if err := s.upsertStatusLocked(st); err != nil {
			return err
		}
	}
	if err := s.db.execRaw("COMMIT;"); err != nil {
		return err
	}
	rollback = false
	return nil
}

func (s *Store) NodeSecret(nodeID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, ok := s.getNodeLocked(nodeID)
	return n.Secret, ok && n.Secret != ""
}

func (s *Store) ListStatuses() []common.RuleRuntimeStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT * FROM rule_statuses`)
	if err != nil {
		return nil
	}
	items := make([]common.RuleRuntimeStatus, 0, len(rows))
	for _, row := range rows {
		items = append(items, rowToStatus(row))
	}
	return items
}

func (s *Store) StatusMap() map[string]common.RuleRuntimeStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT * FROM rule_statuses`)
	m := map[string]common.RuleRuntimeStatus{}
	if err != nil {
		return m
	}
	for _, row := range rows {
		st := rowToStatus(row)
		m[st.RuleID] = st
	}
	return m
}

func (s *Store) AddAudit(userID, action, target, ip, detail string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.insertAuditLocked(AuditLog{ID: common.RandomID("log"), UserID: userID, Action: action, Target: target, IP: ip, Detail: detail, CreatedAt: time.Now()})
	_ = s.db.exec(`DELETE FROM audit_logs WHERE id NOT IN (SELECT id FROM audit_logs ORDER BY created_at DESC LIMIT 50000)`)
}

// P3-26: FireWebhook sends an async HTTP POST to the configured webhook URL.
// The event payload includes action, target, and a timestamp.
// It runs in a goroutine and will not block the caller.
func (s *Store) FireWebhook(action, target, detail string) {
	s.mu.Lock()
	url := ""
	secret := ""
	rows, err := s.db.query(`SELECT key, value FROM settings WHERE key IN ('webhook_url', 'webhook_secret')`)
	s.mu.Unlock()
	if err != nil {
		return
	}
	for _, row := range rows {
		switch row["key"] {
		case "webhook_url":
			url = row["value"]
		case "webhook_secret":
			secret = row["value"]
		}
	}
	if url == "" {
		return
	}
	payload := map[string]any{
		"action":    action,
		"target":    target,
		"detail":    detail,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	}
	go func() {
		b, err := json.Marshal(payload)
		if err != nil {
			return
		}
		for attempt := 0; attempt < 3; attempt++ {
			if attempt > 0 {
				time.Sleep(time.Duration(attempt) * 2 * time.Second)
			}
			req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(b))
			if err != nil {
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("User-Agent", "RelayGuard-Webhook/1.0")
			if secret != "" {
				sig := common.HMACSHA256Hex(secret, b)
				req.Header.Set("X-RelayGuard-Signature", sig)
			}
			client := &http.Client{Timeout: 10 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				continue
			}
			_, _ = io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode < 500 {
				return
			}
		}
	}()
}

func (s *Store) GetSetting(key string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT value FROM settings WHERE key=?`, key)
	if err != nil || len(rows) == 0 {
		return ""
	}
	return rows[0]["value"]
}

func (s *Store) SetSetting(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.exec(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, key, value)
}

func (s *Store) ListSettings() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT key, value FROM settings`)
	if err != nil {
		return nil
	}
	m := make(map[string]string, len(rows))
	for _, row := range rows {
		m[row["key"]] = row["value"]
	}
	return m
}

func (s *Store) ListAuditLogs(limit int) []AuditLog {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil
	}
	logs := make([]AuditLog, 0, len(rows))
	for _, row := range rows {
		logs = append(logs, rowToAudit(row))
	}
	return logs
}

// P3-28: ListRulesByTags returns rules that have any of the specified tags.
func (s *Store) ListRulesByTags(u common.User, tags []string) []common.ForwardRule {
	s.mu.Lock()
	defer s.mu.Unlock()
	all := s.listRulesLocked("", nil)
	if !isAdminRole(u.Role) {
		filtered := make([]common.ForwardRule, 0)
		for _, r := range all {
			if r.UserID == u.ID {
				filtered = append(filtered, r)
			}
		}
		all = filtered
	}
	if len(tags) == 0 {
		return all
	}
	tagSet := make(map[string]bool, len(tags))
	for _, t := range tags {
		tagSet[t] = true
	}
	result := make([]common.ForwardRule, 0)
	for _, r := range all {
		for _, tag := range r.Tags {
			if tagSet[tag] {
				result = append(result, r)
				break
			}
		}
	}
	return result
}

func (s *Store) Dashboard() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	totalTraffic := uint64(0)
	enabledRules := 0
	rules := s.listRulesLocked("", nil)
	for _, r := range rules {
		totalTraffic += r.TrafficUsed
		if r.Enabled {
			enabledRules++
		}
	}
	nodes := s.listNodesRawLocked()
	onlineNodes := 0
	for _, n := range nodes {
		if n.LastSeenAt != nil && now.Sub(*n.LastSeenAt) <= 35*time.Second {
			onlineNodes++
		}
	}
	numUsers, _ := s.db.querySingleInt(`SELECT COUNT(*) FROM users`)
	return map[string]any{"nodes": len(nodes), "online_nodes": onlineNodes, "rules": len(rules), "enabled_rules": enabledRules, "users": numUsers, "traffic_used": totalTraffic, "storage_engine": "sqlite", "version": common.Version}
}

func (s *Store) Backup(destDir string) (string, error) {
	if destDir == "" {
		destDir = filepath.Join(filepath.Dir(s.path), "backups")
	}
	if err := os.MkdirAll(destDir, 0700); err != nil {
		return "", err
	}
	name := fmt.Sprintf("relayguard-backup-%s.db", time.Now().Format("20060102-150405"))
	dest := filepath.Join(destDir, name)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.db.execRaw("PRAGMA wal_checkpoint(TRUNCATE);"); err != nil {
		return "", err
	}
	b, err := os.ReadFile(s.path)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(dest, b, 0600); err != nil {
		return "", err
	}
	_ = s.insertAuditLocked(AuditLog{ID: common.RandomID("log"), UserID: "system", Action: "backup", Target: name, IP: "local", Detail: "创建 SQLite 数据库备份", CreatedAt: time.Now()})
	return dest, nil
}

func (s *Store) ListBackups(destDir string) []map[string]any {
	if destDir == "" {
		destDir = filepath.Join(filepath.Dir(s.path), "backups")
	}
	ents, err := os.ReadDir(destDir)
	if err != nil {
		return nil
	}
	items := []map[string]any{}
	for _, ent := range ents {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".db") {
			continue
		}
		info, err := ent.Info()
		if err != nil {
			continue
		}
		items = append(items, map[string]any{"name": ent.Name(), "size": info.Size(), "created_at": info.ModTime()})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i]["created_at"].(time.Time).After(items[j]["created_at"].(time.Time))
	})
	return items
}

// validatePasswordStrength checks that a password meets minimum strength requirements.
// At least 8 characters and must contain characters from at least 3 of the 4 categories:
// uppercase, lowercase, digits, special characters.
func validatePasswordStrength(password string) error {
	if len(password) < 8 {
		return fmt.Errorf("密码至少需要 8 位")
	}
	var hasUpper, hasLower, hasDigit, hasSpecial bool
	for _, ch := range password {
		switch {
		case ch >= 'A' && ch <= 'Z':
			hasUpper = true
		case ch >= 'a' && ch <= 'z':
			hasLower = true
		case ch >= '0' && ch <= '9':
			hasDigit = true
		default:
			hasSpecial = true
		}
	}
	categories := 0
	for _, ok := range []bool{hasUpper, hasLower, hasDigit, hasSpecial} {
		if ok {
			categories++
		}
	}
	if categories < 3 {
		return fmt.Errorf("密码必须包含大写字母、小写字母、数字、特殊字符中的至少 3 种")
	}
	return nil
}

func (s *Store) UpdateOwnPassword(userID, oldPassword, newPassword string) error {
	if err := validatePasswordStrength(newPassword); err != nil {
		return err
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.userByIDLocked(userID)
	if !ok {
		return fmt.Errorf("用户不存在")
	}
	if !common.VerifyPassword(oldPassword, u.PasswordHash) {
		return fmt.Errorf("当前密码不正确")
	}
	hash, err := common.HashPassword(newPassword)
	if err != nil {
		return err
	}
	u.PasswordHash = hash
	u.MustChange = false
	u.UpdatedAt = now
	return s.upsertUserLocked(u)
}

func (s *Store) VerifyUserPassword(userID, password string) (common.User, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.userByIDLocked(userID)
	if !ok || u.Disabled {
		return common.User{}, false
	}
	return u, common.VerifyPassword(password, u.PasswordHash)
}

func (s *Store) SetUserTOTP(userID, secret string, enabled bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.userByIDLocked(userID)
	if !ok {
		return fmt.Errorf("用户不存在")
	}
	u.TOTPSecret = secret
	u.TOTPEnabled = enabled
	u.UpdatedAt = time.Now()
	return s.upsertUserLocked(u)
}

func (s *Store) ListSessionsForUser(userID string) []common.Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT * FROM sessions WHERE user_id=? ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil
	}
	out := make([]common.Session, 0, len(rows))
	now := time.Now()
	for _, row := range rows {
		sx := rowToSession(row)
		if now.After(sx.ExpiresAt) {
			_ = s.db.exec(`DELETE FROM sessions WHERE token=?`, sx.Token)
			continue
		}
		sx.Token = ""
		out = append(out, sx)
	}
	return out
}

func (s *Store) DeleteOtherSessions(userID, keepToken string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.exec(`DELETE FROM sessions WHERE user_id=? AND token<>?`, userID, keepToken)
}

func (s *Store) DeleteSessionsByUser(userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.exec(`DELETE FROM sessions WHERE user_id=?`, userID)
}

// RotateSessionToken replaces the session token for a given session ID,
// invalidating the old token and returning the new session (with new token).
func (s *Store) RotateSessionToken(oldToken string) (common.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.query(`SELECT * FROM sessions WHERE token=?`, oldToken)
	if err != nil || len(rows) == 0 {
		return common.Session{}, fmt.Errorf("会话不存在")
	}
	sess := rowToSession(rows[0])
	newToken, err := common.RandomToken(32)
	if err != nil {
		return common.Session{}, err
	}
	sess.Token = newToken
	if err := s.db.exec(`DELETE FROM sessions WHERE token=?`, oldToken); err != nil {
		return common.Session{}, err
	}
	return sess, s.upsertSessionLocked(sess)
}

func (s *Store) cleanupExpiredSessions() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.exec(`DELETE FROM sessions WHERE expires_at < ?`, timeToDB(time.Now()))
}

// CleanupExpired removes expired sessions, expired node tokens, and old audit logs.
// Called periodically.
func (s *Store) CleanupExpired() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var err error
	if e := s.db.exec(`DELETE FROM sessions WHERE expires_at < ?`, timeToDB(time.Now())); e != nil && err == nil {
		err = e
	}
	if e := s.db.exec(`DELETE FROM node_tokens WHERE expires_at < ?`, timeToDB(time.Now())); e != nil && err == nil {
		err = e
	}
	// P3-31: Configurable audit log retention
	days := 90 // default
	if rows, e := s.db.query(`SELECT value FROM settings WHERE key=?`, "audit_retention_days"); e == nil && len(rows) > 0 {
		if d, perr := strconv.Atoi(rows[0]["value"]); perr == nil && d > 0 {
			days = d
		}
	}
	cutoff := time.Now().AddDate(0, 0, -days).Format(time.RFC3339)
	if e := s.db.exec(`DELETE FROM audit_logs WHERE created_at < ?`, cutoff); e != nil && err == nil {
		err = e
	}
	if e := s.db.exec(`DELETE FROM connectivity_tests WHERE created_at < ?`, cutoff); e != nil && err == nil {
		err = e
	}
	return err
}

// StartCleanupLoop runs periodic cleanup of expired sessions and tokens.
func (s *Store) StartCleanupLoop(stopCh <-chan struct{}) {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			_ = s.CleanupExpired()
		case <-stopCh:
			return
		}
	}
}

func (s *Store) userCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, _ := s.db.querySingleInt(`SELECT COUNT(*) FROM users`)
	return n
}

func (s *Store) nodeCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, _ := s.db.querySingleInt(`SELECT COUNT(*) FROM nodes`)
	return n
}

func (s *Store) ruleCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, _ := s.db.querySingleInt(`SELECT COUNT(*) FROM forward_rules`)
	return n
}

func (s *Store) listNodesRawLocked() []common.Node {
	rows, err := s.db.query(`SELECT * FROM nodes`)
	if err != nil {
		return nil
	}
	out := make([]common.Node, 0, len(rows))
	for _, row := range rows {
		out = append(out, rowToNode(row))
	}
	return out
}

func (s *Store) listRulesLocked(where string, args []any) []common.ForwardRule {
	q := `SELECT * FROM forward_rules`
	if where != "" {
		q += " " + where
	}
	rows, err := s.db.query(q, args...)
	if err != nil {
		return nil
	}
	rules := make([]common.ForwardRule, 0, len(rows))
	for _, row := range rows {
		rules = append(rules, rowToRule(row))
	}
	sort.Slice(rules, func(i, j int) bool { return rules[i].CreatedAt.After(rules[j].CreatedAt) })
	return rules
}

func (s *Store) getNodeLocked(id string) (common.Node, bool) {
	rows, err := s.db.query(`SELECT * FROM nodes WHERE id=?`, id)
	if err != nil || len(rows) == 0 {
		return common.Node{}, false
	}
	return rowToNode(rows[0]), true
}

func (s *Store) getRuleLocked(id string) (common.ForwardRule, bool) {
	rows, err := s.db.query(`SELECT * FROM forward_rules WHERE id=?`, id)
	if err != nil || len(rows) == 0 {
		return common.ForwardRule{}, false
	}
	return rowToRule(rows[0]), true
}

func (s *Store) getStatusLocked(id string) (common.RuleRuntimeStatus, bool) {
	rows, err := s.db.query(`SELECT * FROM rule_statuses WHERE rule_id=?`, id)
	if err != nil || len(rows) == 0 {
		return common.RuleRuntimeStatus{}, false
	}
	return rowToStatus(rows[0]), true
}

func (s *Store) userByIDLocked(id string) (common.User, bool) {
	rows, err := s.db.query(`SELECT * FROM users WHERE id=?`, id)
	if err != nil || len(rows) == 0 {
		return common.User{}, false
	}
	return rowToUser(rows[0]), true
}

func (s *Store) userUsableLocked(u common.User, now time.Time) bool {
	if u.Disabled {
		return false
	}
	if u.ExpiresAt != nil && now.After(*u.ExpiresAt) {
		return false
	}
	if u.TrafficLimit > 0 && u.TrafficUsed >= u.TrafficLimit {
		return false
	}
	return true
}

func (s *Store) upsertUserLocked(u common.User) error {
	return s.db.exec(`INSERT OR REPLACE INTO users(id,username,password_hash,role,traffic_limit,traffic_used,rule_limit,allowed_node_ids,port_range_start,port_range_end,expires_at,disabled,must_change,totp_enabled,totp_secret,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, u.ID, u.Username, u.PasswordHash, u.Role, u.TrafficLimit, u.TrafficUsed, u.RuleLimit, jsonString(u.AllowedNodeIDs), u.PortRangeStart, u.PortRangeEnd, timePtrToDB(u.ExpiresAt), u.Disabled, u.MustChange, u.TOTPEnabled, u.TOTPSecret, timeToDB(u.CreatedAt), timeToDB(u.UpdatedAt))
}
func (s *Store) upsertSessionLocked(x common.Session) error {
	return s.db.exec(`INSERT OR REPLACE INTO sessions(token,user_id,ip,user_agent,expires_at,created_at) VALUES(?,?,?,?,?,?)`, x.Token, x.UserID, x.IP, x.UserAgent, timeToDB(x.ExpiresAt), timeToDB(x.CreatedAt))
}
func (s *Store) upsertNodeLocked(n common.Node) error {
	// TODO(P0-2): Node secret is currently stored in plaintext. If the database
	// leaks, an attacker can forge agent heartbeats. Future migration should
	// store secrets encrypted (AES-GCM) with a server-managed key, or use a
	// derived-key scheme that does not require retrievable plaintext for
	// HMAC signature verification. This is a breaking change requiring a
	// migration path for deployed agents.
	return s.db.exec(`INSERT OR REPLACE INTO nodes(id,name,secret,status,hostname,os,arch,agent_version,public_ip,private_ips,port_range_start,port_range_end,firewall_mode,max_rules,last_seen_at,last_metrics,last_error,firewall_state,firewall_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, n.ID, n.Name, n.Secret, n.Status, n.Hostname, n.OS, n.Arch, n.AgentVersion, n.PublicIP, jsonString(n.PrivateIPs), n.PortRangeStart, n.PortRangeEnd, n.FirewallMode, n.MaxRules, timePtrToDB(n.LastSeenAt), jsonString(n.LastMetrics), n.LastError, n.FirewallState, n.FirewallError, timeToDB(n.CreatedAt), timeToDB(n.UpdatedAt))
}
func (s *Store) upsertNodeTokenLocked(t common.NodeToken) error {
	return s.db.exec(`INSERT OR REPLACE INTO node_tokens(id,name,token_hash,used_by_node,used_at,max_uses,used_count,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, t.ID, t.Name, t.TokenHash, t.UsedByNode, timePtrToDB(t.UsedAt), t.MaxUses, t.UsedCount, timeToDB(t.ExpiresAt), timeToDB(t.CreatedAt))
}
func (s *Store) upsertRuleLocked(r common.ForwardRule) error {
	return s.db.exec(`INSERT OR REPLACE INTO forward_rules(id,name,user_id,node_id,protocol,listen_port,target_host,target_port,enabled,source_cidrs,speed_limit_mbps,max_connections,traffic_limit,traffic_used,expire_at,description,firewall_managed,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, r.ID, r.Name, r.UserID, r.NodeID, r.Protocol, r.ListenPort, r.TargetHost, r.TargetPort, r.Enabled, jsonString(r.SourceCIDRs), r.SpeedLimitMbps, r.MaxConnections, r.TrafficLimit, r.TrafficUsed, timePtrToDB(r.ExpireAt), r.Description, r.FirewallManaged, jsonString(r.Tags), timeToDB(r.CreatedAt), timeToDB(r.UpdatedAt))
}
func (s *Store) upsertStatusLocked(st common.RuleRuntimeStatus) error {
	return s.db.exec(`INSERT OR REPLACE INTO rule_statuses(rule_id,state,protocol,listen_port,active_connections,bytes_in,bytes_out,last_error,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`, st.RuleID, st.State, st.Protocol, st.ListenPort, st.ActiveConnections, st.BytesIn, st.BytesOut, st.LastError, timeToDB(st.UpdatedAt))
}
func (s *Store) insertAuditLocked(l AuditLog) error {
	return s.db.exec(`INSERT INTO audit_logs(id,user_id,action,target,ip,detail,created_at) VALUES(?,?,?,?,?,?,?)`, l.ID, l.UserID, l.Action, l.Target, l.IP, l.Detail, timeToDB(l.CreatedAt))
}

func (s *Store) CreateConnectivityTest(ruleID string, requestedBy common.User) (common.ConnectivityTestResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rule, ok := s.getRuleLocked(ruleID)
	if !ok {
		return common.ConnectivityTestResult{}, fmt.Errorf("规则不存在")
	}
	if !isStoreAdmin(requestedBy) && rule.UserID != requestedBy.ID {
		return common.ConnectivityTestResult{}, fmt.Errorf("无权检测该规则")
	}
	now := time.Now()
	item := common.ConnectivityTestResult{ID: common.RandomID("test"), RuleID: rule.ID, NodeID: rule.NodeID, RequestedBy: requestedBy.ID, Protocol: rule.Protocol, ListenPort: rule.ListenPort, TargetHost: rule.TargetHost, TargetPort: rule.TargetPort, Status: "queued", CreatedAt: now}
	if err := s.upsertConnectivityTestLocked(item); err != nil {
		return common.ConnectivityTestResult{}, err
	}
	_ = s.insertAuditLocked(AuditLog{ID: common.RandomID("log"), UserID: requestedBy.ID, Action: "connectivity_test", Target: rule.ID, IP: "panel", Detail: fmt.Sprintf("创建连通性检测：%s:%d", rule.TargetHost, rule.TargetPort), CreatedAt: now})
	return item, nil
}

func (s *Store) ListConnectivityTests(u common.User, ruleID string, testID string, limit int) []common.ConnectivityTestResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	where := ""
	args := []any{}
	if testID != "" {
		where = "WHERE id=?"
		args = append(args, testID)
	} else if ruleID != "" {
		where = "WHERE rule_id=?"
		args = append(args, ruleID)
	}
	q := "SELECT * FROM connectivity_tests " + where + " ORDER BY created_at DESC LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.query(q, args...)
	if err != nil {
		return nil
	}
	out := make([]common.ConnectivityTestResult, 0, len(rows))
	for _, row := range rows {
		item := rowToConnectivityTest(row)
		if !isStoreAdmin(u) {
			rule, ok := s.getRuleLocked(item.RuleID)
			if !ok || rule.UserID != u.ID {
				continue
			}
		}
		out = append(out, item)
	}
	return out
}

func (s *Store) PullConnectivityTestsForNode(nodeID string, limit int) []common.ConnectivityTestRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 || limit > 20 {
		limit = 5
	}
	rows, err := s.db.query(`SELECT * FROM connectivity_tests WHERE node_id=? AND status=? ORDER BY created_at ASC LIMIT ?`, nodeID, "queued", limit)
	if err != nil {
		return nil
	}
	now := time.Now()
	out := make([]common.ConnectivityTestRequest, 0, len(rows))
	for _, row := range rows {
		item := rowToConnectivityTest(row)
		item.Status = "running"
		item.StartedAt = &now
		_ = s.upsertConnectivityTestLocked(item)
		out = append(out, common.ConnectivityTestRequest{ID: item.ID, RuleID: item.RuleID, NodeID: item.NodeID, Protocol: item.Protocol, ListenPort: item.ListenPort, TargetHost: item.TargetHost, TargetPort: item.TargetPort, CreatedAt: item.CreatedAt})
	}
	return out
}

func (s *Store) SaveConnectivityTestResults(nodeID string, results []common.ConnectivityTestResult) {
	if len(results) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, item := range results {
		if item.NodeID != "" && item.NodeID != nodeID {
			continue
		}
		old, ok := s.getConnectivityTestLocked(item.ID)
		if !ok || old.NodeID != nodeID {
			continue
		}
		item.RuleID = old.RuleID
		item.NodeID = old.NodeID
		item.RequestedBy = old.RequestedBy
		item.Protocol = old.Protocol
		item.ListenPort = old.ListenPort
		item.TargetHost = old.TargetHost
		item.TargetPort = old.TargetPort
		item.CreatedAt = old.CreatedAt
		if item.StartedAt == nil {
			item.StartedAt = old.StartedAt
		}
		if item.FinishedAt == nil {
			now := time.Now()
			item.FinishedAt = &now
		}
		if item.Status == "" {
			item.Status = "failed"
		}
		_ = s.upsertConnectivityTestLocked(item)
	}
}

func (s *Store) getConnectivityTestLocked(id string) (common.ConnectivityTestResult, bool) {
	rows, err := s.db.query(`SELECT * FROM connectivity_tests WHERE id=?`, id)
	if err != nil || len(rows) == 0 {
		return common.ConnectivityTestResult{}, false
	}
	return rowToConnectivityTest(rows[0]), true
}

func (s *Store) upsertConnectivityTestLocked(t common.ConnectivityTestResult) error {
	return s.db.exec(`INSERT OR REPLACE INTO connectivity_tests(id,rule_id,node_id,requested_by,protocol,listen_port,target_host,target_port,status,local_listen_ok,target_tcp_ok,target_udp_ok,ping_ok,ping_latency_ms,error,details,created_at,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, t.ID, t.RuleID, t.NodeID, t.RequestedBy, t.Protocol, t.ListenPort, t.TargetHost, t.TargetPort, t.Status, t.LocalListenOK, t.TargetTCPOK, t.TargetUDPOK, t.PingOK, t.PingLatencyMS, t.Error, jsonString(t.Details), timeToDB(t.CreatedAt), timePtrToDB(t.StartedAt), timePtrToDB(t.FinishedAt))
}

func isStoreAdmin(u common.User) bool { return u.Role == "super_admin" || u.Role == "admin" }

func rowToConnectivityTest(r map[string]string) common.ConnectivityTestResult {
	var details []string
	_ = json.Unmarshal([]byte(r["details"]), &details)
	return common.ConnectivityTestResult{ID: r["id"], RuleID: r["rule_id"], NodeID: r["node_id"], RequestedBy: r["requested_by"], Protocol: r["protocol"], ListenPort: atoi(r["listen_port"]), TargetHost: r["target_host"], TargetPort: atoi(r["target_port"]), Status: r["status"], LocalListenOK: atob(r["local_listen_ok"]), TargetTCPOK: atob(r["target_tcp_ok"]), TargetUDPOK: atob(r["target_udp_ok"]), PingOK: atob(r["ping_ok"]), PingLatencyMS: atoi(r["ping_latency_ms"]), Error: r["error"], Details: details, CreatedAt: parseTime(r["created_at"]), StartedAt: parseTimePtr(r["started_at"]), FinishedAt: parseTimePtr(r["finished_at"])}
}

func rowToUser(r map[string]string) common.User {
	var allowed []string
	_ = json.Unmarshal([]byte(r["allowed_node_ids"]), &allowed)
	return common.User{ID: r["id"], Username: r["username"], PasswordHash: r["password_hash"], Role: r["role"], TrafficLimit: atou64(r["traffic_limit"]), TrafficUsed: atou64(r["traffic_used"]), RuleLimit: atoi(r["rule_limit"]), AllowedNodeIDs: allowed, PortRangeStart: atoi(r["port_range_start"]), PortRangeEnd: atoi(r["port_range_end"]), ExpiresAt: parseTimePtr(r["expires_at"]), Disabled: atob(r["disabled"]), MustChange: atob(r["must_change"]), TOTPEnabled: atob(r["totp_enabled"]), TOTPSecret: r["totp_secret"], CreatedAt: parseTime(r["created_at"]), UpdatedAt: parseTime(r["updated_at"])}
}
func rowToSession(r map[string]string) common.Session {
	return common.Session{Token: r["token"], UserID: r["user_id"], IP: r["ip"], UserAgent: r["user_agent"], ExpiresAt: parseTime(r["expires_at"]), CreatedAt: parseTime(r["created_at"])}
}
func rowToNode(r map[string]string) common.Node {
	var ips []string
	_ = json.Unmarshal([]byte(r["private_ips"]), &ips)
	var m common.NodeMetrics
	_ = json.Unmarshal([]byte(r["last_metrics"]), &m)
	return common.Node{ID: r["id"], Name: r["name"], Secret: r["secret"], Status: r["status"], Hostname: r["hostname"], OS: r["os"], Arch: r["arch"], AgentVersion: r["agent_version"], PublicIP: r["public_ip"], PrivateIPs: ips, PortRangeStart: atoi(r["port_range_start"]), PortRangeEnd: atoi(r["port_range_end"]), FirewallMode: r["firewall_mode"], MaxRules: atoi(r["max_rules"]), LastSeenAt: parseTimePtr(r["last_seen_at"]), LastMetrics: m, LastError: r["last_error"], FirewallState: r["firewall_state"], FirewallError: r["firewall_error"], CreatedAt: parseTime(r["created_at"]), UpdatedAt: parseTime(r["updated_at"])}
}
func rowToNodeToken(r map[string]string) common.NodeToken {
	return common.NodeToken{ID: r["id"], Name: r["name"], TokenHash: r["token_hash"], UsedByNode: r["used_by_node"], UsedAt: parseTimePtr(r["used_at"]), MaxUses: atoi(r["max_uses"]), UsedCount: atoi(r["used_count"]), ExpiresAt: parseTime(r["expires_at"]), CreatedAt: parseTime(r["created_at"])}
}
func rowToRule(r map[string]string) common.ForwardRule {
	var cidrs []string
	_ = json.Unmarshal([]byte(r["source_cidrs"]), &cidrs)
	var tags []string
	_ = json.Unmarshal([]byte(r["tags"]), &tags)
	return common.ForwardRule{ID: r["id"], Name: r["name"], UserID: r["user_id"], NodeID: r["node_id"], Protocol: r["protocol"], ListenPort: atoi(r["listen_port"]), TargetHost: r["target_host"], TargetPort: atoi(r["target_port"]), Enabled: atob(r["enabled"]), SourceCIDRs: cidrs, SpeedLimitMbps: atoi(r["speed_limit_mbps"]), MaxConnections: atoi(r["max_connections"]), TrafficLimit: atou64(r["traffic_limit"]), TrafficUsed: atou64(r["traffic_used"]), ExpireAt: parseTimePtr(r["expire_at"]), Description: r["description"], FirewallManaged: atobDefault(r["firewall_managed"], true), Tags: tags, CreatedAt: parseTime(r["created_at"]), UpdatedAt: parseTime(r["updated_at"])}
}
func rowToStatus(r map[string]string) common.RuleRuntimeStatus {
	return common.RuleRuntimeStatus{RuleID: r["rule_id"], State: r["state"], Protocol: r["protocol"], ListenPort: atoi(r["listen_port"]), ActiveConnections: atoi(r["active_connections"]), BytesIn: atou64(r["bytes_in"]), BytesOut: atou64(r["bytes_out"]), LastError: r["last_error"], UpdatedAt: parseTime(r["updated_at"])}
}
func rowToAudit(r map[string]string) AuditLog {
	return AuditLog{ID: r["id"], UserID: r["user_id"], Action: r["action"], Target: r["target"], IP: r["ip"], Detail: r["detail"], CreatedAt: parseTime(r["created_at"])}
}

func jsonString(v any) string { b, _ := json.Marshal(v); return string(b) }
func timeToDB(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}
func timePtrToDB(t *time.Time) any {
	if t == nil || t.IsZero() {
		return nil
	}
	return timeToDB(*t)
}
func parseTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t
}
func parseTimePtr(s string) *time.Time {
	t := parseTime(s)
	if t.IsZero() {
		return nil
	}
	return &t
}
func atoi(s string) int      { n, _ := strconv.Atoi(s); return n }
func atou64(s string) uint64 { n, _ := strconv.ParseUint(s, 10, 64); return n }
func atob(s string) bool     { return s == "1" || strings.EqualFold(s, "true") }
func atobDefault(s string, def bool) bool {
	if s == "" {
		return def
	}
	return atob(s)
}
func isAdminRole(role string) bool { return role == "super_admin" || role == "admin" }

// isPrivateIP checks if the host portion of an address is a loopback,
// link-local, or RFC1918 private address. Returns true for addresses that
// should be restricted from non-admin users to prevent SSRF.
// It also checks IPv6-mapped IPv4, IPv6 loopback, and unique local addresses.
func isPrivateIP(host string) bool {
	// Strip port if present (handles host:port format)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	// Try parsing as an IP first (both v4 and v6)
	if ip, err := netip.ParseAddr(host); err == nil {
		return isPrivateAddr(ip)
	}
	// Resolve hostname
	addrs, err := net.LookupHost(host)
	if err != nil {
		// If resolution fails, treat as potentially unsafe
		return true
	}
	for _, addr := range addrs {
		ip, err := netip.ParseAddr(addr)
		if err != nil {
			continue
		}
		if isPrivateAddr(ip) {
			return true
		}
	}
	return false
}

// isPrivateAddr checks a single parsed IP address for private/reserved ranges,
// covering IPv4, IPv6, and IPv4-mapped IPv6 addresses.
func isPrivateAddr(ip netip.Addr) bool {
	// Unwrap IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1)
	ip = ip.Unmap()
	return ip.IsLoopback() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsPrivate() ||
		ip.Is4In6() ||
		// IPv6 specific checks
		ip == netip.IPv6Unspecified() // ::
}

func containsString(items []string, v string) bool {
	for _, item := range items {
		if item == v {
			return true
		}
	}
	return false
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil || !errors.Is(err, os.ErrNotExist)
}

func (s *Store) backupDir(destDir string) string {
	if destDir == "" {
		return filepath.Join(filepath.Dir(s.path), "backups")
	}
	return destDir
}

func safeBackupName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", fmt.Errorf("备份文件名不能为空")
	}
	base := filepath.Base(name)
	if base != name || strings.Contains(name, "..") || !strings.HasSuffix(name, ".db") {
		return "", fmt.Errorf("备份文件名不合法")
	}
	return base, nil
}

func validateRelayGuardDB(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.IsDir() || info.Size() == 0 {
		return fmt.Errorf("备份文件无效")
	}
	db, err := openSQLite(path)
	if err != nil {
		return err
	}
	defer db.close()
	rows, err := db.query(`PRAGMA integrity_check;`)
	if err != nil {
		return err
	}
	ok := false
	for _, row := range rows {
		for _, v := range row {
			if strings.EqualFold(v, "ok") {
				ok = true
			}
		}
	}
	if !ok {
		return fmt.Errorf("SQLite 完整性校验失败")
	}
	rows, err = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','nodes','forward_rules','settings')`)
	if err != nil {
		return err
	}
	if len(rows) < 4 {
		return fmt.Errorf("不是有效的 RelayGuard 数据库备份")
	}
	return nil
}

func copyFileAtomic(src, dst string, perm os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	syncErr := out.Sync()
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return copyErr
	}
	if syncErr != nil {
		_ = os.Remove(tmp)
		return syncErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return closeErr
	}
	if err := os.Chmod(tmp, perm); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

func (s *Store) reopenSQLiteLocked() error {
	db, err := openSQLite(s.path)
	if err != nil {
		return err
	}
	s.db = db
	for _, q := range []string{
		`PRAGMA journal_mode=WAL;`,
		`PRAGMA synchronous=NORMAL;`,
		`PRAGMA busy_timeout=5000;`,
		`PRAGMA foreign_keys=ON;`,
	} {
		if err := s.db.execRaw(q); err != nil {
			return err
		}
	}
	return s.setDefaultSettingsLocked()
}

func (s *Store) RestoreBackup(name string, destDir string, userID string, ip string) (map[string]string, error) {
	base, err := safeBackupName(name)
	if err != nil {
		return nil, err
	}
	// Prevent restoring the currently active database file
	if base == filepath.Base(s.path) {
		return nil, fmt.Errorf("不能恢复当前正在使用的数据库文件")
	}
	backupDir := s.backupDir(destDir)
	backupPath := filepath.Join(backupDir, base)
	if err := validateRelayGuardDB(backupPath); err != nil {
		return nil, fmt.Errorf("备份校验失败：%w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(backupDir, 0700); err != nil {
		return nil, err
	}
	if s.db != nil {
		if err := s.db.execRaw("PRAGMA wal_checkpoint(TRUNCATE);"); err != nil {
			return nil, err
		}
	}
	preName := fmt.Sprintf("relayguard-pre-restore-%s.db", time.Now().Format("20060102-150405"))
	prePath := filepath.Join(backupDir, preName)
	if err := copyFileAtomic(s.path, prePath, 0600); err != nil {
		return nil, fmt.Errorf("创建恢复前备份失败：%w", err)
	}

	if s.db != nil {
		if err := s.db.close(); err != nil {
			return nil, err
		}
		s.db = nil
	}
	cleanupSidecar := func() {
		_ = os.Remove(s.path + "-wal")
		_ = os.Remove(s.path + "-shm")
	}
	cleanupSidecar()
	if err := copyFileAtomic(backupPath, s.path, 0600); err != nil {
		_ = copyFileAtomic(prePath, s.path, 0600)
		_ = s.reopenSQLiteLocked()
		return nil, fmt.Errorf("替换数据库失败，已尝试回滚：%w", err)
	}
	if err := s.reopenSQLiteLocked(); err != nil {
		if s.db != nil {
			_ = s.db.close()
			s.db = nil
		}
		rollbackErr := copyFileAtomic(prePath, s.path, 0600)
		cleanupSidecar()
		reopenErr := s.reopenSQLiteLocked()
		if rollbackErr != nil || reopenErr != nil {
			return nil, fmt.Errorf("恢复失败且回滚失败：恢复错误=%v，回滚错误=%v，重新打开错误=%v", err, rollbackErr, reopenErr)
		}
		return nil, fmt.Errorf("恢复失败，已回滚到恢复前备份：%w", err)
	}
	_ = s.insertAuditLocked(AuditLog{ID: common.RandomID("log"), UserID: userID, Action: "restore_backup", Target: base, IP: ip, Detail: "从备份恢复数据库；恢复前备份：" + preName, CreatedAt: time.Now()})
	return map[string]string{"restored": base, "pre_restore_backup": preName}, nil
}
