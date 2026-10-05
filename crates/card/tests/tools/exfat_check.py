"""Independent exFAT sanity check for card images written by refragmenter-card (spec checksums + directory walk)."""
import struct
import sys

f = open(sys.argv[1], "rb")


def rd(off, n):
    f.seek(off)
    return f.read(n)


b = rd(0, 512)
assert b[3:11] == b"EXFAT   ", "OEM name"
assert all(x == 0 for x in b[11:64]), "MustBeZero"
vol_len, fat_off, fat_len, heap, count, root, serial = struct.unpack_from("<QIIIIII", b, 72)
bps = 1 << b[108]
spc = 1 << b[109]
cb = bps * spc
print(f"volume {vol_len} sectors, fat@{fat_off} len {fat_len}, heap@{heap}, {count} clusters of {cb}, root {root}")

region = rd(0, 11 * 512)
c = 0
for i, x in enumerate(region):
    if i in (106, 107, 112):
        continue
    c = (((c >> 1) | ((c & 1) << 31)) + x) & 0xFFFFFFFF
stored = struct.unpack_from("<I", rd(11 * 512, 4))[0]
assert c == stored, f"boot checksum {c:08x} != {stored:08x}"
assert rd(12 * 512, 11 * 512 + 4) == rd(0, 11 * 512 + 4), "backup boot region differs"
print("boot checksum ok, backup ok")


def coff(cl):
    return heap * bps + (cl - 2) * cb


def fat(cl):
    return struct.unpack_from("<I", rd(fat_off * bps + cl * 4, 4))[0]


def walk(cl, path, contiguous_len=None):
    data = b""
    if contiguous_len:
        data = rd(coff(cl), contiguous_len)
    else:
        seen = 0
        while 2 <= cl < count + 2 and seen < 10000:
            data += rd(coff(cl), cb)
            cl = fat(cl)
            seen += 1
    i = 0
    while i + 32 <= len(data):
        t = data[i]
        if t == 0:
            break
        if t == 0x81:
            print(f"  {path}[bitmap] cluster {struct.unpack_from('<I', data, i + 20)[0]}")
        elif t == 0x82:
            cs, = struct.unpack_from("<I", data, i + 4)
            ucl, = struct.unpack_from("<I", data, i + 20)
            ulen, = struct.unpack_from("<Q", data, i + 24)
            u = rd(coff(ucl), ulen)
            c = 0
            for x in u:
                c = (((c >> 1) | ((c & 1) << 31)) + x) & 0xFFFFFFFF
            assert c == cs, "upcase checksum"
            print(f"  {path}[upcase] ok")
        elif t & 0x7F == 0x05:
            sec = data[i + 1]
            s = data[i : i + 32 * (sec + 1)]
            c = 0
            for k, x in enumerate(s):
                if k in (2, 3):
                    continue
                c = (((c >> 1) | ((c & 1) << 15)) + x) & 0xFFFF
            # Deleting only clears InUse bits, so deleted sets legitimately fail their checksum.
            assert t == 0x05 or c == struct.unpack_from("<H", s, 2)[0], "entry set checksum"
            st = s[32:64]
            nlen = st[3]
            name = b"".join(s[64 + 32 * k + 2 : 64 + 32 * k + 32] for k in range(sec - 1)).decode("utf-16le")[:nlen]
            first, = struct.unpack_from("<I", st, 20)
            size, = struct.unpack_from("<Q", st, 8)
            attr, = struct.unpack_from("<H", s, 4)
            nofat = st[1] & 2
            state = "deleted" if t == 0x05 else "live"
            print(f"  {path}{name} {'DIR' if attr & 0x10 else size} first={first} nofat={bool(nofat)} {state}")
            if attr & 0x10 and t == 0x85:
                walk(first, path + name + "/", size if nofat else None)
            i += 32 * sec
        i += 32


walk(root, "/")
print("exFAT structure ok")
