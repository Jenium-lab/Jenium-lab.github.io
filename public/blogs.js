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
  function slugify(str) {
    return String(str).toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
  }

  if (typeof window !== 'undefined' && window.marked && window.DOMPurify) {
    const rawHtml = window.marked.parse(markdown);
    const clean = window.DOMPurify.sanitize(rawHtml);
    const container = document.createElement('div');
    container.innerHTML = clean;
    container.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
      if (!h.id) h.id = slugify(h.textContent || h.innerText || 'heading');
    });
    return container.innerHTML;
  }

  // Basic fallback renderer
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
  const html = escaped
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/^-\s+(.*$)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)(\n?)(?!<li>)/gms, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br />')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');

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

async function renderBlogs() {
  const blogList = document.getElementById('blog-list');
  if (!blogList) return;
  try {
    const posts = await loadBlogIndex();

    // Build a simple list of clickable titles
    blogList.innerHTML = `
      <aside class="blog-list">
        <ul>${posts.map((p) => `<li><a href="?post=${encodeURIComponent(p.name)}" data-name="${p.name}" class="post-link">${p.title}</a></li>`).join('')}</ul>
      </aside>
      <section id="blog-reader" class="blog-reader"></section>
    `;

    const reader = document.getElementById('blog-reader');

    async function showPostByName(name, push = true) {
      const post = posts.find((p) => p.name === name);
      if (!post) {
        reader.innerHTML = '<article class="project-card"><h3>Post not found</h3></article>';
        return;
      }
      reader.innerHTML = `<article class="project-card"><h2>${post.title}</h2><p class="meta">${post.category || 'General'} • ${post.date || ''}</p><div class="content">Loading…</div></article>`;
      const result = await renderContent(post);
      const contentHtml = (result && result.html) ? result.html : result;
      const raw = (result && result.raw) ? result.raw : '';
      const contentNode = reader.querySelector('.content');
      if (contentNode) contentNode.innerHTML = contentHtml;

      const slugify = (s) => String(s).toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
      if (contentNode) {
        contentNode.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
          if (!h.id) h.id = slugify(h.textContent || h.innerText || 'heading');
        });
      }

      let tocHtml = '';
      if (raw) tocHtml = generateTOC(raw);
      else if (contentNode) {
        const hs = Array.from(contentNode.querySelectorAll('h1,h2,h3'));
        if (hs.length) {
          tocHtml = `<nav class="post-toc"><strong>On this page</strong><ul>${hs.map(h => `<li><a href="#${h.id}">${h.textContent}</a></li>`).join('')}</ul></nav>`;
        }
      }
      const existingToc = reader.querySelector('.post-toc');
      if (existingToc) existingToc.remove();
      if (tocHtml) reader.querySelector('.project-card').insertAdjacentHTML('afterbegin', tocHtml);
      if (push) history.pushState({ post: name }, '', `?post=${encodeURIComponent(name)}`);
    }

    // Attach click handlers
    blogList.querySelectorAll('.post-link').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        const name = el.getAttribute('data-name');
        showPostByName(name);
      });
    });

    // If URL contains ?post=..., open it
    const params = new URLSearchParams(window.location.search);
    const initial = params.get('post');
    if (initial) {
      showPostByName(initial, false);
    }

    window.addEventListener('popstate', (ev) => {
      const postName = ev.state && ev.state.post;
      if (postName) showPostByName(postName, false);
      else {
        const readerEl = document.getElementById('blog-reader');
        if (readerEl) readerEl.innerHTML = '';
      }
    });

  } catch (error) {
    blogList.innerHTML = '<article class="project-card"><h3>Unable to load blogs</h3><p>Check that the Markdown files are available in the blog folder.</p></article>';
  }
}

if (document.getElementById('blog-list')) {
  renderBlogs();
}
