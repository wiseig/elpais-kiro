#!/usr/bin/env python3
"""Genera un PDF A4 desde Markdown sin dependencias externas."""

from __future__ import annotations

import re
import sys
import textwrap
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

PAGE_WIDTH = 595.28
PAGE_HEIGHT = 841.89
LEFT = 50.0
RIGHT = 50.0
TOP = 48.0
BOTTOM = 54.0
CONTENT_WIDTH = PAGE_WIDTH - LEFT - RIGHT


@dataclass(frozen=True)
class Style:
    font: str
    size: float
    leading: float
    before: float
    after: float
    color: tuple[float, float, float]
    indent: float = 0.0


STYLES = {
    "title": Style("F2", 25, 30, 8, 12, (0.08, 0.10, 0.11)),
    "h2": Style("F2", 16, 20, 13, 7, (0.05, 0.38, 0.39)),
    "h3": Style("F2", 11.5, 15, 8, 4, (0.08, 0.10, 0.11)),
    "body": Style("F1", 9.4, 12.5, 0, 5, (0.10, 0.11, 0.12)),
    "meta": Style("F1", 8.8, 11.5, 0, 3, (0.34, 0.38, 0.40)),
    "bullet": Style("F1", 9.2, 12.2, 0, 2.5, (0.10, 0.11, 0.12), 12),
    "code": Style("F3", 7.3, 9.6, 2, 2, (0.16, 0.18, 0.19), 10),
    "quote": Style("F4", 9.0, 12.2, 2, 5, (0.30, 0.34, 0.36), 12),
}


@dataclass
class Block:
    kind: str
    text: str = ""


def clean_inline(value: str) -> str:
    value = value.replace("**", "").replace("__", "").replace("`", "")
    value = re.sub(r"\[([^]]+)]\(([^)]+)\)", r"\1 (\2)", value)
    return value


def parse_markdown(markdown: str) -> list[Block]:
    blocks: list[Block] = []
    in_code = False
    first_rule = True

    for raw in markdown.splitlines():
        stripped = raw.strip()
        if stripped.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            blocks.append(Block("code", raw or " "))
        elif stripped == "---":
            if first_rule:
                blocks.append(Block("pagebreak"))
                first_rule = False
            else:
                blocks.append(Block("rule"))
        elif not stripped:
            blocks.append(Block("blank"))
        elif stripped.startswith("# "):
            blocks.append(Block("title", clean_inline(stripped[2:])))
        elif stripped.startswith("## "):
            blocks.append(Block("h2", clean_inline(stripped[3:])))
        elif stripped.startswith("### "):
            blocks.append(Block("h3", clean_inline(stripped[4:])))
        elif stripped.startswith("- "):
            blocks.append(Block("bullet", "• " + clean_inline(stripped[2:])))
        elif re.match(r"^\d+\.\s+", stripped):
            blocks.append(Block("bullet", clean_inline(stripped)))
        elif stripped.startswith("> "):
            blocks.append(Block("quote", clean_inline(stripped[2:])))
        elif stripped.startswith("**"):
            blocks.append(Block("meta", clean_inline(stripped)))
        else:
            blocks.append(Block("body", clean_inline(stripped)))
    return blocks


def normalize_pdf_text(value: str) -> str:
    replacements = {
        "→": "->", "←": "<-", "↗": "^", "│": "|", "─": "-", "└": "+",
        "├": "+", "┬": "+", "┴": "+", "▼": "v", "►": ">", "…": "...",
        "“": '"', "”": '"', "‘": "'", "’": "'", "": "",
    }
    for old, new in replacements.items():
        value = value.replace(old, new)
    return value


def pdf_string(value: str) -> bytes:
    data = normalize_pdf_text(value).encode("cp1252", errors="replace")
    return data.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def max_chars(style: Style) -> int:
    average = 0.60 if style.font == "F3" else 0.50
    usable = CONTENT_WIDTH - style.indent
    return max(22, int(usable / (style.size * average)))


def wrap_block(block: Block, style: Style) -> list[str]:
    if block.kind == "code":
        return textwrap.wrap(
            normalize_pdf_text(block.text), width=max_chars(style), replace_whitespace=False,
            drop_whitespace=False, break_long_words=False, break_on_hyphens=False,
        ) or [" "]
    prefix = ""
    subsequent = ""
    text = block.text
    if block.kind == "bullet":
        if text.startswith("• "):
            prefix = "• "
            text = text[2:]
            subsequent = "  "
        else:
            match = re.match(r"^(\d+\.\s+)(.*)$", text)
            if match:
                prefix, text = match.group(1), match.group(2)
                subsequent = " " * len(prefix)
    return textwrap.wrap(
        normalize_pdf_text(text), width=max_chars(style), initial_indent=prefix,
        subsequent_indent=subsequent, break_long_words=False, break_on_hyphens=False,
    ) or [prefix.rstrip()]


def text_command(x: float, y: float, value: str, style: Style) -> bytes:
    r, g, b = style.color
    escaped = pdf_string(value)
    return (
        f"BT /{style.font} {style.size:.2f} Tf {r:.3f} {g:.3f} {b:.3f} rg "
        f"1 0 0 1 {x:.2f} {y:.2f} Tm (".encode("ascii") + escaped + b") Tj ET\n"
    )


def page_base(page_number: int) -> bytearray:
    content = bytearray()
    content.extend(b"1 1 1 rg 0 0 595.28 841.89 re f\n")
    content.extend(b"0.05 0.38 0.39 rg 0 832.89 595.28 9 re f\n")
    header = Style("F2", 7.2, 9, 0, 0, (0.34, 0.38, 0.40))
    footer = Style("F1", 7.2, 9, 0, 0, (0.34, 0.38, 0.40))
    content.extend(text_command(LEFT, PAGE_HEIGHT - 29, "PREGUNTALE A EL PAÍS  ·  INFORME DEL PROTOTIPO", header))
    content.extend(b"0.82 0.85 0.86 RG 0.6 w 50 43 m 545.28 43 l S\n")
    content.extend(text_command(LEFT, 27, f"4 de setiembre de 2026  ·  Página {page_number}", footer))
    return content


def render(blocks: list[Block]) -> list[bytes]:
    pages: list[bytes] = []
    page_number = 1
    content = page_base(page_number)
    y = PAGE_HEIGHT - TOP - 18

    def new_page() -> None:
        nonlocal content, y, page_number
        pages.append(bytes(content))
        page_number += 1
        content = page_base(page_number)
        y = PAGE_HEIGHT - TOP - 18

    for block in blocks:
        if block.kind == "pagebreak":
            if len(content) > len(page_base(page_number)):
                new_page()
            continue
        if block.kind == "blank":
            y -= 4
            continue
        if block.kind == "rule":
            if y < BOTTOM + 12:
                new_page()
            content.extend(f"0.82 0.85 0.86 RG 0.6 w {LEFT:.2f} {y:.2f} m {PAGE_WIDTH-RIGHT:.2f} {y:.2f} l S\n".encode("ascii"))
            y -= 10
            continue

        style = STYLES[block.kind]
        lines = wrap_block(block, style)
        needed = style.before + len(lines) * style.leading + style.after
        if block.kind in {"title", "h2", "h3"} and y - needed < BOTTOM + 24:
            new_page()
        elif y - needed < BOTTOM:
            new_page()

        y -= style.before
        for line in lines:
            if y < BOTTOM:
                new_page()
            content.extend(text_command(LEFT + style.indent, y, line, style))
            y -= style.leading
        y -= style.after

    pages.append(bytes(content))
    return pages


def build_pdf(pages: list[bytes], destination: Path) -> None:
    # 1 catalog, 2 pages tree, 3-6 fonts, then page/content pairs, final info.
    objects: dict[int, bytes] = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        4: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
        6: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>",
    }
    kids: list[str] = []
    next_id = 7
    for page_stream in pages:
        page_id = next_id
        stream_id = next_id + 1
        next_id += 2
        kids.append(f"{page_id} 0 R")
        objects[page_id] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_WIDTH:.2f} {PAGE_HEIGHT:.2f}] "
            "/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> "
            f"/Contents {stream_id} 0 R >>"
        ).encode("ascii")
        objects[stream_id] = (
            f"<< /Length {len(page_stream)} >>\nstream\n".encode("ascii")
            + page_stream + b"endstream"
        )

    objects[2] = f"<< /Type /Pages /Count {len(pages)} /Kids [{' '.join(kids)}] >>".encode("ascii")
    info_id = next_id
    created = datetime.now(timezone.utc).strftime("D:%Y%m%d%H%M%SZ")
    objects[info_id] = (
        b"<< /Title (Preguntale a El Pa\355s - Informe tecnico y de avance) "
        b"/Author (Equipo Preguntale a El Pa\355s) /Creator (Kiro PDF generator) "
        + f"/CreationDate ({created}) >>".encode("ascii")
    )

    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0] * (info_id + 1)
    for object_id in range(1, info_id + 1):
        offsets[object_id] = len(output)
        output.extend(f"{object_id} 0 obj\n".encode("ascii"))
        output.extend(objects[object_id])
        output.extend(b"\nendobj\n")

    xref = len(output)
    output.extend(f"xref\n0 {info_id + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for object_id in range(1, info_id + 1):
        output.extend(f"{offsets[object_id]:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {info_id + 1} /Root 1 0 R /Info {info_id} 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n".encode("ascii")
    )
    destination.write_bytes(output)


def main() -> int:
    if len(sys.argv) != 3:
        print("Uso: generate-project-report.py <entrada.md> <salida.pdf>", file=sys.stderr)
        return 2
    source = Path(sys.argv[1]).resolve()
    destination = Path(sys.argv[2]).resolve()
    if not source.is_file():
        print(f"No existe la fuente: {source}", file=sys.stderr)
        return 2
    destination.parent.mkdir(parents=True, exist_ok=True)
    blocks = parse_markdown(source.read_text(encoding="utf-8"))
    pages = render(blocks)
    build_pdf(pages, destination)
    data = destination.read_bytes()
    if not data.startswith(b"%PDF-") or not data.rstrip().endswith(b"%%EOF"):
        print("El resultado no es un PDF válido", file=sys.stderr)
        return 1
    print(f"PDF generado: {destination} ({len(pages)} páginas, {len(data):,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
