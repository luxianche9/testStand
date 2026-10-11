"""Turn a device manual into text the agent can read and cite (design doc 8.5).

Local models cannot read PDF attachments, and vendor documents come as PDF, Word or Excel.
:func:`extract` returns plain text (Markdown with page / sheet headings); :func:`convert`
writes it to ``<project>/docs/<name>.md``, which the import tool registers as a reference.
Pages that are mostly picture (connector figures, scans) and image files are read by the
offline Windows OCR (:mod:`.ocr`); their text is marked as OCR and the rendered pages are kept
next to the document. Old binary formats (.doc, .xls) are not readable; the user saves them
as .docx / .xlsx / .pdf.
"""

from __future__ import annotations

import hashlib
import logging
import re
import tempfile
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from teststand_backend.contracts.errors import AppError

from . import ocr

Record = dict[str, Any]
log = logging.getLogger(__name__)

TEXT_SUFFIXES = frozenset(
    {
        ".txt",
        ".md",
        ".h",
        ".hpp",
        ".c",
        ".cpp",
        ".cs",
        ".py",
        ".ini",
        ".inf",
        ".csv",
        ".json",
        ".xml",
        ".log",
        ".bas",
        ".vb",
        ".def",
    }
)
IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".gif"})
SUPPORTED = TEXT_SUFFIXES | IMAGE_SUFFIXES | {".pdf", ".docx", ".xlsx"}
OCR_MODES = ("auto", "all", "none")
MAX_SOURCE = 200 * 1024 * 1024
MAX_TEXT = 4 * 1024 * 1024 - 4096
DOCS_DIR = "docs"
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _decode(data: bytes) -> str:
    for encoding in ("utf-8-sig", "gb18030", "utf-16"):
        try:
            text = data.decode(encoding)
        except UnicodeDecodeError:
            continue
        if "\x00" not in text:
            return text
    return data.decode("latin-1")


def _ocr_block(lines: list[str], image: str | None) -> str:
    where = f"\nPage image: {image}" if image else ""
    return (
        f"\n### Text read from the picture (OCR, verify; common misreads: {ocr.CONFUSIONS})"
        f"{where}\n\n```text\n" + "\n".join(lines) + "\n```\n"
    )


def _pdf(path: Path, images: Path | None, mode: str) -> tuple[str, int, int, str | None]:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    texts = []
    for page in reader.pages:
        try:
            texts.append((page.extract_text() or "").strip())
        except Exception as error:  # a damaged page must not lose the rest of the manual
            texts.append(f"(page text unreadable: {type(error).__name__})")
    extra: dict[int, str] = {}
    note = None
    try:
        chosen = ocr.pages_to_ocr(path, texts, mode)
        rendered: list[tuple[int, Path]] = []
        if chosen:
            folder = images or Path(tempfile.mkdtemp(prefix="teststand-ocr-"))
            folder.mkdir(parents=True, exist_ok=True)
            for index in chosen:
                target = folder / f"page-{index + 1:03d}.png"
                target.write_bytes(ocr.render_png(path, index))
                rendered.append((index, target))
            results = ocr.recognize([target for _, target in rendered])
            for (index, target), result in zip(rendered, results, strict=True):
                lines = ocr.rows(result.get("words", []))
                relative = f"{folder.parent.name}/{folder.name}/{target.name}" if images else None
                if lines:
                    extra[index] = _ocr_block(lines, relative)
    except Exception as error:  # OCR is an aid: the text layer stands on its own
        log.warning("OCR of %s failed", path.name, exc_info=True)
        note = f"OCR skipped: {type(error).__name__}: {error}"
    pages = [
        f"## Page {number}\n\n{text}\n{extra.get(number - 1, '')}"
        for number, text in enumerate(texts, 1)
    ]
    return "\n".join(pages), len(reader.pages), len(extra), note


def _image(path: Path) -> tuple[str, int]:
    [result] = ocr.recognize([path])
    lines = ocr.rows(result.get("words", []))
    return (_ocr_block(lines, None) if lines else ""), 1


def _docx(path: Path) -> tuple[str, int]:
    with zipfile.ZipFile(path) as archive:
        root = ElementTree.fromstring(archive.read("word/document.xml"))
    blocks: list[str] = []
    body = root.find(f"{_W}body")
    for element in body if body is not None else []:
        if element.tag == f"{_W}p":
            text = "".join(node.text or "" for node in element.iter(f"{_W}t"))
            style = element.find(f"{_W}pPr/{_W}pStyle")
            level = re.search(r"(\d)", style.get(f"{_W}val", "")) if style is not None else None
            if text.strip():
                heading = style is not None and "eading" in style.get(f"{_W}val", "")
                blocks.append(f"{'#' * int(level[1]) if heading and level else ''} {text}".strip())
        elif element.tag == f"{_W}tbl":
            for row in element.iter(f"{_W}tr"):
                cells = [
                    " ".join(t.text or "" for t in cell.iter(f"{_W}t")).strip()
                    for cell in row.iter(f"{_W}tc")
                ]
                blocks.append("| " + " | ".join(cells) + " |")
    return "\n\n".join(blocks), 0


def _xlsx(path: Path) -> tuple[str, int]:
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            strings = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(t.text or "" for t in item.iter(f"{_S}t")) for item in strings]
        workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
        sheet_names = [sheet.get("name", "") for sheet in workbook.iter(f"{_S}sheet")]
        sections = []
        for index, name in enumerate(sheet_names, 1):
            member = f"xl/worksheets/sheet{index}.xml"
            if member not in names:
                continue
            sheet = ElementTree.fromstring(archive.read(member))
            rows = []
            for row in sheet.iter(f"{_S}row"):
                cells = []
                for cell in row.iter(f"{_S}c"):
                    value = cell.find(f"{_S}v")
                    inline = cell.find(f"{_S}is")
                    if cell.get("t") == "s" and value is not None and value.text:
                        text = shared[int(value.text)] if int(value.text) < len(shared) else ""
                    elif inline is not None:
                        text = "".join(t.text or "" for t in inline.iter(f"{_S}t"))
                    else:
                        text = value.text if value is not None and value.text else ""
                    cells.append(f"{cell.get('r', '')}={text}" if text else "")
                if any(cells):
                    rows.append(" | ".join(c for c in cells if c))
            sections.append(f"## Sheet {name}\n\n" + "\n".join(rows))
    return "\n\n".join(sections), len(sections)


def extract(path: Path, images: Path | None = None, mode: str = "auto") -> Record:
    """``{text, format, pages, ocrPages}`` of a supported document; rendered OCR pages go to
    ``images`` (``mode``: ``auto`` pages that are mostly picture, ``all``, ``none``)."""
    suffix = path.suffix.lower()
    if suffix in {".doc", ".xls", ".ppt"}:
        raise AppError(
            "invalid_argument",
            f"{suffix} is an old binary Office format that cannot be read",
            {"recovery": "Ask the user to save it as .docx/.xlsx or print it to PDF."},
        )
    if suffix not in SUPPORTED:
        raise AppError(
            "invalid_argument",
            f"Unsupported document type {suffix or '(none)'}; supported: "
            + ", ".join(sorted(SUPPORTED)),
        )
    if not path.is_file():
        raise AppError("not_found", f"{path} is not a file")
    if path.stat().st_size > MAX_SOURCE:
        raise AppError("invalid_argument", "Documents are limited to 200 MiB")
    ocr_pages, note = 0, None
    try:
        if suffix == ".pdf":
            text, pages, ocr_pages, note = _pdf(path, images, mode)
        elif suffix in IMAGE_SUFFIXES:
            if mode == "none":
                raise AppError("invalid_argument", "An image has text only through OCR")
            text, pages = _image(path)
            ocr_pages = 1
        elif suffix == ".docx":
            text, pages = _docx(path)
        elif suffix == ".xlsx":
            text, pages = _xlsx(path)
        else:
            text, pages = _decode(path.read_bytes()), 0
    except AppError:
        raise
    except Exception as error:
        raise AppError(
            "invalid_argument", f"{path.name} cannot be read: {type(error).__name__}: {error}"
        ) from error
    text = text.replace("\x00", "")
    if not text.strip():
        raise AppError(
            "invalid_argument",
            f"{path.name} has no extractable text (probably scanned images)",
            {"recovery": "Ask the user for a text version or the relevant values."},
        )
    result: Record = {
        "text": text,
        "format": suffix.lstrip("."),
        "pages": pages,
        "ocrPages": ocr_pages,
    }
    if note:
        result["note"] = note
    return result


def _slug(stem: str) -> str:
    ascii_part = re.sub(r"[^A-Za-z0-9]+", "-", stem).strip("-").lower()[:40]
    digest = hashlib.sha256(stem.encode()).hexdigest()[:8]
    return f"{ascii_part}-{digest}" if ascii_part else f"doc-{digest}"


def convert(source: Path, project: Path, mode: str = "auto") -> Record:
    """Write ``docs/<slug>.md`` and its OCR page images ``docs/<slug>/page-NNN.png``
    (overwrites a previous conversion of the same file)."""
    slug = _slug(source.stem)
    images = project / DOCS_DIR / slug
    extracted = extract(source, images, mode)
    text = extracted["text"]
    truncated = len(text) > MAX_TEXT
    if truncated:
        text = text[:MAX_TEXT] + "\n\n(…truncated at 4 MiB…)\n"
    target = project / DOCS_DIR / f"{slug}.md"
    target.parent.mkdir(exist_ok=True)
    header = f"# {source.name}\n\nSource: {source}\n\n"
    target.write_text(header + text, encoding="utf-8", newline="\n")
    return {
        "slug": slug,
        "path": target.relative_to(project).as_posix(),
        "format": extracted["format"],
        "pages": extracted["pages"],
        "characters": len(text),
        "truncated": truncated,
        "ocrPages": extracted["ocrPages"],
        **({"note": extracted["note"]} if "note" in extracted else {}),
    }
