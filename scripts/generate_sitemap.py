#!/usr/bin/env python3
"""Generate sitemap.xml from blogs/index.json with lastmod dates."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blog_util import BASE_URL, post_slug  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BLOGS_DIR = ROOT / "blogs"
INDEX_FILE = BLOGS_DIR / "index.json"
SITEMAP_FILE = ROOT / "sitemap.xml"


def entry(loc, changefreq, priority, lastmod=None):
    last = f"\n    <lastmod>{lastmod}</lastmod>" if lastmod else ""
    return f"  <url>\n    <loc>{loc}</loc>{last}\n    <changefreq>{changefreq}</changefreq>\n    <priority>{priority}</priority>\n  </url>"


def main():
    posts = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    urls = [
        entry(f"{BASE_URL}/", "weekly", "1.0"),
        entry(f"{BASE_URL}/blogs.html", "weekly", "0.8"),
    ]
    for post in sorted(posts, key=lambda p: p.get("date", ""), reverse=True):
        slug = post_slug(post["name"])
        urls.append(entry(f"{BASE_URL}/blogs/{slug}/", "monthly", "0.6", post.get("date")))

    sitemap = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(urls)
        + "\n</urlset>\n"
    )
    SITEMAP_FILE.write_text(sitemap, encoding="utf-8")
    print(f"Generated {SITEMAP_FILE} with {len(urls)} URLs")


if __name__ == "__main__":
    main()
