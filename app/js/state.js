/* 작업 상태, 되돌리기, 작업 기록, project.json 변환 */
(function (App) {
  'use strict';

  const PREVIEW_MAX = 2000; // 화면용 축소 이미지의 긴 변(px)
  App.PREVIEW_MAX = PREVIEW_MAX;

  const S = (App.state = {
    project: '',
    sheets: [], // 순서 = 파일 순서. sheets[0] 은 0번(배치도)
    zOrder: [], // 화면에 그리는 순서 (id 배열, 뒤가 위)
    selectedId: null,
    pendingProject: null, // 이미지보다 먼저 불러온 project.json
    frameSize: null, // 기준 도곽 크기 {w, h} (월드 px). 처음 지정한 도곽으로 정해짐
    layout: null, // 확인한 배치 (0번 위 격자와 칸 번호) — layout.js
    log: { startedAt: null, ops: {} },
  });

  let nextId = 1;
  App.newId = () => nextId++;

  App.byId = (id) => S.sheets.find((s) => s.id === id) || null;
  App.selected = () => App.byId(S.selectedId);
  App.layoutSheet = () => S.sheets[0] || null;
  App.mapSheets = () => S.sheets.slice(1); // 연결 대상(1~n번)

  App.newName = (sheet) => {
    const idx = S.sheets.indexOf(sheet);
    const base = S.project.trim() || '원도';
    return `${base}_${idx}${sheet.ext.toLowerCase()}`;
  };

  App.cropSize = (s) => ({
    w: Math.max(1, s.w - s.crop.left - s.crop.right),
    h: Math.max(1, s.h - s.crop.top - s.crop.bottom),
  });

  // 도면 네 모서리의 월드 좌표
  App.corners = (s) => {
    const { w, h } = App.cropSize(s);
    const t = s.transform;
    const r = (t.rotation * Math.PI) / 180;
    const c = Math.cos(r) * t.scale;
    const n = Math.sin(r) * t.scale;
    return [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ].map(([x, y]) => [t.x + x * c - y * n, t.y + x * n + y * c]);
  };

  App.bounds = (sheets) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of sheets) {
      for (const [x, y] of App.corners(s)) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    if (!isFinite(minX)) return null;
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  };

  /* ---------- 작업 기록 (Before/After 측정용) ---------- */
  App.logOp = (kind, n = 1) => {
    if (!S.log.startedAt) S.log.startedAt = new Date().toISOString();
    S.log.ops[kind] = (S.log.ops[kind] || 0) + n;
    App.emit('log');
  };
  App.opTotal = () => Object.values(S.log.ops).reduce((a, b) => a + b, 0);

  /* ---------- 되돌리기 ---------- */
  const undoStack = [];
  const redoStack = [];

  function snapshot() {
    return JSON.stringify({
      project: S.project,
      frameSize: S.frameSize,
      layout: S.layout,
      order: S.sheets.map((s) => s.id),
      zOrder: S.zOrder.slice(),
      sheets: S.sheets.map((s) => ({
        id: s.id, sheetNo: s.sheetNo, grid: s.grid, frame: s.frame,
        transform: s.transform, crop: s.crop, display: s.display,
      })),
    });
  }

  function restore(json) {
    const d = JSON.parse(json);
    S.project = d.project;
    S.frameSize = d.frameSize || null;
    S.layout = d.layout || null;
    const map = new Map(S.sheets.map((s) => [s.id, s]));
    S.sheets = d.order.map((id) => map.get(id)).filter(Boolean);
    S.zOrder = d.zOrder.filter((id) => map.has(id));
    for (const v of d.sheets) {
      const s = map.get(v.id);
      if (!s) continue;
      s.sheetNo = v.sheetNo;
      s.grid = v.grid || null;
      s.frame = v.frame || null;
      s.transform = v.transform;
      s.crop = v.crop;
      s.display = v.display;
    }
    App.emit('change');
  }

  // 상태를 바꾸기 직전에 호출
  App.checkpoint = () => {
    undoStack.push(snapshot());
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  };
  App.undo = () => {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    App.logOp('undo');
  };
  App.redo = () => {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
  };
  App.clearHistory = () => { undoStack.length = 0; redoStack.length = 0; };

  /* ---------- 간단한 이벤트 ---------- */
  const handlers = {};
  App.on = (name, fn) => (handlers[name] = handlers[name] || []).push(fn);
  App.emit = (name) => (handlers[name] || []).forEach((fn) => fn());

  /* ---------- project.json ---------- */
  App.toProjectJSON = () => {
    const layout = App.layoutSheet();
    return {
      app: 'jijeok-connect',
      version: 1,
      project: S.project,
      savedAt: new Date().toISOString(),
      frameSize: S.frameSize,
      layoutGrid: S.layout,
      layout: layout
        ? { file: App.newName(layout), originalName: layout.originalName, size: [layout.w, layout.h] }
        : null,
      sheets: App.mapSheets().map((s) => ({
        file: App.newName(s),
        originalName: s.originalName,
        fileIndex: S.sheets.indexOf(s),
        sheetNo: s.sheetNo,
        grid: s.grid,
        size: [s.w, s.h],
        z: S.zOrder.indexOf(s.id),
        transform: {
          x: App.round(s.transform.x, 2),
          y: App.round(s.transform.y, 2),
          rotation: App.round(s.transform.rotation, 3),
          scale: App.round(s.transform.scale, 5),
        },
        crop: { ...s.crop },
        frame: s.frame ? { corners: s.frame.corners.map(([x, y]) => [App.round(x, 1), App.round(y, 1)]), clip: s.frame.clip, auto: s.frame.auto || null } : null,
        display: { ...s.display },
        paper: s.paper,
      })),
      log: {
        startedAt: S.log.startedAt,
        savedAt: new Date().toISOString(),
        elapsedSec: S.log.startedAt ? Math.round((Date.now() - Date.parse(S.log.startedAt)) / 1000) : 0,
        ops: { ...S.log.ops },
      },
    };
  };

  // 불러온 이미지에 project.json 의 값을 입힘. 맞춘 개수를 돌려줌
  App.applyProject = (p) => {
    App.checkpoint();
    if (p.project) S.project = p.project;
    if (p.frameSize) S.frameSize = { ...p.frameSize };
    if (p.layoutGrid) S.layout = JSON.parse(JSON.stringify(p.layoutGrid));
    const pool = S.sheets.slice();
    const take = (entry) => {
      if (!entry) return null;
      const i = pool.findIndex((s) => s.originalName === entry.originalName || s.originalName === entry.file);
      return i >= 0 ? pool.splice(i, 1)[0] : null;
    };

    const ordered = [];
    // 0번: 프로젝트에 적힌 배치도, 없으면 기존 0번 유지
    let layout = take(p.layout);
    if (!layout && pool.includes(S.sheets[0])) layout = pool.splice(pool.indexOf(S.sheets[0]), 1)[0];
    if (layout) ordered.push(layout);

    let matched = 0;
    const entries = (p.sheets || []).slice().sort((a, b) => a.fileIndex - b.fileIndex);
    for (const e of entries) {
      const s = take(e);
      if (!s) continue;
      matched++;
      s.sheetNo = e.sheetNo || '';
      s.grid = e.grid || null;
      if (e.size && e.size[0] && e.size[0] !== s.w) {
        // 다른 해상도의 이미지로 다시 연 경우: 좌표를 비율로 환산
        const f = s.w / e.size[0];
        s.transform = { ...e.transform, scale: e.transform.scale / f };
        s.crop = Object.fromEntries(Object.entries(e.crop).map(([k, v]) => [k, v * f]));
        s.frame = e.frame ? { ...e.frame, corners: e.frame.corners.map(([x, y]) => [x * f, y * f]) } : null;
      } else {
        s.transform = { ...e.transform };
        s.crop = { ...e.crop };
        s.frame = e.frame ? { corners: e.frame.corners.map((c) => c.slice()), clip: e.frame.clip !== false, auto: e.frame.auto || null } : null;
      }
      s.display = { opacity: 1, blend: 'darken', visible: true, whiten: false, ...e.display };
      ordered.push(s);
    }
    // 프로젝트에 없던 파일은 뒤에 붙임
    S.sheets = ordered.concat(pool);

    const zMap = new Map(entries.map((e) => [e.originalName, e.z ?? 0]));
    S.zOrder = App.mapSheets()
      .slice()
      .sort((a, b) => (zMap.get(a.originalName) ?? 1e9) - (zMap.get(b.originalName) ?? 1e9))
      .map((s) => s.id);

    if (p.log) {
      S.log.startedAt = p.log.startedAt || S.log.startedAt;
      S.log.ops = { ...(p.log.ops || {}) };
    }
    App.emit('change');
    return { matched, total: entries.length };
  };

  /* ---------- 자동 저장 (JSON만, 이미지는 저장하지 않음) ---------- */
  App.autosave = () => {
    try {
      if (S.sheets.length) localStorage.setItem('jijeok-connect:last', JSON.stringify(App.toProjectJSON()));
    } catch (e) { /* 저장소 사용 불가 시 무시 */ }
  };
  App.lastAutosave = () => {
    try {
      const v = localStorage.getItem('jijeok-connect:last');
      return v ? JSON.parse(v) : null;
    } catch (e) { return null; }
  };
})(window.App);
