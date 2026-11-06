# CLAUDE.md

本專案的 Agent 守則統一寫在 AGENTS.md，以下匯入全文；請完整遵守。

@AGENTS.md

## Claude Code 補充

- 開工前依 AGENTS.md §3 讀取必讀文件；文件路徑可用 `@docs/...` 引用。
- 遇到 AGENTS.md §4 的「與文件衝突」或「需要新決策」時，使用 AskUserQuestion 向使用者確認，列出選項與對文件的影響，不要自行決定。
- 會修改規劃文件或跨多個模組的任務，先進入 plan mode 提出計畫，經使用者同意再執行。
- 需要修改文件時，先改文件並單獨 commit（`docs: ...`），再改程式碼。
- 不要把只對本機有效的設定寫進本檔；個人偏好放在 `CLAUDE.local.md`（已列入 .gitignore）。
