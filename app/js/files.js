/* 1~3단계: 원본 불러오기, 순서 정리, 파일명 지정 (왼쪽 영역) */
(function (App) {
  'use strict';
  const S = App.state;

  const IMAGE_RE = /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i;

  async function decode(file) {
    const bmp = await createImageBitmap(file);
    const w = bmp.width, h = bmp.height;
    const k = Math.min(1, App.PREVIEW_MAX / Math.max(w, h));
    const preview = document.createElement('canvas');
    preview.width = Math.max(1, Math.round(w * k));
    preview.height = Math.max(1, Math.round(h * k));
    preview.getContext('2d').drawImage(bmp, 0, 0, preview.width, preview.height);

    const tk = Math.min(1, 120 / Math.max(w, h));
    const thumb = document.createElement('canvas');
    thumb.width = Math.max(1, Math.round(w * tk));
    thumb.height = Math.max(1, Math.round(h * tk));
    thumb.getContext('2d').drawImage(preview, 0, 0, thumb.width, thumb.height);
    bmp.close && bmp.close();
    return { w, h, preview, thumbURL: thumb.toDataURL('image/jpeg', 0.8) };
  }

  App.addFiles = async (fileList) => {
    const files = Array.from(fileList);
    const jsons = files.filter((f) => /\.json$/i.test(f.name));
    const images = files.filter((f) => IMAGE_RE.test(f.name));
    const skipped = files.length - jsons.length - images.length;

    if (images.length) {
      App.status(`원도 ${images.length}장을 읽는 중…`);
      const existing = new Set(S.sheets.map((s) => s.originalName));
      const fresh = images.filter((f) => !existing.has(f.name)).sort((a, b) => App.naturalCompare(a.name, b.name));
      const failed = [];
      const added = [];
      for (let i = 0; i < fresh.length; i++) {
        const f = fresh[i];
        App.status(`원도 읽는 중… (${i + 1}/${fresh.length}) ${f.name}`);
        try {
          const d = await decode(f);
          const [, ext] = App.splitExt(f.name);
          added.push({
            id: App.newId(),
            file: f,
            originalName: f.name,
            ext: ext || '.jpg',
            w: d.w, h: d.h,
            preview: d.preview,
            thumbURL: d.thumbURL,
            sheetNo: '',
            grid: null,
            transform: { x: 0, y: 0, rotation: 0, scale: 1 },
            crop: { left: 0, top: 0, right: 0, bottom: 0 },
            display: { opacity: 1, blend: 'multiply', visible: true },
          });
        } catch (e) {
          failed.push(f.name);
        }
      }
      if (added.length) {
        App.checkpoint();
        const wasEmpty = S.sheets.length === 0;
        S.sheets.push(...added);
        const mapIds = new Set(App.mapSheets().map((s) => s.id));
        S.zOrder = S.zOrder.filter((id) => mapIds.has(id));
        for (const s of App.mapSheets()) if (!S.zOrder.includes(s.id)) S.zOrder.push(s.id);
        if (!S.project && wasEmpty) S.project = guessProjectName(added.map((s) => s.originalName));
        App.logOp('load', added.length);
        if (S.pendingProject) {
          const r = App.applyProject(S.pendingProject);
          App.toast(`프로젝트 배치를 적용했습니다 (${r.matched}/${r.total}장 일치)`);
          if (r.matched === r.total) S.pendingProject = null;
        } else {
          App.autoArrange(wasEmpty ? null : added);
        }
        App.emit('change');
        App.fitView();
      }
      let msg = `원도 ${added.length}장을 불러왔습니다.`;
      if (images.length - fresh.length) msg += ` 이미 있는 파일 ${images.length - fresh.length}장은 건너뜀.`;
      if (failed.length) msg += ` 읽지 못한 파일: ${failed.join(', ')} (TIFF는 JPG/PNG로 변환해 주세요)`;
      App.status(msg);
    }

    for (const j of jsons) await App.openProjectFile(j);
    if (skipped > 0) App.toast(`이미지/JSON이 아닌 파일 ${skipped}개는 건너뛰었습니다.`);
  };

  // 공통 접두어로 프로젝트 이름 추정 (한글이 들어 있을 때만)
  function guessProjectName(names) {
    const stems = names.map((n) => App.splitExt(n)[0]);
    let p = stems[0] || '';
    for (const s of stems) while (p && !s.startsWith(p)) p = p.slice(0, -1);
    p = p.replace(/[\s_\-()[\]0-9]+$/, '');
    return /[가-힣]/.test(p) ? p : '';
  }

  /* ---------- 순서 변경 ---------- */
  App.moveSheet = (from, to) => {
    if (from === to || to < 0 || to >= S.sheets.length) return;
    App.checkpoint();
    const [s] = S.sheets.splice(from, 1);
    S.sheets.splice(to, 0, s);
    // 0번이 바뀌면 그리기 순서도 정리
    const mapIds = App.mapSheets().map((x) => x.id);
    S.zOrder = S.zOrder.filter((id) => mapIds.includes(id));
    for (const id of mapIds) if (!S.zOrder.includes(id)) S.zOrder.push(id);
    App.logOp('reorder');
    App.emit('change');
  };

  App.sortByName = () => {
    App.checkpoint();
    S.sheets.sort((a, b) => App.naturalCompare(a.originalName, b.originalName));
    App.logOp('reorder');
    App.emit('change');
  };

  App.removeSheet = (id) => {
    const i = S.sheets.findIndex((s) => s.id === id);
    if (i < 0) return;
    App.checkpoint();
    S.sheets.splice(i, 1);
    S.zOrder = S.zOrder.filter((z) => z !== id);
    if (S.selectedId === id) S.selectedId = null;
    App.emit('change');
  };

  /* ---------- 정리된 사본 (ZIP) ---------- */
  App.downloadRenamed = async () => {
    if (!S.sheets.length) return App.toast('먼저 원도를 불러오세요.');
    App.status('정리된 사본을 묶는 중…');
    const entries = [];
    const rows = ['순서,새 파일명,원래 파일명,도면 번호'];
    for (let i = 0; i < S.sheets.length; i++) {
      const s = S.sheets[i];
      const name = App.newName(s);
      entries.push({ name, data: new Uint8Array(await s.file.arrayBuffer()) });
      rows.push([i, name, s.originalName, i === 0 ? '배치도' : s.sheetNo].map(csvCell).join(','));
    }
    const csv = '﻿' + rows.join('\r\n');
    entries.push({ name: `${S.project || '원도'}_이름표.csv`, data: new TextEncoder().encode(csv) });
    App.download(App.makeZip(entries), `${S.project || '원도'}_정리본.zip`);
    App.logOp('rename');
    App.status(`정리된 사본 ${S.sheets.length}장과 이름표를 내려받았습니다.`);
  };

  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /* ---------- 왼쪽 목록 그리기 ---------- */
  const listEl = () => document.getElementById('sheet-list');

  App.renderList = () => {
    const el = listEl();
    const nameInput = document.getElementById('project-name');
    if (document.activeElement !== nameInput) nameInput.value = S.project;
    document.getElementById('sheet-count').textContent = S.sheets.length
      ? `0번 + ${S.sheets.length - 1}장`
      : '';
    document.getElementById('empty-left').hidden = S.sheets.length > 0;

    el.innerHTML = '';
    S.sheets.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'sheet-item' + (i === 0 ? ' is-layout' : '') + (s.id === S.selectedId ? ' is-selected' : '');
      li.draggable = true;
      li.dataset.index = i;
      li.dataset.id = s.id;
      const hidden = !s.display.visible && i > 0;
      li.innerHTML = `
        <span class="grip" aria-hidden="true">⋮⋮</span>
        <img class="thumb${hidden ? ' is-hidden' : ''}" alt="" src="${s.thumbURL}">
        <span class="names">
          <span class="new-name">${escapeHTML(App.newName(s))}</span>
          <span class="old-name" title="${escapeHTML(s.originalName)}">${escapeHTML(s.originalName)}</span>
          ${i === 0 ? '<span class="tag">0번 · 배치도</span>' : s.sheetNo ? `<span class="tag tag-no">도면 ${escapeHTML(s.sheetNo)}</span>` : ''}
        </span>
        <span class="row-actions">
          ${i === 0 ? '' : `<button class="icon-btn" data-act="eye" title="${hidden ? '보이기' : '숨기기'}" aria-label="${hidden ? '보이기' : '숨기기'}">${hidden ? '◌' : '●'}</button>`}
          <button class="icon-btn" data-act="up" title="위로" aria-label="위로" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" data-act="down" title="아래로" aria-label="아래로" ${i === S.sheets.length - 1 ? 'disabled' : ''}>↓</button>
          ${i === 0 ? '' : '<button class="icon-btn" data-act="layout" title="0번(배치도)으로 지정" aria-label="0번으로 지정">0</button>'}
        </span>`;
      el.appendChild(li);
    });
  };

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  App.escapeHTML = escapeHTML;

  App.initFiles = () => {
    const el = listEl();

    el.addEventListener('click', (e) => {
      const li = e.target.closest('.sheet-item');
      if (!li) return;
      const i = +li.dataset.index;
      const s = S.sheets[i];
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'up') return App.moveSheet(i, i - 1);
      if (act === 'down') return App.moveSheet(i, i + 1);
      if (act === 'layout') return App.moveSheet(i, 0);
      if (act === 'eye') {
        App.checkpoint();
        s.display.visible = !s.display.visible;
        App.logOp('display');
        return App.emit('change');
      }
      if (i === 0) return App.showLayoutViewer(true);
      S.selectedId = s.id;
      App.emit('change');
      App.focusSheet(s);
    });

    let dragFrom = null;
    el.addEventListener('dragstart', (e) => {
      const li = e.target.closest('.sheet-item');
      if (!li) return;
      dragFrom = +li.dataset.index;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragFrom));
      li.classList.add('is-dragging');
    });
    el.addEventListener('dragover', (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      const li = e.target.closest('.sheet-item');
      el.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
      if (li) {
        const r = li.getBoundingClientRect();
        li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
      }
    });
    el.addEventListener('drop', (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      const li = e.target.closest('.sheet-item');
      if (li) {
        const r = li.getBoundingClientRect();
        let to = +li.dataset.index + (e.clientY < r.top + r.height / 2 ? 0 : 1);
        if (to > dragFrom) to--;
        App.moveSheet(dragFrom, to);
      }
      dragFrom = null;
    });
    el.addEventListener('dragend', () => {
      dragFrom = null;
      el.querySelectorAll('.is-dragging,.drop-before,.drop-after').forEach((n) =>
        n.classList.remove('is-dragging', 'drop-before', 'drop-after'));
    });

    const nameInput = document.getElementById('project-name');
    nameInput.addEventListener('focus', () => App.checkpoint());
    nameInput.addEventListener('input', () => {
      S.project = nameInput.value;
      App.renderList();
      App.renderPanel();
      App.autosave();
    });
  };
})(window.App);
