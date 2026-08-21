#!/usr/bin/env python3
"""
Contrast audit for the theme tokens.

Parses styles.css, resolves each theme's primitives and the semantic layer that
aliases onto them, then reports WCAG contrast for the pairs that carry text.

Run: python3 tools/check-contrast.py     (exit 1 if any pair is under its floor)
"""
import re, sys, os

CSS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "client", "src", "styles.css")
AA_TEXT = 4.5
AA_LARGE = 3.0

def srgb(c):
    c = c / 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

def lum(hexstr):
    h = hexstr.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        return None
    try:
        r, g, b = (int(h[i:i+2], 16) for i in (0, 2, 4))
    except ValueError:
        return None
    return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)

def ratio(fg, bg):
    a, b = lum(fg), lum(bg)
    if a is None or b is None:
        return None
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)

src = open(CSS).read()

blocks = {}
for m in re.finditer(r'\[data-theme="([a-z0-9]+)"\]\s*\{([^}]*)\}', src):
    d = blocks.setdefault(m.group(1), {})
    for k, v in re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', m.group(2)):
        d.setdefault(k, v.strip())

m = re.search(r':root,\s*\[data-theme="terminal"\]\s*\{([^}]*)\}', src)
if m:
    d = blocks.setdefault("terminal", {})
    for k, v in re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', m.group(1)):
        d.setdefault(k, v.strip())

alias = {}
m = re.search(r':root,\s*\n\[data-theme\]\s*\{(.*?)\n\}', src, re.S)
if m:
    for k, v in re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', m.group(1)):
        alias[k] = v.strip()

def resolve(theme, token, seen=None):
    seen = seen or set()
    if token in seen:
        return None
    seen.add(token)
    val = blocks.get(theme, {}).get(token) or alias.get(token)
    if not val:
        return None
    val = re.sub(r'/\*.*?\*/', '', val).strip()
    if val.startswith("#"):
        return val.split()[0]
    fn = re.match(r'var\((--[\w-]+)(?:\s*,\s*(.+))?\)$', val)
    if fn:
        got = resolve(theme, fn.group(1), seen)
        if got:
            return got
        fb = (fn.group(2) or "").strip()
        if fb.startswith("#"):
            return fb
        fn2 = re.match(r'var\((--[\w-]+)\)', fb)
        if fn2:
            return resolve(theme, fn2.group(1), seen)
    return None

PAIRS = [
    ("--text-1", "--surface-1", AA_TEXT,  "names / headings"),
    ("--text-2", "--surface-1", AA_TEXT,  "supporting text"),
    ("--text-3", "--surface-1", AA_TEXT,  "labels, paths, timestamps"),
    ("--status-blocked", "--surface-1", AA_LARGE, "blocked indicator"),
    ("--status-ready",   "--surface-1", AA_LARGE, "ready indicator"),
    ("--status-working", "--surface-1", AA_LARGE, "working indicator"),
]

fails, skipped = [], 0
print("%-10s %-22s %7s %6s  %s" % ("THEME", "PAIR", "RATIO", "FLOOR", "RESULT"))
print("-" * 66)
for t in sorted(blocks):
    for fg_t, bg_t, floor, label in PAIRS:
        fg, bg = resolve(t, fg_t), resolve(t, bg_t)
        if not fg or not bg:
            skipped += 1
            continue
        r = ratio(fg, bg)
        if r is None:
            skipped += 1
            continue
        ok = r >= floor
        if not ok:
            fails.append((t, fg_t, bg_t, r, floor, label))
        print("%-10s %-22s %7.2f %6.1f  %s" % (t, fg_t.strip("-"), r, floor, "ok" if ok else "FAIL  " + label))

print()
if skipped:
    print("%d pair(s) skipped (rgba/unresolvable primitives, e.g. glass)" % skipped)
if fails:
    print("%d FAILING pair(s):" % len(fails))
    for t, fg, bg, r, floor, label in fails:
        print("  %-10s %s on %s = %.2f (needs %.1f) — %s" % (t, fg, bg, r, floor, label))
    sys.exit(1)
print("all resolvable text and indicator pairs clear their floor")
