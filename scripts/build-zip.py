#!/usr/bin/env python3
"""打发布 zip：dsh-creator-plus-<version>.zip，顶层目录 dsh-creator-plus/。

与 dsh plugin add <解压目录> 的安装方式对应。内容与手工发布保持一致
（README/cordis.patch.yml/icon.svg/index.js/lib/locale/package.json/test），
排除 .git、.github、scripts、node_modules 与 dot 文件。

可复现：条目排序固定、时间戳固定为 2026-10-24T00:00:00Z；同一份源码每次都产出同一 sha256。

用法：python scripts/build-zip.py [--out <目录>]
"""

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXCLUDE_DIRS = {".git", ".github", "node_modules", "scripts", "__pycache__"}
EXCLUDE_FILES = {".gitignore", ".gitattributes"}
FIXED_TIME = (2026, 10, 24, 0, 0, 0)


def collect() -> list[Path]:
    files = []
    for path in sorted(ROOT.rglob("*")):
        rel = path.relative_to(ROOT)
        if any(part in EXCLUDE_DIRS for part in rel.parts):
            continue
        if path.is_file() and path.name not in EXCLUDE_FILES and not path.name.startswith("."):
            files.append(path)
    return files


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT.parent / "dist"), help="输出目录，默认 <repo>/../dist")
    args = ap.parse_args()

    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    name = f"dsh-creator-plus-{version}.zip"
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / name

    files = collect()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in files:
            arcname = (Path("dsh-creator-plus") / path.relative_to(ROOT)).as_posix()
            info = zipfile.ZipInfo(arcname, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())

    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    print(f"{out}")
    print(f"entries={len(files)} size={out.stat().st_size} sha256={digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
