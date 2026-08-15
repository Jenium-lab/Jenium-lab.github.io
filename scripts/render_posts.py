#!/usr/bin/env python3
"""Render each markdown blog post to a static HTML page at blogs/<slug>/index.html."""
import json
import re
import sys
from datetime import date
from pathlib import Path

import markdown

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blog_util import BASE_URL, SITE_TITLE, excerpt_from_markdown, post_slug, slugify  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BLOGS_DIR = ROOT / "blogs"
INDEX_FILE = BLOGS_DIR / "index.json"

NAV = """<nav class="nav" role="navigation">
        <a class="brand" href="/index.html">
          <span class="brand-mark">ST</span>
          <span class="brand-name">Srijan&nbsp;<em>T.&nbsp;Magar</em></span>
        </a>
        <div class="nav-links">
          <a href="/index.html#experience">Experience</a>
          <a href="/index.html#skills">Skills</a>
          <a href="/index.html#blogs">Blogs</a>
          <a href="/index.html#contact">Contact</a>
          <a class="nav-cta" href="/blogs.html">Blog archive&nbsp;&#x2197;</a>
        </div>
      </nav>"""

FOOTER = f"""<footer class="footer">
        <span>&#169; {date.today().year} {SITE_TITLE}</span>
        <span>
          <a href="/index.html">Home</a> &middot; <a href="/blogs.html">Blogs</a> &middot;
          <a href="/index.html#contact">Contact</a> &middot; <a href="#top">Back to top &#8593;</a>
        </span>
      </footer>"""

FONTS = """<link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400;1,9..144,500&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap" rel="stylesheet" />"""

MD = markdown.Markdown(
    extensions=["extra", "sane_lists", "nl2br", "toc"],
    output_format="html5",
    extension_configs={"toc": {"toc_depth": "2-6"}},
)
MD.toc_slugify = lambda value, separator: slugify(value)


def render_markdown(raw):
    MD.reset()
    body = MD.convert(raw)
    tokens = list(MD.toc_tokens or [])
    return body, tokens


def headings_toc(tokens):
    """Build the on-page TOC from the toc-extension tokens (h2 and below)."""
    entries = [t for t in tokens if t["level"] >= 2]
    if not entries:
        return ""
    items = "".join(
        f'<li style="margin-left:{10 * (t["level"] - 2)}px"><a href="#{t["id"]}">{t["name"]}</a></li>'
        for t in entries
    )
    return f'<nav class="post-toc"><strong>On this page</strong><ul>{items}</ul></nav>'


def build_page(post):
    name = post["name"]
    slug = post_slug(name)
    title = post.get("title") or post_slug(name).replace("-", " ").title()
    category = post.get("category") or "General"
    post_date = post.get("date") or date.today().isoformat()
    excerpt = post.get("excerpt") or excerpt_from_markdown(
        (BLOGS_DIR / name).read_text(encoding="utf-8") if (BLOGS_DIR / name).exists() else ""
    ) or f"Infrastructure engineering notes on {category.lower()}, written by {SITE_TITLE}."

    raw = (BLOGS_DIR / name).read_text(encoding="utf-8")
    body_html, toc_tokens = render_markdown(raw)
    body_html = re.sub(r"^<h1[^>]*>.*?</h1>", "", body_html, count=1, flags=re.S).lstrip()

    page_title = f"{title} | {SITE_TITLE}"
    url = f"{BASE_URL}/blogs/{slug}/"
    toc = headings_toc(toc_tokens)

    article_json = {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": title,
        "description": excerpt,
        "image": f"{BASE_URL}/gemini-svg.svg",
        "mainEntityOfPage": {"@type": "WebPage", "@id": url},
        "datePublished": post_date,
        "dateModified": post_date,
        "author": {"@type": "Person", "name": SITE_TITLE, "url": BASE_URL},
        "publisher": {"@type": "Person", "name": SITE_TITLE, "url": BASE_URL},
    }

    return f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{page_title}</title>
    <meta name="description" content="{excerpt}" />
    <link rel="canonical" href="{url}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="{SITE_TITLE}" />
    <meta property="og:title" content="{page_title}" />
    <meta property="og:description" content="{excerpt}" />
    <meta property="og:url" content="{url}" />
    <meta property="og:image" content="{BASE_URL}/gemini-svg.svg" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="{page_title}" />
    <meta name="twitter:description" content="{excerpt}" />
    <script type="application/ld+json">
    {json.dumps(article_json, indent=2)}
    </script>
    {FONTS}
    <link rel="icon" type="image/svg+xml" href="/gemini-svg.svg" />
    <link rel="stylesheet" href="/styles.css?v=9" />
    <script>document.documentElement.classList.add('js');</script>
  </head>
  <body>
    <div id="top" class="page-shell">

      {NAV}

      <header class="hero short-hero">
        <div class="hero-copy">
          <p class="eyebrow">Blog Post</p>
          <h1>{title}</h1>
          <p class="meta">{category} &bull; {post_date}</p>
          <div class="actions">
            <a class="btn primary" href="/blogs.html">&#8592; Back to blog list</a>
            <a class="btn secondary" href="/index.html">Home</a>
          </div>
        </div>
      </header>

      <main>
        <section class="section projects">
          <article class="reader">
            {toc}
            <div class="content markdown-content">{body_html}</div>
          </article>
        </section>
      </main>

      {FOOTER}
    </div>

    <script src="/libs/highlight.min.js"></script>
    <script src="/libs/copy-buttons.js"></script>
    <script>
      document.querySelectorAll('.markdown-content pre code').forEach(function (block) {{
        if (window.hljs) {{ try {{ window.hljs.highlightElement(block); }} catch (e) {{}} }}
      }});
    </script>
  </body>
</html>
"""


def main():
    posts = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    for post in posts:
        slug = post_slug(post["name"])
        out_dir = BLOGS_DIR / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(build_page(post), encoding="utf-8")
        print(f"Rendered {post['name']} -> blogs/{slug}/index.html")


if __name__ == "__main__":
    main()
