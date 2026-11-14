# Draws the toolbar icon: rounded square, page corner, accent spark. Run: python3 scripts/make_icons.py
from PIL import Image, ImageDraw
import sys, os
out = sys.argv[1] if len(sys.argv) > 1 else 'src/icons'
os.makedirs(out, exist_ok=True)
for size in (16, 32, 48, 128):
    S = size * 4
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = S // 5
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=(47, 111, 237, 255))
    # page
    m = S // 5
    d.rounded_rectangle([m, m, S - m, S - m], radius=S // 14, fill=(255, 255, 255, 255))
    # text lines
    lw = max(4, S // 16)
    for i, w in enumerate((0.55, 0.42, 0.5)):
        y = m + S * (0.2 + i * 0.14)
        d.rounded_rectangle([m + S * 0.1, y, m + S * (0.1 + w * 0.6), y + lw], radius=lw // 2, fill=(26, 31, 41, 255))
    # spark
    cx, cy, k = S * 0.66, S * 0.66, S * 0.13
    d.polygon([(cx, cy - k), (cx + k * 0.3, cy - k * 0.3), (cx + k, cy), (cx + k * 0.3, cy + k * 0.3), (cx, cy + k), (cx - k * 0.3, cy + k * 0.3), (cx - k, cy), (cx - k * 0.3, cy - k * 0.3)], fill=(47, 111, 237, 255))
    im.resize((size, size), Image.LANCZOS).save(os.path.join(out, f'icon{size}.png'))
print('icons ok')
