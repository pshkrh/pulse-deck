#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
IMG_DIR = ROOT / "com.pshkrh.pulse-deck.sdPlugin" / "imgs"


def load_font(
    size: int, bold: bool = False
) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = []
    if bold:
        candidates.extend(
            [
                "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                "/System/Library/Fonts/Supplemental/Helvetica Neue Bold.ttf",
            ]
        )
    else:
        candidates.extend(
            [
                "/System/Library/Fonts/Supplemental/Arial.ttf",
                "/System/Library/Fonts/Supplemental/Helvetica Neue.ttc",
            ]
        )

    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue

    return ImageFont.load_default()


def draw_gradient(
    size: int, accent: tuple[int, int, int], secondary: tuple[int, int, int]
) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    draw = ImageDraw.Draw(image)

    for y in range(size):
        t = y / max(1, size - 1)
        r = int(18 + accent[0] * 0.2 + secondary[0] * 0.05 + t * 20)
        g = int(20 + accent[1] * 0.2 + secondary[1] * 0.04 + t * 15)
        b = int(28 + accent[2] * 0.15 + secondary[2] * 0.05 + t * 18)
        draw.line([(0, y), (size, y)], fill=(r, g, b, 255), width=1)

    draw.rounded_rectangle(
        [2, 2, size - 3, size - 3],
        radius=max(8, size // 7),
        outline=(255, 255, 255, 45),
        width=max(1, size // 72),
    )
    return image


def draw_chip(image: Image.Image, title: str, accent: tuple[int, int, int]) -> None:
    draw = ImageDraw.Draw(image)
    size = image.width

    value_font = load_font(max(18, size // 2), bold=True)
    label_font = load_font(max(8, size // 7), bold=True)

    value_text = title
    value_bbox = draw.textbbox((0, 0), value_text, font=value_font)
    vw = value_bbox[2] - value_bbox[0]

    draw.text(
        ((size - vw) / 2, size * 0.16),
        value_text,
        font=value_font,
        fill=(255, 255, 255, 248),
    )

    label_text = "PULSE DECK"
    label_bbox = draw.textbbox((0, 0), label_text, font=label_font)
    lw = label_bbox[2] - label_bbox[0]
    draw.text(
        ((size - lw) / 2, size * 0.70),
        label_text,
        font=label_font,
        fill=(accent[0], accent[1], accent[2], 230),
    )


def draw_sparkline(image: Image.Image, accent: tuple[int, int, int]) -> None:
    draw = ImageDraw.Draw(image)
    size = image.width

    points = [
        (size * 0.16, size * 0.74),
        (size * 0.31, size * 0.62),
        (size * 0.46, size * 0.68),
        (size * 0.63, size * 0.45),
        (size * 0.84, size * 0.56),
    ]
    draw.line(
        points,
        fill=(accent[0], accent[1], accent[2], 225),
        width=max(2, size // 24),
        joint="curve",
    )
    px, py = points[-1]
    radius = max(2, size // 18)
    draw.ellipse(
        [px - radius, py - radius, px + radius, py + radius],
        fill=(255, 255, 255, 255),
        outline=(accent[0], accent[1], accent[2], 255),
        width=max(1, size // 80),
    )


def save_icon(
    name: str, title: str, accent: tuple[int, int, int], secondary: tuple[int, int, int]
) -> None:
    for size, suffix in [(72, ""), (144, "@2x")]:
        image = draw_gradient(size, accent, secondary)
        draw_chip(image, title, accent)
        draw_sparkline(image, accent)
        image.save(IMG_DIR / f"{name}{suffix}.png", format="PNG")


def main() -> int:
    IMG_DIR.mkdir(parents=True, exist_ok=True)

    save_icon("pluginIcon", "PD", (108, 182, 255), (255, 142, 92))
    save_icon("actionCpu", "C", (255, 102, 87), (255, 165, 120))
    save_icon("actionCpuTemp", "°C", (255, 102, 87), (255, 165, 120))
    save_icon("actionMemory", "R", (92, 177, 255), (134, 209, 255))
    save_icon("actionPing", "P", (76, 206, 222), (108, 168, 245))
    save_icon("actionBattery", "B", (96, 224, 122), (145, 245, 169))
    save_icon("actionUptime", "U", (173, 190, 210), (132, 156, 184))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
