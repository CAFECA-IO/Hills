# Hills 文件索引

規劃文件是本專案的唯一事實來源。所有人（包含 AI Agent）修改專案時，**先改文件，再改程式碼**，詳細流程見 [AGENTS.md](../AGENTS.md) §4。

## 文件與優先順序

| 順位 | 文件 | 內容 | 何時更新 |
|:---:|------|------|---------|
| 1 | [feature-plan.md](./feature-plan.md) §2 | 決策表（D1…） | 任何方針確認或變更 |
| 2 | [feature-plan.md](./feature-plan.md) | 產品定位、功能模組、里程碑、驗收指標、風險、版本紀錄 | 範圍、優先順序、時程變更 |
| 3 | [technical-design.md](./technical-design.md) | M0 / M1：身分、金鑰、同步、協定、假勤規則、資料模型、部署 | 協定、資料模型、金鑰流程變更 |
| 3 | [technical-design-m2-m5.md](./technical-design-m2-m5.md) | M2–M5：聊天、檔案、行動端、AI、整合、通話、開源；提案 P1… | 同上 |
| 4 | [ui-spec.md](./ui-spec.md) | 畫面結構、流程、狀態 | UI 流程變更 |
| 5 | [development-guidelines.md](./development-guidelines.md) | 分支、commit、程式碼、測試、資安、發佈 | 開發流程變更 |
| 6 | [backlog/](./backlog/) | M0–M5 Issue 清單（JSON 為來源，.md 為產生的總覽） | 工作項目增減 |

上層文件與下層衝突時以上層為準，並修正下層文件。

## 變更流程

1. 提出變更（Issue 或對話），說明原因與影響的文件。
2. 若涉及方針，於決策表新增 D 編號（只新增、不覆寫；被取代者加註）。
3. 更新受影響的文件章節與各文件開頭的版本號、日期。
4. 在 feature-plan「文件版本紀錄」加一行。
5. 若工作項目有變，更新 `backlog/*.json` 並以 `python3 scripts/render-backlog.py` 重新產生 `.md`。milestone 或 Issue **改名或移除**時，必須在 `backlog/renames.json` 記錄舊名 → 新名（或移除原因），再以 `python3 scripts/sync-github-backlog.py --apply` 同步到 GitHub（`create-github-backlog.sh` 只會新增，不會處理改名）。
6. 文件 commit 在前，程式碼 commit 在後。

## 標記慣例

- **D編號**：已確認的決策，可實作。
- **〔提案〕/ P 編號**：尚未確認，不得實作。
- **待確認 / 待決**：需要討論的問題。
- **「實作前需核對」**：涉及法規或外部事實，實作前需查證並在測試中註明出處與日期。
