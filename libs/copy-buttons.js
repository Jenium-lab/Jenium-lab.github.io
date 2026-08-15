/* Add copy-to-clipboard buttons to code blocks. */
(function () {
  'use strict';

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    done();
  }

  function addCopyButtons(root) {
    root.querySelectorAll('pre').forEach(function (pre) {
      var code = pre.querySelector('code');
      if (code) {
        var m = (code.className || '').match(/language-([\w-]+)/);
        if (m) pre.setAttribute('data-lang', m[1]);
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-btn';
      btn.setAttribute('aria-label', 'Copy code to clipboard');
      btn.textContent = 'copy';
      btn.addEventListener('click', function () {
        var c = pre.querySelector('code');
        var text = c ? c.innerText : pre.innerText;
        var done = function () {
          btn.textContent = 'copied';
          setTimeout(function () { btn.textContent = 'copy'; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
        } else {
          fallbackCopy(text, done);
        }
      });
      pre.classList.add('has-copy');
      pre.appendChild(btn);
    });
  }

  addCopyButtons(document);
})();
