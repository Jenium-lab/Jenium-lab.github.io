(function () {
  'use strict';

  /* Scroll-reveal */
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('in'); });
  }

  /* Blog preview: 3 latest posts from blogs/index.json */
  var preview = document.getElementById('blog-preview');
  if (preview) {
    fetch('./blogs/index.json')
      .then(function (res) { return res.json(); })
      .then(function (posts) {
        if (!posts || !posts.length) {
          preview.innerHTML = '';
          return;
        }
        preview.innerHTML = posts.slice(0, 3).map(function (p) {
          var when = p.date || '';
          if (when) {
            var parts = when.split('-');
            if (parts.length === 3) {
              var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
              when = months[Number(parts[1]) - 1] + ' ' + parts[2];
            }
          }
          return '<a class="blog-preview-item" href="post.html?post=' + encodeURIComponent(p.name) + '">' +
            '<span class="bpi-title">' + p.title + '</span>' +
            '<span class="bpi-meta">' + (p.category || 'General') + (when ? ' · ' + when : '') + '</span>' +
            '<span class="bpi-arrow">→</span>' +
          '</a>';
        }).join('');
      })
      .catch(function () { preview.innerHTML = ''; });
  }
})();
