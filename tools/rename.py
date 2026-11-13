"""원도 파일을 숫자 순서로 정렬해 '공통이름_0~n' 사본을 만든다.

원본은 건드리지 않고, 출력 폴더에 사본과 이름표(CSV)를 만든다.
첫 번째 파일(가장 작은 번호)이 0번(배치도)이 된다.

사용 예:
  python tools/rename.py data/raw/다운로드폴더 --name 남산정 --out data/raw/남산정
  python tools/rename.py data/raw/다운로드폴더 --name 남산정 --dry-run
"""
from __future__ import annotations

import argparse
import csv
import re
import shutil
import sys
from pathlib import Path

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"}


def natural_key(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path, help="내려받은 원도 폴더")
    ap.add_argument("--name", required=True, help="공통 이름 (예: 남산정)")
    ap.add_argument("--out", type=Path, help="사본을 만들 폴더 (기본: <src>/<name>)")
    ap.add_argument("--dry-run", action="store_true", help="복사하지 않고 결과만 표시")
    args = ap.parse_args(argv)

    files = sorted((p for p in args.src.iterdir() if p.suffix.lower() in IMAGE_EXT), key=lambda p: natural_key(p.name))
    if not files:
        print(f"이미지가 없습니다: {args.src}", file=sys.stderr)
        return 1

    out = args.out or args.src / args.name
    rows = []
    for i, p in enumerate(files):
        new = f"{args.name}_{i}{p.suffix.lower()}"
        rows.append((i, new, p.name))
        print(f"{i:>3}  {p.name}  →  {new}{'  (0번·배치도)' if i == 0 else ''}")

    if args.dry_run:
        return 0

    out.mkdir(parents=True, exist_ok=True)
    for i, new, old in rows:
        shutil.copy2(args.src / old, out / new)
    with open(out / f"{args.name}_이름표.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["순서", "새 파일명", "원래 파일명"])
        w.writerows(rows)
    print(f"사본 {len(rows)}장과 이름표를 만들었습니다: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
