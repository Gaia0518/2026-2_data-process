/* 화면 연결: 상단 버튼, 단계 표시, 단축키, 상태 표시줄 */
(function (App) {
  'use strict';
  const S = App.state;
  const $ = (id) => document.getElementById(id);

  App.status = (msg) => { $('status-msg').textContent = msg; };

  let toastTimer = null;
  App.toast = (msg, ms = 4000) => {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  };

  function renderSteps() {
    const n = App.mapSheets().length;
    const done = [S.sheets.length > 0, n > 0, (S.log.ops.move || 0) + (S.log.ops.rotate || 0) > 0, !!(S.log.ops.save || S.log.ops.export)];
    document.querySelectorAll('.step').forEach((el, i) => {
      el.classList.toggle('is-done', done[i]);
      el.classList.toggle('is-current', done.indexOf(false) === i);
    });
  }

  function renderLog() {
    const started = S.log.startedAt ? Date.parse(S.log.startedAt) : null;
    $('log-time').textContent = started ? App.formatDuration(Date.now() - started) : '0:00';
    const o = S.log.ops;
    const adjust = (o.move || 0) + (o.rotate || 0) + (o.scale || 0) + (o.crop || 0) + (o.frame || 0);
    $('log-ops').textContent = `조정 ${adjust}회`;
    $('log-ops').title = Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n') || '아직 기록 없음';
  }

  function renderAll() {
    App.renderList();
    App.renderPanel();
    renderSteps();
    renderLog();
    App.drawLayout();
    App.requestDraw();
  }

  function updateExportInfo() {
    const k = parseFloat($('export-scale').value);
    const plan = App.exportPlan(k);
    const info = $('export-info');
    if (!plan) { info.textContent = '내보낼 원도가 없습니다.'; return; }
    info.textContent = `${plan.W.toLocaleString()} × ${plan.H.toLocaleString()} px` + (plan.ok ? '' : ' · 브라우저 한계 초과');
    info.classList.toggle('is-warn', !plan.ok);
    $('export-go').disabled = !plan.ok;
  }

  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  }

  document.addEventListener('DOMContentLoaded', () => {
    App.initFiles();
    App.initCanvas();
    App.initPanel();
    App.initLayoutViewer();
    App.initFrame();

    App.on('change', () => { renderAll(); App.autosave(); });
    App.on('select', () => { App.renderList(); App.renderPanel(); App.requestDraw(); });
    App.on('log', () => { renderLog(); renderSteps(); });
    setInterval(renderLog, 1000);

    // 파일 추가
    const fileInput = $('file-input');
    $('btn-add').addEventListener('click', () => fileInput.click());
    $('btn-add-empty').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      await App.addFiles(fileInput.files);
      fileInput.value = '';
    });
    const projInput = $('project-input');
    $('btn-open').addEventListener('click', () => projInput.click());
    projInput.addEventListener('change', async () => {
      if (projInput.files[0]) await App.openProjectFile(projInput.files[0]);
      projInput.value = '';
    });

    // 창 전체에 끌어다 놓기
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      dragDepth++;
      document.body.classList.add('is-dropping');
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove('is-dropping');
    });
    window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('is-dropping');
      await App.addFiles(e.dataTransfer.files);
    });

    // 왼쪽 도구
    $('btn-sort').addEventListener('click', App.sortByName);
    $('btn-zip').addEventListener('click', App.downloadRenamed);

    // 가운데 도구
    $('btn-arrange').addEventListener('click', () => {
      if (!App.mapSheets().length) return;
      App.checkpoint();
      App.autoArrange(null);
      App.logOp('arrange');
      App.fitView();
      App.emit('change');
    });
    $('btn-fit').addEventListener('click', App.fitView);
    $('btn-zoom-in').addEventListener('click', () => App.zoomBy(1.25));
    $('btn-zoom-out').addEventListener('click', () => App.zoomBy(0.8));
    $('btn-layout').addEventListener('click', () => App.showLayoutViewer($('layout-viewer').hidden));
    $('btn-labels').addEventListener('click', (e) => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on));
      App.setLabels(on);
    });
    $('btn-blend-all').addEventListener('change', (e) => {
      App.checkpoint();
      for (const s of App.mapSheets()) s.display.blend = e.target.value;
      App.logOp('display');
      App.emit('change');
    });
    $('btn-undo').addEventListener('click', App.undo);
    $('btn-redo').addEventListener('click', App.redo);

    // 저장·내보내기
    $('btn-save').addEventListener('click', App.saveProject);
    const dlg = $('export-dialog');
    $('btn-export').addEventListener('click', () => {
      if (!App.mapSheets().length) return App.toast('먼저 원도를 불러오세요.');
      updateExportInfo();
      dlg.showModal();
    });
    $('export-scale').addEventListener('change', updateExportInfo);
    $('export-go').addEventListener('click', async (e) => {
      e.preventDefault();
      dlg.close();
      await App.exportPNG(parseFloat($('export-scale').value));
    });
    $('export-cancel').addEventListener('click', () => dlg.close());

    // 단축키
    window.addEventListener('keydown', (e) => {
      if (document.querySelector('dialog[open]')) return; // 대화상자가 열려 있으면 연결 화면 단축키 끔
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        if (isTyping(e)) return;
        e.preventDefault();
        return e.shiftKey ? App.redo() : App.undo();
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); return App.redo(); }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); return App.saveProject(); }
      if (isTyping(e)) return;
      const sel = App.selected();
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (sel && arrows[e.key]) {
        e.preventDefault();
        return App.nudge(...arrows[e.key], e.shiftKey ? 10 : 1);
      }
      if (sel && (e.key === '[' || e.key === ']')) {
        const d = (e.key === '[' ? -1 : 1) * (e.shiftKey ? 1 : 0.1);
        return App.editSelected('rotate', (s) => (s.transform.rotation = App.round(s.transform.rotation + d, 3)));
      }
      if (e.key === 'Escape' && sel) { S.selectedId = null; App.emit('select'); }
      if (e.key === 'f' || e.key === 'F') App.fitView();
    });

    // 이전 작업 안내 (이미지는 다시 불러와야 함)
    const last = App.lastAutosave();
    if (last && last.sheets && last.sheets.length) {
      const bar = $('restore-bar');
      $('restore-text').textContent = `이전 작업 "${last.project || '이름 없음'}" (${last.sheets.length + 1}장)의 배치 정보가 남아 있습니다.`;
      bar.hidden = false;
      $('restore-yes').addEventListener('click', () => {
        S.pendingProject = last;
        S.project = last.project || '';
        bar.hidden = true;
        App.emit('change');
        App.status('이전 배치 정보를 준비했습니다. 같은 원본 이미지를 불러오면 자동으로 적용됩니다.');
      });
      $('restore-no').addEventListener('click', () => (bar.hidden = true));
    }

    renderAll();
    App.status('원도 이미지를 끌어다 놓거나 [파일 추가]를 누르세요. 0번(배치도)을 포함해 한 지역 묶음을 한 번에 불러오면 됩니다.');
  });
})(window.App);
