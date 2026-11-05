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

各平台額外需求：

- **macOS**：Xcode Command Line Tools（`xcode-select --install`）
- **Windows**：Visual Studio Build Tools（「使用 C++ 的桌面開發」）與 WebView2（Windows 10/11 已內建）
- **Linux**：`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev`

```bash
pnpm install
pnpm --filter @hills/desktop tauri dev     # 開啟桌機 app（開發模式）
cargo test --workspace && pnpm -r test     # 全部測試
```

常用指令見 [AGENTS.md §7](AGENTS.md#7-常用指令)。

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
