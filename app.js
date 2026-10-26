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
    row.appendChild(typeof label === 'string' ? el('round', label) : label);
    for (var c = 1; c <= COLS; c++) row.appendChild(cellFn(c));
  }
  function colClass(c) { return 'cell' + ([9, 19, 29].indexOf(c) !== -1 ? ' k5' : ''); }

  var headRow = document.getElementById('head-row');
  buildRow(headRow, '開催回', function (c) { return el(colClass(c), c); });

  var tableRows = document.getElementById('table-rows');
  // 開催日 'YYYY/MM/DD' → 'YY/MM/DD'(例: 2026/10/05 → 26/10/05)。日付がないサンプルデータは空欄
  function shortDate(date) {
    var m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(date || '');
    return m ? m[1].slice(2) + '/' + m[2] + '/' + m[3] : '';
  }
  // 履歴表を作り直す(古い回が先頭=上、新しい回が最後=下)。サンプルもCSVも同じ処理を使う
  function renderHistory(list) {
    tableRows.textContent = '';
    list.forEach(function (d) {
      var row = el('row data');
      if (d.date) row.dataset.date = d.date;
      var roundCell = el('round two');   // 縦2段: 上=開催回、下=開催日
      roundCell.appendChild(el('rd-no', '第' + d.round + '回'));
      roundCell.appendChild(el('rd-date', shortDate(d.date)));
      buildRow(row, roundCell, function (c) {
        var main = !!d.nums[c], bonus = !!d.bonus[c], hit = main || bonus;
        return el(colClass(c).replace(' k5', hit ? '' : ' k5') + (main ? ' hit main' : bonus ? ' hit bonus' : ''), hit ? c : '');
      });
      tableRows.appendChild(row);
    });
  }
  var sampleData = makeData();   // 保存データがないときだけ表示する仮データ(起動処理 startUp で描画)
  var draws = [];                // 現在の抽選データ(全回分・開催回の昇順)。表示は最新40回だけ

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
    document.getElementById('table-h'),          // v3.9-test: 出目表の横スクロール担当(旧: table-scroll)
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

  // タッチ方向固定は一旦無効化。まず標準スクロールとタップ操作を優先する。

  // ---- ブラウザ内保存(IndexedDB) ----
  // draws: 全抽選回(キー=[くじ種別, 開催回]) / kv: メタ情報と選択数字(キー=種別付き)
  // くじ種別(LOTTERY)ごとにキーを分けているので、将来のロト6・ミニロトも別の値で並べて保存できる。
  var LOTTERY = 'loto7';
  var DB_NAME = 'loto7-prediction', DB_VERSION = 1;
  var KEY_META = 'meta:' + LOTTERY, KEY_SEL = 'selected:' + LOTTERY;
  var dbHandle = null;      // 開けたDB。nullなら保存なし(memoryOnly)
  var memoryOnly = false;   // 保存機能が使えない端末(プライベートブラウズ等)。画面上だけで動く
  var ready = false;        // 起動処理(保存データの読み出し)が終わるまで数字の選択を受け付けない
  var busy = false;         // CSVの保存中は数字の選択・クリア・CSV読み込みを受け付けない

  function drawRange() { return IDBKeyRange.bound([LOTTERY, 0], [LOTTERY, Infinity]); }
  function numKeys(o) { return Object.keys(o).map(Number).sort(function (a, b) { return a - b; }); }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB未対応')); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('draws')) d.createObjectStore('draws', { keyPath: ['lottery', 'round'] });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('open失敗')); };
      req.onblocked = function () { reject(new Error('open待ち')); };
    });
  }

  // 保存データの読み出し。形式が正しい抽選回だけを採用する
  function validStored(r) {
    function ok(a, n) {
      if (!Array.isArray(a) || a.length !== n) return false;
      for (var i = 0; i < a.length; i++) if (!(a[i] >= 1 && a[i] <= COLS && Math.floor(a[i]) === a[i])) return false;
      return true;
    }
    return r && r.round >= 1 && ok(r.nums, PICK) && ok(r.bonus, BONUS);
  }
  function loadSaved(d) {
    return new Promise(function (resolve, reject) {
      var out = { draws: [], meta: null, selected: null };
      var tx = d.transaction(['draws', 'kv'], 'readonly');
      tx.objectStore('draws').getAll(drawRange()).onsuccess = function (e) {
        e.target.result.forEach(function (r) {
          if (!validStored(r)) return;
          var nums = {}, bonus = {};
          r.nums.forEach(function (v) { nums[v] = true; });
          r.bonus.forEach(function (v) { bonus[v] = true; });
          out.draws.push({ round: r.round, date: r.date || '', nums: nums, bonus: bonus });
        });
        out.draws.sort(function (a, b) { return a.round - b.round; });
      };
      tx.objectStore('kv').get(KEY_META).onsuccess = function (e) { out.meta = e.target.result || null; };
      tx.objectStore('kv').get(KEY_SEL).onsuccess = function (e) { out.selected = e.target.result || null; };
      tx.oncomplete = function () { resolve(out); };
      tx.onerror = function () { reject(tx.error || new Error('読み出し失敗')); };
      tx.onabort = function () { reject(tx.error || new Error('読み出し中断')); };
    });
  }

  // CSVの全置換。抽選データの入れ替えと選択数字の消去を1つのトランザクションで行う。
  // どこかで失敗すると全体が取り消され、以前の抽選データ・選択数字がそのまま残る。
  // 完了(oncomplete)してはじめて成功扱いにする。
  function persistReplace(list, meta) {
    return new Promise(function (resolve, reject) {
      var tx;
      try { tx = dbHandle.transaction(['draws', 'kv'], 'readwrite'); } catch (e) { reject(e); return; }
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('保存失敗')); };
      tx.onabort = function () { reject(tx.error || new Error('保存中断')); };
      try {
        var ds = tx.objectStore('draws'), kv = tx.objectStore('kv');
        ds.delete(drawRange());
        list.forEach(function (x) {
          ds.put({ lottery: LOTTERY, round: x.round, date: x.date, nums: numKeys(x.nums), bonus: numKeys(x.bonus) });
        });
        kv.put({ key: KEY_META, fileName: meta.fileName, count: meta.count, latestRound: meta.latestRound, latestDate: meta.latestDate, savedAt: meta.savedAt });
        kv.delete(KEY_SEL);
      } catch (e) { try { tx.abort(); } catch (_) {} reject(e); }
    });
  }

  // 選択数字の保存(0個のときは保存データごと消す)
  var selSaveFailShown = false;
  function saveSelection() {
    if (memoryOnly || !dbHandle) return;
    var arr = numKeys(selected);
    try {
      var tx = dbHandle.transaction(['kv'], 'readwrite'), kv = tx.objectStore('kv');
      if (arr.length) kv.put({ key: KEY_SEL, numbers: arr }); else kv.delete(KEY_SEL);
      tx.oncomplete = function () { selSaveFailShown = false; };
      tx.onabort = tx.onerror = function () { selSaveFailed(); };
    } catch (e) { selSaveFailed(); }
  }
  function selSaveFailed() {
    if (selSaveFailShown) return;   // 連続して失敗しても通知は1回だけ
    selSaveFailShown = true;
    showMsg(true, '選択を保存できませんでした', ['選択はこの画面では使えますが、閉じると消える可能性があります。']);
  }

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
    var values = Object.keys(selected).map(Number).sort(function (a, b) { return a - b; });
    Array.prototype.forEach.call(pickedEl.querySelectorAll('.chip-slot'), function (slot, i) {
      var v = values[i];
      slot.textContent = v ? String(v) : '';
      slot.classList.toggle('filled', !!v);
    });
    var selectionMsg = document.getElementById('selection-msg');
    selectionMsg.textContent = '';
    pickedEl.classList.remove('limit-shake');
    Array.prototype.forEach.call(predRow.querySelectorAll('.cell[data-n]'), function (cell) {
      var on = !!selected[cell.dataset.n];
      cell.classList.toggle('sel', on);
      cell.setAttribute('aria-pressed', on ? 'true' : 'false');
      cell.textContent = on ? cell.dataset.n : '';
    });
  }

  var predRound = predRow.querySelector('.round');
  predRow.addEventListener('click', function (e) {
    if (!ready || busy) return;
    // タップ領域を上下に広げたため、左端の固定列(次回予想)の上下の余白は、下に隠れたマスに届く。固定列の範囲は無視する
    if (predRound && e.clientX < predRound.getBoundingClientRect().right) return;
    var cell = e.target.closest('.cell[data-n]');
    if (!cell) return;
    var n = cell.dataset.n;
    if (selected[n]) {
      delete selected[n];
    } else if (selectedCount() < MAX_SELECT) {
      selected[n] = true;
    } else {
      // 8個目は追加せず、画面メッセージを表示。振動API対応端末では短く振動する。
      countEl.classList.remove('bump');
      void countEl.offsetWidth;
      countEl.classList.add('bump');
      // 選択済みの7枠だけを短く揺らす。選択欄にはメッセージを表示しない。
      pickedEl.classList.remove('limit-shake');
      void pickedEl.offsetWidth;
      pickedEl.classList.add('limit-shake');
      if (typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(100); } catch (_) {}
      }
      return;
    }
    render();
    saveSelection();   // 選択・解除のたびに保存
  });

  clearBtn.addEventListener('click', function () {
    if (!ready || busy) return;
    selected = {};
    render();
    saveSelection();   // 0個 → 保存済みの選択も消去
  });
  render();

  // ---- 初期位置:新しい回(下側)を表示 ----
  var tableScroll = document.getElementById('table-scroll');   // v3.9-test: 縦スクロール担当
  var tableH = scrollers[1];                                    // v3.9-test: 横スクロール担当(#table-h)
  function toBottom() { tableScroll.scrollTop = tableScroll.scrollHeight; }

  // 「最新回へ戻る」:縦位置だけ最下段へ。横位置(scrollLeft)には触れない
  // iOS Safariでは scrollTo({behavior:'smooth'}) が効かない/慣性スクロール中は
  // scrollTop の代入が無視されることがあるため、慣性を止めてから scrollTop を直接代入する。
  document.getElementById('latest-btn').addEventListener('click', function () {
    var left = tableH.scrollLeft;
    tableScroll.style.overflowY = 'hidden';          // 慣性スクロールを止める
    tableScroll.scrollTop = tableScroll.scrollHeight;
    requestAnimationFrame(function () {
      tableScroll.style.overflowY = '';
      tableScroll.scrollTop = tableScroll.scrollHeight;
      if (tableH.scrollLeft !== left) tableH.scrollLeft = left;
    });
  });
  // ---- 拡大・縮小(操作行は対象外) ----
  // transformは使わず、CSS変数 --z で列幅・行高・文字サイズを実寸で変える。
  var ZOOMS = [30, 40, 50, 60, 70, 80, 90, 100, 120, 140];   // %
  var zi = 1;                                           // 初期 40%
  var zoomOut = document.getElementById('zoom-out');
  var zoomIn = document.getElementById('zoom-in');
  var zoomVal = document.getElementById('zoom-val');

  function setZoom(next) {
    if (next < 0 || next >= ZOOMS.length || next === zi) return;
    var ratio = ZOOMS[next] / ZOOMS[zi];
    var t = tableScroll, h = tableH;   // v3.9-test: 縦はt、横はhから読む
    // 変更前の「表示の中心」と「最新回を見ているか」を記録
    var atBottom = t.scrollTop >= t.scrollHeight - t.clientHeight - 2;
    var cx = h.scrollLeft + h.clientWidth / 2;
    var cy = t.scrollTop + t.clientHeight / 2;
    zi = next;
    document.documentElement.style.setProperty('--z', ZOOMS[zi] / 100);
    // 以降の読み取りでレイアウトが再計算される。同じ場所が中心に残るようにスクロール位置を補正
    h.scrollLeft = cx * ratio - h.clientWidth / 2;
    t.scrollTop = atBottom ? t.scrollHeight : cy * ratio - t.clientHeight / 2;
    scrollers[0].scrollLeft = scrollers[2].scrollLeft = h.scrollLeft;   // 上下の列位置を確実に揃える
    zoomVal.textContent = ZOOMS[zi] + '%';
    zoomOut.disabled = zi === 0;
    zoomIn.disabled = zi === ZOOMS.length - 1;
  }
  zoomOut.addEventListener('click', function () { setZoom(zi - 1); });
  zoomIn.addEventListener('click', function () { setZoom(zi + 1); });
  zoomVal.textContent = ZOOMS[zi] + '%';
  document.documentElement.style.setProperty('--z', ZOOMS[zi] / 100);
  zoomOut.disabled = zi === 0;
  zoomIn.disabled = zi === ZOOMS.length - 1;

  // ---- 色設定(本数字・ボーナス数字の色。localStorageに保存) ----
  var DEFAULT_COLORS = { main: '#d3202c', bonus: '#f5b700' };
  var PALETTE = ['#d3202c', '#f5b700', '#1f5fd1', '#c2410c', '#7e22ce', '#15803d', '#0f766e', '#9d174d', '#374151'];
  var STORE_KEY = 'loto7.colors';
  var colors = { main: DEFAULT_COLORS.main, bonus: DEFAULT_COLORS.bonus };
  var HEX = /^#[0-9a-f]{6}$/i;

  function loadColors() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return;                                   // 保存データなし → 初期色
      var o = JSON.parse(raw);
      if (o && HEX.test(o.main)) colors.main = o.main.toLowerCase();
      if (o && HEX.test(o.bonus)) colors.bonus = (o.bonus.toLowerCase() === '#1f5fd1' ? DEFAULT_COLORS.bonus : o.bonus.toLowerCase());
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

  // ---- CSV読み込み(ブラウザ内だけで処理。サーバーへは送信しない) ----
  var SHOW_ROUNDS = 40;                       // 表示する直近の回数
  var MAX_CSV_BYTES = 5 * 1024 * 1024;
  var CSV_HEADER = ['開催回', '開催日', '第1数字', '第2数字', '第3数字', '第4数字', '第5数字', '第6数字', '第7数字', 'ボーナス数字1', 'ボーナス数字2'];
  var csvBtn = document.getElementById('csv-btn');
  var csvInput = document.getElementById('csv-input');
  var csvInfo = document.getElementById('csv-info');
  var csvMsg = document.getElementById('csv-msg');
  var csvMsgTitle = document.getElementById('csv-msg-title');
  var csvMsgBody = document.getElementById('csv-msg-body');
  var csvMsgTimer = null;

  function showMsg(isError, title, lines) {
    clearTimeout(csvMsgTimer);
    csvMsg.classList.toggle('err', isError);
    csvMsgTitle.textContent = title;
    csvMsgBody.textContent = '';
    var ul = document.createElement('ul');
    lines.forEach(function (t) { var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    csvMsgBody.appendChild(ul);
    csvMsg.hidden = false;
    if (!isError) csvMsgTimer = setTimeout(function () { csvMsg.hidden = true; }, 6000);   // 成功メッセージは自動で消える
  }
  document.getElementById('csv-msg-close').addEventListener('click', function () { clearTimeout(csvMsgTimer); csvMsg.hidden = true; });

  // バイト列 → 文字列。UTF-8(BOM付き含む)と判定できればUTF-8、そうでなければCP932(Shift_JIS系)
  function decodeCsv(buf) {
    if (typeof TextDecoder === 'undefined') throw new Error('このブラウザは文字コードの変換(TextDecoder)に対応していません。');
    var bytes = new Uint8Array(buf);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { /* UTF-8ではない → CP932 */ }
    try { return new TextDecoder('shift_jis').decode(bytes); }   // WHATWG仕様のshift_jisはCP932(Windows-31J)互換
    catch (e2) { throw new Error('このブラウザはCP932(Shift_JIS)の読み込みに対応していません。'); }
  }

  // 簡易CSVパーサ(ダブルクォート・改行コード差異に対応)。空行は捨てる
  function parseCsv(text) {
    var rows = [], row = [], cur = '', q = false, i, ch;
    for (i = 0; i < text.length; i++) {
      ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else { q = false; } }
        else cur += ch;
      } else if (ch === '"') { q = true; }
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); cur = '';
        rows.push(row); row = [];
      } else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return !(r.length === 1 && r[0].trim() === ''); });
  }

  function parseDate(str) {   // 2013/4/5, 2013-04-05, 2013.4.5, 2013年4月5日 → '2013/04/05'
    var m = /^(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})\s*日?$/.exec(str);
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return y + '/' + (mo < 10 ? '0' : '') + mo + '/' + (d < 10 ? '0' : '') + d;
  }

  // 検証。戻り値 { errors: [...], list: [...] }。errorsが空のときだけlistを使う
  function validateCsv(text) {
    var errors = [], list = [];
    function err(msg) { errors.push(msg); }
    var rows = parseCsv(text);
    if (!rows.length) return { errors: ['ファイルが空です。'], list: [] };
    var head = rows[0].map(function (h) { return h.replace(/^\uFEFF/, '').trim(); });
    if (head.length !== CSV_HEADER.length) {
      return { errors: ['1行目(見出し)の列数が違います(' + head.length + '列。正しくは' + CSV_HEADER.length + '列)。'], list: [] };
    }
    var badHead = [];
    CSV_HEADER.forEach(function (h, i) { if (head[i] !== h) badHead.push((i + 1) + '列目「' + head[i] + '」(正しくは「' + h + '」)'); });
    if (badHead.length) {
      return { errors: ['1行目(見出し)が想定と違います:' + badHead.slice(0, 3).join('、') + (badHead.length > 3 ? ' ほか' : '') +
        '。文字コードがCP932(Shift_JIS)またはUTF-8のCSVか確認してください。'], list: [] };
    }
    if (rows.length < 2) return { errors: ['抽選履歴の行がありません(見出しのみ)。'], list: [] };

    var seen = {}, intRe = /^\d+$/;
    for (var r = 1; r < rows.length; r++) {
      var f = rows[r].map(function (v) { return v.trim(); }), at = r + 1 + '行目:', bad = false;
      if (f.length !== CSV_HEADER.length) { err(at + '列数が' + f.length + '列です(正しくは' + CSV_HEADER.length + '列)。'); continue; }
      if (!intRe.test(f[0]) || +f[0] < 1) { err(at + '開催回「' + f[0] + '」が正しくありません。'); continue; }
      var round = +f[0];
      if (seen[round]) { err(at + '開催回' + round + 'が重複しています(' + seen[round] + '行目と同じ)。'); continue; }
      seen[round] = r + 1;
      var date = parseDate(f[1]);
      if (!date) { err(at + '第' + round + '回の開催日「' + f[1] + '」を読み取れません(例:2024/4/5)。'); bad = true; }
      var nums = {}, bonus = {}, k, v;
      for (k = 2; k <= 8; k++) {
        v = f[k];
        if (!intRe.test(v) || +v < 1 || +v > COLS) { err(at + '第' + round + '回の' + CSV_HEADER[k] + '「' + v + '」は1〜' + COLS + 'の数字ではありません。'); bad = true; continue; }
        if (nums[+v]) { err(at + '第' + round + '回の本数字に' + v + 'が重複しています。'); bad = true; continue; }
        nums[+v] = true;
      }
      for (k = 9; k <= 10; k++) {
        v = f[k];
        if (!intRe.test(v) || +v < 1 || +v > COLS) { err(at + '第' + round + '回の' + CSV_HEADER[k] + '「' + v + '」は1〜' + COLS + 'の数字ではありません。'); bad = true; continue; }
        if (nums[+v] || bonus[+v]) { err(at + '第' + round + '回のボーナス数字' + v + 'が、本数字または他のボーナス数字と重複しています。'); bad = true; continue; }
        bonus[+v] = true;
      }
      if (!bad) list.push({ round: round, date: date, nums: nums, bonus: bonus });
    }
    return { errors: errors, list: list };
  }

  function loadCsvFile(file) {
    if (!file) return;
    if (!ready || busy) { showMsg(true, '少し待ってください', ['保存の準備中、または保存中です。数秒後にもう一度お試しください。', '以前のデータはそのままです。']); return; }
    if (file.size > MAX_CSV_BYTES) { showMsg(true, '読み込めませんでした', ['ファイルが大きすぎます(5MBまで)。', '元の履歴はそのままです。']); return; }
    var reader = new FileReader();
    reader.onerror = function () { showMsg(true, '読み込めませんでした', ['ファイルを読み取れませんでした。', '元の履歴はそのままです。']); };
    reader.onload = function () {
      var result;
      try { result = validateCsv(decodeCsv(reader.result)); }
      catch (e) { showMsg(true, '読み込めませんでした', [e.message, '元の履歴はそのままです。']); return; }
      if (result.errors.length) {
        var lines = result.errors.slice(0, 8);
        if (result.errors.length > 8) lines.push('ほか' + (result.errors.length - 8) + '件のエラーがあります。');
        lines.push('元の履歴はそのままです。');
        showMsg(true, 'CSVに問題があります(' + result.errors.length + '件)', lines);
        return;
      }
      // 検証に成功したら、まずブラウザへの保存(全件置換+選択数字の消去)を完了させる。
      // 保存できたときだけ画面の抽選データを切り替え、選択数字をリセットする。失敗したら以前の抽選データ・選択数字を維持する
      var list = result.list.sort(function (a, b) { return a.round - b.round; });
      var latest = list[list.length - 1];
      var meta = { fileName: file.name, count: list.length, latestRound: latest.round, latestDate: latest.date, savedAt: Date.now() };
      function applyNew(extra) {
        draws = list;
        showDraws(meta);
        selected = {};   // 次の抽選回の予想を始める(保存側の選択は保存処理の中で消去済み)
        render();
        toBottom();      // 最新回(最下段)が見える位置へ
        var shown = Math.min(SHOW_ROUNDS, list.length);
        showMsg(false, '読み込みました', [
          'ファイル:' + file.name,
          list.length + '回分(第' + list[0].round + '〜' + latest.round + '回)',
          '最新:第' + latest.round + '回(' + latest.date + ')。直近' + shown + '回を表示しています。',
          '選択数字をリセットしました。次回の予想を始められます。'
        ].concat(extra));
      }
      if (memoryOnly) { applyNew(['※この端末では保存できません。画面を閉じると消えます。']); return; }
      busy = true;
      persistReplace(list, meta).then(function () {
        busy = false;
        applyNew([]);
      }, function () {
        busy = false;
        showMsg(true, '保存できませんでした', [
          'CSVの内容をブラウザに保存できなかったため、読み込みを取り消しました。',
          '以前の抽選データと選択数字はそのままです。',
          '端末の空き容量を確認して、もう一度お試しください。'
        ]);
      });
    };
    reader.readAsArrayBuffer(file);
  }

  // 現在の抽選データ(draws)から、直近の表示回数だけを表に出す。操作行の「n回」も更新
  function showDraws(meta) {
    renderHistory(draws.slice(-SHOW_ROUNDS));
    var latest = draws[draws.length - 1];
    csvInfo.textContent = latest.round + '回';   // 操作行では短く表示(ファイル名はタップ後のメッセージに表示)
    csvInfo.title = (meta && meta.fileName) || '';
  }

  csvBtn.addEventListener('click', function () { csvInput.click(); });
  csvInput.addEventListener('change', function () {
    var f = csvInput.files && csvInput.files[0];
    loadCsvFile(f);
    csvInput.value = '';   // 同じファイルをもう一度選べるようにする
  });

  // ---- 起動:保存済みの抽選データ・選択数字を復元 ----
  function startUp(saved) {
    if (saved && saved.draws.length) {
      draws = saved.draws;
      showDraws(saved.meta);
    } else {
      renderHistory(sampleData);   // 保存データなし → 仮データ(従来どおり「サンプル」表示)
    }
    var sel = saved && saved.selected && saved.selected.numbers;
    if (Array.isArray(sel) && sel.length <= MAX_SELECT) {
      var ok = true, tmp = {};
      sel.forEach(function (v) { if (!(v >= 1 && v <= COLS && Math.floor(v) === v) || tmp[v]) ok = false; tmp[v] = true; });
      if (ok) selected = tmp;   // 壊れた保存データは無視
    }
    render();
    toBottom();
    ready = true;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (_) {}   // 可能ならブラウザに保存の維持を依頼(失敗しても動作に影響なし)
  }
  function init() {
    var settled = false, timer;
    function fallback(reason) {   // 保存機能が使えない → 画面上だけで動かし、その旨を通知
      if (settled) return;
      settled = true; clearTimeout(timer);
      memoryOnly = true;
      startUp(null);
      showMsg(true, '保存機能が使えません', [reason, '読み込んだCSVや選択数字は、この画面を閉じると消えます。(プライベートブラウズ中の場合は解除してください)']);
    }
    timer = setTimeout(function () { fallback('保存機能の準備が終わりませんでした。'); }, 5000);
    openDb().then(function (d) {
      if (settled) { d.close(); return; }
      d.onversionchange = function () { d.close(); dbHandle = null; };
      return loadSaved(d).then(function (saved) {
        if (settled) { d.close(); return; }
        settled = true; clearTimeout(timer);
        dbHandle = d;
        startUp(saved);
      });
    }).catch(function () { fallback('ブラウザの保存機能(IndexedDB)を使えませんでした。'); });
  }
  init();

  toBottom();
  window.addEventListener('load', toBottom);
  window.addEventListener('orientationchange', function () { setTimeout(toBottom, 300); });
})();
