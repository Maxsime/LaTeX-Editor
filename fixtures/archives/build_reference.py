"""Builds reference-report.zip, the project archive used by the J1 import tests.

It mimics a Prism or Overleaf export of a multi-file report: local class,
bibliography, chapters in a subfolder, PNG and PDF figures, explicit directory
entries with Unix modes, an empty folder, and text files whose exact bytes
must survive an import/export round trip (CRLF, BOM, no final newline,
Latin-1). Run with `python3 build_reference.py`; the output is deterministic.
"""

import struct
import zipfile
import zlib
from pathlib import Path

STAMP = (2026, 10, 26, 12, 0, 0)
FILE_MODE = 0o100644 << 16
DIR_MODE = (0o040755 << 16) | 0x10


def png(width: int, height: int, shade: int) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    rows = b"".join(b"\x00" + bytes([shade, 255 - shade, (shade * 7) % 256]) * width for _ in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def pdf(label: str) -> bytes:
    stream = f"BT /F1 18 Tf 20 40 Td ({label}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 80] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


MAIN = r"""\documentclass[11pt]{rapport-local}

\usepackage[french]{babel}
\usepackage{graphicx}
\usepackage[backend=biber]{biblatex}
\addbibresource{references.bib}

\titre{Rapport de projet}
\auteur{Équipe de test}

\begin{document}
\pagedegarde{logos/entete.pdf}
\tableofcontents

\input{chapitres/01_introduction}
\input{chapitres/02_mesures}
\input{chapitres/conclusion}

\printbibliography
\end{document}
"""

CLASS = r"""\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{rapport-local}[2026/10/26 Classe locale de test]
\LoadClass[a4paper]{report}
\RequirePackage[T1]{fontenc}
\RequirePackage{geometry}
\geometry{margin=2.5cm}
\newcommand{\titre}[1]{\title{#1}}
\newcommand{\auteur}[1]{\author{#1}}
\newcommand{\pagedegarde}[1]{%
  \begin{titlepage}\centering\includegraphics[width=6cm]{#1}\par\vspace{2cm}%
  \makeatletter{\Huge\@title\par}\makeatother\end{titlepage}}
\endinput
"""

BIB = """@article{dupont2024,
  author  = {Dupont, Claire and Martin, Léo},
  title   = {Mesures de latence sur bus synchrone},
  journal = {Revue d'électronique},
  year    = {2024},
  volume  = {12},
  pages   = {33--41},
}
"""

INTRO = "\ufeff\\chapter{Introduction}\n\nCe rapport présente les mesures~\\cite{dupont2024}.\n"
MESURES = (
    "\\chapter{Mesures}\r\n\r\n"
    "\\begin{figure}[h]\r\n  \\centering\r\n"
    "  \\includegraphics[width=.6\\linewidth]{figures/02_mesures/banc1.png}\r\n"
    "  \\caption{Banc de mesure.}\r\n\\end{figure}\r\n"
)
CONCLUSION = "\\chapter{Conclusion}\n\nRésultats conformes."  # no final newline
LEGACY = "% Ancien fichier en Latin-1 : café, été.\n".encode("latin-1")

ENTRIES: list[tuple[str, bytes | None]] = [
    ("main.tex", MAIN.encode()),
    ("rapport-local.cls", CLASS.encode()),
    ("references.bib", BIB.encode()),
    ("chapitres/", None),
    ("chapitres/01_introduction.tex", INTRO.encode()),
    ("chapitres/02_mesures.tex", MESURES.encode()),
    ("chapitres/conclusion.tex", CONCLUSION.encode()),
    ("chapitres/ancien-latin1.tex", LEGACY),
    ("figures/", None),
    ("figures/02_mesures/", None),
    ("figures/02_mesures/banc1.png", png(64, 32, 40)),
    ("figures/02_mesures/banc2.png", png(48, 48, 200)),
    ("figures/vue d'ensemble.png", png(16, 16, 120)),
    ("logos/", None),
    ("logos/entete.pdf", pdf("Galley")),
    ("annexes/", None),
]


def main() -> None:
    target = Path(__file__).with_name("reference-report.zip")
    with zipfile.ZipFile(target, "w") as archive:
        for name, data in ENTRIES:
            info = zipfile.ZipInfo(name, STAMP)
            info.create_system = 3
            if data is None:
                info.external_attr = DIR_MODE
                archive.writestr(info, b"")
            else:
                info.external_attr = FILE_MODE
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data)
    print(f"wrote {target}")


if __name__ == "__main__":
    main()
