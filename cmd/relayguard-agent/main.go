package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/idcsu/relayguard/internal/agent"
	"github.com/idcsu/relayguard/internal/common"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "firewall" {
		if err := agent.FirewallCLI(os.Args[2:]); err != nil {
			log.Fatalf("防火墙命令失败：%v", err)
		}
		return
	}

	panelURL := flag.String("panel", env("RELAYGUARD_PANEL", ""), "面板地址，例如 https://panel.example.com")
	token := flag.String("token", env("RELAYGUARD_TOKEN", ""), "节点注册 Token")
	dataDir := flag.String("data", env("RELAYGUARD_AGENT_DATA", "./agent-data"), "Agent 数据目录")
	name := flag.String("name", env("RELAYGUARD_NODE_NAME", ""), "节点名称")
	sshPortsRaw := flag.String("ssh-ports", env("RELAYGUARD_SSH_PORTS", ""), "严格防火墙模式下保留的 SSH 端口，多个用逗号分隔，例如 22,2222")
	extraTCPRaw := flag.String("allow-tcp", env("RELAYGUARD_ALLOW_TCP", ""), "严格防火墙模式下额外保留的 TCP 端口，多个用逗号分隔")
	extraUDPRaw := flag.String("allow-udp", env("RELAYGUARD_ALLOW_UDP", ""), "严格防火墙模式下额外保留的 UDP 端口，多个用逗号分隔")
	version := flag.Bool("version", false, "显示版本")
	flag.Parse()
	if *version {
		fmt.Println(common.ProjectName, "agent", common.Version)
		return
	}

	cfg, err := agent.LoadConfig(*dataDir)
	if err != nil {
		cfg = agent.Config{DataDir: *dataDir}
	}
	if *panelURL != "" {
		cfg.PanelURL = *panelURL
	}
	if *token != "" {
		cfg.Token = *token
	}
	if *name != "" {
		cfg.Name = *name
	}
	if ports := parsePorts(*sshPortsRaw); len(ports) > 0 {
		cfg.SSHPorts = ports
	}
	if ports := parsePorts(*extraTCPRaw); len(ports) > 0 {
		cfg.ExtraAllowTCP = ports
	}
	if ports := parsePorts(*extraUDPRaw); len(ports) > 0 {
		cfg.ExtraAllowUDP = ports
	}
	if len(cfg.SSHPorts) == 0 {
		cfg.SSHPorts = []int{22}
	}
	cfg.FirewallICMP = true
	cfg.DataDir = *dataDir

	a := agent.New(cfg)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		a.Stop()
	}()

	if err := a.Run(); err != nil {
		log.Fatalf("Agent 启动失败：%v", err)
	}
	log.Printf("Agent 已关闭")
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func parsePorts(raw string) []int {
	var out []int
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		p, err := strconv.Atoi(part)
		if err == nil && p >= 1 && p <= 65535 {
			out = append(out, p)
		}
	}
	return out
}