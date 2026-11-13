/* 2차: 도곽 자동 지정
 *
 * 1) 원도마다 도곽 후보(사각형)를 여러 개 찾음: 가로·세로로 길게 이어진 선 4개, 비율 약 1.25,
 *    종이 가장자리 7% 안쪽, 선이 모서리에서 끝날수록 높은 점수 (모눈선은 종이 끝까지 이어짐)
 * 2) 투표: 가장 많은 원도에서 공통으로 나타나는 도곽 크기(이미지 대비 비율)를 고름
 * 3) 원도마다 그 크기·비율로 사각형을 1px씩 옮겨 가며 네 변이 가장 잘 겹치는 위치를 찾음
 *    (흐리거나 지워진 변은 나머지 변과 비율로 추정)
 * 4) 컬러 원도는 모서리를 빨간 선에 맞춰 기울기까지 구함
 *
 * 시험 (tools 없이 편집기에서 동일): 남산정 컬러 4장 정밀 검출값과 4px 이내, 대구 흑백 4장 육안 일치
 */
(function (App) {
  'use strict';
  const S = App.state;

  const MAX_DIM = 1000; // 계산용 축소 크기
  const MARGIN = 0.07; // 도곽은 종이 가장자리에서 이만큼 안쪽에 있음
  const yieldUI = () => new Promise((r) => setTimeout(r));

  // 화면용 미리보기에서 계산용 잉크 지도를 만듦
  function prepare(s) {
    const k = Math.min(1, MAX_DIM / Math.max(s.w, s.h));
    const w = Math.max(16, Math.round(s.w * k)), h = Math.max(16, Math.round(s.h * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s.preview, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const n = w * h;
    const rg = new Float32Array(n);
    let sumAbs = 0;
    for (let i = 0; i < n; i++) { rg[i] = d[i * 4] - d[i * 4 + 1]; sumAbs += Math.abs(rg[i]); }
    const color = sumAbs / n > 4;
    const ink = new Float32Array(n);
    if (color) {
      const med = Float32Array.from(rg).sort()[n >> 1];
      for (let i = 0; i < n; i++) ink[i] = Math.max(0, rg[i] - med - 4);
    } else {
      for (let i = 0; i < n; i++) ink[i] = Math.max(0, 200 - (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3);
    }
    return { k, w, h, ink, color };
  }

  // 누적합: 가로 선분·세로 선분의 평균 잉크를 바로 구하기 위함 (1px 두께 허용)
  function prefix(g, binary, thr) {
    const { w, h, ink } = g;
    const val = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return 0;
      const v = ink[y * w + x];
      return binary ? (v > thr ? 1 : 0) : v;
    };
    const Pr = new Float32Array(h * (w + 1)); // 행마다 x 방향 누적 (위아래 1px 중 최댓값)
    const Pc = new Float32Array((h + 1) * w); // 열마다 y 방향 누적 (좌우 1px 중 최댓값)
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = 0; x < w; x++) {
        acc += Math.max(val(x, y - 1), val(x, y), val(x, y + 1));
        Pr[y * (w + 1) + x + 1] = acc;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = 0; y < h; y++) {
        acc += Math.max(val(x - 1, y), val(x, y), val(x + 1, y));
        Pc[(y + 1) * w + x] = acc;
      }
    }
    const hc = (y, x0, x1) => {
      y = Math.min(h - 1, Math.max(0, Math.round(y)));
      x0 = Math.max(0, Math.round(x0)); x1 = Math.min(w, Math.round(x1));
      return x1 > x0 ? (Pr[y * (w + 1) + x1] - Pr[y * (w + 1) + x0]) / (x1 - x0) : 0;
    };
    const vc = (x, y0, y1) => {
      x = Math.min(w - 1, Math.max(0, Math.round(x)));
      y0 = Math.max(0, Math.round(y0)); y1 = Math.min(h, Math.round(y1));
      return y1 > y0 ? (Pc[y1 * w + x] - Pc[y0 * w + x]) / (y1 - y0) : 0;
    };
    return { hc, vc };
  }

  function topPeaks(prof, lo, hi, k, sep = 6) {
    const idx = [];
    for (let i = Math.max(0, Math.ceil(lo)); i < Math.min(prof.length, Math.floor(hi)); i++) idx.push(i);
    idx.sort((a, b) => prof[b] - prof[a]);
    const out = [];
    for (const i of idx) {
      if (out.every((j) => Math.abs(i - j) > sep)) out.push(i);
      if (out.length >= k) break;
    }
    return out;
  }

  /* ---------- 모서리 좌표 숫자 ----------
   * 도곽 모서리에는 좌표 숫자(+900, -250, +200, 0 등)가 도곽선 바로 바깥에, 모서리에서 시작해 선을 따라 적혀 있다.
   * (가로 숫자: 위·아래 변 바깥, 세로 숫자: 좌·우 변 바깥. 모든 모서리에 있지는 않음)
   * 선 바로 바깥 띠의 잉크 − 한 띠 더 바깥의 잉크 = 숫자 (종이 모눈은 양쪽에 고르게 있어 빠짐)
   * 띠 안에서 끝까지 이어진 줄(모눈선)은 숫자가 아니므로 셈에서 뺌
   */
  const LABEL_W = App.frameParams && App.frameParams.lw != null ? App.frameParams.lw : 5; // 숫자 점수 비중
  function normInk(g) {
    if (g.inkN) return g.inkN;
    const p99 = Float32Array.from(g.ink).sort()[Math.floor(g.ink.length * 0.99)] + 1e-3;
    g.inkN = g.ink.map((v) => Math.min(1.5, v / p99));
    return g.inkN;
  }
  function textIn(g, x0, y0, x1, y1, orient) {
    const { w, h } = g, ink = normInk(g);
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(w, Math.round(x1)); y1 = Math.min(h, Math.round(y1));
    if (x1 - x0 < 2 || y1 - y0 < 2) return 0;
    let sum = 0, cnt = 0;
    if (orient === 'h') { // 가로 띠: 끝까지 이어진 가로줄은 뺌
      for (let y = y0; y < y1; y++) {
        let s = 0, on = 0;
        for (let x = x0; x < x1; x++) { const v = ink[y * w + x]; s += v; if (v > 0.35) on++; }
        if (on > (x1 - x0) * 0.6) continue;
        sum += s; cnt += x1 - x0;
      }
    } else {
      for (let x = x0; x < x1; x++) {
        let s = 0, on = 0;
        for (let y = y0; y < y1; y++) { const v = ink[y * w + x]; s += v; if (v > 0.35) on++; }
        if (on > (y1 - y0) * 0.6) continue;
        sum += s; cnt += y1 - y0;
      }
    }
    return cnt ? sum / cnt : 0;
  }
  // side: 'L'|'R'|'T'|'B', pos: 그 변의 위치, a·b: 그 변의 양 끝(모서리)
  function labelAt(g, side, pos, a, b) {
    const big = Math.max(g.w, g.h);
    // 숫자 실측(1125px 원도): 높이 약 3px, 길이 15~20px, 선에서 1~2px 바깥 → 띠도 그 크기로
    const P = App.frameParams || {};
    const d1 = P.d1 != null ? P.d1 : 0;
    const t = Math.max(3, Math.round(big * (P.th || 0.0045))), L = Math.round(big * (P.len || 0.022));
    const strip = () => {
      let v = 0;
      for (const [s0, s1] of [[a, a + L], [b - L, b]]) {
        if (side === 'L' || side === 'R') {
          const sgn = side === 'L' ? -1 : 1;
          const xa = pos + sgn * d1, xb = xa + sgn * t;
          const near_ = textIn(g, Math.min(xa, xb), s0, Math.max(xa, xb), s1, 'v');
          const far_ = textIn(g, Math.min(xa, xb) + sgn * (t + 2), s0, Math.max(xa, xb) + sgn * (t + 2), s1, 'v');
          v += Math.max(0, near_ - far_);
        } else {
          const sgn = side === 'T' ? -1 : 1;
          const ya = pos + sgn * d1, yb = ya + sgn * t;
          const near_ = textIn(g, s0, Math.min(ya, yb), s1, Math.max(ya, yb), 'h');
          const far_ = textIn(g, s0, Math.min(ya, yb) + sgn * (t + 2), s1, Math.max(ya, yb) + sgn * (t + 2), 'h');
          v += Math.max(0, near_ - far_);
        }
      }
      return v;
    };
    return strip();
  }
  App._labelAt = labelAt; // 시험용
  App._prepare = (s) => prepare(s); // 시험용

  // 1단계: 후보 사각형
  function candidates(g, aspect = 1.25, K = 20) {
    const { w, h, ink } = g;
    const sorted = Float32Array.from(ink).sort();
    const thr = g.color ? 8 : sorted[Math.floor(sorted.length * 0.85)];
    const { hc, vc } = prefix(g, true, thr);
    const rows = new Float32Array(h), cols = new Float32Array(w);
    for (let y = 0; y < h; y++) rows[y] = hc(y, w * 0.2, w * 0.8);
    for (let x = 0; x < w; x++) cols[x] = vc(x, h * 0.2, h * 0.8);
    const T = topPeaks(rows, h * MARGIN, h * 0.45, K), B = topPeaks(rows, h * 0.55, h * (1 - MARGIN), K);
    const L = topPeaks(cols, w * MARGIN, w * 0.45, K), R = topPeaks(cols, w * 0.55, w * (1 - MARGIN), K);
    const ext = Math.max(10, Math.round(Math.min(w, h) * 0.05));
    const out = [];
    for (const t of T) for (const b of B) for (const l of L) for (const r of R) {
      const fw = r - l, fh = b - t;
      if (fw < w * 0.5 || fh < h * 0.5 || Math.abs(fw / fh - aspect) / aspect > 0.08) continue;
      const inside = (hc(t, l, r) + hc(b, l, r) + vc(l, t, b) + vc(r, t, b)) / 4;
      const outside = (hc(t, l - ext, l - 2) + hc(t, r + 2, r + ext) + hc(b, l - ext, l - 2) + hc(b, r + 2, r + ext)
        + vc(l, t - ext, t - 2) + vc(l, b + 2, b + ext) + vc(r, t - ext, t - 2) + vc(r, b + 2, b + ext)) / 8;
      out.push({ score: inside - 0.7 * outside, fx: fw / w, fy: fh / h, t, b, l, r });
    }
    // 선 점수 상위 후보에 모서리 숫자 점수를 더함
    out.sort((a, b) => b.score - a.score);
    for (const c of out.slice(0, 400)) {
      c.label = labelAt(g, 'L', c.l, c.t, c.b) + labelAt(g, 'R', c.r, c.t, c.b) + labelAt(g, 'T', c.t, c.l, c.r) + labelAt(g, 'B', c.b, c.l, c.r);
      c.score += LABEL_W * 0.25 * c.label;
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 300);
  }

  // 2단계: 여러 원도에 공통으로 나타나는 도곽 크기
  function vote(all, tol = 0.025) {
    let best = null;
    for (const cs of all) {
      for (const c0 of cs.slice(0, 60)) {
        let tot = 0;
        const pick = all.map((list) => {
          let m = null;
          for (const c of list) if (Math.abs(c.fx - c0.fx) < tol && Math.abs(c.fy - c0.fy) < tol && (!m || c.score > m.score)) m = c;
          if (m) tot += m.score;
          return m;
        });
        if (!best || tot > best.tot) best = { tot, c0, pick };
      }
    }
    return best;
  }

  // 3단계: 정한 크기·비율로 위치를 1px씩 다시 찾음 (흐린 선도 연한 정도까지 반영)
  function refine(g, init, fx, aspect) {
    const { w, h, ink } = g;
    const p99 = Float32Array.from(ink).sort()[Math.floor(ink.length * 0.99)] + 1e-3;
    const gn = { ...g, ink: ink.map((v) => v / p99) };
    const { hc, vc } = prefix(gn, false);
    let { t, b, l, r } = init;
    const ext = Math.max(10, Math.round(Math.min(w, h) * 0.05));
    const win = 0.2, pen = 0.7;
    let sv = 0, sh = 0;
    const lab = (side, a, b, n) => { const arr = new Float32Array(n); for (let i = 0; i < n; i++) arr[i] = labelAt(g, side, i, a, b); return arr; };
    for (let it = 0; it < 3; it++) {
      let best = null;
      const labL = lab('L', t, b, w), labR = lab('R', t, b, w);
      for (let fw = fx * w * 0.96; fw < fx * w * 1.05; fw += 1) {
        for (let ll = Math.max(w * MARGIN, l - w * win); ll < Math.min(w * (1 - MARGIN) - fw, l + w * win); ll += 1) {
          const rr = ll + fw;
          const sc = vc(ll, t, b) + vc(rr, t, b) - pen * (vc(ll, t - ext, t - 2) + vc(ll, b + 2, b + ext) + vc(rr, t - ext, t - 2) + vc(rr, b + 2, b + ext)) / 2
            + LABEL_W * (labL[Math.round(ll)] + labR[Math.round(rr)] || 0);
          if (!best || sc > best.sc) best = { sc, a: ll, b: rr };
        }
      }
      if (best) { sv = best.sc; l = best.a; r = best.b; }
      const fh0 = (r - l) / aspect; // 세로 길이는 가로 길이와 도곽 비율로
      best = null;
      const labT = lab('T', l, r, h), labB = lab('B', l, r, h);
      for (let fh = fh0 * 0.985; fh < fh0 * 1.015; fh += 0.5) {
        for (let tt = Math.max(h * MARGIN, t - h * win); tt < Math.min(h * (1 - MARGIN) - fh, t + h * win); tt += 1) {
          const bb = tt + fh;
          const sc = hc(tt, l, r) + hc(bb, l, r) - pen * (hc(tt, l - ext, l - 2) + hc(tt, r + 2, r + ext) + hc(bb, l - ext, l - 2) + hc(bb, r + 2, r + ext)) / 2
            + LABEL_W * (labT[Math.round(tt)] + labB[Math.round(bb)] || 0);
          if (!best || sc > best.sc) best = { sc, a: tt, b: bb };
        }
      }
      if (best) { sh = best.sc; t = best.a; b = best.b; }
    }
    // 마지막: 변마다 따로 '그 변의 선 + 그 변에 붙은 모서리 숫자'로 미세 조정 (±1.5%)
    const fw = (App.frameParams && App.frameParams.fine) ?? 0.015;
    if (fw > 0) {
      const sideScore = {
        L: (x) => vc(x, t, b) - pen * (vc(x, t - ext, t - 2) + vc(x, b + 2, b + ext)) / 2 + LABEL_W * labelAt(g, 'L', x, t, b),
        R: (x) => vc(x, t, b) - pen * (vc(x, t - ext, t - 2) + vc(x, b + 2, b + ext)) / 2 + LABEL_W * labelAt(g, 'R', x, t, b),
        T: (y) => hc(y, l, r) - pen * (hc(y, l - ext, l - 2) + hc(y, r + 2, r + ext)) / 2 + LABEL_W * labelAt(g, 'T', y, l, r),
        B: (y) => hc(y, l, r) - pen * (hc(y, l - ext, l - 2) + hc(y, r + 2, r + ext)) / 2 + LABEL_W * labelAt(g, 'B', y, l, r),
      };
      const best1 = (fn, v0, span) => {
        let bv = v0, bs = fn(v0);
        for (let v = Math.round(v0 - span); v <= v0 + span; v++) { const sc = fn(v); if (sc > bs) { bs = sc; bv = v; } }
        return bv;
      };
      for (let it = 0; it < 2; it++) {
        l = best1(sideScore.L, l, w * fw); r = best1(sideScore.R, r, w * fw);
        t = best1(sideScore.T, t, h * fw); b = best1(sideScore.B, b, h * fw);
      }
    }
    return { t, b, l, r, score: (sv + sh) / 2 };
  }

  function median(arr) { const a = arr.slice().sort((x, y) => x - y); return a[a.length >> 1]; }

  // 여러 원도의 도곽을 한꺼번에 찾아 적용. 결과: [{ sheet, corners, score, review }]
  App.autoFrameAll = async (sheets, { onProgress } = {}) => {
    sheets = sheets.filter(Boolean);
    if (!sheets.length) return [];
    const preps = [], cands = [];
    for (let i = 0; i < sheets.length; i++) {
      onProgress && onProgress(`도곽 후보 찾는 중… (${i + 1}/${sheets.length})`);
      await yieldUI();
      const g = prepare(sheets[i]);
      preps.push(g);
      cands.push(candidates(g));
    }
    const v = vote(cands);
    if (!v) return [];
    const picks = v.pick.map((p, i) => p || v.c0);
    const aspect = median(picks.map((p) => (p.r - p.l) / (p.b - p.t)));

    const results = [];
    for (let i = 0; i < sheets.length; i++) {
      onProgress && onProgress(`도곽 위치 맞추는 중… (${i + 1}/${sheets.length})`);
      await yieldUI();
      const s = sheets[i], g = preps[i];
      const init = v.pick[i] || { t: g.h * v.c0.fy * 0.18, b: g.h * (1 - 0.18), l: g.w * 0.12, r: g.w * (0.12 + v.c0.fx) };
      const f = refine(g, init, v.c0.fx, aspect);
      let corners = [[f.l, f.t], [f.r, f.t], [f.r, f.b], [f.l, f.b]].map(([x, y]) => [x / g.k, y / g.k]);
      // 컬러 원도: 모서리를 빨간 선에 정밀하게 맞춤 (기울기까지)
      let snapped = 0;
      if (g.color && App.snapCorner) {
        const out = [];
        for (let c = 0; c < 4; c++) {
          const q = await App.snapCorner(s, corners[c][0], corners[c][1], c);
          if (q.snapped) snapped++;
          // 맞춘 점이 너무 멀리 가면 버림
          out.push(Math.hypot(q.x - corners[c][0], q.y - corners[c][1]) < Math.max(s.w, s.h) * 0.01 ? [q.x, q.y] : corners[c]);
        }
        corners = out;
      }
      results.push({ sheet: s, corners, score: f.score, snapped, color: g.color });
    }
    // 확인 필요: 점수가 다른 원도보다 크게 낮거나, 이미지 대비 도곽 크기가 다른 원도들과 2.5% 넘게 다를 때
    const med = median(results.map((r) => r.score));
    const rel = results.map((r) => { const m = App.frameMetrics(r.corners); return [m.w / r.sheet.w, m.h / r.sheet.h]; });
    const mfx = median(rel.map((v) => v[0])), mfy = median(rel.map((v) => v[1]));
    results.forEach((r, i) => {
      const off = Math.max(Math.abs(rel[i][0] - mfx) / mfx, Math.abs(rel[i][1] - mfy) / mfy);
      r.review = r.score < med * 0.6 || (results.length >= 3 && off > 0.025);
      r.reason = r.score < med * 0.6 ? '선이 흐림' : off > 0.025 ? `크기가 다른 도곽과 ${Math.round(off * 100)}% 다름` : '';
    });
    return results;
  };

  // 화면 버튼: 도곽이 없는 원도(없으면 전체)에 자동 지정 → 확인이 필요한 원도 안내
  App.runAutoFrame = async ({ all = false, quiet = false } = {}) => {
    const targets = App.mapSheets().filter((s) => all || !s.frame);
    const list = targets.length ? targets : App.mapSheets();
    if (!list.length) return App.toast('먼저 원도를 불러오세요.');
    const t0 = Date.now();
    const res = await App.autoFrameAll(list, { onProgress: App.status });
    if (!res.length) { App.status('도곽을 찾지 못했습니다. [도곽 수정]으로 직접 지정하세요.'); return; }
    App.checkpoint();
    // 기준 도곽 크기: 찾은 도곽들의 가운데 값 (처음 한 장에 치우치지 않도록)
    if (!S.frameSize) {
      const ms = res.map((r) => App.frameMetrics(r.corners));
      S.frameSize = { w: Math.round(median(ms.map((m) => m.w))), h: Math.round(median(ms.map((m) => m.h))) };
    }
    for (const r of res) {
      App.applyFrame(r.sheet, r.corners);
      r.sheet.frame.auto = { score: App.round(r.score, 3), review: r.review, reason: r.reason || '' };
    }
    App.logOp('autoFrame', res.length);
    if (S.layout) App.arrangeByLayout();
    App.emit('change');
    App.fitView();
    const review = res.filter((r) => r.review);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    App.status(`도곽 자동 지정 ${res.length}장 (${sec}초)` + (review.length
      ? ` · 확인 필요 ${review.length}장: ${review.map((r) => App.newName(r.sheet)).join(', ')} — [도곽 수정]에서 확인하세요.`
      : ' · 모두 자신 있게 찾았습니다. 그래도 경계를 한 번 확인하세요.'));
    if (!quiet && review.length) App.toast(`확인이 필요한 도곽 ${review.length}장이 있습니다. 목록에서 ⚠ 표시를 확인하세요.`, 6000);
    return res;
  };
})(window.App);
