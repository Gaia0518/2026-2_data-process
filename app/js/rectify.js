/* 도곽 펴기: 지정한 네 모서리를 반듯한 직사각형으로 펴서 네 변을 모두 수직·수평으로 맞춤 (원근 보정)
 *
 * 평균 기울기만큼 회전하는 방식은 사다리꼴로 틀어진 스캔에서 변마다 기울기가 남는다.
 * 펴기를 켜면(frame.rectify) 원도는 '도곽 안쪽만 펴진 이미지'(가로 = 도곽 가로 평균, 세로 = 세로 평균)로 다뤄진다.
 */
(function (App) {
  'use strict';

  // 출력 직사각형 (0,0)-(W,H) → 원본 사각형 네 점으로 가는 투영 변환 계수 [a..h]
  //   x = (a u + b v + c) / (g u + h v + 1),  y = (d u + e v + f) / (g u + h v + 1)
  App.homography = (W, H, quad) => {
    const src = [[0, 0], [W, 0], [W, H], [0, H]];
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = src[i], [x, y] = quad[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); B.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); B.push(y);
    }
    // 가우스 소거
    const n = 8;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        B[r] -= f * B[c];
      }
    }
    return B.map((b, i) => b / A[i][i]);
  };

  App.isRectified = (s) => !!(s && s.frame && s.frame.rectify);

  // 펴진 크기 (원본 px 단위)
  App.rectSize = (s) => {
    const m = App.frameMetrics(s.frame.corners);
    return { w: Math.max(1, Math.round(m.w)), h: Math.max(1, Math.round(m.h)) };
  };

  // src(캔버스/이미지비트맵, 원본 px × k 크기)의 사각형을 W×H(원본 px) × k 크기로 폄 — 쌍선형 보간
  App.warpQuad = (src, k, quad, W, H) => {
    const sw = src.width, sh = src.height;
    const sc = document.createElement('canvas');
    sc.width = sw; sc.height = sh;
    const sctx = sc.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(src, 0, 0);
    const sd = sctx.getImageData(0, 0, sw, sh).data;
    const ow = Math.max(1, Math.round(W * k)), oh = Math.max(1, Math.round(H * k));
    const out = document.createElement('canvas');
    out.width = ow; out.height = oh;
    const octx = out.getContext('2d');
    const img = octx.createImageData(ow, oh);
    const od = img.data;
    const [a, b, c, d, e, f, g, h] = App.homography(W, H, quad);
    for (let j = 0; j < oh; j++) {
      const v = (j + 0.5) / k;
      for (let i = 0; i < ow; i++) {
        const u = (i + 0.5) / k;
        const z = g * u + h * v + 1;
        const x = ((a * u + b * v + c) / z) * k - 0.5;
        const y = ((d * u + e * v + f) / z) * k - 0.5;
        const o = (j * ow + i) * 4;
        const x0 = Math.floor(x), y0 = Math.floor(y);
        if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) { od[o] = od[o + 1] = od[o + 2] = 255; od[o + 3] = 255; continue; }
        const fx = x - x0, fy = y - y0;
        const p = (y0 * sw + x0) * 4, q = p + sw * 4;
        for (let ch = 0; ch < 3; ch++) {
          const top = sd[p + ch] * (1 - fx) + sd[p + 4 + ch] * fx;
          const bot = sd[q + ch] * (1 - fx) + sd[q + 4 + ch] * fx;
          od[o + ch] = top * (1 - fy) + bot * fy;
        }
        od[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  };

  // 화면용: 미리보기를 편 이미지 (모서리가 바뀔 때만 다시 계산)
  App.rectPreview = (s) => {
    const key = JSON.stringify(s.frame.corners);
    if (s._rect && s._rect.key === key) return s._rect.canvas;
    const { w, h } = App.rectSize(s);
    const k = s.preview.width / s.w;
    const canvas = App.warpQuad(s.preview, k, s.frame.corners, w, h);
    s._rect = { key, canvas };
    return canvas;
  };
})(window.App);
