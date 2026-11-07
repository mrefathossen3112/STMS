#!/usr/bin/env python3
"""ফাইল অপরিবর্তিত আছে কিনা মেলানোর জন্য SHA-256 তালিকা।
  python3 tools/checksums.py web            → web/ ফোল্ডারের তালিকা দেখায়
  python3 tools/checksums.py web <APK-এর assets/web ফোল্ডার>  → দুই ফোল্ডার মেলায়
"""
import hashlib, os, sys
def h(d): return {f: hashlib.sha256(open(os.path.join(d, f), 'rb').read()).hexdigest() for f in sorted(os.listdir(d)) if os.path.isfile(os.path.join(d, f))}
a = h(sys.argv[1])
if len(sys.argv) < 3:
    [print(v, k) for k, v in a.items()]
else:
    b = h(sys.argv[2]); bad = 0
    for k, v in a.items():
        ok = b.get(k) == v; bad += (not ok); print('✅' if ok else '❌ বদলে গেছে/নেই', k)
    print('সব ঠিক আছে ✅' if not bad else f'{bad}টি ফাইল ভিন্ন ❌')
