# Hills 自架部署（M0）

> 版本：v0.3 · 2026-11-06 · 對應 [technical-design.md](./technical-design.md) §10、§16.9
> M0 部署 **relay**（iroh-relay，NAT 穿透與中繼）與 **mailbox**（離線信箱、roster 分發、邀請、封裝金鑰、位址簿）。tsa、storage 隨 M1 加入。

伺服器只看得到加密後的資料與技術中繼資料（technical-design §5.2、§16.7），看不到訊息或文件內容。

## 1. 準備

| 項目 | 需求 |
|------|------|
| 主機 | 1 vCPU、1 GB RAM、10 GB 磁碟起；Linux（Debian / Ubuntu 皆可）；有固定公網 IPv4 |
| 軟體 | Docker Engine 24 以上、Docker Compose v2 |
| 網域 | 一個子網域給 relay，例如 `relay.example.com`，DNS **A 記錄**指向主機公網 IP |
| 防火牆 | TCP 80、TCP 443、UDP 7842（relay）、UDP 7843（mailbox，可用 `HILLS_UDP_PORT` 修改） |

TCP 80 用於 LetsEncrypt 自動取得憑證，需要保持開放。

## 2. 安裝

```bash
git clone https://github.com/CAFECA-IO/hills.cafeca.io.git
cd hills.cafeca.io/deploy

cp .env.example .env               # 填入 HILLS_RELAY_HOST、HILLS_RELAY_CONTACT、HILLS_PUBLIC_IP

docker compose up -d --build       # 第一次建置約 10–20 分鐘
docker compose ps                  # relay 與 mailbox 皆為 running / healthy
curl -s http://127.0.0.1:18080/v1/health   # mailbox 健康檢查（埠為 HILLS_HEALTH_PORT）
```

`.env` 已列入 `.gitignore`，不要提交。

relay 的設定檔由容器啟動時依 `.env` 產生（LetsEncrypt、TCP 80 / 443、UDP 7842），compose 不掛載任何主機檔案，因此在開發容器、遠端 Docker context 等「docker 指令與 Docker daemon 不在同一個檔案系統」的環境也能使用。需要進階設定時，可另以 named volume 提供 `/config/relay.toml`，存在時優先使用（格式見 `relay.toml.example`）。

## 3. 取得 mailbox 連線碼

```bash
docker compose logs mailbox | grep 連線碼
# 或
docker compose exec mailbox cat /data/mailbox-code.txt
```

連線碼以 `hills-mbx1-` 開頭，只含 mailbox 的位址（NodeId、relay URL、公網 IP 與埠），**不是機密**。

要讓自己組織建置的桌機 app 預先填入此連線碼，在建置環境設定 `VITE_HILLS_DEFAULT_MAILBOX`（例如寫入 `apps/desktop/.env.local`，已列入 `.gitignore`；或設為 CI secret）。不要提交到 repo（D20）。

## 4. 建立組織（立即執行）

1. 在第一台電腦安裝 Hills 桌機 app，選「建立組織」。
2. 貼上 mailbox 連線碼，填寫組織名稱與姓名。
3. 抄寫復原詞並驗證，接著**匯出組織根金鑰備份**（設定密碼，備份檔離線保存）。

未設定 `HILLS_ORG_ROOT_PUB` 時，mailbox 處於「未綁定」狀態：**第一位以組織根金鑰簽發之管理者憑證連線者即完成綁定**，之後不可更換（technical-design §16.9）。因此部署完成後應立即建立組織。

若要事先固定組織，可在 `.env` 設定 `HILLS_ORG_ROOT_PUB`（64 位 hex）後重新啟動。

## 5. 邀請成員與綁定裝置

- 管理者：「設定 → 成員 → 產生邀請碼」，把邀請碼或 QR Code 交給新成員；新成員選「以邀請碼加入」。加入申請由建立邀請的管理者裝置上線時自動處理。
- 同一人的第二台電腦：在新電腦選「綁定既有帳號的新裝置」，貼上既有電腦「設定 → 組織」的組織連線碼，再把新電腦顯示的綁定碼貼到既有電腦「設定 → 個人 → 綁定新裝置」，兩邊比對 6 位數字一致後按「一致」。
- 所有裝置都遺失：選「以復原詞還原」，輸入 24 字與組織連線碼（請其他成員從「設定 → 組織」複製給你）。

## 6. M0 驗收（Mac + Windows 跨網路）

1. Mac 與 Windows 分別接在**不同網路**（例如公司 Wi-Fi 與手機熱點）。
2. Mac 建立組織，Windows 以邀請碼加入，確認雙方「團隊」頁看到彼此。
3. 任一方修改狀態文字，另一方 2 秒內更新；管理者修改組織名稱，另一方同步。
4. 關閉 Windows app，Mac 修改組織名稱；重新開啟 Windows，確認補同步。
5. 結果記錄到 [poc-report.md](./poc-report.md) §5。

## 7. 備份

| 資料 | 位置 | 說明 |
|------|------|------|
| mailbox | volume `mailbox-data`（`/data`） | `index.sqlite`、`blobs/`、`node.key`（mailbox 身分，遺失後連線碼會改變） |
| relay | volume `relay-data`（`/data/certs`） | LetsEncrypt 憑證，遺失時會自動重新申請 |

```bash
docker compose stop mailbox
docker run --rm -v deploy_mailbox-data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/mailbox-$(date +%F).tgz -C /data .
docker compose start mailbox
```

mailbox 內的資料都已端對端加密；遺失時成員的本機資料仍完整，重新部署後由成員裝置重新上傳即可補回（連線碼改變時需重新設定，M1 提供更換 mailbox 的流程）。

## 8. 升級

```bash
git pull
docker compose up -d --build
```

## 9. 疑難排解

| 狀況 | 檢查 |
|------|------|
| relay 日誌 `Error: config-path must be a file`（v0.2 以前的部署方式） | docker 指令所在環境與 Docker daemon 不同（例如在開發容器內操作），主機上看不到 `relay.toml`，Docker 自動建立了空資料夾。更新到最新版後不再需要 `relay.toml`，`docker compose down` 後重新 `up -d --build` |
| app 一直顯示「離線」 | 防火牆 UDP 7843 是否開放；`.env` 的 `HILLS_PUBLIC_IP` 是否正確；`docker compose logs mailbox` |
| relay 無法取得憑證 | DNS 是否已生效（`dig relay.example.com`）；TCP 80 是否開放 |
| mailbox 連線碼不含 relay（只能經 mailbox 輪詢同步） | relay 未正常啟動或憑證未取得；先修好 relay（`docker compose logs relay`），再 `docker compose restart mailbox` 取得新連線碼 |
| 建立組織後一直「離線」，mailbox 日誌出現拒絕連線 | mailbox 已被其他組織綁定，或 `HILLS_ORG_ROOT_PUB` 與你的組織不同；重新部署時需清除 `mailbox-data` volume |
| 啟動時 `Bind for …:8080 failed: port is already allocated` 之類的埠衝突 | 主機上已有服務占用該埠；在 `.env` 修改 `HILLS_HEALTH_PORT`（健康檢查，預設 18080）或 `HILLS_UDP_PORT` |
| 加入後一直「等待核准」 | 建立該邀請的管理者裝置需上線一次 |
