# Hills 自架部署（M0）

> 版本：v0.6 · 2026-11-08 · 對應 [technical-design.md](./technical-design.md) §10、§15.6–15.7、§16.9、§17
> 部署 **relay**（iroh-relay，NAT 穿透與中繼）、**mailbox**（離線信箱、roster 分發、加入申請、封裝金鑰、位址簿）與 M1 的 **storage-0…7**（檔案分片，D39）。tsa 隨假勤功能加入。

伺服器只看得到加密後的資料與技術中繼資料（technical-design §5.2、§16.7），看不到訊息或文件內容。

## 1. 準備

| 項目 | 需求 |
|------|------|
| 主機 | 1 vCPU、1 GB RAM、10 GB 磁碟起；Linux（Debian / Ubuntu 皆可）；有固定公網 IPv4 |
| 軟體 | Docker Engine 24 以上、Docker Compose v2 |
| 網域 | 一個子網域給 relay，例如 `relay.example.com`，DNS **A 記錄**指向主機公網 IP |
| 防火牆 | TCP 80、TCP 443、UDP 7842（relay）、UDP 7843（mailbox，可用 `HILLS_UDP_PORT` 修改）、UDP 7850–7857（storage-0…7，可用 `HILLS_STORAGE_PORT_0` … `HILLS_STORAGE_PORT_7` 個別修改） |
| 磁碟 | 檔案分享：每 1 GB 檔案約占 1.6 GB（RS 8/5）；建議把 8 個 storage volume 分散在不同磁碟（technical-design §15.7） |

TCP 80 用於 LetsEncrypt 自動取得憑證，需要保持開放。

## 2. 安裝

```bash
git clone https://github.com/CAFECA-IO/hills.cafeca.io.git
cd hills.cafeca.io/deploy

cp .env.example .env               # 填入 HILLS_RELAY_HOST、HILLS_RELAY_CONTACT、HILLS_PUBLIC_IP、HILLS_CAFECA_WALLET

docker compose up -d --build       # 第一次建置約 10–20 分鐘
docker compose ps                  # relay 與 mailbox 皆為 running / healthy
curl -s http://127.0.0.1:18080/v1/health   # mailbox 健康檢查（埠為 HILLS_HEALTH_PORT）
```

`.env` 已列入 `.gitignore`，不要提交。

**CAFECA 登入**（D41，technical-design §17）：

| 變數 | 必填 | 說明 |
|------|:---:|------|
| `HILLS_CAFECA_WALLET` | ✓ | CAFECA 錢包網址（例如 `https://<錢包網域>`，不含結尾 `/`）。桌機 app 由 mailbox 取得，用來產生登入連結；mailbox 也用它讀取 `/.well-known/cafeca-configuration` 與查詢代稱 |
| `HILLS_CAFECA_RPC` |  | 改用自架的鏈上 RPC（預設使用錢包設定檔中的 `rpcUrl`） |

mailbox 需能以 HTTPS 連出到錢包網域與 RPC；錢包需已支援原生 App 模式（`mode: "relay"`）。

relay 的設定檔由容器啟動時依 `.env` 產生（LetsEncrypt、TCP 80 / 443、UDP 7842），compose 不掛載任何主機檔案，因此在開發容器、遠端 Docker context 等「docker 指令與 Docker daemon 不在同一個檔案系統」的環境也能使用。需要進階設定時，可另以 named volume 提供 `/config/relay.toml`，存在時優先使用（格式見 `relay.toml.example`）。

### 儲存節點（M1 檔案分享）

`docker compose up -d --build` 會一併啟動 `storage-0` … `storage-7`。每個節點啟動時把自己的連線碼寫進共用的 `storage-codes` volume，mailbox 從那裡回應 app 的 `Services` 請求，**不需要手動設定**。確認方式：

```bash
docker compose logs storage-0 | grep 連線碼
docker compose exec mailbox ls /storage-codes      # 應有 storage-0.txt … storage-7.txt
```

建立組織後，管理者的 app 上線一次即會把成員名冊推送到每個節點；之後所有成員都能上傳與下載附件。

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
3. **以 CAFECA 登入**（手機掃 QR，或在這台電腦開啟 CAFECA），確認兩邊確認碼一致後簽署。
4. **匯出組織根金鑰備份**（設定密碼，備份檔離線保存）。

未設定 `HILLS_ORG_ROOT_PUB` 時，mailbox 處於「未綁定」狀態：**第一位以組織根金鑰簽發之管理者憑證連線者即完成綁定**，之後不可更換（technical-design §16.9）。因此部署完成後應立即建立組織。

若要事先固定組織，可在 `.env` 設定 `HILLS_ORG_ROOT_PUB`（64 位 hex）後重新啟動。

## 5. 加入成員與新增裝置（D41）

- **新成員**：任一成員從「設定 → 組織」複製組織連線碼給新成員；新成員選「加入組織」，貼上連線碼並以 CAFECA 登入。管理者在「設定 → 成員與小組 → 待核准」選擇角色與小組後核准。
- **同一人的新電腦**：在新電腦選「加入組織」、貼上組織連線碼並以 CAFECA 登入；本人其他已開啟 Hills 的電腦會自動完成授權，並跳出「新裝置已加入」通知。
- **所有裝置都遺失**：在新電腦「加入組織」並以 CAFECA 登入，選「我沒有其他裝置了」送出還原申請，由管理者核准；只有本人可讀的私人資料無法還原。

## 6. M0 驗收（Mac + Windows 跨網路）

1. Mac 與 Windows 分別接在**不同網路**（例如公司 Wi-Fi 與手機熱點）。
2. Mac 建立組織，Windows 以組織連線碼 + CAFECA 登入申請加入、Mac 核准，確認雙方「團隊」頁看到彼此。
3. 任一方修改狀態文字，另一方 2 秒內更新；管理者修改組織名稱，另一方同步。
4. 關閉 Windows app，Mac 修改組織名稱；重新開啟 Windows，確認補同步。
5. 結果記錄到 [poc-report.md](./poc-report.md) §5。

## 7. 備份

| 資料 | 位置 | 說明 |
|------|------|------|
| mailbox | volume `mailbox-data`（`/data`） | `index.sqlite`、`blobs/`、`node.key`（mailbox 身分，遺失後連線碼會改變） |
| relay | volume `relay-data`（`/data/certs`） | LetsEncrypt 憑證，遺失時會自動重新申請 |
| storage-0…7 | volume `storage-0-data` … `storage-7-data` | 檔案分片（密文）與 `node.key`；任 3 個遺失時檔案仍可下載，遺失的分片需由寄件者重新分享（修復流程 M2） |
| storage-codes | volume `storage-codes` | 各節點的連線碼，由節點啟動時重新寫入，不需備份 |

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

### 重置（v0.6：改用 CAFECA 登入，資料格式不相容）

以 CAFECA 登入的版本（technical-design §17.9）與先前版本的資料不相容，M1 試用前直接重置：

```bash
git pull
# 在 .env 加上 HILLS_CAFECA_WALLET（必要時 HILLS_CAFECA_RPC）
docker compose down
docker volume rm deploy_mailbox-data deploy_storage-0-data deploy_storage-1-data deploy_storage-2-data \
  deploy_storage-3-data deploy_storage-4-data deploy_storage-5-data deploy_storage-6-data deploy_storage-7-data
docker compose up -d --build
docker compose logs mailbox | grep hills-mbx1-    # mailbox 身分重新產生，連線碼會改變
```

- volume 名稱前綴依 compose 專案名稱而定（預設為目錄名 `deploy`），可先以 `docker volume ls` 確認。
- 若 `.env` 設定了 `HILLS_ORG_ROOT_PUB`，重置前先刪除該行（新組織的根金鑰不同）。
- 桌機 app 更新後啟動時會提示清除舊資料，之後依 §4 重新建立組織、§5 加入成員。

## 9. 疑難排解

| 狀況 | 檢查 |
|------|------|
| relay 日誌 `Error: config-path must be a file`（v0.2 以前的部署方式） | docker 指令所在環境與 Docker daemon 不同（例如在開發容器內操作），主機上看不到 `relay.toml`，Docker 自動建立了空資料夾。更新到最新版後不再需要 `relay.toml`，`docker compose down` 後重新 `up -d --build` |
| app 一直顯示「離線」 | 防火牆 UDP 7843 是否開放；`.env` 的 `HILLS_PUBLIC_IP` 是否正確；`docker compose logs mailbox` |
| relay 無法取得憑證 | DNS 是否已生效（`dig relay.example.com`）；TCP 80 是否開放 |
| mailbox 連線碼不含 relay（只能經 mailbox 輪詢同步） | relay 未正常啟動或憑證未取得；先修好 relay（`docker compose logs relay`），再 `docker compose restart mailbox` 取得新連線碼 |
| 「以 CAFECA 登入」一直等待或顯示驗證失敗 | mailbox `.env` 的 `HILLS_CAFECA_WALLET` 是否正確、主機能否連到錢包與 RPC（`docker compose logs mailbox` 會記錄 CAFECA 設定讀取結果，不含帳戶資料）；錢包是否已支援原生 App 模式；電腦時間是否正確 |
| 建立組織後一直「離線」，mailbox 日誌出現拒絕連線 | mailbox 已被其他組織綁定，或 `HILLS_ORG_ROOT_PUB` 與你的組織不同；重新部署時需清除 `mailbox-data` volume |
| 啟動時 `Bind for …:8080 failed: port is already allocated` 之類的埠衝突 | 主機上已有服務占用該埠；在 `.env` 修改 `HILLS_HEALTH_PORT`（健康檢查，預設 18080）或 `HILLS_UDP_PORT` |
| 加入後一直「等待核准」 | 管理者需開啟 Hills，在「設定 → 成員與小組 → 待核准」核准；新電腦則需本人另一台已登入的電腦開啟 Hills |
| 附件一直「上傳中」或顯示「沒有可用的儲存節點」 | `docker compose ps` 確認 storage-0…7 都在執行；防火牆 UDP 7850–7857；`docker compose logs storage-0`；mailbox 需能讀到 `storage-codes` volume（`docker compose exec mailbox ls /storage-codes`） |
| 附件顯示「檔案目前無法下載」 | 可用的 storage 節點少於 5 個；啟動停止的節點後重試 |
