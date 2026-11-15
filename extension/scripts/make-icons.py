"""Generates the extension icons (headset on a blue rounded square). Run: python3 extension/scripts/make-icons.py"""
from PIL import Image, ImageDraw
import os
out = os.path.join(os.path.dirname(__file__), '..', 'icons')
os.makedirs(out, exist_ok=True)
for size in (16, 32, 48, 128):
    S = size * 8
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.22, fill=(42, 120, 214, 255))
    w = max(int(S * 0.075), 1)
    d.arc([S * .24, S * .2, S * .76, S * .72], 180, 360, fill='white', width=w)
    d.line([S * .24 + w / 2, S * .46, S * .24 + w / 2, S * .58], fill='white', width=w)
    d.line([S * .76 - w / 2, S * .46, S * .76 - w / 2, S * .58], fill='white', width=w)
    d.rounded_rectangle([S * .2, S * .52, S * .36, S * .76], radius=S * .04, fill='white')
    d.rounded_rectangle([S * .64, S * .52, S * .8, S * .76], radius=S * .04, fill='white')
    img.resize((size, size), Image.LANCZOS).save(os.path.join(out, f'icon{size}.png'))
print('icons written')
