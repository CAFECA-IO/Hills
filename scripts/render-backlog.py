#!/usr/bin/env python3
"""由 docs/backlog/*.json 重新產生同名 .md 總覽。

用法：python3 scripts/render-backlog.py [backlog.json ...]
未指定時處理 docs/backlog/ 下全部 JSON。JSON 是唯一來源，請勿手動編輯 .md。
"""
import glob, json, os, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
files = sys.argv[1:] or sorted(f for f in glob.glob(os.path.join(root, "docs", "backlog", "*.json"))
                              if not os.path.basename(f).startswith("renames"))
for path in files:
    data = json.load(open(path, encoding="utf-8"))
    name = os.path.basename(path)
    titles = [m["title"] for m in data["milestones"]]
    head = titles[0].split()[0] + ("–" + titles[-1].split()[0] if len(titles) > 1 else "")
    out = [f"# {head} Backlog", "",
           f"> 由 `docs/backlog/{name}` 產生（`python3 scripts/render-backlog.py`），共 {len(data['issues'])} 個 Issue。"
           "請編輯 JSON 後重新產生，勿手動修改本檔。以 `scripts/create-github-backlog.sh` 建立到 GitHub。", ""]
    for m in data["milestones"]:
        sub = [i for i in data["issues"] if i["milestone"] == m["title"]]
        out += [f"## {m['title']}（{len(sub)} 項，目標日 {m['due']}）", "", m["desc"], "",
                "| # | Issue | 標籤 |", "|---|---|---|"]
        out += [f"| {n} | {i['title']} | {', '.join(i['labels'])} |" for n, i in enumerate(sub, 1)]
        out += [""]
    with open(path[:-5] + ".md", "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print(f"{name} → {os.path.basename(path[:-5])}.md（{len(data['issues'])} issues）")
