# Hills 技術設計文件

> 版本：v0.13 草案 · 2026-11-08 · 對應功能規劃 [feature-plan.md](./feature-plan.md) v1.0；M2–M5 見 [technical-design-m2-m5.md](./technical-design-m2-m5.md)
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

工具鏈：Rust stable（`rust-toolchain.toml`）、Node 22、pnpm 10；Tauri 使用 2.x 穩定版。

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
2. 該成員能取得的每把金鑰（GK、所屬小組 TK、相關 AK）進行 **epoch 輪替**：管理者裝置產生新金鑰，以 HPKE 封裝給剩餘的合法持有者，寫入 `keys` 紀錄。
3. 新資料一律使用新 epoch；被停用者已同步的歷史資料無法撤回，UI 需明示。
4. 停用者的計劃、報表文件保留，小組負責人可讀以利交接。

## 4. 資料加密與同步

### 4.1 文件切分

業務資料存為 Automerge 文件，並依「誰可以寫」切分，讓權限檢查簡單可靠：

| 文件 | 寫入者 | 讀取者 | 金鑰 | 內容 |
|------|--------|--------|------|------|
| `org` | 管理者 | 全員 | `GK` | 設定、品牌、成員憑證與 CAFECA 帳戶、小組、假日曆、假別、工作規則、核准規則 |
| `team/<teamId>` | 小組成員 | 小組成員 | `TK_team` | 任務、小組目標 |
| `member/<id>/plans/{private,team,org}` | 本人 | 依可見度 | `PK` / `TK` / `GK` | 五層計劃（見 §4.3） |
| `member/<id>/scrum/<yyyy-mm>` | 本人 | 小組成員 | `TK_team` | 每日 Scrum |
| `member/<id>/attendance/<yyyy-mm>` | 本人 | 本人、負責人、管理者 | `AK_member` | 打卡紀錄 |
| `member/<id>/requests` | 本人 | 本人、核准者 | `AK_member` | 請假、加班、補打卡申請 |
| `member/<id>/secrets` | 本人 | 本人 | `PK_member` | 本人的私密設定 |
| `approvals/<approverId>` | 核准者本人 | 申請者、管理者 | 申請者的 `AK_member` | 核准 / 退回決定 |
| `member/<id>/reports` | 本人 | 依發佈範圍 | `TK_team` | 日 / 週報 |

- 申請與核准分屬不同寫入者的文件，申請狀態由投影層組合兩者得出，避免多人寫同一欄位造成衝突或越權。
- `AK_member`（出勤金鑰）：每位成員一把，封裝給本人、其小組負責人與所有管理者；負責人異動時輪替。
- `PK_member`（私人金鑰）：只封裝給本人。
- `GK`（組織金鑰）：封裝給全員；成員停用時輪替。

### 4.2 簽章變更與驗證層

- 每個 Automerge change 由寫入裝置的 DK 簽章：`SignedChange{docId, changeHash, deps, authorDevice, sig}`。
- 接收端套用前驗證：簽章 → 信任鏈（§3.2）→ 作者是該文件的合法寫入者（§4.1）。
- 驗證失敗的 change 不套用，記錄於本機稽核紀錄。因為每份文件只有一類寫入者，拒絕非法 change 不會影響合法寫入者的因果鏈。
- `team/<teamId>` 為多人寫入：驗證層只確認作者是小組成員；欄位級規則（例如只有負責人可改小組目標）在投影層檢查並於 UI 限制，M1 接受此簡化。

### 4.3 計劃的可見度

可見度有「私人 / 小組 / 全組織」三種，分別以 `PK_member`、`TK_team`、`GK` 加密，因此計劃拆為三份文件。改變可見度 = 將項目搬到另一份文件並保留同一 `planItemId`。上下層連結以 `planItemId` 參照，跨文件仍可組成目標樹；讀者看不到的上層項目顯示為「私人項目」。

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
Task        { id, teamId, title, assigneeId?, status: todo|doing|review|done,
              estimateHours?, dueAt?, steps?: TaskStep[], planItemId?, blockedReason?,
              createdAt, updatedAt }
TaskStep    { id, title, assigneeId?, done: boolean, doneAt? }
TeamGoal    { id, teamId, period, title, keyResults: KeyResult[] }

// member 文件
PlanItem    { id, level: year|quarter|month|week|day, period: '2026' | '2026-Q4' |
              '2026-11' | '2026-W45' | '2026-11-05', parentId?, alignedTeamGoalId?,
              title, keyResults?: KeyResult[], done?: boolean, progress, progressOverride? }
KeyResult   { id, title, start: number, target: number, current: number, unit }
ScrumReport { date, done: Ref[], today: Ref[], blockers: Blocker[], submittedAt }
AttendanceRecord { id, kind: in|out, localTime, serverTime?, tsaToken?, location,
                   lateStamped, sig }
LeaveRequest    { id, typeId, start, end, hours, delegateId?, reason, proof?, ruleId,
                  createdAt, cancelledAt? }
OvertimeRequest { id, start, end, hours, reason, compensation: pay|compTime, ruleId, createdAt }
CorrectionRequest { id, date, kind: in|out, time, reason, ruleId, createdAt }
Report      { id, scope: member|team, period, sections: { progress, okr, attendance, next },
              publishedTo: teamId[], generatedAt, editedAt? }

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
| 新裝置綁定被調包 | 臨時公鑰寫在 CAFECA 簽署的 nonce 中，mailbox 無法替換 |
| 公開 repo 洩漏機密 | GitHub secret scanning、pre-commit 掃描、`.env` 範本化 |

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
  kind: 'text' | 'files' | 'system',
  body: string,                       // Markdown
  mentions: MemberId[],
  attachments?: Attachment[]          // kind = 'files'
}
Attachment =
  | { type: 'file',   manifest: FileManifest,  fileKey: base64 }          // §15.4
  | { type: 'folder', name, totalSize, fileCount,
      manifestRef: ObjectRef, manifestKey: base64 }                      // §15.5
```

- 驗證層（§4.2）：作者必須是 `meta` 中的成員；`log` 為多人寫入文件，只接受新增訊息（投影層忽略修改既有訊息的 change）。
- 傳遞：沿用 §4.5——在線成員直連同步，離線成員經 mailbox 補同步。`fileKey` / `manifestKey` 只出現在 `CK` 加密的訊息中。
- 通知：收到 `mentions` 含自己或 `dm` 訊息時發桌機通知；群組預設只通知提及。

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
| `PutKeys` | ✓ | 管理者（org、team、attendance）/ 本人（private） | `Signed<WrappedKey>`，由簽署裝置的權限決定 |
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
  teams:   { <teamId>: { name, leadIds: [..], memberIds: [..] } },
  offices: { <officeId>: { name, wifiHashes: [] } },     // v0.11（D40）；M1 wifiHashes 為空
  lunchBreak?: { start: "12:00", end: "13:30" },          // v0.11；組織時區
}

team/<teamId> = {                                         // v0.11（D40）
  "task:<taskId ULID>": { title, assignee?, status: todo|doing|review|done, dueAt?,
                          steps: [ { id, title, assignee?, done, doneAt? } ],
                          createdBy, createdAt, updatedAt },
  "profile:<memberId>": "{\"hair\":0,\"shirt\":3,\"skin\":1}",   // 角色外觀（JSON 字串，固定色盤的索引）
}
```

- 任務與外觀都放在根物件的獨立 key（不共用 `tasks` / `profiles` 容器），避免兩人同時建立第一個容器時 Automerge 只保留其中一個。

- `offices`、`lunchBreak` 只有管理者可寫（org 文件規則）。
- `team/<id>` 為多人寫入（§4）：任務全組可編輯；`profile:<memberId>` 只有本人可寫，由驗證層檢查（根物件上 `profile:` 開頭的 key 必須是作者本人，且只能放入字串），他人的寫入整筆 change 拒絕。成員把外觀寫進自己所屬的每個小組文件，讀取時取任一份。
- **焦點**（feature-plan §5.4）：候選為指派給我、或下一個未完成步驟指派給我的未完成任務；依「期限最近 → 卡住別人（下一步負責人不是我但我負責的步驟未完成）→ 指派給我 → 建立時間」排序。手動選擇的焦點只存在本機（secret 檔 `focus`），任務完成或刪除時回到自動。

`Directory`（§4.2）由 org 文件投影提供。M0 建立組織時自動建立一個預設小組。

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
