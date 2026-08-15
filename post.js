async function addCopyButtons(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    if (code) {
      const m = (code.className || '').match(/language-([\w-]+)/);
      if (m) pre.setAttribute('data-lang', m[1]);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    btn.textContent = 'copy';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      const text = code ? code.innerText : pre.innerText;
      const done = () => {
        btn.textContent = 'copied';
        setTimeout(() => { btn.textContent = 'copy'; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      } else {
        fallbackCopy(text, done);
      }
    });
    pre.classList.add('has-copy');
    pre.appendChild(btn);
  });
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
  done();
}

async function renderSinglePost() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('post');
  const app = document.getElementById('post-content');

  if (!name) {
    if (app) app.innerHTML = '<h3>No post selected</h3><p>Open a post from the <a href="./blogs.html">blog list</a>.</p>';
    return;
  }

  try {
    const posts = await loadBlogIndex();
    const post = posts.find((p) => p.name === name);
    if (!post) {
      if (app) app.innerHTML = '<h3>Post not found</h3><p>Return to the <a href="./blogs.html">blog list</a>.</p>';
      return;
    }

    const titleEl = document.getElementById('post-title');
    const metaEl = document.getElementById('post-meta');
    if (titleEl) titleEl.textContent = post.title;
    if (metaEl) metaEl.textContent = `${post.category || 'General'} • ${post.date || ''}`;
    const pageTitle = `${post.title} | Srijan Tangnami Magar`;
    document.title = pageTitle;
    const fullUrl = `${window.location.origin}${window.location.pathname}?post=${encodeURIComponent(name)}`;
    const setMeta = (sel, attr, val) => {
      const el = document.querySelector(sel);
      if (el) el.setAttribute(attr, val);
    };
    setMeta('meta[name="description"]', 'content', `Srijan Tangnami Magar: ${post.title}. Infrastructure engineering notes on cloud, networking, and automation.`);
    setMeta('meta[property="og:title"]', 'content', pageTitle);
    setMeta('meta[property="og:url"]', 'content', fullUrl);
    setMeta('meta[name="twitter:title"]', 'content', pageTitle);
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.href = fullUrl;

    const result = await renderContent(post);
    const contentHtml = (result && result.html) ? result.html : result;
    const raw = (result && result.raw) ? result.raw : '';
    if (app) app.innerHTML = contentHtml;

    if (app) addCopyButtons(app);

    const slugify = (s) => String(s).toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    if (app) {
      app.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
        if (!h.id) h.id = slugify(h.textContent || h.innerText || 'heading');
      });
    }

    const tocEl = document.getElementById('post-toc');
    if (tocEl) {
      let tocHtml = '';
      if (raw) tocHtml = generateTOC(raw);
      else if (app) {
        const hs = Array.from(app.querySelectorAll('h1,h2,h3'));
        if (hs.length) {
          tocHtml = `<nav class="post-toc"><strong>On this page</strong><ul>${hs.map((h) => `<li><a href="#${h.id}">${h.textContent}</a></li>`).join('')}</ul></nav>`;
        }
      }
      tocEl.innerHTML = tocHtml;
    }
  } catch (error) {
    if (app) app.innerHTML = '<h3>Unable to load post</h3><p>Check that the Markdown file exists in the blog folder.</p>';
  }
}

renderSinglePost();
