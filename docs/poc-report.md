# M0 PoC 報告

> 版本：v0.6 · 2026-11-06 · 對應 technical-design §12、§15.8；Issue「[M0][PoC] …」各項
> 狀態：**部分完成**。macOS 與 Windows WebView 檔案管線通過；Windows 已經自架 mailbox + relay 加入組織。NAT 矩陣、安裝檔與 §5.4 其餘項目待實測。

## 1. 結論摘要

| 項目 | 通過標準 | 目前結果 | 狀態 |
|------|---------|---------|------|
| iroh 穿透 | 各網路組合皆可連線 | 本機雙行程直連成功；NAT 矩陣待測 | ⏳ 待實測 |
| Automerge 同步 | 一致、無遺失、合併 < 1 秒 | 一致；100 次 / 副本合併 3.4 ms | ✅ 通過 |
| 多節點同步（hills-node） | 即時 ≤ 2 秒、離線補同步 ≤ 5 秒 | 本機：gossip + 直連 120 ms、離線補同步 209 ms；加入、presence、綁定、停用輪替、復原皆通過 | ✅ 本機通過；Windows 已經自架部署加入組織，⏳ §5.4 其餘項目待測 |
| 加密 bundle + mailbox | 補同步 ≤ 5 秒 | 3 份 bundle 補同步 77–90 ms（debug）、6 ms（release），本機直連 | ✅ 通過（跨網路待 §5.1 一併實測） |
| RS 與 SwarmStorage 相容 | 逐位元組一致 | 5 組向量全部一致 | ✅ 通過 |
| 前端加密 / 編碼效能 | 每平台 ≥ 50 MB/s、記憶體 < 200 MB | **macOS WKWebView 366–401 MB/s、WebContent 行程 78.5 MB；Windows WebView2 120–125 MB/s，記憶體在 200 MB 內**；Node 192 MB/s、Chromium Worker 123 MB/s | ✅ macOS、Windows 通過 |
| 桌機打包 | macOS、Windows 可安裝啟動 | Linux 可建置並啟動；CI 已設定 macOS / Windows 打包 | ⏳ 待 CI / 實機 |

**go / no-go**：待 §5 實測完成後填寫。目前沒有任何項目顯示需要更換 iroh 或 Automerge。

## 2. 測試環境（雲端）

- Linux x86_64，2 vCPU（Intel Xeon 2.30GHz），7 GB RAM
- Rust 1.97、Node 22.23、Chromium 153（headless）、WebKitGTK 2.52
- 套件：iroh 1.4.1、automerge 0.12.0、tauri 2.12.5

## 3. 已完成的測試

### 3.1 Automerge 離線合併（`poc/automerge-sync`）

兩個副本由同一份計劃文件 fork，各自離線編輯（新增項目、改標題、勾選完成、兩人同時修改同一個 KR），再以 Automerge sync protocol 交換**編碼後**的訊息。

| 每副本編輯次數 | 一致 | 同步耗時 | 往返 | 傳輸 | 儲存大小 | 項目數 |
|---:|:---:|---:|---:|---:|---:|---:|
| 100 | ✅ | 3.4 ms | 2 | 4.2 KB | 2.1 KB | 51 |
| 1,000 | ✅ | 28.5 ms | 2 | 14.8 KB | 6.9 KB | 501 |

- 同時修改同一個 KR 數值時，雙方得到相同結果（Automerge 以確定性規則選出勝者）。
- 存檔後重新載入，內容一致。
- 測試：`cargo test -p automerge-sync`（含「合併 < 1 秒」斷言）。

### 3.2 iroh 連線（`poc/net-echo`）

| 情境 | 路徑 | 建立連線 | 往返中位數（64 KB × 20） |
|------|------|---:|---:|
| 同一台主機、兩個行程、停用 relay | direct | 2.0 ms | 0.45 ms |

只驗證工具本身與 API 用法；跨 NAT 才是此 PoC 的重點，見 §5.1。

### 3.3 Reed-Solomon 相容性（`packages/swarm`）

- `src/rs.ts` 移植自 SwarmStorage `src/lib/reed_solomon_erasure.ts`（commit `5a073e7`，MIT）。
- 以 SwarmStorage **原始程式**產生 5 組向量（分片大小 1 B、7 B、4 KB、64 KB+1、4 MiB+4），本專案實作的同位分片 SHA-256 全部一致（`test/rs.compat.test.ts`）。
- 8 片中任選 3 片遺失的全部 56 種組合皆可還原；遺失 4 片時正確拒絕。

### 3.4 逐條帶加密管線（`packages/swarm`）

依 technical-design §15.2–15.4 實作，測試涵蓋：

- 多條帶與最後一個較短的條帶、空檔案
- 任 3 個節點離線、單一分片損壞（以 SHA-256 偵測並改用同位分片）
- 可用分片少於 5 → `UNRECOVERABLE`；金鑰錯誤 → `DECRYPT_FAILED`
- 條帶重排、截斷（stripeCount 不同）、混用其他檔案（fileId 不同）皆解密失敗
- 同時最多 1 個條帶上傳中（記憶體上限）
- manifest 不含檔案金鑰

### 3.5 前端效能

| 執行環境 | 大小 | 加密 + 編碼 | 解碼 + 解密 | 記憶體 |
|---------|---:|---:|---:|---|
| Node 22（主執行緒） | 1 GB | 191.8 MB/s | 731.4 MB/s | 存活 100 MB（含基準本身 20 MB 資料）；RSS 峰值 391 MB |
| Chromium 153 Web Worker（WebView2 代理） | 256 MB | 122.6 MB/s | 326.2 MB/s | Worker 內無法量測 |

- **存活記憶體**（每個條帶後強制 GC 的 heap + ArrayBuffer）約 100 MB，符合 < 200 MB；**RSS** 偏高是因為 V8 不會立即把釋放的記憶體還給作業系統，實機量測時請以作業系統的工作管理員 / 活動監視器觀察 Hills 行程的記憶體。
- 已做的最佳化：資料分片 0–3 直接引用密文 buffer，每條帶少複製 20 MB。
- 若 WebView 實測不足 50 MB/s：RS 改用 WASM（`reed-solomon-erasure` crate），或改由 Rust 核心處理（需更新 D35）。

### 3.6 加密 bundle + mailbox（`apps/mailbox/tests/e2e.rs`）

真實 iroh 連線（停用 relay、本機直連）：

1. 管理者以 OK 簽發的憑證連線（bootstrap），推送 roster。
2. 小組金鑰 epoch 1 以 HPKE 封裝給 alice、bob。
3. alice 離線期間，bob 編輯小組文件 3 次，每次以 DK 簽署 change、以小組金鑰加密成 bundle 上傳；重送同一份被去重。
4. alice 上線：連線 + Hello → LIST → 解密 → 驗證層驗證簽章、信任鏈與寫入權限 → 套用。

| 建置 | 補同步耗時（含連線與 Hello） | 結果 |
|------|---:|------|
| debug | 77–90 ms | alice 與 bob 的文件 heads 一致，無被拒 change |
| release | 6.1 ms | 同上 |

同一組測試也驗證：未 Hello、陌生組織、憑證與連線 NodeId 不符的裝置被拒；一般成員不能推送 roster；撤銷成員後其**既有連線**立即失效；bundle_hash 不符被拒；mailbox 重啟後 roster 與 bundle 仍在。

### 3.6.1 多節點整合（`crates/hills-node/tests/multi_node.rs`）

一個 mailbox（未綁定模式）+ 多個 node，停用 relay、本機直連，debug build：

| 情境 | 結果 |
|------|------|
| 管理者離線時送出加入申請，上線後自動核准 | ✅ |
| org 文件變更經 gossip + 直連到達 | ✅ 120 ms（標準 ≤ 2 秒） |
| 離線期間的變更上線後經 mailbox 補同步 | ✅ 209 ms（標準 ≤ 5 秒） |
| presence ≤ 2 秒到達、關閉後逾時判定離線 | ✅ |
| 新裝置綁定（SAS 一致後取得身分並同步） | ✅ |
| 停用成員：金鑰輪替，被停用者遭 mailbox 拒絕、讀不到新資料 | ✅ |
| 刪除本機資料後以繁中復原詞 + 組織連線碼還原 | ✅ |

連續執行 3 次皆通過。

### 3.7 桌機 app

- Tauri 2.12.5 + React 19 + Vite 8 + Tailwind 4；Linux（WebKitGTK）可建置並啟動。
- 開發模式提供 `#/dev/swarm-bench` 頁面，在 Web Worker 中執行 §3.5 的基準（正式版不包含）。

## 4. 已知問題

| 問題 | 影響 | 處理 |
|------|------|------|
| TypeScript 7 尚未被 typescript-eslint 支援 | 無 | 暫時固定 TypeScript 6.0 |
| `paste`、`proc-macro-error` 停止維護通知（RUSTSEC-2024-0436、0370） | 無安全漏洞，皆為上游編譯期 macro | `deny.toml` 記錄後忽略，上游更新後移除 |
| `zbus_names`、`zvariant`、`zvariant_derive` 停止維護通知（RUSTSEC-2026-0370–0372） | 只在 Linux 經 keyring → Secret Service 引入；無安全漏洞 | `deny.toml` 記錄後忽略，keyring 升級 zbus 6 後移除 |
| ESLint 依賴的 minimatch 有 moderate 等級 advisory | 只影響開發工具 | CI 以 high 為門檻；待 ESLint 更新 |

## 5. 待實測（需在實機執行）

### 5.1 iroh NAT 矩陣

兩台電腦（Mac 與 Windows 筆電）都需要 Rust 工具鏈（見 README「開發環境」）。

```bash
# 電腦 A
cargo run --release -p net-echo -- listen
# 電腦 B（貼上 A 印出的 ticket）
cargo run --release -p net-echo -- dial <ticket> --count 20 --size 65536
```

每個組合記錄 dial 輸出的 JSON。先用官方 relay 測，再以 `deploy/poc/` 架好自架 relay 後加上 `--relay https://<網域>` 重測。

| A 網路 | B 網路 | relay | path | connect_ms | rtt_median_ms |
|--------|--------|-------|------|---:|---:|
| 公司 Wi-Fi | 家用寬頻 | 官方 | | | |
| 公司 Wi-Fi | 手機熱點（CGNAT） | 官方 | | | |
| 家用寬頻 | 手機熱點（CGNAT） | 官方 | | | |
| 企業防火牆 | 家用寬頻 | 官方 | | | |
| （以上重複） | | 自架 | | | |

### 5.2 WebView 檔案管線效能

在 Mac 與 Windows 筆電各執行：

```bash
pnpm install
pnpm --filter @hills/desktop tauri dev
```

**macOS 記憶體量測說明**（活動監視器，1024 MB 測試期間最高值）：

| 行程 | 記憶體 | 說明 |
|------|---:|------|
| `http://localhost:1420`（WebContent） | 78.5 MB | 前端與 Web Worker 所在行程，**即本項的量測對象** |
| hills-desktop Graphics and Media | 70.9 MB | WebKit 繪圖行程，與檔案管線無關 |
| hills-desktop | 45.3 MB | Tauri / Rust 主行程 |
| hills-desktop Networking | 8.2 MB | WebKit 網路行程 |

WebContent 行程 78.5 MB < 200 MB，通過。四個行程合計約 203 MB，為整個 app 的占用，不是檔案管線的成本。活動監視器預設數秒更新一次，1 GB 測試只跑約 3 秒，峰值可能被低估；之後若需更精確，可在「顯示方式 → 更新頻率」改為「非常頻繁」再測。

在開啟的視窗中前往「開發工具：檔案管線效能測試」，以 256 MB 與 1024 MB 各測一次，並在測試期間用活動監視器 / 工作管理員記錄 Hills 行程的記憶體峰值。把畫面上的 JSON 與記憶體峰值填入下表：

| 平台 | WebView | 大小 | encodeMBps | decodeMBps | 記憶體峰值 |
|------|---------|---:|---:|---:|---:|
| macOS（MacBook Air M4） | WKWebView | 256 MB | 366.2 | 1857.1 | 待記錄 |
| macOS（MacBook Air M4） | WKWebView | 1024 MB | 400.6 | 1969.1 | 78.5 MB（WebContent） |
| macOS（MacBook Air M4） | Chrome 156 瀏覽器（Blink，與 WebView2 同引擎；非 Tauri 視窗） | 1024 MB | 288.5 | 1239.2 | 待記錄 |
| Windows | WebView2 | 256 MB | 120.5 | 401.4 | < 200 MB（使用者回報） |
| Windows | WebView2 | 1024 MB | 124.7 | 383.2 | < 200 MB（使用者回報） |

### 5.3 安裝檔

push 後 CI 的「Desktop bundle」job 會產生未簽章的 `.dmg`、`.exe`、`.msi`（Actions 頁面的 artifacts）。在 Mac 與 Windows 各安裝一次並確認可開啟。未簽章的 macOS 安裝檔需在「系統設定 → 隱私權與安全性」允許開啟。

### 5.4 M0 驗收：Mac + Windows 跨網路

依 [deploy.md](./deploy.md) 在雲端主機部署 relay + mailbox，再依 deploy.md §6 執行。記錄：

| 項目 | 結果 |
|------|------|
| Mac 建立組織、Windows 以邀請碼加入（不同網路） | ✅ 2026-11-06，經自架 mailbox + relay（relay.cafeca.io）加入成功 |
| 狀態文字同步時間 | |
| 組織名稱即時同步時間 | |
| Windows 關閉期間的變更，重新開啟後補同步 | |
| 綁定第二台裝置 | |
