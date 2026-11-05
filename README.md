# 山丘上的卡菲卡
**站在山丘上，俯瞰團隊前進方向**

CAFECA 團隊的協作工具，提供成員安排與回報每日 Scrum 的任務，自動化生成的日報、週報、月報、年報，並提供即時通訊服務與線上會議平台。

## 文件

規劃與設計文件在 [docs/](docs/README.md)。開始任何工作前請先閱讀 [AGENTS.md](AGENTS.md)：**文件是唯一事實來源，修改專案前先修改文件**。

## 開發環境

| 工具 | 版本 |
|------|------|
| Rust | stable（見 `rust-toolchain.toml`，需 ≥ 1.91） |
| Node.js | 22 以上 |
| pnpm | 10（`corepack enable`） |

### macOS

1. 安裝工具（第一次）：

   ```bash
   xcode-select --install                                          # Xcode Command Line Tools
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
   brew install node@22                                            # 或用 nvm 安裝 Node 22
   corepack enable                                                 # 啟用 pnpm
   ```

2. 安裝依賴並以開發模式啟動（會開出 app 視窗，改前端程式碼即時更新）：

   ```bash
   pnpm install
   pnpm --filter @hills/desktop tauri dev
   ```

3. 編譯安裝檔：

   ```bash
   pnpm --filter @hills/desktop tauri build
   ```

   產出在 `target/release/bundle/`：`macos/Hills.app`、`dmg/Hills_<版本>_aarch64.dmg`。

   同時支援 Apple Silicon 與 Intel Mac 的安裝檔：

   ```bash
   rustup target add aarch64-apple-darwin x86_64-apple-darwin
   pnpm --filter @hills/desktop tauri build --target universal-apple-darwin
   ```

4. 目前的安裝檔沒有簽章（M1「安裝檔簽章與自動更新」處理），第一次開啟會被阻擋：到「系統設定 → 隱私權與安全性」按「仍要打開」，或執行 `xattr -cr target/release/bundle/macos/Hills.app`。

### Windows

1. 安裝工具（第一次）：
   - **Visual Studio Build Tools**：勾選「使用 C++ 的桌面開發」
   - **Rust**：https://rustup.rs 下載 `rustup-init.exe`，使用預設的 MSVC 工具鏈
   - **Node.js 22**：https://nodejs.org 下載 LTS 安裝檔
   - **pnpm**：以系統管理員身分開 PowerShell 執行 `corepack enable`，或 `npm install -g pnpm`
   - **WebView2**：Windows 10 / 11 已內建

2. 安裝依賴並以開發模式啟動（PowerShell）：

   ```powershell
   pnpm install
   pnpm --filter @hills/desktop tauri dev
   ```

3. 編譯安裝檔：

   ```powershell
   pnpm --filter @hills/desktop tauri build
   ```

   產出在 `target\release\bundle\`：`nsis\Hills_<版本>_x64-setup.exe`、`msi\Hills_<版本>_x64_en-US.msi`。第一次編譯時 Tauri 會自動下載 NSIS 與 WiX。

4. 安裝檔沒有簽章，SmartScreen 會警告：點「其他資訊 → 仍要執行」。

### Linux

需要 `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev`；Linux 桌機版於 M2 發佈（D34）。

### 測試與常用指令

```bash
cargo test --workspace && pnpm -r test      # 全部測試
cargo run --release -p net-echo -- listen   # PoC：iroh 連線測試（見 docs/poc-report.md §5）
```

檔案管線效能測試：以開發模式開啟 app，點「開發工具：檔案管線效能測試」。其他指令見 [AGENTS.md §7](AGENTS.md#7-常用指令)。

### 常見問題

- **第一次編譯很慢**：Rust 需編譯約 600 個套件（Mac 約 3–5 分鐘、Windows 約 5–10 分鐘），之後只重新編譯有改動的部分。
- **Windows 出現 `link.exe not found`**：Build Tools 沒有勾選 C++ 工作負載，重新安裝並勾選。
- **Windows 11 上 MSI 打包失敗**：WiX 需要 VBScript，到「設定 → 系統 → 選用功能」加回 VBSCRIPT；或只產生 NSIS 安裝檔：`pnpm --filter @hills/desktop tauri build --bundles nsis`。
- **找不到 `pnpm`**：重開終端機讓 corepack 設定生效。

## 目錄

```
crates/     Rust 核心函式庫（身分、加密、同步、網路、領域規則）
apps/       desktop（Tauri 2）、mailbox、tsa、storage 服務
packages/   前端共用套件（swarm：SwarmStorage 檔案管線）
poc/        M0 技術驗證工具
deploy/     部署設定
docs/       規劃與設計文件
```

## 授權

[MIT](LICENSE)
