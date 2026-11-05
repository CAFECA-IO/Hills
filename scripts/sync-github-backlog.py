#!/usr/bin/env python3
"""讓 GitHub 的 Labels / Milestones / Issues 與 docs/backlog/*.json 一致。

與 create-github-backlog.sh（只新增）不同，本腳本會：
  1. 依 docs/backlog/renames.json 處理改名的 milestone：
     - 只有舊名 → 直接改名
     - 新舊都有 → 把舊 milestone 的 Issue 全部移到新的，再刪除舊 milestone
  2. 依 renames.json 處理改名的 Issue：
     - 只有舊標題 → 改標題
     - 新舊都有 → 關閉舊的並留言「重複」
  3. 依 JSON 更新既有 Issue 的 milestone、labels、內容；建立缺少的 Issue
  4. 關閉 renames.json「removed」中已移除的 Issue（留言說明原因）
  5. 更新 milestone 的說明與目標日
已手動修改過內容的 Issue 會被 JSON 覆寫，請先把需要保留的內容寫回 JSON。
已關閉的 Issue 不會被重新打開。

預設只顯示將要做的變更（dry-run），加上 --apply 才會實際執行。

需求：gh（已 gh auth login）
用法：
  python3 scripts/sync-github-backlog.py [--repo owner/repo] [--apply]
"""
import argparse
import glob
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def gh_api(method, path, body=None):
    cmd = ["gh", "api", "-X", method, path, "-H", "Accept: application/vnd.github+json"]
    if body is not None:
        cmd += ["--input", "-"]
    res = subprocess.run(cmd, input=json.dumps(body) if body is not None else None,
                         capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"gh api {method} {path} 失敗：{res.stderr.strip()}")
    return json.loads(res.stdout) if res.stdout.strip() else None


def get_all(path):
    items, page = [], 1
    sep = "&" if "?" in path else "?"
    while True:
        batch = gh_api("GET", f"{path}{sep}per_page=100&page={page}")
        if not batch:
            return items
        items += batch
        page += 1


class Sync:
    def __init__(self, repo, apply):
        self.repo, self.apply, self.changes = repo, apply, 0

    def act(self, desc, method, path, body=None):
        self.changes += 1
        print(("  ✓ " if self.apply else "  [dry-run] ") + desc)
        return gh_api(method, f"repos/{self.repo}/{path}", body) if self.apply else None

    def run(self):
        files = sorted(glob.glob(os.path.join(ROOT, "docs", "backlog", "*.json")))
        backlog = [json.load(open(f, encoding="utf-8")) for f in files
                   if not f.endswith("renames.json")]
        ren = json.load(open(os.path.join(ROOT, "docs", "backlog", "renames.json"), encoding="utf-8"))
        want_labels = {l["name"]: l["color"] for b in backlog for l in b["labels"]}
        want_ms = {m["title"]: m for b in backlog for m in b["milestones"]}
        want_issues = {i["title"]: i for b in backlog for i in b["issues"]}

        print("== Labels")
        have_labels = {l["name"] for l in get_all(f"repos/{self.repo}/labels")}
        for name, color in want_labels.items():
            if name not in have_labels:
                self.act(f"建立 label {name}", "POST", "labels", {"name": name, "color": color})

        print("== Milestones")
        ms = {m["title"]: m for m in get_all(f"repos/{self.repo}/milestones?state=all")}
        issues = [i for i in get_all(f"repos/{self.repo}/issues?state=all") if "pull_request" not in i]
        for old, new in ren["milestones"].items():
            if old not in ms:
                continue
            if new not in ms:
                self.act(f"milestone 改名：{old} → {new}", "PATCH", f"milestones/{ms[old]['number']}", {"title": new})
                ms[new] = dict(ms.pop(old), title=new)
            else:
                moved = [i for i in issues if (i.get("milestone") or {}).get("title") == old]
                for i in moved:
                    self.act(f"#{i['number']} 移到 {new}", "PATCH", f"issues/{i['number']}",
                             {"milestone": ms[new]["number"]})
                    i["milestone"] = ms[new]
                self.act(f"刪除 milestone {old}（已移出 {len(moved)} 個 Issue）", "DELETE",
                         f"milestones/{ms[old]['number']}")
                ms.pop(old)
        for title, m in want_ms.items():
            body = {"title": title, "description": m["desc"], "due_on": f"{m['due']}T23:59:59Z"}
            if title not in ms:
                created = self.act(f"建立 milestone {title}", "POST", "milestones", body)
                ms[title] = created or {"number": f"<new:{title}>", "title": title}
            else:
                cur = ms[title]
                if cur.get("description") != m["desc"] or (cur.get("due_on") or "")[:10] != m["due"]:
                    self.act(f"更新 milestone {title} 說明 / 目標日", "PATCH", f"milestones/{cur['number']}", body)

        print("== 改名的 Issue")
        by_title = {}
        for i in issues:
            by_title.setdefault(i["title"], []).append(i)
        for old, new in ren["issues"].items():
            for i in [x for x in by_title.get(old, []) if x["state"] == "open"]:
                if by_title.get(new):
                    self.act(f"#{i['number']} 與「{new}」重複，關閉", "POST", f"issues/{i['number']}/comments",
                             {"body": f"規劃變更後由「{new}」取代，關閉此重複 Issue。"})
                    self.act(f"關閉 #{i['number']}", "PATCH", f"issues/{i['number']}",
                             {"state": "closed", "state_reason": "not_planned"})
                else:
                    self.act(f"#{i['number']} 改標題：{old} → {new}", "PATCH", f"issues/{i['number']}", {"title": new})
                    i["title"] = new
                    by_title[new] = [i]

        print("== 已移除的 Issue")
        for title, reason in ren["removed"].items():
            for i in [x for x in by_title.get(title, []) if x["state"] == "open"]:
                self.act(f"關閉 #{i['number']} {title}", "POST", f"issues/{i['number']}/comments",
                         {"body": f"依規劃變更移除：{reason}"})
                self.act(f"關閉 #{i['number']}", "PATCH", f"issues/{i['number']}",
                         {"state": "closed", "state_reason": "not_planned"})

        print("== Issue 內容")
        for title, w in want_issues.items():
            target = {"milestone": ms[w["milestone"]]["number"], "labels": w["labels"], "body": w["body"]}
            existing = [x for x in by_title.get(title, [])]
            if not existing:
                self.act(f"建立 {title}", "POST", "issues", {"title": title, **target})
                continue
            i = existing[0]
            if i["state"] != "open":
                continue
            diff = []
            if (i.get("milestone") or {}).get("title") != w["milestone"]:
                diff.append("milestone")
            if sorted(l["name"] for l in i.get("labels", [])) != sorted(w["labels"]):
                diff.append("labels")
            if (i.get("body") or "").strip() != w["body"].strip():
                diff.append("內容")
            if diff:
                self.act(f"#{i['number']} 更新{'、'.join(diff)}：{title}", "PATCH", f"issues/{i['number']}", target)

        print(f"\n共 {self.changes} 項變更" + ("，已套用。" if self.apply else "。確認無誤後加上 --apply 執行。"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default="CAFECA-IO/hills.cafeca.io")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    Sync(a.repo, a.apply).run()
