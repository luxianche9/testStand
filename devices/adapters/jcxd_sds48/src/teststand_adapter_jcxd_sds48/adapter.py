"""Devices-JC JCXD-SDS48-CPCI: 48 single-pole double-throw relays on two J30J-74 connectors.

Hardware manual V2.0.0 / software manual V2.0.0. Relay n: OT_COMn common, OT_CLn normally closed,
OT_OPn normally open. Energized (driver status 1) connects COM-OP, released (0) COM-CL; reset
releases every relay. The driver reads back the relay drive register, not the contacts: a welded
or open contact is only found by measuring through it (README acceptance procedure).

Several cards are told apart by ``serialNumber`` (card ids follow slot order).
"""

from __future__ import annotations

import time
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

from .driver import MAX_CARDS, Sds48Driver
from .pinout import pinout as build_pinout
from .sim import SimulatedSds48

CARD_TYPE = 0x5205
CHANNELS = 48

Relays = model("Sds48Relays", mask=(int, "Drive register read back: bit i set = relay i energized (COM-OP)."),
               energized=(list[int], "Energized relays, ascending."))
Relay = param(int, "Relay 0..47 (OT_COMn/OT_CLn/OT_OPn).", ge=0, le=CHANNELS - 1)


def channels_of(mask: int) -> list[int]:
    return [bit for bit in range(CHANNELS) if mask >> bit & 1]


class JcxdSds48(Device):
    manufacturer = "Devices-JC"
    model = "JCXD-SDS48-CPCI"
    prefix = "sds48"
    capabilities = ("relay_switching",)
    isolation = "subprocess"
    version = "1.0.0"
    instructions = ("JCXD-SDS48-CPCI: 48 SPDT relays. Energized connects COM-OP, released connects COM-CL. "
                    "set_relay / set_relays switch and read the drive register back; safe_state releases all.")
    description = ("Devices-JC JCXD-SDS48-CPCI, 3U CPCI relay card: 48 single-pole double-throw relays "
                   "(OT_COM/OT_CL/OT_OP per relay) on CON1 (relays 0-11, 24-35) and CON2 (12-23, 36-47), "
                   "J30J-74 connectors. Switching reads the drive register back; contacts are not sensed. "
                   "Card selected by serialNumber (or cardIndex).")

    def __init__(self, config: DeviceConfig) -> None:
        super().__init__(config)
        settings = config.settings
        serial = settings.get("serialNumber")
        self.serial = int(serial) if serial not in (None, "") else None
        self.card_index = int(settings.get("cardIndex", 0))
        self.settle_s = float(settings.get("settleMs", 10)) / 1000
        if not 0 <= self.settle_s <= 1:
            raise ValueError("settleMs must be within 0..1000")
        self.driver = self.select_driver(lambda: Sds48Driver(settings.get("dllPath")), SimulatedSds48)
        self.handle: int | None = None
        self.identity: dict[str, int] = {}
        self.shadow = 0
        self.relays = self.streams.add(BitsStream("relays", bit_labels=[f"K{n}" for n in range(CHANNELS)],
                                                  label="Relay drive register (1 = COM-OP)", display="switches",
                                                  kind="measured"))

    # --- lifecycle ----------------------------------------------------
    def _open_card(self) -> tuple[int, dict[str, int]]:
        ids = range(MAX_CARDS) if self.serial is not None else (self.card_index,)
        seen = []
        for card_id in ids:
            rc, handle = self.driver.open(card_id)
            if rc != 0 or handle is None:
                continue
            info_rc, info = self.driver.info(handle)
            sn_rc, sn = self.driver.serial(handle)
            if self.serial is None or info.get("serialNumber") == self.serial:
                return handle, {**info, "cardId": card_id, "infoRc": info_rc, "snRc": sn_rc, "snRegister": sn}
            seen.append(info.get("serialNumber"))
            self.driver.close(handle)
        wanted = f"serial number {self.serial}" if self.serial is not None else f"card id {self.card_index}"
        raise DeviceError(f"JCXD-SDS48 with {wanted} not found (cards seen: {seen})", category=DEVICE_UNREACHABLE,
                          details={"seen": seen})

    def open(self) -> dict[str, Any]:
        handle, identity = self._open_card()
        if self.driver.reset(handle) != 0:
            self.driver.close(handle)
            raise DeviceError("JC_SDS48_ResetDev failed", category=DEVICE_UNREACHABLE)
        self.handle, self.identity, self.shadow = handle, identity, 0
        mask = self._register()
        self.relays.publish(mask)
        return {"identity": identity, "mask": mask}

    def close(self) -> dict[str, Any]:
        handle, self.handle = self.handle, None
        if handle is not None:
            self.driver.reset(handle)
            self.driver.close(handle)
        return {"closed": handle is not None}

    def _require(self) -> int:
        if self.handle is None:
            raise DeviceError("Card not open.", category=DEVICE_UNREACHABLE)
        return self.handle

    def _register(self) -> int:
        rc, mask = self.driver.get_mask(self._require())
        if rc != 0:
            raise DeviceError(f"JC_SDS48_Switch_GetMultiStatus failed rc={rc}", category=DEVICE_ERROR)
        return mask

    def _apply(self, mask: int) -> dict[str, Any]:
        """Write the whole register, wait settleMs, read it back and publish; mismatch is an error."""
        handle = self._require()
        rc = self.driver.set_mask(handle, mask)
        if rc != 0:
            raise DeviceError(f"JC_SDS48_Switch_SetMultiStatus failed rc={rc}", category=DEVICE_ERROR,
                              details={"rc": rc, "requested": mask, "relaysMayHaveMoved": True})
        self.shadow = mask
        if self.settle_s:
            time.sleep(self.settle_s)
        back = self._register()
        self.relays.publish(back)
        if back != mask:
            raise DeviceError(f"relay register reads {back:#014x} after writing {mask:#014x}", category=DEVICE_ERROR,
                              details={"requested": mask, "readBack": back, "differ": channels_of(back ^ mask)})
        return {"mask": back, "energized": channels_of(back)}

    # --- tools --------------------------------------------------------
    @tool(kind="actuate", output=Relays, safety_action="safe_state", effects=("relay_switched",),
          description="Energize (COM-OP) or release (COM-CL) one relay, wait settleMs (default 10 ms) and read the "
                      "drive register back; other relays keep their state. The register is not a contact "
                      "measurement.")
    def set_relay(self, channel: Relay, energized: param(bool, "true = COM-OP, false = COM-CL.")) -> dict[str, Any]:
        current = self._register()
        mask = current | 1 << channel if energized else current & ~(1 << channel)
        return self._apply(mask)

    @tool(kind="actuate", output=Relays, safety_action="safe_state", effects=("relay_switched",),
          description="Energize or release several relays in one register write (they move together), wait "
                      "settleMs and read the register back; relays not listed keep their state.")
    def set_relays(self, channels: param(list[Relay], "Relays 0..47 to change.", min_length=1, max_length=CHANNELS),
                   energized: param(bool, "true = COM-OP, false = COM-CL.")) -> dict[str, Any]:
        bits = 0
        for channel in channels:
            bits |= 1 << channel
        current = self._register()
        return self._apply(current | bits if energized else current & ~bits)

    @tool(kind="read", output=Relays, evidence="controller_state",
          description="Read the relay drive register: which relays are energized (COM-OP). It is the card's "
                      "register, not a contact measurement.")
    def read_relays(self) -> dict[str, Any]:
        mask = self._register()
        return {"mask": mask, "energized": channels_of(mask)}

    @tool(kind="safe", output=Relays,
          description="Release all 48 relays (every COM back to CL) in one register write and read it back.")
    def safe_state(self) -> dict[str, Any]:
        return self._apply(0)

    # --- self-test ----------------------------------------------------
    def self_test(self) -> list[Check]:
        identity = self.identity
        serial = identity.get("serialNumber")
        handle = self._require()
        mask = self._register()
        singles = 0
        failed_single = []
        for channel in range(CHANNELS):
            rc, status = self.driver.get_single(handle, channel)
            if rc != 0:
                failed_single.append(channel)
            singles |= (status & 1) << channel
        return [
            check_equal("读板卡信息", identity.get("infoRc"), 0, "JC_SDS48_Get_DevParInfo 返回码"),
            check_equal("板卡类型", f"{identity.get('cardType', 0):#x}", f"{CARD_TYPE:#x}", "dwCardType"),
            check_equal("继电器路数（板卡报告）", identity.get("channelMax"), CHANNELS, "dwChMax"),
            Check("序列号", bool(serial) and (self.serial is None or serial == self.serial), serial,
                  self.serial if self.serial is not None else "非零", f"cardId {identity.get('cardId')}"),
            check_equal("序列号寄存器", identity.get("snRegister"), serial, "JC_SDS48_GetDevSn 与设备信息一致"),
            check_equal("驱动寄存器 = 最后写入", f"{mask:#014x}", f"{self.shadow:#014x}",
                        "Switch_GetMultiStatus 与插件最后一次写入一致"),
            check_equal("逐路读回 = 整体读回", f"{singles:#014x}", f"{mask:#014x}",
                        f"Switch_GetSingleStatus × 48{f'，失败 {failed_single}' if failed_single else ''}；"
                        "只读寄存器，不动作继电器，触点通断须按 README 验收步骤测量"),
        ]

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        return {"relays": CHANNELS, "form": "SPDT", "energized": "COM-OP", "released": "COM-CL",
                "settleMs": self.settle_s * 1000, "contactSensing": False,
                "card": {"serialNumber": self.serial, "cardIndex": self.card_index}}

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)
