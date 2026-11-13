/* 원도 ↔ 도엽 번호 대응표
 *
 * 원도와 배치도 칸은 '도엽 번호'로 짝지어진다.
 *   - 도면 번호(sheetNo)를 적었으면 그 번호 (一, 十一, 11 모두 가능)
 *   - 비어 있으면 파일 순서(이름_번호의 번호)
 *   - '—' 이면 대응 없음 (배치에서 빠짐)
 * 이 표에서 번호마다 어느 원도가 들어갈지 보고 고친다.
 */
(function (App) {
  'use strict';
  const S = App.state;
  const $ = (id) => document.getElementById(id);
  const NONE = '—';

  App.isUnmatched = (s) => s.sheetNo === NONE;

  // 배치 칸 위치(배치표 기준 행·열)를 원도마다 다시 계산
  App.updateGrids = () => {
    if (!S.layout) return;
    const off = S.layout.offset || { row: 0, col: 0 };
    for (const s of App.mapSheets()) {
      const c = App.isUnmatched(s) ? null : S.layout.cells.find((x) => x.no === App.sheetNumber(s));
      s.grid = c ? { row: c.row - off.row, col: c.col - off.col } : null;
    }
  };

  function source(s) {
    if (App.isUnmatched(s)) return '대응 없음';
    return App.parseSheetNo(s.sheetNo) != null ? `도면 번호 ${s.sheetNo}` : '파일 순서';
  }

  let changed = false;
  function touch() {
    if (!changed) { App.checkpoint(); changed = true; }
  }

  function render() {
    const sheets = App.mapSheets();
    const cells = new Map((S.layout ? S.layout.cells : []).map((c) => [c.no, c]));
    const byNo = new Map();
    for (const s of sheets) {
      if (App.isUnmatched(s)) continue;
      const n = App.sheetNumber(s);
      (byNo.get(n) || byNo.set(n, []).get(n)).push(s);
    }
    const total = Math.max(S.layout ? S.layout.total : 0, ...sheets.map((s) => (App.isUnmatched(s) ? 0 : App.sheetNumber(s))), 1);
    const off = (S.layout && S.layout.offset) || { row: 0, col: 0 };
    const showAll = $('match-all').checked;

    const opts = (cur) => [`<option value="">— 원도 없음 —</option>`]
      .concat(sheets.map((s) => `<option value="${s.id}" ${cur === s ? 'selected' : ''}>${App.escapeHTML(App.newName(s))} (${App.escapeHTML(s.originalName)})</option>`))
      .join('');

    let linked = 0, empty = 0, dup = 0, noCell = 0;
    const rows = [];
    for (let n = 1; n <= total; n++) {
      const list = byNo.get(n) || [];
      const c = cells.get(n);
      const s = list[0] || null;
      let st, cls;
      if (list.length > 1) { st = `중복 ${list.length}장`; cls = 'bad'; dup++; }
      else if (s && c) { st = '연결됨'; cls = 'ok'; linked++; }
      else if (s && !c) { st = S.layout ? '배치도에 칸 없음' : '배치 미정'; cls = 'warn'; noCell++; }
      else { st = '원도 없음'; cls = 'none'; empty++; }
      if (!showAll && !s && cls === 'none') continue;
      rows.push(`<tr class="m-${cls}">
        <td class="m-no">${n}</td>
        <td class="m-cell">${c ? `${c.row - off.row + 1}행 ${c.col - off.col + 1}열` : '—'}</td>
        <td class="m-thumb">${s ? `<img src="${s.thumbURL}" alt="">` : ''}</td>
        <td><select data-no="${n}">${opts(s)}</select>${s ? `<div class="muted small">${source(s)}</div>` : ''}</td>
        <td class="m-st">${st}</td>
      </tr>`);
    }
    $('match-rows').innerHTML = rows.join('') || '<tr><td colspan="5" class="muted">표시할 번호가 없습니다. [원도가 없는 번호도 보기]를 켜세요.</td></tr>';

    const unmatched = sheets.filter((s) => App.isUnmatched(s) || App.sheetNumber(s) > total || App.sheetNumber(s) < 1);
    $('match-unmatched').innerHTML = unmatched.length
      ? '<b>번호가 없는 원도:</b> ' + unmatched.map((s) => App.escapeHTML(App.newName(s))).join(', ')
      : '';
    $('match-summary').innerHTML = `연결 <b>${linked}</b> · 원도 없음 ${empty}`
      + (noCell ? ` · <span class="warn">배치도에 칸 없음 ${noCell}</span>` : '')
      + (dup ? ` · <span class="warn">중복 ${dup}</span>` : '')
      + (S.layout ? '' : ' · <span class="warn">배치도 인식을 아직 적용하지 않았습니다</span>');
  }

  // 번호 n에 원도 s를 넣음 (그 번호를 쓰던 다른 원도는 대응 없음으로)
  function assign(n, s) {
    touch();
    for (const x of App.mapSheets()) {
      if (x !== s && !App.isUnmatched(x) && App.sheetNumber(x) === n) x.sheetNo = NONE;
    }
    if (s) s.sheetNo = String(n);
    App.updateGrids();
    App.logOp('match');
    render();
  }

  App.openMatchDialog = () => {
    if (!App.mapSheets().length) return App.toast('먼저 원도를 불러오세요.');
    changed = false;
    render();
    $('match-dialog').showModal();
  };

  function close(arrange) {
    $('match-dialog').close();
    if (!changed && !arrange) return;
    if (arrange) {
      if (!changed) App.checkpoint();
      if (!App.arrangeByLayout()) App.autoArrange(null);
      App.logOp('arrange');
    }
    App.emit('change');
    App.fitView();
  }

  App.initMatch = () => {
    $('match-rows').addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-no]');
      if (!sel) return;
      const n = +sel.dataset.no;
      const s = sel.value ? App.byId(+sel.value) : null;
      if (s) return assign(n, s);
      // '원도 없음'을 고르면 지금 그 번호의 원도를 뺌
      touch();
      for (const x of App.mapSheets()) if (!App.isUnmatched(x) && App.sheetNumber(x) === n) x.sheetNo = NONE;
      App.updateGrids();
      render();
    });
    $('match-all').addEventListener('change', render);
    $('match-fileorder').addEventListener('click', () => {
      touch();
      for (const s of App.mapSheets()) s.sheetNo = '';
      App.updateGrids();
      render();
    });
    $('match-close').addEventListener('click', () => close(false));
    $('match-arrange').addEventListener('click', () => close(true));
    $('btn-match').addEventListener('click', App.openMatchDialog);
  };
})(window.App);
