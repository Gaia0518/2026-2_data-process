"""시험용 '가상 지적원도' 묶음을 만든다. (실제 원도가 아님)

하나의 가상 지도를 격자로 나눠 여러 장의 원도처럼 만들고,
각 장에 종이 여백·약간의 기울기·배율 차이를 준다.
0번은 표지와 작은 배치도이다. 정답 배치는 truth.json 에 남긴다.

사용 예:
  python tools/make_samples.py --out samples/synthetic --rows 2 --cols 3
"""
from __future__ import annotations

import argparse
import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

KANJI = "一二三四五六七八九十"
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "C:/Windows/Fonts/malgun.ttf",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
]


def font(size: int):
    for p in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def kanji_no(n: int) -> str:
    if n <= 10:
        return KANJI[n - 1]
    return ("" if n // 10 == 1 else KANJI[n // 10 - 1]) + "十" + (KANJI[n % 10 - 1] if n % 10 else "")


def paper(w: int, h: int, rng: random.Random) -> Image.Image:
    base = Image.new("RGB", (w, h), (226, 212, 182))
    noise = Image.effect_noise((w, h), 18).filter(ImageFilter.GaussianBlur(1.2))
    tint = Image.merge("RGB", [noise.point(lambda v, o=o: max(0, min(255, v + o))) for o in (-10, -22, -55)])
    img = Image.blend(base, tint, 0.25)
    d = ImageDraw.Draw(img)
    for _ in range(6):  # 얼룩
        x, y, r = rng.randint(0, w), rng.randint(0, h), rng.randint(30, 120)
        d.ellipse((x - r, y - r, x + r, y + r), fill=(214, 196, 160))
    return img.filter(ImageFilter.GaussianBlur(0.6))


def draw_world(W: int, H: int, rng: random.Random) -> Image.Image:
    """흰 바탕 위 먹선 지도 (곱하기용)"""
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)
    step = 110
    pts = {}
    for gx in range(-1, W // step + 3):
        for gy in range(-1, H // step + 3):
            pts[gx, gy] = (gx * step + rng.randint(-35, 35), gy * step + rng.randint(-35, 35))
    # 필지 경계
    for (gx, gy), p in pts.items():
        for q in (pts.get((gx + 1, gy)), pts.get((gx, gy + 1))):
            if q and rng.random() < 0.85:
                d.line([p, q], fill=60, width=2)
    # 지번
    f = font(15)
    for (gx, gy), p in pts.items():
        q = pts.get((gx + 1, gy + 1))
        if q and rng.random() < 0.7:
            d.text(((p[0] + q[0]) / 2 - 8, (p[1] + q[1]) / 2 - 8), str(rng.randint(1, 400)), fill=90, font=f)
    # 도로 (이중선)
    for _ in range(3):
        y = rng.randint(H // 6, H * 5 // 6)
        line = [(x, y + 60 * math.sin(x / 400 + rng.random() * 6)) for x in range(-50, W + 60, 40)]
        d.line([(x, y - 9) for x, y in line], fill=30, width=3)
        d.line([(x, y + 9) for x, y in line], fill=30, width=3)
    for _ in range(2):
        x = rng.randint(W // 6, W * 5 // 6)
        line = [(x + 50 * math.sin(y / 350 + rng.random() * 6), y) for y in range(-50, H + 60, 40)]
        d.line([(x - 9, y) for x, y in line], fill=30, width=3)
        d.line([(x + 9, y) for x, y in line], fill=30, width=3)
    return img


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=Path("samples/synthetic"))
    ap.add_argument("--rows", type=int, default=2)
    ap.add_argument("--cols", type=int, default=3)
    ap.add_argument("--cell", type=int, nargs=2, default=[900, 700], metavar=("W", "H"))
    ap.add_argument("--margin", type=int, default=110)
    ap.add_argument("--name", default="가상정")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    cw, ch = args.cell
    W, H = cw * args.cols, ch * args.rows
    world = draw_world(W, H, rng)
    args.out.mkdir(parents=True, exist_ok=True)
    prefix = "CJA0099999_"
    truth = {"note": "가상 원도의 정답 배치 (지도 좌표 px)", "cell": [cw, ch], "sheets": []}

    # 0번: 표지 + 배치도
    cover = paper(1400, 1100, rng)
    d = ImageDraw.Draw(cover)
    d.text((980, 140), f"{args.name}\n原圖", fill=(60, 45, 35), font=font(64), spacing=20)
    bx, by, bw, bh = 260, 420, 110 * args.cols, 110 * args.rows * ch / cw
    for r in range(args.rows):
        for c in range(args.cols):
            n = r * args.cols + c + 1
            x0, y0 = bx + c * bw / args.cols, by + r * bh / args.rows
            d.rectangle((x0, y0, x0 + bw / args.cols, y0 + bh / args.rows), outline=(150, 40, 40), width=2)
            d.text((x0 + 38, y0 + 22), kanji_no(n), fill=(150, 40, 40), font=font(34))
    cover.save(args.out / f"{prefix}0000.jpg", quality=85)

    for r in range(args.rows):
        for c in range(args.cols):
            n = r * args.cols + c + 1
            m = args.margin
            sheet = paper(cw + 2 * m, ch + 2 * m, rng)
            content = world.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch))
            ink = Image.new("RGB", content.size, (45, 35, 30))
            sheet.paste(ink, (m, m), content.point(lambda v: 255 - v))
            d = ImageDraw.Draw(sheet)
            d.rectangle((m, m, m + cw, m + ch), outline=(40, 30, 25), width=3)
            d.text((cw + m - 10, 20), f"{args.name}\n{kanji_no(n)}", fill=(60, 45, 35), font=font(30))
            d.rectangle((30, ch + m + 20, 90, ch + m + 80), outline=(170, 50, 40), width=3)  # 도장

            rot = rng.uniform(-1.2, 1.2)
            scale = rng.uniform(0.97, 1.03)
            out = sheet.rotate(rot, resample=Image.BICUBIC, expand=True, fillcolor=(236, 230, 214))
            out = out.resize((round(out.width * scale), round(out.height * scale)), Image.LANCZOS)
            name = f"{prefix}{n:04d}.jpg"
            out.save(args.out / name, quality=85)
            truth["sheets"].append({
                "file": name, "sheetNo": kanji_no(n), "grid": {"row": r, "col": c},
                "mapCenter": [c * cw + cw / 2, r * ch + ch / 2],
                "appliedRotationCCW": rot, "appliedScale": scale,
                "fix": {"rotation": round(rot, 3), "scale": round(1 / scale, 5)},
            })
            print(name, kanji_no(n), f"rot={rot:+.2f}° scale={scale:.3f}")

    (args.out / "truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"→ {args.out}")


if __name__ == "__main__":
    main()
