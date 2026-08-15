/* Legacy entry point: old post.html?post=<file> URLs now redirect to the
   pre-rendered static page at /blogs/<slug>/. */
(function () {
  'use strict';

  function slugify(s) {
    return String(s).toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
  }

  const params = new URLSearchParams(window.location.search);
  const name = params.get('post');
  const app = document.getElementById('post-content');

  if (!name) {
    if (app) {
      app.innerHTML = '<h3>No post selected</h3><p>Open a post from the <a href="/blogs.html">blog list</a>.</p>';
    }
    return;
  }

  const slug = slugify(String(name).replace(/\.[^.]+$/, ''));
  window.location.replace('/blogs/' + encodeURIComponent(slug) + '/');
})();
