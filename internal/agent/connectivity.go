package agent

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/idcsu/relayguard/internal/common"
)

func RunConnectivityTest(req common.ConnectivityTestRequest) common.ConnectivityTestResult {
	started := time.Now()
	result := common.ConnectivityTestResult{
		ID:         req.ID,
		RuleID:     req.RuleID,
		NodeID:     req.NodeID,
		Protocol:   req.Protocol,
		ListenPort: req.ListenPort,
		TargetHost: req.TargetHost,
		TargetPort: req.TargetPort,
		Status:     "running",
		CreatedAt:  req.CreatedAt,
		StartedAt:  &started,
	}
	var details []string
	var errs []string

	if req.Protocol == "tcp" || req.Protocol == "both" {
		if err := tcpDial("127.0.0.1", req.ListenPort, 3*time.Second); err != nil {
			errs = append(errs, "节点本地 TCP 监听检测失败："+err.Error())
			details = append(details, "节点本地 TCP 监听：失败")
		} else {
			result.LocalListenOK = true
			details = append(details, "节点本地 TCP 监听：正常")
		}
		if err := tcpDial(req.TargetHost, req.TargetPort, 5*time.Second); err != nil {
			errs = append(errs, "目标 TCP 连接失败："+err.Error())
			details = append(details, "目标 TCP 连接：失败")
		} else {
			result.TargetTCPOK = true
			details = append(details, "目标 TCP 连接：正常")
		}
	}

	if req.Protocol == "udp" || req.Protocol == "both" {
		if err := udpSend("127.0.0.1", req.ListenPort, 2*time.Second); err != nil {
			errs = append(errs, "节点本地 UDP 探测失败："+err.Error())
			details = append(details, "节点本地 UDP 探测：失败")
		} else if req.Protocol == "udp" {
			result.LocalListenOK = true
			details = append(details, "节点本地 UDP 探测：已发送探测包")
		} else {
			details = append(details, "节点本地 UDP 探测：已发送探测包")
		}
		if err := udpSend(req.TargetHost, req.TargetPort, 3*time.Second); err != nil {
			errs = append(errs, "目标 UDP 探测失败："+err.Error())
			details = append(details, "目标 UDP 探测：失败")
		} else {
			result.TargetUDPOK = true
			details = append(details, "目标 UDP 探测：已发送探测包（UDP 无法保证对端业务响应）")
		}
	}

	if ok, ms, err := pingHost(req.TargetHost, 3*time.Second); err == nil && ok {
		result.PingOK = true
		result.PingLatencyMS = ms
		details = append(details, fmt.Sprintf("Ping：正常（约 %d ms）", ms))
	} else if err != nil {
		details = append(details, "Ping：不可用或失败（"+err.Error()+"）")
	} else {
		details = append(details, "Ping：失败")
	}

	finished := time.Now()
	result.FinishedAt = &finished
	result.Details = details
	if len(errs) > 0 {
		result.Status = "failed"
		result.Error = strings.Join(errs, "；")
	} else {
		result.Status = "success"
	}
	return result
}

func tcpDial(host string, port int, timeout time.Duration) error {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), timeout)
	if err != nil {
		return err
	}
	return conn.Close()
}

func udpSend(host string, port int, timeout time.Duration) error {
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return err
	}
	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	_, err = conn.Write([]byte{0})
	return err
}

func pingHost(host string, timeout time.Duration) (bool, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "ping", "-n", "1", "-w", "2000", host)
	} else {
		cmd = exec.CommandContext(ctx, "ping", "-c", "1", "-W", "2", host)
	}
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return false, 0, ctx.Err()
	}
	text := string(out)
	ms := parsePingMS(text)
	if err != nil {
		return false, ms, err
	}
	return true, ms, nil
}

func parsePingMS(text string) int {
	re := regexp.MustCompile(`time[=<]([0-9.]+)\s*ms`)
	m := re.FindStringSubmatch(text)
	if len(m) < 2 {
		return 0
	}
	f, _ := strconv.ParseFloat(m[1], 64)
	return int(f + 0.5)
}
