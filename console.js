(function () {
  'use strict';

  function pad(n) { return String(n).padStart(2, '0'); }

  function tickClock() {
    document.querySelectorAll('[data-clock]').forEach(function (el) {
      var now = new Date();
      var h = pad(now.getHours()), m = pad(now.getMinutes()), s = pad(now.getSeconds());
      var utc = pad(now.getUTCHours()) + ':' + pad(now.getUTCMinutes()) + ':' + pad(now.getUTCSeconds());
      var local = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      var mode = el.getAttribute('data-clock');
      if (mode === 'utc') el.textContent = utc + ' UTC';
      else if (mode === 'date') el.textContent = local;
      else el.textContent = h + ':' + m + ':' + s;
    });
  }

  /* -- live metrics: purely cosmetic console flavor -- */
  var bootOffset = Math.floor((Date.now() - new Date('2026-01-01T00:00:00Z')) / 1000);
  var metricState = {
    load: [0.42, 0.33, 0.29],
    rx: 1240,
    tx: 860
  };

  function tickMetrics() {
    bootOffset += 1;
    var jitter = function (base, amp) { return (base + (Math.random() * 2 - 1) * amp).toFixed(2); };
    metricState.load = [jitter(0.4, 0.06), jitter(0.33, 0.05), jitter(0.28, 0.05)];
    metricState.rx = Math.max(120, metricState.rx + (Math.random() * 900 - 430));
    metricState.tx = Math.max(80, metricState.tx + (Math.random() * 700 - 340));

    var up = bootOffset;
    var dh = Math.floor(up / 3600), dm = Math.floor((up % 3600) / 60), ds = up % 60;
    var uptime = dh + 'h ' + pad(dm) + 'm ' + pad(ds) + 's';

    var map = { uptime: uptime, load1: metricState.load[0], load5: metricState.load[1], load15: metricState.load[2] };
    document.querySelectorAll('[data-metric]').forEach(function (el) {
      var key = el.getAttribute('data-metric');
      if (key in map) el.textContent = map[key];
    });

    var rxEl = document.querySelector('[data-metric="rx"]');
    var txEl = document.querySelector('[data-metric="tx"]');
    if (rxEl) rxEl.textContent = Math.round(metricState.rx) + ' KiB/s';
    if (txEl) txEl.textContent = Math.round(metricState.tx) + ' KiB/s';
  }

  /* -- terminal boot sequence -- */
  function bootTerminal() {
    var root = document.getElementById('boot');
    if (!root) return;
    var lines = Array.prototype.slice.call(root.querySelectorAll('.type'));
    var idx = 0;

    function next() {
      if (idx >= lines.length) {
        var cursor = root.querySelector('.cursor');
        if (cursor) cursor.classList.add('cursor');
        return;
      }
      var line = lines[idx++];
      line.classList.remove('hidden-line');
      line.classList.add('revealed');
      var speed = line.getAttribute('data-speed') || 60;
      setTimeout(next, Number(speed));
    }
    setTimeout(next, 300);
  }

  document.addEventListener('DOMContentLoaded', function () {
    tickClock();
    tickMetrics();
    bootTerminal();
    setInterval(tickClock, 1000);
    setInterval(tickMetrics, 1000);
  });
})();
