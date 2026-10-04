"""
生成验收样例图片：一张「拍下来的实验笔记」。

用途：给「图片转 Markdown / LaTeX」做固定、可复现的输入样例。
它不是运行时依赖——图片本身就是交付件（acceptance/sample/sample-note-photo.png），
这个脚本只是把「这张图是怎么来的」记录下来，方便你换成自己的真实照片。

运行：
    python acceptance/tools/make-sample-image.py

需要 Pillow（本机 DSH 运行时已带）。字体用系统自带的微软雅黑 + Times New Roman。
"""
from __future__ import annotations

import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "sample" / "sample-note-photo.png"

WIDTH, HEIGHT = 900, 620
PAPER = (247, 244, 236)
INK = (32, 38, 52)
INK_SOFT = (70, 78, 95)

FONT_FILES = {
    "cjk": r"C:\Windows\Fonts\msyh.ttc",
    "cjk_bold": r"C:\Windows\Fonts\msyhbd.ttc",
    "latin": r"C:\Windows\Fonts\times.ttf",
    "mono": r"C:\Windows\Fonts\consola.ttf",
}


def font(kind: str, size: int):
    path = FONT_FILES.get(kind, FONT_FILES["latin"])
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def paper_texture() -> Image.Image:
    """米色纸 + 轻微噪点 + 边角阴影，像一张随手拍的照片。"""
    image = Image.new("RGB", (WIDTH, HEIGHT), PAPER)
    noise = Image.new("L", (WIDTH, HEIGHT))
    pixels = noise.load()
    rng = random.Random(20261002)
    for y in range(HEIGHT):
        for x in range(0, WIDTH, 2):
            value = rng.randint(232, 255)
            pixels[x, y] = value
            if x + 1 < WIDTH:
                pixels[x + 1, y] = value
    image = Image.composite(Image.new("RGB", (WIDTH, HEIGHT), (255, 255, 255)), image, noise.point(lambda v: 24))
    return image.filter(ImageFilter.GaussianBlur(0.4))


def main() -> None:
    image = paper_texture()
    draw = ImageDraw.Draw(image)

    # 标题
    draw.text((70, 48), "电磁感应实验记录", font=font("cjk_bold", 40), fill=INK)
    draw.line([(70, 104), (WIDTH - 70, 104)], fill=(198, 190, 176), width=2)

    # 正文
    body = font("cjk", 22)
    draw.text((70, 132), "线圈匝数 N = 200，磁铁快速插入与抽出。", font=body, fill=INK)
    draw.text((70, 172), "由法拉第电磁感应定律可得：", font=body, fill=INK)

    # 公式（Times 的希腊字母更像印刷体）
    math_font = font("latin", 34)
    draw.text((150, 224), "ε = -N · dΦ/dt", font=math_font, fill=INK)

    draw.text((70, 292), "测量数据：", font=body, fill=INK)
    # 用中文字体渲染数据行：Consolas 没有中文字形，会显示成方框
    data_font = font("cjk", 19)
    draw.text((95, 330), "1.  插入磁铁   t = 0.20 s   峰值电压 1.84 V", font=data_font, fill=INK_SOFT)
    draw.text((95, 364), "2.  抽出磁铁   t = 0.18 s   峰值电压 1.92 V", font=data_font, fill=INK_SOFT)

    draw.text((70, 424), "结论：感应电动势与磁通量变化率成正比，", font=body, fill=INK)
    draw.text((70, 462), "方向由楞次定律决定。", font=body, fill=INK)

    draw.text((70, 530), "—— 2026-10-02  物理实验课", font=font("cjk", 18), fill=(120, 116, 108))

    # 轻微倾斜 + 暗角，更像照片
    image = image.rotate(-1.2, resample=Image.BICUBIC, expand=False, fillcolor=PAPER)
    vignette = Image.new("L", (WIDTH, HEIGHT), 0)
    vdraw = ImageDraw.Draw(vignette)
    vdraw.ellipse((-140, -180, WIDTH + 140, HEIGHT + 180), fill=52)
    vignette = vignette.filter(ImageFilter.GaussianBlur(90))
    image = Image.composite(Image.new("RGB", (WIDTH, HEIGHT), (232, 226, 214)), image, vignette)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT, "PNG", optimize=True)
    print(f"已生成 {OUT}  ({OUT.stat().st_size} bytes, {WIDTH}x{HEIGHT})")


if __name__ == "__main__":
    main()
