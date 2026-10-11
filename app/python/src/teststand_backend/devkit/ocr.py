"""Text of figures and scanned pages, offline: PDFium renders, Windows OCR reads.

Pin tables of many manuals are pictures: the PDF has no text for them. :func:`pages_to_ocr`
finds pages that are mostly picture, :func:`render_png` renders a page, :func:`recognize` runs
the Windows built-in OCR (``Windows.Media.Ocr``, in process through WinRT) and :func:`rows` rebuilds
table rows from word positions, so a connector figure reads ``DIO0 68 34 DIO1``.

OCR output is a reading aid, never a source of truth: it is labelled as such in the document.
"""

from __future__ import annotations

import asyncio
import struct
import sys
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

Record = dict[str, Any]

RENDER_SCALE = 4.0
"""About 290 dpi: the Chinese recognizer reads 8-point table text reliably from there."""
MAX_PIXELS = 9000
IMAGE_SHARE = 0.12
"""A page whose pictures cover at least this share of it is read by OCR."""
MAX_OCR_PAGES = 60
OCR_TIMEOUT_S = 600.0
UPSCALE_WIDTH = 2400.0
UPSCALE_LIMIT = 4.0
CONFUSIONS = "IO→℃ or 10, I→l/1/|, O→0, VIN→训N/VlN; spaces may split words"


def available() -> bool:
    return sys.platform == "win32"


def _png_gray(width: int, height: int, stride: int, channels: int, buffer: bytes) -> bytes:
    rows = []
    for y in range(height):
        row = buffer[y * stride : y * stride + width * channels]
        if channels == 1:
            rows.append(b"\0" + row)
        else:  # BGR(A) -> luminance
            blue, green, red = row[0::channels], row[1::channels], row[2::channels]
            rows.append(
                b"\0"
                + bytes(
                    (b * 29 + g * 150 + r * 77) >> 8
                    for b, g, r in zip(blue, green, red, strict=True)
                )
            )

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 6))
        + chunk(b"IEND", b"")
    )


def pages_to_ocr(path: Path, texts: list[str], mode: str) -> list[int]:
    """Zero-based pages to read by OCR: ``all``, ``none``, or (``auto``) pages that are mostly
    picture or have almost no text."""
    if mode == "none" or not available():
        return []
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(str(path))
    try:
        chosen = []
        for index in range(len(document)):
            if mode == "all":
                chosen.append(index)
                continue
            page = document[index]
            width, height = page.get_size()
            area = 0.0
            for item in page.get_objects(filter=(pdfium.raw.FPDF_PAGEOBJ_IMAGE,), max_depth=4):
                left, bottom, right, top = item.get_bounds()
                area += max(0.0, right - left) * max(0.0, top - bottom)
            text = texts[index] if index < len(texts) else ""
            if area >= IMAGE_SHARE * width * height or len(text.strip()) < 40:
                chosen.append(index)
        return chosen[:MAX_OCR_PAGES]
    finally:
        document.close()


def render_png(path: Path, index: int) -> bytes:
    """Page ``index`` as a grayscale PNG at about 290 dpi."""
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(str(path))
    try:
        page = document[index]
        width, height = page.get_size()
        scale = min(RENDER_SCALE, MAX_PIXELS / max(width, height, 1.0))
        bitmap = page.render(scale=scale, grayscale=True)
        return _png_gray(
            bitmap.width, bitmap.height, bitmap.stride, bitmap.n_channels, bytes(bitmap.buffer)
        )
    finally:
        document.close()


def recognize(images: list[Path], timeout_s: float = OCR_TIMEOUT_S) -> list[Record]:
    """Windows OCR of ``images``: ``[{path, language, width, height, words}]``.

    The engine runs in this process through the WinRT projection: no PowerShell or other child
    process, which security software may forbid an unsigned executable to start. It runs on a
    worker thread with its own event loop, so callers may hold a loop of their own.
    """
    if not images:
        return []
    if not available():
        raise RuntimeError("OCR needs the Windows built-in OCR engine")
    with ThreadPoolExecutor(1, thread_name_prefix="ocr") as pool:
        future = pool.submit(asyncio.run, _recognize_all(images))
        return future.result(timeout=timeout_s)


async def _recognize_all(images: list[Path]) -> list[Record]:
    from winrt.windows.graphics.imaging import (
        BitmapAlphaMode,
        BitmapDecoder,
        BitmapInterpolationMode,
        BitmapPixelFormat,
        BitmapTransform,
        ColorManagementMode,
        ExifOrientationMode,
    )
    from winrt.windows.media.ocr import OcrEngine
    from winrt.windows.storage import FileAccessMode, StorageFile

    engine = OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        languages = list(OcrEngine.available_recognizer_languages)
        if not languages:
            raise RuntimeError("No Windows OCR language is installed")
        engine = OcrEngine.try_create_from_language(languages[0])
    if engine is None:
        raise RuntimeError("The Windows OCR engine cannot be created")
    limit = float(OcrEngine.max_image_dimension)
    results: list[Record] = []
    for image in images:
        file = await StorageFile.get_file_from_path_async(str(Path(image).resolve()))
        stream = await file.open_async(FileAccessMode.READ)
        try:
            decoder = await BitmapDecoder.create_async(stream)
            width, height = decoder.pixel_width, decoder.pixel_height
            # Small text reads badly: scale to about 2400 px wide, within the engine's limit.
            scale = max(1.0, min(UPSCALE_LIMIT, UPSCALE_WIDTH / max(1, width)))
            scale = min(scale, limit / max(width, height, 1))
            transform = BitmapTransform()
            transform.scaled_width = int(width * scale)
            transform.scaled_height = int(height * scale)
            transform.interpolation_mode = BitmapInterpolationMode.FANT
            bitmap = await decoder.get_software_bitmap_transformed_async(
                BitmapPixelFormat.BGRA8,
                BitmapAlphaMode.PREMULTIPLIED,
                transform,
                ExifOrientationMode.RESPECT_EXIF_ORIENTATION,
                ColorManagementMode.DO_NOT_COLOR_MANAGE,
            )
            result = await engine.recognize_async(bitmap)
        finally:
            stream.close()
        words = [
            {
                "text": word.text,
                "x": word.bounding_rect.x,
                "y": word.bounding_rect.y,
                "w": word.bounding_rect.width,
                "h": word.bounding_rect.height,
            }
            for line in result.lines
            for word in line.words
        ]
        results.append(
            {
                "path": str(image),
                "language": engine.recognizer_language.language_tag,
                "width": bitmap.pixel_width,
                "height": bitmap.pixel_height,
                "words": words,
            }
        )
    return results


def _cjk(text: str) -> bool:
    return bool(text) and "一" <= text[0] <= "鿿"


def rows(words: list[Record]) -> list[str]:
    """Lines of text rebuilt from word boxes: words whose vertical centres are close form a
    row, read left to right (a table row keeps its cells in order)."""
    ordered = sorted(words, key=lambda word: float(word["y"]) + float(word["h"]) / 2)
    groups: list[tuple[float, list[Record]]] = []
    for word in ordered:
        centre = float(word["y"]) + float(word["h"]) / 2
        tolerance = max(6.0, 0.55 * float(word["h"]))
        if groups and abs(centre - groups[-1][0]) <= tolerance:
            mean, members = groups[-1]
            members.append(word)
            groups[-1] = ((mean * (len(members) - 1) + centre) / len(members), members)
        else:
            groups.append((centre, [word]))
    lines = []
    for _, members in groups:
        text = ""
        for word in sorted(members, key=lambda item: float(item["x"])):
            piece = str(word["text"])
            text += piece if text and _cjk(piece) and _cjk(text[-1]) else f" {piece}"
        if text.strip():
            lines.append(text.strip())
    return lines
