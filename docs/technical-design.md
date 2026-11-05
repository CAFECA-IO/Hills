# Hills 技術設計文件

> 版本：v0.2 草案 · 2026-11-05 · 對應功能規劃 [feature-plan.md](./feature-plan.md) v1.0；M2–M5 見 [technical-design-m2-m5.md](./technical-design-m2-m5.md)
> 範圍：M0（基礎）與 M1（計劃、Scrum、假勤、對話、檔案分享）所需的協定、資料模型與金鑰流程。M1 對話見 §14，檔案分享（SwarmStorage 原理）見 §15。

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
│ hills-storage×8 檔案分片儲存節點（SwarmStorage 原理，§15）                    │
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
  storage/         # hills-storage 分片節點（§15.6）
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
  storage-0 … storage-7:  # hills-storage，各自獨立 volume（§15.7）
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
- 新增成員：封裝**目前** epoch 給新成員（M1 不分享歷史 epoch，新成員看不到加入前訊息；歷史分享為 M2 功能）。
- 移出成員：輪替 epoch，新訊息使用新 `CK`。
- 對話設定存於 `conv/<convId>/meta`（寫入者：對話管理員 = 建立者與其指定者）：名稱、成員、金鑰封裝紀錄。

### 14.2 訊息文件

```
conv/<convId>/meta            寫入者：對話管理員       金鑰：CK
conv/<convId>/log/<yyyy-mm>   寫入者：對話成員（append） 金鑰：CK
```

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
  └► 主執行緒：列出檔案（Tauri fs plugin，權限只限所選路徑）→ 建立上傳佇列
       └► 逐一處理每個檔案（依序，一次一個檔案）
            └► 每個條帶 k（20 MiB 明文，最後一條帶可較短）：
                 1. fs FileHandle 讀取 [k·20MiB, (k+1)·20MiB)   ──► 傳給 Web Worker（Transferable）
                 2. Worker：AES-256-GCM 加密
                      key = fileKey（每檔隨機 256-bit）
                      IV  = fileNonce(8 B 隨機) ‖ uint32_be(k)
                      AAD = fileId ‖ uint32_be(k) ‖ uint32_be(stripeCount)
                      payload = ciphertext ‖ tag(16 B)
                 3. Worker：payload 以 0 補齊到 5 的倍數 → 切 5 個資料分片 → RS 計算 3 個同位分片
                 4. Worker：每個分片計算 SHA-256（物件 ID）
                 5. 主執行緒：8 個分片平行上傳到 8 個儲存節點（§15.6）
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

M1 自行實作輕量 HTTPS 物件節點（Rust + axum），部署 8 個實例；日後可替換為 SwarmStorage 節點網路。

```
PUT    /v1/objects/{sha256}     body = 分片位元組；節點驗證 SHA-256 相符才存
HEAD   /v1/objects/{sha256}     200 / 404（續傳用）
GET    /v1/objects/{sha256}     回傳分片；支援 Range
GET    /v1/health
```

- **驗證**：每個請求帶 `Hills-Auth` 標頭：`DeviceCert`、`MemberCert` 與 DK 對 `method ‖ path ‖ date ‖ sha256(body)` 的簽章；節點持有 OK.pub 與成員憑證快照（同 mailbox，§5.2）以驗證。
- **前端直接上傳**：前端以 Tauri http plugin（或設定 CORS 後使用 fetch）直接連線 8 個節點；不經過 Rust 核心轉送，以符合「前端切割加密後上傳」。
- **分片分配**：分片 i 放到節點 `(i + fileNonce[0]) mod N`（N = 節點數，M1 為 8），讓負載分散。
- **保留**：上傳時帶 `Hills-Expires`（預設上傳後 1 年，D16）；節點每日清除過期物件。
- **配額**：每組織、每成員的總容量與單檔上限（預設 5 GB，可設定），超過時回 `413`。
- **節點看到的資訊**：分片密文、大小、上傳者的成員 ID 與時間；看不到檔名、目錄結構、內容。

### 15.7 部署與容錯

- docker-compose 新增 `storage-0` … `storage-7`，每個實例使用獨立 volume；`caddy` 以 `storage-<n>.<domain>` 對外。
- M1 單台主機時，請把 8 個 volume 分散在不同磁碟；正式環境建議分散到至少 3 台主機，讓任 1 台主機故障時仍保有 ≥ 5 片（每台最多放 3 個節點，且 3 台中任兩台合計 ≥ 5）。
- 監控：每日抽查每個節點的分片 SHA-256，發現損壞時由持有檔案的成員裝置重新上傳缺少的分片（修復流程列為 M2）。

### 15.8 M0 PoC 追加項目

| 項目 | 方法 | 通過標準 |
|------|------|---------|
| WebView 加密與編碼效能 | 在 macOS（WKWebView）與 Windows（WebView2）的 Web Worker 中，對 1 GB 檔案執行讀取 → AES-GCM → RS(8,5) | 每平台 ≥ 50 MB/s；記憶體 < 200 MB |
| RS 相容性 | 以 SwarmStorage 產生的分片比對移植後的實作 | 輸出逐位元組一致 |
| Mac ↔ Windows 檔案往返 | Mac 上傳含中文檔名、多層目錄的資料夾，Windows 下載；反向亦同 | 雜湊一致；關閉任 3 個節點仍可下載 |
