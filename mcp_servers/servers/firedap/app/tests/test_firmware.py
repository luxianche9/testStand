import hashlib
import struct

import pytest
from intelhex import IntelHex

from hardwareharness_firedap.firmware import FLASH_START, FLASH_END, OperationError, inspect_firmware, validate_segments


def test_bin_explicit_address_snapshot_and_hash(tmp_path):
    path = tmp_path / 'firmware.bin'
    path.write_bytes(b'\x01\x02\x03\x04')
    with pytest.raises(OperationError, match='explicit'):
        inspect_firmware(str(path), [str(tmp_path)])
    info, segments = inspect_firmware(str(path), [str(tmp_path)], FLASH_START)
    assert info['sha256'] == hashlib.sha256(path.read_bytes()).hexdigest()
    path.write_bytes(b'changed')
    assert segments == [(FLASH_START, b'\x01\x02\x03\x04')]
    with pytest.raises(OperationError, match='SHA-256'):
        inspect_firmware(str(path), [str(tmp_path)], FLASH_START, info['sha256'])


def test_path_allowlist_and_missing_files(tmp_path):
    path = tmp_path / 'a.bin'
    path.write_bytes(b'abcd')
    with pytest.raises(OperationError, match='firmwareRoots'):
        inspect_firmware(str(path), [str(tmp_path / 'allowed')], FLASH_START)
    with pytest.raises(OperationError, match='not accessible'):
        inspect_firmware(str(tmp_path / 'missing.bin'), [str(tmp_path)], FLASH_START)


@pytest.mark.parametrize('address,data', [(0, b'xx'), (0x1FFF0000, b'xx'), (0x20000000,b'xx'),
                                         (0x90000000,b'xx'), (FLASH_END-1,b'xx'), (FLASH_START,b'')])
def test_refuses_non_flash_empty_and_overflow(address, data):
    with pytest.raises(OperationError):
        validate_segments([(address,data)])


def test_overlapping_segments_rejected():
    with pytest.raises(OperationError, match='Overlapping'):
        validate_segments([(FLASH_START,b'1234'),(FLASH_START+2,b'56')])


def test_hex_addresses_checksums_and_sparse_data(tmp_path):
    path = tmp_path / '固件.hex'
    ih = IntelHex()
    ih.puts(FLASH_START,b'1234')
    ih.puts(FLASH_START+0x20000,b'abcd')
    ih.write_hex_file(str(path))
    info, segments = inspect_firmware(str(path),[str(tmp_path)])
    assert info['programBytes'] == 8
    assert len(segments) == 2
    with pytest.raises(OperationError, match='only valid for .bin'):
        inspect_firmware(str(path),[str(tmp_path)],FLASH_START)
    text = path.read_text()
    path.write_text(text.replace(':020000040800F2', ':020000040800F3'))
    with pytest.raises(OperationError, match='Malformed'):
        inspect_firmware(str(path),[str(tmp_path)])


def test_hex_cannot_touch_option_bytes(tmp_path):
    path=tmp_path/'option.hex'
    ih=IntelHex(); ih.puts(0x1FFFC000,b'1234'); ih.write_hex_file(str(path))
    with pytest.raises(OperationError,match='outside'):
        inspect_firmware(str(path),[str(tmp_path)])


def test_arm_elf_uses_load_address_not_ram_execution_address(tmp_path):
    path=tmp_path/'program.axf'
    ident=b'\x7fELF'+bytes([1,1,1])+bytes(9)
    header=ident+struct.pack('<HHIIIIIHHHHHH',2,40,1,FLASH_START,52,0,0,52,32,1,40,0,0)
    ph=struct.pack('<IIIIIIII',1,84,0x20000000,FLASH_START,4,8,6,4)
    path.write_bytes(header+ph+b'abcd')
    _,segments=inspect_firmware(str(path),[str(tmp_path)])
    assert segments==[(FLASH_START,b'abcd')]
    invalid=bytearray(path.read_bytes()); invalid[18:20]=struct.pack('<H',3);path.write_bytes(invalid)
    with pytest.raises(OperationError,match='ARM'):
        inspect_firmware(str(path),[str(tmp_path)])
