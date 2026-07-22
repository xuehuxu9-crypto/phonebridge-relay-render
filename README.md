# PhoneBridge 生产中继

这套中继同时提供 iPhone 控制网页和华为端使用的 WebSocket 接口。它兼容现有 `0.1.1` APK，并增加了：

- WebSocket 心跳和失效连接清理；
- iPhone 端指数退避自动重连；
- 5 分钟内使用随机续连令牌恢复已批准会话；
- 慢连接背压保护，优先丢弃旧画面帧而不是拖垮进程；
- 配对尝试限流、请求超时和输入校验；
- 健康检查、Docker 自动重启和 Caddy 自动 HTTPS/WSS 证书。

## 服务器要求

- Ubuntu 24.04 LTS 或其他受支持 Linux；
- 2 核 CPU、2 GB 内存起步；
- 建议至少 20 Mbps 公网带宽和 500 GB/月流量；长时间控制建议 30 Mbps、2 TB/月以上；
- 一个固定域名，DNS `A` 记录指向服务器公网 IPv4；
- 防火墙开放 TCP 80、TCP 443；HTTP/3 可额外开放 UDP 443。

中国大陆设备优先选择中国香港地域，通常不需要中国大陆 ICP 备案。不要再使用会变更地址或定时过期的免费临时隧道。

## 部署

在服务器安装 Docker Engine 与 Compose 插件后：

```bash
sudo mkdir -p /opt/phonebridge
sudo chown "$USER":"$USER" /opt/phonebridge
cd /opt/phonebridge
# 将本目录全部文件上传到这里
cp .env.example .env
```

编辑 `.env`，把 `bridge.example.com` 改成真实域名，然后执行：

```bash
docker compose up -d --build
docker compose ps
curl -fsS "https://你的域名/health"
```

华为端填写：

```text
wss://你的域名/ws
```

iPhone Safari 打开：

```text
https://你的域名/
```

## 开机自启与恢复

Compose 中两个服务都使用 `restart: unless-stopped`。如需额外确保系统启动后拉起整套服务：

```bash
sudo cp deploy/phonebridge-watchdog.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now phonebridge-watchdog.service
```

建议使用外部监控每分钟访问 `/health`，连续失败时发送短信或推送告警。生产更新前先运行 `npm test`，更新使用：

```bash
docker compose build --pull
docker compose up -d
docker compose ps
```

## 已知边界

现有 `0.1.1` 华为 APK 在公网断线或服务器重启后不会自行连接，必须手动点“重新连接公网中继”。要消除这个缺口，需要安装带自动重连、固定域名保存和华为电池保护引导的新版 APK。Android/HarmonyOS 在重启手机或系统撤销屏幕录制授权后，仍会要求机主重新确认；系统安全限制不能被服务器绕过。
