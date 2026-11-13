/* 2차: 도곽(빨간 테두리) 네 모서리 지정 → 자르기·회전·배율 자동 계산 */
(function (App) {
  'use strict';
  const S = App.state;
  const $ = (id) => document.getElementById(id);

  const CORNER_NAMES = ['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래'];

  /* ---------- 계산 ---------- */

  // 도곽 중심의 도면 내부 좌표 (자르기 중심 기준, 배율 적용 전)
  App.frameCenterLocal = (s) => {
    if (!s.frame || App.isRectified(s)) return [0, 0]; // 펴진 이미지는 도곽 중심 = 이미지 중심
    const { w, h } = App.cropSize(s);
    const c = s.frame.corners;
    const cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4;
    const cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
    return [cx - (s.crop.left + w / 2), cy - (s.crop.top + h / 2)];
  };

  function localToWorld(t, [lx, ly]) {
    const r = (t.rotation * Math.PI) / 180;
    return [
      t.x + (lx * Math.cos(r) - ly * Math.sin(r)) * t.scale,
      t.y + (lx * Math.sin(r) + ly * Math.cos(r)) * t.scale,
    ];
  }

  // 도곽 중심(도곽이 없으면 자르기 중심)이 월드 (X, Y)에 오도록 이동
  App.placeAt = (s, X, Y) => {
    const t = s.transform;
    const [wx, wy] = localToWorld({ ...t, x: 0, y: 0 }, App.frameCenterLocal(s));
    t.x = X - wx;
    t.y = Y - wy;
  };

  App.frameAnchor = (s) => localToWorld(s.transform, App.frameCenterLocal(s));

  // 네 모서리 → 기울기(도, 시계 방향 +), 가로·세로 길이, 중심
  App.frameMetrics = (c) => {
    const [tl, tr, br, bl] = c;
    const deg = (a) => (a * 180) / Math.PI;
    const angles = [
      deg(Math.atan2(tr[1] - tl[1], tr[0] - tl[0])),
      deg(Math.atan2(br[1] - bl[1], br[0] - bl[0])),
      deg(Math.atan2(-(bl[0] - tl[0]), bl[1] - tl[1])),
      deg(Math.atan2(-(br[0] - tr[0]), br[1] - tr[1])),
    ];
    const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    return {
      angle: angles.reduce((a, b) => a + b, 0) / 4,
      angles,
      w: (len(tl, tr) + len(bl, br)) / 2,
      h: (len(tl, bl) + len(tr, br)) / 2,
      center: [(tl[0] + tr[0] + br[0] + bl[0]) / 4, (tl[1] + tr[1] + br[1] + bl[1]) / 4],
    };
  };

  // 도곽을 적용: 자르기 = 도곽을 감싸는 사각형, 회전 = 기울기 보정, 배율 = 기준 도곽 크기에 맞춤
  // rectify: 네 모서리를 직사각형으로 펴서 네 변을 모두 수직·수평으로 (기본). false면 평균 기울기만큼 회전
  App.applyFrame = (s, corners, rectify = App.rectifyDefault !== false) => {
    const m = App.frameMetrics(corners);
    const keepAt = App.frameAnchor(s); // 도곽 중심이 지금 자리에 그대로 오도록

    let setRef = false;
    if (!S.frameSize) {
      S.frameSize = { w: Math.round(m.w), h: Math.round(m.h) };
      setRef = true;
    }
    const scale = (S.frameSize.w / m.w + S.frameSize.h / m.h) / 2;

    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    s.crop = {
      left: App.clamp(Math.floor(Math.min(...xs)), 0, s.w - 2),
      top: App.clamp(Math.floor(Math.min(...ys)), 0, s.h - 2),
      right: App.clamp(s.w - Math.ceil(Math.max(...xs)), 0, s.w - 2),
      bottom: App.clamp(s.h - Math.ceil(Math.max(...ys)), 0, s.h - 2),
    };
    s.frame = { corners: corners.map((c) => c.slice()), clip: true, rectify: !!rectify };
    s._rect = null;
    s.transform.rotation = rectify ? 0 : App.round(-m.angle, 3);
    s.transform.scale = App.round(scale, 5);

    App.placeAt(s, keepAt[0], keepAt[1]);
    return { metrics: m, scale, setRef };
  };

  /* ---------- 빨간 선에 맞추기 ---------- */
  // 모서리 근처에는 빨간 좌표 숫자(+200, 0 등)가 있어 헷갈리므로,
  // 모서리에서 안쪽으로 길게 뻗은 도곽선 구간의 붉은 정도(R-G)를 합산해 선의 위치를 찾는다.
  async function readRegion(s, sx, sy, sw, sh) {
    sx = Math.round(App.clamp(sx, 0, s.w - 1));
    sy = Math.round(App.clamp(sy, 0, s.h - 1));
    sw = Math.round(Math.min(sw, s.w - sx));
    sh = Math.round(Math.min(sh, s.h - sy));
    if (sw < 3 || sh < 3) return null;
    const bmp = await createImageBitmap(s.file, sx, sy, sw, sh);
    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    const d = ctx.getImageData(0, 0, sw, sh).data;
    const red = new Float32Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) red[i] = d[i * 4] - d[i * 4 + 1];
    const sorted = Float32Array.from(red).sort();
    const base = sorted[Math.floor(sorted.length / 2)];
    for (let i = 0; i < red.length; i++) red[i] = Math.max(0, red[i] - base - 3);
    return { sx, sy, sw, sh, red };
  }

  // axis 'h': 가로선 → 행별 합, 'v': 세로선 → 열별 합. 돌려주는 값은 원본 좌표
  function linePeak(g, axis) {
    const n = axis === 'h' ? g.sh : g.sw;
    const prof = new Float32Array(n);
    for (let j = 0; j < g.sh; j++) for (let i = 0; i < g.sw; i++) prof[axis === 'h' ? j : i] += g.red[j * g.sw + i];
    let bi = 0;
    for (let i = 1; i < n; i++) if (prof[i] > prof[bi]) bi = i;
    const sorted = Float32Array.from(prof).sort();
    const med = sorted[Math.floor(n / 2)] + 1e-3;
    return { pos: (axis === 'h' ? g.sy : g.sx) + bi, strength: prof[bi] / med };
  }

  // corner: 0 왼위, 1 오위, 2 오아, 3 왼아
  App.snapCorner = async (s, x, y, corner) => {
    const big = Math.max(s.w, s.h);
    const r = Math.round(Math.max(30, big * 0.015)); // 찾는 범위(±px)
    const skip = Math.round(Math.max(40, big * 0.025)); // 모서리 숫자를 피하는 거리
    const len = Math.round(Math.min(s.w, s.h) * 0.3); // 선을 따라 합산할 길이
    const right = corner === 1 || corner === 2;
    const bottom = corner === 2 || corner === 3;
    try {
      const hx = right ? x - skip - len : x + skip;
      const vy = bottom ? y - skip - len : y + skip;
      const gh = await readRegion(s, hx, y - r, len, 2 * r + 1);
      const gv = await readRegion(s, x - r, vy, 2 * r + 1, len);
      const ph = gh && linePeak(gh, 'h');
      const pv = gv && linePeak(gv, 'v');
      // 실제 원도 시험: 뚜렷한 도곽선은 강도 9 이상, 잡음은 7 이하 → 8 미만이면 클릭한 자리 유지
      const ny = ph && ph.strength >= 8 ? ph.pos : y;
      const nx = pv && pv.strength >= 8 ? pv.pos : x;
      return { x: nx, y: ny, snapped: nx !== x && ny !== y, partial: (nx !== x) !== (ny !== y), strength: [ph && ph.strength, pv && pv.strength] };
    } catch (e) {
      return { x, y, snapped: false };
    }
  };

  /* ---------- 도곽 지정 창 ---------- */
  const fv = { zoom: 1, ox: 0, oy: 0 };
  App.frameView = fv; // 시험용으로 노출
  let sheet = null, pts = [], snapInfo = [];
  let canvas, ctx, drag = null;

  App.openFrameDialog = (s) => {
    if (!s || S.sheets.indexOf(s) < 1) return App.toast('연결 화면에서 도면을 먼저 선택하세요.');
    sheet = s;
    pts = s.frame ? s.frame.corners.map((c) => c.slice()) : [];
    snapInfo = pts.map(() => false);
    $('frame-preview').checked = false;
    $('frame-rectify').checked = sheet.frame ? sheet.frame.rectify !== false : true;
    $('frame-dialog').showModal();
    requestAnimationFrame(() => { fitFrame(); render(); });
  };

  function fitFrame() {
    const r = canvas.parentElement.getBoundingClientRect();
    const k = Math.min(r.width / sheet.w, r.height / sheet.h) * 0.96;
    fv.zoom = k;
    fv.ox = (r.width - sheet.w * k) / 2;
    fv.oy = (r.height - sheet.h * k) / 2;
  }

  // 지정할 모서리 근처를 확대
  function focusCorner(i) {
    const r = canvas.parentElement.getBoundingClientRect();
    const guess = [[0.12, 0.13], [0.88, 0.13], [0.88, 0.87], [0.12, 0.87]][i];
    let gx = sheet.w * guess[0], gy = sheet.h * guess[1];
    if (pts.length >= 2 && i === 2) { gx = pts[1][0]; gy = pts[0][1] + (sheet.h * 0.74); }
    if (pts.length >= 3 && i === 3) { gx = pts[0][0]; gy = pts[2][1]; }
    const k = Math.min(r.width, r.height) / (Math.max(sheet.w, sheet.h) * 0.3);
    fv.zoom = k;
    fv.ox = r.width / 2 - gx * k;
    fv.oy = r.height / 2 - gy * k;
  }

  const toImg = (sx, sy) => [(sx - fv.ox) / fv.zoom, (sy - fv.oy) / fv.zoom];
  const toScr = (x, y) => [x * fv.zoom + fv.ox, y * fv.zoom + fv.oy];

  let previewCache = null;
  function render() {
    if (!sheet) return;
    const wrap = canvas.parentElement.getBoundingClientRect();
    const d = window.devicePixelRatio || 1;
    canvas.width = Math.round(wrap.width * d);
    canvas.height = Math.round(wrap.height * d);
    canvas.style.width = wrap.width + 'px';
    canvas.style.height = wrap.height + 'px';
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.fillStyle = '#3a403e';
    ctx.fillRect(0, 0, wrap.width, wrap.height);
    const k = sheet.preview.width / sheet.w;

    // 펴진 모습 보기: 네 모서리를 지정했으면 편 결과를 화면에 맞춰 보여 줌 (수직·수평 확인용 격자 포함)
    if (pts.length === 4 && $('frame-preview').checked) {
      const m = App.frameMetrics(pts);
      const key = JSON.stringify(pts) + $('frame-rectify').checked;
      if (!previewCache || previewCache.key !== key) {
        let img;
        if ($('frame-rectify').checked) img = App.warpQuad(sheet.preview, k, pts, m.w, m.h);
        else {
          // 회전만: 평균 기울기만큼 돌린 결과
          img = document.createElement('canvas');
          img.width = Math.round(m.w * k); img.height = Math.round(m.h * k);
          const g = img.getContext('2d');
          g.translate(img.width / 2, img.height / 2);
          g.rotate((-m.angle * Math.PI) / 180);
          g.drawImage(sheet.preview, -m.center[0] * k, -m.center[1] * k);
        }
        previewCache = { key, img };
      }
      const img = previewCache.img;
      const z = Math.min(wrap.width / img.width, wrap.height / img.height) * 0.94;
      const x0 = (wrap.width - img.width * z) / 2, y0 = (wrap.height - img.height * z) / 2;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, x0, y0, img.width * z, img.height * z);
      ctx.strokeStyle = 'rgba(25,179,166,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 8; i++) {
        const gx = Math.round(x0 + (img.width * z * i) / 8) + 0.5, gy = Math.round(y0 + (img.height * z * i) / 8) + 0.5;
        ctx.moveTo(gx, y0); ctx.lineTo(gx, y0 + img.height * z);
        ctx.moveTo(x0, gy); ctx.lineTo(x0 + img.width * z, gy);
      }
      ctx.stroke();
      $('frame-info').textContent = '펴진 모습입니다. 초록 격자와 도곽선이 나란한지 확인하세요. [펴진 모습 보기]를 끄면 모서리를 고칠 수 있습니다.';
      $('frame-apply').disabled = false;
      $('frame-apply-next').disabled = false;
      $('frame-clear').disabled = false;
      return;
    }
    ctx.setTransform(d * fv.zoom / k, 0, 0, d * fv.zoom / k, d * fv.ox, d * fv.oy);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sheet.preview, 0, 0);
    ctx.setTransform(d, 0, 0, d, 0, 0);

    if (pts.length > 1) {
      ctx.strokeStyle = '#19b3a6';
      ctx.lineWidth = 2;
      ctx.setLineDash(pts.length < 4 ? [6, 4] : []);
      ctx.beginPath();
      pts.forEach(([x, y], i) => { const [a, b] = toScr(x, y); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
      if (pts.length === 4) ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    pts.forEach(([x, y], i) => {
      const [a, b] = toScr(x, y);
      ctx.strokeStyle = snapInfo[i] ? '#19b3a6' : '#f3b23a';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a - 14, b); ctx.lineTo(a + 14, b); ctx.moveTo(a, b - 14); ctx.lineTo(a, b + 14); ctx.stroke();
      ctx.beginPath(); ctx.arc(a, b, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(String(i + 1), a + 9, b - 9);
    });

    // 안내
    const next = pts.length;
    document.querySelectorAll('.corner-step').forEach((el, i) => {
      el.classList.toggle('is-done', i < next);
      el.classList.toggle('is-current', i === next);
    });
    $('frame-sheet').textContent = `${App.newName(sheet)}${sheet.sheetNo ? ' · 도면 ' + sheet.sheetNo : ''}`;
    const info = $('frame-info');
    if (pts.length === 4) {
      const m = App.frameMetrics(pts);
      const ref = S.frameSize;
      const sc = ref ? (ref.w / m.w + ref.h / m.h) / 2 : 1;
      const skew = Math.max(...m.angles) - Math.min(...m.angles);
      const loose = snapInfo.filter((v) => !v).length;
      info.innerHTML = (loose && $('frame-snap').checked ? `<b class="warn">주황 표시 ${loose}곳은 빨간 선을 찾지 못해 클릭한 자리 그대로입니다. 확대해서 확인하세요.</b> ` : '') + `도곽 ${Math.round(m.w).toLocaleString()} × ${Math.round(m.h).toLocaleString()}px · 기울기 ${App.round(m.angle, 2)}° · 배율 ${App.round(sc * 100, 2)}%`
        + (skew > 0.6 ? ' · <b class="warn">네 변의 기울기 차이가 큽니다. 모서리를 확인하세요.</b>' : '');
      $('frame-apply').disabled = false;
      $('frame-apply-next').disabled = false;
    } else {
      info.textContent = `${CORNER_NAMES[next]} 모서리를 클릭하세요. (휠: 확대 · 끌기: 이동 · Backspace: 하나 지우기)`;
      $('frame-apply').disabled = true;
      $('frame-apply-next').disabled = true;
    }
    $('frame-clear').disabled = pts.length === 0;
  }

  function hitPoint(sx, sy) {
    for (let i = pts.length - 1; i >= 0; i--) {
      const [a, b] = toScr(...pts[i]);
      if (Math.hypot(sx - a, sy - b) <= 10) return i;
    }
    return -1;
  }

  async function addOrMove(i, x, y) {
    x = App.clamp(x, 0, sheet.w - 1);
    y = App.clamp(y, 0, sheet.h - 1);
    let snapped = false;
    if ($('frame-snap').checked) {
      const r = await App.snapCorner(sheet, x, y, i < 0 ? pts.length : i);
      x = r.x; y = r.y; snapped = r.snapped;
    }
    if (i < 0) { pts.push([x, y]); snapInfo.push(snapped); }
    else { pts[i] = [x, y]; snapInfo[i] = snapped; }
    if (i < 0 && pts.length < 4 && $('frame-autozoom').checked) focusCorner(pts.length);
    else if (i < 0 && pts.length === 4 && $('frame-autozoom').checked) fitFrame();
    if (i < 0 && pts.length === 4) $('frame-preview').checked = true; // 네 점을 다 찍으면 펴진 모습을 바로 보여 줌
    render();
  }

  function sheetsToFrame() { return App.mapSheets(); }

  function apply(next) {
    App.checkpoint();
    const r = App.applyFrame(sheet, pts, $('frame-rectify').checked);
    App.logOp('frame');
    App.autosave();
    App.emit('change');
    const sc = App.round(r.scale * 100, 2);
    App.status(r.setRef
      ? `기준 도곽을 ${S.frameSize.w}×${S.frameSize.h}px로 정했습니다 (${App.newName(sheet)}). 다른 도면은 이 크기에 맞춰집니다.`
      : `${App.newName(sheet)} 도곽 적용 · 회전 ${sheet.transform.rotation}° · 배율 ${sc}%`);
    if (next) {
      const list = sheetsToFrame();
      const rest = list.slice(list.indexOf(sheet) + 1).concat(list.slice(0, list.indexOf(sheet)));
      const n = rest.find((x) => !x.frame || (x.frame.auto && x.frame.auto.review));
      if (n) {
        S.selectedId = n.id;
        App.emit('select');
        return App.openFrameDialog(n);
      }
      App.toast('모든 도면의 도곽을 지정했습니다.');
    }
    $('frame-dialog').close();
    App.fitView();
  }

  App.initFrame = () => {
    canvas = $('frame-canvas');
    ctx = canvas.getContext('2d');
    new ResizeObserver(() => sheet && render()).observe(canvas.parentElement);

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const hit = hitPoint(sx, sy);
      drag = { sx, sy, ox: fv.ox, oy: fv.oy, hit, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (!drag) {
        canvas.style.cursor = hitPoint(sx, sy) >= 0 ? 'move' : pts.length < 4 ? 'crosshair' : 'grab';
        return;
      }
      if (Math.hypot(sx - drag.sx, sy - drag.sy) > 4) drag.moved = true;
      if (!drag.moved) return;
      if (drag.hit >= 0) {
        pts[drag.hit] = toImg(sx, sy);
        snapInfo[drag.hit] = false;
      } else {
        fv.ox = drag.ox + sx - drag.sx;
        fv.oy = drag.oy + sy - drag.sy;
      }
      render();
    });
    canvas.addEventListener('pointerup', async (e) => {
      const d = drag;
      drag = null;
      if (!d) return;
      const r = canvas.getBoundingClientRect();
      const [x, y] = toImg(e.clientX - r.left, e.clientY - r.top);
      if (d.hit >= 0 && d.moved) await addOrMove(d.hit, x, y);
      else if (!d.moved && d.hit < 0 && pts.length < 4) await addOrMove(-1, x, y);
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const [ix, iy] = toImg(sx, sy);
      fv.zoom = App.clamp(fv.zoom * Math.exp(-e.deltaY * 0.0015), 0.02, 20);
      fv.ox = sx - ix * fv.zoom;
      fv.oy = sy - iy * fv.zoom;
      render();
    }, { passive: false });

    $('frame-dialog').addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && pts.length && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        pts.pop(); snapInfo.pop();
        render();
      }
    });
    $('frame-dialog').addEventListener('close', () => { sheet = null; });
    $('frame-preview').addEventListener('change', render);
    $('frame-rectify').addEventListener('change', render);
    $('frame-clear').addEventListener('click', () => { pts = []; snapInfo = []; fitFrame(); render(); });
    $('frame-fit').addEventListener('click', () => { fitFrame(); render(); });
    $('frame-cancel').addEventListener('click', () => $('frame-dialog').close());
    $('frame-apply').addEventListener('click', () => apply(false));
    $('frame-apply-next').addEventListener('click', () => apply(true));

    $('btn-frame').addEventListener('click', () => App.openFrameDialog(App.selected()));
    $('btn-frame-all').addEventListener('click', () => App.runAutoFrame({ all: false }));
    // 도곽 수정: 확인이 필요한(또는 아직 없는) 도면부터 차례로 열기
    $('btn-frame-review').addEventListener('click', () => {
      const first = App.mapSheets().find((x) => !x.frame || (x.frame.auto && x.frame.auto.review)) || App.selected() || App.mapSheets()[0];
      if (!first) return App.toast('먼저 원도를 불러오세요.');
      S.selectedId = first.id;
      App.emit('select');
      App.openFrameDialog(first);
    });
    $('btn-frame-remove').addEventListener('click', () => App.editSelected('frame', (s) => {
      const at = App.frameAnchor(s);
      s.frame = null;
      App.placeAt(s, at[0], at[1]);
    }));
    $('f-clip').addEventListener('change', (e) => App.editSelected('display', (s) => { if (s.frame) s.frame.clip = e.target.checked; }));
    $('btn-frame-ref').addEventListener('click', () => {
      const s = App.selected();
      if (!s || !s.frame) return;
      App.checkpoint();
      const m = App.frameMetrics(s.frame.corners);
      S.frameSize = { w: Math.round(m.w), h: Math.round(m.h) };
      // 모든 도곽 도면의 배율을 새 기준으로 다시 계산 (도곽 중심은 칸에 맞춰 유지)
      for (const x of App.mapSheets().filter((x) => x.frame)) {
        const at = App.frameAnchor(x);
        const mm = App.frameMetrics(x.frame.corners);
        x.transform.scale = App.round((S.frameSize.w / mm.w + S.frameSize.h / mm.h) / 2, 5);
        App.placeAt(x, at[0], at[1]);
      }
      App.logOp('frame');
      App.emit('change');
      App.status(`기준 도곽을 ${S.frameSize.w}×${S.frameSize.h}px(${App.newName(s)})로 바꿨습니다.`);
    });
  };

  App.renderFramePanel = (s) => {
    const has = !!(s && s.frame);
    $('frame-state').textContent = has
      ? (() => {
        const m = App.frameMetrics(s.frame.corners);
        const how = s.frame.auto ? (s.frame.auto.review ? `⚠ 자동 지정 · 확인 필요 (${s.frame.auto.reason || '점수 낮음'})` : '자동 지정') : '직접 지정';
        return `${how} · ${Math.round(m.w)}×${Math.round(m.h)}px · 기울기 ${App.round(m.angle, 2)}°`;
      })()
      : '아직 지정하지 않음';
    $('frame-ref').textContent = S.frameSize ? `기준 도곽 ${S.frameSize.w}×${S.frameSize.h}px` : '기준 도곽: 처음 지정하는 도곽으로 정해짐';
    $('btn-frame').textContent = has ? '도곽 다시 지정' : '도곽 모서리 지정';
    $('btn-frame-remove').hidden = !has;
    $('btn-frame-ref').hidden = !has;
    $('f-clip-row').hidden = !has;
    $('f-clip').checked = has && s.frame.clip;
  };
})(window.App);
