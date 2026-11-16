# 發佈 Alpha 版

> 版本：v0.1 · 2026-11-16 · 依 [feature-plan.md](./feature-plan.md) D75、[technical-design.md](./technical-design.md) §12.1

Alpha 版由 GitHub Actions 的 `Release` workflow（`.github/workflows/release.yml`）建置：macOS 版以 Developer ID 簽章並經 Apple 公證，Windows 版暫不簽章。安裝檔放在 GitHub Releases 的 **draft pre-release**，檢查後再發佈。

## 1. 一次性設定：GitHub Secrets

在 GitHub 專案的 Settings → Secrets and variables → Actions 新增以下 Secrets（只存在 GitHub，不進 repo）：

| Secret | 內容 | 取得方式 |
|---|---|---|
| `APPLE_CERTIFICATE` | Developer ID Application 憑證（含私鑰）的 `.p12`，base64 編碼 | 鑰匙圈存取 → 「我的憑證」→ 右鍵「Developer ID Application: …」→ 輸出為 .p12；再執行 `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | 匯出 .p12 時設的密碼 | 同上 |
| `APPLE_SIGNING_IDENTITY` | 憑證名稱，例如 `Developer ID Application: CAFECA Inc. (TEAMID1234)` | `security find-identity -v -p codesigning` |
| `APPLE_API_ISSUER` | App Store Connect API 的 Issuer ID | App Store Connect → 使用者與存取 → 整合 → App Store Connect API |
| `APPLE_API_KEY` | API Key ID（10 碼） | 同上，建立一把「開發者」權限的金鑰 |
| `APPLE_API_KEY_P8` | 下載的 `AuthKey_<KeyID>.p8` 全文 | 同上（只能下載一次） |
| `KEYCHAIN_PASSWORD` | 任意長字串（CI 暫時鑰匙圈用） | 自行產生，例如 `openssl rand -base64 24` |

缺少任一個時，macOS job 會失敗並列出缺少的名稱，不會產出未簽章的 mac 版。

## 2. 發佈步驟

1. 確認要發佈的 commit 已在 `main`、CI 全綠。
2. 打 tag 並推送（版本號固定 `0.1.0`，Alpha 編號放在 tag）：

   ```bash
   git tag -a v0.1.0-alpha.1 -m "Hills 0.1.0 alpha 1"
   git push origin v0.1.0-alpha.1
   ```

   也可以在 Actions 頁面手動執行 `Release`，輸入 tag 名稱。
3. 等 `Release` workflow 完成（macOS 公證約 5–20 分鐘）。
4. 到 GitHub Releases 檢查 draft：
   - `Hills_0.1.0_universal.dmg`（macOS，Apple Silicon 與 Intel）
   - `Hills_0.1.0_x64-setup.exe`、`Hills_0.1.0_x64_en-US.msi`（Windows，未簽章）
   - `SHA256SUMS.txt`
5. 下載 dmg 在 Mac 上驗證（見下一節）後，按「Publish release」。

## 3. 驗證簽章與公證

```bash
# 掛載 dmg 後
codesign --verify --deep --strict --verbose=2 /Volumes/Hills/Hills.app
spctl -a -vv -t exec /Volumes/Hills/Hills.app     # 應顯示 source=Notarized Developer ID
xcrun stapler validate /Volumes/Hills/Hills.app   # 應顯示 The validate action worked!
```

Windows 版未簽章：第一次執行時 SmartScreen 會提示「Windows 已保護您的電腦」，按「其他資訊 → 仍要執行」。

## 4. 版本與通道

- `tauri.conf.json` 與 `Cargo.toml` 的版本號維持 `0.1.0`（MSI 不接受 `-alpha` 這類非數字的預發佈標記）。
- CI 以環境變數 `HILLS_CHANNEL=alpha` 建置；「設定 → 關於 → 版本」顯示 `0.1.0 alpha (<commit>)`。
- 自動更新（Tauri updater）與 Windows 簽章在 Beta 前處理（backlog「安裝檔簽章與自動更新」）。
