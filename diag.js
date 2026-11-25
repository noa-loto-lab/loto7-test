/* ======================================================================
   画面回転後のタッチ位置ずれの診断表示(テスト環境だけ・原因調査用の一時的なもの)
   - index.html の起動処理が、environment.json が "test" のときだけ読み込む(本番では読み込まれない)
   - 表示するもの:window / document / visualViewport の大きさ・位置・拡大率、ページのスクロール位置、
     画面の向き、#app・操作エリアの位置、回転の前後の値、最後にタップした座標と反応した要素
   - タップは「見るだけ」(preventDefault / stopPropagation はしない)。値の表示枠はタッチを通す(pointer-events: none)
   - IndexedDB・localStorage には一切触れない。アプリ本体(app.js)の処理・変数も使わない
   - 調査が終わったら、このファイルと index.html の読み込み部分(数行)を削除すれば元に戻る
   ====================================================================== */
(function () {
  'use strict';
  if (!window.LOTO7_ENV || window.LOTO7_ENV.environment !== 'test') return;   // 念のため:テスト環境以外では何もしない

  var r1 = function (v) { return Math.round(v * 10) / 10; };
  function rectOf(el) {
    if (!el || !el.getBoundingClientRect) return null;
    var b = el.getBoundingClientRect();
    return { l: r1(b.left), t: r1(b.top), w: r1(b.width), h: r1(b.height) };
  }
  function nameOf(el) {
    if (!el || el.nodeType !== 1) return '(なし)';
    var n = el.id ? '#' + el.id : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    if (el.dataset && el.dataset.n) n += '[' + el.dataset.n + ']';
    return n;
  }
  // ボタン類はボタン自身の名前で表す(中のアイコンやラベルではなく)
  function ownerOf(el) {
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.id || /^(BUTTON|SELECT|INPUT|A)$/.test(el.tagName) || (el.dataset && el.dataset.n)) return el;
      el = el.parentNode;
    }
    return el;
  }

  // ---- 表示部品(画面の左上・ヘッダーの下に小さく。値の枠はタッチを通す) ----
  var box = document.createElement('div');
  box.id = 'diag-box';
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = 'position:fixed;z-index:9999;left:4px;top:calc(var(--stat-h, 76px) + 4px);max-width:min(250px, calc(100vw - 40px));' +
    'padding:3px 5px;font:8.5px/1.25 ui-monospace,Menlo,monospace;color:#fff;background:rgba(20,20,20,.62);border-radius:6px;' +
    'pointer-events:none;white-space:pre-wrap;word-break:break-all;-webkit-user-select:none;user-select:none;';
  var tgl = document.createElement('button');
  tgl.id = 'diag-toggle';
  tgl.type = 'button';
  tgl.textContent = '診';
  tgl.title = '診断表示の表示/非表示';
  tgl.style.cssText = 'position:fixed;z-index:10000;right:calc(env(safe-area-inset-right, 0px) + 4px);top:calc(var(--stat-h, 76px) + 4px);' +
    'width:26px;height:26px;padding:0;font:700 12px/1 sans-serif;color:#fff;background:rgba(20,20,20,.6);border:0;border-radius:13px;touch-action:manipulation;';
  var shown = true;
  tgl.addEventListener('click', function () { shown = !shown; box.style.display = shown ? '' : 'none'; });

  // ---- 値の取得 ----
  function orient() {
    var a = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (typeof window.orientation === 'number' ? window.orientation : '?');
    return (window.matchMedia && matchMedia('(orientation: portrait)').matches ? '縦' : '横') + '(角度' + a + ')';
  }
  function snap() {
    var vv = window.visualViewport, de = document.documentElement, app = document.getElementById('app'), dock = document.getElementById('dock');
    return {
      o: orient(),
      win: [window.innerWidth, window.innerHeight, window.outerWidth, window.outerHeight],
      scroll: [r1(window.scrollX || window.pageXOffset || 0), r1(window.scrollY || window.pageYOffset || 0), r1(de.scrollTop), r1(document.body.scrollTop)],
      doc: [de.clientWidth, de.clientHeight],
      vv: vv ? [r1(vv.offsetLeft), r1(vv.offsetTop), r1(vv.pageLeft), r1(vv.pageTop), r1(vv.scale * 1000) / 1000, r1(vv.width), r1(vv.height)] : null,
      body: rectOf(document.body),
      app: rectOf(app),
      dock: rectOf(dock),
      dpr: window.devicePixelRatio
    };
  }
  function fmtSnap(s) {
    return s.o + ' dpr' + s.dpr + '\n' +
      'window  内' + s.win[0] + '×' + s.win[1] + ' 外' + s.win[2] + '×' + s.win[3] + '\n' +
      'scroll  X' + s.scroll[0] + ' Y' + s.scroll[1] + ' (html' + s.scroll[2] + ' body' + s.scroll[3] + ')\n' +
      'doc     ' + s.doc[0] + '×' + s.doc[1] + '\n' +
      (s.vv ? 'vv      offset ' + s.vv[0] + ',' + s.vv[1] + ' page ' + s.vv[2] + ',' + s.vv[3] + '\n        拡大率' + s.vv[4] + ' ' + s.vv[5] + '×' + s.vv[6] + '\n' : 'vv      (未対応)\n') +
      'body    上' + s.body.t + ' 左' + s.body.l + ' 高' + s.body.h + '\n' +
      'app     上' + (s.app ? s.app.t : '-') + ' 高' + (s.app ? s.app.h : '-') + ' / 操作エリア上端' + (s.dock ? s.dock.t : '-');
  }

  // ---- 回転の記録(直前の向きの値と、回転後に落ち着いた値) ----
  var last = snap(), rotLog = [];
  function onEnv(kind) {
    var before = last;
    setTimeout(function () {
      var after = snap();
      if (after.o !== before.o || kind === 'orientationchange') {
        rotLog.unshift(kind + ' ' + before.o + '→' + after.o + ' scrollY ' + before.scroll[1] + '→' + after.scroll[1] +
          (after.vv ? ' vv上 ' + (before.vv ? before.vv[1] : '-') + '→' + after.vv[1] + ' 拡大率' + (before.vv ? before.vv[4] : '-') + '→' + after.vv[4] : '') +
          ' 内高 ' + before.win[1] + '→' + after.win[1]);
        rotLog.length = Math.min(rotLog.length, 2);
      }
      last = after;
      render();
    }, 400);
  }
  window.addEventListener('orientationchange', function () { onEnv('orientationchange'); });
  window.addEventListener('resize', function () { onEnv('resize'); });
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', function () { render(); });
    visualViewport.addEventListener('scroll', function () { render(); });
  }
  window.addEventListener('scroll', function () { render(); });

  // ---- タップの記録(見るだけ。capture で先に受け取るが、処理は一切止めない) ----
  var tap = null;
  document.addEventListener('touchstart', function (e) {
    var t = e.touches && e.touches[0]; if (!t) return;
    var under = document.elementFromPoint(t.clientX, t.clientY);
    tap = { cx: r1(t.clientX), cy: r1(t.clientY), px: r1(t.pageX), py: r1(t.pageY), sx: r1(t.screenX), sy: r1(t.screenY),
            touchTarget: nameOf(ownerOf(e.target)), under: nameOf(ownerOf(under)), click: '(未発生)', clickRect: null, inRect: null };
    render();
  }, { capture: true, passive: true });
  document.addEventListener('click', function (e) {
    if (e.target === tgl) return;
    var own = ownerOf(e.target), r = rectOf(own);
    if (!tap) tap = { cx: r1(e.clientX), cy: r1(e.clientY), px: r1(e.pageX), py: r1(e.pageY), sx: '-', sy: '-', touchTarget: '-', under: '-' };
    tap.click = nameOf(own);
    tap.clickXY = r1(e.clientX) + ',' + r1(e.clientY);
    tap.clickRect = r;
    tap.inRect = r ? (tap.cx >= r.l && tap.cx <= r.l + r.w && tap.cy >= r.t && tap.cy <= r.t + r.h) : null;
    render();
  }, { capture: true, passive: true });

  function fmtTap() {
    if (!tap) return '最後のタップ:(まだなし)';
    var dist = '';
    if (tap.clickRect) {
      var r = tap.clickRect, dx = tap.cx < r.l ? tap.cx - r.l : (tap.cx > r.l + r.w ? tap.cx - (r.l + r.w) : 0), dy = tap.cy < r.t ? tap.cy - r.t : (tap.cy > r.t + r.h ? tap.cy - (r.t + r.h) : 0);
      dist = '\n  反応した要素の枠 左' + r.l + ' 上' + r.t + ' ' + r.w + '×' + r.h + (tap.inRect ? '(タップ位置は枠の中)' : '(枠の外:ずれ X' + r1(dx) + ' Y' + r1(dy) + ')');
    }
    return '最後のタップ client ' + tap.cx + ',' + tap.cy + ' page ' + tap.px + ',' + tap.py + ' screen ' + tap.sx + ',' + tap.sy + '\n' +
      '  指の下(elementFromPoint) ' + tap.under + '\n' +
      '  touch対象 ' + tap.touchTarget + ' / click対象 ' + tap.click + (tap.clickXY ? '(click ' + tap.clickXY + ')' : '') + dist;
  }
  function render() {
    if (!shown) return;
    box.textContent = '【診断・テスト環境のみ】\n' + fmtSnap(snap()) + '\n' + fmtTap() + (rotLog.length ? '\n回転の記録(新しい順)\n  ' + rotLog.join('\n  ') : '');
  }

  function mount() {
    document.body.appendChild(box);
    document.body.appendChild(tgl);
    render();
    setInterval(render, 1000);   // 値の変化の取りこぼしを防ぐ(1秒ごと。表示の更新だけ)
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
