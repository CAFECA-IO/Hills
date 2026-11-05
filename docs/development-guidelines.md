# Hills 開發規範

> 版本：v0.1 · 2026-11-05 · 適用對象：所有人類開發者與 AI Agent
> AI Agent 另需遵守 [AGENTS.md](../AGENTS.md)。本文件與規劃文件衝突時，以規劃文件為準（見 [docs/README.md](./README.md) 的文件優先順序）。

## 1. 文件優先（Docs-first）

1. **規劃文件是唯一事實來源**。程式碼行為必須與文件一致。
2. **先改文件，再改程式碼**。任何會改變功能、協定、資料模型、加密流程、UI 流程或決策的修改，必須在同一個 PR（或更早的 PR）先更新對應文件。
3. **決策要留紀錄**。新增或變更決策時，在 [feature-plan.md](./feature-plan.md) §2 決策表新增一列（新編號，不覆寫舊編號）；被取代的決策標註「由 Dxx 取代」。
4. **提案不是決策**。文件中標示〔提案〕的內容，在轉為決策前不得實作。
5. 文件更新時，同步更新文件開頭的版本號與日期，並在 feature-plan 的「文件版本紀錄」加一行。

## 2. Repo 結構

```
AGENTS.md  CLAUDE.md  README.md  LICENSE
docs/        規劃與設計文件（見 docs/README.md）
crates/      Rust 函式庫（hills-proto / identity / crypto / store / sync / net / domain）
apps/        desktop（Tauri）、mailbox、tsa、storage，以及後續服務
packages/    前端共用 TypeScript 套件（swarm：SwarmStorage 管線）
poc/         PoC 工具（net-echo、automerge-sync）
deploy/      docker-compose.yml、.env.example
holidays/    假日曆資料（holidays/<region>/<year>.json）
scripts/     開發與維運腳本
```

新增頂層目錄或新 crate 前，先更新 technical-design §1。

## 3. 分支、Commit 與 PR

- `main` 永遠可建置；禁止直接 push 到 `main`。
- 分支命名：`<type>/<issue號>-<簡短描述>`，例如 `feat/12-invite-flow`、`docs/feature-plan`。
- Commit 採 [Conventional Commits](https://www.conventionalcommits.org/)：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`、`ci`；scope 用 crate 或模組名，例如 `feat(identity): derive IK from BIP39 seed`。
- Commit 訊息使用英文；文件與 UI 文字以繁體中文為主。
- PR 必須連結 Issue（`Closes #12`），並勾選 PR 檢查清單：
  - [ ] 已閱讀相關規劃文件，實作與文件一致
  - [ ] 行為、協定、資料模型或 UI 有變更時，已先更新文件
  - [ ] 新增 / 修改的程式碼有測試
  - [ ] 未提交任何金鑰、token、`.env`、個人資料
  - [ ] CI 全數通過

## 4. 程式碼規範

### 4.1 Rust

- Edition 2021 以上；`cargo fmt`、`cargo clippy -- -D warnings` 必過。
- 函式庫使用 `thiserror` 定義錯誤型別；應用層可用 `anyhow`。禁止在函式庫中 `unwrap()` / `expect()`（測試除外）。
- 非同步使用 `tokio`。
- 所有網路訊息型別定義在 `hills-proto`，帶 `v` 版本欄位；修改既有訊息必須保持向後相容，或新增版本號。
- 密碼學只呼叫 technical-design §2 列出的函式庫；禁止自行實作加密原語或協定。

### 4.2 TypeScript / React

- `strict` 模式；ESLint + Prettier 必過。
- 前端不直接處理金鑰或加密，只透過 Tauri commands 讀取投影、送出寫入意圖。
- 樣式使用 Tailwind 與設計系統 token，禁止寫死色碼（主題色需可由組織覆寫，D22）。
- 所有使用者可見文字經 i18n（繁中為預設、英文為第二語言），禁止寫死在元件中。

### 4.3 可設定性（開源需求，D20）

組織名稱、品牌、時區、假日曆、假別、工作規則、核准規則一律來自組織設定，程式碼中不得寫死 CAFECA 專屬值。

## 5. 測試

| 層級 | 要求 |
|------|------|
| 單元測試 | `hills-domain` 的工時、特休、核准、工作日判定需涵蓋邊界案例；`hills-crypto` / `hills-identity` 需有固定測試向量 |
| 屬性測試 | CRDT 合併與驗證層使用 `proptest`：任意順序套用 change 結果一致 |
| 整合測試 | 多節點測試框架：在單機啟動多個節點 + mailbox，模擬上下線、斷線、重連 |
| 前端 | 元件測試（Vitest + Testing Library）；主要流程以 Playwright 做 E2E |
| 法規相關 | 特休級距、假別規則的測試案例需註明法條與查證日期 |

新功能沒有測試不得合併。修 bug 時先寫一個重現 bug 的測試。

## 6. 資安規則

- repo 為公開（D25）：禁止提交金鑰、token、憑證、`.env`、內部網址、真實個人資料。測試資料使用假資料。
- 日誌禁止記錄：私鑰、對稱金鑰、復原詞、訊息內容、計劃 / 出勤內容。可記錄 ID 與中繼資料。
- 錯誤訊息不得洩漏金鑰或明文資料。
- 新增依賴前確認授權與 MIT 相容（MIT、Apache-2.0、BSD、ISC、MPL-2.0 可；GPL / AGPL 需先討論），並檢查維護狀態。`cargo deny` 與 `pnpm audit` 於 CI 執行。
- 修改加密、金鑰流程、驗證層的 PR 至少需一位人類審查者核准。

## 7. 隱私

- 伺服器端（relay、mailbox、push、AI Gateway）只能接觸 technical-design 明列的資料；新增任何伺服器端可見的欄位，需先更新文件並說明理由。
- 位置資訊只存 Wi-Fi 雜湊，不收集 GPS（D11）。
- 遙測一律 opt-in。

## 8. 發佈

- 版本號採 SemVer；協定版本與 app 版本分開管理。
- 每次發佈更新 `CHANGELOG.md`。
- 安裝檔必須簽章（macOS notarization、Windows code signing）。
