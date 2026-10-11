import sys

import pytest
from teststand_device_sdk import DeviceError, SerialPort, SimulatedSerialPort, list_ports
from teststand_device_sdk.errors import DEVICE_UNREACHABLE, INVALID_ARGUMENT


def test_simulated_port_reads_nothing_until_loopback_or_inject():
    port = SimulatedSerialPort("com7")
    with pytest.raises(DeviceError):
        port.read()
    port.open(115200, 8, "E", 1)
    assert port.port == "COM7" and port.is_open
    assert port.settings == {"baudrate": 115200, "bytesize": 8, "parity": "E", "stopbits": 1}
    assert port.write(b"abc") == 3 and port.read() == b""
    port.inject(b"xyz")
    assert port.in_waiting() == 3 and port.read(2) == b"xy" and port.read() == b"z"
    port.loopback = True
    port.write(b"echo")
    port.flush(rx=True)
    assert port.read() == b""
    port.write(b"hi")
    assert port.read() == b"hi" and bytes(port.written) == b"abcechohi"
    port.close()
    assert not port.is_open


@pytest.mark.parametrize("settings", [(10, 8, "N", 1), (9600, 9, "N", 1), (9600, 8, "X", 1), (9600, 8, "N", 3)])
def test_settings_are_validated_before_any_port_access(settings):
    with pytest.raises(DeviceError) as error:
        SimulatedSerialPort("COM1").open(*settings)
    assert error.value.category == INVALID_ARGUMENT


def test_real_port_rejects_bad_names():
    with pytest.raises(DeviceError) as error:
        SerialPort("/dev/ttyS0")
    assert error.value.category == INVALID_ARGUMENT
    with pytest.raises(DeviceError):
        SerialPort("COM3").read()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows serial API")
def test_missing_port_is_unreachable_and_ports_are_listed():
    with pytest.raises(DeviceError) as error:
        SerialPort("COM250").open()
    assert error.value.category == DEVICE_UNREACHABLE
    ports = list_ports()
    assert all(item["port"].startswith("COM") and item["device"] for item in ports)


def test_multi_connector_pinout_names_pins_per_connector():
    from teststand_device_sdk import function, multi_connector_pinout

    rx = (function("RXD", "input", "rs232", channel_kind="COM", channel_index=0),)
    layout = multi_connector_pinout("CARD", "Acme", "SER-2", [
        ("P1", "DB9 male", 9, {2: rx}), ("P2", "DB9 male", 9, {})], "manual rev A")
    assert [c.name for c in layout.connectors] == ["P1", "P2"]
    assert layout.pins[1].pinId == "CARD.P1.2" and layout.pins[1].functions == rx
    assert layout.pins[9].pinId == "CARD.P2.1" and layout.pins[9].functions[0].direction == "nc"
    with pytest.raises(ValueError):
        multi_connector_pinout("CARD", "Acme", "SER-2", [("P1", "x", 1, {}), ("P1", "x", 1, {})], "m")
