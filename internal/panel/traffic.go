package panel

import (
	"net/http"
	"strconv"
	"time"

	"github.com/idcsu/relayguard/internal/common"
)

type TrafficPoint struct {
	Time  string `json:"time"`
	Total uint64 `json:"total"`
	Delta uint64 `json:"delta"`
}

func (s *Store) ensureTrafficSnapshotSchemaLocked() error {
	if err := s.db.execRaw(`CREATE TABLE IF NOT EXISTS traffic_snapshots (
		bucket TEXT PRIMARY KEY,
		total_traffic INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	);`); err != nil {
		return err
	}
	if err := s.db.execRaw(`CREATE INDEX IF NOT EXISTS idx_traffic_snapshots_bucket ON traffic_snapshots(bucket);`); err != nil {
		return err
	}
	return nil
}

func (s *Store) StartTrafficSnapshotLoop() {
	_ = s.CaptureTrafficSnapshot()

	ticker := time.NewTicker(5 * time.Minute)
	for range ticker.C {
		_ = s.CaptureTrafficSnapshot()
	}
}

func (s *Store) CaptureTrafficSnapshot() error {
	now := time.Now().UTC()
	bucket := now.Truncate(5 * time.Minute).Format(time.RFC3339)

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.ensureTrafficSnapshotSchemaLocked(); err != nil {
		return err
	}

	rows, err := s.db.query(`SELECT COALESCE(SUM(traffic_used), 0) AS total FROM forward_rules`)
	if err != nil {
		return err
	}

	var total uint64
	if len(rows) > 0 {
		total, _ = strconv.ParseUint(rows[0]["total"], 10, 64)
	}

	if err := s.db.exec(`INSERT INTO traffic_snapshots(bucket,total_traffic,created_at)
		VALUES(?,?,?)
		ON CONFLICT(bucket) DO UPDATE SET total_traffic=excluded.total_traffic, created_at=excluded.created_at`,
		bucket, total, now.Format(time.RFC3339)); err != nil {
		return err
	}

	cutoff := now.Add(-45 * 24 * time.Hour).Format(time.RFC3339)
	_ = s.db.exec(`DELETE FROM traffic_snapshots WHERE bucket < ?`, cutoff)

	return nil
}

func (s *Store) TrafficTimeseries(rangeName string) ([]TrafficPoint, error) {
	if rangeName == "" {
		rangeName = "24h"
	}

	duration := 24 * time.Hour
	switch rangeName {
	case "24h":
		duration = 24 * time.Hour
	case "7d":
		duration = 7 * 24 * time.Hour
	case "30d":
		duration = 30 * 24 * time.Hour
	default:
		duration = 24 * time.Hour
	}

	if err := s.CaptureTrafficSnapshot(); err != nil {
		return nil, err
	}

	cutoff := time.Now().UTC().Add(-duration).Format(time.RFC3339)

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.ensureTrafficSnapshotSchemaLocked(); err != nil {
		return nil, err
	}

	rows, err := s.db.query(`SELECT bucket,total_traffic FROM traffic_snapshots WHERE bucket >= ? ORDER BY bucket ASC`, cutoff)
	if err != nil {
		return nil, err
	}

	items := make([]TrafficPoint, 0, len(rows))
	var prev uint64
	for i, row := range rows {
		total, _ := strconv.ParseUint(row["total_traffic"], 10, 64)
		delta := uint64(0)
		if i > 0 && total >= prev {
			delta = total - prev
		}
		items = append(items, TrafficPoint{
			Time:  row["bucket"],
			Total: total,
			Delta: delta,
		})
		prev = total
	}

	return items, nil
}

func (s *Server) handleTrafficTimeseries(w http.ResponseWriter, r *http.Request, _ common.User) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}

	rangeName := r.URL.Query().Get("range")
	if rangeName == "" {
		rangeName = "24h"
	}

	items, err := s.store.TrafficTimeseries(rangeName)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取流量趋势失败")
		return
	}

	writeJSON(w, map[string]any{
		"items": items,
		"range": rangeName,
	})
}
