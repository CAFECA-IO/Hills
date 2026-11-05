#!/usr/bin/env bash
# 依 docs/backlog/*.json 在 GitHub 建立 Labels、Milestones 與 Issues。
# 可重複執行：已存在的 Label / Milestone / 同標題 Issue 會略過。
# 需求：gh（已 gh auth login）、jq
# 用法：scripts/create-github-backlog.sh [owner/repo] [--dry-run] [backlog.json ...]
#   未指定 JSON 時處理 docs/backlog/ 下全部檔案（依檔名排序）。
set -euo pipefail
REPO="${1:-CAFECA-IO/hills.cafeca.io}"; shift || true
DRY=""; if [[ "${1:-}" == "--dry-run" ]]; then DRY="--dry-run"; shift; fi
DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [[ $# -gt 0 ]]; then FILES=("$@"); else FILES=("$DIR"/docs/backlog/*.json); fi
command -v gh >/dev/null || { echo "需要 gh：https://cli.github.com"; exit 1; }
command -v jq >/dev/null || { echo "需要 jq"; exit 1; }
run() { if [[ "$DRY" == "--dry-run" ]]; then echo "[dry-run] $1 $2 $3" >&2; else "$@"; fi; }

existing_labels="$(gh label list -R "$REPO" --limit 500 --json name -q '.[].name')"
existing_ms="$(gh api "repos/$REPO/milestones?state=all&per_page=100" -q '.[].title')"
existing_issues="$(gh issue list -R "$REPO" --state all --limit 1000 --json title -q '.[].title')"

for DATA in "${FILES[@]}"; do
  echo "##### $(basename "$DATA")"
  echo "== Labels"
  while read -r l; do
    name="$(jq -r .name <<<"$l")"; color="$(jq -r .color <<<"$l")"
    if grep -Fxq "$name" <<<"$existing_labels"; then echo "  略過 $name"; else
      run gh label create "$name" -R "$REPO" --color "$color" >/dev/null && echo "  建立 $name"
      existing_labels+=$'\n'"$name"; fi
  done < <(jq -c '.labels[]' "$DATA")

  echo "== Milestones"
  while read -r m; do
    title="$(jq -r .title <<<"$m")"
    if grep -Fxq "$title" <<<"$existing_ms"; then echo "  略過 $title"; else
      run gh api "repos/$REPO/milestones" -f title="$title" \
        -f description="$(jq -r .desc <<<"$m")" -f due_on="$(jq -r .due <<<"$m")T23:59:59Z" >/dev/null \
        && echo "  建立 $title"
      existing_ms+=$'\n'"$title"; fi
  done < <(jq -c '.milestones[]' "$DATA")

  echo "== Issues"
  while read -r i; do
    title="$(jq -r .title <<<"$i")"
    if grep -Fxq "$title" <<<"$existing_issues"; then echo "  略過 $title"; continue; fi
    run gh issue create -R "$REPO" --title "$title" --body "$(jq -r .body <<<"$i")" \
      --milestone "$(jq -r .milestone <<<"$i")" --label "$(jq -r '.labels | join(",")' <<<"$i")" >/dev/null \
      && echo "  建立 $title"
    existing_issues+=$'\n'"$title"
  done < <(jq -c '.issues[]' "$DATA")
done
echo "完成。"
