# Hills 技術設計文件（M2–M5）

> 版本：v0.1 草案 · 2026-11-05 · 對應 [feature-plan.md](./feature-plan.md) v0.9
> 前置：[technical-design.md](./technical-design.md)（M0 / M1：身分、金鑰、同步、假勤）。本文件沿用其金鑰、ALPN、文件切分與驗證層，不重複說明。
> 標示 **〔提案〕** 的項目尚未列入決策表，需經確認後才能實作（見 §9）。

## 1. M2 即時通訊

### 1.1 對話與金鑰

| 對話類型 | 成員 | 金鑰 |
|---------|------|------|
| 一對一（dm） | 2 人 | `CK_conv`（對話金鑰，epoch 制） |
| 群組（group） | 任意成員組合 | `CK_conv` |
| 小組頻道（team） | 小組全員，隨小組成員異動 | 沿用 `TK_team` |

- **〔提案 P1〕** M2 沿用 M0 的 epoch 對稱金鑰機制，以 HPKE 封裝給每位成員的 EK；成員移出時輪替 epoch。理由：重用 M0 程式碼，符合 1–2 人人力（D23）。代價：沒有逐訊息前向保密。OpenMLS 列為 M5 之後的升級選項（technical-design §13.4）。
- 對話設定（名稱、成員、AI 助理設定、歷史訊息政策）存在 `conv/<convId>/meta` 文件，寫入者為對話管理員（建立者及其指定者）。

### 1.2 訊息儲存

訊息是「附加為主」的資料，不適合整份放在單一 Automerge 文件。設計如下：

```
conv/<convId>/log/<yyyy-mm>    // 每月一份 Automerge 文件，內容為 Message 列表（append-only）
conv/<convId>/state            // 每位成員自己寫：已讀游標、釘選、書籤（single-writer 分片：state/<memberId>）
```

```ts
Message {
  id: ULID, convId, authorId, deviceId, createdAt,
  kind: 'text' | 'file' | 'system' | 'assistant',
  body: string,                 // Markdown
  threadRootId?: ULID,          // 討論串
  mentions: MemberId[], attachments: FileRef[],
  editOf?: ULID,                // 編輯：新增一筆指向原訊息
  retracts?: ULID,              // 撤回：新增一筆撤回紀錄
  assistant?: { assistantId, invokedBy, model }   // kind = 'assistant' 時
}
```

- 每筆訊息仍是 SignedChange，驗證層確認作者是對話成員；`editOf` / `retracts` 只能指向自己的訊息（投影層檢查）。
- 本機以 SQLite 投影建立訊息表與全文索引：FTS5 + trigram tokenizer（支援中文子字串搜尋）。索引存在本機、靜態加密。
- 訊息永久保留（D16）；月份分片讓舊月份可只保留快照，降低載入成本。

### 1.3 已讀、提及、通知

- 已讀游標：`state/<memberId>` 記錄每個對話最後已讀的訊息 ID，同步給對話成員以顯示已讀狀態。
- 提及：`mentions` 欄位觸發被提及者的通知；`@all` 限對話管理員。

### 1.4 歷史訊息分享（D19）

- 預設：新成員加入時，處理加入的成員裝置將所有歷史 epoch 的 `CK` 封裝給新成員，新成員再同步 `log/*` 文件。
- 「僅加入後」群組：只封裝新 epoch；加入前的月份文件對新成員為不可解密。
- 每次歷史分享寫入 `conv/<convId>/meta` 的稽核紀錄（誰、何時、分享了哪些 epoch），並於加入時提示新成員與既有成員。

## 2. M2 檔案傳遞

採用 **iroh-blobs**（BLAKE3 驗證串流、支援續傳與部分下載）：

```
傳送端：fileKey = 隨機 32 bytes
        ciphertext = XChaCha20-Poly1305 分塊加密(file, fileKey)   // 每 1 MiB 一塊，各自 nonce
        hash = iroh-blobs 匯入 ciphertext → BLAKE3 hash
        Message.attachments += FileRef{ hash, size, name, mime, fileKey, thumb? }
接收端：從任一持有者（傳送端、其他已下載成員、mailbox）以 hash 取得 → 驗證 → 解密
```

- `fileKey` 只出現在加密後的訊息內，mailbox 與 relay 看不到。
- mailbox 保存上限：單檔 100 MB（可設定），保留 1 年後清除（D16）；超過上限的檔案只走 P2P，需雙方上線。
- ALPN：`/iroh-bytes/4`（iroh-blobs 內建）；mailbox 的 blob 存取需出示憑證鏈。
- 群組檔案區：由投影層彙整對話內所有 `FileRef`。
- 預覽：圖片縮圖由傳送端產生並一起加密；PDF 與影片於本機解密後預覽。

## 3. M2 行動端與推播

### 3.1 Tauri 行動端

- 沿用同一 Rust 核心；行動端 UI 以響應式版面為主，另做底部分頁導覽。
- 背景限制：iOS / Android 背景不常駐 P2P 連線。前景時連線 iroh 同步，背景時只靠推播喚醒。
- Wi-Fi 識別：iOS 需位置權限與 Access WiFi Information entitlement；Android 10+ 需位置權限。拒絕授權時一律標為「遠端」（feature-plan §9）。

### 3.2 推播服務 hills-push

```
裝置註冊：device → hills-push  { deviceCert, platform, pushToken }
發送：   寫入者裝置 → mailbox PUT bundle（附 recipients: memberId[]）
         mailbox → hills-push { recipients }   // 只有收件者，沒有內容
         hills-push → APNs / FCM：{ "type": "sync", "hint": blake3(convId)[0..8] }
接收：   系統顯示通用通知「你有新訊息」；使用者開啟 app 後同步並顯示內容
```

- **〔提案 P2〕** M2 推播只顯示通用文字。iOS Notification Service Extension 在背景解密並顯示內容，留到 M5 評估（需在擴充程式中存取金鑰與 Rust 核心）。
- 推播憑證（APNs key、FCM service account）只放在 hills-push，透過 docker secret 掛載。

## 4. M3 AI Gateway 與 AI 助理

### 4.1 架構

```
成員裝置（Rust 核心）
  ├ 組合上下文：在本機解密取得所需資料（計劃、Scrum、對話訊息）
  ├ 套用政策：檢查此對話 / 此成員是否允許雲端模型
  ├ 雲端：  ──► hills-ai-gateway ──► LLM 供應商（預設 Claude API）
  └ 本地：  ──► Ollama（localhost）
```

- **AI Gateway**（`hills-ai-gateway`，HTTPS）：
  - 驗證：請求附 DeviceCert + MemberCert 鏈，以 DK 簽章請求。
  - 組織 API Key 只存於 Gateway（D9）。
  - 政策：每月用量上限（組織、成員、對話）、模型白名單、是否保留內容。
  - 稽核：預設只記錄中繼資料（誰、哪個助理、模型、token 數、時間），內容保留需管理者明確開啟。
  - 供應商抽象層：以介面隔離，預設實作 Claude API；可擴充其他供應商。
- Gateway 會看到提示詞明文：UI 在啟用雲端模型的對話中顯示「此對話的 AI 內容會送至雲端」標示（feature-plan §9）。

### 4.2 助理設定

```ts
Assistant {
  id, owner: { kind: 'member', memberId } | { kind: 'conversation', convId },
  name, persona: 'secretary' | 'tech-advisor' | 'minutes' | 'custom',
  instructions: string,              // 自訂指令
  model: { provider: 'cloud', id } | { provider: 'local', id },
  dataScope: DataScope[],            // 個人助理：plans / scrum / tasks / attendance / reports
  proactiveRules: ProactiveRule[],   // 個人助理才有
  enabled: boolean
}
```

- 個人助理設定存在本人的 `member/<id>/assistant` 文件（`PK` 加密）。
- 群組助理設定存在 `conv/<convId>/meta`，對話成員皆可看到設定與資料範圍。

### 4.3 執行模型

- **個人助理**在本人裝置執行，只能讀取本人有權讀取的資料。
- **群組助理**由「呼叫者的裝置」執行：成員 @助理 後，其裝置以該對話最近 N 則訊息（與助理設定允許的檔案）組成上下文並呼叫模型，回覆以 `kind: 'assistant'` 訊息寫入對話，簽章者為呼叫者裝置、`assistant.invokedBy` 標示呼叫者。助理因此不需要自己的金鑰，也無法讀到呼叫者讀不到的內容。
- **人在迴路中**（D17）：模型輸出一律先成為草稿或「建議動作卡」，例如 `CreateTask{…}`、`UpdateKeyResult{…}`、`PublishReport{…}`；使用者按下確認後，才由一般寫入流程產生 change。群組助理的回覆訊息本身例外：被 @ 時直接回覆是使用者明確要求的動作。

### 4.4 主動提醒

主動提醒以**本機規則引擎**判斷是否觸發，只有產生草稿時才呼叫模型，以節省用量：

| 規則 | 觸發條件（本機計算） | 動作 |
|------|---------------------|------|
| 計劃落後 | 關鍵結果進度 < 時間進度 − 門檻 | 提醒 + 調整建議（呼叫模型） |
| Scrum 未填 | 工作日提醒時間後仍未提交 | 提醒 + 草稿（呼叫模型） |
| 待辦逾期 | 任務 / 會議待辦超過期限 | 提醒（不呼叫模型） |
| 週期結束 | 週五 / 月底 | 報表與回顧草稿（呼叫模型） |

## 5. M3 外部整合

### 5.1 Google Calendar（成員個人授權）

- 在客戶端執行 OAuth（PKCE、loopback redirect），refresh token 存在本機 keychain，不經伺服器。
- 讀取：會議時段 → 本機自動切換 Presence 為「會議中」。
- 寫入：核准的請假寫入行事曆；從 Hills 排定會議時建立事件並附通話連結。
- 只在本人裝置在線時同步，接受此限制（行事曆同步不需即時）。

### 5.2 GitHub（組織層級 GitHub App）

- `hills-integrations` 服務接收 GitHub App webhook。
- 服務持有一個**整合機器人身分**（MemberCert 角色 `integration`），只能寫 `integration/github` 文件；該文件以專用的整合金鑰 `IK_int` 加密，封裝給全員與機器人。機器人拿不到 `GK`、`TK` 等其他金鑰。
- 成員裝置讀取 `integration/github`：依 GitHub 帳號對應（成員自行綁定 GitHub 帳號）把 PR / Issue / Commit 帶入 Scrum 草稿；PR 合併時對已連結的任務產生「標為完成」建議動作卡。
- Repo 事件推送到指定頻道：由在線的頻道成員裝置轉貼為 `system` 訊息（機器人不持有對話金鑰）。

## 6. M4 語音 / 視訊會議

### 6.1 媒體路徑

- **〔提案 P3〕** M4 全部通話（含一對一）都走自架 LiveKit SFU，P2P mesh 延到 M5 之後再評估。理由：
  1. 一套媒體路徑，1–2 人可維護（D23）。
  2. Linux 的 WebKitGTK 對 WebRTC 支援有限；改用 LiveKit Rust SDK 在 Rust 核心處理媒體，可避開 webview 差異。
  3. 錄影、會議摘要本來就需要 SFU。
  此提案與 D10（2–4 人 P2P mesh）衝突，需確認後更新決策表。
- 若維持 D10：P2P 通話以 webrtc-rs 或 libwebrtc 在 Rust 核心實作，信令走 iroh 連線（`hills/call/1`），第 5 人加入時改由 LiveKit 接手。

### 6.2 會議流程

1. 發起者向 `hills-call`（LiveKit token 服務）以憑證鏈換取 LiveKit access token。
2. 房間名稱 = blake3(orgId ‖ meetingId)，不洩漏對話名稱。
3. 預設啟用 LiveKit E2EE（金鑰由發起者產生，以對話金鑰加密後放在會議邀請訊息中）。
4. 錄影時必須關閉 E2EE：發起者開啟錄影 → 全員收到同意提示 → 切換為非 E2EE 並由 LiveKit Egress 錄製。
5. 會議摘要：錄音經 AI Gateway 轉文字（供應商可設定），再產生摘要與待辦，以「建議動作卡」呈現。

### 6.3 部署新增

`livekit`（含 TURN/TLS）、`livekit-egress`（錄影，選配）、`hills-call`（token 服務）加入 docker-compose。

## 7. M5 完善與開源

- **月報 / 年報**：沿用 D32 四欄，彙總「目標達成率」與「回顧」；年報加季度演進圖表。
- **訪客**：MemberCert 角色 `guest`，只能加入被邀請的對話，取得對應 `CK`；不取得 `GK`，因此看不到團隊看板、計劃、出勤。
- **Jira / Linear**：同 GitHub 的整合機器人模式（各自的整合金鑰）。
- **管理後台進階**：AI 用量儀表板、稽核紀錄檢視、雙管理者確認（選配）、資料匯出。
- **開源發佈**（D25）：
  - 外部資安審查（加密設計與實作）
  - `SECURITY.md`（通報管道與回應時程）、`CONTRIBUTING.md`、Code of Conduct
  - 自架指南、升級指南、API / 協定文件
  - 檢查 commit 歷史無機密

## 8. 新增協定與服務一覽

| 名稱 | 類型 | 版本 |
|------|------|------|
| `/iroh-bytes/4` | iroh-blobs | M2 |
| `hills-push` | HTTPS 服務 | M2 |
| `hills-ai-gateway` | HTTPS 服務 | M3 |
| `hills-integrations` | HTTPS 服務（webhook）+ iroh 節點 | M3 |
| `hills-call` | HTTPS 服務（LiveKit token） | M4 |
| `hills/call/1` | iroh ALPN（僅在 D10 維持 P2P 時） | M4 |

## 9. 提案與待決事項

| 編號 | 提案 | 影響的決策 | 狀態 |
|------|------|-----------|------|
| P1 | M2 聊天沿用 epoch 對稱金鑰，OpenMLS 延到 M5 之後 | 新增決策 | 待確認 |
| P2 | M2 推播只顯示通用文字，iOS 背景解密延到 M5 評估 | 新增決策 | 待確認 |
| P3 | M4 全部通話走 LiveKit SFU，P2P mesh 延後 | 修改 D10 | 待確認 |

其他待決：

1. 語音轉文字供應商與是否允許本地模型（如 Whisper）處理會議錄音。
2. Google Calendar 是否需要「伺服器端同步」以在成員離線時也更新狀態（目前設計為否）。
3. 單檔 100 MB 的 mailbox 上限是否合適。
