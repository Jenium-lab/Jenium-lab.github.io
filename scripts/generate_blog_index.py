#!/usr/bin/env python3
import json
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLOGS_DIR = ROOT / "blogs"
INDEX_FILE = BLOGS_DIR / "index.json"


def title_from_name(name):
    stem = Path(name).stem
    title = re.sub(r"[-_]+", " ", stem).strip()
    return title[:1].upper() + title[1:] if title else "Untitled post"


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
            posts.append(entry)
            seen.add(name)

    for name in files:
        if name not in seen:
            posts.append(
                {
                    "name": name,
                    "title": title_from_name(name),
                    "category": "General",
                    "date": today,
                }
            )

    INDEX_FILE.write_text(json.dumps(posts, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {len(posts)} posts in {INDEX_FILE}")


if __name__ == "__main__":
    main()
