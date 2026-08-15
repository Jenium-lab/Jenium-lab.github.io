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
    const fileEl = document.getElementById('post-file');
    if (titleEl) titleEl.textContent = post.title;
    if (metaEl) metaEl.textContent = `${post.category || 'General'} • ${post.date || ''}`;
    if (fileEl) fileEl.textContent = `./blogs/${post.name}`;
    document.title = `${post.title} | Srijan Tangnami Magar`;

    const result = await renderContent(post);
    const contentHtml = (result && result.html) ? result.html : result;
    const raw = (result && result.raw) ? result.raw : '';
    if (app) app.innerHTML = contentHtml;

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
