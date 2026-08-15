#!/usr/bin/env python3
"""Shared helpers for blog build scripts."""
import re

BASE_URL = "https://srijantangnamimagar.com.np"
SITE_TITLE = "Srijan Tangnami Magar"


def slugify(text):
    """Match the slugify() used in blogs.js / post.js."""
    slug = re.sub(r"[^0-9A-Za-z_\s-]", "", text.lower().strip())
    return re.sub(r"\s+", "-", slug)


def post_slug(name):
    """URL slug for a blog file name (extension stripped, slugified)."""
    stem = re.sub(r"\.[^.]+$", "", name)
    return slugify(stem)


def excerpt_from_markdown(text, limit=160):
    """First paragraph after the H1, markdown stripped, truncated."""
    lines = text.splitlines()
    started = False
    buf = []
    for line in lines:
        if line.startswith("#"):
            started = True
            continue
        if started and line.strip():
            buf.append(line.strip())
        elif started and buf:
            break
    para = " ".join(buf)
    para = re.sub(r"[`*_#>\[\]()]|!\[|\]\([^)]*\)", "", para)
    para = re.sub(r"\s+", " ", para).strip()
    if len(para) > limit:
        para = para[: limit - 1].rstrip() + "\u2026"
    return para or None
