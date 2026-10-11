from __future__ import annotations

import asyncio
import json
import zipfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from teststand_backend.contracts.errors import AppError
from teststand_backend.devices.plugin_store import PluginStore
from teststand_backend.devkit import documents, kit, runner, tools

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


def _resolve_todos(project: Path, adapter: str) -> None:
    for path in (project / "plugins" / adapter).rglob("*"):
        if path.suffix in {".py", ".md", ".toml"}:
            path.write_text(
                path.read_text("utf-8").replace("TODO(new_device)", "NOTE"), encoding="utf-8"
            )


def _app(project: Path) -> Any:
    devices = SimpleNamespace(
        get_hardware=lambda context, hardware_id: {"hardwareId": hardware_id},
        list_devices=lambda context: [{"deviceId": "DEMO_IO", "type": "demo_io"}],
    )
    projects = SimpleNamespace(document=lambda context: {"rootPath": str(project)})
    return SimpleNamespace(projects=projects, devices=devices)


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, dict[str, Any]]:
    """One adapter scaffolded, checked (TODOs left) and then packaged, shared by the tests."""
    project = tmp_path_factory.mktemp("project")
    created = kit.scaffold(project, "demo_io", "demo", "DEMO-8", "Acme")
    first = asyncio.run(kit.check(project, "demo_io"))
    with pytest.raises(AppError) as refused:
        asyncio.run(kit.pack(project, "demo_io"))
    _resolve_todos(project, "demo_io")
    packed = asyncio.run(kit.pack(project, "demo_io"))
    return project, {"created": created, "first": first, "refused": refused.value, "packed": packed}


def test_scaffold_renders_a_checked_skeleton_and_todos_block_packaging(
    built: tuple[Path, dict[str, Any]],
) -> None:
    project, results = built
    created = results["created"]
    assert created["path"] == "plugins/demo_io" and created["className"] == "DemoIo"
    assert "plugins/demo_io/src/teststand_adapter_demo_io/adapter.py" in created["files"]
    first = results["first"]
    assert first["compliance"] == {"ok": True, "failures": []}
    assert (
        first["tests"]["ran"] and first["tests"]["exitCode"] == 0 and first["tests"]["passed"] > 0
    )
    assert first["todoMarkers"] and not first["ok"] and "next" in first
    assert {t["name"] for t in first["declaration"]["tools"]} >= {
        "demo_set_output",
        "demo_safe_state",
    }
    assert results["refused"].category == "failed_precondition"
    with pytest.raises(AppError) as again:
        kit.scaffold(project, "demo_io", "demo", "DEMO-8", "Acme")
    assert again.value.category == "conflict"


def test_package_is_accepted_by_the_plugin_store(built: tuple[Path, dict[str, Any]]) -> None:
    project, results = built
    packed = results["packed"]
    assert packed["relativePath"] == "dist/demo_io-0.1.0.tsdev"
    manifest = packed["manifest"]
    assert manifest["type"] == "demo_io" and manifest["model"] == "DEMO-8"
    assert manifest["sdk"] == kit.sdk_range() and manifest["isolation"] == "subprocess"
    data = Path(packed["path"]).read_bytes()
    with zipfile.ZipFile(Path(packed["path"])) as archive:
        [wheel] = [name for name in archive.namelist() if name.endswith(".whl")]
        with zipfile.ZipFile(archive.open(wheel)) as inner:
            names = inner.namelist()
            entry = inner.read("teststand_adapter_demo_io-0.1.0.dist-info/entry_points.txt")
    assert "teststand_adapter_demo_io/adapter.py" in names
    assert not any("__pycache__" in name for name in names)
    assert b"demo_io = teststand_adapter_demo_io:DEVICE" in entry
    store = PluginStore(project / "store")
    asyncio.run(store.initialize())
    assert store.inspect(data)["manifest"]["type"] == "demo_io"


def test_static_rules_report_stdout_dependencies_and_missing_files(tmp_path: Path) -> None:
    kit.scaffold(tmp_path, "rules", "rules", "R-1", "Acme")
    item = kit.adapter_dir(tmp_path, "rules")
    adapter = item.source / "adapter.py"
    adapter.write_text(adapter.read_text("utf-8") + "\nprint('hello')\n", encoding="utf-8")
    pyproject = item.root / "pyproject.toml"
    text = pyproject.read_text("utf-8").replace(
        'dependencies = ["teststand-device-sdk', 'dependencies = ["pyserial", "teststand-device-sdk'
    )
    text = text.replace("requiredFiles = []", 'requiredFiles = ["bin/x.dll"]')
    text = text.replace('rules = "teststand_adapter_rules:DEVICE"', 'other = "x:DEVICE"')
    pyproject.write_text(text, encoding="utf-8")
    problems, _ = kit._static_findings(item, kit._project(item))
    joined = "\n".join(problems)
    assert "print()" in joined and "pyserial" in joined and "bin/x.dll" in joined
    assert "entry-points" in joined


def test_adapter_ids_and_arguments_are_validated(tmp_path: Path) -> None:
    for adapter, prefix, model in (("Bad-Id", "p", "M"), ("ok", "Bad", "M"), ("ok", "p", 'a"b')):
        with pytest.raises(AppError) as error:
            kit.scaffold(tmp_path, adapter, prefix, model, "Acme")
        assert error.value.category == "invalid_argument"
    with pytest.raises(AppError) as missing:
        kit.adapter_dir(tmp_path, "absent")
    assert missing.value.category == "not_found"
    assert kit.class_name("cp118u_i") == "Cp118uI"


def test_vendor_files_are_copied_into_the_package_and_required(tmp_path: Path) -> None:
    project, vendor, protected = tmp_path / "p", tmp_path / "vendor", tmp_path / "teststand"
    for folder in (project, vendor, protected):
        folder.mkdir()
    kit.scaffold(project, "card", "card", "C-1", "Acme")
    (vendor / "card_x64.dll").write_bytes(b"MZ" + b"\0" * 64)
    (vendor / "notes.py").write_text("x = 1", encoding="utf-8")
    (protected / "core.dll").write_bytes(b"MZ")
    copied = kit.add_vendor_file(project, "card", str(vendor / "card_x64.dll"), None, [protected])
    assert copied["packagePath"] == "bin/card_x64.dll" and copied["bytes"] == 66
    meta = kit._project(kit.adapter_dir(project, "card"))
    assert meta["tool"]["teststand"]["package"]["requiredFiles"] == ["bin/card_x64.dll"]
    kit.add_vendor_file(project, "card", str(vendor / "card_x64.dll"), None, [protected])
    meta = kit._project(kit.adapter_dir(project, "card"))
    assert meta["tool"]["teststand"]["package"]["requiredFiles"] == ["bin/card_x64.dll"]
    for source, target, category in (
        (protected / "core.dll", None, "permission_denied"),
        (vendor / "notes.py", None, "invalid_argument"),
        (vendor / "absent.dll", None, "not_found"),
        (vendor / "card_x64.dll", "../escape.dll", "invalid_argument"),
    ):
        with pytest.raises(AppError) as error:
            kit.add_vendor_file(project, "card", str(source), target, [protected])
        assert error.value.category == category


def _docx(path: Path) -> None:
    w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = (
        f'<w:document xmlns:w="{w}"><w:body>'
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Pins</w:t></w:r></w:p>'
        "<w:p><w:r><w:t>Pin 1 is TXD+</w:t></w:r></w:p>"
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc>"
        "<w:tc><w:p><w:r><w:t>TXD+</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
        "</w:body></w:document>"
    )
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("word/document.xml", body)


def _xlsx(path: Path) -> None:
    s = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "xl/workbook.xml",
            f'<workbook xmlns="{s}"><sheets><sheet name="Map"/></sheets></workbook>',
        )
        archive.writestr("xl/sharedStrings.xml", f'<sst xmlns="{s}"><si><t>COM3</t></si></sst>')
        archive.writestr(
            "xl/worksheets/sheet1.xml",
            f'<worksheet xmlns="{s}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c>'
            '<c r="B1"><v>3</v></c><c r="C1" t="inlineStr"><is><t>port</t></is></c></row>'
            "</sheetData></worksheet>",
        )


def _pdf(path: Path, text: str) -> None:
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    path.write_bytes(bytes(out))


def test_documents_become_text(tmp_path: Path) -> None:
    _docx(tmp_path / "manual.docx")
    _xlsx(tmp_path / "map.xlsx")
    _pdf(tmp_path / "card.pdf", "Baud rate 115200")
    (tmp_path / "api.h").write_bytes("int Open(); // 打开设备".encode("gbk"))
    docx = documents.extract(tmp_path / "manual.docx")["text"]
    assert "# Pins" in docx and "| 1 | TXD+ |" in docx
    xlsx = documents.extract(tmp_path / "map.xlsx")
    assert xlsx["pages"] == 1 and "A1=COM3 | B1=3 | C1=port" in xlsx["text"]
    pdf = documents.extract(tmp_path / "card.pdf")
    assert pdf["pages"] == 1 and "## Page 1" in pdf["text"] and "115200" in pdf["text"]
    assert "打开设备" in documents.extract(tmp_path / "api.h")["text"]
    (tmp_path / "old.doc").write_bytes(b"\xd0\xcf")
    (tmp_path / "blank.txt").write_text("  \n", encoding="utf-8")
    (tmp_path / "bad.docx").write_bytes(b"not a zip")
    for name, category in (
        ("old.doc", "invalid_argument"),
        ("blank.txt", "invalid_argument"),
        ("bad.docx", "invalid_argument"),
        ("file.bin", "invalid_argument"),
        ("absent.pdf", "not_found"),
    ):
        with pytest.raises(AppError) as error:
            documents.extract(tmp_path / name)
        assert error.value.category == category, name


def test_import_document_registers_a_searchable_reference(tmp_path: Path) -> None:
    project, outside = tmp_path / "project", tmp_path / "docs"
    for folder in (project, outside):
        folder.mkdir()
    _pdf(outside / "串口卡手册.pdf", "RS422 TXD pin 3")
    tools.configure([tmp_path / "teststand"])
    app, context = _app(project), {"actor": "agent"}
    value = {"sourcePath": str(outside / "串口卡手册.pdf"), "hardwareId": "CARD"}
    first = asyncio.run(tools._import_document(app, context, value))
    assert first["path"].startswith("docs/doc-") and first["referenceId"] == first["slug"]
    again = asyncio.run(tools._import_document(app, context, value))
    assert again["referenceId"] == first["referenceId"]
    from teststand_backend.workspace.references import ReferenceService

    found = ReferenceService(str(project)).read(
        {"referenceId": first["referenceId"], "query": "rs422"}
    )
    assert found["total"] > 0
    (tmp_path / "teststand").mkdir()
    (tmp_path / "teststand" / "x.txt").write_text("secret", encoding="utf-8")
    with pytest.raises(AppError) as denied:
        asyncio.run(
            tools._import_document(app, context, {"sourcePath": str(tmp_path / "teststand/x.txt")})
        )
    assert denied.value.category == "permission_denied"
    assert tools.protected_folders() == [tmp_path / "teststand"]


def test_tools_list_adapters_and_describe_the_sdk(built: tuple[Path, dict[str, Any]]) -> None:
    project, _ = built
    app, context = _app(project), {"actor": "agent"}
    listed = tools._list(app, context, {})
    assert listed["adapters"] == [
        {"adapter": "demo_io", "path": "plugins/demo_io", "packages": ["dist/demo_io-0.1.0.tsdev"]}
    ]
    index = tools.describe_sdk(None)
    assert {"Device", "SerialPort", "testing"} <= {item["name"] for item in index["items"]}
    pinout = tools.describe_sdk("multi_connector_pinout")
    assert (
        pinout["signature"].startswith("multi_connector_pinout(") and "connectors" in pinout["doc"]
    )
    device = tools.describe_sdk("Device")
    assert any(member["name"] == "select_driver" for member in device["members"])
    assert tools.describe_sdk("testing.serve")["signature"].startswith("serve(")
    assert "value" in tools.describe_sdk("CONTRACT_REVISION")
    for name in ("os", "Device._private", "Nope"):
        with pytest.raises(AppError):
            tools.describe_sdk(name)
    no_project = SimpleNamespace(projects=SimpleNamespace(document=lambda context: None))
    with pytest.raises(AppError) as required:
        tools._list(no_project, context, {})
    assert required.value.category == "requires_project"


def test_runner_reports_import_errors_and_usage(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert runner.main(["nonsense"]) == 2
    root = tmp_path / "broken"
    (root / "src" / "teststand_adapter_broken").mkdir(parents=True)
    (root / "src" / "teststand_adapter_broken" / "__init__.py").write_text(
        "raise ImportError('no dll')\n", encoding="utf-8"
    )
    assert runner.main(["check", str(root), "broken"]) == 1
    assert runner.main(["describe", str(root), "broken"]) == 1
    results = [
        json.loads(line[len(runner.RESULT_MARK) :])
        for line in capsys.readouterr().out.splitlines()
        if line.startswith(runner.RESULT_MARK)
    ]
    assert "usage" in results[0]["error"]
    assert "does not import" in results[1]["error"] and results[1]["tests"]["ran"] is False
    assert "no dll" in results[2]["error"]


def test_a_hanging_check_times_out(tmp_path: Path) -> None:
    kit.scaffold(tmp_path, "slow", "slow", "S-1", "Acme")
    test = tmp_path / "plugins/slow/tests/test_slow_adapter.py"
    test.write_text("import time\n\ndef test_hang():\n    time.sleep(60)\n", encoding="utf-8")
    with pytest.raises(AppError) as error:
        asyncio.run(kit.check(tmp_path, "slow", timeout_s=8))
    assert error.value.category == "timeout"


def test_ocr_rows_rebuild_table_rows_from_word_boxes() -> None:
    from teststand_backend.devkit import ocr

    def word(text: str, x: float, y: float) -> dict[str, Any]:
        return {"text": text, "x": x, "y": y, "w": 30, "h": 20}

    words = [
        word("34", 300, 101),
        word("DIO0", 10, 100),
        word("68", 200, 99),
        word("DIO1", 400, 102),
        word("连", 10, 160),
        word("接", 42, 161),
        word("J1", 80, 160),
    ]
    assert ocr.rows(words) == ["DIO0 68 34 DIO1", "连接 J1"]
    assert ocr.rows([]) == []


@pytest.mark.skipif(not __import__("sys").platform.startswith("win"), reason="Windows OCR")
def test_figure_pages_are_read_by_ocr(tmp_path: Path) -> None:
    from teststand_backend.devkit import ocr

    _pdf(tmp_path / "scan.pdf", "PIN 68 DIO0")
    png = ocr.render_png(tmp_path / "scan.pdf", 0)
    assert png.startswith(b"\x89PNG")
    # A page with almost no text layer is read by OCR in auto mode; none turns it off.
    assert ocr.pages_to_ocr(tmp_path / "scan.pdf", [""], "auto") == [0]
    assert ocr.pages_to_ocr(tmp_path / "scan.pdf", ["x" * 100], "none") == []
    converted = documents.convert(tmp_path / "scan.pdf", tmp_path / "project")
    assert converted["ocrPages"] == 1
    text = (tmp_path / "project" / converted["path"]).read_text("utf-8")
    assert "Text read from the picture (OCR" in text and "68" in text
    assert (tmp_path / "project" / "docs" / converted["slug"] / "page-001.png").is_file()
    (tmp_path / "page.png").write_bytes(png)
    image = documents.extract(tmp_path / "page.png")
    assert image["ocrPages"] == 1 and "68" in image["text"]
