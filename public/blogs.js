const BLOG_BASE_URL = 'https://raw.githubusercontent.com/Jenium-lab/Portfolio1/main/public/blogs/';
const BLOG_INDEX_URL = `${BLOG_BASE_URL}index.json`;
const LOCAL_BLOG_BASE_URL = './blogs/';

async function loadBlogIndex() {
  try {
    const response = await fetch(BLOG_INDEX_URL);
    if (!response.ok) {
      throw new Error('Remote blog index unavailable');
    }
    return response.json();
  } catch (error) {
    const fallbackResponse = await fetch(`${LOCAL_BLOG_BASE_URL}index.json`);
    if (!fallbackResponse.ok) {
      throw new Error('Unable to load blog index');
    }
    return fallbackResponse.json();
  }
}

function renderMarkdown(markdown) {
  const html = markdown
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br />')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');

  return `<p>${html}</p>`;
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
  const remoteUrl = `${BLOG_BASE_URL}${fileName}`;
  const localUrl = `${LOCAL_BLOG_BASE_URL}${fileName}`;

  try {
    const response = await fetch(remoteUrl);
    if (!response.ok) {
      throw new Error('Remote file unavailable');
    }

    const fileType = getFileType(post.name);
    const text = await response.text();

    if (fileType === 'markdown') {
      return renderMarkdown(text);
    }

    if (fileType === 'text') {
      return `<pre>${text}</pre>`;
    }

    if (fileType === 'pdf') {
      return `<p>PDF preview is available via download below.</p><a class="btn secondary" href="${remoteUrl}" target="_blank" rel="noreferrer">Open PDF</a>`;
    }

    if (fileType === 'document') {
      return `<p>Document file detected.</p><a class="btn secondary" href="${remoteUrl}" target="_blank" rel="noreferrer">Download document</a>`;
    }

    return `<p>File type not supported yet.</p>`;
  } catch (error) {
    const fallbackResponse = await fetch(localUrl);
    if (!fallbackResponse.ok) {
      return `<p>Unable to load ${post.name}</p>`;
    }

    const fallbackText = await fallbackResponse.text();
    return `<pre>${fallbackText}</pre>`;
  }
}

async function renderBlogs() {
  const blogList = document.getElementById('blog-list');
  if (!blogList) return;

  try {
    const posts = await loadBlogIndex();
    const cards = await Promise.all(
      posts.map(async (post) => {
        const content = await renderContent(post);
        return `
          <article class="project-card blog-card">
            <h3>${post.title}</h3>
            <p class="meta">${post.category || 'General'} • ${post.date || ''}</p>
            <div>${content}</div>
          </article>
        `;
      })
    );

    blogList.innerHTML = cards.join('');
  } catch (error) {
    blogList.innerHTML = '<article class="project-card"><h3>Unable to load blogs</h3><p>Check that the Markdown files are available in the blog folder.</p></article>';
  }
}

if (document.getElementById('blog-list')) {
  renderBlogs();
}
