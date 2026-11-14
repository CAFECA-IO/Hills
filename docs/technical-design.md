# Hills 技術設計文件

> 版本：v0.36 草案 · 2026-11-14 · 對應功能規劃 [feature-plan.md](./feature-plan.md) v1.0；M2–M5 見 [technical-design-m2-m5.md](./technical-design-m2-m5.md)
> 範圍：M0（基礎）與 M1（計劃、Scrum、假勤、對話、檔案分享）所需的協定、資料模型與金鑰流程。M1 對話見 §14，檔案分享（SwarmStorage 原理）見 §15，以 CAFECA 登入見 §17。

## 1. 元件總覽

```
┌──────────────────────── Hills 桌機客戶端（Tauri 2）─────────────────────────┐
│ React + TS UI  ◄── Tauri commands / events ──►  Rust 核心                  │
│                                  ├ hills-identity  身分、金鑰、憑證          │
│                                  ├ hills-crypto    小組金鑰、加密封包        │
│                                  ├ hills-store     Automerge 文件庫 + SQLite 投影 │
│                                  ├ hills-sync      文件同步、驗證層          │
│                                  ├ hills-net       iroh endpoint、ALPN、gossip │
│                                  ├ hills-domain    假勤 / 計劃 / Scrum 規則  │
│                                  └ hills-node      app 核心：組合以上元件（§16）│
└────────────────────────────────────────────────────────────────────────────┘
            │  iroh（QUIC + TLS 1.3，端對端加密；直連優先，失敗走 relay）
            ▼
┌──────────────────────── 自架服務（Docker Compose）──────────────────────────┐
│ iroh-relay      打洞協調與中繼（只看得到密文）                               │
│ hills-mailbox   常駐節點：保存加密 change bundle，供離線成員補同步            │
│ hills-tsa       可信時間戳：對打卡雜湊簽發時間憑證                           │
│ hills-storage×8 檔案分片儲存節點（SwarmStorage 原理，§15）                    │
│ （D39：不使用 caddy；儲存節點以 iroh 連線，§15.6）                          │
└────────────────────────────────────────────────────────────────────────────┘
```

Monorepo 結構：

```
crates/
  hills-proto/     # 共用訊息型別（serde + postcard），帶版本號
  hills-identity/  hills-crypto/  hills-store/
  hills-sync/      hills-net/     hills-domain/
  hills-node/      # app 核心：組織生命週期、同步引擎（§16）
apps/
  desktop/         # Tauri 2 app（src-tauri + React 前端）
  mailbox/         # hills-mailbox 服務
  tsa/             # hills-tsa 服務
  storage/         # hills-storage 分片節點（§15.6）
packages/
  swarm/           # SwarmStorage 前端管線（TypeScript）：RS(8,5)、逐條帶加密、manifest（§15）
poc/
  net-echo/        # iroh 連線 PoC 工具（§12），PoC 後保留作為網路診斷工具
  automerge-sync/  # Automerge 離線合併 PoC（§12），PoC 後保留作為回歸測試
deploy/
  docker-compose.yml  .env.example
  poc/             # PoC 用的 iroh-relay 部署片段
```

工具鏈：Rust stable（`rust-toolchain.toml`）、**Node.js ≥ 24.22.1**（v0.30：CVE-2026-111497 Brotli 解碼漏洞於 24.22.1 修正；`package.json` engines + `.npmrc` engine-strict 強制，CI 使用 Node 24 最新版）、pnpm 10；Tauri 使用 2.x 穩定版。

## 2. 密碼學基礎

| 用途 | 演算法 | 函式庫（建議） |
|------|--------|---------------|
| 簽章 | Ed25519 | `ed25519-dalek` |
| 金鑰協商 | X25519 | `x25519-dalek` |
| 對稱加密 | XChaCha20-Poly1305 | `chacha20poly1305` |
| 金鑰推導 | HKDF-SHA256 | `hkdf` |
| 封裝（wrap） | HPKE（X25519 / HKDF-SHA256 / ChaCha20Poly1305） | `hpke` |
| 雜湊 / ID | BLAKE3 | `blake3` |
| 安全儲存 | macOS Keychain / Windows Credential Manager / Linux Secret Service | `keyring` |
| 密碼金鑰推導 | Argon2id（組織根金鑰備份檔） | `argon2` |
| CAFECA 登入：EIP-712 結構雜湊、keccak256 | EIP-712 / keccak256（僅計算要驗證的雜湊，簽章由鏈上合約驗證） | `alloy-sol-types`、`alloy-primitives` |
| CAFECA 登入：中繼回應解密 | ECDH P-256 → HKDF-SHA256 → AES-256-GCM（依 CAFECA 中繼信箱格式） | `p256`、`hkdf`、`aes-gcm` |
| CAFECA 登入：鏈上查詢 | JSON-RPC `eth_call`（HTTPS） | `reqwest` |

原則：不自行設計密碼學原語；CAFECA 相關演算法只用於 §17 的登入協定，不用於 Hills 自身資料加密；所有訊息格式帶版本號 `v`，以便日後升級（例如 M2 群組聊天改用 OpenMLS）。

**簽章輸入格式**（所有 Ed25519 簽章一致）：

```
sig = Sign(key, "hills/v1/" ‖ type ‖ 0x00 ‖ postcard(body))
type ∈ { device-cert, member-cert, revocation, change, roster, … }
```

`type` 做 domain separation，避免一種簽章被拿去冒充另一種；`body` 以 postcard 序列化，欄位順序即定義順序，因此序列化結果唯一。

## 3. 身分與金鑰

### 3.1 金鑰階層

> v0.13（D41）：成員身分改由 CAFECA 帳戶決定，不再有復原詞；協定細節見 §17。

```
CAFECA 帳戶（chainId + 身分合約地址 account，由使用者的 Passkey / CAFECA 卡控制）
成員 ID = blake3("hills/v1/member" ‖ chainId(u64 BE) ‖ account(20B)) 前 16 bytes（base32 顯示）

成員身分金鑰 IK（Ed25519，簽章）、成員協商金鑰 EK（X25519，接收封裝的金鑰）
  └─ 成員第一台裝置隨機產生；之後由本人其他裝置封裝傳給新裝置（§17.6）

裝置金鑰 DK（Ed25519，每台裝置隨機產生；同時作為 iroh NodeId）
裝置憑證 DeviceCert = Sign_IK(memberId, DK.pub, deviceName, issuedAt)

組織根金鑰 OK（Ed25519，建立者產生；組織 ID = blake3(OK.pub)）
成員憑證 MemberCert = Sign_admin(memberId, IK.pub, EK.pub, roles, cafeca{chainId, account}, issuedAt)
```

- 成員 ID 只由 CAFECA 帳戶決定，因此成員還原（換 IK / EK）後 ID 不變，計劃、任務、對話中的成員參照都不受影響。
- IK / EK 私鑰存於每台已綁定裝置的系統安全儲存區；遺失全部裝置時無法取回，改走還原流程換發新金鑰（§17.7）。
- DK 為每台裝置隨機產生的 Ed25519 金鑰，同時作為 iroh `SecretKey` / NodeId；私鑰永不離開裝置。
- `DeviceCert` 保留 `expiresAt?` 欄位（M1 不設期限）。
- OK 只用來簽發第一張管理者憑證，之後的管理操作由任一管理者 IK 簽章。OK 是信任根與災難復原用途，建立後以密碼加密匯出離線備份。
- **v0.34（D62）**：新增成員對稱金鑰 `WK_member`（工作紀錄金鑰），封裝給本人與本人所屬各小組的負責人，**不給管理者**；由本人的裝置產生、交接與輪替（§16.18）。

### 3.2 信任鏈驗證

收到任何簽章資料時依序檢查：

1. `DeviceCert` 由該成員**目前有效**的 IK 簽發，且裝置未被撤銷。
2. 該成員的 `MemberCert` 由有效管理者簽發，且成員未被停用；`memberId` 必須等於由 `cafeca` 欄位推導的值。同一 `memberId` 有多張憑證時，以 `issuedAt` 最新者為準（還原會換發新憑證），由舊 IK 簽發的 DeviceCert 隨之失效。被取代的管理者 IK 只接受時間（憑證 `issuedAt`、撤銷 `at`）早於取代時間的簽章，讓還原前簽發的成員憑證仍可驗證；roster 因此保留每位成員的全部憑證。
3. 管理者有效性可追溯至 OK 簽發的第一張管理者憑證。
4. 此操作在該成員的角色權限內（§5.3）。

### 3.3 建立組織（Genesis）

1. 建立者貼上 mailbox 連線碼，產生 OK、IK、EK、DK，以 CAFECA 登入（§17.5，kind = `create`）。
2. 建立 `org` 文件：組織設定、由 OK 簽署的第一張管理者 `MemberCert`（含 CAFECA 帳戶）。
3. 引導建立者以密碼加密匯出 OK 備份檔。

### 3.4 加入組織

> v0.13（D41）：取代邀請碼。流程見 §17.6。

新成員取得組織連線碼（任何成員可在設定中匯出），以 CAFECA 登入後送出加入申請；mailbox 驗證登入證明後暫存，任一管理者核准（指定角色與小組）時簽發 MemberCert 並封裝金鑰，拒絕則刪除申請。

### 3.5 新裝置綁定

> v0.13（D41）：取代掃碼與 6 位數 SAS。流程見 §17.6。

新裝置以 CAFECA 登入，登入證明綁定新裝置的 DK 與一把臨時 X25519 公鑰；本人任一在線裝置驗證後，以 HPKE 把 IK / EK 封裝給該臨時公鑰並簽發 DeviceCert。本人其他裝置收到「新裝置已加入」通知，可立即撤銷。

### 3.6 成員還原（遺失所有裝置）

> v0.13（D41）：取代復原詞。流程見 §17.7。

1. 新裝置產生新的 IK / EK / DK，以 CAFECA 登入送出還原申請。
2. 管理者核准後簽發新的 `MemberCert`（同一 memberId、新金鑰、沿用原角色），舊裝置的 DeviceCert 隨即失效。
3. 管理者與對話建立者把該成員有權取得的金鑰（含歷史 epoch）重新封裝給新 EK。
4. 只封裝給舊 EK 的私人金鑰（`PK_member`）無法還原，介面需明示。

### 3.7 停用成員與金鑰輪替

1. 管理者寫入 `Sign_admin(Revocation{memberId, reason, at})`。
2. 該成員能取得的每把金鑰（GK、所屬小組 TK、相關 AK）進行 **epoch 輪替**：管理者裝置產生新金鑰，以 HPKE 封裝給剩餘的合法持有者，寫入 `keys` 紀錄。v0.25（D49）：管理者不持有的小組 TK 改由該小組的指定輪替裝置輪替（§16.15）。
3. 新資料一律使用新 epoch；被停用者已同步的歷史資料無法撤回，UI 需明示。
4. 停用者的計劃、報表文件保留，小組負責人可讀以利交接。

## 4. 資料加密與同步

### 4.1 文件切分

業務資料存為 Automerge 文件，並依「誰可以寫」切分，讓權限檢查簡單可靠：

| 文件 | 寫入者 | 讀取者 | 金鑰 | 內容 |
|------|--------|--------|------|------|
| `org` | 管理者 | 全員 | `GK` | 設定、品牌、成員憑證與 CAFECA 帳戶、小組、假日曆、假別、工作規則、核准規則、公司目標（v0.20，D47）、公司目的 `purpose`（v0.35，D65）、`mcp.allowed`（v0.23，D48，§18） |
| `team/<teamId>` | 小組成員 | 小組成員 | `TK_team` | 任務、角色外觀 |
| `team-goals/<teamId>` | 該小組負責人、管理者 | 全員 | `GK` | 小組目標（v0.20，D47，§16.14） |
| `team-roster/<teamId>` | 該小組負責人、管理者 | 全員 | `GK` | 小組成員與負責人、移出次數（v0.25，D49，§16.15） |
| `member/<id>/plans/private`、`plans/team/<teamId>`、`plans/org` | 本人 | 本人 / 該小組成員 / 全員 | `PK` / `TK_team` / `GK` | 五層計劃（見 §4.3、§16.10） |
| `member/<id>/scrum/<teamId>/<yyyy-mm>` | 本人 | 該小組成員 | `TK_team` | 每日 Scrum（每個所屬小組各一份，§16.12） |
| `member/<id>/attendance/<yyyy-mm>` | 本人 | 本人、負責人、管理者 | `AK_member` | 打卡紀錄 |
| `member/<id>/requests` | 本人 | 本人、核准者 | `AK_member` | 請假、加班、補打卡申請 |
| `member/<id>/secrets` | 本人 | 本人 | `PK_member` | 本人的私密設定（v0.31 起含通知偏好 `notify`，§16.17） |
| `member/<id>/tasks` | 本人 | 本人 | `PK_member` | 私人任務（D46，§16.8） |
| `member/<id>/direction` | 本人 | 全員 | `GK` | 方向摘要與對齊建議（v0.21，D47，§16.14） |
| `member/<id>/profile` | 本人 | 全員 | `GK` | 顯示名稱、時區、工作時段（v0.31，D57，§16.17） |
| `member/<id>/timer` | 本人 | 本人 | `PK_member` | 計時原始片段與目前計時狀態（v0.34，D62，§16.18） |
| `member/<id>/worklog/<yyyy-mm>` | 本人 | 本人、本人所屬小組的負責人 | `WK_member` | 每天整理後的逐筆時間、週計劃快照（v0.34，D62，§16.18） |
| `approvals/<approverId>` | 核准者本人 | 申請者、管理者 | 申請者的 `AK_member` | 核准 / 退回決定 |
| `member/<id>/reports/<teamId>/<yyyy>` | 本人 | 該小組成員 | `TK_team` | 日 / 週報（發佈到哪些小組就寫入哪些小組，§16.13） |
| `kb/meta` | 全體成員 | 全員 | `GK` | 知識庫的分類與主題（§16.11） |
| `kb/items/<yyyy-mm>` | 全體成員（每則只限作者與管理者） | 全員 | `GK` | 知識（§16.11） |

- 申請與核准分屬不同寫入者的文件，申請狀態由投影層組合兩者得出，避免多人寫同一欄位造成衝突或越權。
- `AK_member`（出勤金鑰）：每位成員一把，封裝給本人、其小組負責人與所有管理者；負責人異動時輪替。
- `PK_member`（私人金鑰）：只封裝給本人。
- `WK_member`（工作紀錄金鑰，v0.34，D62）：每位成員一把，封裝給本人與本人所屬各小組的負責人（不含管理者，與 `AK_member` 不同）；負責人名單變動時由本人輪替（§16.18）。
- `GK`（組織金鑰）：封裝給全員；成員停用時輪替。

### 4.2 簽章變更與驗證層

- 每個 Automerge change 由寫入裝置的 DK 簽章：`SignedChange{docId, changeHash, deps, authorDevice, sig}`。
- 接收端套用前驗證：簽章 → 信任鏈（§3.2）→ 作者是該文件的合法寫入者（§4.1）。
- 驗證失敗的 change 不套用，記錄於本機稽核紀錄。因為每份文件只有一類寫入者，拒絕非法 change 不會影響合法寫入者的因果鏈。
- `team/<teamId>` 為多人寫入：驗證層只確認作者是小組成員；欄位級規則（例如只有負責人可改小組目標）在投影層檢查並於 UI 限制，M1 接受此簡化。

### 4.3 計劃的可見度

可見度有「私人 / 小組 / 全組織」三種，分別以 `PK_member`、`TK_team`、`GK` 加密，因此計劃拆為多份文件。改變可見度 = 將項目搬到另一份文件並保留同一 `planItemId`。上下層連結以 `planItemId` 參照，跨文件仍可組成目標樹；讀者看不到的上層項目顯示為「私人項目」。

> v0.15：成員可能屬於多個小組，「小組」可見度改為**每個小組一份**：`member/<id>/plans/team/<teamId>`，以該小組的 `TK_team` 加密，只有該小組成員能讀；設定可見度時選擇一個所屬小組。離開小組後，留在該小組文件中的項目仍可被該小組讀到（與任務相同），介面提示改可見度。文件結構與進度彙總見 §16.10。

### 4.4 加密 Change Bundle

直連成員之間使用 Automerge sync protocol（傳輸已由 iroh 加密）。交給 mailbox 保存時打包為：

```
EncryptedBundle {
  v: 1,
  docId,          // 文件 ID（洩漏「某文件有更新」，不洩漏內容）
  keyId,          // 例如 team:<teamId>:epoch:<n>（格式見下）
  nonce,          // 24 bytes，隨機
  ciphertext,     // XChaCha20-Poly1305( postcard(SignedChange[]) )
  bundleHash      // blake3(ciphertext)，mailbox 去重鍵
}
AAD = utf8(docId) ‖ 0x00 ‖ utf8(keyId)
```

`keyId` 格式（`<family>:epoch:<n>`，n 從 1 開始）：

| family | 用途 |
|--------|------|
| `org` | GK |
| `team:<teamId>` | TK |
| `member:<memberId>:attendance` | AK |
| `member:<memberId>:private` | PK |
| `conv:<convId>` | CK |

### 4.5 同步流程

> v0.7：簽章保存、直連協定與 gossip 以 §16.5–16.6 為準。

1. 啟動：連上 iroh relay → 加入組織 gossip 主題 → 廣播 `HeadsAnnounce{docId, heads}`。
2. 發現他人 heads 較新 → 直連該節點跑 Automerge sync。
3. 相關成員都不在線 → 向 mailbox `LIST since=<cursor>` 取得 bundle 補同步。
4. 本機產生新 change → 推送給在線的相關成員，同時上傳 bundle 至 mailbox。
5. 保留：change bundle 永久保存（D16 訊息永久保留）；日後的檔案 blob 依 1 年政策清除。

## 5. 網路協定（iroh ALPN）

| ALPN | 用途 | 參與者 |
|------|------|--------|
| `hills/sync/1` | Automerge 同步（單一連線多工多份文件） | 成員裝置 ↔ 成員裝置 |
| `hills/gossip/1` | iroh-gossip：Presence、HeadsAnnounce | 全組織 |
| `hills/mailbox/1` | PUT / LIST / GET bundle、加入 / 新裝置 / 還原申請投遞 | 裝置 ↔ mailbox |
| `hills/tsa/1` | 時間戳請求 | 裝置 ↔ tsa |

訊息以 `postcard` 序列化，外層帶 `v`、`type`、`requestId`，所有請求設逾時。

### 5.1 上線狀態（Presence）

- 每台裝置每 30 秒於 gossip 廣播 `Presence{memberId, deviceId, state, note, currentTaskId, expiresAt, ts, sig}`，以 `GK` 加密。
- 90 秒未收到 → 離線；同一成員多台裝置取最活躍的狀態。
- 本機閒置 10 分鐘（可設定）→ 自動「暫離」。
- `state`（D40）：`Online` 上線、`Busy` 忙碌、`Meeting` 會議、`Focus` 專注、`Away` 暫離、`Leave` 休假、`Offline` 離線、`Lunch` 午休。`Lunch` 加在列舉最後，既有值的序列化編號不變；舊版收到 `Lunch` 會解碼失敗並略過該則 presence（M1 前尚無正式使用者，可接受）。
- v0.11 Presence 欄位：`{ member, state, note, current_task, at, until?, location }`；`until` 即 `expiresAt`，`location` = `Hidden`（不顯示）| `Remote` | `Office(officeId)`（D40，M1 由成員手動選擇，Wi-Fi 自動判斷隨打卡加入）。新增欄位改變 postcard 格式，舊版無法解碼新版 presence，Mac 與 Windows 需同時更新（M1 前可接受）。
- v0.32：`until` 到期時由**本人的 app** 把狀態改回 `Online` 並清除 `until`（`Leave` 除外；其他成員的 app 不代改，只在顯示上視為已到期）。app 未開啟時不會自動改，下次開啟時立即檢查。
- **延後通知**（D40 敲門 / 專注）：本人狀態為會議、午休或專注且 `until` 未到時，新訊息的系統通知先暫存在本機；狀態結束（到期或手動切換）時以一則摘要通知「專注期間收到 N 則訊息」。訊息本身照常同步，未讀數照常更新；伺服器不參與延後。傳送者在對方會議 / 午休 / 專注時看到「敲門」字樣，語意相同。
- `expiresAt` 是「幾點回來」：到期後回到上線（會議、午休、暫離、專注）或離線（休假以請假期間為準）。

### 5.2 Mailbox 服務 API

> v0.7：完整請求清單以 §16.7 為準。

```
PUT   { orgId, bundle }                              → { cursor }
LIST  { orgId, docIds?: [..], since: cursor, limit } → { bundles: [..], next }
GET   { orgId, bundleHash }                          → EncryptedBundle
JOIN  { orgId, inviteId, payload }                   → ok
FETCH_JOINS { orgId }                                → [JoinRequest]   // 限管理者
```

- 存取控制：iroh 連線本身已驗證對方的 NodeId（= DK），因此每條連線開頭送一次 `Hello{DeviceCert, MemberCert}`，mailbox 確認 `DeviceCert.devicePub == 連線的 NodeId` 且信任鏈有效後，該連線上的請求不需逐一簽章。
- mailbox 以設定檔中的 OK.pub 與管理者推送的 **roster 快照**驗證：`PUT_ROSTER{memberCerts[], revocations[]}`，每筆憑證與撤銷各自驗證簽章（第一位管理者由 OK 簽發，其他由有效管理者簽發）。roster 只含公鑰與角色，不含其他組織資料。
- `Join` 等申請相關請求例外（尚無憑證），改以 CAFECA 登入證明驗證並限流（§17.8）。
- 儲存：SQLite 索引 + 檔案系統存 ciphertext（M1 規模足夠）。
- 配額：每組織、每裝置限流。

### 5.3 角色權限（M1）

| 操作 | 成員 | 小組負責人 | 管理者 |
|------|:---:|:---:|:---:|
| 寫自己的計劃 / Scrum / 打卡 / 申請 | ✓ | ✓ | ✓ |
| 核准小組成員的請假 / 加班 / 補打卡 | | ✓ | ✓ |
| 讀小組成員出勤 | | ✓ | ✓ |
| 修改 org 文件（成員、小組、規則） | | | ✓ |

## 6. 可信時間戳（打卡）

```
裝置：record = { memberId, kind: in|out, localTime, monotonic, location: office(officeId)|remote, wifiHash? }
      h = blake3(postcard(record))          ──► hills-tsa { h }
TSA ：token = Sign_TSA(h ‖ serverTime)       ──► 裝置
裝置：AttendanceRecord = { record, tsaToken, sig_DK }
```

- 工時以 `serverTime` 為準；`localTime` 與 `serverTime` 相差 > 5 分鐘標示異常。
- 離線打卡：先記錄 `localTime` 與單調時鐘讀數，上線後補取 token 並標註 `lateStamped`；報表顯示註記。
- TSA 公鑰寫在 `org` 文件；金鑰輪替時新舊並存。
- `wifiHash = blake3(orgId ‖ BSSID)`，不保存原始 BSSID；與 org 文件中各辦公室登錄的 Wi-Fi 雜湊比對得出 `office(officeId)`；都不符合時為 `remote`（D40 多辦公室）。

## 7. 領域規則（hills-domain）

### 7.1 工作日判定

```
isWorkday(member, date) =
    holidayCalendar(org.region, date.year) 判定為工作日（含補班日，扣除國定假日與公司自訂假日）
  ∧ member 當日沒有已核准的全天請假
```

假日曆以年度 JSON（`region`, `year`, `holidays[]`, `workdays[]`）維護於 repo，由管理者匯入。台灣資料依行政院人事行政總處公告。

### 7.2 工時計算

```
WorkRule { flexStart: 08:00, flexEnd: 10:00, dailyHours: 8, breakMinutes: 60, timezone }

worked   = clockOut.serverTime − clockIn.serverTime − break
late     = clockIn > flexEnd
short    = worked < dailyHours − 當日已核准請假時數
excess   = max(0, worked − dailyHours)      // 僅供參考
overtime = Σ 已核准的 OvertimeRequest 時數    // 正式加班
```

### 7.3 特休（週年制）

依到職日週年計算年度額度。預設級距如下，**實作前需對照現行勞基法第 38 條核對**：

| 年資 | 天數 |
|------|------|
| 6 個月以上未滿 1 年 | 3 |
| 1 年以上未滿 2 年 | 7 |
| 2 年以上未滿 3 年 | 10 |
| 3 年以上未滿 5 年 | 14 |
| 5 年以上未滿 10 年 | 15 |
| 10 年以上 | 每 1 年加 1 日，上限 30 日 |

級距表存在 `org.leavePolicy`，組織可覆寫為優於法規的公司規定。

### 7.4 多層核准引擎

```
ApprovalRule {
  id, appliesTo: leave | overtime | correction,
  when:  { leaveTypes?: [..], minDays?: n, minHours?: n },
  steps: [ { approver: teamLead | admin | <memberId> } ]
}
```

- 依規則順序取第一條符合者；都不符合時用預設規則「小組負責人單層」。
- 申請者本人就是某一步的核准者時，該步改由管理者核准。
- 申請狀態由投影得出：`pending(step k) / approved / rejected / cancelled`。
- 加班核准時選 `pay` 或 `compTime`；`compTime` 轉入補休額度。

## 8. 資料模型（M0 / M1）

ID 一律使用 ULID；時間存 UTC（RFC 3339），另存使用者時區；日期型欄位用 `YYYY-MM-DD`。

```ts
// org 文件
Organization { id, name, branding: { logo?, primaryColor }, locale, timezone,
               holidayRegion, customHolidays: Date[], tsaPublicKeys: Key[],
               offices: Office[], workRule: WorkRule, lunchBreak?: {start, end},
               leaveTypes: LeaveType[], leavePolicy: AnnualLeaveTable,
               approvalRules: ApprovalRule[] }
Member      { id, name, title?, timezone, joinedAt, hireDate, roles: Role[],
              cert: MemberCert, devices: DeviceCert[], status: active|disabled }
Team        { id, name, leadIds: MemberId[], memberIds: MemberId[] }
Invite      { id, secretHash, role, teamIds, expiresAt, usedBy?, revoked }
Office      { id, name, wifiHashes: string[] }
LeaveType   { id, name, paid: boolean, minUnitHours, annualLimitHours?, requireProof }
HolidayCalendar { region, year, holidays: {date, name}[], workdays: Date[] }

// team 文件
Task        { id, teamId | private, title, assigneeId?, status: todo|doing|review|done, doneAt?,
              estimateHours?, dueAt?, steps?: TaskStep[], planItemId?（週目標，D46）, blockedReason?,
              createdAt, updatedAt }
TaskStep    { id, title, assigneeId?, done: boolean, doneAt? }

// member 文件
PlanItem    { id, level: year|quarter|month|week, period: '2026' | '2026-Q4' |
              '2026-11' | '2026-W45', parentId?, alignedGoalId?（年 / 季，D47）,
              title, keyResults?: KeyResult[], done?: boolean, progress, progressOverride? }
KeyResult   { id, title, start: number, target: number, current: number, unit }
ScrumReport { date, done: Ref[], today: Ref[], blockers: Blocker[], submittedAt }   // 詳見 §16.12
AttendanceRecord { id, kind: in|out, localTime, serverTime?, tsaToken?, location,
                   lateStamped, sig }
LeaveRequest    { id, typeId, start, end, hours, delegateId?, reason, proof?, ruleId,
                  createdAt, cancelledAt? }
OvertimeRequest { id, start, end, hours, reason, compensation: pay|compTime, ruleId, createdAt }
CorrectionRequest { id, date, kind: in|out, time, reason, ruleId, createdAt }
Report      { id, scope: member|team, period, sections: { progress, okr, attendance, next },
              publishedTo: teamId[], generatedAt, editedAt? }   // M1 個人日 / 週報見 §16.13；小組彙整為即時合併，不另存

// org 文件 / team-goals 文件（v0.20，D47，§16.14）
Direction   { id, year, title, keyResults: KeyResult[], createdAt, updatedAt }
TeamGoal    { id, teamId, year, title, directionId?, keyResults: KeyResult[], criteria: Criterion[], createdAt, updatedAt }

// approvals 文件
ApprovalDecision { requestId, requesterId, step, decision: approve|reject, comment?, at }
```

## 9. 本地儲存與前端

- Automerge 文件存於 app data 目錄，檔名為 `blake3(docId)` 的 hex（不洩漏文件結構）；以本機儲存金鑰（隨機 32 bytes，存於系統 keychain）靜態加密：XChaCha20-Poly1305、隨機 nonce、AAD = 檔名（`hex(blake3(docId))`）；加密內容為 `docId ‖ Automerge 存檔`，讀取時確認 `blake3(docId)` 與檔名一致。如此不知道 docId 也能列出並解密全部文件（重建投影用），且檔案無法被搬到別的檔名下冒用。
- 寫入採「寫暫存檔 → fsync → rename」，中途中斷不會損壞既有檔案。
- SQLite 投影：從文件導出可查詢的表（任務、Scrum、出勤、申請狀態、計劃樹），文件變更時增量更新；投影隨時可重建。
- **投影資料庫只存在記憶體**，app 啟動時由加密文件重建，因此磁碟上沒有明文業務資料。小團隊（≤ 50 人）的資料量重建只需數秒；若日後過慢，改用 SQLCipher 加密的磁碟資料庫（需先更新本節）。
- 前端只讀投影（Tauri command 查詢 + event 推送變更）；寫入一律經 Rust 核心產生簽章 change。

## 10. 部署（docker-compose）

> v0.7：M0 部署內容以 §16.9 與 [deploy.md](./deploy.md) 為準。

```yaml
services:
  relay:    # iroh-relay（含 QUIC address discovery）
  mailbox:  # hills-mailbox，volume: mailbox-data:/data
  tsa:      # hills-tsa，私鑰以 docker secret 掛載
  storage-0 … storage-7:  # hills-storage，各自獨立 volume 與 UDP 埠（§15.7、D39）
```

- 提供 `.env.example`；實際 `.env` 與所有私鑰不進版控（repo 為公開）。
- 備份：mailbox `/data` 每日快照；TSA 私鑰與 OK 備份離線保存。
- 監控：各服務健康檢查端點、磁碟用量告警。

## 11. 威脅模型摘要

| 威脅 | 對策 |
|------|------|
| 伺服器被入侵 | relay / mailbox 只有密文；TSA 被入侵只能偽造時間，無法讀資料 |
| 組織連線碼外洩 | 連線碼不是機密，只含 mailbox 位址與 OK.pub；加入需 CAFECA 登入並經管理者核准 |
| CAFECA 帳戶遭盜用 | 等同取得該成員身分：新成員需管理者核准；新裝置加入時本人其他裝置收到通知並可撤銷；還原需管理者核准 |
| 冒用登入（QR 轉送、假冒 App） | 原生 App 模式無法綁定網域，登入簽章改綁定裝置金鑰（§17.3 nonce），錢包與 Hills 顯示相同確認碼供比對 |
| RPC 節點說謊 | 可設定自架 RPC（`HILLS_CAFECA_RPC`）；管理者裝置核准前再次驗證 |
| CAFECA 簽章挪用 | 依賴 CAFECA 錢包只簽自己組出的 `SignIn`；合約層 ERC-7739 防重放尚未完成（CAFECA README §7），正式試用前確認 |
| 裝置遺失 | 本人或管理者撤銷 DeviceCert；本機資料靜態加密 |
| 離職成員 | 撤銷 + epoch 輪替；已同步資料無法撤回（明示） |
| 竄改打卡 | DK 簽章 + TSA 時間憑證；異常標示給負責人 |
| 惡意成員寫入他人文件 | single-writer 驗證層拒絕 |
| 惡意小組成員自行輪替出只封給自己的小組金鑰（D49） | 收件端只接受管理者或「指定輪替成員」簽署的較新 epoch（§16.15）；mailbox 同一收件者、同一 keyId 只保留第一份。剛加入、還沒有任何 epoch 的成員無法分辨，M1 接受此限制 |
| 新裝置綁定被調包 | 臨時公鑰寫在 CAFECA 簽署的 nonce 中，mailbox 無法替換 |
| 公開 repo 洩漏機密 | GitHub secret scanning、pre-commit 掃描、`.env` 範本化 |
| 本機其他程式或網頁呼叫 MCP（D48） | 只綁 127.0.0.1；Bearer token（鑰匙圈）；檢查 `Host`、拒絕非本機 `Origin`；寫入一律待確認（§18） |
| Agent 把資料送到外部模型服務（D48） | 預設關閉；需管理者開放 + 本人開啟並看過警告；明示這部分資料離開端對端加密 |
| 知識或結案報告中的惡意 HTML（D52） | 存檔前以 DOMPurify 清理（移除腳本、事件屬性、iframe、表單、外部資源）；顯示時再清理一次，放在不允許腳本的沙盒 iframe，繼承 app CSP；連結攔截後以外部瀏覽器開啟（§16.16） |
| AI Agent 被誘導或失控（D54） | 獨立身分、範圍只限指派給它的任務與所屬小組；不能成為管理者或負責人；寫入頻率上限；每筆寫入留執行紀錄、可退回；負責人可暫停、停用（撤銷裝置 + 輪替小組金鑰）（§19） |

## 12. M0 技術驗證（PoC）

| 項目 | 方法 | 通過標準 |
|------|------|---------|
| iroh 穿透 | 兩台桌機分別在公司網路、家用寬頻、手機熱點（CGNAT）、企業防火牆下兩兩組合測試 | 全部組合可連線；記錄直連比例與 relay 延遲 |
| Automerge 同步 | 兩裝置各自離線編輯同一計劃文件 100 次後重連 | 結果一致、無遺失，合併 < 1 秒 |
| 加密 bundle + mailbox | A 離線時 B 寫入，A 上線經 mailbox 補同步 | 補同步 ≤ 5 秒 |
| 桌機打包 | macOS（notarize）、Windows（簽章）；Linux 於 M2 | 可安裝、可啟動 |
| 檔案分享 | 見 §15.8 | 見 §15.8 |

結論寫入 `docs/poc-report.md`。iroh 或 Automerge 未通過時，評估替代方案（WebRTC + Yjs / Loro）。

## 13. 待決事項

1. `GK` 輪替時是否重新加密 `org` 歷史（建議否：新 change 用新 epoch，歷史保留舊 epoch）。
2. 多人寫入的 `team` 文件長期成長的快照與壓縮策略。
3. 時間戳是否採 RFC 3161 標準格式，以便作為法定出勤紀錄的佐證。
4. M2 群組聊天是否改用 OpenMLS 取代 epoch 小組金鑰。

## 14. M1 對話（D34、D37）

M1 的對話範圍：一對一（`dm`）與群組（`group`），文字、Markdown、@提及、檔案與資料夾附件、桌機通知。小組頻道、已讀、搜尋、討論串、編輯撤回、歷史訊息分享在 M2（見 [technical-design-m2-m5.md](./technical-design-m2-m5.md) §1）。

### 14.1 對話金鑰（D37）

- 每個對話一把 epoch 對稱金鑰 `CK_conv`，沿用 §3.7 的 epoch 機制：建立者產生 `CK`，以 HPKE 封裝給每位成員的 EK。
- 新增成員：輪替 epoch，新 epoch 封裝給全體現任成員（含新成員）；新成員看不到加入前訊息（M1 不分享歷史 epoch；歷史分享為 M2 功能，v0.9 說明見 §14.2）。
- 移出成員：輪替 epoch，新訊息使用新 `CK`。
- 對話設定存於 `conv/<convId>/meta`（寫入者：對話管理員）：名稱、成員、金鑰封裝紀錄。
- **v0.9（M1）**：對話管理員只有**建立者**一人（指定其他管理員為 M2 功能）。`convId = <建立者 memberId>-<ULID>`（皆為小寫 base32，共 53 字元），因此不需先解密 meta 就能得知建立者：
  - `KeyFamily::Conv(convId)` 的封裝金鑰只接受**建立者裝置**簽章者（取代 M0「任何成員皆可」），防止他人以假的較新 epoch 讓成員改用其金鑰加密。
  - `meta` 的每筆 change 必須由建立者簽署；`log` 的作者必須在 meta 的現任成員中。
  - 因同步順序造成「作者尚未出現在 meta」而被拒的 log change 暫存在本機，meta 更新後重試。
- 一對一對話（`dm`）也是一般對話（kind = dm、兩位成員）；兩人同時建立時可能出現兩個 DM，介面優先開啟最近有訊息的那一個。
- 未讀數只存在本機，不同步。

### 14.2 訊息文件

```
conv/<convId>/meta                 寫入者：對話管理員       金鑰：CK（最新 epoch）
conv/<convId>/log/<yyyy-mm>-e<n>   寫入者：對話成員（append） 金鑰：CK epoch n
```

> v0.9：紀錄文件**依 epoch 分開**（`-e<n>`）。Automerge 文件內的 change 互相依賴，若新舊 epoch 共用一份文件，新成員缺少舊 change 就無法套用之後的訊息；直連同步也會把整份文件交給對方。分開後：
> - 新增或移出成員時，建立者都輪替 epoch；新成員只拿到新 epoch，也只會收到新 epoch 的紀錄文件（D37「看不到加入前訊息」）。
> - meta 為每位成員記錄 `epoch`（加入時的 epoch）；直連同步回應 `log/…-e<n>` 前檢查請求者是現任成員且 `epoch ≤ n`。
> - 送出訊息時寫入目前最新 epoch 的文件。

```ts
Message {
  id: ULID, convId, authorId, deviceId, createdAt,
  kind: 'text' | 'files' | 'system' | 'task',
  body: string,                       // Markdown
  mentions: MemberId[],
  attachments?: Attachment[],         // kind = 'files'
  task?: { teamId, taskId } | null    // kind = 'task'（v0.14）；null = 取消連結
}
Attachment =
  | { type: 'file',   manifest: FileManifest,  fileKey: base64 }          // §15.4
  | { type: 'folder', name, totalSize, fileCount,
      manifestRef: ObjectRef, manifestKey: base64 }                      // §15.5
```

- 驗證層（§4.2）：作者必須是 `meta` 中的成員；`log` 為多人寫入文件，只接受新增訊息（投影層忽略修改既有訊息的 change）。
- 傳遞：沿用 §4.5——在線成員直連同步，離線成員經 mailbox 補同步。`fileKey` / `manifestKey` 只出現在 `CK` 加密的訊息中。
- 通知：收到 `mentions` 含自己或 `dm` 訊息時發桌機通知；群組預設只通知提及。

**對話連結的任務（v0.14，D43 焦點營地）**：

- 任何現任成員都可以送出 `kind = 'task'` 的訊息，把對話連到一個任務或取消連結；沿用 log 的 append-only 規則，驗證層不需變更。其他 kind 的 `task` 欄位在投影時忽略。
- 對話目前連結的任務 = 本人可讀的紀錄文件中最新（`createdAt`，相同時比 key）的一則 `kind = 'task'` 訊息。新成員看不到加入前的連結訊息，需由任一成員重新連結。
- 連結訊息不計入未讀、不發通知、不作為對話清單的「最後訊息」；訊息流中顯示為系統列「〈作者〉把對話連到〈任務〉」。
- 只能連結小組任務（私人任務其他成員讀不到，v0.19）。任務內容不複製進對話：讀取時從 `team/<teamId>` 取得。送出前檢查任務存在於本人可讀的小組；讀取方不是該小組成員或任務已刪除時，介面顯示「無法查看此任務」。`teamId`、`taskId` 只出現在 `CK` 加密的訊息中。
- **步驟完成的系統列由介面依 `TaskStep.doneAt` 推導**，插入訊息流顯示（只顯示落在已載入訊息時間範圍內的），不另外寫入對話，避免多台裝置重複寫入與離線衝突。

## 15. M1 檔案分享：SwarmStorage 原理（D35、D36）

### 15.1 與 SwarmStorage 的對應

| SwarmStorage | Hills | 差異原因 |
|-------------|-------|---------|
| 整個檔案以 AES-256-GCM 串流加密，一組 IV / tag | **每個 20 MB 條帶各自 AES-256-GCM**，各有 IV / tag | WebCrypto 不支援 GCM 串流；逐條帶加密可固定記憶體並支援續傳 |
| 20 MB 條帶 → 5 個 4 MB 資料分片 + 3 個同位分片，RS (8, 5)，GF(2⁸)，Vandermonde 系統碼 | 相同 | — |
| 第 i 片附加到 `shard-i.bin`，整檔一個 SHA-256 | **每個條帶的每個分片是獨立物件**，以 SHA-256 定址 | 可逐條帶上傳、續傳、平行傳輸 |
| `metadata.json` 存於倉儲 | `FileManifest` 放在 `CK` 加密的對話訊息中；資料夾的清單另存為加密物件 | 伺服器看不到檔名與結構 |
| 金鑰由呼叫者保管 | 金鑰只存在加密的對話訊息中 | 只有對話成員能解密 |
| 任 5 片可還原；`.partial` 驗證後改名 | 相同 | — |

Reed-Solomon 實作直接移植 SwarmStorage 的 `src/lib/reed_solomon_erasure.ts`（MIT），並以 SwarmStorage 產生的測試向量驗證兩者輸出一致。

### 15.2 前端上傳流程

```
使用者選擇檔案 / 資料夾（Tauri dialog）
  └► 主執行緒：列出檔案（D39：Rust command，只接受本次以 dialog 選擇的路徑）→ 建立上傳佇列
       └► 逐一處理每個檔案（依序，一次一個檔案）
            └► 每個條帶 k（20 MiB 明文，最後一條帶可較短）：
                 1. Rust command 讀取 [k·20MiB, (k+1)·20MiB) 的明文，以二進位回傳 ──► 傳給 Web Worker（Transferable）
                 2. Worker：AES-256-GCM 加密
                      key = fileKey（每檔隨機 256-bit）
                      IV  = fileNonce(8 B 隨機) ‖ uint32_be(k)
                      AAD = utf8(fileId) ‖ uint32_be(k) ‖ uint32_be(stripeCount)
                      payload = ciphertext ‖ tag(16 B)
                 3. Worker：payload 以 0 補齊到 5 的倍數 → 切 5 個資料分片 → RS 計算 3 個同位分片
                 4. Worker：每個分片計算 SHA-256（物件 ID）
                 5. 主執行緒：8 個密文分片交給 Rust，平行上傳到 8 個儲存節點（§15.6，D39）
            └► 全部條帶完成 → 產生 FileManifest
  └► 資料夾：產生 FolderManifest → 以 manifestKey 加密後當作一般檔案上傳（同一流程）
  └► 送出對話訊息（Attachment）
```

- **記憶體**：最多同時處理 2 個條帶（一個加密編碼中、一個上傳中），約 2 ×（20 MiB 明文 + 20 MiB 密文 + 12 MiB 同位）≈ 104 MiB。
- **AAD 綁定條帶序號與總數**：防止分片被重排、截斷或混用其他檔案。
- **IV 唯一性**：每檔隨機 `fileKey` 加上條帶計數器，同一金鑰下 IV 不重複。
- **續傳**：本機記錄每個條帶、每個分片的上傳狀態（SQLite）；重新開始時以 `HEAD` 查詢節點已有的分片並略過。
- **取消**：已上傳的分片不寫入任何訊息，到期後由節點清除。
- **相同內容**：分片以 SHA-256 定址；同一檔案重傳時分片 ID 不同（每次 `fileKey` 不同），不做跨檔去重（避免洩漏內容相同的資訊）。

### 15.3 前端下載流程

```
收件者點擊下載 → 選擇存放位置（資料夾分享則選擇目標資料夾）
  └► 每個條帶 k：
       1. 優先下載資料分片 1–5；任一失敗或 SHA-256 不符，改抓同位分片 6–8
       2. 收到任 5 片：若缺資料分片，RS 解碼還原
       3. 依 payloadLen 去除補齊 → AES-256-GCM 解密（同上 IV / AAD）
       4. 寫入 <name>.partial 的對應位置
  └► 全部條帶 tag 驗證通過 → 改名為正式檔名；任何條帶失敗 → 刪除 .partial 並回報
（D39：分片由 Rust 從節點取回後以二進位交給前端；RS 解碼與解密在前端進行，明文再交給 Rust 寫入使用者所選位置的 `.partial`。）
```

- 少於 5 片可用時回報「檔案無法還原」，並顯示可用分片數。
- 資料夾下載：先下載並解密 FolderManifest，再逐一下載檔案；可只勾選部分檔案。

### 15.4 FileManifest

```ts
FileManifest {
  v: 1,
  fileId: ULID,
  name: string,                 // 單檔分享時的檔名（資料夾內檔案用 FolderManifest 的 path）
  size: number,                 // 明文大小
  mime?: string,
  mtime?: string,
  cipher: 'AES-256-GCM/stripe',
  fileNonce: base64,            // 8 B
  stripeSize: 20971520,         // 20 MiB
  rs: { data: 5, parity: 3 },
  stripes: Array<{
    payloadLen: number,         // 密文 + tag 長度（補齊前）
    shards: Array<{ id: hex /* SHA-256 */, size: number, node: number /* 0–7 */ }>  // 長度 8
  }>
}
```

- 每個條帶 8 筆分片：約 8 × 80 B ≈ 640 B／20 MiB；1 GB 檔案的清單約 32 KB，可直接放在訊息中。超過 256 KB 的清單（約 8 GB 以上的檔案）改為與資料夾相同，存成加密物件後以 `manifestRef` 參照。

### 15.5 資料夾快照（D36）

```ts
FolderManifest {
  v: 1,
  rootName: string,
  createdAt: string,
  entries: Array<
    | { kind: 'dir',  path: string }
    | { kind: 'file', path: string, manifest: FileManifest, fileKey: base64 }
  >
}
```

- `path` 一律以 `/` 分隔、Unicode NFC 正規化、相對於根目錄。
- 分享時略過：符號連結（不跟隨）、系統檔（`.DS_Store`、`Thumbs.db`、`desktop.ini`）、無讀取權限的檔案（列在結果摘要中）。
- 資料夾清單以 `manifestKey` 加密後，依 §15.2 同一流程上傳，訊息中只放 `manifestRef`（其 FileManifest）與 `manifestKey`。
- **下載時的路徑安全**（Windows 與 macOS 都必須處理）：
  - 拒絕 `..`、絕對路徑、磁碟代號、`\`。
  - Windows 保留名稱（`CON`、`PRN`、`AUX`、`NUL`、`COM1`…`LPT9`）與結尾的空白或句點：加上 `_` 前綴。
  - Windows 禁用字元 `<>:"|?*` 替換為 `_`。
  - 大小寫不敏感的檔名衝突（`a.txt` / `A.txt`）：後者加上 ` (2)`。
  - Windows 長路徑：寫入時使用 `\\?\` 前綴。
  - macOS 檔名以 NFD 儲存，讀取時一律轉為 NFC 再比對。

### 15.6 儲存節點 hills-storage

> v0.9：依 D39 改為 iroh 連線，取代原 HTTPS 設計。

M1 自行實作輕量物件節點（Rust），部署 8 個實例；日後可替換為 SwarmStorage 節點網路。每個節點是一個 iroh endpoint（自己的金鑰與固定 UDP 埠），ALPN `hills/storage/1`，訊息格式與 mailbox 相同（每條雙向串流一個請求、postcard、§16.7）：

| 請求 | 需 Hello | 權限 | 說明 |
|------|:---:|------|------|
| `Hello` | — | 有效裝置 | 與 mailbox 相同（裝置憑證 + 成員憑證）；未綁定組織時第一位 OK 簽發的管理者完成綁定（§16.9） |
| `PutRoster` | ✓ | 管理者裝置 | 管理者裝置把 roster（含撤銷）推送到每個節點，與 mailbox 相同 |
| `Has{ids}` | ✓ | 成員 | 回傳每個 SHA-256 是否已存在（續傳用） |
| `Put{id, data, expires_at}` | ✓ | 成員 | 節點驗證 `SHA-256(data) == id` 才存；`expires_at` 最長為上傳後 1 年（D16），預設 1 年 |
| `Get{id, offset, len}` | ✓ | 成員 | 回傳分片（可指定範圍） |

- **單一分片上限**：4 MiB + 少量餘裕（20 MiB 條帶 / 5）；請求與回應上限 5 MiB。
- **轉送**：前端完成加密與 RS 編碼後，把密文分片以二進位交給 Rust command；Rust 依分配規則連到對應節點上傳。Rust 不解密、不重新編碼，也不保存明文。
- **節點位址**：每個節點啟動時把自己的連線碼寫到與 mailbox 共用的 `storage-codes` volume；mailbox 的 `Services` 請求（§16.7）回傳依編號排序的節點位址，node 每次同步時更新（同 §16.1「mailbox 位址更新」），不需管理者手動設定。
- **分片分配**：分片 i 放到節點 `(i + fileNonce[0]) mod N`（N = 節點數，M1 為 8），讓負載分散。
- **保留**：節點每日清除過期物件。
- **配額**：每位成員在每個節點的總容量（預設 20 GB，可由環境變數調整）；單檔上限由前端檢查（預設 5 GB）。超過時回 `TooLarge`。
- **節點看到的資訊**：分片密文、大小、上傳者的成員 ID 與時間；看不到檔名、目錄結構、內容。
- **實作細節**（v0.12）：
  - 協定定義在 `hills-proto::storage`：`Request = Hello | PutRoster | Has{ids} | Put{id, data, expires_at} | Get{id, offset, len} | Health`，回應 `Ok | Has(Vec<bool>) | Stored{duplicate} | Data(bytes) | Health{objects, bytes} | Error{code, message}`（錯誤碼與 mailbox 相同）。`Has` 一次最多 64 個 ID；`Get` 的 `len = 0` 表示到結尾。
  - 信任邏輯（Hello、綁定組織、roster、每個請求重新檢查撤銷）與 mailbox 共用 `hills-net::gate::TrustGate`，兩者只差在持久化方式。
  - 節點資料目錄：`node.key`、`index.sqlite`（`objects(id, size, uploader, created_at, expires_at)`、信任狀態）、`objects/<前 2 碼>/<sha256>`（先寫 `.tmp` 再改名）。
  - **儲存節點連線碼**：`hills-sto1-` + base32(postcard(`StorageTicket{v, index, node: PeerAddr}`))；節點把它寫到 `HILLS_STORAGE_CODES_DIR/storage-<index>.txt`。mailbox 讀同一個資料夾回應 `Services`（依 `index` 排序，缺號略過）。
  - 環境變數：`HILLS_NODE_INDEX`（0–7）、`HILLS_DATA_DIR`、`HILLS_UDP_PORT`、`HILLS_PUBLIC_ADDR`、`HILLS_RELAY`、`HILLS_STORAGE_CODES_DIR`、`HILLS_QUOTA_BYTES`（每位成員，預設 20 GB）、`HILLS_ORG_ROOT_PUB`（選填）。
  - 客戶端（hills-node）：每次同步以 `Services` 更新節點清單並保存；對每個節點維持一條已 Hello 的連線；管理者裝置推送 roster 給 mailbox 時也推送給每個節點。

### 15.7 部署與容錯

- docker-compose 新增 `storage-0` … `storage-7`，每個實例使用獨立 volume 與固定 UDP 埠（預設 7850–7857，D39），不需網域或憑證，NAT 後的裝置經自架 relay 連線。
- M1 單台主機時，請把 8 個 volume 分散在不同磁碟；正式環境建議分散到至少 3 台主機，讓任 1 台主機故障時仍保有 ≥ 5 片（每台最多放 3 個節點，且 3 台中任兩台合計 ≥ 5）。
- 監控：每日抽查每個節點的分片 SHA-256，發現損壞時由持有檔案的成員裝置重新上傳缺少的分片（修復流程列為 M2）。

### 15.8 M0 PoC 追加項目

| 項目 | 方法 | 通過標準 |
|------|------|---------|
| WebView 加密與編碼效能 | 在 macOS（WKWebView）與 Windows（WebView2）的 Web Worker 中，對 1 GB 檔案執行讀取 → AES-GCM → RS(8,5) | 每平台 ≥ 50 MB/s；記憶體 < 200 MB |
| RS 相容性 | 以 SwarmStorage 產生的分片比對移植後的實作 | 輸出逐位元組一致 |
| Mac ↔ Windows 檔案往返 | Mac 上傳含中文檔名、多層目錄的資料夾，Windows 下載；反向亦同 | 雜湊一致；關閉任 3 個節點仍可下載 |

## 16. M0 組織生命週期與同步細節（v0.7）

本節補足實作所需的細節；與 §3.4–3.6、§4.5、§5、§10 衝突時以本節為準。

### 16.1 hills-node

`crates/hills-node` 是 app 核心，組合 identity / crypto / store / sync / net，桌機 app 只透過它操作：

- `create_org`、`join`、`add_device`、`recover`（v0.13，§17）、`approve_join` / `reject_join`、`revoke_member`、`revoke_device`
- `doc(id)` / `change(id, |doc| …)`：讀寫文件，寫入時自動簽章、保存、推送
- `events()`：同步狀態、roster、presence 變化

本機資料：

| 位置 | 內容 | 保護 |
|------|------|------|
| `SecretStore`（系統 keychain） | IK / EK 私鑰、DK、本機儲存金鑰 | OS |
| `node.json` | OK.pub、mailbox 位址、本人 memberId、介面設定 | 非機密 |
| `docs/*.am` | Automerge 文件 + 每筆 change 的簽章（§16.5） | 儲存金鑰（§9） |
| `keyring.enc`、`trust.enc` | KeyRing、TrustStore 快照 | 儲存金鑰 |

網路：node 的 iroh 金鑰就是 DK；relay 使用 mailbox 連線碼中的 relay URL（自架，D1），連線碼沒有 relay 時只用直連（測試用）。

**mailbox 位址更新**（v0.8）：`node.json` 中的 mailbox 位址不是固定值。每次同步呼叫 `Info` 取得 mailbox 目前的位址；NodeId 與已存的相同時，若 relay 或直連位址不同，就更新 `node.json`、把新 relay 加入執行中的 endpoint（不需重啟），再 `Announce` 自己的新位址。NodeId 不同時忽略（mailbox 身分不能以此方式更換）。之後產生的組織連線碼帶新位址。mailbox 只能藉此指定 relay，而 relay 只看得到端對端加密的 QUIC，因此不增加信任範圍。這讓部署後才補上 relay、或更換 relay 網域時，既有安裝會自動修正。M0 只支援 `org`、`team/<id>`、`member/<id>/secrets` 三種文件，其他文件類型隨 M1 功能加入。

### 16.2 邀請與加入

> **v0.13：由 §17 取代**（D41 不再使用邀請碼）。以下保留作為 M0 紀錄，不再實作。

**邀請碼**：`hills1-` + base32（小寫、無補齊）of postcard：

```
InviteTicket { v, org_root: OK.pub, invite_id: [u8; 8], secret: [u8; 16], mailbox: EndpointAddr }
```

加入者需要完整 OK.pub 才能驗證憑證，也需要 mailbox 位址；QR Code 內容與文字相同。

**流程**：

1. 管理者建立邀請：org 文件 `invites[id] = {secretHash: blake3(secret), role, teamIds, expiresAt, createdBy}`；`secret` 只存在建立者本人的私密文件（`member/<id>/plans/private` 以外的專用文件 `member/<id>/secrets`，PK 加密）；向 mailbox `RegisterInvite{inviteId, expiresAt}`。
2. 加入者產生復原詞（D38）→ IK / EK → DK → 自簽 DeviceCert，送出 `Join{orgId, inviteId, JoinRequest}`（不需 Hello）：
   ```
   JoinRequest { v, ik_pub, ek_pub, device_cert, name, mac }
   mac = blake3::keyed_hash(K_inv, postcard(以上欄位))
   K_inv = HKDF-SHA256(ikm = secret, info = "hills/v1/join" ‖ inviteId)
   ```
3. **建立邀請的管理者**的任一裝置（共用同一份 secret）定期 `FetchJoins`，驗證 MAC、邀請未過期未使用後：簽發 MemberCert → `PutRoster` → org 文件加入成員、標記邀請已使用 → 封裝 GK、所屬小組 TK、新成員的 AK（給本人、小組負責人、管理者）→ `PutKeys` → `CloseInvite`。
4. 加入者每 5 秒嘗試 Hello，roster 中出現自己後成功 → `GetRoster`、`FetchKeys`、LIST 補同步。

secret 不放在 org 文件，因為所有成員都能讀 org 文件；代價是只有建立者能處理該邀請（M0 接受）。

### 16.3 新裝置綁定

> **v0.13：由 §17.6 取代**（不再使用 `hills/link/1` 與 SAS）。以下保留作為 M0 紀錄。

1. 新裝置先貼上舊裝置匯出的**組織連線碼**（§16.4 `OrgTicket`，取得自架 relay 與 mailbox 位址，跨網路時舊裝置才連得到新裝置），再產生 DK 與臨時 X25519 `e_new`，顯示 `LinkTicket{v, device addr, e_new.pub}`（文字碼 + QR）。
2. 舊裝置以 ALPN `hills/link/1` 連線，送出臨時公鑰 `e_old.pub`。
3. 雙方計算 `shared = X25519(e_old, e_new)`，`SAS = 6 位數(blake3("hills/v1/sas" ‖ shared ‖ e_old.pub ‖ e_new.pub))`，`K_link = HKDF(shared, "hills/v1/link")`。
4. 兩邊顯示 SAS，使用者在**舊裝置**確認一致後，舊裝置以 `K_link`（XChaCha20-Poly1305）送出 `{復原詞熵, OK.pub, mailbox 位址}`，並以 IK 簽發新裝置的 DeviceCert、`PutDevice`。
5. 新裝置由熵重建 IK / EK，之後與一般啟動相同（`FetchKeys` 取回所有封裝給本人 EK 的金鑰）。

### 16.4 金鑰復原

> **v0.13：由 §17.7 取代**（不再使用復原詞）；`OrgTicket` 保留，見 §17.1。以下保留作為 M0 紀錄。

所有封裝金鑰都封裝給**成員的 EK**（不是裝置），且 mailbox 永久保存，因此：

1. 新裝置輸入復原詞 + **組織連線碼**（`OrgTicket{v, org_root, mailbox}`，`hills-org1-` + base32；任何成員可在設定中匯出）。
2. 重建 IK / EK，產生新 DK，以 IK 自簽 DeviceCert → `PutDevice`（mailbox 由 roster 確認此成員有效）。
3. `FetchKeys`（since 0）取回全部封裝 → `GetRoster` → LIST 補同步。
4. 在設定中撤銷舊裝置。

### 16.5 簽章保存與直連同步

- 本地文件檔除 Automerge 存檔外，另保存每筆 change 的 `(changeHash, signer, sig)`；change 內容從 Automerge 取，不重複儲存。需要轉送時組回 `SignedChange`。
- ALPN `hills/sync/1`，請求 / 回應同 §5（一個串流一個請求）：
  ```
  SyncRequest::Pull { doc_id, heads }   →   SyncResponse::Changes(Vec<SignedChange>)  // 對方有、我沒有的
  SyncRequest::Push { doc_id, changes } →   SyncResponse::Ok
  ```
- 回應前依 §4.1 **讀取者**欄位檢查請求者（連線 NodeId → TrustStore → Directory）；無權讀取回 `Forbidden`。收到的 change 一律經 §4.2 驗證層。

### 16.6 Gossip 與 Presence

- iroh-gossip topic = `blake3("hills/v1/gossip" ‖ orgId)`；bootstrap 節點來自 mailbox 位址簿（§16.7 `Peers`）。
- 訊息 = GK 加密（AAD = `"hills/v1/gossip" ‖ keyId`）的 `Signed<GossipMsg>`（以 DK 簽章）：
  ```
  GossipMsg::Presence { member, state, note, current_task, at, until, location }   // v0.11
  GossipMsg::Heads    { doc_id, heads }
  ```
- Presence 每 30 秒一次、90 秒未收到視為離線（§5.1）；Heads 在本機文件變更後送出，收到比自己新的 heads 時向該裝置 `Pull`。
- Heads 會讓組織成員知道某文件有更新（不含內容），M0 接受。

### 16.7 mailbox 請求（完整）

| 請求 | 需 Hello | 權限 | 說明 |
|------|:---:|------|------|
| `Hello` | — | 有效裝置 | §5.2；`member_cert` 可省略（復原、剛加入時本機尚無自己的成員憑證），省略時 mailbox 使用已知的成員憑證 |
| `GetRoster` | ✓ | 成員 | 回傳 MemberCert、DeviceCert、Revocation；每筆可獨立驗證，mailbox 只能扣留、不能偽造 |
| `PutRoster` | ✓ | 管理者 | 成員憑證與撤銷 |
| `PutDevice` | ✓ | 本人 | 上傳本人裝置的 DeviceCert（新裝置綁定） |
| `PutRevocation` | ✓ | 管理者（成員）/ 本人或管理者（裝置） | |
| `Config` | ✗ | 任何人 | v0.13：回傳 `{ cafeca_wallet }`（部署設定，§17.1） |
| `Join{org_id, application}` | ✗ | 有效 CAFECA 登入證明 | v0.13：加入 / 新裝置 / 還原申請，回應申請狀態，§17.8 |
| `JoinStatus{org_id, device_pub}` | ✗ | 申請裝置本人 | v0.13：`Pending` / `AwaitingDevice` / `Rejected` / `Unknown` |
| `FetchJoins` | ✓ | 管理者 | v0.13：待核准的加入與還原申請 |
| `ResolveJoin{device_pub, approved}` | ✓ | 管理者 | v0.13：核准（已 `PutRoster` 後）或拒絕 |
| `FetchDeviceRequests` | ✓ | 本人裝置 | v0.13：本人的新裝置申請 |
| `PutDeviceGrant{device_pub, sealed}` | ✓ | 本人裝置 | v0.13：封裝給新裝置的 IK / EK |
| `FetchDeviceGrant{org_id, device_pub}` | ✗ | 任何人（內容已加密） | v0.13：新裝置取回封裝 |
| `PutKeys` | ✓ | 管理者（org、attendance）/ 任何有效成員（team，v0.25）/ 本人（private） | `Signed<WrappedKey>`，由簽署裝置的權限決定；v0.25（D49）：mailbox 看不到小組名單，小組金鑰只檢查簽署者是有效成員，成員資格由收件端檢查（§16.15） |
| `FetchKeys{since}` | ✓ | 收件者本人 | 只回傳 `recipient == 本人` 的封裝 |
| `Announce{addr}` / `Peers` | ✓ | 成員 | 自架位址簿：裝置的 iroh 位址與最後上線時間，取代 n0 DNS 探索（D1、D26 全自架） |
| `Services` | ✓ | 成員 | v0.9：回傳儲存節點位址列表（依編號排序，§15.6）；尚未部署儲存節點時為空 |
| `Info` | ✓ | 成員 | 回傳 mailbox 目前的 `PeerAddr`（NodeId、relay、對外位址優先），供 node 更新已存位址（§16.1）；內容與 mailbox 連線碼相同，不是機密 |
| `Put` / `List` / `Get` | ✓ | 成員 | §5.2 |

`Roster` 增加 `device_certs`。

### 16.8 org 文件

```
org = {
  name, timezone, locale,
  members: { <memberId>: { name, joinedAt, cafeca: "eip155:<chainId>:<account>", handle?, approvedBy? } },   // v0.13
  teams:   { <teamId>: { name, leadIds: [..], memberIds: [..], archivedAt? } },   // v0.25（D49）：有 team-roster 文件時以它的名單為準
  offices: { <officeId>: { name, wifiHashes: [] } },     // v0.11（D40）；M1 wifiHashes 為空
  lunchBreak?: { start: "12:00", end: "13:30" },          // v0.11；組織時區
  directionRules?: { minAlignedShare: 50, behindPoints: 25, staleDays: 14 },   // v0.21（D47，§16.14）；管理者可改
}

team/<teamId> = {                                         // v0.11（D40）
  "task:<taskId ULID>": { title, assignee?, status: todo|doing|review|done, dueAt?,
                          doneAt?,                        // v0.21（D47）：改成完成時寫入，離開完成時刪除
                          steps: [ { id, title, assignee?, done, doneAt? } ],
                          planItemId?,                    // v0.19（D46）：所屬週目標
                          assignedBy?, assignedAt?,       // v0.26（D50）：負責人改變時寫入
                          teamGoalId?,                    // v0.26（D50）：來源小組目標，只供顯示與建議
                          brief?,                         // v0.29（D53）：交付說明，Markdown，≤ 8 KB
                          acceptance?: [ { id, text } ],  // v0.29（D53）：完成條件，≤ 20 條，每條 1–200 字
                          createdBy, createdAt, updatedAt },
  "profile:<memberId>": "{\"kind\":0,\"hair\":0,\"shirt\":3,\"skin\":1}",   // 角色外觀（JSON 字串，v0.31 起含 kind；見下方「角色外觀」）
  "ack:<taskId>:<memberId>": "{\"state\":\"accepted\",\"at\":0}",   // v0.26（D50）：負責人的回應，只有本人可寫
  "log:<taskId>:<ULID>:<memberId>": "<JSON>",            // v0.29（D53）：執行紀錄，只有本人可寫
  "report:<taskId>:<memberId>": "<JSON>",                // v0.29（D53）：結案報告，只有本人可寫
}
```

- 任務與外觀都放在根物件的獨立 key（不共用 `tasks` / `profiles` 容器），避免兩人同時建立第一個容器時 Automerge 只保留其中一個。

- `offices`、`lunchBreak` 只有管理者可寫（org 文件規則）。
- `team/<id>` 為多人寫入（§4）：任務全組可編輯；`profile:<memberId>` 只有本人可寫，由驗證層檢查（根物件上 `profile:` 開頭的 key 必須是作者本人，且只能放入字串），他人的寫入整筆 change 拒絕。成員把外觀寫進自己所屬的每個小組文件，讀取時取任一份。
- **角色外觀**（v0.31，D56）：`Look = { kind, hair, shirt, skin }`。`kind` 0–6 依序為男性、女性、貓、狗、大象、羊、老虎；`hair` / `shirt` / `skin` 是三個部位的色號 0–5（`LOOK_PALETTE = 6`），部位依角色解讀：

  | kind | hair（部位 1） | shirt（部位 2） | skin（部位 3） |
  |---|---|---|---|
  | 0 男性、1 女性 | 頭髮 | 衣服 | 膚色 |
  | 2 貓 | 毛色 | 衣服 | 花紋 |
  | 3 狗 | 毛色 | 衣服 | 耳朵 |
  | 4 大象 | 皮膚 | 衣服 | 耳內 |
  | 5 羊 | 羊毛 | 衣服 | 臉 |
  | 6 老虎 | 毛色 | 衣服 | 條紋 |

  色值是 token `--hills-look-<kind>-<part>-<n>`（衣服共用 `--hills-shirt-<n>`），不存在文件裡。**相容**：沒有 `kind` 的舊資料視為 0（男性）；讀取時色號以 6 取餘數、`kind` 超出範圍視為 0，不再丟棄整筆；寫入時檢查 `kind < 7` 且色號 < 6。
- **任務與週目標**（v0.19，D46）：`planItemId` 指向一個週目標（`level = week`）；寫入時檢查該目標存在於本人可讀的計劃中且為週層級。目標可能是私人或另一個小組的，看不到的讀者顯示「私人項目」。**任務進度** = 已完成步驟數 / 步驟數 × 100；沒有步驟時完成 = 100、未完成 = 0（§16.10 彙總）。
- **分派與回應**（v0.26，D50）：
  - `write_task` 發現負責人改變時寫入 `assignedBy`（寫入者）與 `assignedAt`；沒有負責人時刪除兩者。
  - `ack:<taskId>:<memberId>` 為 JSON 字串 `{state: "accepted" | "concern", note?, at}`，note 1–200 字；只有 memberId 本人可寫（驗證層比照 `profile:`：`ack:` 開頭的 key 必須以 `:<作者>` 結尾、只能放入字串）。
  - 回應**有效**：memberId 是目前負責人且 `at ≥ assignedAt`；改派後舊回應自動失效。
  - **待接下**：有負責人、`assignedBy` 不是負責人，且沒有有效的 accepted。負責人自己建立或改成自己的任務不需接下。
  - `teamGoalId` 指向同一小組的小組目標（寫入時檢查存在），只用於顯示來源與建議，進度仍經週目標彙總（D46 不變）。
  - **通知**：套用遠端 change 後，本機找出「負責人是我、`assignedBy` 不是我」且 `task/assignedAt` 沒通知過的任務，發桌機通知（伺服器不參與）。
  - **負荷**（介面計算）：未完成 = 負責人是他、狀態不是完成；本週到期 = 其中期限落在組織時區本週；「偏重」= 未完成 ≥ 7 或本週到期 ≥ 4。
- **執行紀錄與結案報告**（v0.29，D53）：
  - `log:` = `{kind: "start" | "progress" | "question" | "answer" | "close" | "reopen", text, percent?, refs?: [knowledgeKey], at}`；text ≤ 4 KB（Markdown），percent 0–100；只有作者可寫（驗證層比照 `ack:`：key 以 `:<作者>` 結尾、只能放入字串），寫入後不修改。
  - 誰可以寫：`start` / `progress` / `question` / `close`：目前負責人；`answer`：任何小組成員；`reopen`：指派者、負責人或小組負責人。
  - `report:` = `{v: 1, format: "markdown" | "html", spec: "hills-doc/1", body, criteria: [{id, met: bool, note?}], attachments: [§14.2 Attachment], at}`；body ≤ 64 KB 且符合 §16.16 的結案報告規格，附件 JSON ≤ 512 KB；只有負責人可寫，覆寫同一 key（每人一份，最新為準）。
  - **結案**：寫 `report:` → 任務狀態改為完成 → 寫 `close` 紀錄（refs 可帶產出的知識）。**退回**：任務改回進行中、寫 `reopen` 紀錄（text 為意見，必填）；報告保留，負責人可再結案覆寫。
  - 附件的 `fileKey` 只存在 `TK` 加密的小組文件中，小組成員都能下載；介面上傳前提示。
  - v0.33 實作：結案與退回由 node 在**同一筆 change** 內依序寫入（報告 → 狀態 / `doneAt` → 紀錄），不會只寫一半。紀錄 key 為 `log:<taskId>:<ULID>:<memberId>`，驗證層與 `ack:` 相同（key 以 `:<作者>` 結尾、長度 ≤ 128、只能放入字串）；`report:` 同。私人任務的紀錄與報告存在 `member/<id>/tasks`（只有本人）。讀取報告時取目前負責人的那份，沒有則取最新一份。
- **v0.34（D60、D62）任務進度、預估時數與紀錄種類**：
  - **預估時數**：`task.estimate`、`step.estimate`（分鐘，選填，15–60 000）；有步驟且步驟有預估時，任務預估 = 步驟加總（介面計算，不另存）。
  - **任務進度**（取代上面的 D46 公式）：狀態為完成 → 100；否則 = max（完成步驟數 / 步驟數 × 100（沒有步驟時 0），負責人最新一筆帶 `percent` 的 `progress` 紀錄的百分比）。結案後被退回時，退回之後沒有新的百分比紀錄則只看步驟比例。§16.10 彙總照舊使用任務進度。
  - **紀錄種類**新增 `step`（勾選步驟完成時由 node 自動寫入，text 為步驟標題，refs = [stepId]）、`blocked`（卡住了，text 必填）、`resolved`（已解決，refs = [被解決的 blocked 紀錄 key]）。`question` 為舊資料，介面以「卡住了」顯示；`answer` 保留為「回覆」。
  - 誰可以寫：`blocked`：目前負責人（私人任務 = 本人）；`resolved`：負責人、指派者或小組負責人；`step`：只由 node 在步驟完成時寫入（作者 = 勾選的人）。
  - **卡住了的狀態**：`blocked`（或舊的 `question`）紀錄之後沒有指向它的 `resolved`、也沒有 `close` → 「卡住中」（結案視為全部解決）；同時有多筆時顯示最新一筆；卡住天數 = 現在 − 紀錄時間（日）。
  - **通知**：套用含新 `blocked` 紀錄的 change 後，若本人是該小組負責人或該任務的指派者（且不是作者），發桌機通知「〈作者〉卡住了：〈任務〉」（受 §16.17 `notify.blockers` 控制）；小組沒有負責人時通知管理者。伺服器不參與。
- **私人任務**（v0.19，D46）：存在 `member/<id>/tasks`（`PK_member`，只有本人讀寫），結構與 `team/<id>` 的 `task:` 相同（不含 `profile:`）。介面與命令以 `teamId = "private"` 表示；負責人固定為本人、步驟沒有負責人；不出現在小組頁，不能連結到對話（§14.2）。
- **焦點**（feature-plan §5.4）：候選（含私人任務）為指派給我、或下一個未完成步驟指派給我的未完成任務；依「期限最近 → 卡住別人（下一步負責人不是我但我負責的步驟未完成）→ 指派給我 → 建立時間」排序。手動選擇的焦點只存在本機（secret 檔 `focus`），任務完成或刪除時回到自動。

`Directory`（§4.2）由 org 文件投影提供。M0 建立組織時自動建立一個預設小組。

### 16.10 計劃文件（v0.15，D8、D43「階梯」；v0.19 依 D46 取消日層級）

```
member/<id>/plans/{private | team/<teamId> | org} = {
  "item:<planItemId ULID>": {
    level: year|quarter|month|week,
    period: "2026" | "2026-Q4" | "2026-11" | "2026-W45",
    title, parentId?, krRef?: "<上層 planItemId>/<krId>",
    alignedGoalId?,                // v0.20（D47）：年 / 季，指向公司目標或小組目標（§16.14）
    criteria: [ { id, text } ],    // v0.20（D47）：年 / 季「做到的標準」，純文字，0–5 個，不影響進度
    helps: [ criterionId ],        // v0.20（D47）：季，幫助達成上層年目標的哪些標準（只供顯示）
    done: boolean,                 // 月 / 週
    progressOverride?: 0..100,
    keyResults: [ { id, title, start, target, current, unit, manual } ],   // 年 / 季，0–5 個
    review?: { outcome: achieved|partial|missed|dropped, percent: 0..100,  // v0.36（D67）：回顧或調整的結果
               note?: string, carriedTo?: planItemId, at },
    createdAt, updatedAt
  }
}
```

- 只有本人可寫（§4.1）；`keyResults` 整筆替換（與任務步驟相同），`done` 單獨修改。
- **v0.19（D46）**：寫入時拒絕 `level = day`；既有的日目標（M1 試用前的測試資料）讀取時略過、不顯示。週目標之下為任務（§16.8）。
- `period` 依**組織時區**（org `timezone`）計算，週為 ISO 週（週一開始，跨年週屬於含週四的那一年）；寫入時檢查格式與 `level` 相符。
- 改變可見度：在新文件寫入同一 id，再從舊文件刪除；同一 id 同時出現在兩份文件時取 `updatedAt` 較新者。
- **v0.20（D47）**：`alignedGoalId` 只用於年 / 季，指向公司目標（org 文件 `direction:<id>`）或小組目標（`team-goals/<teamId>` 的 `goal:<id>`）；寫入時檢查目標存在。所指的方向或小組目標被刪除時，讀取端視為未對齊。取代原預留的 `alignedTeamGoalId`。`criteria`（每則 1–80 字）與 `helps` 只供引導式介面顯示，不參與進度彙總；`helps` 指向的標準不存在時略過。

- **v0.36（D67）`review`**：期末回顧或「調整目標」寫入，只有本人可寫。`note` 0–200 字；`percent` 0–100；`carriedTo` 須為同一位擁有者的計劃項目（延到下一期時新建的那一個），寫入時檢查存在。寫入 `review` 時介面同時設定：`achieved` / `partial` / `missed` → `progressOverride = percent`（月 / 週另設 `done = true`）；`dropped`（不做了）→ 保留紀錄、`done = true`（月 / 週）。延到下一期：在下一期建立同層項目（同 `parentId`、`krRef`、可見度），原項目寫 `carriedTo`；未完成而連到原項目的任務可一併改連新項目（§16.8 `planItemId`）。回顧的 `note` 由本人的月報 / 季報帶入「差異原因」（kind = `other`，前綴目標名稱；§16.13）。MCP `list_goals` 回傳 `review`，不提供寫入工具。

**進度彙總**（0–100，由投影層計算，不存入文件）：

- 待辦（月 / 週）：子項目（月 → 週目標）與連結的任務（週目標，§16.8 任務進度）合併平均；都沒有時完成 = 100、未完成 = 0。
- 關鍵結果：`manual` 為真 → `(current − start) / (target − start)`（限制在 0–100）；否則有以 `krRef` 連結的待辦 → 其平均；都沒有 → 以 `current` 計算。
- 年 / 季目標：有關鍵結果 → 關鍵結果平均；否則子項目平均；都沒有 → 0。
- `progressOverride` 優先於自動計算；讀者看不到的子項目與任務不列入計算。
- **v0.36（D67）**：`review.outcome = dropped` 的子項目不列入上一層的平均（也不列入關鍵結果以 `krRef` 計算的平均）；它本身的進度仍顯示 `progressOverride`。

### 16.11 知識庫（v0.16，D42「星空」）

```
kb/meta = {
  "cat:<ULID>":   { name, createdAt, createdBy, mergedInto? },
  "topic:<ULID>": { name, categoryId, createdAt, createdBy, mergedInto? },
}
kb/items/<yyyy-mm> = {                       // 依知識 id（ULID）的建立月份（UTC）分份
  "<作者 memberId>:<ULID>": "<JSON 字串>"     // 見下
}
KbItem JSON = { v: 1, title, body, format? /* v0.29：markdown（預設）| html */, spec? /* v0.29："hills-doc/1" | 無 */, tags: string[], topicId,
                refs: string[] /* 其他知識的 key */, source, createdAt, updatedAt, updatedBy }
source = { kind: "manual" }
       | { kind: "message", convId, messageKey }
       | { kind: "file", convId, attachment /* §14.2 Attachment，含 fileKey */ }
       | { kind: "task", teamId, taskId }
```

- **寫入規則**：
  - `kb/meta`：任何成員可建立分類與主題、改名、合併（設定 `mergedInto`）；讀取時沿 `mergedInto` 鏈找到最終的分類 / 主題（遇到循環時停在鏈上 id 最小者）。
  - `kb/items/*`：任何成員可新增；驗證層規則 `own_keys_or_admin`——每個 op 都必須在根物件上放入字串或刪除 key，且 key 以作者 memberId 開頭；管理者可修改或刪除任何 key。因此「只有作者與管理者能編輯或刪除」在驗證層強制，不只是介面限制。
- **關聯**（投影層計算，不存入文件）：引用 = `refs`；同主題 = 相同（合併後的）主題；同任務 = 相同來源任務；同對話 = 相同來源對話。被引用次數 = 其他知識 `refs` 指到它的數量。`refs` 指到不存在的知識時忽略。
- 限制：標題 1–200 字、內容 ≤ 64 KB、標籤 ≤ 10 個、引用 ≤ 20 個、附件 JSON ≤ 512 KB。
- **格式與規格**（v0.29，D52）：`format = html` 時內容在存檔前清理、只在沙盒顯示（§16.16）；聲明 `spec` 的知識存檔時檢查必填段落（摘要、內容），沒有聲明的舊資料照常顯示。`source.kind = task` 的知識在介面標示來源任務；作者是 AI Agent 時標「AI 產生」（§19）。
- **隱私**：知識內容與 `source` 全組織可讀。從對話「存成知識」會把該訊息內容與 convId 公開給全組織；從檔案建立會把附件（含 `fileKey`）公開，等於全組織都能下載該檔案，介面在送出前明確提示。伺服器仍只看到 `GK` 密文。
- M3 的 AI 歸納建議存為本機的待套用項目，使用者按「套用」後才以上述格式寫入（D17）。

### 16.12 每日 Scrum（v0.17，feature-plan §5.4、D21）

```
member/<id>/scrum/<teamId>/<yyyy-mm> = {
  "day:<yyyy-mm-dd>": "<JSON 字串>"     // 一天一份，依組織時區
}
ScrumReport JSON = { v: 1, date, done: Ref[], today: Ref[], blockers: Blocker[],
                     submittedAt, updatedAt }
Ref     = { kind: "task", teamId, taskId, title } | { kind: "plan", planId, title } | { kind: "text", title }
          // 私人任務送出時記為 kind: "text"（小組讀者看不到私人任務）
Blocker = { text, notified: MemberId[] }
```

- 成員可能屬於多個小組：送出時**把同一份 Scrum 寫入每個所屬小組的文件**（`TK_team` 加密、只有該小組成員能讀），每個小組都看得到；讀取時同一天出現多份取 `updatedAt` 較新者。只有本人可寫（§4.1）。
- `Ref.title` 在填寫時複製進來，讀者看不到來源任務或計劃時仍能顯示。每區最多 30 項，每項 1–200 字。
- **帶入**（v0.19，D46）：「從任務帶入」→ 昨天以來（週一從上週五起）完成的任務與步驟；「從今天的任務帶入」→ 焦點任務、今天到期與進行中的我的任務。日目標已取消。
- 草稿只存在本機（不同步）；按「送出」才寫入文件。送出後可再修改，覆寫同一天並更新 `updatedAt`。
- **阻礙通知**：送出時 `notified` = 各所屬小組的負責人（`leadIds`）；小組沒有負責人時為全體管理者。負責人的裝置收到 `notified` 含自己、且有阻礙的新 Scrum 時發桌機通知（本機判斷，伺服器不參與）。
- **提醒**：組織預設時間存在 org 文件 `scrumReminder: "HH:MM"`（管理者可改，預設 `17:30`），個人可在本機覆寫（本機設定檔，不同步）。工作日依 §7.1；**M1 第一版在假日曆（backlog #6）與請假（#14）尚未實作前，只排除週六與週日**。當天已送出就不提醒，每天最多提醒一次。
- v0.31（D57）：提醒時間以**本人時區**（§16.17 `timezone`，未設定時用裝置時區）解讀；不在本人 `workHours.days` 的日子不提醒（取代上面的「週六與週日」）；本人的通知偏好 `scrumReminder` 關閉時不提醒。週報提醒（§16.13）套用同樣的工作日與開關。

**v0.34（D60）改名「每日任務」**：文件 key 不變（`member/<id>/scrum/<teamId>/<yyyy-mm>`，`day:<date>`），JSON 改為 v2：

```
DailyTasks JSON = { v: 2, date,
  done:    [ { log: "<log key>" | null, ref: Ref, text?, percent? } ],   // 引用任務紀錄；手動項目 log = null
  today:   [ Ref ],
  blocked: [ { log: "<blocked log key>", ref: Ref, text, since } ],      // 未解決的卡住了
  note?,                                                                  // 一句話，≤ 200 字
  submittedAt, updatedAt }
```

- **草稿**（本機計算）：`done` = 期間內（昨天以來；週一從上週五起）我寫的 `step`、`progress`（有百分比或文字）、`close` 紀錄，以及沒有紀錄的手動完成項；`today` = 焦點、今天到期、進行中與今天排入的我的任務；`blocked` = 我負責的任務中卡住中的 `blocked` 紀錄。本人可取消勾選、補手動項目與 `note`。私人任務照舊只帶標題（`kind: "text"`）。
- `blocked` 不再另外通知（紀錄寫入時已通知，§16.8 v0.34）。
- 讀取 v1（`blockers`）時轉為 `blocked`（`log: null`）；v1 不再寫入。
- 送出時一併把修正後的前一天時間寫入 worklog（§16.18）。
- 介面名稱、提醒文字、通知偏好標籤改為「每日任務」；`scrumReminder` 欄位名稱不變。
- **日報取消**（D60）：`report:daily:*` 不再產生；既有資料唯讀顯示。日報改由匯出產生（§16.13 v0.34）。

### 16.13 日 / 週報（v0.18，feature-plan §5.5、D32、D16）

```
member/<id>/reports/<teamId>/<yyyy> = {
  "report:<daily|weekly>:<period>": "<JSON 字串>"     // period = 2026-11-09 或 2026-W45
}
Report JSON = { v: 1, kind, period,
                sections: { progress, okr, attendance, next },   // 皆為 Markdown
                publishedTo: teamId[], generatedAt, publishedAt, editedAt? }
```

- `<yyyy>` 為期間所屬年份（ISO 週以週的年份）。發佈到哪些小組就寫入那些小組的文件（`TK_team`，只有該小組成員能讀；預設為全部所屬小組，D16）；這次取消的小組，從該小組文件刪除。只有本人可寫。
- 草稿只存在本機；按「發佈」才寫入文件，之後可修改再發佈（覆寫）。各欄最多 32 KB。
- **產生規則**（前端依組織時區計算，產生後可自由編輯）：
  - 完成 / 進行中 / 阻礙：期間內我送出的 Scrum 的完成項與阻礙，加上期間內我完成的任務 / 步驟；進行中 = 指派給我、狀態為進行中或審核的任務。
  - OKR 進度：我的年 / 季目標與關鍵結果目前的進度（§16.10 彙總）；週報另列本週完成的週目標。
  - 工時與出勤摘要：假勤上線前為固定說明文字（backlog #7、#9）。
  - 下期計劃：日報 = 下一個工作日到期的我的任務，加上當天 Scrum「今天計劃」中尚未完成者；週報 = 下週的週目標與下週到期的任務（v0.19 依 D46 移除日目標）。
- **小組彙整**：把同一小組成員同期間已發佈的報表依欄位合併顯示，不另存。
- 週五（組織時區）到 Scrum 提醒時間時，若本週週報尚未發佈，提醒一次；開啟報表頁時若沒有草稿也沒有已發佈的週報，自動產生草稿。
- 月報、年報在 M5；AI 摘要在 M3；發佈到小組頻道在 M2（頻道上線後）。

**v0.34（D61）改為「報告」**：週報 JSON v2（同一個 key `report:weekly:<YYYY-Www>`）：

```
Report JSON v2 = { v: 2, kind: "weekly", period,
  summary,                          // 一段話；summaryEdited: bool（true 時重新產生不覆蓋）
  summaryEdited,
  time:     [ { project: teamGoalId | "other" | "nontask", minutes } ],          // 只到專案層級
  projects: [ { project: teamGoalId, title, start, end, mine } ],               // 進度 0–100，mine 為我的貢獻（百分點）
  plan:     { minutes: [ { project, planned, actual } ], tasks: { planned, done, carried } },
  reasons:  [ { kind: "blocked" | "underestimate" | "unplanned" | "reopened" | "leave" | "other", text, minutes? } ],
  doneMd, nextMd,                   // Markdown（做了什麼、下期）
  publishedTo: teamId[], generatedAt, publishedAt, editedAt? }
```

- 發佈到小組（`TK_team`）的內容**只有專案層級**的時數與比例，不含逐筆時間（D62）。v1（四個 Markdown 欄位）照舊可讀。
- **計算**（前端，依組織時區）：
  - `time`：期間內 worklog 的分鐘數依任務 → 週目標 → … → 對齊的小組目標歸到專案；任務沒有連到小組目標 → `other`；會議、訊息與零碎 → `nontask`。組長以外的讀者只看到比例與時數合計。
  - `projects`：專案期初 / 期末進度取自本人方向摘要（§16.14）與小組目標進度；`mine` = Σ（我對齊該小組目標的個人季目標進度變化）÷ 對齊該小組目標的個人目標數（只計讀得到的）。
  - `plan`：計劃 = 週計劃快照（§16.18）各專案預估分鐘數；實際 = `time`；**時間偏移** = Σ|實際 − 計劃| ÷ Σ計劃；`tasks` = 快照中的件數、其中完成的件數、延到下期的件數。沒有預估的任務列為「未估」，不計入偏移。
  - `reasons`（自動找出，本人可增刪）：卡住了（期間內卡住中的天數與受影響專案）、預估過低（實際 ≥ 1.5 × 預估）、計劃外（快照之後新增且有時間的任務）、退回重做（期間內 `reopen` 紀錄）、請假（假勤上線後）。
  - `summary`：固定句型（投入最多的專案與時數、前進多少；其他專案、計劃外與非任務時間；完成件數、時間偏移、前兩個原因），只在本機產生，不經外部服務。
- **延到下期**：發佈時對勾選的未完成任務一併 `update_task`（期限移到下週一同一時間；週目標改為本人下週同名週目標，沒有時建立）；在週報 `plan.tasks.carried` 記件數。
- **只匯出的報告**（日 / 月 / 季 / 年）：本機由 worklog、任務紀錄、週報與方向摘要彙整成同樣的六段，不寫入任何文件。日報 = 當天的每日任務 + worklog；月 / 季 / 年 = 期間內每週資料加總、計劃取每週快照的加總，`projects` 期初取期間第一週的方向摘要（方向摘要只保留 8 週，更早的取當週已發佈週報的 `projects.start`）。
- **匯出格式**：PDF（系統列印，只印報告內容）、Markdown（六段為 `##` 標題，hills-doc 以外的一般文件）、CSV（每列一筆：日期、任務、專案、分鐘、來源；小組 / 全公司範圍只輸出專案層級彙總）。
- **範圍**：我自己；小組（該小組負責人：成員逐人時間可讀，§16.18；其他成員只有專案層級）；全公司（管理者：只用已發佈的週報，專案層級）。
- 月報、年報的發佈（原 M5 規劃）取消；AI 摘要（M3）仍需本人確認（D17）。

### 16.14 團隊方向（v0.20，D47）

```
org = { …,
  "direction:<ULID>": { year: "2027", title, keyResults: [ KeyResult ], createdAt, updatedAt }
}
team-goals/<teamId> = {
  "goal:<ULID>": { year: "2027", title, directionId?, keyResults: [ KeyResult ], criteria: [ { id, text } ], createdAt, updatedAt },
  "weekNote:<YYYY-Www>": "<JSON 字串>"     // v0.22：負責人的這週重點 { text（1–200 字）, author, updatedAt }，保留最近 8 週
}
```

- **公司目標**存在 org 文件，只有管理者可寫（org 文件規則），每年建議 1–3 個（介面限制 5 個）。
- **小組目標**存在 `team-goals/<teamId>`，以 `GK` 加密，全員可讀（D47 全員透明）。寫入者是該小組的負責人（org `teams.<id>.leadIds`）或管理者，由驗證層檢查（`DocKind::TeamGoals`，`Directory::is_team_lead`）。`directionId` 指向同一年的公司目標（選填）。
- 標題 1–80 字；`keyResults` 結構與計劃相同（§16.10），最多 5 個；小組目標的 `criteria`（做到的標準）同計劃，純文字、不影響進度。
- **對齊**：個人的年 / 季目標以 `alignedGoalId` 指向公司目標或小組目標（§16.10）。一個目標只對齊一個。
- **進度**（投影層計算，0–100）：
  - 有關鍵結果 → 關鍵結果平均（規則同 §16.10）；
  - 否則小組目標 = 對齊它的個人年 / 季目標進度平均；公司目標 = 對齊它的小組目標與直接對齊它的個人目標平均；
  - 都沒有 → 0。只計算讀者看得到的個人目標（§4.3），所以不同讀者可能看到不同數字；第 2 批的方向摘要（本節後續）讓全員看到一致的比例。
- 刪除公司目標或小組目標時不連帶修改他人的文件；對齊它的目標讀取時視為未對齊（介面提示重新選擇）。
**OGSM**（v0.35，D65）：公司與每個小組各一份；沿用上面的文件，只新增 key。

```
org = { …,
  "purpose": "<JSON 字串>"            // 公司目的 { title（1–120 字）, why（≤ 1000 字）, period（≤ 20 字，例如 "2026–2027"）, updatedAt, updatedBy }
}
team-goals/<teamId> = { …,
  "purpose": "<JSON 字串>",           // 小組目的：同上，另加 goalIds（它服務的公司目標 id，0–5 個）
  "strategy:<ULID>": "<JSON 字串>"     // 策略，見下
}
Strategy = { title（1–80 字）, how?（≤ 300 字）, goalIds: [小組目標 id]（1–5 個）, owners: MemberId[]（≤ 10）,
             measures: [Measure]（≤ 5）, order: number, createdAt, updatedAt }
Measure  = { id, title（1–80 字）,
             source: { kind: "goal", goalId, krId? }                        // 小組目標或其關鍵結果的進度
                   | { kind: "manual", current, target（> 0）, unit?（≤ 10 字）, updatedAt } }
```

- **對應**：公司 OGSM = 目的（org `purpose`）→ 公司目標（`direction:*`，介面名稱由「公司方向」改為「公司目標」）→ 策略（`directionId` 指向它的小組目標）→ 衡量（小組目標進度）。小組 OGSM = 目的（`team-goals` `purpose`）→ 小組目標（`goal:*`）→ 策略（`strategy:*`）→ 衡量（`measures`）。行動計劃 = 對齊這些目標的個人目標與其任務（§16.10、§16.8），不另存。
- **寫入**：org `purpose` 只有管理者（org 文件規則）；`team-goals` 的 `purpose`、`strategy:*` 與小組目標相同，該小組負責人或管理者（驗證層 `DocKind::TeamGoals` 不變）。寫入時檢查 `goalIds` 指向同一小組現存的小組目標、`krId` 存在、`owners` 是該小組成員；讀取時參照已不存在的項目略過。
- **進度**（投影層，0–100）：衡量 `goal` = 該小組目標（或關鍵結果，規則同 §16.10）的進度；`manual` = min(100, current ÷ target × 100)。策略 = 衡量平均；沒有衡量時 = `goalIds` 所指小組目標的進度平均。**不設紅黃綠門檻**，狀態以進度與「應到」（依期間經過比例）呈現，個人層級沿用往山丘走。
- **我的角色**（投影層，只在本人的裝置計算）：所屬小組的目的與策略；`owners` 含我的策略；對齊這些小組目標的我的年 / 季目標；這週連到這些目標的任務；本週計時花在這些專案（小組目標）的比例（§16.18，只有本人）。
- 限制：每個小組策略 ≤ 10 個；刪除小組目標時不連帶修改策略，讀取時從 `goalIds` 略過，全部略過時介面提示重新選擇。

**方向摘要**（v0.21，第 2 批）：

```
member/<id>/direction = {
  "week:<YYYY-Www>": "<JSON 字串>",      // 最近 8 週，較舊的在發佈時刪除
  "suggest:<ULID>": "<JSON 字串>"        // 我送給別人的對齊建議
}
DirectionWeek = { v: 1, week, units, alignedUnits, quarterProgress: number | null,
                  goals: [ { id, title, progress, alignedGoalId? } ],   // 本季我的季目標，不含私人
                  privateGoals,                                       // 私人季目標的數量
                  lastActivity, openTasks, dueThisWeek, updatedAt }
Suggestion    = { v: 1, to: memberId, planItemId, goalId, createdAt }
```

- 只有本人可寫、全員可讀（`GK`，D47 全員透明）；伺服器看不到內容。每則最多 16 KB；`goals` 最多 20 個。
- **由本人的 App 計算**（前端，依組織時區，同 §16.13）：啟動後與任務 / 目標變更後 30 秒內重算，與上次發佈的內容（不含 `updatedAt`）相同時不寫入。計算只用本人看得到的資料：
  - `units`（這週完成的事）= 這週完成、負責人是我的步驟（步驟沒有負責人時看任務負責人）＋ 這週完成、沒有步驟、負責人是我的任務（`doneAt` 在這週）；私人任務也算。
  - `alignedUnits` = 其中所屬任務的 `planItemId` 往上（週 → 月 → 季 → 年，經 `parentId`）有任一層設定了 `alignedGoalId` 者。
  - `goals` = 我這一季的季目標（含所屬年目標的對齊：季目標沒有 `alignedGoalId` 時沿用 `parentId` 年目標的）；`quarterProgress` = 已對齊的季目標進度平均，沒有已對齊的季目標時為全部季目標平均，沒有季目標時為 null。
  - `lastActivity` = 我完成步驟 / 任務、或修改自己目標（`updatedAt`）的最近時間。
  - `openTasks` / `dueThisWeek` = 指派給我、未完成的任務數，以及其中這週到期的數量（第 5 批「負荷外圈」使用）。
- **四項檢查**（讀者端計算，門檻取 org `directionRules`，沒有時用預設值）：
  1. **目標沒對齊團隊**：最新摘要的 `goals` 都沒有 `alignedGoalId`（含沒有季目標，但 `privateGoals > 0` 時不判定，介面註明「有私人目標」）。
  2. **時間花在別的事**：本週 `units > 0` 且 `alignedUnits / units × 100 < minAlignedShare`。本週沒有摘要或 `units = 0` 時不判定。
  3. **進度落後時程**：`quarterProgress < 本季經過比例 × 100 − behindPoints`。
  4. **太久沒更新**：`現在 − lastActivity ≥ staleDays` 天（本人沒開 App 也能判定）。
  - 狀態：第 4 項成立 → 「太久沒更新」；其他任一項成立 → 「可能偏離」；都不成立 → 「在路上」；沒有任何摘要 → 「還沒有資料」。
  - **角度**（方向羅盤）= 90° ×（1 − alignedUnits / units）；`units = 0` 時為 0° 並以灰色顯示。**長度** = `quarterProgress`。
- **對齊建議**：任何人可以對「目標沒對齊團隊」的成員送出建議（寫在自己的文件，`to` 為對象、`planItemId` 為對方摘要中的季目標、`goalId` 為小組目標）。對象的 App 讀取所有成員文件中 `to` 為自己的建議，在目標首頁顯示，按「套用」才修改自己的目標（只有本人可寫計劃，D17 精神）；「不用了」記在本機。建議 30 天後不再顯示。
- **隱私**：摘要讓全員看到比例、季目標標題與進度（D47 的決定）；私人目標只計數量，私人任務只算進 `units`，不露標題。私人任務多的人可能被判為「時間花在別的事」，介面註明。
- **四週軌跡與大家實際走向**（v0.22，第 4 批）：讀者端由摘要的歷史週（最多 8 週，取最近 4 週）計算每週的角度與進度；大家實際走向 = 本週 `units > 0` 的成員角度的向量平均（每人固定畫在左或右側，由成員 ID 決定）。
- **週一方向時刻的預測**（v0.22）：只在本機計算，不寫入；預測比例 =（本週 `alignedUnits` + 選了對齊鏈週目標的未完成任務數）/（本週 `units` + 列出的未完成任務數）。按「好，開始這一週」只修改這些任務的 `planItemId`（一般的任務更新，§16.8）。


**往山丘走**（v0.34，D59）：小組方向的預設畫面，資料與四項檢查同上，另加「往後退」：
- **狀態**（依序判定，取第一個成立的）：停下來（第 4 項）→ 往後退（本週 `quarterProgress` 比上週低 1 個百分點以上，原因多為退回或回報百分比下降）→ 方向歪了（第 1 或第 2 項）→ 走太慢（第 3 項）→ 在路上；沒有摘要 → 還沒有資料；本人狀態為休假 → 休假（畫在雲上，不列入統計）。
- **位置**：往前 = `quarterProgress`（0 = 起點、100 = 山頂；「今天應到」虛線 = 本季經過比例）；左右 = 角度（每人固定在左或右側，由成員 ID 決定，同大家實際走向）；足跡 = 前 3 週的位置。
- 表格檢視列出四項檢查的數字依據與四週的 `alignedUnits / units` 長條，作為無障礙替代。

### 16.15 小組管理與小組金鑰交接（v0.25，D49）

**文件**

```
org.teams.<teamId> = { name, archivedAt?, leadIds?, memberIds? }   // 名稱與封存由管理者寫；舊的名單為後備值
team-roster/<teamId> = {                                          // GK，全員可讀；寫入者 = 管理者或該小組負責人
  members: [memberId..],          // 至少一位
  leads:   [memberId..],          // members 的子集
  removals: n,                    // 有人被移出就 +1
}
team/<teamId>."keyRotatedFor" = n // 已為第 n 次移出輪替（小組成員寫）
```

- `team-roster/<teamId>` 存在且有 `members` 時，投影（`Directory`、`teams_of`）以它的名單為準；否則用 org 文件的 `memberIds` / `leadIds`（D49 之前的組織）。寫入權限由驗證層檢查（`DocKind::TeamRoster`，寫入者是管理者或依目前投影的該小組負責人）。
- **建立小組**（管理者）：org 寫入名稱，`team-roster` 寫入成員與負責人；管理者裝置產生 epoch 0 的 TK，封裝給全部成員；管理者不在成員中時不存入自己的金鑰環（D49）。
- **改名、封存**（管理者）：只改 org 文件。封存的小組不出現在選單與小組頁，名單、文件與金鑰保留，可再取消封存。
- **加入 / 移出、設定負責人**（管理者或該小組負責人）：整份覆寫 `members`、`leads`；這次有人被移出時 `removals + 1`。小組至少一位成員，負責人必須是成員。核准加入申請時選的小組也寫入 `team-roster`（沒有時寫入 org 的後備名單）。停用成員時從所有 `team-roster` 移除。

**交接（每台持有 TK 的成員裝置，同步迴圈中執行）**

1. 對名單上每位有效成員（不含自己）：本機紀錄（secret 檔 `team-handover`，key = `小組 / 成員 / EK / 最新 epoch`）中沒有時，把持有的全部 epoch 封裝給他、簽章、放入 `key_outbox`，並記下。重複封裝無害：mailbox 同一收件者、同一 EK、同一 keyId 只保留第一份。
2. **輪替**：`team-roster.removals` 大於 `team.keyRotatedFor`，且本裝置是**指定輪替裝置**時，以 `rotate()` 產生下一個 epoch 封裝給名單上全部有效成員，再以新 epoch 寫入 `team.keyRotatedFor = removals`。
   - 指定輪替成員：負責人中 memberId 最小者；沒有負責人時取成員中最小者。指定輪替裝置：該成員有效裝置中 DevicePub 最小的一台。
   - 指定輪替裝置還沒有 TK 時等交接完成再輪替；不在線時延後，介面顯示「金鑰交接中」。
3. 名單上沒有任何持有 TK 的人時（例如持有者全被移出）無法交接，留下的人讀不到小組內容；M1 接受此限制，介面在移出時提醒「至少留一位已持有金鑰的成員」。

**接受規則（收件端 `accept_keys`）**

- 小組 TK：簽署者是管理者，或依目前投影是該小組成員；epoch 大於本人已持有的最新 epoch 時，簽署者必須是管理者或指定輪替成員。
- 不符合的封裝（常見原因是名單文件比金鑰晚到）暫存在 secret 檔 `keys-deferred`（最多 500 筆），下載文件後與每次同步時重試。
- mailbox 的 `PutKeys` 對小組 TK 只檢查簽署者是有效成員（§16.7）。

**介面資料**：小組列表回傳名稱、成員、負責人、是否封存，以及本人是成員卻還沒有 TK 時的 `awaitingKey`（「金鑰交接中，等小組成員上線」）。

### 16.16 文件規格 hills-doc/1（v0.29，D52）

適用：知識（§16.11）與結案報告（§16.8）。`spec = "hills-doc/1"`，`format = markdown | html`。

**段落**

| 文件 | 必填 | 選填 |
|------|------|------|
| 知識 `knowledge` | `summary` 摘要、`content` 內容 | `points` 重點、`sources` 來源 |
| 結案報告 `report` | `summary` 結果摘要；任務有完成條件時 `criteria` 完成條件對照 | `outputs` 產出、`issues` 問題與風險、`next` 後續建議 |

- 段落 key 為 `[a-z][a-z0-9-]{0,31}`；不在上表的 key 必須以 `x-` 開頭，或不寫 key，都視為**自訂段落**（照原樣顯示，擷取時 key 為 `x-…` 或 `null`）。同一 key 出現兩次時取第一個，其餘視為自訂段落。
- **Markdown**：第一個 H2 之前為前言；每個 H2 開始一個段落，標題結尾的 `{#key}` 為段落 key（顯示時移除並作為錨點）；H3 以下屬於所在段落。
- **HTML**：根為 `<article data-hills-doc="1">`（缺少時視為整份是一個前言）；`<section data-section="key">` 為段落，段落標題為其中第一個 `h2`。自訂段落可帶 `class`、`style`，文件可帶一個 `<style>` 區塊（只作用於沙盒內）。
- **驗證**：寫入端（App、MCP、hills-agent）存檔前檢查必填段落存在且內文非空，Rust 端（`hills_node::doc_spec`）再檢查一次；缺少時回錯並列出缺少的 key。只有聲明 `spec` 的文件才驗證。
- **擷取**：`sections = [{key, title, text}]`，text 為純文字（Markdown 去除標記、HTML 取 textContent）；列表摘要取 `summary`，沒有時取前言前 140 字。MCP `get_knowledge(key, sections?)` 只回傳要求的段落。

**HTML 清理與顯示**

- 清理（DOMPurify，存檔前與顯示前各一次）：允許結構、文字、清單、表格、`details`、`figure`、`img`（只限 `data:` 圖片）、`a`（只限 `http(s):`、`mailto:`、`#`）、`class`、`style`、`<style>`、`data-*`；移除 `script`、所有 `on*` 屬性、`iframe` / `object` / `embed` / `form` / `input` / `base` / `link` / `meta`，以及 `style` 中的 `url(...)`（`data:` 除外）與 `@import`。
- 顯示：`<iframe sandbox="allow-same-origin" srcdoc>`——不允許腳本、表單、彈出視窗；srcdoc 繼承 app 的 CSP（`script-src 'self'`、`img-src 'self' data: blob:`），外部資源一律載入失敗。外層注入 Hills 閱讀樣式（字型、色彩 token、表格、程式碼），讀取內容高度調整 iframe；點擊連結時攔截並以外部瀏覽器開啟。
- 原始碼檢視以等寬字顯示清理後的 HTML。
- 經 MCP / hills-agent 寫入的 HTML 不經前端清理：Rust 端（`kb_save`）拒絕含 `<script`、`<iframe`、`javascript:` 或 `on*=` 事件屬性的內容，其餘照存；顯示前一律再清理並放在沙盒中。
- 測試環境：前端以 jsdom 驗證清理結果（DOMPurify 在不支援的環境下不輸出任何標記，只輸出跳脫後的文字）。

### 16.17 個人資料與通知偏好（v0.31，D57）

```
member/<id>/profile = {
  "displayName": "小美",                  // 1–40 字（去頭尾空白）；空字串 = 用 org 名冊的 name
  "timezone": "Asia/Taipei",              // IANA 名稱；空字串 = 裝置時區
  "workHours": "{\"days\":[1,2,3,4,5],\"start\":\"09:00\",\"end\":\"18:00\"}",  // JSON 字串；days 1 = 週一 … 7 = 週日
  "updatedAt": 1762650000000
}
member/<id>/secrets 另加：
  "notify": "{\"messages\":true,\"assigned\":true,\"blockers\":true,\"scrumReminder\":true}"
```

- **權限**：`profile` 是 §4.1 的本人文件（`DocKind::Member`，section `profile`），驗證層只接受本人裝置的 change；以 `GK` 加密，全員可讀。不經 mailbox 明文（與其他文件相同）。
- **驗證**（寫入時，hills-node）：`displayName` 0–40 字、不含控制字元；`timezone` 為空或符合 IANA 名稱格式（英數字與 `/ _ - +`，≤ 64 字；Rust 端只檢查格式，前端以 `Intl` 確認時區存在，不另引入時區資料庫）；`workHours.days` 為 1–7 的不重複整數（可以是空陣列，代表沒有固定工作日）、`start` / `end` 為 `HH:MM` 且 `start < end`（不支援跨午夜）。讀取時不合格的欄位改用預設值。
- **名稱解析**：`displayName` 非空時所有畫面、通知標題、MCP（`whoami`、`list_members`、確認卡）都用它；否則用 org 名冊 `members/<id>/name`。管理者在「人與小組」的成員列表同時看到名冊姓名。名冊姓名仍只有管理者能改（§16.8）。
- **時區**：只用來換算本人的提醒時間與顯示「現在幾點」；期間代碼、週次、報表日期一律依組織時區（§16.10 不變）。
- **工作時段**：
  - 提醒：見 §16.12 v0.31。
  - 對同事：以對方的 `timezone` 與 `workHours` 計算現在是否在工作時段，不在時介面把該成員標為 `offHours`（前端以 `Intl` 計算，後端只回傳個人資料），名牌顯示「下班時間」，敲門提示（§16.8 延後通知）比照「專注中」。對方沒有個人資料時視為在工作時段。
- **通知偏好**（`secrets.notify`，只有本人的裝置讀得到）：`messages`（私訊與提及）、`assigned`（被指派任務）、`blockers`（小組成員回報阻礙）、`scrumReminder`（Scrum 與週報提醒），缺少的欄位視為 `true`。「新裝置加入」（§17.6）屬於安全通知，不受偏好影響。延後通知（專注、會議、午休）照舊在前；偏好關閉的類型不會進入延後摘要。
- **營地進度**（D56）由前端依現有資料計算，不寫入任何文件。

### 16.18 計時與工作紀錄（v0.34，D62）

```
member/<id>/timer = {                                    // PK_member，只有本人
  "running": "<JSON 字串>" | 不存在,                     // { current: WorkRef | null（暫停）, since, source: "start" | "focus" | "status", resume?: WorkRef }
  "seg:<ULID>": "<JSON 字串>"                            // { ref: WorkRef, start, end, source }；短於 30 秒不記
}
member/<id>/worklog/<yyyy-mm> = {                        // WK_member，本人與本人所屬小組的負責人
  "day:<yyyy-mm-dd>": "<JSON 字串>",                     // { v: 1, entries: [ { ref, project?, minutes, source: "auto" | "edited" | "manual" } ], attendance?, updatedAt }
  "plan:<YYYY-Www>": "<JSON 字串>"                       // { v: 1, tasks: [ { ref, estimate?, project? } ], capacity, createdAt }
}
WorkRef = { kind: "task", team, task, step?, title } | { kind: "meeting" } | { kind: "other", title }   // 私人任務 team = "private"
```

- **計時**（本機，hills-node 維護 `running`，前端顯示）：
  - 開始：任務列「開始做」、首頁焦點任務設定、狀態改為「專注」且有焦點任務。同時只有一件；開始另一件時先結束目前的片段。
  - 暫停：狀態改為會議（之後的時間記為 `meeting` 片段）、午休、暫離、離線，或 App 結束；狀態回到上線 / 專注時，若暫停前有計時則恢復同一件。
  - 閒置：系統閒置 15 分鐘先結束片段（end = 開始閒置的時間），回來時前端詢問是否補回（補回 = 延長片段）。
  - 「訊息與零碎」= 出勤（或工作時段）中沒有任何片段的時間，在整理時計算，不另存片段。
  - 片段跨午夜時由整理時依組織時區切開；`seg:` 保留 62 天，較舊的在寫入時刪除。
  - 週計劃快照存在週一所在月份的 worklog 文件。
- **整理**（每天第一次啟動、送出每日任務時）：把前一天（含未整理的更早日期，最多 7 天）的片段依 TaskRef 加總為 `entries`（15 分鐘四捨五入），寫入 worklog `day:`；`project` 由任務 → 週目標 → … → 對齊的小組目標求得（找不到則省略）。本人在每日任務卡修正後覆寫同一天，修正過的項目 `source = edited`、補的 `manual`。
- **週計劃快照**：「排這一週」按「好，開始這一週」時寫入 `plan:<week>`（任務、預估、專案，`capacity` = 本人工作時段時數 − 固定會議 − 請假）；一週只寫一次（之後再按會覆寫並記錄 `createdAt`）。週一 12:00 前沒寫的，第一次需要計劃時以「期限在這週、週一 12:00 之前就存在的我的任務」自動建立。
- **WK_member 交接與輪替**（本人的裝置執行，同步迴圈中）：
  - 收件人 = 本人的有效裝置 ∪ 本人所屬各小組（`team-roster`）負責人的有效裝置；沒有 WK 時由本人裝置中 DevicePub 最小的一台產生 epoch 1。
  - 對收件人中還沒拿到的，封裝持有的全部 epoch（本機紀錄 secret 檔 `worklog-handover`，key = `收件成員 / EK / 最新 epoch`）。
  - **輪替**：上次封裝過的負責人有人不再是本人任何小組的負責人（或本人離開了該小組）時，本人產生下一個 epoch 只封裝給目前的收件人；之後的寫入用新 epoch。舊 epoch 的文件不重新加密（卸任者仍讀得到卸任前的資料，與 TK 移出規則相同）。
  - **接受規則**（收件端 `accept_keys`）：`member:<id>:worklog` 的封裝，簽署者必須是該成員本人的裝置；mailbox `PutKeys` 同樣只接受本人封裝（比照 `PK_member`）。
- **權限**：`member/<id>/timer` 只有本人讀寫（`PK_member`）；`member/<id>/worklog/*` 只有本人寫，`can_read` = 本人或「本人所屬任一小組的負責人」（直連同步回應前檢查）。驗證層：兩者都是本人文件（`DocKind::Member`，section `timer` / `worklog/<yyyy-mm>`）。
- **介面資料**：本人看自己的 worklog 與計時狀態；負責人在「工作 › 小組」點成員時讀該成員 worklog（讀不到 = 金鑰交接中）。發佈的週報只含專案層級（§16.13 v0.34）。

### 16.19 檔案索引（v0.35，D64）

「檔案」頁列出本人看得到的所有附件。**不新增同步文件**：每台裝置從自己已解密的文件即時建立索引，伺服器看不到檔名與出處。

```
FileEntry = {
  key,                                   // 檔案：FileManifest.fileId；資料夾：manifestRef 的物件 id
  kind: "file" | "folder", name, size /* 資料夾為 totalSize */, mime?, fileCount?,
  sources: [ FileSource ],               // 依時間排序，第一筆 = 第一次分享
  downloaded?: { path, at },             // 本機下載紀錄（只在這台裝置）
  expiresAt,                             // 第一筆出處時間 + 儲存節點保留期（D16，預設 365 天）
  attachment                             // 第一筆出處的 §14.2 Attachment（只給介面，MCP 不回傳）
}
FileSource =
  | { kind: "message",    convId, messageId, author, at, excerpt }   // 對話訊息的 attachments（§14.2）
  | { kind: "taskReport", team, task, title, author, at }            // 結案報告的 attachments（§16.8）
  | { kind: "kb",         kbKey, title, author, at }                 // 知識的 source.kind = file（§16.11）
```

- **來源**：本人是現任成員、可讀的對話紀錄（只看得到加入後的 epoch，§14.2）；所屬小組與本人私人任務的結案報告；知識庫全部。看不到的出處不列，所以同一個檔案不同人看到的出處數可能不同。
- **合併**：同一個 `key` 在多處出現（轉傳、存成知識、附到結案報告會沿用同一份 manifest）只列一筆；重新上傳的同名檔案是不同的 `key`。
- `excerpt` = 訊息內文去除 Markdown 後的前 80 字。分享者 = 第一筆出處的作者；「我上傳的」= 第一筆出處的作者是本人。
- **下載紀錄**：`finish_download` 成功時把 `{ key → path, at }` 寫入本機資料夾的 `downloads.json`（不同步、不加密以外的保護同其他本機設定）；檔案被移動或刪除時，打開失敗即移除該筆。
- **前往出處**：介面依 `FileSource` 開啟對話並捲到 `messageId`、開啟任務詳情、或開啟知識；原訊息所在 epoch 已讀不到時顯示「已無法前往」。
- 介面的 `list_files` 一併回傳第一筆出處的原 `Attachment`（含金鑰，供下載，同對話中的附件卡）；MCP 的 `list_files`（§18.3）不回傳 `Attachment` 與任何金鑰。

### 16.9 部署（M0）

- `deploy/docker-compose.yml`：`relay`（iroh-relay，自帶 LetsEncrypt；TCP 80 / 443、UDP 7842）與 `mailbox`（固定 UDP 埠、`HILLS_RELAY` 指向自架 relay）；tsa、storage 隨 M1 加入。
- mailbox 啟動時印出 **mailbox 連線碼**（`hills-mbx1-` + base32(EndpointAddr)），建立組織時貼上。
- **綁定組織**：mailbox 未設定 `HILLS_ORG_ROOT_PUB` 時為「未綁定」狀態，第一位以組織根金鑰簽發之管理者憑證連線者即完成綁定（寫入資料庫，之後不可更換），未綁定前其他請求一律拒絕。部署後應立即建立組織；若要事先固定組織，可設定 `HILLS_ORG_ROOT_PUB`。
- 步驟見 [deploy.md](./deploy.md)。

## 17. 以 CAFECA 登入（v0.13，D41）

取代 §3.4–3.6、§16.2–16.4 的邀請碼、掃碼綁定與復原詞。協定依據 CAFECA「Sign in with CAFECA」（[CAFECA README](https://github.com/CAFECA-IO/CAFECA) §3–§5、§8）與其**原生 App 模式**（`mode: "relay"`，由 CAFECA 新增，本節列出 Hills 需要的內容）。CAFECA repo 未附授權條款，Hills 不複製其程式碼，只依公開協定實作（`crates/hills-cafeca`）。

### 17.1 設定與連線碼

- **CAFECA 錢包網址**（例如 `https://<錢包網域>`）是部署設定：mailbox 環境變數 `HILLS_CAFECA_WALLET`（必填），客戶端以 `Config` 請求取得（不需 Hello），不寫死在程式中（D20）。
- 鏈與合約設定取自 `<錢包>/.well-known/cafeca-configuration`（`chainId`、`rpcUrl`、`contracts.recovery` 等）；mailbox 可用 `HILLS_CAFECA_RPC` 改用自架 RPC。客戶端與 mailbox 各自快取 1 小時。
- **組織連線碼** `OrgTicket{v, org_root, mailbox}`（`hills-org1-`）保留，加入、新裝置、還原都從它開始；邀請碼 `InviteTicket` 與綁定碼 `LinkTicket` 移除。
- App ID：`io.cafeca.hills`（Hills 桌機 App 的套件識別碼）；登入請求的 `domain` 與 `uri` 固定為 `app://io.cafeca.hills`。

### 17.2 登入請求（原生 App 模式）

Hills 產生一把臨時 P-256 金鑰 `r`、中繼通道 id `ch`（16 bytes 隨機，hex）與請求 id `id`（16 bytes 隨機，hex），組出：

```
SignInRequest {
  v: 1,
  domain: "app://io.cafeca.hills", uri: "app://io.cafeca.hills",
  nonce,                                   // §17.3
  issuedAt, expiresAt = issuedAt + 600,    // Unix 秒
  mode: "relay",
  statement: "<動作>「<組織名稱>」· 確認碼 XXXX-XXXX",   // 動作：建立組織 / 加入 / 新增裝置 / 還原
  claims: ["handle"],
  relay: { ch, id, pub: base64url(r.pub 未壓縮 65 bytes) }
}
```

- 連結 `https://<錢包>/dl/auth?v=1&req=<base64url(JSON)>`：介面同時提供「在這台電腦開啟」（以系統瀏覽器開啟）與 QR Code（以手機上的 CAFECA 掃描）。
- 錢包簽署後，以自己的臨時 P-256 金鑰 `w` 加密回應，放入 CAFECA 中繼信箱 `/api/channel`（`op: "reply"`）；Hills 每 2 秒以 `GET /api/channel?ch=<ch>&r=<id>&res=1` 輪詢，最多到 `expiresAt`。
- 回應 Box：`{ v: 1, ch, id, epk: base64url(w.pub), iv, ct }`；金鑰 `K = HKDF-SHA256(ikm = ECDH(r, w), salt = ch, info = "CAFECA-channel-v1")`，`AES-256-GCM(K, iv, aad = "<ch>|<id>|res")`，與 CAFECA 簽章通道相同。解出的明文即 CAFECA 登入回應（README §4）；`error` 欄位為 `access_denied` 時顯示「已在 CAFECA 拒絕」。
- 中繼只看得到密文；`r` 只存在記憶體，登入結束即丟棄。

### 17.3 nonce 與確認碼

```
SignInBinding {
  v, org_id, kind: create | join | recover,   // join 同時用於加入與新增裝置
  device_pub: DK.pub,
  ik_pub: Option<IK.pub>,       // 申請裝置新產生的 IK
  key_pub: X25519 公鑰,          // 申請裝置新產生的 EK；新增裝置時作為接收封裝的臨時金鑰
  issued_at,
}
h       = blake3("hills/v1/cafeca-signin" ‖ postcard(SignInBinding))
nonce   = base64url(h)                       // 43 字元，符合 CAFECA 8–128 字元限制
確認碼  = base32(h[0..5]) 8 字元，以 XXXX-XXXX 顯示
```

- 登入簽章因此綁定裝置與金鑰：攔截到回應的人只能把**原本那台裝置**加入，無法換成自己的裝置。
- 錢包在授權畫面顯示 statement（含確認碼），Hills 同時以大字顯示確認碼，請使用者確認兩邊一致後再簽署（防 QR 轉送與假冒 App）。

### 17.4 登入證明與驗證

```
CafecaProof {
  v, binding: SignInBinding,
  chain_id: u64, account: [u8; 20],
  message: { domain, uri, nonce, issued_at, expires_at, statement, claims, channel },
  signature: bytes,
  handle: Option<String>,        // 回應中自稱的代稱，只供顯示
}
```

驗證（`hills-cafeca::Verifier`，mailbox 與客戶端共用）：

1. `message.nonce == nonce(binding)`；`message.domain == message.uri == "app://io.cafeca.hills"`；`message.channel == ""`；`message.issued_at == binding.issued_at`；`expires_at - issued_at ≤ 600`。
2. 時效：收到時（mailbox 的 `received_at`、或本機登入當下）早於 `expires_at`。管理者與本人裝置事後驗證時，以 mailbox 記錄的 `received_at` 判斷。
3. `chain_id` 等於 `.well-known` 設定。
4. `hash = EIP-712 hashTypedData({ name: "CAFECA Sign-In", version: "1", chainId, verifyingContract: account }, SignIn, message)`；`eth_call account.isValidSignature(hash, signature)` 必須回傳 `0x1626ba7e`。
5. 有 `contracts.recovery` 時，`recovery.isPending(account)` 必須為 false（身分恢復中不接受）。
6. 代稱以 `GET <錢包>/api/profile?q=<account>` 查詢，只用於顯示；查不到時顯示帳戶縮寫。
7. 不要求實名等級（D41）。

### 17.5 建立組織

1. 貼上 mailbox 連線碼 → `Config` 取得錢包網址。
2. 產生 OK、IK、EK、DK；登入（kind = `create`、`org_id = blake3(OK.pub)`）；本機驗證證明。
3. 由帳戶推導 memberId，OK 簽發第一張管理者 MemberCert（含 `cafeca`），IK 簽發 DeviceCert；建立 org 文件（`members[me].cafeca`、`handle`）。之後與 M0 相同（綁定 mailbox、匯出 OK 備份）。

### 17.6 加入與新裝置

**加入**（kind = `join`）：

1. 貼上組織連線碼 → `Config`；產生 IK、EK、DK；登入；由帳戶推導 memberId，IK 簽發 DeviceCert。
2. `Join{org_id, Application::Join{proof, ik_pub, ek_pub, device_cert, name}}`。mailbox 驗證證明（§17.4）、`binding` 的金鑰與 payload 一致、`device_cert.member_id` 與帳戶相符、此帳戶尚非成員，通過後暫存（同一帳戶只保留最新一筆）。
3. 任一在線管理者裝置 `FetchJoins`，再次驗證後在「設定 › 成員 › 待核准」列出（代稱、帳戶縮寫、裝置名稱、申請時間）。
4. 核准：管理者指定角色與小組 → 簽發 MemberCert → `PutRoster`（含新成員的 DeviceCert）→ org 文件新增成員（`approvedBy`）→ 封裝 GK、所屬小組 TK、新成員的 AK → `PutKeys` → `ResolveJoin{approved: true}`。拒絕：`ResolveJoin{approved: false}`。
5. 申請者每 5 秒嘗試 Hello，roster 出現自己後成功；同時以 `JoinStatus` 得知是否被拒。

**新裝置**（同樣以 kind = `join` 登入，使用者不需事先選擇）：

1. 流程同「加入」步驟 1–2；mailbox 發現帳戶推導出的成員已在 roster 中、未被停用，就把申請轉為 `Application::Device{proof, device_pub, eph_pub = 申請中的 EK, name = 裝置名稱}` 暫存給該成員，回應 `JoinState::AwaitingDevice`（加入則回 `Pending`）。也可直接送出 `Application::Device`。
2. 本人任一在線裝置以 `FetchDeviceRequests` 取得，再次驗證（帳戶是本人、`binding.key_pub == eph_pub`、`device_pub` 相符）後：
   - IK 簽發新裝置的 DeviceCert → `PutDevice`；
   - `sealed = enc ‖ HPKE-Seal(eph_pub, info = "hills/v1/device-grant", aad = device_pub, plaintext = postcard{v, member_id, account, device_cert, ik_secret, ek_secret})`；`PutDeviceGrant{device_pub, sealed}`。
3. 新裝置每 2 秒以 `FetchDeviceGrant` 查詢，取回後以申請時的 EK 私鑰解開，確認帳戶、成員與 DeviceCert 相符後把成員 IK / EK 存入安全儲存區（申請時產生的 IK / EK 丟棄），之後與一般啟動相同（Hello、`FetchKeys`、補同步）。
4. 本人其他裝置看到 roster 多出新裝置時通知「新裝置〈名稱〉已加入」，可直接撤銷。
5. 介面隨時提供「我沒有其他裝置了」改走還原（§17.7，需重新登入），等待 10 分鐘後主動提示。

### 17.7 還原

kind = `recover`，流程與加入相同（產生**新的** IK / EK / DK、`Application::Recover`），差別：

- mailbox 與管理者確認帳戶**已是**成員。
- 核准時管理者簽發同一 memberId、新金鑰、沿用原角色的 MemberCert（`issuedAt` 較新，§3.2），`PutRoster`；舊裝置的 DeviceCert 因簽發的 IK 已被取代而失效。
- 重新封裝：核准的管理者裝置把它持有的 GK、該成員所屬小組 TK、該成員的 AK（皆含歷史 epoch）封裝給新 EK；各對話的建立者裝置看到該成員的 EK 改變時，把該對話的 CK（含歷史 epoch）封裝給新 EK。該成員本人建立的對話，舊訊息無法再讀取，之後由本人輪替新 epoch。
- `PK_member` 只封裝給舊 EK，無法還原；還原後產生新的 `PK_member`。介面在送出申請前說明此限制。

`WrappedKey` 新增 `recipient_ek: Pub32`（封裝對象的 EK），客戶端只解開封裝給自己目前 EK 的項目。

### 17.8 mailbox 申請處理

- `Application` 由 mailbox 以 `hills-cafeca::RpcVerifier` 驗證；驗證失敗回 `BadRequest`；通過後回應 `JoinStatus(Pending | AwaitingDevice)`。
- `JoinStatus` 只能查詢連線 NodeId 自己的申請；`FetchDeviceGrant` 只能取回連線 NodeId 自己的封裝。
- 限流：每組織待處理申請最多 50 筆、每帳戶每種類最多 1 筆（新的取代舊的）、每個來源 NodeId 每分鐘最多 5 次；申請 7 天後清除，新裝置封裝（grant）取回後或 1 天後清除。
- **mailbox 可看到的明文（新增）**：申請者的 CAFECA 帳戶地址、代稱、裝置名稱、公鑰；不含任何組織資料。
- mailbox 需能連出到 CAFECA 錢包（`.well-known`、代稱查詢）與 RPC。

### 17.9 版本與既有資料

- `FORMAT_VERSION` 由 1 升為 2（MemberCert、WrappedKey、mailbox 請求格式改變）。客戶端啟動時偵測到 v1 的本機資料，提示後清除重新開始；mailbox 與 storage 依 deploy.md 重置（M1 試用前，D41）。

### 17.10 開發測試模式（D44）

開發期間不需 CAFECA 錢包即可測試建立、加入、新增裝置與還原。

- **測試帳號**：使用者輸入名稱（小寫英數與 `_`，2–32 字元）。`account = { chainId: 0, address: blake3("hills/v1/dev-account" ‖ name)[0..20] }`；鏈 ID 0 不是任何真實鏈，因此不會與 CAFECA 帳戶重複，同一名稱永遠對應同一成員。
- **測試登入證明**：客戶端在本機組出 `CafecaProof`，binding、nonce、message 與正式流程相同（domain 仍為 `app://io.cafeca.hills`），`signature` 固定為 `"hills/v1/dev-login/no-signature"`，`handle` 為測試帳號名稱；不經 CAFECA 中繼。
- **驗證**（`hills_cafeca::Verifier::Dev`）：鏈 ID 0 的證明只檢查 §17.4 步驟 1–2、固定簽章、`account == 由 handle 推導的帳戶`；其他鏈 ID 仍交給 RPC 驗證（有設定 `HILLS_CAFECA_WALLET` 時）。
- **啟用條件**：
  - mailbox：環境變數 `HILLS_DEV_LOGIN=1` 才使用 `Verifier::Dev`，啟動時記錄警告；`Config` 回應帶 `dev_login: true`。未設定時鏈 ID 0 的證明一律因鏈 ID 不符而被拒。
  - 桌機：只有 debug 建置（`cfg(debug_assertions)`：`tauri dev`、CI 的 `tauri build --debug`）會顯示測試帳號欄位，並在 mailbox 回報 `dev_login` 時接受測試證明（包含管理者核准與本人裝置自動授權）；release 建置不接受。
- **風險**：測試帳號沒有任何簽章保護，知道名稱就能以該帳號申請加入、替該帳號加入新裝置（本人其他裝置會自動授權）。只能用於測試資料，正式伺服器不得設定 `HILLS_DEV_LOGIN`。

## 18. 本機 MCP 介面（v0.23，D48）

### 18.1 架構

- 桌機 app 的 Rust 端（`apps/desktop/src-tauri/src/mcp/`）內建 MCP 伺服器，直接呼叫 app 持有的 `Node`；不另做讀同一資料夾的程式（避免兩個行程同時寫 Automerge / SQLite）。
- 傳輸：MCP Streamable HTTP（協定版本 `2025-06-18`），端點 `POST http://127.0.0.1:47321/mcp`；只回 `application/json`（不開 SSE），不使用 `Mcp-Session-Id`；`GET` 回 405。
- 支援的方法：`initialize`、`notifications/initialized`（回 202）、`ping`、`tools/list`、`tools/call`；其他回 JSON-RPC `-32601`。工具錯誤以 `result.isError = true` 回傳文字說明。
- 只支援 stdio 的用戶端以 `npx mcp-remote http://127.0.0.1:47321/mcp --header "Authorization: Bearer <token>"` 轉接。

### 18.2 開關與驗證

- **組織**：`org.mcp = { allowed: bool }`，預設不存在 = 不允許；只有管理者寫入（Node 檢查 `is_admin`，同 `set_direction_rules`）。
- **本機**：app data 目錄的 `mcp.json` = `{ enabled: bool, port: 47321 }`（不同步）；token = 32 bytes 隨機值的 base32，存在系統鑰匙圈（`hills.mcp.token`），可重新產生（舊 token 立即失效）。
- 伺服器只在「組織允許 且 本機開啟 且 Node 已啟動」時監聽；組織改為不允許時（同步到 org 變更）立即停止。v0.27：重新開啟 app、Node 載入後即依保存的設定啟動；設定頁讀取狀態時若應執行卻未執行（且沒有監聽錯誤），補啟動一次。
- 每個請求：`Host` 必須是 `127.0.0.1:<port>` 或 `localhost:<port>`；帶 `Origin` 時必須是 `http://127.0.0.1` / `http://localhost`（任意埠），否則 403；`Authorization: Bearer <token>` 以固定時間比較，錯誤 401。

### 18.3 工具

讀取（回傳 JSON 文字；只含本人在 app 內本來就讀得到的資料）：

| 工具 | 參數 | 內容 |
|------|------|------|
| `whoami` | — | 我（id、名稱、是否管理者）、組織名稱、所屬小組、組織時區與目前時間（ms），以及期間代碼格式（年 `2026`、季 `2026-Q4`、月 `2026-11`、ISO 週 `2026-W46`、日 `2026-11-09`，依組織時區） |
| `list_members` | — | 成員、所屬小組、狀態、回來 / 休假至 |
| `list_goals` | `level?`、`period?`、`mine_only?` | 目標（含進度、對齊、上層） |
| `get_directions` | — | 公司目標、小組目標（含進度）、這週重點；v0.35（D65）：公司與小組的目的、策略與衡量（含進度） |
| `list_files` | `query?`、`source?`（message / taskReport / kb）、`limit?`（≤ 100） | v0.35（D64）：本人看得到的檔案（名稱、大小、出處），不含金鑰 |
| `get_direction_summaries` | — | 每人的方向週摘要與偏離門檻（四項檢查由呼叫端依 §16.14 判定） |
| `list_tasks` | `assignee?`、`status?`、`team?`、`due_before?` | 任務與步驟 |
| `get_scrum` | `date` | 我的 Scrum 與小組的 Scrum |
| `get_report` | `kind`（daily / weekly）、`period` | 我的與小組的報表 |
| `list_conversations` | — | 對話列表 |
| `read_messages` | `conv`、`limit?`（≤ 50） | 最近的訊息 |
| `search_knowledge` | `query`、`limit?` | 標題與內文包含關鍵字的知識 |
| `list_teams` | — | v0.28（D51）：小組（id、名稱、成員、負責人、封存時間、本人能否管理） |
| `list_knowledge_tree` | — | v0.28（D51）：知識庫分類與主題（含 `resolved`：合併後的最終項目），不含內文 |

寫入（只建立待確認變更，回傳 `{status: "pending", id, summary}`）：`propose_goal`（PlanInput，有 `id` 為修改）、`propose_task`（team + TaskInput，有 `task` 為修改）、`propose_step_done`、`propose_scrum_draft`、`propose_message`、`propose_kb_item`；刪除（v0.24）：`propose_delete_goal(id)`（只限本人的目標）、`propose_delete_task(team, task)`、`propose_delete_kb_item(key)`，權限與使用者在 app 內刪除相同；查詢：`get_change_status(id)` → `pending | approved | rejected | expired | failed`（failed 附錯誤訊息）。

寫入（v0.28，D51；同樣只建立待確認變更，準備階段先檢查權限，核准時以同一組 Node API 再檢查一次）：

| 工具 | 參數 | 核准後 | 權限 |
|------|------|--------|------|
| `propose_team_goal` | `id?`、`team`、`year`、`title`、`directionId?`、`keyResults?`、`criteria?` | `save_team_goal`（修改時未給的欄位沿用原值） | 該小組負責人（或管理者，同 §16.14） |
| `propose_delete_team_goal` | `team`、`id` | `delete_team_goal` | 同上 |
| `propose_week_note` | `team`、`week`、`text` | `set_week_note` | 同上 |
| `propose_direction` | `id?`、`year`、`title`、`keyResults?` | `save_direction` | 管理者 |
| `propose_delete_direction` | `id` | `delete_direction` | 管理者 |
| `propose_task_status` | `team`、`task`、`status` | 只改狀態的 `update_task` | 與在 app 內改任務相同 |
| `propose_task_ack` | `team`、`task`、`state`（accepted / concern）、`note?`（concern 必填，≤ 200 字） | `set_task_ack`（§16.8；不會自動私訊，通知指派者請另用 `propose_message`） | 目前負責人本人 |
| `propose_team` | `id?`、`name`、`members`、`leads` | 新增 `create_team`；修改時名稱有變 `rename_team`、名單有變 `set_team_members`（§16.15） | 新增、改名：管理者；名單：管理者或該小組負責人 |
| `propose_archive_team` | `id`、`archived` | `archive_team` | 管理者 |
| `propose_kb_category` | `name` | `kb_create_category` | 全員；名稱不可與現有分類重複 |
| `propose_kb_topic` | `categoryId`、`name` | `kb_create_topic` | 全員；同分類內名稱不可重複 |
| `propose_kb_rename` | `kind`（category / topic）、`id`、`name` | `kb_rename` | 全員（同 app） |

`propose_delete_*` 與 `propose_archive_team` 標 `destructiveHint`。

v0.29（D52）：`propose_kb_item` 新增 `format`（markdown | html，預設 markdown），一律以 hills-doc/1 驗證（必填段落在準備階段檢查，HTML 先清理）；新增讀取工具 `get_knowledge(key, sections?)`，回傳標題、格式、來源與 `sections`（只含要求的 key；未指定時全部）。D53 的 `propose_task_log`、`propose_task_close` 與 `propose_task` 的 `brief` / `acceptance` 隨第 2 批加入。 v0.33：新增 `propose_task_log`（kind = start / progress / question / answer，text、percent?）、`propose_task_close`（format、body、criteria；報告在準備階段以 hills-doc/1 驗證；**附件不經 MCP**）、`propose_task_reopen`（text 必填）；`propose_task` 加 `brief` / `acceptance`。權限與 app 內相同，一律待本人確認。確認卡摘要（preview）：`updateTeam` 附 `removed`（被移出的成員；有值時核准會輪替小組金鑰）；`message` 附 `to`（私訊對象 memberId）或 `conv` 與 `count`（群組人數）。

v0.34（D60–D62）：
- 讀取：`get_scrum` 改名 `get_daily_tasks`（舊名保留為別名）；`get_report` 的 `kind` 改為 daily / weekly / monthly / quarterly / yearly，回傳六段（日 / 月 / 季 / 年為即時彙整）；新增 `get_my_time(from, to)`（本人的 worklog 與目前計時，只有本人）。
- 寫入：`propose_scrum_draft` 改名 `propose_daily_tasks`（參數：要引用的紀錄 key、手動項目、`note`；舊名保留為別名）；`propose_task_log` 的 `kind` 增加 `blocked` / `resolved`；新增 `propose_time_fix(date, entries)`（修正某天的時間，只有本人）。計時的開始 / 暫停不提供給 MCP。

### 18.4 待確認變更

- 只存在本機記憶體（app 重啟即作廢）；欄位：id（ULID）、client（`initialize` 的 `clientInfo.name`）、工具、參數、人看得懂的摘要、建立時間、狀態。
- 同時最多 50 筆待確認；建立後 24 小時未處理即 `expired`。
- 建立時發出前端事件 `hills://mcp`；確認卡「核准」→ 以同一組 Node API 執行（與使用者自己操作相同的驗證與權限），結果寫回狀態；「拒絕」→ `rejected`。
- 稽核：本機保留最近 200 筆 `{時間, client, 工具, 結果}`，不記參數與回傳內容。

## 19. AI Agent 成員與 hills-agent（v0.29，D54，M2）

### 19.1 成員種類

- `org.members.<id>` 新增 `kind: "human" | "agent"`（缺少視為 human）、`sponsor`（負責人 memberId，必填於 agent）、`purpose`、`scopes`（`kb.write`、`chat.team`；任務範圍固定為指派給它的）、`paused?`。
- agent 不能持有 `Admin` 角色，不能出現在任何 `leadIds` / roster `leads`；驗證層拒絕。組織 `org.agents = { allowed: bool }`，預設不允許，只有管理者可寫。
- MemberCert 新增 `kind`；agent 的 `cafeca` 欄位為空，改由 sponsor 的簽章背書（`SponsorAttest = Sign_IK_sponsor(agentMemberId, AgentIK.pub, purpose, issuedAt)`），管理者核准時一併驗證。

### 19.2 配對

1. 管理者建立 agent：產生 `pairCode`（96-bit 隨機，base32，10 分鐘有效），在 mailbox 以 `H(pairCode)` 為 key 放一個「等待配對」請求，只存在建立者的裝置與 mailbox。
2. `hills-agent pair <pairCode>`：產生 Agent 的 IK / DK，把公鑰與 `H(pairCode)` 送到 mailbox；建立者的 App 取回後驗證、簽發 MemberCert（kind agent）與 DeviceCert，封裝 GK 與所屬小組 TK（同 §16.2 加入流程）。
3. 配對碼一次性，過期或用過即失效；失敗不透露原因。

### 19.3 hills-agent 節點

- `apps/agent`（Rust binary）：使用 hills-node 的 `Node`，資料夾與金鑰存於設定的目錄（金鑰用系統鑰匙圈，沒有時以檔案 + 權限 600，並提示）。
- 同步與 mailbox 同一般裝置；只解得開 GK 與所屬小組 TK。
- 本機 MCP（`127.0.0.1`，token 同 §18.2）：工具集合同 D48 / D51 / D53，但**寫入直接生效**（以 Agent 身分），回傳結果而非待確認 id；工具只列出 Agent 有權限的部分。
- 每次寫入前檢查：未暫停、組織仍允許、目標在範圍內（任務的負責人是自己；對話是所屬小組；知識為新增或自己寫的）；頻率上限每分鐘 30 筆、每天 2,000 筆，超過回錯。
- 寫入任務時自動補執行紀錄（狀態改變 → `progress` / `close`）。

### 19.4 暫停與停用

- 暫停：sponsor 或管理者把 `paused` 設為 true；節點同步到後拒絕所有寫入（讀取照常），介面顯示「已暫停」。
- 停用：同成員停用（§16.15）：撤銷 DeviceCert、從所有小組移除並輪替 TK；之後的寫入被驗證層拒絕。
- 刪除 Agent 不刪除它寫過的紀錄、報告與知識，作者顯示「〈名稱〉（已停用的 AI）」。
