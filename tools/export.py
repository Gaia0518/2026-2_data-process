"""project.json + 원본 이미지 → 연결 이미지(PNG/TIFF)

브라우저에서 만들기 어려운 원본 해상도 출력을 담당한다.
편집기(app/)와 같은 규칙으로 도면을 놓는다.

  - transform.x, y : 잘라낸 영역의 중심이 놓일 월드 좌표(원본 px)
  - rotation       : 시계 방향(도), scale: 배율
  - display.blend  : darken(어둡게) | multiply(곱하기) | normal, opacity: 0~1
  - display.whiten : 종이 밝게 (paper 밝기를 흰색으로)
  - frame.corners  : 도곽 네 모서리(원본 px). frame.clip 이면 도곽 바깥을 잘라냄

사용 예:
  python tools/export.py data/raw/남산정/남산정.project.json --images data/raw/남산정 --scale 1
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None  # 큰 원도 허용


def find_image(entry: dict, folder: Path) -> Path | None:
    for key in ("file", "originalName"):
        name = entry.get(key)
        if name and (folder / name).exists():
            return folder / name
    return None


def crop_size(s: dict) -> tuple[float, float]:
    w, h = s["size"]
    c = s["crop"]
    return max(1, w - c["left"] - c["right"]), max(1, h - c["top"] - c["bottom"])


def corners(s: dict) -> list[tuple[float, float]]:
    w, h = crop_size(s)
    t = s["transform"]
    r = math.radians(t["rotation"])
    c, n = math.cos(r) * t["scale"], math.sin(r) * t["scale"]
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    return [(t["x"] + x * c - y * n, t["y"] + x * n + y * c) for x, y in pts]


def render_sheet(img: Image.Image, s: dict, k: float, f: float) -> Image.Image:
    """잘라내기 → 배율 → 회전한 RGBA 조각. f = 실제 이미지 px / 기록된 px"""
    c = s["crop"]
    w, h = crop_size(s)
    box = tuple(round(v) for v in (c["left"] * f, c["top"] * f, (c["left"] + w) * f, (c["top"] + h) * f))
    piece = img.crop(box).convert("RGB")
    out_w = max(1, round(w * s["transform"]["scale"] * k))
    out_h = max(1, round(h * s["transform"]["scale"] * k))
    piece = piece.resize((out_w, out_h), Image.LANCZOS)
    frame = s.get("frame")
    if frame and frame.get("clip", True):
        # 도곽 바깥(여백)은 투명하게
        sx, sy = out_w / (box[2] - box[0]), out_h / (box[3] - box[1])
        poly = [((x * f - box[0]) * sx, (y * f - box[1]) * sy) for x, y in frame["corners"]]
        mask = Image.new("L", (out_w, out_h), 0)
        ImageDraw.Draw(mask).polygon(poly, fill=255)
        piece.putalpha(mask)
    else:
        piece.putalpha(255)
    rot = s["transform"]["rotation"]
    if abs(rot) > 1e-6:
        # PIL은 반시계가 +이므로 부호를 뒤집는다. expand 후에도 중심은 유지된다.
        piece = piece.rotate(-rot, resample=Image.BICUBIC, expand=True)
    return piece


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path, help="project.json 경로")
    ap.add_argument("--images", type=Path, help="원본 이미지 폴더 (기본: project.json 폴더)")
    ap.add_argument("--scale", type=float, default=1.0, help="원본 대비 출력 배율 (기본 1.0)")
    ap.add_argument("--out", type=Path, help="출력 파일 (기본: <프로젝트>_연결_<배율>.png)")
    ap.add_argument("--include-hidden", action="store_true", help="숨긴 도면도 포함")
    args = ap.parse_args(argv)

    project = json.loads(args.project.read_text(encoding="utf-8"))
    folder = args.images or args.project.parent
    k = args.scale

    sheets = [s for s in project["sheets"] if args.include_hidden or s["display"].get("visible", True)]
    sheets.sort(key=lambda s: s.get("z", 0))
    if not sheets:
        print("내보낼 도면이 없습니다.", file=sys.stderr)
        return 1

    missing = [s["file"] for s in sheets if find_image(s, folder) is None]
    if missing:
        print(f"원본을 찾지 못했습니다 ({folder}): {', '.join(missing)}", file=sys.stderr)
        return 1

    xs, ys = zip(*(p for s in sheets for p in corners(s)))
    min_x, min_y = min(xs), min(ys)
    W = math.ceil((max(xs) - min_x) * k)
    H = math.ceil((max(ys) - min_y) * k)
    print(f"출력 크기: {W:,} × {H:,} px (배율 {k})")

    canvas = np.full((H, W, 3), 255, dtype=np.uint8)

    for i, s in enumerate(sheets, 1):
        path = find_image(s, folder)
        with Image.open(path) as img:
            f = img.width / s["size"][0]
            piece = render_sheet(img, s, k, f)
        cx = (s["transform"]["x"] - min_x) * k
        cy = (s["transform"]["y"] - min_y) * k
        x0 = round(cx - piece.width / 2)
        y0 = round(cy - piece.height / 2)

        # 캔버스 밖으로 나간 부분 자르기
        px0, py0 = max(0, -x0), max(0, -y0)
        px1, py1 = min(piece.width, W - x0), min(piece.height, H - y0)
        if px1 <= px0 or py1 <= py0:
            continue
        arr = np.asarray(piece, dtype=np.float32)[py0:py1, px0:px1] / 255.0
        src, alpha = arr[..., :3], arr[..., 3:4] * float(s["display"].get("opacity", 1))
        region = canvas[y0 + py0:y0 + py1, x0 + px0:x0 + px1].astype(np.float32) / 255.0
        blend = s["display"].get("blend", "darken")
        if s["display"].get("whiten") and s.get("paper"):
            src = np.clip(src * min(3.0, 255.0 / s["paper"]), 0, 1)  # 종이 밝게
        if blend == "multiply":
            region = region * (1 - alpha + alpha * src)
        elif blend == "darken":
            region = region * (1 - alpha) + np.minimum(region, src) * alpha
        else:
            region = region * (1 - alpha) + src * alpha
        canvas[y0 + py0:y0 + py1, x0 + px0:x0 + px1] = np.clip(region * 255 + 0.5, 0, 255).astype(np.uint8)
        print(f"  [{i}/{len(sheets)}] {path.name}")

    name = project.get("project") or "원도"
    out = args.out or args.project.parent / f"{name}_연결_{round(k * 100)}.png"
    Image.fromarray(canvas).save(out)
    print(f"저장: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
