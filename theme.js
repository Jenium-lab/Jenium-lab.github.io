(function () {
  'use strict';

  var KEY = 'jenium-theme';

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      if (v === 'light' || v === 'dark') return v;
    } catch (e) {}
    return null;
  }

  function preferred() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  var theme = stored() || preferred();
  apply(theme);

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.querySelector('.theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      theme = theme === 'dark' ? 'light' : 'dark';
      apply(theme);
      try {
        localStorage.setItem(KEY, theme);
      } catch (e) {}
    });
  });
})();
