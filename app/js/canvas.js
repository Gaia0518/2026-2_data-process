/* 8~9단계: 연결 화면 — 자동 배열, 이동·회전·배율, 곱하기 표시 */
(function (App) {
  'use strict';
  const S = App.state;

  const view = (App.view = { zoom: 0.2, ox: 40, oy: 40 });
  let canvas, ctx, dpr = 1;
  let showLabels = true;
  let needsDraw = false;

  const HANDLE = 9; // 모서리 손잡이 크기(px)
  const ROT_ARM = 30; // 회전 손잡이 길이(px)

  /* ---------- 좌표 변환 ---------- */
  const toScreen = (x, y) => [x * view.zoom + view.ox, y * view.zoom + view.oy];
  const toWorld = (x, y) => [(x - view.ox) / view.zoom, (y - view.oy) / view.zoom];

  // 월드 좌표 → 도면 내부 좌표(자르기 후 중심 기준, 배율 적용 전)
  function toLocal(s, wx, wy) {
    const t = s.transform;
    const r = (-t.rotation * Math.PI) / 180;
    const dx = wx - t.x, dy = wy - t.y;
    return [(dx * Math.cos(r) - dy * Math.sin(r)) / t.scale, (dx * Math.sin(r) + dy * Math.cos(r)) / t.scale];
  }

  function hitSheet(wx, wy) {
    for (let i = S.zOrder.length - 1; i >= 0; i--) {
      const s = App.byId(S.zOrder[i]);
      if (!s || !s.display.visible) continue;
      const [lx, ly] = toLocal(s, wx, wy);
      const { w, h } = App.cropSize(s);
      if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2) return s;
    }
    return null;
  }

  function handlePoints(s) {
    const pts = App.corners(s).map(([x, y]) => toScreen(x, y));
    const topMid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    const r = (s.transform.rotation * Math.PI) / 180;
    const up = [Math.sin(r), -Math.cos(r)];
    const rot = [topMid[0] + up[0] * ROT_ARM, topMid[1] + up[1] * ROT_ARM];
    return { pts, topMid, rot };
  }

  function hitHandle(s, sx, sy) {
    if (!s) return null;
    const { pts, rot } = handlePoints(s);
    if (Math.hypot(sx - rot[0], sy - rot[1]) <= 9) return { type: 'rotate' };
    for (let i = 0; i < 4; i++) {
      if (Math.abs(sx - pts[i][0]) <= HANDLE && Math.abs(sy - pts[i][1]) <= HANDLE) return { type: 'scale', corner: i };
    }
    return null;
  }

  /* ---------- 그리기 ---------- */
  App.requestDraw = () => {
    if (needsDraw) return;
    needsDraw = true;
    requestAnimationFrame(draw);
  };

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    App.requestDraw();
  }

  function drawGrid(W, H) {
    // 화면 기준 모눈 (월드 단위 100/500/1000… 중 적당한 간격)
    const steps = [100, 250, 500, 1000, 2500, 5000];
    const step = steps.find((s) => s * view.zoom >= 24) || 10000;
    const [x0, y0] = toWorld(0, 0);
    const [x1, y1] = toWorld(W, H);
    ctx.lineWidth = 1;
    ctx.strokeStyle = getVar('--grid');
    ctx.beginPath();
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
      const sx = Math.round(x * view.zoom + view.ox) + 0.5;
      ctx.moveTo(sx, 0); ctx.lineTo(sx, H);
    }
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) {
      const sy = Math.round(y * view.zoom + view.oy) + 0.5;
      ctx.moveTo(0, sy); ctx.lineTo(W, sy);
    }
    ctx.stroke();
  }

  const cssCache = {};
  function getVar(name) {
    if (!cssCache[name]) cssCache[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return cssCache[name];
  }

  App.drawSheet = (c, s, img, imgScale) => {
    // c: 2D context (월드 좌표계로 설정된 상태), imgScale: 원본 px → img px 비율
    const t = s.transform;
    const { w, h } = App.cropSize(s);
    c.save();
    c.translate(t.x, t.y);
    c.rotate((t.rotation * Math.PI) / 180);
    c.scale(t.scale, t.scale);
    c.globalAlpha = s.display.opacity;
    c.globalCompositeOperation = s.display.blend === 'multiply' ? 'multiply' : 'source-over';
    if (s.frame && s.frame.clip) {
      // 도곽 바깥(여백)은 그리지 않음
      const ox = s.crop.left + w / 2, oy = s.crop.top + h / 2;
      c.beginPath();
      s.frame.corners.forEach(([x, y], i) => (i ? c.lineTo(x - ox, y - oy) : c.moveTo(x - ox, y - oy)));
      c.closePath();
      c.clip();
    }
    c.drawImage(img, s.crop.left * imgScale, s.crop.top * imgScale, w * imgScale, h * imgScale, -w / 2, -h / 2, w, h);
    c.restore();
  };

  function draw() {
    needsDraw = false;
    const W = canvas.width / dpr, H = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = getVar('--canvas-bg');
    ctx.fillRect(0, 0, W, H);
    drawGrid(W, H);

    ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.ox, dpr * view.oy);
    ctx.imageSmoothingQuality = 'high';
    for (const id of S.zOrder) {
      const s = App.byId(id);
      if (!s || !s.display.visible) continue;
      App.drawSheet(ctx, s, s.preview, s.preview.width / s.w);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    if (showLabels) {
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (const id of S.zOrder) {
        const s = App.byId(id);
        if (!s || !s.display.visible) continue;
        const [cx, cy] = toScreen(s.transform.x, s.transform.y);
        const idx = S.sheets.indexOf(s);
        const label = s.sheetNo ? `${idx} · ${s.sheetNo}` : String(idx);
        const tw = ctx.measureText(label).width + 14;
        ctx.fillStyle = s.id === S.selectedId ? getVar('--accent') : 'rgba(30,40,38,.72)';
        roundRect(ctx, cx - tw / 2, cy - 11, tw, 22, 11);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(label, cx, cy + 0.5);
      }
    }

    const sel = App.selected();
    if (sel && sel.display.visible && S.sheets.indexOf(sel) > 0) {
      const { pts, topMid, rot } = handlePoints(sel);
      ctx.strokeStyle = getVar('--accent');
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(topMid[0], topMid[1]);
      ctx.lineTo(rot[0], rot[1]);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      for (const [x, y] of pts) {
        ctx.fillRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
        ctx.strokeRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
      }
      ctx.beginPath();
      ctx.arc(rot[0], rot[1], 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    document.getElementById('zoom-label').textContent = `${Math.round(view.zoom * 100)}%`;
    document.getElementById('empty-center').hidden = App.mapSheets().length > 0;
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /* ---------- 보기 ---------- */
  App.zoomAt = (factor, sx, sy) => {
    const z = App.clamp(view.zoom * factor, 0.01, 8);
    const [wx, wy] = toWorld(sx, sy);
    view.zoom = z;
    view.ox = sx - wx * z;
    view.oy = sy - wy * z;
    App.requestDraw();
  };

  App.zoomBy = (factor) => {
    const r = canvas.getBoundingClientRect();
    App.zoomAt(factor, r.width / 2, r.height / 2);
  };

  App.fitView = () => {
    const sheets = App.mapSheets().filter((s) => s.display.visible);
    const b = App.bounds(sheets);
    if (!b) return App.requestDraw();
    const r = canvas.getBoundingClientRect();
    const pad = 48;
    view.zoom = App.clamp(Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2) / b.h), 0.01, 8);
    view.ox = (r.width - b.w * view.zoom) / 2 - b.minX * view.zoom;
    view.oy = (r.height - b.h * view.zoom) / 2 - b.minY * view.zoom;
    App.requestDraw();
  };

  App.focusSheet = (s) => {
    const r = canvas.getBoundingClientRect();
    const [sx, sy] = toScreen(s.transform.x, s.transform.y);
    if (sx < 0 || sy < 0 || sx > r.width || sy > r.height) {
      view.ox += r.width / 2 - sx;
      view.oy += r.height / 2 - sy;
    }
    App.requestDraw();
  };

  App.setLabels = (on) => { showLabels = on; App.requestDraw(); };

  /* ---------- 자동 배열 (1차: 파일 순서대로 격자 배치) ---------- */
  App.autoArrange = (subset) => {
    const all = App.mapSheets();
    if (!all.length) return;
    const colsInput = document.getElementById('arrange-cols');
    let cols = parseInt(colsInput.value, 10);
    if (!cols || cols < 1) {
      cols = Math.ceil(Math.sqrt(all.length));
      colsInput.value = cols;
    }
    // 도곽을 지정했으면 기준 도곽 크기를 칸 크기로, 아니면 가장 큰 도면 크기로
    const sizes = all.map((s) => App.cropSize(s));
    const cellW = S.frameSize ? S.frameSize.w : Math.max(...sizes.map((z, i) => z.w * all[i].transform.scale));
    const cellH = S.frameSize ? S.frameSize.h : Math.max(...sizes.map((z, i) => z.h * all[i].transform.scale));

    if (subset && subset.length) {
      // 나중에 추가한 원도는 기존 배치 오른쪽에 한 줄로
      const others = all.filter((s) => !subset.includes(s));
      const b = App.bounds(others);
      const x0 = b ? b.maxX + cellW * 0.6 : cellW / 2;
      const y0 = b ? b.minY + cellH / 2 : cellH / 2;
      subset.forEach((s, i) => App.placeAt(s, x0 + i * cellW, y0));
      return App.requestDraw();
    }

    all.forEach((s, i) => {
      const row = Math.floor(i / cols), col = i % cols;
      s.grid = { row, col };
      if (!s.frame) s.transform.rotation = 0;
      App.placeAt(s, col * cellW + cellW / 2, row * cellH + cellH / 2);
    });
    App.requestDraw();
  };

  /* ---------- 마우스·터치 조작 ---------- */
  let drag = null;
  let spaceDown = false;

  function onPointerDown(e) {
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [wx, wy] = toWorld(sx, sy);

    if (e.button === 1 || e.button === 2 || spaceDown) {
      drag = { mode: 'pan', sx, sy, ox: view.ox, oy: view.oy };
      return;
    }
    const sel = App.selected();
    const h = sel && S.sheets.indexOf(sel) > 0 ? hitHandle(sel, sx, sy) : null;
    if (h) {
      const t = sel.transform;
      const [cx, cy] = toScreen(t.x, t.y);
      drag = {
        mode: h.type, sheet: sel, start: { ...t }, changed: false,
        a0: Math.atan2(sy - cy, sx - cx), d0: Math.hypot(sx - cx, sy - cy), cx, cy,
      };
      return;
    }
    const hit = hitSheet(wx, wy);
    if (hit) {
      if (S.selectedId !== hit.id) {
        S.selectedId = hit.id;
        App.emit('select');
      }
      drag = { mode: 'move', sheet: hit, sx, sy, start: { ...hit.transform }, changed: false };
    } else {
      if (S.selectedId !== null) {
        S.selectedId = null;
        App.emit('select');
      }
      drag = { mode: 'pan', sx, sy, ox: view.ox, oy: view.oy };
    }
    App.requestDraw();
  }

  function onPointerMove(e) {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (!drag) {
      const sel = App.selected();
      const h = sel && S.sheets.indexOf(sel) > 0 ? hitHandle(sel, sx, sy) : null;
      canvas.style.cursor = spaceDown ? 'grab'
        : h ? (h.type === 'rotate' ? 'alias' : 'nwse-resize')
        : hitSheet(...toWorld(sx, sy)) ? 'move' : 'default';
      return;
    }
    if (drag.mode === 'pan') {
      view.ox = drag.ox + (sx - drag.sx);
      view.oy = drag.oy + (sy - drag.sy);
      canvas.style.cursor = 'grabbing';
      return App.requestDraw();
    }
    const s = drag.sheet;
    if (!drag.changed) {
      App.checkpoint();
      drag.changed = true;
    }
    const t = s.transform;
    if (drag.mode === 'move') {
      t.x = drag.start.x + (sx - drag.sx) / view.zoom;
      t.y = drag.start.y + (sy - drag.sy) / view.zoom;
    } else if (drag.mode === 'rotate') {
      let deg = drag.start.rotation + ((Math.atan2(sy - drag.cy, sx - drag.cx) - drag.a0) * 180) / Math.PI;
      deg = ((deg + 540) % 360) - 180;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      else if (!e.altKey) deg = Math.round(deg * 10) / 10;
      t.rotation = deg;
    } else if (drag.mode === 'scale') {
      const d = Math.hypot(sx - drag.cx, sy - drag.cy);
      t.scale = App.clamp(drag.start.scale * (d / Math.max(1, drag.d0)), 0.05, 20);
    }
    App.renderPanel();
    App.requestDraw();
  }

  function onPointerUp(e) {
    if (drag && drag.changed) {
      App.logOp(drag.mode);
      App.autosave();
    }
    drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* 이미 해제됨 */ }
    canvas.style.cursor = 'default';
  }

  function onWheel(e) {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      App.zoomAt(k, sx, sy);
    } else {
      view.ox -= e.deltaX || e.deltaY;
      App.requestDraw();
    }
  }

  App.initCanvas = () => {
    canvas = document.getElementById('board');
    ctx = canvas.getContext('2d');
    new ResizeObserver(resize).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && e.target === canvas) { spaceDown = true; e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
    resize();
  };

  /* ---------- 0번 배치도 보기 창 ---------- */
  const lv = { zoom: 1, ox: 0, oy: 0 };
  let lvCanvas, lvCtx;

  App.showLayoutViewer = (show) => {
    const panel = document.getElementById('layout-viewer');
    const layout = App.layoutSheet();
    panel.hidden = !show || !layout;
    document.getElementById('btn-layout').setAttribute('aria-pressed', String(!panel.hidden));
    if (!panel.hidden) {
      fitLayout();
      drawLayout();
    }
  };

  function fitLayout() {
    const layout = App.layoutSheet();
    if (!layout) return;
    const r = lvCanvas.parentElement.getBoundingClientRect();
    lv.zoom = Math.min(r.width / layout.preview.width, r.height / layout.preview.height);
    lv.ox = (r.width - layout.preview.width * lv.zoom) / 2;
    lv.oy = (r.height - layout.preview.height * lv.zoom) / 2;
  }

  function drawLayout() {
    const layout = App.layoutSheet();
    const panel = document.getElementById('layout-viewer');
    if (!layout || panel.hidden) return;
    const r = lvCanvas.parentElement.getBoundingClientRect();
    const d = window.devicePixelRatio || 1;
    lvCanvas.width = Math.round(r.width * d);
    lvCanvas.height = Math.round(r.height * d);
    lvCanvas.style.width = r.width + 'px';
    lvCanvas.style.height = r.height + 'px';
    lvCtx.setTransform(d, 0, 0, d, 0, 0);
    lvCtx.fillStyle = getVar('--canvas-bg');
    lvCtx.fillRect(0, 0, r.width, r.height);
    lvCtx.setTransform(d * lv.zoom, 0, 0, d * lv.zoom, d * lv.ox, d * lv.oy);
    lvCtx.imageSmoothingQuality = 'high';
    lvCtx.drawImage(layout.preview, 0, 0);
    document.getElementById('layout-title').textContent = App.newName(layout);
  }
  App.drawLayout = drawLayout;

  App.initLayoutViewer = () => {
    lvCanvas = document.getElementById('layout-canvas');
    lvCtx = lvCanvas.getContext('2d');
    let d = null;
    lvCanvas.addEventListener('pointerdown', (e) => {
      lvCanvas.setPointerCapture(e.pointerId);
      d = { x: e.clientX, y: e.clientY, ox: lv.ox, oy: lv.oy };
    });
    lvCanvas.addEventListener('pointermove', (e) => {
      if (!d) return;
      lv.ox = d.ox + e.clientX - d.x;
      lv.oy = d.oy + e.clientY - d.y;
      drawLayout();
    });
    lvCanvas.addEventListener('pointerup', () => (d = null));
    lvCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = lvCanvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const k = Math.exp(-e.deltaY * 0.0015);
      const z = App.clamp(lv.zoom * k, 0.05, 10);
      const wx = (sx - lv.ox) / lv.zoom, wy = (sy - lv.oy) / lv.zoom;
      lv.zoom = z;
      lv.ox = sx - wx * z;
      lv.oy = sy - wy * z;
      drawLayout();
    }, { passive: false });
    new ResizeObserver(drawLayout).observe(lvCanvas.parentElement);
    document.getElementById('layout-close').addEventListener('click', () => App.showLayoutViewer(false));
    document.getElementById('layout-fit').addEventListener('click', () => { fitLayout(); drawLayout(); });
  };
})(window.App);
