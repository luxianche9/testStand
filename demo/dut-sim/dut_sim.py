"""虚拟被测件：没有被测对象时演示 testStand 用。

一个 TCP 服务端（默认 127.0.0.1:9000），像一块接了串口的控制板那样工作：

* 每 100 ms 上报一帧状态（cmd 0x81）：电压 mV（缓慢正弦 + 噪声）、温度 0.1 °C、状态位
  （bit0 LED、bit1 风扇、bit2 故障）、帧计数；
* 收到命令帧回一帧应答（cmd 0x01，code 0 = 成功）：
  0x10 设 LED（1 字节 0/1）、0x11 设风扇（1 字节 0/1）、0x12 设电压目标 mV（u16，电压向它靠拢）、
  0x13 注入 / 清除故障（1 字节 0/1）。

帧格式与 dut_sim.icd.yaml 一致：AA 55 | 长度 | 命令 | 负载 | CRC16-Modbus（小端），长度 = 1 + 负载字节数，
CRC 从长度字节算到负载结束。只用 Python 标准库。

    python dut_sim.py                 # 127.0.0.1:9000
    python dut_sim.py --port 9100     # 换端口
在 testStand 里添加 comm_link 设备，设置 {"link": "tcp_client", "host": "127.0.0.1", "port": 9000}。
"""

from __future__ import annotations

import argparse
import math
import random
import socket
import struct
import threading
import time

HEADER = b"\xaa\x55"
STATUS, ACK = 0x81, 0x01
SET_LED, SET_FAN, SET_VOLTAGE, SET_FAULT = 0x10, 0x11, 0x12, 0x13


def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def frame(cmd: int, payload: bytes) -> bytes:
    body = HEADER + bytes([1 + len(payload), cmd]) + payload
    return body + crc16_modbus(body[2:]).to_bytes(2, "little")


class Board:
    """The simulated controller's state."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.led = False
        self.fan = False
        self.fault = False
        self.target_mv = 2500
        self.voltage_mv = 2500.0
        self.temperature = 25.0
        self.counter = 0
        self.started = time.monotonic()

    def step(self, dt: float) -> bytes:
        with self.lock:
            t = time.monotonic() - self.started
            # The voltage follows its target with a slow ripple; the temperature rises with the LED, falls with the fan.
            self.voltage_mv += (self.target_mv - self.voltage_mv) * min(1.0, dt * 2)
            shown = self.voltage_mv + 40 * math.sin(t * 0.8) + random.uniform(-5, 5)
            heat = (0.6 if self.led else 0.0) - (1.2 if self.fan else 0.0)
            self.temperature += (25.0 + heat * 10 - self.temperature) * dt * 0.2
            if self.fault:
                shown = 0
            status = int(self.led) | int(self.fan) << 1 | int(self.fault) << 2
            self.counter = (self.counter + 1) & 0xFFFF
            payload = struct.pack("<HhBH", max(0, min(65535, round(shown))), round(self.temperature * 10),
                                  status, self.counter)
        return frame(STATUS, payload)

    def command(self, cmd: int, payload: bytes) -> int:
        """Apply one command; the code for its acknowledgement (0 = done, 1 = bad command)."""
        with self.lock:
            if cmd == SET_LED and len(payload) >= 1:
                self.led = bool(payload[0])
            elif cmd == SET_FAN and len(payload) >= 1:
                self.fan = bool(payload[0])
            elif cmd == SET_VOLTAGE and len(payload) >= 2:
                self.target_mv = min(3300, struct.unpack("<H", payload[:2])[0])
            elif cmd == SET_FAULT and len(payload) >= 1:
                self.fault = bool(payload[0])
            else:
                return 1
            return 0


def frames_in(buffer: bytearray) -> list[tuple[int, bytes]]:
    """Whole, checksum-correct frames at the front of ``buffer`` (consumed); junk before a header is dropped."""
    found: list[tuple[int, bytes]] = []
    while True:
        start = buffer.find(HEADER)
        if start < 0:
            del buffer[:-1]
            return found
        del buffer[:start]
        if len(buffer) < 4:
            return found
        total = 3 + buffer[2] + 2
        if len(buffer) < total:
            return found
        body, crc = bytes(buffer[: total - 2]), int.from_bytes(buffer[total - 2 : total], "little")
        del buffer[:total]
        if crc16_modbus(body[2:]) == crc:
            found.append((body[3], body[4:]))


def serve_client(client: socket.socket, board: Board, period: float) -> None:
    client.settimeout(period)
    buffer = bytearray()
    last = time.monotonic()
    while True:
        now = time.monotonic()
        if now - last >= period:
            client.sendall(board.step(now - last))
            last = now
        try:
            data = client.recv(1024)
        except TimeoutError:
            continue
        if not data:
            return
        buffer += data
        for cmd, payload in frames_in(buffer):
            client.sendall(frame(ACK, bytes([board.command(cmd, payload)])))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9000)
    parser.add_argument("--period-ms", type=int, default=100, help="status frame interval")
    options = parser.parse_args()
    board = Board()
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((options.host, options.port))
    server.listen(1)
    print(f"虚拟被测件在 {options.host}:{options.port} 等待连接（Ctrl+C 退出）", flush=True)
    try:
        while True:
            client, address = server.accept()
            print(f"已连接 {address[0]}:{address[1]}", flush=True)
            try:
                serve_client(client, board, options.period_ms / 1000)
            except OSError as exc:
                print(f"连接断开：{exc}", flush=True)
            finally:
                client.close()
            print("连接已关闭，等待下一次连接", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        server.close()


if __name__ == "__main__":
    main()
