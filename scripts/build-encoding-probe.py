#!/usr/bin/env python3
# Regenerate the accountant encoding-probe kit — byte-identical every run.
#
# Five files (into the target dir, default accountant-encoding-probe/):
#   probe-1-utf8-flagged.zip   UTF-8 entry names, UTF-8 general-purpose flag SET
#   probe-2-cp932-noflag.zip   CP932 (Shift-JIS) entry names, flag CLEAR
#                              (entry 03 omitted: ㉑ U+3251 is absent from CP932)
#   probe-3-utf8-noflag.zip    UTF-8 entry names, flag CLEAR
#   content-utf8-bom.csv       CSV content probe, UTF-8 + BOM
#   content-cp932.csv          CSV content probe, Shift-JIS (no BOM)
#
# Determinism: every entry uses a fixed date_time, STORED compression, no
# extra fields. The three ZIP variants differ ONLY in how the entry-name bytes
# and the UTF-8 flag bit are produced, via a ZipInfo._encodeFilenameFlags
# override (Python's default would leave ASCII names unflagged, but probe-1
# flags every entry, including 00_README.txt — hence the explicit override).
#
# Verify: shasum -a 256 *.zip *.csv  vs  accountant-encoding-probe/CHECKSUMS.txt
#
# Background: docs/2026-06-pack-approved-delta.md (encoding probe) and
# accountant-encoding-probe/SEND-PROCEDURE.md.
import os
import sys
import zipfile

DATE_TIME = (2026, 8, 7, 12, 0, 0)  # fixed DOS timestamp → deterministic output

_MASK_UTF8_FLAG = 0x800

# The seven probe entries — the "correct" unicode names the accountant should
# see. The ASCII 00–06 prefixes survive any encoding so he can report which
# rendered. Entry 03 carries ㉑ (U+3251), absent from CP932, so it is dropped
# from probe-2.
NAMES = [
    "00_README.txt",
    "01_会議費Jun2026③小田原みなと食堂￥6,490.txt",
    "02_旅費交通費Jun2026⑭セブン-イレブン東中野末広橋店￥10,000.txt",
    "03_旅費交通費Jun2026㉑テスト商店￥1,234.txt",
    "04_旅費交通費Jun2026(21)テスト商店￥1,234.txt",
    "05_広告宣伝費Jun2026①〔BtoB〕ラクスル￥886.txt",
    "AMEXカード利用領収書2026年6月4日支払い分/06_フォルダ内テスト.txt",
]
CIRCLED21_NAME = NAMES[3]  # the ㉑ entry, omitted from the CP932 probe

README_TEMPLATE = (
    "﻿【文字コード検証 {n}】合同会社Dazbeez\r\n"
    "==================================================\r\n"
    "\r\n"
    "この ZIP を解凍し、ファイル名が正しく表示されるかご確認ください。\r\n"
    "各ファイルを開くと「正しい名前」が書いてあります。表示名と見比べてください。\r\n"
    "\r\n"
    "確認していただきたい点:\r\n"
    "  01 … 通常の証憑名（丸数字③・全角￥）\r\n"
    "  02 … 6月に実在した最大番号（⑭）\r\n"
    "  03 … 丸数字㉑（21以上）※この検証には含まれない場合があります\r\n"
    "  04 … 21以上を (21) と半角表記した代替案\r\n"
    "  05 … 〔BtoB〕などの記号\r\n"
    "  06 … フォルダ名（AMEXカード利用領収書2026年6月4日支払い分）\r\n"
    "\r\n"
    "先頭の番号（00〜06）は半角数字なので、名前が文字化けしていても\r\n"
    "「01は正しい」「03は文字化け」のようにご回答いただけます。\r\n"
)

NAME_ENTRY_TEMPLATE = (
    "﻿このファイルの正しい名前 / The correct name of this file:\r\n"
    "  {name}\r\n"
    "\r\n"
    "上の名前と、実際に表示されているファイル名を見比べてください。\r\n"
    "（この ZIP は 検証{n} です）\r\n"
)

CSV_TEXT = (
    "科目,店舗名,金額,丸数字\r\n"
    "会議費,小田原みなと食堂,￥6490,③\r\n"
    "旅費交通費,セブン-イレブン東中野末広橋店,￥10000,⑭\r\n"
)


# --- ZipInfo subclasses: control entry-name encoding + the UTF-8 flag bit. --
# Python's default _encodeFilenameFlags encodes non-ASCII names as UTF-8 and
# sets the flag, but leaves ASCII names unflagged. These overrides force the
# intended bit on every entry so the three probes isolate exactly one variable.

class _Utf8Flag(zipfile.ZipInfo):
    """UTF-8 entry names, UTF-8 flag SET on every entry (incl. ASCII)."""

    def _encodeFilenameFlags(self):
        return self.filename.encode("utf-8"), self.flag_bits | _MASK_UTF8_FLAG


class _Cp932NoFlag(zipfile.ZipInfo):
    """CP932 (Shift-JIS) entry names, UTF-8 flag CLEAR."""

    def _encodeFilenameFlags(self):
        return self.filename.encode("cp932"), self.flag_bits


class _Utf8NoFlag(zipfile.ZipInfo):
    """UTF-8 entry names, UTF-8 flag CLEAR (the common broken middle case)."""

    def _encodeFilenameFlags(self):
        return self.filename.encode("utf-8"), self.flag_bits


def _content_for(name, variant):
    if name == "00_README.txt":
        return README_TEMPLATE.format(n=variant).encode("utf-8")
    return NAME_ENTRY_TEMPLATE.format(name=name, n=variant).encode("utf-8")


def _build_zip(path, zinfo_cls, variant, drop_circled21):
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as z:
        for name in NAMES:
            if drop_circled21 and name == CIRCLED21_NAME:
                continue
            zi = zinfo_cls(name, date_time=DATE_TIME)
            zi.compress_type = zipfile.ZIP_STORED
            z.writestr(zi, _content_for(name, variant))


def build(target_dir):
    os.makedirs(target_dir, exist_ok=True)
    _build_zip(os.path.join(target_dir, "probe-1-utf8-flagged.zip"), _Utf8Flag, 1, False)
    _build_zip(os.path.join(target_dir, "probe-2-cp932-noflag.zip"), _Cp932NoFlag, 2, True)
    _build_zip(os.path.join(target_dir, "probe-3-utf8-noflag.zip"), _Utf8NoFlag, 3, False)
    with open(os.path.join(target_dir, "content-utf8-bom.csv"), "wb") as f:
        f.write(b"\xef\xbb\xbf" + CSV_TEXT.encode("utf-8"))
    with open(os.path.join(target_dir, "content-cp932.csv"), "wb") as f:
        f.write(CSV_TEXT.encode("cp932"))


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "accountant-encoding-probe"
    build(target)
    print(f"wrote 5 probe files to {os.path.abspath(target)}/")
