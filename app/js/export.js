/* 10단계: 연결 이미지(PNG) 내보내기, project.json 저장·불러오기 */
(function (App) {
  'use strict';
  const S = App.state;

  // 브라우저 캔버스 한계 (크롬 기준보다 보수적으로)
  const MAX_SIDE = 16384;
  const MAX_AREA = 120e6;

  App.exportPlan = (k) => {
    const sheets = App.mapSheets().filter((s) => s.display.visible);
    const b = App.bounds(sheets);
    if (!b) return null;
    const W = Math.ceil(b.w * k), H = Math.ceil(b.h * k);
    return { sheets, b, W, H, ok: W <= MAX_SIDE && H <= MAX_SIDE && W * H <= MAX_AREA };
  };

  App.exportPNG = async (k) => {
    const plan = App.exportPlan(k);
    if (!plan) return App.toast('내보낼 원도가 없습니다.');
    if (!plan.ok) {
      return App.toast(`${plan.W.toLocaleString()}×${plan.H.toLocaleString()}px는 브라우저에서 만들 수 없습니다. 배율을 낮추거나 tools/export.py를 사용하세요.`, 7000);
    }
    const c = document.createElement('canvas');
    c.width = plan.W;
    c.height = plan.H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, plan.W, plan.H);
    ctx.imageSmoothingQuality = 'high';

    const order = S.zOrder.map(App.byId).filter((s) => s && plan.sheets.includes(s));
    for (let i = 0; i < order.length; i++) {
      const s = order[i];
      App.status(`연결 이미지 만드는 중… (${i + 1}/${order.length}) ${App.newName(s)}`);
      const previewScale = s.preview.width / s.w;
      // 미리보기 해상도로 충분하면 그대로, 아니면 원본을 다시 읽음
      let img = s.preview, imgScale = previewScale, bmp = null;
      if (k * s.transform.scale > previewScale * 1.01) {
        bmp = await createImageBitmap(s.file);
        img = bmp;
        imgScale = 1;
      }
      ctx.setTransform(k, 0, 0, k, -plan.b.minX * k, -plan.b.minY * k);
      App.drawSheet(ctx, s, img, imgScale);
      if (bmp && bmp.close) bmp.close();
      await new Promise((r) => setTimeout(r));
    }
    App.status('PNG로 저장하는 중…');
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    if (!blob) return App.toast('이미지를 만들지 못했습니다. 배율을 낮춰 보세요.');
    App.download(blob, `${S.project || '원도'}_연결_${Math.round(k * 100)}.png`);
    App.logOp('export');
    App.status(`연결 이미지를 저장했습니다 · ${plan.W.toLocaleString()}×${plan.H.toLocaleString()}px · ${(blob.size / 1048576).toFixed(1)}MB`);
  };

  App.saveProject = () => {
    if (!S.sheets.length) return App.toast('먼저 원도를 불러오세요.');
    App.logOp('save');
    const json = JSON.stringify(App.toProjectJSON(), null, 2);
    App.download(new Blob([json], { type: 'application/json' }), `${S.project || '원도'}.project.json`);
    App.autosave();
    App.status('작업 정보(project.json)를 저장했습니다. 원본 이미지와 같은 폴더에 보관하세요.');
  };

  App.openProjectFile = async (file) => {
    let p;
    try {
      p = JSON.parse(await file.text());
    } catch (e) {
      return App.toast(`${file.name}: JSON을 읽지 못했습니다.`);
    }
    if (p.app !== 'jijeok-connect' || !Array.isArray(p.sheets)) {
      return App.toast(`${file.name}: 이 도구의 작업 정보 파일이 아닙니다.`);
    }
    if (!S.sheets.length) {
      S.pendingProject = p;
      S.project = p.project || S.project;
      App.emit('change');
      return App.status(`작업 정보를 읽었습니다. 이제 같은 원본 이미지 ${p.sheets.length + (p.layout ? 1 : 0)}장을 불러오세요.`);
    }
    const r = App.applyProject(p);
    App.fitView();
    if (r.matched < r.total) {
      S.pendingProject = p;
      App.status(`작업 정보를 적용했습니다 (${r.matched}/${r.total}장 일치). 나머지 원본을 더 불러오면 자동으로 맞춥니다.`);
    } else {
      S.pendingProject = null;
      App.status(`작업 정보를 적용했습니다 (${r.matched}장 모두 일치).`);
    }
  };
})(window.App);
