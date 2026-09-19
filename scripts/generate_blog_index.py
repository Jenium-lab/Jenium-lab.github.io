#!/usr/bin/env python3
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blog_util import excerpt_from_markdown  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BLOGS_DIR = ROOT / "blogs"
INDEX_FILE = BLOGS_DIR / "index.json"


def title_from_name(name):
    stem = Path(name).stem
    title = re.sub(r"[-_]+", " ", stem).strip()
    return title[:1].upper() + title[1:] if title else "Untitled post"


def git_file_date(name):
    """First commit date for a blog file, used as its publish date (YYYY-MM-DD)."""
    rel_path = str(Path(BLOGS_DIR / name).resolve().relative_to(ROOT.resolve()))
    result = subprocess.run(
        ["git", "-C", str(ROOT), "log", "--reverse", "--format=%cI", "--", rel_path],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    oldest = result.stdout.strip().splitlines()
    if not oldest:
        return None
    return oldest[0][:10]


def main():
    existing = []
    if INDEX_FILE.exists():
        existing = json.loads(INDEX_FILE.read_text(encoding="utf-8"))

    files = sorted(
        f.name for f in BLOGS_DIR.iterdir() if f.is_file() and f.name != "index.json"
    )

    today = date.today().isoformat()
    posts = []
    seen = set()

    for entry in existing:
        name = entry.get("name")
        if name in files:
            if not entry.get("date"):
                entry["date"] = git_file_date(name) or today
            posts.append(entry)
            seen.add(name)

    for name in files:
        if name not in seen:
            post_date = git_file_date(name) or today
            posts.append(
                {
                    "name": name,
                    "title": title_from_name(name),
                    "category": "General",
                    "date": post_date,
                }
            )
            print(f"New post {name!r} dated {post_date}")

    for post in posts:
        md_path = BLOGS_DIR / post["name"]
        if md_path.exists():
            excerpt = excerpt_from_markdown(md_path.read_text(encoding="utf-8"))
            if excerpt:
                post["excerpt"] = excerpt

    INDEX_FILE.write_text(json.dumps(posts, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {len(posts)} posts in {INDEX_FILE}")


if __name__ == "__main__":
    main()
