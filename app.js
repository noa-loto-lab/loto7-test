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

  // ---- 横スクロール ----
  // 見出し・出目表・数字タップ欄は1つのスクロール領域(#work)の中に縦に積んでいるので、横位置は常に共通。
  // 以前の「見出し・出目表・予想欄の横スクロール同期」は不要になったため削除した。

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
      if (arr.length) kv.put({ key: KEY_SEL, numbers: arr, from: fromMemo || null }); else kv.delete(KEY_SEL);   // from: 予想メモから呼び出した場合の元予想
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
  var clearBtn = document.getElementById('clear-btn');
  var pickedEl = document.getElementById('picked');

  function selectedCount() { return Object.keys(selected).length; }

  function render() {
    var n = selectedCount();
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
    afterRender();   // v4.0: 予想メモ追加ボタンと呼び出し元表示の更新
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
      // 選択済みの7枠だけを短く揺らす。選択欄にはメッセージを表示しない。
      pickedEl.classList.remove('limit-shake');
      void pickedEl.offsetWidth;
      pickedEl.classList.add('limit-shake');
      if (typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(100); } catch (_) {}
      }
      return;
    }
    if (!selectedCount()) fromMemo = null;   // v4.0: 全部外したら呼び出し元の表示も消す
    render();
    saveSelection();   // 選択・解除のたびに保存
  });

  clearBtn.addEventListener('click', function () {
    if (!ready || busy) return;
    selected = {};
    fromMemo = null;   // v4.0
    render();
    saveSelection();   // 0個 → 保存済みの選択も消去
  });
  render();

  // ---- 初期位置:新しい回(下側)を表示 ----
  var work = document.getElementById('work');   // 縦横スクロール担当(見出し・出目表・数字タップ欄)
  function toBottom() { work.scrollTop = work.scrollHeight; }   // 最新回(出目表の最下段)と数字タップ欄が見える位置へ
  // ---- 拡大・縮小(操作バーは対象外。最後に使った縮尺を localStorage に保存して次回起動時に復元) ----
  // transformは使わず、CSS変数 --z で列幅・行高・文字サイズを実寸で変える。
  var ZOOMS = [30, 40, 50, 60, 70, 80, 90, 100, 120, 140];   // %
  var ZOOM_DEFAULT = 40;                                // 保存がない・壊れているときの初期値(%)
  var ZOOM_KEY = 'loto7.zoom';                          // 縮尺だけを保存するキー(表示回数とは別)
  function loadZoomIndex() {
    try {
      var raw = window.localStorage.getItem(ZOOM_KEY);
      if (raw !== null) { var i = ZOOMS.indexOf(Number(raw)); if (i >= 0) return i; }
    } catch (e) { /* 読めなければ初期値 */ }
    return ZOOMS.indexOf(ZOOM_DEFAULT);
  }
  function saveZoom() {
    try { window.localStorage.setItem(ZOOM_KEY, String(ZOOMS[zi])); } catch (e) { /* 保存できなくても動作は続ける */ }
  }
  var zi = loadZoomIndex();
  var zoomOut = document.getElementById('zoom-out');
  var zoomIn = document.getElementById('zoom-in');

  function setZoom(next) {
    if (next < 0 || next >= ZOOMS.length || next === zi) return;
    var ratio = ZOOMS[next] / ZOOMS[zi];
    // 変更前の「表示の中心」と「最新回を見ているか」を記録
    var atBottom = work.scrollTop >= work.scrollHeight - work.clientHeight - 2;
    var cx = work.scrollLeft + work.clientWidth / 2;
    var cy = work.scrollTop + work.clientHeight / 2;
    zi = next;
    document.documentElement.style.setProperty('--z', ZOOMS[zi] / 100);
    // 以降の読み取りでレイアウトが再計算される。同じ場所が中心に残るようにスクロール位置を補正
    work.scrollLeft = cx * ratio - work.clientWidth / 2;
    work.scrollTop = atBottom ? work.scrollHeight : cy * ratio - work.clientHeight / 2;
    zoomOut.disabled = zi === 0;
    zoomIn.disabled = zi === ZOOMS.length - 1;
    saveZoom();
  }
  zoomOut.addEventListener('click', function () { setZoom(zi - 1); });
  zoomIn.addEventListener('click', function () { setZoom(zi + 1); });
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
  // 表示回数(出目表に出す直近の回数だけを変える。縮尺・行の高さ・数字の大きさには影響しない)。localStorage に保存して次回起動時に復元
  var ROUNDS_OPTIONS = [5, 10, 20, 30, 50];
  var ROUNDS_DEFAULT = 20;                    // 保存がない・壊れているときの初期値
  var ROUNDS_KEY = 'loto7.showRounds';        // 表示回数だけを保存するキー(縮尺とは別)
  function loadShowRounds() {
    try {
      var raw = window.localStorage.getItem(ROUNDS_KEY);
      if (raw !== null && ROUNDS_OPTIONS.indexOf(Number(raw)) >= 0) return Number(raw);
    } catch (e) { /* 読めなければ初期値 */ }
    return ROUNDS_DEFAULT;
  }
  function saveShowRounds() {
    try { window.localStorage.setItem(ROUNDS_KEY, String(SHOW_ROUNDS)); } catch (e) { /* 保存できなくても動作は続ける */ }
  }
  var SHOW_ROUNDS = loadShowRounds();         // 表示する直近の回数
  var MAX_CSV_BYTES = 5 * 1024 * 1024;
  var CSV_HEADER = ['開催回', '開催日', '第1数字', '第2数字', '第3数字', '第4数字', '第5数字', '第6数字', '第7数字', 'ボーナス数字1', 'ボーナス数字2'];
  var csvBtn = document.getElementById('csv-btn');
  var csvInput = document.getElementById('csv-input');
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
        fromMemo = null; // v4.0: 呼び出し元の表示も消す
        render();
        toBottom();      // 最新回(最下段)が見える位置へ
        var shown = Math.min(SHOW_ROUNDS, list.length);
        showMsg(false, '読み込みました', [
          'ファイル:' + file.name,
          list.length + '回分(第' + list[0].round + '〜' + latest.round + '回)',
          '最新:第' + latest.round + '回(' + latest.date + ')。直近' + shown + '回を表示しています。',
          '選択数字をリセットしました。次回の予想を始められます。',
          '予想メモの対象を第' + (latest.round + 1) + '回に切り替えました(過去回の予想メモは残っています)。'
        ].concat(extra));
        memoViewKey = null;   // v4.0: 予想メモ画面は新しい対象回を表示
        renderMemo();
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

  // 現在の抽選データ(draws。なければ仮データ)から、直近の表示回数だけを表に出す
  function refreshHistory() {
    renderHistory((draws.length ? draws : sampleData).slice(-SHOW_ROUNDS));
  }
  function showDraws(meta) { refreshHistory(); }

  csvBtn.addEventListener('click', function () { csvInput.click(); });
  csvInput.addEventListener('change', function () {
    var f = csvInput.files && csvInput.files[0];
    loadCsvFile(f);
    csvInput.value = '';   // 同じファイルをもう一度選べるようにする
  });

  // ---- 設定パネル(歯車ボタン。CSV読み込み・色指定の2項目。画面下部に重ねて表示) ----
  // 「ロト7 CSV読み込み」(#csv-btn)は上の既存処理がそのままファイル選択を開く。「色指定」(#color-btn)も既存処理がそのまま色設定パネルを開く。
  // ここでは設定パネルの開閉だけを行う(項目を押したら設定パネルは閉じる)。
  var settingsPanel = document.getElementById('settings-panel');
  var settingsBackdrop = document.getElementById('settings-backdrop');
  var settingsBtn = document.getElementById('settings-btn');
  function setSettings(open) {
    settingsPanel.hidden = !open;
    settingsBackdrop.hidden = !open;
    settingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  settingsBtn.addEventListener('click', function () { if (settingsPanel.hidden) setMemoSheet(false); setSettings(settingsPanel.hidden); });
  document.getElementById('sp-close').addEventListener('click', function () { setSettings(false); });
  settingsBackdrop.addEventListener('click', function () { setSettings(false); });
  csvBtn.addEventListener('click', function () { setSettings(false); });
  colorBtn.addEventListener('click', function () { setSettings(false); });

  // 表示回数(5・10・20・30・50回)。出目表に出す履歴件数だけを変える。縮尺(--z)・行の高さ・数字の大きさ・横位置は変えない。
  var roundBtns = Array.prototype.slice.call(document.querySelectorAll('#rounds-options button'));
  function applyRoundsButtons() {
    roundBtns.forEach(function (b) { b.setAttribute('aria-pressed', Number(b.dataset.n) === SHOW_ROUNDS ? 'true' : 'false'); });
  }
  roundBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      var n = Number(b.dataset.n);
      if (ROUNDS_OPTIONS.indexOf(n) < 0 || n === SHOW_ROUNDS) return;
      SHOW_ROUNDS = n;
      saveShowRounds();
      applyRoundsButtons();
      var left = work.scrollLeft;
      refreshHistory();
      toBottom();                 // 最新側(最下段)に合わせる
      work.scrollLeft = left;     // 横位置は維持
    });
  });
  applyRoundsButtons();

  // ======================================================================
  // v4.0 予想メモ
  //  - 保存先は専用のIndexedDB(loto7-memo)。抽選履歴・選択数字のDB(loto7-prediction)は変更しない
  //    (同じオリジンの別ページが古い版の同名DBを開いていても、バージョン違いで壊さないため)
  //  - 対象回は保存せず、現在の抽選データの最新回+1から求める(CSVを読み込めば自動で切り替わる)
  //  - 予想の追加・マーク変更・削除は、保存に成功してから画面に反映する(失敗時は通知して変更しない)
  // ======================================================================
  var MEMO_DB_NAME = 'loto7-memo', MEMO_DB_VERSION = 1;
  var memoDb = null, memoMemoryOnly = false, memoReady = false, memoBusy = false, memoWarned = false;
  var memos = [];            // 全予想(保存順)。各要素: {id, target, round, numbers[7], mark, seq, createdAt, fromId, fromSeq, fromTarget}
  var memoLocalId = 0, memoLocalSeq = {};   // 保存できない端末用(画面上だけ)
  var fromMemo = null;       // いまの選択の呼び出し元 {id, seq, target}
  var memoFilter = 'all';    // all | buy | maybe
  var memoViewKey = null;    // 予想メモ画面で表示中の対象回(null=作成中の回)
  var memoOpen = false;      // 予想メモ(ボトムシート)が開いているか

  var memoScreen = document.getElementById('memo-screen');
  var memoList = document.getElementById('memo-list');
  var memoRoundSel = document.getElementById('memo-round');
  var memoTargetEl = document.getElementById('memo-target');
  var memoWarnEl = document.getElementById('memo-warn');
  var memoAddBtn = document.getElementById('memo-add');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  var MARKS = { buy: '★', maybe: '？' };

  function currentTarget() {   // 作成中の対象回:最新回+1。CSV未読込(サンプル表示)のときは 'sample'
    if (draws.length) { var r = draws[draws.length - 1].round + 1; return { key: 'r' + r, round: r, sample: false }; }
    return { key: 'sample', round: null, sample: true };
  }
  function targetLabel(key) { return key === 'sample' ? 'サンプル(CSV未読込)' : '第' + key.slice(1) + '回'; }

  function toast(msg, warn) {
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.classList.toggle('warn', !!warn);
    toastEl.hidden = false;
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, warn ? 3600 : 2400);
  }

  // 確認ダイアログ(Promise<boolean>)
  var cfEl = document.getElementById('confirm'), cfOk = document.getElementById('cf-ok'), cfCancel = document.getElementById('cf-cancel');
  var cfResolve = null;
  function askConfirm(title, text, okLabel, kind) {
    return new Promise(function (resolve) {
      if (cfResolve) cfResolve(false);
      cfResolve = resolve;
      document.getElementById('cf-title').textContent = title;
      document.getElementById('cf-text').textContent = text;
      cfOk.textContent = okLabel;
      cfOk.className = kind || 'primary';
      cfEl.hidden = false;
    });
  }
  function closeConfirm(v) { cfEl.hidden = true; var r = cfResolve; cfResolve = null; if (r) r(v); }
  cfOk.addEventListener('click', function () { closeConfirm(true); });
  cfCancel.addEventListener('click', function () { closeConfirm(false); });

  // ---- 保存(IndexedDB) ----
  function openMemoDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB未対応')); return; }
      var req;
      try { req = indexedDB.open(MEMO_DB_NAME, MEMO_DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('memos')) d.createObjectStore('memos', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });   // 対象回ごとの予想番号カウンタ
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('open失敗')); };
      req.onblocked = function () { reject(new Error('open待ち')); };
    });
  }
  function validMemo(r) {
    if (!r || typeof r.id !== 'number' || typeof r.target !== 'string' || !Array.isArray(r.numbers) || r.numbers.length !== MAX_SELECT) return false;
    var seen = {};
    for (var i = 0; i < r.numbers.length; i++) {
      var v = r.numbers[i];
      if (!(v >= 1 && v <= COLS) || Math.floor(v) !== v || seen[v]) return false;
      seen[v] = true;
    }
    return true;
  }
  function loadMemos(d) {
    return new Promise(function (resolve, reject) {
      var out = [];
      var tx = d.transaction(['memos'], 'readonly');
      tx.objectStore('memos').getAll().onsuccess = function (e) {
        e.target.result.forEach(function (r) {
          if (!validMemo(r)) return;   // 壊れた1件は無視(他の予想は読む)
          r.numbers = r.numbers.slice().sort(function (a, b) { return a - b; });
          if (r.mark !== 'buy' && r.mark !== 'maybe') r.mark = '';
          out.push(r);
        });
        out.sort(function (a, b) { return a.id - b.id; });
      };
      tx.oncomplete = function () { resolve(out); };
      tx.onerror = tx.onabort = function () { reject(tx.error || new Error('読み出し失敗')); };
    });
  }
  function dbAddMemo(rec) {   // 予想番号(seq)の採番と追加を1つのトランザクションで行う。完了してはじめて成功
    return new Promise(function (resolve, reject) {
      var tx;
      try { tx = memoDb.transaction(['memos', 'meta'], 'readwrite'); } catch (e) { reject(e); return; }
      var saved = null;
      tx.oncomplete = function () { resolve(saved); };
      tx.onerror = tx.onabort = function () { reject(tx.error || new Error('保存失敗')); };
      var meta = tx.objectStore('meta'), key = 'seq:' + rec.target;
      meta.get(key).onsuccess = function (e) {
        var cur = e.target.result, n = ((cur && cur.value) || 0) + 1;
        meta.put({ key: key, value: n });
        rec.seq = n;
        var rq = tx.objectStore('memos').add(rec);
        rq.onsuccess = function () { rec.id = rq.result; saved = rec; };
      };
    });
  }
  function dbPutMemo(rec) {
    return new Promise(function (resolve, reject) {
      var tx;
      try { tx = memoDb.transaction(['memos'], 'readwrite'); tx.objectStore('memos').put(rec); } catch (e) { reject(e); return; }
      tx.oncomplete = function () { resolve(); };
      tx.onerror = tx.onabort = function () { reject(tx.error || new Error('保存失敗')); };
    });
  }
  function dbDeleteMemo(id) {
    return new Promise(function (resolve, reject) {
      var tx;
      try { tx = memoDb.transaction(['memos'], 'readwrite'); tx.objectStore('memos').delete(id); } catch (e) { reject(e); return; }
      tx.oncomplete = function () { resolve(); };
      tx.onerror = tx.onabort = function () { reject(tx.error || new Error('削除失敗')); };
    });
  }
  function memoSaveFailed(what) {
    clearTimeout(toastTimer); toastEl.hidden = true;   // 直前の「保存しました」が残って誤解されないように消す
    showMsg(true, what + 'できませんでした', ['ブラウザへの保存に失敗したため、変更しませんでした(画面の予想メモはそのままです)。', '端末の空き容量を確認して、もう一度お試しください。']);
  }

  // ---- 追加 ----
  function addMemo() {
    if (!ready || busy || !memoReady || memoBusy) { toast('準備中です。少し待ってからもう一度押してください。', true); return; }
    var n = selectedCount();
    if (n < MAX_SELECT) {
      toast('あと' + (MAX_SELECT - n) + '個選んでください(' + MAX_SELECT + '個そろうと保存できます)', true);
      pickedEl.classList.remove('limit-shake'); void pickedEl.offsetWidth; pickedEl.classList.add('limit-shake');
      return;
    }
    var t = currentTarget();
    var rec = { lottery: LOTTERY, target: t.key, round: t.round, numbers: numKeys(selected), mark: '', seq: 0, createdAt: Date.now(),
                fromId: fromMemo ? fromMemo.id : null, fromSeq: fromMemo ? fromMemo.seq : null, fromTarget: fromMemo ? fromMemo.target : null };
    function done(r) {
      memos.push(r);
      memoBusy = false;
      if (memoOpen && memoViewKey !== r.target) memoViewKey = r.target;
      renderMemo();
      toast(targetLabel(r.target) + ' 予想' + r.seq + ' に保存しました' + (memoMemoryOnly ? '(この端末では閉じると消えます)' : ''));
    }
    memoBusy = true;
    if (memoMemoryOnly) {
      memoLocalSeq[rec.target] = (memoLocalSeq[rec.target] || 0) + 1;
      rec.seq = memoLocalSeq[rec.target]; rec.id = ++memoLocalId;
      if (!memoWarned) { memoWarned = true; showMsg(true, '保存機能が使えません', ['予想メモは、この画面を閉じると消えます。(プライベートブラウズ中の場合は解除してください)']); }
      done(rec);
      return;
    }
    dbAddMemo(rec).then(function (r) { done(r); }, function () { memoBusy = false; memoSaveFailed('予想メモに保存'); });
  }
  memoAddBtn.addEventListener('click', addMemo);

  // ---- 予想メモ(ボトムシート)の開閉 ----
  // 画面の下半分に重ねて表示する。上部の操作バー・選択数字エリアは隠れず、出目表のスクロール位置・縮尺・選択もそのまま保たれる。
  var memoOpenBtn = document.getElementById('memo-open');
  var memoTop = document.getElementById('memo-top');
  var sheetTimer = null;
  function setMemoSheet(open, keepInline) {
    if (open === memoOpen) return;
    memoOpen = open;
    clearTimeout(sheetTimer);
    memoOpenBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    memoScreen.classList.remove('dragging');
    if (open) {
      setPanel(false); setSettings(false);
      memoScreen.style.transform = '';
      memoScreen.hidden = false;
      renderMemo(); memoList.scrollTop = 0;
      void memoScreen.offsetHeight;          // 表示してから動かす(アニメーションの開始位置を確定)
      memoScreen.classList.add('open');
    } else {
      if (!keepInline) memoScreen.style.transform = '';
      memoScreen.classList.remove('open');
      sheetTimer = setTimeout(function () { memoScreen.hidden = true; memoScreen.style.transform = ''; }, 230);
    }
  }
  memoOpenBtn.addEventListener('click', function () { setMemoSheet(!memoOpen); });
  document.getElementById('memo-close').addEventListener('click', function () { setMemoSheet(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && memoOpen) setMemoSheet(false); });

  // 下スワイプで閉じる。反応するのはシート上部(つまみ+見出し)だけで、一覧のスクロールとは干渉しない
  var sheetDrag = null;
  memoTop.addEventListener('pointerdown', function (e) {
    if (!memoOpen || e.target.closest('button')) return;
    sheetDrag = { id: e.pointerId, y0: e.clientY, t0: Date.now(), dy: 0 };
    try { memoTop.setPointerCapture(e.pointerId); } catch (_) {}
    memoScreen.classList.add('dragging');
  });
  memoTop.addEventListener('pointermove', function (e) {
    if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
    sheetDrag.dy = Math.max(0, e.clientY - sheetDrag.y0);
    memoScreen.style.transform = 'translateY(' + sheetDrag.dy + 'px)';
  });
  function endSheetDrag(e) {
    if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
    var d = sheetDrag; sheetDrag = null;
    memoScreen.classList.remove('dragging');
    var fast = d.dy > 30 && d.dy / Math.max(1, Date.now() - d.t0) > 0.5;
    if (e.type !== 'pointercancel' && (d.dy >= 80 || fast)) {
      memoScreen.style.transform = 'translateY(100%)';   // 指を離した位置から下へ滑り落ちる
      setMemoSheet(false, true);
    } else {
      memoScreen.style.transform = '';                   // 元の位置へ戻る
    }
  }
  memoTop.addEventListener('pointerup', endSheetDrag);
  memoTop.addEventListener('pointercancel', endSheetDrag);

  // ---- 予想メモ画面の描画 ----
  function memoKeys() {   // 表示できる対象回:作成中の回 → 新しい回順 → サンプル
    var cur = currentTarget().key, seen = {}, keys = [];
    memos.forEach(function (m) { seen[m.target] = true; });
    seen[cur] = true;
    Object.keys(seen).forEach(function (k) { if (k !== cur) keys.push(k); });
    keys.sort(function (a, b) {
      if (a === 'sample') return 1; if (b === 'sample') return -1;
      return Number(b.slice(1)) - Number(a.slice(1));
    });
    return [cur].concat(keys);
  }
  function renderMemo() {
    var cur = currentTarget().key;
    memoWarnEl.hidden = !memoMemoryOnly;
    if (!memoOpen) return;   // シートを開いたときに描画する

    var keys = memoKeys();
    if (!memoViewKey || keys.indexOf(memoViewKey) === -1) memoViewKey = cur;
    memoRoundSel.textContent = '';
    keys.forEach(function (k) {
      var n = memos.filter(function (m) { return m.target === k; }).length;
      var o = document.createElement('option');
      o.value = k;
      o.textContent = targetLabel(k) + (k === cur ? ' 作成中' : '') + '(' + n + '口)';
      memoRoundSel.appendChild(o);
    });
    memoRoundSel.value = memoViewKey;
    memoTargetEl.textContent = '作成中:' + targetLabel(cur);

    var all = memos.filter(function (m) { return m.target === memoViewKey; });
    var cnt = { all: all.length, buy: 0, maybe: 0 };
    all.forEach(function (m) { if (m.mark) cnt[m.mark]++; });
    Array.prototype.forEach.call(document.querySelectorAll('#memo-filter button'), function (b) {
      var f = b.dataset.filter;
      b.setAttribute('aria-pressed', f === memoFilter ? 'true' : 'false');
      b.querySelector('.mf-n').textContent = cnt[f];
    });
    var shown = all.filter(function (m) { return memoFilter === 'all' || m.mark === memoFilter; });   // 保存順(予想1が上)

    memoList.textContent = '';
    if (!shown.length) {
      var empty = document.createElement('div');
      empty.className = 'memo-empty';
      empty.textContent = !all.length
        ? (memoViewKey === cur ? 'まだ予想がありません。出目表で7個の数字を選び、「メモに追加」を押してください。' : 'この回の予想はありません。')
        : 'この条件の予想はありません。';
      memoList.appendChild(empty);
      return;
    }
    shown.forEach(function (m) {
      var card = document.createElement('div');
      card.className = 'memo-card' + (m.mark ? ' ' + m.mark : '');
      card.dataset.id = m.id;
      card.setAttribute('role', 'listitem');

      var idBox = document.createElement('div'); idBox.className = 'mc-id';
      var lab = document.createElement('span'); lab.className = 'mc-label'; lab.textContent = '予想' + m.seq;
      idBox.appendChild(lab);
      if (m.fromId) {   // 呼び出して修正した予想:元の予想を確認できる
        var fb = document.createElement('button'); fb.type = 'button'; fb.className = 'mc-from'; fb.dataset.act = 'from'; fb.dataset.id = m.id;
        fb.textContent = '元:' + (m.fromTarget && m.fromTarget !== m.target ? targetLabel(m.fromTarget) : '') + '予想' + m.fromSeq;
        idBox.appendChild(fb);
      }
      card.appendChild(idBox);

      var nums = document.createElement('div'); nums.className = 'mc-nums';
      m.numbers.forEach(function (v) { var s2 = document.createElement('span'); s2.className = 'mc-num'; s2.textContent = v; nums.appendChild(s2); });
      card.appendChild(nums);

      var act = document.createElement('div'); act.className = 'mc-actions';
      ['buy', 'maybe'].forEach(function (k) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'mc-mark'; b.dataset.act = 'mark'; b.dataset.mark = k; b.dataset.id = m.id;
        b.textContent = MARKS[k]; b.setAttribute('aria-pressed', m.mark === k ? 'true' : 'false');
        b.setAttribute('aria-label', (k === 'buy' ? '買う' : '迷い中') + 'のマーク');
        act.appendChild(b);
      });
      var ob = document.createElement('button'); ob.type = 'button'; ob.className = 'mc-open'; ob.dataset.act = 'open'; ob.dataset.id = m.id; ob.textContent = '出目表で開く';
      var db = document.createElement('button'); db.type = 'button'; db.className = 'mc-del'; db.dataset.act = 'del'; db.dataset.id = m.id; db.textContent = '削除';
      act.appendChild(ob); act.appendChild(db);
      card.appendChild(act);
      memoList.appendChild(card);
    });
  }

  memoRoundSel.addEventListener('change', function () { memoViewKey = memoRoundSel.value; renderMemo(); memoList.scrollTop = 0; });
  document.getElementById('memo-filter').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-filter]');
    if (!b) return;
    memoFilter = b.dataset.filter; renderMemo(); memoList.scrollTop = 0;
  });

  function findMemo(id) { for (var i = 0; i < memos.length; i++) if (memos[i].id === id) return memos[i]; return null; }

  memoList.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]');
    if (!b) return;
    var rec = findMemo(Number(b.dataset.id));
    if (!rec) return;
    var act = b.dataset.act;
    if (act === 'mark') changeMark(rec, b.dataset.mark);
    else if (act === 'open') recallMemo(rec);
    else if (act === 'del') deleteMemo(rec);
    else if (act === 'from') jumpToSource(rec);
  });

  function changeMark(rec, k) {
    if (memoBusy || !memoReady) return;
    var next = rec.mark === k ? '' : k;   // 同じマークをもう一度押すと「マークなし」に戻る
    function applied() {
      rec.mark = next; memoBusy = false;
      var hidden = memoFilter !== 'all' && next !== memoFilter;
      renderMemo();
      toast('予想' + rec.seq + ':' + (next ? MARKS[next] + (next === 'buy' ? ' 買う' : ' 迷い中') : 'マークなし') + (hidden ? '(いまの絞り込みからは外れました)' : ''));
    }
    memoBusy = true;
    if (memoMemoryOnly) { applied(); return; }
    var copy = {}; Object.keys(rec).forEach(function (key) { copy[key] = rec[key]; }); copy.mark = next;
    dbPutMemo(copy).then(applied, function () { memoBusy = false; memoSaveFailed('マークを保存'); });
  }

  function deleteMemo(rec) {
    if (memoBusy || !memoReady) return;
    askConfirm('この予想を削除しますか?', targetLabel(rec.target) + ' 予想' + rec.seq + '(' + rec.numbers.join(' ') + ')を削除します。元に戻せません。', '削除する', 'danger').then(function (ok) {
      if (!ok) return;
      function removed() {
        memos = memos.filter(function (m) { return m.id !== rec.id; });
        memoBusy = false; renderMemo(); toast('予想' + rec.seq + ' を削除しました');
      }
      memoBusy = true;
      if (memoMemoryOnly) { removed(); return; }
      dbDeleteMemo(rec.id).then(removed, function () { memoBusy = false; memoSaveFailed('削除'); });
    });
  }

  // ---- 出目表で開く:選択数字を、この予想の数字に置き換える ----
  function recallMemo(rec) {
    if (!ready || busy) { toast('準備中です。少し待ってからもう一度押してください。', true); return; }
    var cur = numKeys(selected);
    var same = cur.length === rec.numbers.length && cur.every(function (v, i) { return v === rec.numbers[i]; });
    function apply() {
      selected = {};
      rec.numbers.forEach(function (v) { selected[v] = true; });
      fromMemo = { id: rec.id, seq: rec.seq, target: rec.target };
      render();
      saveSelection();
      setMemoSheet(false);   // 出目表を見せるためにシートを閉じる
      toast(targetLabel(rec.target) + ' 予想' + rec.seq + ' を出目表に呼び出しました');
    }
    if (cur.length && !same) {
      askConfirm('出目表の選択を置き換えますか?', '現在の選択(' + cur.join(' ') + ')を、予想' + rec.seq + '(' + rec.numbers.join(' ') + ')に置き換えます。保存していない選択は失われます。', '置き換える', 'primary')
        .then(function (ok) { if (ok) apply(); });
    } else apply();
  }

  function jumpToSource(rec) {   // 「元:予想N」→ 元の予想を表示(別の回なら回も切り替える)
    var src = findMemo(rec.fromId);
    if (!src) { toast('元の予想(予想' + rec.fromSeq + ')は削除されています', true); return; }
    memoViewKey = src.target; memoFilter = 'all'; renderMemo();
    var card = memoList.querySelector('.memo-card[data-id="' + src.id + '"]');
    if (card) { card.scrollIntoView({ block: 'center' }); card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
  }

  // 選択行の表示更新(render()から呼ばれる)
  function afterRender() {
    if (!memoAddBtn) return;   // 起動中(部品の準備前)は何もしない
    var n = selectedCount();
    memoAddBtn.classList.toggle('short', n < MAX_SELECT);
    var msg = document.getElementById('selection-msg');
    msg.textContent = '';
    if (fromMemo && n > 0) {
      var src = findMemo(fromMemo.id), same = src && src.numbers.join() === numKeys(selected).join();
      var lab = (fromMemo.target !== currentTarget().key ? targetLabel(fromMemo.target) + ' ' : '') + '予想' + fromMemo.seq;
      msg.textContent = !src ? '元:' + lab + '(削除済み)' : same ? lab + ' を呼び出し中' : lab + ' から修正中';
    }
  }

  // 起動:予想メモの読み出し(失敗しても出目表は使える。その場合は画面上だけの予想メモになる)
  (function initMemo() {
    var settled = false, timer;
    function useMemoryOnly() {
      if (settled) return;
      settled = true; clearTimeout(timer);
      memoMemoryOnly = true; memoReady = true;
      renderMemo(); afterRender();
    }
    timer = setTimeout(useMemoryOnly, 5000);
    openMemoDb().then(function (d) {
      if (settled) { d.close(); return; }
      d.onversionchange = function () { d.close(); memoDb = null; memoMemoryOnly = true; renderMemo(); };
      return loadMemos(d).then(function (list) {
        if (settled) { d.close(); return; }
        settled = true; clearTimeout(timer);
        memoDb = d; memos = list; memoReady = true;
        renderMemo(); afterRender();
      });
    }).catch(useMemoryOnly);
  })();

  // ---- 起動:保存済みの抽選データ・選択数字を復元 ----
  function startUp(saved) {
    if (saved && saved.draws.length) {
      draws = saved.draws;
      showDraws(saved.meta);
    } else {
      refreshHistory();   // 保存データなし → 仮データ(従来どおり「サンプル」表示。件数は表示回数に従う)
    }
    var sel = saved && saved.selected && saved.selected.numbers;
    if (Array.isArray(sel) && sel.length <= MAX_SELECT) {
      var ok = true, tmp = {};
      sel.forEach(function (v) { if (!(v >= 1 && v <= COLS && Math.floor(v) === v) || tmp[v]) ok = false; tmp[v] = true; });
      if (ok) selected = tmp;   // 壊れた保存データは無視
      var fr = ok && saved.selected.from;
      if (fr && typeof fr.id === 'number' && typeof fr.target === 'string') fromMemo = { id: fr.id, seq: fr.seq, target: fr.target };   // v4.0
    }
    render();
    toBottom();
    ready = true;
    renderMemo();   // v4.0: 対象回(最新回+1)が決まったので予想メモ画面を更新
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
