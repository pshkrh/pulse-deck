#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

KEY_SIZE     = 144
PADDING      = 12
GRAPH_LEFT   = 12
GRAPH_RIGHT  = KEY_SIZE - 12
GRAPH_TOP    = 64
GRAPH_BOTTOM = KEY_SIZE - 22

THEMES = {
    "cpu": {
        "label": "CPU",
        "accent": (255, 102, 87),
        "accent_soft": (255, 165, 120),
        "mode": "percent",
    },
    "cpu_temp": {
        "label": "CPU",
        "accent": (255, 102, 87),
        "accent_soft": (255, 165, 120),
        "mode": "temp",
    },
    "memory": {
        "label": "RAM",
        "accent": (92, 177, 255),
        "accent_soft": (134, 209, 255),
        "mode": "percent",
    },
    "ping": {
        "label": "PING",
        "accent": (76, 206, 222),
        "accent_soft": (108, 168, 245),
        "mode": "latency",
    },
    "battery": {
        "label": "BAT",
        "accent": (96, 224, 122),
        "accent_soft": (145, 245, 169),
        "mode": "percent",
    },
    "uptime": {
        "label": "UP",
        "accent": (173, 190, 210),
        "accent_soft": (132, 156, 184),
        "mode": "uptime",
    },
}


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def save_png_atomic(image: Image.Image, output_path: Path) -> None:
    ensure_parent(output_path)
    temp_file = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{output_path.name}.",
            suffix=".tmp",
            dir=output_path.parent,
            delete=False,
        ) as temp:
            temp_file = Path(temp.name)
        image.save(temp_file, format="PNG")
        os.replace(temp_file, output_path)
    finally:
        if temp_file and temp_file.exists():
            try:
                temp_file.unlink()
            except Exception:
                pass


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if bold:
        choices = [
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/Supplemental/Helvetica Neue Bold.ttf",
        ]
    else:
        choices = [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/Supplemental/Helvetica Neue.ttc",
        ]
    for path in choices:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def clamp_value(value: float, mode: str) -> float:
    if value < 0:
        return 0.0
    if mode == "percent" and value > 100:
        return 100.0
    elif mode == "temp" and value > 120:
        return 120.0
    return value


def parse_history(raw: str, mode: str) -> list[float]:
    if not raw:
        return []
    values: list[float] = []
    for chunk in raw.split(","):
        try:
            values.append(clamp_value(float(chunk), mode))
        except Exception:
            continue
    return values


def draw_background(
    image: Image.Image, accent: tuple[int, int, int], soft: tuple[int, int, int]
) -> None:
    draw = ImageDraw.Draw(image)
    for y in range(KEY_SIZE):
        t = y / max(1, KEY_SIZE - 1)
        r = int(18 + (soft[0] * 0.16) + t * 22)
        g = int(20 + (soft[1] * 0.12) + t * 18)
        b = int(28 + (soft[2] * 0.1) + t * 20)
        draw.line([(0, y), (KEY_SIZE, y)], fill=(r, g, b, 255), width=1)
    draw.rounded_rectangle(
        [2, 2, KEY_SIZE - 3, KEY_SIZE - 3],
        radius=20,
        outline=(255, 255, 255, 35),
        width=1,
    )
    glow = Image.new("RGBA", (KEY_SIZE, KEY_SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(
        [KEY_SIZE - 70, -22, KEY_SIZE + 34, 80],
        fill=(accent[0], accent[1], accent[2], 58),
    )
    image.alpha_composite(glow)


def draw_grid(draw: ImageDraw.ImageDraw) -> None:
    for step in range(5):
        y = GRAPH_TOP + ((GRAPH_BOTTOM - GRAPH_TOP) * step / 4)
        draw.line(
            [(GRAPH_LEFT, y), (GRAPH_RIGHT, y)],
            fill=(255, 255, 255, 28 if step else 38),
            width=1,
        )


def draw_history(
    draw: ImageDraw.ImageDraw,
    history: list[float],
    accent: tuple[int, int, int],
    scale_max: float,
) -> None:
    if not history:
        return
    if len(history) == 1:
        history = [history[0], history[0]]

    span        = max(1, len(history) - 1)
    width       = GRAPH_RIGHT - GRAPH_LEFT
    height      = GRAPH_BOTTOM - GRAPH_TOP
    denominator = max(scale_max, 0.001)

    points: list[tuple[float, float]] = [
        (GRAPH_LEFT + (width * i / span), GRAPH_BOTTOM - (height * (v / denominator)))
        for i, v in enumerate(history)
    ]

    draw.polygon(
        [(GRAPH_LEFT, GRAPH_BOTTOM)] + points + [(GRAPH_RIGHT, GRAPH_BOTTOM)],
        fill=(accent[0], accent[1], accent[2], 40),
    )
    for i in range(1, len(points)):
        draw.line([points[i - 1], points[i]], fill=(accent[0], accent[1], accent[2], 232), width=3)

    px, py = points[-1]
    draw.ellipse(
        [px - 3.5, py - 3.5, px + 3.5, py + 3.5],
        fill=(255, 255, 255, 255),
        outline=(accent[0], accent[1], accent[2], 255),
        width=2,
    )


def format_latency(value: float) -> tuple[str, str]:
    return (f"{value:.1f}", "ms") if value < 10 else (f"{value:.0f}", "ms")


def format_uptime(hours: float) -> tuple[str, str]:
    if hours >= 24:
        return (f"{int(hours // 24)}d", f"{int(hours % 24)}h")
    if hours >= 1:
        return (f"{hours:.1f}", "h")
    return (f"{int(round(hours * 60))}", "m")


def draw_value_with_unit(
    draw: ImageDraw.ImageDraw,
    value: float,
    unit: str,
    accent: tuple[int, int, int],
) -> None:
    """Draw a large numeric value with a smaller unit label alongside it (percent/temp layout)."""
    value_font = load_font(50, bold=True)
    unit_font  = load_font(22, bold=True)
    value_text = f"{int(round(value))}"
    bbox       = draw.textbbox((0, 0), value_text, font=value_font)
    draw.text((PADDING, 20), value_text, font=value_font, fill=(255, 255, 255, 255))
    draw.text(
        (PADDING + (bbox[2] - bbox[0]) + 2, 20 + (bbox[3] - bbox[1]) - 26),
        unit,
        font=unit_font,
        fill=(accent[0], accent[1], accent[2], 255),
    )


def draw_labels(
    draw: ImageDraw.ImageDraw,
    label: str,
    value: float,
    accent: tuple[int, int, int],
    mode: str,
) -> None:
    draw.text((PADDING, 10), label, font=load_font(18, bold=True), fill=(232, 239, 255, 230))

    if mode == "percent":
        draw_value_with_unit(draw, value, "%", accent)
        return

    if mode == "temp":
        draw_value_with_unit(draw, value, "°C", accent)
        return

    if mode == "latency":
        value_text, unit_text = format_latency(value)
    else:
        value_text, unit_text = format_uptime(value)

    draw.text((PADDING, 24), value_text, font=load_font(34, bold=True), fill=(255, 255, 255, 255))
    draw.text((PADDING, 54), unit_text,  font=load_font(15, bold=True), fill=(accent[0], accent[1], accent[2], 255))


def draw_progress_bar(
    draw: ImageDraw.ImageDraw,
    value: float,
    accent: tuple[int, int, int],
    scale_max: float,
    mode: str,
) -> None:
    bar_left   = PADDING
    bar_top    = KEY_SIZE - 16
    bar_right  = KEY_SIZE - PADDING
    bar_bottom = KEY_SIZE - 10

    draw.rounded_rectangle([bar_left, bar_top, bar_right, bar_bottom], radius=4, fill=(255, 255, 255, 35))

    if mode == "uptime":
        bar_ratio = max(0.0, min(1.0, (value % 24.0) / 24.0))
    elif scale_max > 0:
        bar_ratio = max(0.0, min(1.0, value / scale_max))
        if mode == "latency":
            bar_ratio = 1.0 - bar_ratio  # Lower latency = better bar fill
    else:
        bar_ratio = 0.0

    bar_width = (bar_right - bar_left) * bar_ratio
    draw.rounded_rectangle(
        [bar_left, bar_top, bar_left + bar_width, bar_bottom],
        radius=4,
        fill=(accent[0], accent[1], accent[2], 220),
    )


def resolve_scale_max(mode: str, values: list[float], current_value: float) -> float:
    if mode == "percent":
        return 100.0
    if mode == "temp":
        return max(60.0, max(values, default=current_value), current_value)
    if mode == "latency":
        return max(20.0, max(values, default=current_value), current_value)
    if mode == "uptime":
        return max(24.0, max(values, default=current_value), current_value)
    return max(1.0, current_value)


def render(metric: str, value: float, history: list[float], output: Path) -> int:
    theme     = THEMES.get(metric, THEMES["cpu"])
    mode      = theme["mode"]
    safe_value = clamp_value(value, mode)
    values    = history[-30:] if history else [safe_value]
    scale_max = resolve_scale_max(mode, values, safe_value)

    image = Image.new("RGBA", (KEY_SIZE, KEY_SIZE), (0, 0, 0, 255))
    draw_background(image, theme["accent"], theme["accent_soft"])

    draw = ImageDraw.Draw(image)
    draw_grid(draw)
    draw_labels(draw, theme["label"], safe_value, theme["accent"], mode)
    draw_history(draw, values, theme["accent"], scale_max)
    draw_progress_bar(draw, safe_value, theme["accent"], scale_max, mode)

    save_png_atomic(image, output)
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 5:
        return 1
    metric = argv[1]
    try:
        value = float(argv[2])
    except Exception:
        value = 0.0
    mode    = THEMES.get(metric, THEMES["cpu"])["mode"]
    history = parse_history(argv[3], mode)
    output  = Path(argv[4])
    return render(metric, value, history, output)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
