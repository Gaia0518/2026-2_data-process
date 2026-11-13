/* 2차: 0번 배치도 인식 → 사용자 확인·수정 → 그 배치대로 자동 배열
 *
 * 배치(S.layout)는 0번 이미지 위의 격자로 저장한다 (0번 원본 px).
 *   { x0, y0, cw, ch, cols, rows, total, order, cells: [{ row, col, no }] }
 * 번호 no 는 도엽 번호(1~전체). 원도와는 '도면 번호'(없으면 파일 순서)로 짝짓는다.
 */
(function (App) {
  'use strict';
  const S = App.state;
  const $ = (id) => document.getElementById(id);

  /* ---------- 번호 ---------- */
  const KANJI = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

  // "11", "十一", "六十八", "二十" → 숫자. 읽을 수 없으면 null
  App.parseSheetNo = (v) => {
    if (v == null) return null;
    const s = String(v).trim().replace(/[第號号호\s]/g, '');
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    let total = 0, cur = 0, seen = false;
    for (const ch of s) {
      if (ch in KANJI) { cur = KANJI[ch]; seen = true; }
      else if (ch === '十' || ch === '拾') { total += (cur || 1) * 10; cur = 0; seen = true; }
      else if (ch === '百') { total += (cur || 1) * 100; cur = 0; seen = true; }
      else return null;
    }
    return seen ? total + cur : null;
  };

  // 도엽 번호: 원도에 적힌 도면 번호가 있으면 그것, 없으면 파일 순서(이름_번호)
  App.sheetNumber = (s) => App.parseSheetNo(s.sheetNo) ?? S.sheets.indexOf(s);

  const ORDERS = {
    'col-rtl': (a, b) => b.col - a.col || a.row - b.row, // 오른쪽 열부터, 위 → 아래 (지적원도에서 흔한 순서)
    'col-ltr': (a, b) => a.col - b.col || a.row - b.row,
    'row-ltr': (a, b) => a.row - b.row || a.col - b.col,
    'row-rtl': (a, b) => a.row - b.row || b.col - a.col,
  };

  /* ---------- 자동 인식 ---------- */
  // 영역 픽셀 읽기 (계산은 긴 변 800px 이하로 줄여서)
  async function readGray(s, box) {
    const k = Math.min(1, 800 / Math.max(box.w, box.h));
    const bmp = await createImageBitmap(s.file, Math.round(box.x), Math.round(box.y), Math.round(box.w), Math.round(box.h));
    const W = Math.max(8, Math.round(box.w * k)), H = Math.max(8, Math.round(box.h * k));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, W, H);
    bmp.close && bmp.close();
    return { k, W, H, data: ctx.getImageData(0, 0, W, H).data };
  }

  // 잉크 지도: 컬러면 빨간 선·글씨(R-G), 흑백이면 어두운 정도
  function inkMap(img) {
    const { W, H, data } = img;
    const n = W * H;
    const rg = new Float32Array(n);
    let sumAbs = 0;
    for (let i = 0; i < n; i++) { rg[i] = data[i * 4] - data[i * 4 + 1]; sumAbs += Math.abs(rg[i]); }
    const color = sumAbs / n > 4;
    const ink = new Float32Array(n);
    if (color) {
      const med = Float32Array.from(rg).sort()[n >> 1];
      for (let i = 0; i < n; i++) ink[i] = Math.max(0, rg[i] - med - 6) * 4;
    } else {
      for (let i = 0; i < n; i++) ink[i] = Math.max(0, 200 - (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3);
    }
    return { ink, color };
  }

  // 선의 연속성: 그 열(행)에서 잉크가 있는 비율 (테두리는 길게 이어지고, 글씨 획은 짧음)
  function continuity(ink, W, H, axis, thr) {
    const out = new Float32Array(axis === 'x' ? W : H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let on = false;
        for (let d = -1; d <= 1 && !on; d++) {
          const xx = axis === 'x' ? x + d : x, yy = axis === 'x' ? y : y + d;
          if (xx >= 0 && xx < W && yy >= 0 && yy < H && ink[yy * W + xx] > thr) on = true;
        }
        if (on) out[axis === 'x' ? x : y] += 1;
      }
    }
    const L = axis === 'x' ? H : W;
    for (let i = 0; i < out.length; i++) out[i] /= L;
    return out;
  }

  function median(arr) { return Float32Array.from(arr).sort()[arr.length >> 1]; }

  function periodScore(prof, P) {
    const n = prof.length;
    let best = 0, bestPh = 0;
    for (let ph = 0; ph < P; ph += 0.5) {
      let sum = 0, cnt = 0;
      for (let x = ph; x < n; x += P) { sum += prof[Math.round(x)] || 0; cnt++; }
      if (cnt >= 2 && sum / cnt > best) { best = sum / cnt; bestPh = ph; }
    }
    return { score: best / (median(prof) + 1e-3), ph: bestPh };
  }

  // 번호는 칸 한가운데에 있다 → 칸 중심 띠에 잉크가 더 많은 쪽으로 위상을 고름
  function centerInk(rawProf, P, ph) {
    let sum = 0, cnt = 0;
    for (let x = ph + P / 2; x < rawProf.length; x += P) {
      for (let d = -P * 0.18; d <= P * 0.18; d += 1) { sum += rawProf[Math.round(x + d)] || 0; cnt++; }
    }
    return cnt ? sum / cnt : 0;
  }

  App.detectLayout = async (layoutSheet, box, total, aspect) => {
    const img = await readGray(layoutSheet, box);
    const { W, H, k } = img;
    const { ink, color } = inkMap(img);
    const sorted = Float32Array.from(ink).sort();
    const thr = color ? 10 : sorted[Math.floor(sorted.length * 0.8)];
    const cx = continuity(ink, W, H, 'x', thr), cy = continuity(ink, W, H, 'y', thr);
    const rawX = new Float32Array(W), rawY = new Float32Array(H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { rawX[x] += ink[y * W + x]; rawY[y] += ink[y * W + x]; }

    // 칸 수가 전체 도엽 수의 0.9~4.5배가 되는 크기만 후보로 (종이 모눈·두 배 크기 오인 방지)
    let best = null;
    for (let P = 8; P < W / 1.5; P += 0.5) {
      const Q0 = P / aspect;
      const ncell = (W / P) * (H / Q0);
      if (ncell < total * 0.9 || ncell > total * 4.5) continue;
      const sx = periodScore(cx, P);
      let sy = { score: -1 };
      let Q = Q0;
      for (let q = Q0 * 0.92; q <= Q0 * 1.08; q += 0.5) {
        const r = periodScore(cy, q);
        if (r.score > sy.score) { sy = r; Q = q; }
      }
      const score = sx.score + sy.score;
      if (!best || score > best.score) best = { score, P, Q, phx: sx.ph, phy: sy.ph };
    }
    if (!best) return null;
    let { P, Q, phx, phy } = best;
    if (centerInk(rawX, P, phx + P / 2) > centerInk(rawX, P, phx)) phx = (phx + P / 2) % P;
    if (centerInk(rawY, Q, phy + Q / 2) > centerInk(rawY, Q, phy)) phy = (phy + Q / 2) % Q;

    // 영역을 덮는 격자 (0번 원본 px)
    const cw = P / k, ch = Q / k;
    let x0 = box.x + phx / k, y0 = box.y + phy / k;
    while (x0 - cw > box.x - cw * 0.5) x0 -= cw;
    while (y0 - ch > box.y - ch * 0.5) y0 -= ch;
    const cols = Math.max(1, Math.round((box.x + box.w - x0) / cw));
    const rows = Math.max(1, Math.round((box.y + box.h - y0) / ch));
    const grid = { x0, y0, cw, ch, cols, rows, color };
    grid.scores = cellScores(grid, ink, img, box);
    return grid;
  };

  // 칸 가운데(번호 자리)의 잉크 양
  function cellScores(g, ink, img, box) {
    const { W, H, k } = img;
    const out = [];
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const x0 = (g.x0 + c * g.cw - box.x) * k, y0 = (g.y0 + r * g.ch - box.y) * k;
        const ax = Math.max(0, Math.round(x0 + g.cw * k * 0.3)), bx = Math.min(W, Math.round(x0 + g.cw * k * 0.7));
        const ay = Math.max(0, Math.round(y0 + g.ch * k * 0.22)), by = Math.min(H, Math.round(y0 + g.ch * k * 0.78));
        let sum = 0, cnt = 0;
        for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) { sum += ink[y * W + x]; cnt++; }
        out.push({ row: r, col: c, score: cnt ? sum / cnt : 0 });
      }
    }
    return out;
  }

  // 잉크가 많은 칸부터 전체 도엽 수만큼 고르고, 정한 순서대로 번호를 매김
  function proposeCells(scores, total, order) {
    const picked = scores.slice().sort((a, b) => b.score - a.score).slice(0, total);
    return numberCells(picked.map(({ row, col }) => ({ row, col })), order);
  }
  function numberCells(cells, order) {
    return cells.slice().sort(ORDERS[order] || ORDERS['col-rtl']).map((c, i) => ({ row: c.row, col: c.col, no: i + 1 }));
  }

  /* ---------- 배치도 인식 창 ---------- */
  const lv = { zoom: 1, ox: 0, oy: 0 };
  App.layoutView = lv; // 시험용
  App.layoutWork = () => work; // 시험용
  let canvas, ctx;
  let work = null; // 편집 중인 배치 (적용 전까지 S.layout 과 별개)
  let mode = 'region';
  let selected = null; // {row, col}
  let seqNext = 1;
  let drag = null, draft = null;
  let lastScores = null;

  const layoutImg = () => App.layoutSheet();

  App.openLayoutDialog = () => {
    const s0 = layoutImg();
    if (!s0) return App.toast('0번(배치도) 원도를 먼저 불러오세요.');
    work = S.layout ? JSON.parse(JSON.stringify(S.layout)) : null;
    selected = null;
    lastScores = null;
    $('lay-total').value = (work && work.total) || Math.max(App.mapSheets().length, 1);
    $('lay-order').value = (work && work.order) || 'col-rtl';
    setMode(work ? 'edit' : 'region');
    $('layout-dialog').showModal();
    requestAnimationFrame(() => { fit(); render(); });
  };

  function setMode(m) {
    mode = m;
    document.querySelectorAll('[name="lay-mode"]').forEach((el) => (el.checked = el.value === m));
    if (m === 'sequence') seqNext = 1;
    render();
  }

  function fit() {
    const s0 = layoutImg();
    const r = canvas.parentElement.getBoundingClientRect();
    const target = work ? { x: work.x0, y: work.y0, w: work.cw * work.cols, h: work.ch * work.rows } : { x: 0, y: 0, w: s0.w, h: s0.h };
    const pad = work ? 1.15 : 1.0;
    lv.zoom = Math.min(r.width / (target.w * pad), r.height / (target.h * pad));
    lv.ox = r.width / 2 - (target.x + target.w / 2) * lv.zoom;
    lv.oy = r.height / 2 - (target.y + target.h / 2) * lv.zoom;
  }

  const toImg = (sx, sy) => [(sx - lv.ox) / lv.zoom, (sy - lv.oy) / lv.zoom];
  const toScr = (x, y) => [x * lv.zoom + lv.ox, y * lv.zoom + lv.oy];

  function cellAt(x, y) {
    if (!work) return null;
    const col = Math.floor((x - work.x0) / work.cw), row = Math.floor((y - work.y0) / work.ch);
    if (col < 0 || row < 0 || col >= work.cols || row >= work.rows) return null;
    return { row, col };
  }
  const findCell = (row, col) => work.cells.find((c) => c.row === row && c.col === col);

  function missingNumbers() {
    const have = new Set(work ? work.cells.map((c) => c.no) : []);
    const out = [];
    for (let i = 1; i <= work.total; i++) if (!have.has(i)) out.push(i);
    return out;
  }

  function render() {
    const s0 = layoutImg();
    if (!s0 || !canvas) return;
    const wrap = canvas.parentElement.getBoundingClientRect();
    const d = window.devicePixelRatio || 1;
    canvas.width = Math.round(wrap.width * d);
    canvas.height = Math.round(wrap.height * d);
    canvas.style.width = wrap.width + 'px';
    canvas.style.height = wrap.height + 'px';
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.fillStyle = '#3a403e';
    ctx.fillRect(0, 0, wrap.width, wrap.height);
    const pk = s0.preview.width / s0.w;
    ctx.setTransform(d * lv.zoom / pk, 0, 0, d * lv.zoom / pk, d * lv.ox, d * lv.oy);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s0.preview, 0, 0);
    ctx.setTransform(d, 0, 0, d, 0, 0);

    if (work) {
      const [gx, gy] = toScr(work.x0, work.y0);
      const cw = work.cw * lv.zoom, ch = work.ch * lv.zoom;
      // 번호 칸
      for (const c of work.cells) {
        const x = gx + c.col * cw, y = gy + c.row * ch;
        ctx.fillStyle = 'rgba(25,179,166,0.28)';
        ctx.fillRect(x, y, cw, ch);
      }
      ctx.strokeStyle = 'rgba(30,120,255,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 0; c <= work.cols; c++) { ctx.moveTo(gx + c * cw + 0.5, gy); ctx.lineTo(gx + c * cw + 0.5, gy + work.rows * ch); }
      for (let r = 0; r <= work.rows; r++) { ctx.moveTo(gx, gy + r * ch + 0.5); ctx.lineTo(gx + work.cols * cw, gy + r * ch + 0.5); }
      ctx.stroke();
      const dup = duplicates();
      const fs = Math.max(9, Math.min(28, ch * 0.42));
      ctx.font = `700 ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const c of work.cells) {
        const x = gx + (c.col + 0.5) * cw, y = gy + (c.row + 0.5) * ch;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.strokeText(String(c.no), x, y);
        ctx.fillStyle = dup.has(c.no) || c.no > work.total ? '#c0392b' : '#0d5e57';
        ctx.fillText(String(c.no), x, y);
      }
      if (selected) {
        ctx.strokeStyle = '#f39c12';
        ctx.lineWidth = 3;
        ctx.strokeRect(gx + selected.col * cw, gy + selected.row * ch, cw, ch);
      }
    }
    if (draft) {
      const [a, b] = toScr(draft.x, draft.y);
      ctx.strokeStyle = mode === 'cell' ? '#f39c12' : '#19b3a6';
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeRect(a, b, draft.w * lv.zoom, draft.h * lv.zoom);
      ctx.setLineDash([]);
    }
    renderSide();
  }

  function duplicates() {
    const seen = new Set(), dup = new Set();
    for (const c of work ? work.cells : []) (seen.has(c.no) ? dup : seen).add(c.no);
    return dup;
  }

  function renderSide() {
    const has = !!work;
    document.querySelectorAll('.lay-step').forEach((el, i) => {
      const done = [has, has && work.cells.length > 0, false][i];
      el.classList.toggle('is-done', done);
      el.classList.toggle('is-current', i === (has ? (work.cells.length ? 2 : 1) : 0));
    });
    $('lay-grid-box').hidden = !has;
    $('lay-summary').hidden = !has;
    $('lay-apply').disabled = !has || !work.cells.length;
    $('lay-apply-arrange').disabled = !has || !work.cells.length;
    const hint = {
      region: '0번 원도에서 배치도 부분을 드래그해 사각형으로 감싸세요. 놓으면 칸과 번호를 자동으로 찾습니다.',
      cell: '배치도의 칸 하나를 정확히 드래그하세요. 그 크기로 격자를 다시 맞춥니다.',
      edit: '빈 칸 클릭: 빠진 번호 넣기 · 번호 칸 클릭: 선택 (Delete로 빼기, 오른쪽에서 번호 고치기) · 끌기: 화면 이동',
      sequence: `1번부터 순서대로 칸을 클릭하세요. 다음 번호: ${seqNext}`,
    }[mode];
    $('lay-hint').textContent = hint;
    if (!has) return;
    $('lay-cols').value = work.cols;
    $('lay-rows').value = work.rows;
    $('lay-cellsize').textContent = `칸 ${Math.round(work.cw)} × ${Math.round(work.ch)}px`;
    const miss = missingNumbers();
    const dup = [...duplicates()];
    const sheetsByNo = new Map(App.mapSheets().map((s) => [App.sheetNumber(s), s]));
    const placed = App.mapSheets().filter((s) => work.cells.some((c) => c.no === App.sheetNumber(s))).length;
    $('lay-summary').innerHTML = [
      `번호 매긴 칸 <b>${work.cells.length}</b> / 전체 ${work.total}`,
      `불러온 원도 ${App.mapSheets().length}장 중 <b>${placed}</b>장이 칸과 짝지어짐`,
      miss.length ? `<span class="warn">빠진 번호: ${compactList(miss)}</span>` : '빠진 번호 없음',
      dup.length ? `<span class="warn">중복 번호: ${dup.join(', ')}</span>` : '',
      App.mapSheets().length > placed
        ? `<span class="muted">칸이 없는 원도: ${App.mapSheets().filter((s) => !work.cells.some((c) => c.no === App.sheetNumber(s))).map((s) => App.sheetNumber(s)).join(', ')}</span>` : '',
    ].filter(Boolean).join('<br>');
    const selBox = $('lay-selected');
    const sc = selected && findCell(selected.row, selected.col);
    selBox.hidden = !sc;
    if (sc) {
      const sh = sheetsByNo.get(sc.no);
      $('lay-sel-title').textContent = `선택한 칸 (행 ${sc.row + 1}, 열 ${sc.col + 1})`;
      if (document.activeElement !== $('lay-sel-no')) $('lay-sel-no').value = sc.no;
      $('lay-sel-sheet').textContent = sh ? `→ ${App.newName(sh)}` : '→ 불러온 원도 없음 (빈 틀로 배열)';
    }
  }

  function compactList(nums) {
    const out = [];
    for (let i = 0; i < nums.length; i++) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      out.push(j > i ? `${nums[i]}–${nums[j]}` : String(nums[i]));
      i = j;
    }
    return out.join(', ');
  }

  async function runDetect(box) {
    const s0 = layoutImg();
    const total = Math.max(1, parseInt($('lay-total').value, 10) || App.mapSheets().length || 1);
    const aspect = S.frameSize ? S.frameSize.w / S.frameSize.h : 1.25;
    $('lay-hint').textContent = '배치도를 분석하는 중…';
    const g = await App.detectLayout(s0, box, total, aspect);
    if (!g) {
      App.toast('칸을 찾지 못했습니다. [칸 하나 그리기]로 칸 크기를 알려 주세요.');
      work = { x0: box.x, y0: box.y, cw: box.w / 4, ch: box.h / 4, cols: 4, rows: 4, total, order: $('lay-order').value, cells: [] };
      setMode('cell');
      return;
    }
    lastScores = { scores: g.scores, key: `${g.x0},${g.y0},${g.cw},${g.ch}` };
    work = {
      x0: g.x0, y0: g.y0, cw: g.cw, ch: g.ch, cols: g.cols, rows: g.rows, total,
      order: $('lay-order').value, region: box,
      cells: proposeCells(g.scores, total, $('lay-order').value),
    };
    App.logOp('layoutDetect');
    setMode('edit');
    fit();
    render();
  }

  // 칸 하나를 그려 격자 크기·위치를 다시 맞춤 → 번호 칸도 다시 제안
  async function regridFromCell(c) {
    const s0 = layoutImg();
    const region = work && work.region ? work.region : { x: work.x0, y: work.y0, w: work.cw * work.cols, h: work.ch * work.rows };
    let x0 = c.x, y0 = c.y;
    while (x0 - c.w > region.x - c.w * 0.5) x0 -= c.w;
    while (y0 - c.h > region.y - c.h * 0.5) y0 -= c.h;
    const cols = Math.max(1, Math.round((region.x + region.w - x0) / c.w));
    const rows = Math.max(1, Math.round((region.y + region.h - y0) / c.h));
    work = { ...work, x0, y0, cw: c.w, ch: c.h, cols, rows };
    // 새 격자로 번호 자리 잉크를 다시 계산
    const img = await readGray(s0, region);
    const { ink } = inkMap(img);
    const scores = cellScores(work, ink, img, region);
    work.cells = proposeCells(scores, work.total, work.order);
    App.logOp('layoutEdit');
    setMode('edit');
    render();
  }

  function clickCell(cell) {
    if (!cell) { selected = null; return render(); }
    const existing = findCell(cell.row, cell.col);
    if (mode === 'sequence') {
      const n = seqNext++;
      work.cells = work.cells.filter((c) => c.no !== n && !(c.row === cell.row && c.col === cell.col));
      work.cells.push({ row: cell.row, col: cell.col, no: n });
      selected = cell;
      return render();
    }
    if (existing) {
      selected = cell;
    } else {
      const miss = missingNumbers();
      const no = miss.length ? miss[0] : work.cells.reduce((m, c) => Math.max(m, c.no), 0) + 1;
      work.cells.push({ row: cell.row, col: cell.col, no });
      selected = cell;
    }
    render();
  }

  function removeSelected() {
    if (!selected) return;
    work.cells = work.cells.filter((c) => !(c.row === selected.row && c.col === selected.col));
    selected = null;
    render();
  }

  // 검토한 배치를 적용: 원도마다 격자 위치(row, col)를 정함
  function applyLayout(arrange) {
    App.checkpoint();
    S.layout = JSON.parse(JSON.stringify(work));
    S.layout.cells.sort((a, b) => a.no - b.no);
    const minR = Math.min(...S.layout.cells.map((c) => c.row)), minC = Math.min(...S.layout.cells.map((c) => c.col));
    S.layout.offset = { row: minR, col: minC };
    for (const s of App.mapSheets()) {
      const c = S.layout.cells.find((x) => x.no === App.sheetNumber(s));
      s.grid = c ? { row: c.row - minR, col: c.col - minC } : null;
    }
    App.logOp('layout');
    $('layout-dialog').close();
    if (arrange) App.arrangeByLayout();
    App.emit('change');
    App.fitView();
  }

  /* ---------- 배치대로 자동 배열 ---------- */
  App.layoutCellSize = () => {
    if (S.frameSize) return { w: S.frameSize.w, h: S.frameSize.h };
    const ms = App.mapSheets();
    if (!ms.length) return { w: 1000, h: 800 };
    return {
      w: Math.max(...ms.map((s) => App.cropSize(s).w * s.transform.scale)),
      h: Math.max(...ms.map((s) => App.cropSize(s).h * s.transform.scale)),
    };
  };

  // 배치표의 모든 칸 (월드 좌표의 사각 틀)
  App.layoutFrames = () => {
    if (!S.layout || !S.layout.cells.length) return [];
    const { w, h } = App.layoutCellSize();
    const off = S.layout.offset || { row: 0, col: 0 };
    return S.layout.cells.map((c) => ({ no: c.no, x: (c.col - off.col) * w, y: (c.row - off.row) * h, w, h }));
  };

  App.arrangeByLayout = () => {
    const frames = App.layoutFrames();
    if (!frames.length) return false;
    const { w, h } = App.layoutCellSize();
    const byNo = new Map(frames.map((f) => [f.no, f]));
    const maxY = Math.max(...frames.map((f) => f.y + f.h));
    let extra = 0;
    for (const s of App.mapSheets()) {
      const f = byNo.get(App.sheetNumber(s));
      if (!s.frame) s.transform.rotation = 0;
      if (f) {
        App.placeAt(s, f.x + w / 2, f.y + h / 2);
      } else {
        // 배치표에 없는 원도는 아래쪽에 한 줄로
        App.placeAt(s, extra * w * 1.05 + w / 2, maxY + h * 0.4 + h / 2);
        extra++;
      }
    }
    return true;
  };

  /* ---------- 이벤트 ---------- */
  App.initLayout = () => {
    canvas = $('layout-canvas2');
    ctx = canvas.getContext('2d');
    new ResizeObserver(() => $('layout-dialog').open && render()).observe(canvas.parentElement);

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const pan = e.button !== 0 || mode === 'edit' || mode === 'sequence';
      drag = { sx, sy, ox: lv.ox, oy: lv.oy, moved: false, pan, start: toImg(sx, sy) };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (Math.hypot(sx - drag.sx, sy - drag.sy) > 4) drag.moved = true;
      if (!drag.moved) return;
      if (drag.pan || (e.buttons & 6)) {
        lv.ox = drag.ox + sx - drag.sx;
        lv.oy = drag.oy + sy - drag.sy;
      } else {
        const [x, y] = toImg(sx, sy);
        draft = { x: Math.min(x, drag.start[0]), y: Math.min(y, drag.start[1]), w: Math.abs(x - drag.start[0]), h: Math.abs(y - drag.start[1]) };
      }
      render();
    });
    canvas.addEventListener('pointerup', async (e) => {
      const d = drag;
      drag = null;
      if (!d) return;
      const r = canvas.getBoundingClientRect();
      const [x, y] = toImg(e.clientX - r.left, e.clientY - r.top);
      if (draft && draft.w > 4 && draft.h > 4) {
        const box = draft;
        draft = null;
        if (mode === 'region') await runDetect(box);
        else if (mode === 'cell') await regridFromCell(box);
        return;
      }
      draft = null;
      if (!d.moved && (mode === 'edit' || mode === 'sequence') && e.button === 0) clickCell(cellAt(x, y));
      else render();
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const [ix, iy] = toImg(sx, sy);
      lv.zoom = App.clamp(lv.zoom * Math.exp(-e.deltaY * 0.0015), 0.02, 30);
      lv.ox = sx - ix * lv.zoom;
      lv.oy = sy - iy * lv.zoom;
      render();
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    $('layout-dialog').addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); removeSelected(); }
    });
    document.querySelectorAll('[name="lay-mode"]').forEach((el) => el.addEventListener('change', () => setMode(el.value)));
    $('lay-fit').addEventListener('click', () => { fit(); render(); });
    $('lay-cancel').addEventListener('click', () => $('layout-dialog').close());
    $('lay-apply').addEventListener('click', () => applyLayout(false));
    $('lay-apply-arrange').addEventListener('click', () => applyLayout(true));
    $('lay-renumber').addEventListener('click', () => {
      if (!work) return;
      work.order = $('lay-order').value;
      work.cells = numberCells(work.cells, work.order);
      render();
    });
    $('lay-total').addEventListener('change', () => {
      const v = parseInt($('lay-total').value, 10);
      if (work && v > 0) { work.total = v; render(); }
    });
    $('lay-redetect').addEventListener('click', () => {
      if (work && work.region) runDetect(work.region);
      else setMode('region');
    });
    $('lay-clear').addEventListener('click', () => { if (work) { work.cells = []; selected = null; render(); } });
    const dims = (dc, dr) => { if (!work) return; work.cols = Math.max(1, work.cols + dc); work.rows = Math.max(1, work.rows + dr); work.cells = work.cells.filter((c) => c.col < work.cols && c.row < work.rows); render(); };
    $('lay-cols').addEventListener('change', () => dims(parseInt($('lay-cols').value, 10) - work.cols, 0));
    $('lay-rows').addEventListener('change', () => dims(0, parseInt($('lay-rows').value, 10) - work.rows));
    // 격자 전체를 한 칸 단위로 늘리거나(왼쪽·위로) 0번 px 단위로 밀기
    document.querySelectorAll('[data-lay-shift]').forEach((b) => b.addEventListener('click', () => {
      if (!work) return;
      const [dx, dy] = b.dataset.layShift.split(',').map(Number);
      const step = Math.max(1, 1 / lv.zoom);
      work.x0 += dx * step;
      work.y0 += dy * step;
      render();
    }));
    document.querySelectorAll('[data-lay-grow]').forEach((b) => b.addEventListener('click', () => {
      if (!work) return;
      const side = b.dataset.layGrow;
      if (side === 'left') { work.x0 -= work.cw; work.cols++; work.cells.forEach((c) => c.col++); }
      if (side === 'top') { work.y0 -= work.ch; work.rows++; work.cells.forEach((c) => c.row++); }
      if (side === 'right') work.cols++;
      if (side === 'bottom') work.rows++;
      if (selected) { if (side === 'left') selected.col++; if (side === 'top') selected.row++; }
      render();
    }));
    $('lay-sel-no').addEventListener('change', () => {
      const c = selected && findCell(selected.row, selected.col);
      const v = parseInt($('lay-sel-no').value, 10);
      if (!c || !(v > 0) || v === c.no) return;
      // 이미 다른 칸에 있는 번호면 두 칸의 번호를 맞바꿈
      const other = work.cells.find((x) => x !== c && x.no === v);
      if (other) other.no = c.no;
      c.no = v;
      render();
    });
    $('lay-sel-remove').addEventListener('click', removeSelected);
    $('btn-layout-detect').addEventListener('click', App.openLayoutDialog);
  };
})(window.App);
