(function () {
  'use strict';

  var COLS = 37;       // 1〜37
  var PICK = 7;        // 仮データ用:1回あたりの本数字の数
  var BONUS = 2;       // 仮データ用:ボーナス数字の数
  var LAST_ROUND = 699;
  var ROUNDS = 40;     // 仮データの回数

  // ---- 仮データ(レイアウト確認用。毎回同じ結果になる擬似乱数) ----
  var seed = 7;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  var seed2 = 11;      // ボーナス用は別の乱数列(本数字の仮データを変えないため)
  function rnd2() { seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff; return seed2 / 0x7fffffff; }
  function makeData() {
    var list = [];
    for (var i = 0; i < ROUNDS; i++) {
      var set = {};
      var n = 0;
      while (n < PICK) {
        var v = 1 + Math.floor(rnd() * COLS);
        if (!set[v]) { set[v] = true; n++; }
      }
      var bonus = {};
      var m = 0;
      while (m < BONUS) {
        var b = 1 + Math.floor(rnd2() * COLS);
        if (!set[b] && !bonus[b]) { bonus[b] = true; m++; }
      }
      list.push({ round: LAST_ROUND - ROUNDS + 1 + i, nums: set, bonus: bonus });
    }
    return list; // 古い回が上、新しい回が下
  }

  // ---- DOM生成 ----
  function el(cls, text) {
    var d = document.createElement('div');
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }
  function buildRow(row, label, cellFn) {
    row.appendChild(el('round', label));
    for (var c = 1; c <= COLS; c++) row.appendChild(cellFn(c));
  }
  function colClass(c) { return 'cell' + (c % 5 === 0 ? ' k5' : ''); }

  var headRow = document.getElementById('head-row');
  buildRow(headRow, '開催回', function (c) { return el(colClass(c), c); });

  var tableRows = document.getElementById('table-rows');
  makeData().forEach(function (d) {
    var row = el('row data');
    buildRow(row, '第' + d.round + '回', function (c) {
      var main = !!d.nums[c], bonus = !!d.bonus[c], hit = main || bonus;
      return el(colClass(c).replace(' k5', hit ? '' : ' k5') + (main ? ' hit main' : bonus ? ' hit bonus' : ''), hit ? c : '');
    });
    tableRows.appendChild(row);
  });

  var predRow = document.getElementById('pred-row');
  buildRow(predRow, '次回予想', function (c) {
    var d = el(colClass(c));
    d.dataset.n = c;
    d.setAttribute('role', 'button');
    d.setAttribute('aria-pressed', 'false');
    return d;
  });

  // ---- 横スクロールの同期(見出し・出目表・予想欄) ----
  var scrollers = [
    document.getElementById('head-scroll'),
    document.getElementById('table-scroll'),
    document.getElementById('pred-scroll')
  ];
  var owner = null, timer = null;
  scrollers.forEach(function (src) {
    src.addEventListener('scroll', function () {
      if (owner && owner !== src) return;   // 同期で動かされた側のイベントは無視
      owner = src;
      var x = src.scrollLeft;
      scrollers.forEach(function (o) { if (o !== src && o.scrollLeft !== x) o.scrollLeft = x; });
      clearTimeout(timer);
      timer = setTimeout(function () { owner = null; }, 120);
    }, { passive: true });
  });

  // ---- 数字選択(第2段階) ----
  var MAX_SELECT = 7;
  var selected = {};          // { 数字: true }
  var countEl = document.getElementById('count');
  var clearBtn = document.getElementById('clear-btn');
  var pickedEl = document.getElementById('picked');

  function selectedCount() { return Object.keys(selected).length; }

  function render() {
    var n = selectedCount();
    countEl.textContent = n + ' / ' + MAX_SELECT;
    countEl.classList.toggle('full', n === MAX_SELECT);
    clearBtn.disabled = n === 0;
    pickedEl.textContent = '';
    Object.keys(selected).map(Number).sort(function (a, b) { return a - b; }).forEach(function (v) {
      pickedEl.appendChild(el('chip', v));
    });
    Array.prototype.forEach.call(predRow.querySelectorAll('.cell[data-n]'), function (cell) {
      var on = !!selected[cell.dataset.n];
      cell.classList.toggle('sel', on);
      cell.setAttribute('aria-pressed', on ? 'true' : 'false');
      cell.textContent = on ? cell.dataset.n : '';
    });
  }

  predRow.addEventListener('click', function (e) {
    var cell = e.target.closest('.cell[data-n]');
    if (!cell) return;
    var n = cell.dataset.n;
    if (selected[n]) {
      delete selected[n];
    } else if (selectedCount() < MAX_SELECT) {
      selected[n] = true;
    } else {
      // 8個目は追加しない。選択数表示を揺らして知らせる
      countEl.classList.remove('bump');
      void countEl.offsetWidth;
      countEl.classList.add('bump');
      return;
    }
    render();
  });

  clearBtn.addEventListener('click', function () { selected = {}; render(); });
  render();

  // ---- 初期位置:新しい回(下側)を表示 ----
  var tableScroll = scrollers[1];
  function toBottom() { tableScroll.scrollTop = tableScroll.scrollHeight; }

  // 「最新回へ戻る」:縦位置だけ最下段へ。横位置(scrollLeft)には触れない
  // iOS Safariでは scrollTo({behavior:'smooth'}) が効かない/慣性スクロール中は
  // scrollTop の代入が無視されることがあるため、慣性を止めてから scrollTop を直接代入する。
  document.getElementById('latest-btn').addEventListener('click', function () {
    var left = tableScroll.scrollLeft;
    tableScroll.style.overflowY = 'hidden';          // 慣性スクロールを止める
    tableScroll.scrollTop = tableScroll.scrollHeight;
    requestAnimationFrame(function () {
      tableScroll.style.overflowY = '';
      tableScroll.scrollTop = tableScroll.scrollHeight;
      if (tableScroll.scrollLeft !== left) tableScroll.scrollLeft = left;
    });
  });
  // ---- 拡大・縮小(操作行は対象外) ----
  // transformは使わず、CSS変数 --z で列幅・行高・文字サイズを実寸で変える。
  var ZOOMS = [40, 50, 60, 70, 80, 90, 100, 120, 140];   // %
  var zi = 6;                                           // 初期 100%
  var zoomOut = document.getElementById('zoom-out');
  var zoomIn = document.getElementById('zoom-in');
  var zoomVal = document.getElementById('zoom-val');

  function setZoom(next) {
    if (next < 0 || next >= ZOOMS.length || next === zi) return;
    var ratio = ZOOMS[next] / ZOOMS[zi];
    var t = tableScroll;
    // 変更前の「表示の中心」と「最新回を見ているか」を記録
    var atBottom = t.scrollTop >= t.scrollHeight - t.clientHeight - 2;
    var cx = t.scrollLeft + t.clientWidth / 2;
    var cy = t.scrollTop + t.clientHeight / 2;
    zi = next;
    document.documentElement.style.setProperty('--z', ZOOMS[zi] / 100);
    // 以降の読み取りでレイアウトが再計算される。同じ場所が中心に残るようにスクロール位置を補正
    t.scrollLeft = cx * ratio - t.clientWidth / 2;
    t.scrollTop = atBottom ? t.scrollHeight : cy * ratio - t.clientHeight / 2;
    scrollers[0].scrollLeft = scrollers[2].scrollLeft = t.scrollLeft;   // 上下の列位置を確実に揃える
    zoomVal.textContent = ZOOMS[zi] + '%';
    zoomOut.disabled = zi === 0;
    zoomIn.disabled = zi === ZOOMS.length - 1;
  }
  zoomOut.addEventListener('click', function () { setZoom(zi - 1); });
  zoomIn.addEventListener('click', function () { setZoom(zi + 1); });
  zoomVal.textContent = ZOOMS[zi] + '%';

  // ---- 色設定(本数字・ボーナス数字の色。localStorageに保存) ----
  var DEFAULT_COLORS = { main: '#d3202c', bonus: '#1f5fd1' };
  var PALETTE = ['#d3202c', '#1f5fd1', '#c2410c', '#7e22ce', '#15803d', '#0f766e', '#9d174d', '#374151'];
  var STORE_KEY = 'loto7.colors';
  var colors = { main: DEFAULT_COLORS.main, bonus: DEFAULT_COLORS.bonus };
  var HEX = /^#[0-9a-f]{6}$/i;

  function loadColors() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return;                                   // 保存データなし → 初期色
      var o = JSON.parse(raw);
      if (o && HEX.test(o.main)) colors.main = o.main.toLowerCase();
      if (o && HEX.test(o.bonus)) colors.bonus = o.bonus.toLowerCase();
    } catch (e) { /* 保存データが壊れている・使えない場合は初期色のまま */ }
  }
  function saveColors() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(colors)); } catch (e) { /* 保存できなくても動作は続ける */ }
  }
  function inkFor(hex) {   // 背景色に対して読みやすい文字色(白/黒)
    var r = parseInt(hex.substr(1, 2), 16), g = parseInt(hex.substr(3, 2), 16), b = parseInt(hex.substr(5, 2), 16);
    function lin(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    var L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.4 ? '#1b1b1b' : '#ffffff';
  }

  var root = document.documentElement;
  var panel = document.getElementById('color-panel');
  var colorBtn = document.getElementById('color-btn');
  var warnEl = document.getElementById('cp-warn');
  var swatchBoxes = {}, pickers = {};
  ['main', 'bonus'].forEach(function (kind) {
    var row = panel.querySelector('.cp-row[data-kind="' + kind + '"]');
    swatchBoxes[kind] = row.querySelector('.cp-swatches');
    pickers[kind] = row.querySelector('input[type="color"]');
    PALETTE.forEach(function (hex) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cp-swatch';
      b.dataset.color = hex;
      b.style.background = hex;
      b.setAttribute('aria-label', kind === 'main' ? '本数字を ' + hex + ' にする' : 'ボーナス数字を ' + hex + ' にする');
      b.addEventListener('click', function () { setColor(kind, hex); });
      swatchBoxes[kind].appendChild(b);
    });
    pickers[kind].addEventListener('input', function () { setColor(kind, pickers[kind].value); });
  });

  function applyColors() {
    root.style.setProperty('--main', colors.main);
    root.style.setProperty('--bonus', colors.bonus);
    root.style.setProperty('--main-ink', inkFor(colors.main));
    root.style.setProperty('--bonus-ink', inkFor(colors.bonus));
    ['main', 'bonus'].forEach(function (kind) {
      pickers[kind].value = colors[kind];
      Array.prototype.forEach.call(swatchBoxes[kind].children, function (b) {
        b.classList.toggle('on', b.dataset.color === colors[kind]);
      });
    });
    warnEl.hidden = colors.main !== colors.bonus;
  }
  function setColor(kind, hex) {
    if (!HEX.test(hex)) return;
    colors[kind] = hex.toLowerCase();
    applyColors();
    saveColors();
  }

  function setPanel(open) {
    panel.hidden = !open;
    colorBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  colorBtn.addEventListener('click', function () { setPanel(panel.hidden); });
  document.getElementById('cp-close').addEventListener('click', function () { setPanel(false); });
  document.getElementById('cp-reset').addEventListener('click', function () {   // 色だけを初期色に戻す
    colors.main = DEFAULT_COLORS.main;
    colors.bonus = DEFAULT_COLORS.bonus;
    applyColors();
    saveColors();
  });
  loadColors();
  applyColors();

  toBottom();
  window.addEventListener('load', toBottom);
  window.addEventListener('orientationchange', function () { setTimeout(toBottom, 300); });
})();
