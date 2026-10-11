"""ART Technology PXI2355L: 32 isolated DI and 32 isolated Darlington source DO on one SCSI-100.

Hardware manual V6.00.02 (PCI/PXI 235xL). DI: bidirectional optocouplers, ±30 V, logic 1 when
|V| ≥ 5 V flows between P0-3.x and the port's COM (≤ 2 V reads 0). DO: ULN2803 source outputs
powered from each port's external Px.VCC (5-40 V); 500 mA on a single line, 100 mA per line when
the whole port is on. Without Px.VCC an output that reads 1 drives nothing.

Driven through ART-DAQ: one DI task on ``<dev>/port0:3`` and one DO task on ``<dev>/port4:7``,
32 lines each, bit i = line i (DI i = P(i//8).(i%8), DO i = P(4+i//8).(i%8)). The DO task reads
back the output state the driver holds.
"""

from __future__ import annotations

from typing import Any

from teststand_device_sdk import (
    DEVICE_ERROR,
    DEVICE_UNREACHABLE,
    BitsStream,
    Check,
    Device,
    DeviceConfig,
    DeviceError,
    Pinout,
    check_equal,
    model,
    param,
    tool,
)

from .driver import ArtDaqDriver
from .pinout import pinout as build_pinout
from .sim import SimulatedArtDaq

PRODUCT = "PXI2355L"
LINES = 32
FULL = (1 << LINES) - 1

DiState = model("Pxi2355Di", mask=(int, "Bit i = DI line i conducting (1) or not (0)."),
                high=(list[int], "DI lines reading 1."))
DoState = model("Pxi2355Do", mask=(int, "Output state read back from the DO task: bit i = DO line i on."),
                on=(list[int], "DO lines on."))
Line = param(int, "Line 0..31 (DO i = P(4+i//8).(i%8)).", ge=0, le=LINES - 1)


def lines_of(mask: int) -> list[int]:
    return [bit for bit in range(LINES) if mask >> bit & 1]


class ArtPxi2355l(Device):
    manufacturer = "ART Technology"
    model = PRODUCT
    prefix = "pxi2355"
    capabilities = ("digital_input", "digital_output")
    isolation = "subprocess"
    version = "1.0.0"
    instructions = ("PXI2355L: 32 isolated DI (read_di, di stream) and 32 isolated source DO (write_do, write_do_mask; "
                    "outputs need external Px.VCC). DO state is read back from the driver.")
    description = ("ART Technology PXI2355L, PXI optically isolated I/O: 32 DI (bidirectional optocoupler, ±30 V, "
                   "1 at |V| ≥ 5 V, 2500 Vrms) and 32 Darlington source DO (external 5-40 V per port, 500 mA single "
                   "line), SCSI-100. Driven through ART-DAQ; card selected by serialNumber or deviceName.")

    def __init__(self, config: DeviceConfig) -> None:
        super().__init__(config)
        settings = config.settings
        serial = settings.get("serialNumber")
        self.serial = int(serial) if serial not in (None, "") else None
        self.device_name = settings.get("deviceName") or None
        self.safe_mask = int(settings.get("safeMask", 0))
        if not 0 <= self.safe_mask <= FULL:
            raise ValueError("safeMask must be a 32-bit mask")
        self.driver = self.select_driver(lambda: ArtDaqDriver(settings.get("dllPath")), SimulatedArtDaq)
        self.identity: dict[str, Any] = {}
        self.di_task: int | None = None
        self.do_task: int | None = None
        self.shadow = 0
        labels = [f"P{n // 8}.{n % 8}" for n in range(LINES)]
        self.di = self.streams.add(BitsStream("di", sample=self._sample_di, rate_hz=50.0, publish_on_change=True,
                                              bit_labels=labels, label="DI levels", kind="measured"))
        self.do = self.streams.add(BitsStream("do", bit_labels=[f"P{4 + n // 8}.{n % 8}" for n in range(LINES)],
                                              label="DO state (driver readback)", kind="measured"))

    # --- lifecycle ----------------------------------------------------
    def _find(self) -> dict[str, Any]:
        names = [self.device_name] if self.device_name else self.driver.devices()
        seen = []
        for name in names:
            identity = self.driver.identity(name)
            seen.append({key: identity[key] for key in ("device", "productType", "serialNumber")})
            if identity["productType"] != PRODUCT:
                continue
            if self.serial is None or identity["serialNumber"] == self.serial:
                return identity
        raise DeviceError(f"{PRODUCT} {'serial ' + str(self.serial) if self.serial else ''} not found in ART-DAQ "
                          f"devices {seen}", category=DEVICE_UNREACHABLE, details={"seen": seen})

    def _check(self, rc: int, what: str, **details: Any) -> None:
        if rc < 0:
            raise DeviceError(f"{what} failed ({rc}): {self.driver.last_error()}", category=DEVICE_ERROR,
                              details={"rc": rc, **details})

    def open(self) -> dict[str, Any]:
        identity = self._find()
        device = identity["device"]
        rc, di = self.driver.create(device, output=False)
        self._check(rc, "create DI task", device=device)
        rc, do = self.driver.create(device, output=True)
        if rc < 0 or do is None:
            self.driver.clear(di)
            self._check(rc, "create DO task", device=device)
        self.identity, self.di_task, self.do_task = identity, di, do
        self._apply(self.safe_mask)
        return {"identity": identity, "do": self.shadow}

    def close(self) -> dict[str, Any]:
        tasks = [task for task in (self.di_task, self.do_task) if task is not None]
        self.di_task = self.do_task = None
        for task in tasks:
            self.driver.clear(task)
        return {"closed": bool(tasks)}

    def _tasks(self) -> tuple[int, int]:
        if self.di_task is None or self.do_task is None:
            raise DeviceError("Card not open.", category=DEVICE_UNREACHABLE)
        return self.di_task, self.do_task

    def _read_do(self) -> int:
        rc, mask = self.driver.read(self._tasks()[1])
        self._check(rc, "read DO state")
        return mask

    def _read_di(self) -> int:
        rc, mask = self.driver.read(self._tasks()[0])
        self._check(rc, "read DI")
        return mask

    def _sample_di(self) -> int | None:
        return self._read_di() if self.di_task is not None else None

    def _apply(self, mask: int) -> dict[str, Any]:
        rc = self.driver.write(self._tasks()[1], mask)
        self._check(rc, "write DO", requested=mask)
        self.shadow = mask
        back = self._read_do()
        self.do.publish(back)
        if back != mask:
            raise DeviceError(f"DO reads {back:#010x} after writing {mask:#010x}", category=DEVICE_ERROR,
                              details={"requested": mask, "readBack": back, "differ": lines_of(back ^ mask)})
        return {"mask": back, "on": lines_of(back)}

    # --- tools --------------------------------------------------------
    @tool(kind="actuate", output=DoState, safety_action="safe_state", effects=("do_driven",),
          description="Switch one DO line on (source current from Px.VCC into the load) or off; the other lines keep "
                      "their state. The DO state is read back from the driver; the load current is not measured.")
    def write_do(self, line: Line, on: param(bool, "true = output on, false = off.")) -> dict[str, Any]:
        current = self._read_do()
        return self._apply(current | 1 << line if on else current & ~(1 << line))

    @tool(kind="actuate", output=DoState, safety_action="safe_state", effects=("do_driven",),
          description="Write all 32 DO lines at once from a mask (bit i = DO line i on) and read the state back. "
                      "Mind the 100 mA per line limit when a whole port is on.")
    def write_do_mask(self, mask: param(int, "32-bit mask, bit i = DO line i.", ge=0, le=FULL)) -> dict[str, Any]:
        return self._apply(mask)

    @tool(kind="read", output=DoState, evidence="controller_state",
          description="Read the DO state the driver holds (bit i = DO line i on). It is the output register, not a "
                      "measurement of the load or of Px.VCC.")
    def read_do(self) -> dict[str, Any]:
        mask = self._read_do()
        return {"mask": mask, "on": lines_of(mask)}

    @tool(kind="read", output=DiState, evidence="measurement",
          description="Read the 32 isolated DI lines once: bit i = 1 when |V| ≥ 5 V drives current through "
                      "P(i//8).(i%8) and its port COM, 0 at ≤ 2 V.")
    def read_di(self) -> dict[str, Any]:
        mask = self._read_di()
        return {"mask": mask, "high": lines_of(mask)}

    @tool(kind="safe", output=DoState,
          description="Write safeMask (default 0: every DO off) to all 32 DO lines and read the state back.")
    def safe_state(self) -> dict[str, Any]:
        return self._apply(self.safe_mask)

    # --- self-test ----------------------------------------------------
    def self_test(self) -> list[Check]:
        identity = self.identity
        checks = [
            check_equal("产品型号", identity.get("productType"), PRODUCT, f"ART-DAQ 设备 {identity.get('device')}"),
            Check("序列号", bool(identity.get("serialNumber")) and
                  (self.serial is None or identity.get("serialNumber") == self.serial),
                  identity.get("serialNumber"), self.serial if self.serial is not None else "非零"),
        ]
        try:
            self._read_di()
            checks.append(Check("DI 读取", True, "32 路", "成功", "ArtDAQ_ReadDigitalScalarU32 port0:3"))
        except DeviceError as exc:
            checks.append(Check("DI 读取", False, str(exc), "成功"))
        back = self._read_do()
        checks.append(check_equal("DO 回读 = 最后写入", f"{back:#010x}", f"{self.shadow:#010x}",
                                  "DO 任务读回驱动持有的输出状态"))
        rc, states = self.driver.power_up(identity.get("device", ""))
        checks.append(Check("DO 上电状态", rc >= 0 and all(state == "low" for state in states),
                            sorted(set(states)) if rc >= 0 else self.driver.last_error(), ["low"],
                            "ArtDAQ_GetDigitalPowerUpStates：上电时全部关断；输出须外接 Px.VCC 才有驱动能力，"
                            "负载上的电压按 README 验收步骤测量"))
        return checks

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        return {"di": {"lines": LINES, "inputVolts": [-30, 30], "high": "|V| >= 5 V", "low": "|V| <= 2 V"},
                "do": {"lines": LINES, "type": "darlington_source", "supplyVolts": [5, 40],
                       "currentMa": {"singleLine": 500, "allLinesPerLine": 100}, "readback": "driver_state",
                       "safeMask": self.safe_mask},
                "card": {"serialNumber": self.serial, "deviceName": self.device_name}}

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)
