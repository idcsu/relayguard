package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/idcsu/relayguard/internal/common"
	"github.com/idcsu/relayguard/internal/panel"
)

func main() {
	addr := flag.String("addr", env("RELAYGUARD_ADDR", ":10026"), "监听地址，例如 :10026")
	dataDir := flag.String("data", env("RELAYGUARD_DATA", "./data"), "数据目录")
	adminUser := flag.String("admin-user", env("ADMIN_USER", "admin"), "初始化管理员用户名")
	adminPassword := flag.String("admin-password", env("ADMIN_PASSWORD", ""), "初始化管理员密码，留空则随机生成")
	resetAdmin := flag.Bool("reset-admin-password", false, "重置管理员密码后退出，需同时提供 -admin-password")
	version := flag.Bool("version", false, "显示版本")
	flag.Parse()

	if *version {
		fmt.Println(common.ProjectName, common.Version)
		return
	}

	storePath := filepath.Join(*dataDir, "relayguard.db")
	st, initialPassword, err := panel.OpenStore(storePath, *adminUser, *adminPassword)
	if err != nil {
		log.Fatalf("打开数据失败：%v", err)
	}
	if *resetAdmin {
		if *adminPassword == "" {
			log.Fatalf("重置管理员密码需要提供 -admin-password 或 ADMIN_PASSWORD")
		}
		if err := st.ResetAdminPassword(*adminUser, *adminPassword); err != nil {
			log.Fatalf("重置管理员密码失败：%v", err)
		}
		log.Printf("管理员 %s 的密码已重置，所有会话已失效。", *adminUser)
		return
	}

	if initialPassword != "" {
		log.Printf("============================================================")
		log.Printf("RelayGuard 初始管理员账号：%s", *adminUser)
		log.Printf("RelayGuard 初始管理员密码：%s", initialPassword)
		log.Printf("请立即登录面板并修改密码，密码只在首次初始化时显示。")
		log.Printf("============================================================")
	}

	srv := panel.NewServer(st, *addr)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		srv.Stop()
	}()

	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("面板启动失败：%v", err)
	}
	log.Printf("面板已关闭")
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}