"""
Generates the social cards.

Every claim on these is checked against what is actually deployed, because an
OG card is what gets scraped into every link preview — a wrong fee or an
invented TVL here is shown to everyone who sees the link, and is trivially
contradicted by reading the contract.

Deliberately no pool figures. A static image cannot track a live pool, so any
number baked in is guaranteed to be wrong eventually.

    python3 assets/make-social.py
"""
from PIL import Image, ImageDraw, ImageFont
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "social")
FONTS = os.path.join(HERE, "fonts")
os.makedirs(OUT, exist_ok=True)

PAPER = (239, 238, 234)
INK = (17, 17, 16)
ACCENT = (47, 174, 142)
MUTED = (17, 17, 16, 140)

SERIF = os.path.join(FONTS, "PlayfairDisplay-SemiBold.ttf")
MONO_B = os.path.join(FONTS, "SpaceGrotesk-Bold.ttf")
MONO_R = os.path.join(FONTS, "SpaceGrotesk-Regular.ttf")

# --- copy: the single source of truth for both cards -----------------------
HEADLINE = ["Bury every transfer", "in ten thousand others"]
SUBLINE = [
    "0.3% withdrawal fee — 0.2% to the relayer that fronts your gas,",
    "0.1% into a reserve the contract has no function to withdraw from.",
]
EYEBROW = "PRIVACY POOL · ROBINHOOD CHAIN 4663"
FOOTER_FACTS = "NO OWNER · NO UPGRADE · NO PAUSE · UNAUDITED"
DOMAIN = "stratapool.xyz"


def tracked(draw, xy, text, font, fill, tracking=0.0):
    """PIL has no letter-spacing; the brand's eyebrows depend on it."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += font.getlength(ch) + tracking
    return x - xy[0]


def tracked_width(text, font, tracking=0.0):
    return sum(font.getlength(c) + tracking for c in text) - tracking


def mark(img, cx, cy, size, on_dark=False):
    """The five strata, middle one accented, one note inside it."""
    d = ImageDraw.Draw(img)
    s = size / 400.0
    bar = PAPER if on_dark else INK
    hole = INK if on_dark else PAPER
    rows = [(100, 112, 288), (150, 82, 318), (200, 62, 338), (250, 82, 318), (300, 112, 288)]
    half = 11 * s
    for y, x0, x1 in rows:
        colour = ACCENT if y == 200 else bar
        d.rectangle(
            [cx + (x0 - 200) * s, cy + (y - 200) * s - half,
             cx + (x1 - 200) * s, cy + (y - 200) * s + half],
            fill=colour,
        )
    r = 11 * s
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=hole)


def speckle(img, seed, density):
    """Matches the site's dot field, faintly."""
    rnd = random.Random(seed)
    d = ImageDraw.Draw(img, "RGBA")
    for _ in range(density):
        x = rnd.randrange(img.width)
        y = rnd.randrange(img.height)
        if rnd.random() < 0.22:
            c = (*ACCENT, rnd.randrange(60, 150))
        else:
            c = (*INK, rnd.randrange(25, 70))
        r = rnd.choice([1, 1, 1, 2])
        d.ellipse([x - r, y - r, x + r, y + r], fill=c)


def card(w, h, *, footer_h, headline_size, sub_size, mark_size,
         left_pad, reserve_bottom_left=0):
    img = Image.new("RGB", (w, h), PAPER)
    speckle(img, seed=7, density=int(w * h / 2600))
    d = ImageDraw.Draw(img)

    f_eyebrow = ImageFont.truetype(MONO_R, int(h * 0.026))
    f_word = ImageFont.truetype(MONO_B, int(h * 0.040))
    f_head = ImageFont.truetype(SERIF, headline_size)
    f_sub = ImageFont.truetype(MONO_R, sub_size)
    f_foot = ImageFont.truetype(MONO_B, int(footer_h * 0.30))
    f_facts = ImageFont.truetype(MONO_R, int(footer_h * 0.26))

    # header rule
    head_h = int(h * 0.155)
    d.line([(0, head_h), (w, head_h)], fill=INK, width=2)

    mark(img, left_pad + mark_size / 2, head_h / 2, mark_size)
    tracked(d, (left_pad + mark_size + int(w * 0.018), head_h / 2 - f_word.size * 0.72),
            "STRATA", f_word, INK, tracking=f_word.size * 0.24)

    ew = tracked_width(EYEBROW, f_eyebrow, f_eyebrow.size * 0.22)
    tracked(d, (w - left_pad - ew, head_h / 2 - f_eyebrow.size * 0.6),
            EYEBROW, f_eyebrow, (17, 17, 16, 150), tracking=f_eyebrow.size * 0.22)

    # headline
    y = head_h + (h - head_h - footer_h) * 0.16
    for line in HEADLINE:
        d.text((left_pad, y), line, font=f_head, fill=INK)
        y += headline_size * 1.16

    y += headline_size * 0.42
    for line in SUBLINE:
        d.text((left_pad, y), line, font=f_sub, fill=(17, 17, 16))
        y += sub_size * 1.65

    # footer
    d.rectangle([0, h - footer_h, w, h], fill=INK)
    fy = h - footer_h / 2 - f_foot.size * 0.72
    d.text((left_pad + reserve_bottom_left, fy), DOMAIN, font=f_foot, fill=PAPER)
    fw = tracked_width(FOOTER_FACTS, f_facts, f_facts.size * 0.18)
    tracked(d, (w - left_pad - fw, h - footer_h / 2 - f_facts.size * 0.62),
            FOOTER_FACTS, f_facts, (239, 238, 234, 190), tracking=f_facts.size * 0.18)
    return img


# --- Open Graph: 1200x630, rendered at 2x --------------------------------
og = card(2400, 1260, footer_h=150, headline_size=132, sub_size=40,
          mark_size=86, left_pad=110)
og.save(os.path.join(OUT, "og.png"))
og.resize((1200, 630), Image.LANCZOS).save(os.path.join(OUT, "og@1x.png"))

# --- X header: 1500x500. The avatar overlaps the lower left, so the domain
#     is nudged clear of it rather than sitting under a circle. -------------
x = card(3000, 1000, footer_h=132, headline_size=118, sub_size=34,
         mark_size=76, left_pad=120, reserve_bottom_left=380)
x.save(os.path.join(OUT, "x-header.png"))
x.resize((1500, 500), Image.LANCZOS).save(os.path.join(OUT, "x-header@1x.png"))

# --- X avatar: the mark on paper, 800x800 ---------------------------------
av = Image.new("RGB", (800, 800), PAPER)
speckle(av, seed=3, density=90)
mark(av, 400, 400, 470)
av.save(os.path.join(OUT, "x-avatar.png"))

for f in sorted(os.listdir(OUT)):
    p = os.path.join(OUT, f)
    print(f"  {f:<20} {Image.open(p).size!s:<14} {os.path.getsize(p)/1024:7.1f} KB")
