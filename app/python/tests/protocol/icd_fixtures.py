"""ICD fixtures shared by the protocol tests (the §6.2 example plus a few additions)."""

from __future__ import annotations

from teststand_backend.protocol import Icd, checksums, load_icd

DUT_CMD_YAML = """\
formatVersion: 1
name: dut_cmd
description: DUT 命令口 RS422 协议
transport: bytes                 # bytes：需要切帧；frames：已经是报文
framing:
  kind: header_length
  header: "AA 55"
  lengthField: {offset: 2, size: 1}
  lengthCovers: payload
  trailer: checksum
  maxLength: 260
checksum:
  algorithm: crc16_modbus
  range: {from: 2, to: -2}
  offset: -2
  endian: little
messages:
  - name: status
    match: {offset: 3, value: 0x81}
    fields:
      - {name: selfTest, offset: 4, type: u8, bits: "0", enum: {0: fail, 1: pass}}
      - {name: voltage,  offset: 5, type: i16, endian: little, scale: 0.01, unit: V}
      - {name: temp,     offset: 7, type: i16, endian: little, scale: 0.1, unit: degC}
      - {name: version,  offset: 9, type: ascii, length: 8}
      - {name: selfTestRaw, offset: 4, type: u8}
      - {name: power,    expr: "voltage * 2 + bit(selfTestRaw, 0)", unit: W}
  - name: ack
    match: {offset: 3, value: 0x01}
    fields:
      - {name: code, offset: 4, type: u8}
  - name: mode_echo
    match: [{offset: 3, value: 0x10}, {length: 7}]
    fields:
      - {name: mode, offset: 4, type: u8}
encoders:
  - name: set_mode
    template: {header: "AA 55", cmd: 0x10}
    fields: [{name: mode, offset: 4, type: u8}]
"""


def dut_cmd() -> Icd:
    return load_icd(DUT_CMD_YAML)


def status_frame(
    *, self_test: int = 1, voltage: int = 1234, temp: int = -52, version: bytes = b"V1.2.3\x00\x00"
) -> bytes:
    body = bytearray(b"\xaa\x55\x00\x81")
    body.append(self_test)
    body += voltage.to_bytes(2, "little", signed=True)
    body += temp.to_bytes(2, "little", signed=True)
    body += version
    body[2] = len(body) - 3
    crc = checksums.compute("crc16_modbus", bytes(body[2:]))
    return bytes(body) + crc.to_bytes(2, "little")


def ack_frame(code: int) -> bytes:
    body = bytearray(b"\xaa\x55\x02\x01") + bytes([code])
    return bytes(body) + checksums.compute("crc16_modbus", bytes(body[2:])).to_bytes(2, "little")
