/* 오른쪽 영역: 선택한 도면의 위치·회전·배율·자르기·표시 조정 */
(function (App) {
  'use strict';
  const S = App.state;

  // [입력 id, 읽기, 쓰기, 기록 종류]
  const FIELDS = [
    ['f-x', (s) => App.round(s.transform.x, 1), (s, v) => (s.transform.x = v), 'move'],
    ['f-y', (s) => App.round(s.transform.y, 1), (s, v) => (s.transform.y = v), 'move'],
    ['f-rot', (s) => App.round(s.transform.rotation, 2), (s, v) => (s.transform.rotation = App.clamp(v, -180, 180)), 'rotate'],
    ['f-scale', (s) => App.round(s.transform.scale * 100, 2), (s, v) => (s.transform.scale = App.clamp(v / 100, 0.05, 20)), 'scale'],
    ['f-crop-l', (s) => Math.round(s.crop.left), (s, v) => setCrop(s, 'left', v), 'crop'],
    ['f-crop-t', (s) => Math.round(s.crop.top), (s, v) => setCrop(s, 'top', v), 'crop'],
    ['f-crop-r', (s) => Math.round(s.crop.right), (s, v) => setCrop(s, 'right', v), 'crop'],
    ['f-crop-b', (s) => Math.round(s.crop.bottom), (s, v) => setCrop(s, 'bottom', v), 'crop'],
  ];

  // 자르기를 바꿔도 지도 내용이 제자리에 있도록 중심을 보정
  function setCrop(s, side, v) {
    const c = { ...s.crop };
    const max = side === 'left' || side === 'right' ? s.w - 2 - (side === 'left' ? c.right : c.left)
      : s.h - 2 - (side === 'top' ? c.bottom : c.top);
    c[side] = App.clamp(Math.round(v), 0, Math.max(0, max));
    const dcx = ((c.left - s.crop.left) - (c.right - s.crop.right)) / 2;
    const dcy = ((c.top - s.crop.top) - (c.bottom - s.crop.bottom)) / 2;
    const t = s.transform;
    const r = (t.rotation * Math.PI) / 180;
    t.x += (dcx * Math.cos(r) - dcy * Math.sin(r)) * t.scale;
    t.y += (dcx * Math.sin(r) + dcy * Math.cos(r)) * t.scale;
    s.crop = c;
  }

  App.renderPanel = () => {
    const s = App.selected();
    const isMap = s && S.sheets.indexOf(s) > 0;
    document.getElementById('panel-empty').hidden = !!isMap;
    document.getElementById('panel-body').hidden = !isMap;
    if (!isMap) return;

    document.getElementById('sel-name').textContent = App.newName(s);
    document.getElementById('sel-orig').textContent = `${s.originalName} · ${s.w.toLocaleString()}×${s.h.toLocaleString()}px`;
    for (const [id, get] of FIELDS) {
      const el = document.getElementById(id);
      if (document.activeElement !== el) el.value = get(s);
    }
    const no = document.getElementById('f-sheetno');
    if (document.activeElement !== no) no.value = s.sheetNo;
    document.getElementById('f-opacity').value = Math.round(s.display.opacity * 100);
    document.getElementById('f-opacity-val').textContent = `${Math.round(s.display.opacity * 100)}%`;
    document.getElementById('f-blend').value = s.display.blend;
    document.getElementById('f-visible').checked = s.display.visible;
    App.renderFramePanel(s);
  };

  function edit(kind, fn) {
    const s = App.selected();
    if (!s) return;
    App.checkpoint();
    fn(s);
    App.logOp(kind);
    App.autosave();
    App.renderPanel();
    App.requestDraw();
  }
  App.editSelected = edit;

  App.initPanel = () => {
    for (const [id, , set, kind] of FIELDS) {
      const el = document.getElementById(id);
      el.addEventListener('change', () => {
        const v = parseFloat(el.value);
        if (Number.isFinite(v)) edit(kind, (s) => set(s, v));
        else App.renderPanel();
      });
    }
    const no = document.getElementById('f-sheetno');
    no.addEventListener('change', () => {
      edit('sheetNo', (s) => (s.sheetNo = no.value.trim()));
      App.renderList();
    });

    const op = document.getElementById('f-opacity');
    let opStarted = false;
    op.addEventListener('input', () => {
      const s = App.selected();
      if (!s) return;
      if (!opStarted) { App.checkpoint(); opStarted = true; }
      s.display.opacity = op.value / 100;
      document.getElementById('f-opacity-val').textContent = `${op.value}%`;
      App.requestDraw();
    });
    op.addEventListener('change', () => {
      opStarted = false;
      App.logOp('display');
      App.autosave();
    });

    document.getElementById('f-blend').addEventListener('change', (e) =>
      edit('display', (s) => (s.display.blend = e.target.value)));
    document.getElementById('f-visible').addEventListener('change', (e) => {
      edit('display', (s) => (s.display.visible = e.target.checked));
      App.renderList();
    });

    document.getElementById('btn-front').addEventListener('click', () => edit('order', (s) => {
      S.zOrder = S.zOrder.filter((id) => id !== s.id).concat(s.id);
    }));
    document.getElementById('btn-back').addEventListener('click', () => edit('order', (s) => {
      S.zOrder = [s.id].concat(S.zOrder.filter((id) => id !== s.id));
    }));
    document.getElementById('btn-reset-rot').addEventListener('click', () =>
      edit('rotate', (s) => { s.transform.rotation = 0; s.transform.scale = 1; }));

    document.querySelectorAll('[data-nudge]').forEach((b) => b.addEventListener('click', () => {
      const [dx, dy] = b.dataset.nudge.split(',').map(Number);
      App.nudge(dx, dy, 10);
    }));
    document.querySelectorAll('[data-rot]').forEach((b) => b.addEventListener('click', () =>
      edit('rotate', (s) => (s.transform.rotation = App.round(s.transform.rotation + Number(b.dataset.rot), 3)))));
  };

  // 화면 px 기준 이동 (확대 배율과 관계없이 같은 느낌)
  App.nudge = (dx, dy, px) => edit('move', (s) => {
    s.transform.x += (dx * px) / App.view.zoom;
    s.transform.y += (dy * px) / App.view.zoom;
  });
})(window.App);
