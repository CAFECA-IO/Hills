#!/usr/bin/env bash
# 依 docs/backlog/m0-m1.json 在 GitHub 建立 Labels、Milestones 與 Issues。
# 可重複執行：已存在的 Label / Milestone / 同標題 Issue 會略過。
# 需求：gh（已 gh auth login）、jq
# 用法：scripts/create-github-backlog.sh [owner/repo] [--dry-run]
set -euo pipefail
REPO="${1:-CAFECA-IO/hills.cafeca.io}"
DRY="${2:-}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$DIR/docs/backlog/m0-m1.json"
command -v gh >/dev/null || { echo "需要 gh：https://cli.github.com"; exit 1; }
command -v jq >/dev/null || { echo "需要 jq"; exit 1; }
run() { if [[ "$DRY" == "--dry-run" ]]; then echo "[dry-run] $1 $2 $3" >&2; else "$@"; fi; }

echo "== Labels"
existing_labels="$(gh label list -R "$REPO" --limit 500 --json name -q '.[].name')"
jq -c '.labels[]' "$DATA" | while read -r l; do
  name="$(jq -r .name <<<"$l")"; color="$(jq -r .color <<<"$l")"
  if grep -Fxq "$name" <<<"$existing_labels"; then echo "  略過 $name"; else
    run gh label create "$name" -R "$REPO" --color "$color" >/dev/null && echo "  建立 $name"; fi
done

echo "== Milestones"
existing_ms="$(gh api "repos/$REPO/milestones?state=all&per_page=100" -q '.[].title')"
jq -c '.milestones[]' "$DATA" | while read -r m; do
  title="$(jq -r .title <<<"$m")"
  if grep -Fxq "$title" <<<"$existing_ms"; then echo "  略過 $title"; else
    run gh api "repos/$REPO/milestones" -f title="$title" \
      -f description="$(jq -r .desc <<<"$m")" -f due_on="$(jq -r .due <<<"$m")T23:59:59Z" >/dev/null \
      && echo "  建立 $title"; fi
done

echo "== Issues"
existing_issues="$(gh issue list -R "$REPO" --state all --limit 1000 --json title -q '.[].title')"
jq -c '.issues[]' "$DATA" | while read -r i; do
  title="$(jq -r .title <<<"$i")"
  if grep -Fxq "$title" <<<"$existing_issues"; then echo "  略過 $title"; continue; fi
  labels="$(jq -r '.labels | join(",")' <<<"$i")"
  run gh issue create -R "$REPO" --title "$title" --body "$(jq -r .body <<<"$i")" \
    --milestone "$(jq -r .milestone <<<"$i")" --label "$labels" >/dev/null && echo "  建立 $title"
done
echo "完成。"
