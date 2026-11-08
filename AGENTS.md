# AGENTS.md：AI Agent 工作守則

本檔規範所有在此 repo 工作的 AI Agent（Claude Code、Codex、Cursor、Copilot 等），人類開發者也一併適用。
**開始任何工作前必須讀完本檔。** 本檔的規則優先於 Agent 自身的預設習慣。

## 1. 專案一句話

Hills（山丘上的卡菲卡）是 CAFECA 的 P2P 工作協作工具：出勤與假勤、年→週目標與其下的任務、每日 Scrum、自動報表、即時通訊、檔案、會議，以及個人與群組 AI 助理。技術：Tauri 2（Rust 核心 + React/TS）、iroh、Automerge；檔案依 SwarmStorage 原理（前端逐條帶加密 + Reed-Solomon 8/5 分片）存於自架儲存節點；自架服務以 Docker Compose 部署。M1 目標：Mac 與 Windows 筆電可安裝、互相對話與分享檔案。

## 2. 文件是唯一事實來源

文件優先順序（上面的優先；彼此衝突時以上層為準，並回報衝突）：

1. [docs/feature-plan.md](docs/feature-plan.md) §2 **決策表（D1…）**：已確認的方針
2. [docs/feature-plan.md](docs/feature-plan.md) 其他章節：功能範圍、里程碑、驗收指標
3. [docs/technical-design.md](docs/technical-design.md)（M0/M1）、[docs/technical-design-m2-m5.md](docs/technical-design-m2-m5.md)（M2–M5）：協定、資料模型、金鑰流程
4. [docs/ui-spec.md](docs/ui-spec.md)：畫面與流程
5. [docs/development-guidelines.md](docs/development-guidelines.md)：開發規範
6. [docs/backlog/](docs/backlog/) 與 GitHub Issues：工作項目
7. 程式碼

完整索引見 [docs/README.md](docs/README.md)。

## 3. 開工前必讀

| 任務類型 | 必讀 |
|---------|------|
| 任何任務 | 本檔、feature-plan §2 決策表、對應的 Issue |
| 身分、金鑰、加密、驗證層 | technical-design §2–4、§11；development-guidelines §6 |
| 網路、同步、伺服器服務 | technical-design §4–6、§10 |
| 假勤、計劃、Scrum、報表規則 | feature-plan §5.2–5.5；technical-design §7–8 |
| M1 對話、檔案分享（SwarmStorage 原理） | technical-design §14–15；feature-plan D34–D37；ui-spec「聊天」「檔案分享」 |
| M2 之後的聊天進階、行動端、AI、整合、通話 | technical-design-m2-m5 對應章節 |
| 任何 UI | ui-spec 對應章節與「共通規則」；[docs/design-system.md](docs/design-system.md)、[docs/components.md](docs/components.md) |

讀完後，在回覆或 PR 描述中列出「依據的文件章節」。

## 4. 文件優先工作流程（強制）

每個任務依下列流程判斷：

```
需求是否與文件一致？
 ├─ 一致 ──────────────► 實作 → 測試 → PR（列出依據章節）
 ├─ 文件沒寫到（細節空白）
 │    ├─ 細節不影響行為（變數命名、內部重構）──► 直接實作
 │    └─ 會影響行為、協定、資料模型、UI 流程 ──► 先補文件，再實作
 └─ 與文件衝突，或要改變既有決策
      └─ 停止實作 → 向使用者說明衝突與選項 → 取得確認
         → 先更新文件（決策表新增 D 編號、更新對應章節、版本號）
         → 再實作
```

具體規則：

1. **不得實作與文件衝突的內容**，即使使用者的指示看似如此要求；先指出衝突並詢問要改文件還是改需求。
2. **專案調整一律先改規劃文件**：範圍、優先順序、里程碑、技術選型、資料模型、協定、UI 流程有任何變更，先修改文件，文件修改與程式碼修改可在同一個 PR，但文件 commit 在前。
3. **決策表只新增不覆寫**：新決策用下一個 D 編號；取代舊決策時，在舊列加註「由 Dxx 取代」。
4. **〔提案〕不得實作**：technical-design-m2-m5 §9 的 P1…等提案，在轉為決策前不能寫進程式碼。
5. **更新文件時同步**：文件開頭版本號與日期、feature-plan「文件版本紀錄」、受影響的 backlog JSON（並以 `python3 scripts/render-backlog.py` 重新產生 .md）；milestone 或 Issue 改名、移除時，同時記錄在 `docs/backlog/renames.json`。
6. **不確定就問**：文件有兩種以上合理解讀時，向使用者確認，不要自行選擇後默默實作。

## 5. 禁止事項

- 自行實作密碼學原語或協定；使用 technical-design §2 以外的加密函式庫。
- 讓伺服器端（relay、mailbox、push、AI Gateway、integrations）看到文件未列出的明文資料。
- 提交金鑰、token、`.env`、憑證、真實個人資料（repo 為公開，D25）。
- 在日誌或錯誤訊息中輸出金鑰、復原詞或業務資料內容。
- 寫死 CAFECA 專屬設定（D20）；寫死 UI 文字（需 i18n）或色碼（需設計系統 token）。
- 在 `apps/desktop/src/ui/` 以外直接寫原生互動元素（button、input、select、textarea）或任意樣式值；畫面只能組合通用元件與 token（D45，docs/components.md、docs/design-system.md）。
- 讓 AI 助理未經使用者確認就送出訊息、修改計劃 / 任務或發佈報表（D17）。
- 直接 push 到 `main`、改寫已推送的歷史、刪除或停用測試以讓 CI 通過。
- 引入 GPL / AGPL 等與 MIT 不相容的依賴而未先討論。

## 6. 完成的定義

一個任務要同時滿足以下條件才算完成：

- [ ] 實作符合文件；PR 描述列出依據的文件章節
- [ ] 若有行為變更，文件已先更新
- [ ] 測試涵蓋新行為（規則見 development-guidelines §5），全部通過
- [ ] `cargo fmt`、`cargo clippy -D warnings`、ESLint、Prettier 通過
- [ ] 沒有機密資料進版控
- [ ] Issue 中的驗收條件逐項達成

## 7. 常用指令

```bash
# 安裝依賴
pnpm install

# Rust：格式、lint、測試
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# 前端：lint、測試、建置
pnpm -r lint
pnpm -r test
pnpm -r build

# 桌機 app 開發模式（需在 macOS / Windows，或已安裝 webkit2gtk 的 Linux）
pnpm --filter @hills/desktop tauri dev

# PoC
cargo run -p net-echo -- listen
cargo run --release -p automerge-sync
pnpm --filter @hills/swarm bench

# 修改 docs/backlog/*.json 後重新產生總覽
python3 scripts/render-backlog.py

# 讓 GitHub Milestones / Labels / Issues 與 backlog 一致（處理改名、移除；預設 dry-run）
python3 scripts/sync-github-backlog.py
python3 scripts/sync-github-backlog.py --apply
```

## 8. 回報格式

完成工作時，回報：

1. 做了什麼（一兩句）
2. 依據的文件章節
3. 文件是否有修改，修改了哪裡
4. 尚未解決的問題或發現的文件衝突
