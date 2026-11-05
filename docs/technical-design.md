# Hills 技術設計文件

> 版本：v0.1 草案 · 2026-11-05 · 對應功能規劃 [feature-plan.md](./feature-plan.md) v0.8
> 範圍：M0（基礎）與 M1（計劃、Scrum、假勤）所需的協定、資料模型與金鑰流程。聊天、檔案、通話、AI 於後續版本補充。

## 1. 元件總覽

```
┌──────────────────────── Hills 桌機客戶端（Tauri 2）─────────────────────────┐
│ React + TS UI  ◄── Tauri commands / events ──►  Rust 核心                  │
│                                  ├ hills-identity  身分、金鑰、憑證          │
│                                  ├ hills-crypto    小組金鑰、加密封包        │
│                                  ├ hills-store     Automerge 文件庫 + SQLite 投影 │
│                                  ├ hills-sync      文件同步、驗證層          │
│                                  ├ hills-net       iroh endpoint、ALPN、gossip │
│                                  └ hills-domain    假勤 / 計劃 / Scrum 規則  │
└────────────────────────────────────────────────────────────────────────────┘
            │  iroh（QUIC + TLS 1.3，端對端加密；直連優先，失敗走 relay）
            ▼
┌──────────────────────── 自架服務（Docker Compose）──────────────────────────┐
│ iroh-relay      打洞協調與中繼（只看得到密文）                               │
│ hills-mailbox   常駐節點：保存加密 change bundle，供離線成員補同步            │
│ hills-tsa       可信時間戳：對打卡雜湊簽發時間憑證                           │
│ caddy           反向代理與自動 TLS                                           │
└────────────────────────────────────────────────────────────────────────────┘
```

Monorepo 結構：

```
crates/
  hills-proto/     # 共用訊息型別（serde + postcard），帶版本號
  hills-identity/  hills-crypto/  hills-store/
  hills-sync/      hills-net/     hills-domain/
apps/
  desktop/         # Tauri 2 app（src-tauri + React 前端）
  mailbox/         # hills-mailbox 服務
  tsa/             # hills-tsa 服務
deploy/
  docker-compose.yml  .env.example
```

## 2. 密碼學基礎

| 用途 | 演算法 | 函式庫（建議） |
|------|--------|---------------|
| 簽章 | Ed25519 | `ed25519-dalek` |
| 金鑰協商 | X25519 | `x25519-dalek` |
| 對稱加密 | XChaCha20-Poly1305 | `chacha20poly1305` |
| 金鑰推導 | HKDF-SHA256 | `hkdf` |
| 封裝（wrap） | HPKE（X25519 / HKDF-SHA256 / ChaCha20Poly1305） | `hpke` |
| 雜湊 / ID | BLAKE3 | `blake3` |
| 復原詞 | BIP39 24 字（256-bit entropy） | `bip39` |
| 安全儲存 | macOS Keychain / Windows Credential Manager / Linux Secret Service | `keyring` |

原則：不自行設計密碼學原語；所有訊息格式帶版本號 `v`，以便日後升級（例如 M2 群組聊天改用 OpenMLS）。

## 3. 身分與金鑰

### 3.1 金鑰階層

```
復原詞（24 字，成員自行保管）
  └─ seed ─HKDF─► 成員身分金鑰 IK（Ed25519，簽章）
              └─► 成員協商金鑰 EK（X25519，接收封裝的金鑰）
成員 ID = blake3(IK.pub) 前 16 bytes（base32 顯示）

裝置金鑰 DK（Ed25519，每台裝置隨機產生；同時作為 iroh NodeId）
裝置憑證 DeviceCert = Sign_IK(memberId, DK.pub, deviceName, issuedAt)

組織根金鑰 OK（Ed25519，建立者產生；組織 ID = blake3(OK.pub)）
成員憑證 MemberCert = Sign_admin(memberId, IK.pub, EK.pub, roles, issuedAt)
```

- IK / EK 私鑰存於每台已綁定裝置的系統安全儲存區，可由復原詞重建。
- DK 私鑰永不離開裝置。
- OK 只用來簽發第一張管理者憑證，之後的管理操作由任一管理者 IK 簽章。OK 是信任根與災難復原用途，建立後匯出離線備份。

### 3.2 信任鏈驗證

收到任何簽章資料時依序檢查：

1. `DeviceCert` 由某成員 IK 簽發，且裝置未被撤銷。
2. 該成員的 `MemberCert` 由有效管理者簽發，且成員未被停用。
3. 管理者有效性可追溯至 OK 簽發的第一張管理者憑證。
4. 此操作在該成員的角色權限內（§5.3）。

### 3.3 建立組織（Genesis）

1. 建立者產生復原詞 → IK / EK；產生 DK、OK。
2. 建立 `org` 文件：組織設定、由 OK 簽署的第一張管理者 `MemberCert`。
3. 引導建立者抄寫復原詞並驗證（隨機抽 3 個字），並以密碼加密匯出 OK 備份檔。

### 3.4 邀請與加入

邀請碼：`hills1-<base32(orgId[0..8] ‖ inviteId(8B) ‖ secret(16B))>`。QR Code 另含 relay URL 與 mailbox NodeId；文字邀請碼需另輸入伺服器網址。

```
管理者裝置                        hills-mailbox                     新成員裝置
 │ 1. 建立 Invite{inviteId, role, teams,                             │
 │    expiresAt, H=blake3(secret)} 寫入 org 文件                      │
 │ 2. 將邀請碼交給新成員（私訊或當面）                                   │
 │                                   │◄── 3. JoinRequest ───────────│
 │                                   │  {inviteId, IK.pub, EK.pub,   │
 │                                   │   DeviceCert, name,           │
 │                                   │   mac=HMAC(K_inv, 以上欄位)}  │
 │◄── 4. 管理者上線後取得 ────────────│  K_inv = HKDF(secret,"join") │
 │ 5. 驗證 mac、邀請未過期未使用                                       │
 │ 6. 簽發 MemberCert 寫入 org 文件；標記邀請已使用                     │
 │ 7. 以 HPKE 將 GK 與所屬小組的目前金鑰封裝給 EK.pub                   │
 │──────────── 8. JoinAccepted（經 mailbox 或直連）─────────────────►│
```

- 邀請一次性、預設 72 小時過期；`secret` 不寫入任何文件，只存雜湊。
- 任一在線管理者裝置都可處理 JoinRequest。
- 新成員加入後通知全員，降低邀請碼外洩風險。

### 3.5 新裝置綁定

1. 新裝置產生 DK 與臨時 X25519 金鑰，顯示 QR（含 DK.pub、臨時公鑰、relay 位址）。
2. 既有裝置掃碼，經 ALPN `hills/link/1` 連線。
3. 雙方顯示 6 位數 SAS（由雙方公鑰雜湊得出），使用者確認一致。
4. 既有裝置以臨時金鑰加密傳送 IK / EK 私鑰，並寫入新的 `DeviceCert`。

### 3.6 金鑰復原（遺失所有裝置）

1. 新裝置輸入復原詞 → 重建 IK / EK，產生新 DK 並自簽 `DeviceCert`。
2. 經 mailbox 廣播 `RecoveryAnnounce`；其他成員裝置確認 IK 對應既有 MemberCert 後，將其有權取得的金鑰（含歷史 epoch）重新封裝給 EK。
3. 成員本人簽署撤銷舊裝置的 `DeviceCert`。
4. 無復原詞時：管理者停用舊身分（§3.7）並重新邀請；只有舊身分能解密的私人資料無法還原。

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
| `org` | 管理者 | 全員 | `GK` | 設定、品牌、成員憑證、小組、邀請、假日曆、假別、工作規則、核准規則 |
| `team/<teamId>` | 小組成員 | 小組成員 | `TK_team` | 任務、小組目標 |
| `member/<id>/plans/{private,team,org}` | 本人 | 依可見度 | `PK` / `TK` / `GK` | 五層計劃（見 §4.3） |
| `member/<id>/scrum/<yyyy-mm>` | 本人 | 小組成員 | `TK_team` | 每日 Scrum |
| `member/<id>/attendance/<yyyy-mm>` | 本人 | 本人、負責人、管理者 | `AK_member` | 打卡紀錄 |
| `member/<id>/requests` | 本人 | 本人、核准者 | `AK_member` | 請假、加班、補打卡申請 |
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
  keyId,          // 例如 team:<teamId>:epoch:<n>
  nonce,          // 24 bytes
  ciphertext,     // XChaCha20-Poly1305( postcard(SignedChange[]) )
  bundleHash      // blake3(ciphertext)，mailbox 去重鍵
}
```

### 4.5 同步流程

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
| `hills/mailbox/1` | PUT / LIST / GET bundle、JoinRequest 投遞 | 裝置 ↔ mailbox |
| `hills/tsa/1` | 時間戳請求 | 裝置 ↔ tsa |
| `hills/link/1` | 新裝置綁定 | 同一成員的兩台裝置 |

訊息以 `postcard` 序列化，外層帶 `v`、`type`、`requestId`，所有請求設逾時。

### 5.1 上線狀態（Presence）

- 每台裝置每 30 秒於 gossip 廣播 `Presence{memberId, deviceId, state, note, currentTaskId, expiresAt, ts, sig}`，以 `GK` 加密。
- 90 秒未收到 → 離線；同一成員多台裝置取最活躍的狀態。
- 本機閒置 10 分鐘（可設定）→ 自動「離開」。

### 5.2 Mailbox 服務 API

```
PUT   { orgId, bundle }                              → { cursor }
LIST  { orgId, docIds?: [..], since: cursor, limit } → { bundles: [..], next }
GET   { orgId, bundleHash }                          → EncryptedBundle
JOIN  { orgId, inviteId, payload }                   → ok
FETCH_JOINS { orgId }                                → [JoinRequest]   // 限管理者
```

- 存取控制：請求者出示 `DeviceCert` + `MemberCert` 鏈，mailbox 持有 OK.pub 與 org 憑證快照以驗證（憑證以明文簽章副本另行上傳，不含其他組織資料）。`JOIN` 例外，以 inviteId 與 IP 限流。
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
裝置：record = { memberId, kind: in|out, localTime, monotonic, location: office|remote, wifiHash? }
      h = blake3(postcard(record))          ──► hills-tsa { h }
TSA ：token = Sign_TSA(h ‖ serverTime)       ──► 裝置
裝置：AttendanceRecord = { record, tsaToken, sig_DK }
```

- 工時以 `serverTime` 為準；`localTime` 與 `serverTime` 相差 > 5 分鐘標示異常。
- 離線打卡：先記錄 `localTime` 與單調時鐘讀數，上線後補取 token 並標註 `lateStamped`；報表顯示註記。
- TSA 公鑰寫在 `org` 文件；金鑰輪替時新舊並存。
- `wifiHash = blake3(orgId ‖ BSSID)`，不保存原始 BSSID；與 org 文件中登錄的公司 Wi-Fi 雜湊比對得出 `office`。

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
               officeWifiHashes: string[], workRule: WorkRule,
               leaveTypes: LeaveType[], leavePolicy: AnnualLeaveTable,
               approvalRules: ApprovalRule[] }
Member      { id, name, title?, timezone, joinedAt, hireDate, roles: Role[],
              cert: MemberCert, devices: DeviceCert[], status: active|disabled }
Team        { id, name, leadIds: MemberId[], memberIds: MemberId[] }
Invite      { id, secretHash, role, teamIds, expiresAt, usedBy?, revoked }
LeaveType   { id, name, paid: boolean, minUnitHours, annualLimitHours?, requireProof }
HolidayCalendar { region, year, holidays: {date, name}[], workdays: Date[] }

// team 文件
Task        { id, teamId, title, assigneeId?, status: todo|doing|review|done,
              estimateHours?, planItemId?, blockedReason?, createdAt, updatedAt }
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

- Automerge 文件以 `docId` 為檔名存於 app data 目錄，以本機儲存金鑰（存於 keychain）靜態加密。
- SQLite 投影：從文件導出可查詢的表（任務、Scrum、出勤、申請狀態、計劃樹），文件變更時增量更新；投影隨時可重建。
- 前端只讀投影（Tauri command 查詢 + event 推送變更）；寫入一律經 Rust 核心產生簽章 change。

## 10. 部署（docker-compose）

```yaml
services:
  relay:    # iroh-relay（含 QUIC address discovery）
  mailbox:  # hills-mailbox，volume: mailbox-data:/data
  tsa:      # hills-tsa，私鑰以 docker secret 掛載
  caddy:    # 80/443，自動 TLS，反向代理 relay
```

- 提供 `.env.example`；實際 `.env` 與所有私鑰不進版控（repo 為公開）。
- 備份：mailbox `/data` 每日快照；TSA 私鑰與 OK 備份離線保存。
- 監控：各服務健康檢查端點、磁碟用量告警。

## 11. 威脅模型摘要

| 威脅 | 對策 |
|------|------|
| 伺服器被入侵 | relay / mailbox 只有密文；TSA 被入侵只能偽造時間，無法讀資料 |
| 邀請碼外洩 | 一次性、72 小時過期、可撤銷；新成員加入通知全員 |
| 裝置遺失 | 本人或管理者撤銷 DeviceCert；本機資料靜態加密 |
| 離職成員 | 撤銷 + epoch 輪替；已同步資料無法撤回（明示） |
| 竄改打卡 | DK 簽章 + TSA 時間憑證；異常標示給負責人 |
| 惡意成員寫入他人文件 | single-writer 驗證層拒絕 |
| 裝置綁定的中間人攻擊 | 6 位數 SAS 比對 |
| 公開 repo 洩漏機密 | GitHub secret scanning、pre-commit 掃描、`.env` 範本化 |

## 12. M0 技術驗證（PoC）

| 項目 | 方法 | 通過標準 |
|------|------|---------|
| iroh 穿透 | 兩台桌機分別在公司網路、家用寬頻、手機熱點（CGNAT）、企業防火牆下兩兩組合測試 | 全部組合可連線；記錄直連比例與 relay 延遲 |
| Automerge 同步 | 兩裝置各自離線編輯同一計劃文件 100 次後重連 | 結果一致、無遺失，合併 < 1 秒 |
| 加密 bundle + mailbox | A 離線時 B 寫入，A 上線經 mailbox 補同步 | 補同步 ≤ 5 秒 |
| 三平台打包 | macOS（notarize）、Windows（簽章）、Linux（AppImage / deb） | 可安裝、可啟動 |

結論寫入 `docs/poc-report.md`。iroh 或 Automerge 未通過時，評估替代方案（WebRTC + Yjs / Loro）。

## 13. 待決事項

1. `GK` 輪替時是否重新加密 `org` 歷史（建議否：新 change 用新 epoch，歷史保留舊 epoch）。
2. 多人寫入的 `team` 文件長期成長的快照與壓縮策略。
3. 時間戳是否採 RFC 3161 標準格式，以便作為法定出勤紀錄的佐證。
4. M2 群組聊天是否改用 OpenMLS 取代 epoch 小組金鑰。
