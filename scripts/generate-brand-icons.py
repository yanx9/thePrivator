#!/usr/bin/env python3
"""Render the shared brand SVG to the Linux bundle icon.

Requires librsvg's rsvg-convert and ImageMagick's magick on PATH.
Run from any directory: python3 scripts/generate-brand-icons.py
The current Tauri config targets deb/rpm and consumes only icons/icon.png.
"""

from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public/favicon.svg"
TARGET = ROOT / "src-tauri/icons/icon.png"


def main():
    for command in ("rsvg-convert", "magick"):
        if shutil.which(command) is None:
            raise SystemExit(f"Required icon generation tool not found: {command}")
    with tempfile.TemporaryDirectory(prefix="theprivator-icon-") as directory:
        rendered = Path(directory) / "render.png"
        subprocess.run(
            ["rsvg-convert", "--width", "512", "--height", "512", "--output", str(rendered), str(SOURCE)],
            check=True,
        )
        # Tauri expects RGBA, not an indexed PNG. Strip metadata for reproducibility.
        subprocess.run(
            ["magick", str(rendered), "-strip", f"PNG32:{TARGET}"], check=True
        )
    print(f"Generated {TARGET.relative_to(ROOT)} from {SOURCE.relative_to(ROOT)} (512x512 RGBA)")


if __name__ == "__main__":
    main()
