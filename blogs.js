const LOCAL_BLOG_BASE_URL = './blogs/';
const BLOG_INDEX_URL = `${LOCAL_BLOG_BASE_URL}index.json`;

async function loadBlogIndex() {
  const response = await fetch(BLOG_INDEX_URL);
  if (!response.ok) {
    throw new Error('Unable to load blog index');
  }
  return response.json();
}

function renderMarkdown(markdown) {
  // If `marked` + `DOMPurify` are available, use them for full markdown rendering and sanitization
  function slugify(str) {
    return String(str).toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
  }

  if (typeof window !== 'undefined' && window.marked && window.DOMPurify) {
    const rawHtml = window.marked.parse(markdown, { gfm: true, breaks: true });
    const clean = window.DOMPurify.sanitize(rawHtml);
    // Add ids to headings
    const container = document.createElement('div');
    container.innerHTML = clean;
    container.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
      if (!h.id) h.id = slugify(h.textContent || h.innerText || 'heading');
    });
    // Syntax-highlight fenced code blocks when highlight.js is available
    if (window.hljs) {
      container.querySelectorAll('pre code').forEach((block) => {
        try { window.hljs.highlightElement(block); } catch (e) { /* ignore */ }
      });
    }
    return container.innerHTML;
  }

  // Basic sanitizer: escape HTML tags then convert Markdown-like syntax to HTML
  function escapeHtml(str) {
    return str.replace(/[&<>\"]+/g, (ch) => {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return ch;
      }
    });
  }

  const escaped = escapeHtml(markdown);

  // Pull out fenced code blocks so the newline transforms below don't corrupt them
  const codeBlocks = [];
  const withPlaceholders = escaped.replace(/```[\w+-]*\n?([\s\S]*?)```/g, (match, code) => {
    codeBlocks.push(`<pre><code>${code}</code></pre>`);
    return `\u0000${codeBlocks.length - 1}\u0000`;
  });

  const html = withPlaceholders
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/^-\s+(.*$)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)(\n?)(?!<li>)/gms, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br />')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\u0000(\d+)\u0000/g, (match, i) => codeBlocks[Number(i)] || '');

  return `<div class="markdown-content">${html}</div>`;
}

function generateTOC(markdown) {
  const slugify = (s) => String(s).toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
  const entries = [];
  const re = /^(#{1,6})\s+(.*)$/gm;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const level = m[1].length;
    const text = m[2].trim();
    entries.push({ level, text, id: slugify(text) });
  }
  if (!entries.length) return '';
  return `<nav class="post-toc"><strong>On this page</strong><ul>${entries.map(e => `<li style="margin-left:${(e.level-1)*10}px"><a href="#${e.id}">${e.text}</a></li>`).join('')}</ul></nav>`;
}

function getFileType(name) {
  const lower = (name || '').toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.txt') || lower.endsWith('.text')) return 'text';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.doc') || lower.endsWith('.docx')) return 'document';
  return 'file';
}

async function renderContent(post) {
  const fileName = encodeURIComponent(post.name);
  const localUrl = `${LOCAL_BLOG_BASE_URL}${fileName}`;
  const response = await fetch(localUrl);
  if (!response.ok) {
    return `<p>Unable to load ${post.name}</p>`;
  }

  const fileType = getFileType(post.name);
  const text = await response.text();

  if (fileType === 'markdown') {
    return { html: renderMarkdown(text), raw: text };
  }

  if (fileType === 'text') {
    return { html: `<pre>${text}</pre>`, raw: text };
  }

  if (fileType === 'pdf') {
    return { html: `<p>PDF preview is available via download below.</p><a class="btn secondary" href="${localUrl}" target="_blank" rel="noreferrer">Open PDF</a>`, raw: '' };
  }

  if (fileType === 'document') {
    return { html: `<p>Document file detected.</p><a class="btn secondary" href="${localUrl}" target="_blank" rel="noreferrer">Download document</a>`, raw: '' };
  }

  return { html: `<p>File type not supported yet.</p>`, raw: '' };
}

function postHref(name) {
  const stem = String(name).replace(/\.[^.]+$/, '');
  const slug = stem.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
  return `blogs/${encodeURIComponent(slug)}/`;
}

async function renderBlogs() {
  const blogList = document.getElementById('blog-list');
  if (!blogList) return;
  try {
    const posts = await loadBlogIndex();

    blogList.innerHTML = `<div class="blog-cards">${posts.map((p) => `
      <a class="blog-card" href="${postHref(p.name)}">
        <h3>${p.title}</h3>
        <p class="meta">${p.category || 'General'} • ${p.date || ''}</p>
      </a>`).join('')}</div>`;

  } catch (error) {
    blogList.innerHTML = '<article class="project-card"><h3>Unable to load blogs</h3><p>Check that the Markdown files are available in the blog folder.</p></article>';
  }
}

if (document.getElementById('blog-list')) {
  renderBlogs();
}
