"""Rebuild the testStand catalog and detailed model from the user's PDFs.

Run with a Python containing openpyxl; --docs selects the document root.
Connector pin numbers are schematic/contact numbers, never an inferred viewing order.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

import openpyxl

OUT = Path(__file__).resolve().parent
HID = "DUT_1"
LEGACY_485 = "251574e3-45eb-4ccd-9a0d-be332ee3ac06.J1"

# ref, title, physical connector type, source PDF page, signals in physical pin-number order.
PORTS = [
    ("J1", "SWD 下载", "XH-5AW / 1x5", 12, "3V3 PA13/SWDIO GND PA14/SWCLK NRST"),
    ("J45", "JTAG / SWD 下载", "2x10 2.54mm", 12,
     "3V3/VTREF 3V3/VDD PB4/nTRST GND PA15/TDI GND PA13/TMS_SWDIO GND PA14/TCK_SWCLK GND NC/RTCK GND PB3/TDO_SWO GND NRST GND NC/DBGRQ GND NC/DBGACK GND"),
    ("CN2", "GPIO 扩展 A", "2x30 2.54mm male", 5,
     "PA15 PA14 PA13 PB3 PB4 NRST PB5 GND BOOT0 PG6 PA9 PA3 PA10 PB2 PF0 PF1 PF2 PF3 PF4 PF5 PF12 PF13 PF14 PF15 PG0 PG1 PG2 PG3 PG4 PG5 PD11 PD12 PD13 PG12 PD14 PD15 PD0 PD1 PE7 PE8 PE9 PE10 PE11 PE12 PE13 PE14 PE15 PD8 PD9 PD10 PF6 PF7 PF8 PC3 PA0 PC13 GND GND 3V3 3V3"),
    ("CN3", "GPIO 扩展 B", "2x30 2.54mm male", 5,
     "PG11 PC4 PG13 PC5 PG14 PA1 PA7 PC1 GND PA2 PB12 PB13 PB14 PB15 PC0 PE3 PF10 PC6 PA8 PC7 PA6 PE4 PB7 PB6 PA4 PE5 PB8 PE6 PC2 PB9 PG7 PB0 PA11 PB1 PB10 PA12 PB11 PG15 PE2 PG10 PD4 PD5 PE0 PE1 PF11 GND PD6 PG8 PG9 PD3 PF9 PD7 PC8 PC11 PC9 PD2 PC10 PC12 PA5 VBAT"),
    ("J87", "电源引出", "2x4 2.54mm", 5, "5V 5V 3V3 3V3 3V3 3V3 GND GND"),
    ("JACK1", "DC 输入 6–12V（中心正）", "DC005 5.5x2.1mm", 3, "DC_IN_POS GND GND"),
    ("CN5", "RTC 电池 CR1220", "CR1220 holder", 12, "VBAT GND"),
    ("J8", "USB 转串口 / 5V 电源", "USB Mini-B contacts", 7, "5V_USB CH340_UD- CH340_UD+ NC/ID GND"),
    ("J24", "USB OTG FS", "USB Micro-B contacts", 12, "5V_USB PA11/USB_DM PA12/USB_DP PB1/ID GND"),
    ("J30", "USB HOST（与 OTG 共用 D+/D−）", "USB Type-A contacts", 12, "5V PA11/USB_DM PA12/USB_DP GND"),
    ("J13", "CAN2 总线（板载 120Ω）", "2-pin screw terminal", 7, "CANL CANH"),
    ("J15", "RS485 总线（板载 120Ω）", "2-pin screw terminal", 7, "485A 485B"),
    ("CON1", "RS232 母头 / USART3", "DE-9 female", 7, "NC RXD3_232/BOARD_RX TXD3_232/BOARD_TX NC GND NC NC NC NC"),
    ("CON2", "RS232 公头 / USART2", "DE-9 male", 7, "NC RXD2_232/BOARD_RX TXD2_232/BOARD_TX NC GND NC NC NC NC"),
    ("J40", "CAN/485 电源和 USART2 路由跳帽", "2x4 2.54mm", 7, "3V3 CAN_485_3V3 485_D 485_R PA2 PA3 RS232_T1IN RS232_R1OUT"),
    ("J69", "USART3 RX ↔ RS232 跳帽", "1x2 jumper", 7, "RS232_UART3_RX PB11"),
    ("J70", "USART3 TX ↔ RS232 跳帽", "1x2 jumper", 7, "RS232_UART3_TX PB10"),
    ("J80", "USART1 TX ↔ CH340 RX 跳帽", "1x2 jumper", 7, "CH340_RXD PA9"),
    ("J81", "USART1 RX ↔ CH340 TX 跳帽", "1x2 jumper", 7, "CH340_TXD PA10"),
    ("J82", "EBF Module 扩展", "1x6 2.54mm", 7, "3V3 GND PB11 PB10 PB1 PF10"),
    ("CN6", "FSMC 8080 液晶 / 触摸扩展", "2x16 2.54mm female", 6,
     "GND PF11 PD10 PD9 PD8 PE15 PE14 PE13 PE12 PE11 PE10 PE9 PE8 PE7 PD1 PD0 PD15 PD14 PD4 PD5 PF0 PG10 PG9 PD7 PD6 PD3 PG8 PF9 5V GND 3V3 GND"),
    ("J17", "DCMI 摄像头扩展", "2x10 2.54mm female", 8,
     "5V PC6 PC0 PC7 PF10 PC8 PA8 PC9 PA6 PE4 PB7 PB6 NC PE5 NC PE6 PA4 PB8 GND PB9"),
    ("J28", "Micro SD / TF 卡", "Micro SD contacts (9=detect,10–13=shell)", 8,
     "PC10/D2 PC11/D3 PD2/CMD 3V3 PC12/CLK GND PC8/D0 PC9/D1 NC/CD GND GND GND GND"),
    ("J54", "以太网 10/100M（外部触点 J1–J8）", "RJ45 cable contacts (not PCB pad numbering)", 9,
     "TX+ TX- RX+ TERMINATED TERMINATED RX- TERMINATED TERMINATED"),
    ("J5", "DHT11 / DS18B20 插座", "1x4 sensor socket", 10, "3V3 PE3/DATA GND GND"),
    ("J19", "LINE IN 音频输入（原理图焊脚编号）", "PJ-325C5-R", 11,
     "LINE_L/WM8978_LI2 LINE_L/WM8978_LI2 LINE_R/WM8978_RI2 LINE_R/WM8978_RI2 GND"),
    ("J20", "PHONE 耳机输出（原理图焊脚编号）", "PJ-325C5-G", 11,
     "3V3_VIA_10K PHONE_L PHONE_R PHONE_R GND"),
    ("J22", "扬声器输出（桥接，两端均非地）", "PH2.0 2-pin", 11, "SPK_P SPK_N"),
    ("J63", "BOOT 上侧电源跳帽", "1x2 jumper", 5, "3V3 3V3"),
    ("J64", "BOOT0 / BOOT1 选择", "1x2 jumper", 5, "BOOT0_VIA_10K PB2_BOOT1_VIA_10K"),
    ("J65", "BOOT 下侧接地跳帽", "1x2 jumper", 5, "GND GND"),
    ("J66", "ESP8266 电源跳帽", "1x2 jumper", 6, "3V3 3V3_WIFI"),
    ("J83", "ESP8266 下载模式跳帽", "1x4 jumper", 6, "3V3 WIFI_EN WIFI_GPIO0 GND"),
    ("J84", "ESP8266 TX → USART3 RX", "1x2 jumper", 6, "WIFI_TXD PB11"),
    ("J85", "ESP8266 RX ← USART3 TX", "1x2 jumper", 6, "WIFI_RXD PB10"),
    ("J73", "RGB LED 共阳电源跳帽", "1x2 jumper", 10, "3V3 RGB_ANODE"),
    ("J77", "电位器 → ADC 跳帽", "1x2 jumper", 10, "PB0 POT_WIPER"),
    ("J78", "电容触摸按键跳帽", "1x2 jumper", 10, "PA5 TOUCH_PAD"),
]

# User-approved first phase: common external connectors only. Other transcriptions
# above are source notes, not exported hardware ports.
COMMON_REFS = {"J1", "J45", "CN2", "CN3", "J87", "JACK1", "J8", "J24", "J13", "J15", "CON1", "CON2", "J82", "J5"}
JUMPER_REFS = {"J40", "J69", "J70", "J80", "J81", "J63", "J64", "J65", "J66", "J83", "J84", "J85", "J73", "J77", "J78"}
RESOURCES = [
    {"ref":"U19", "name":"STM32F407ZGT6", "kind":"MCU", "clockHzMax":168000000,
     "flashBytes":1048576, "sramBytes":196608, "sramBreakdown":"112 KiB SRAM1 + 16 KiB SRAM2 + 64 KiB CCM; separate 4 KiB backup SRAM",
     "package":"LQFP144", "gpioCount":114, "externalGpioCount":110, "sourcePage":4},
    {"ref":"U23","name":"IS62WV51216BLL","kind":"SRAM","bytes":1048576,"bus":"FSMC NE1 / PG12, 16-bit","sourcePage":12},
    {"ref":"U24","name":"W25Q128JV","kind":"SPI NOR","bytes":16777216,"pins":{"CS":"PG6","SCK":"PB3","MISO":"PB4","MOSI":"PB5"},"sourcePage":8},
    {"ref":"U21","name":"AT24C02","kind":"EEPROM","bytes":256,"i2c7bit":"0x50","bus":"PB8/SCL PB9/SDA","sourcePage":8},
    {"ref":"U20","name":"ESP8266","kind":"Wi-Fi","pins":{"TX":"PB11 via J84","RX":"PB10 via J85","EN":"PE2","RST":"PG15"},"sourcePage":6},
    {"ref":"U22","name":"W25Q64JVSSIQ","kind":"ESP8266 private SPI NOR","bytes":8388608,"sourcePage":6},
    {"ref":"U16","name":"LAN8720A","kind":"RMII PHY","pins":{"REF_CLK":"PA1","MDIO":"PA2","MDC":"PC1","CRS_DV":"PA7","RXD0":"PC4","RXD1":"PC5","TX_EN":"PG11","TXD0":"PG13","TXD1":"PG14","RESET":"NRST"},"sourcePage":9},
    {"ref":"U7","name":"SIT1042AQT/3 (older TJA1042T/3)","kind":"CAN transceiver","pins":{"RX":"PB12/CAN2_RX","TX":"PB13/CAN2_TX"},"terminationOhms":120,"sourcePage":7},
    {"ref":"U8","name":"SIT3088EESA (older MAX485)","kind":"RS485 transceiver","pins":{"DIR":"PC0 (DE and /RE tied)","TX":"PA2 via J40 3-5","RX":"PA3 via J40 4-6"},"terminationOhms":120,"sourcePage":7},
    {"ref":"U6","name":"SIT3232EESE (older MAX3232)","kind":"RS232 transceiver","sourcePage":7},
    {"ref":"U5","name":"CH340C","kind":"USB UART / ISP","pins":{"TX":"PA10 via J81","RX":"PA9 via J80","DTR":"automatic NRST circuit","RTS":"automatic BOOT0 circuit"},"sourcePage":7},
    {"ref":"U4","name":"MPU6050","kind":"6-axis IMU","bus":"PB8/SCL PB9/SDA","i2c7bit":"0x68","pins":{"INT":"PF10"},"sourcePage":10},
    {"ref":"U14","name":"AP3216C","kind":"ambient light / proximity / IR","bus":"PB8/SCL PB9/SDA","i2c7bit":"0x1E","pins":{"INT":"PE3"},"sourcePage":10},
    {"ref":"U17","name":"WM8978","kind":"audio codec","bus":"PB8/SCL PB9/SDA","i2c7bit":"0x1A","pins":{"LRCLK":"PB12","BCLK":"PB13","ADCDAT":"PB14","DACDAT":"PB15","MCLK":"PC6"},"sourcePage":11},
    {"ref":"SW1","name":"KEY1 / WKUP","kind":"button","pin":"PA0","activeLevel":1,"sourcePage":10},
    {"ref":"SW3","name":"KEY2 / TAMPER","kind":"button","pin":"PC13","activeLevel":1,"sourcePage":10},
    {"ref":"SW2","name":"RESET","kind":"button","pin":"NRST","activeLevel":0,"sourcePage":12},
    {"ref":"U1","name":"main power switch","kind":"mechanical control","sourcePage":3},
    {"ref":"D6","name":"RGB common-anode LED","kind":"LED","pins":{"R":"PF6","G":"PF7","B":"PF8"},"activeLevel":0,"sourcePage":10},
    {"ref":"D48","name":"blue user LED","kind":"LED","pin":"PC3","activeLevel":0,"sourcePage":10},
    {"ref":"D4","name":"power LED","kind":"LED","sourcePage":3},
    {"ref":"D46/D49","name":"Wi-Fi power / TX LEDs","kind":"LED","sourcePage":6},
    {"ref":"PZ1","name":"active buzzer","kind":"buzzer","pin":"PG7","activeLevel":1,"sourcePage":10},
    {"ref":"RA1","name":"1 kohm potentiometer","kind":"analog input","pin":"PB0 via J77","rangeVolts":[0,3.3],"sourcePage":10},
    {"ref":"TPAD1","name":"capacitive touch","kind":"RC timing input (not dedicated CTSU)","pin":"PA5 via J78","sourcePage":10},
    {"ref":"J6","name":"HS0038B infrared receiver (soldered)","kind":"IR receiver","pin":"PA8","sourcePage":10},
    {"ref":"P1","name":"onboard microphone","kind":"analog audio input","sourcePage":11},
    {"ref":"Y8/Y7","name":"MCU HSE/LSE crystals","kind":"clock","hseHz":25000000,"lseHz":32768,"pins":["PH0","PH1","PC14","PC15"],"sourcePage":4},
]

CONSTRAINTS = [
    {"pins":["PB10","PB11"],"resources":["CON1 RS232","ESP8266","J82 EBF"],"rule":"USART3 is shared. Select J69/J70 or J84/J85; do not tie two external TX outputs onto PB11."},
    {"pins":["PA2","PA3"],"resources":["CON2 RS232","J15 RS485","LAN8720A MDIO on PA2"],"rule":"J40 3-5/4-6 selects 485; 5-7/6-8 selects RS232. USART2 TX on PA2 conflicts with Ethernet MDIO."},
    {"pins":["PB12","PB13"],"resources":["CAN2","WM8978 I2S2"],"rule":"CAN and audio I2S cannot operate on these pins simultaneously."},
    {"pins":["PC0"],"resources":["RS485 direction","camera power-down"],"rule":"Both are hard-wired; no software-only independent control."},
    {"pins":["PF10"],"resources":["MPU6050 interrupt","camera reset","EBF"],"rule":"Shared net; external drive can conflict with IMU output."},
    {"pins":["PC8","PC9"],"resources":["SDIO","camera data"],"rule":"Camera and SDIO share data pins."},
    {"pins":["PA8"],"resources":["IR receiver output","camera XCLK"],"rule":"Shared with an onboard output; check board isolation before driving XCLK."},
    {"pins":["PE3"],"resources":["AP3216C interrupt","DHT11/DS18B20"],"rule":"Shared interrupt/sensor data net."},
    {"pins":["PC6"],"resources":["WM8978 MCLK","camera D0"],"rule":"Audio master clock conflicts with camera data."},
    {"pins":["PB3","PB4"],"resources":["SPI Flash","JTAG/SWO"],"rule":"Use SWD without SWO to free PB3/PB4; full JTAG conflicts with SPI Flash."},
    {"pins":["PA11","PA12"],"resources":["J24 USB device","J30 USB host"],"rule":"Same USB FS data pair; connect/use only one role at a time."},
    {"pins":["PB1"],"resources":["USB OTG ID","EBF"],"rule":"Shared net."},
    {"pins":["PB8","PB9"],"resources":["EEPROM","IMU","light sensor","audio control","camera SCCB"],"rule":"Shared I2C bus with parallel pull-ups. Use distinct 7-bit addresses; check camera address/pull-ups."},
    {"pins":["FSMC data/address/control"],"resources":["SRAM","LCD"],"rule":"Shared FSMC bus; separate chip selects (SRAM PG12 NE1, LCD PG10 NE3), valid bank timings required."},
    {"pins":["CANL","CANH","485A","485B"],"resources":["J13","J15"],"rule":"Each port has a fixed 120-ohm board termination; count it in total bus termination."},
    {"pins":["J40.1","J40.2"],"resources":["CAN","RS485"],"rule":"Install J40 1-2 to supply CAN/485 logic; other routes do not supply it."},
    {"pins":["SPK_P","SPK_N"],"resources":["J22"],"rule":"Bridge-driven speaker output. Neither pin is ground."},
    {"pins":["VTREF","3V3"],"resources":["FireDAP","SWD"],"rule":"FireDAP VREF is target-voltage reference. Supply board separately; do not assume probe powers it."},
    {"pins":["GPIO"],"resources":["CN2","CN3"],"rule":"3.3V logic. Only datasheet-designated FT inputs tolerate 5V under stated conditions; analog inputs must stay within VDDA. RS232 voltages never connect directly to GPIO."},
]


def save(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build(docs: Path):
    schematic = next(docs.glob("2-*/F407_霸天虎V2/原理图/*2025.pdf"))
    spec = docs / "[野火]STM32F407_霸天虎V2开发板硬件规格书.pdf"
    xlsx = next(docs.glob("2-*/F407_霸天虎V2/*.xlsx"))
    dap = next(docs.glob("5-*/*DAP高速*/1-*.pdf"))
    sources = [{"id":key,"path":str(path),"sha256":hashlib.sha256(path.read_bytes()).hexdigest()}
               for key,path in [("schematic",schematic),("spec",spec),("io",xlsx),("dap",dap)]]
    selected = [entry for entry in PORTS if entry[0] in COMMON_REFS]
    # All GPIO alternates and package pin numbers in the vendor spreadsheet are preserved.
    workbook = openpyxl.load_workbook(xlsx, data_only=True)
    io_rows = [{"sheet":sheet.title,"row":index,"values":list(row)} for sheet in workbook
               for index,row in enumerate(sheet.iter_rows(values_only=True),1) if any(v is not None for v in row)]
    alternates = {}
    for row in io_rows:
        vals = row["values"]
        if len(vals) >= 2 and isinstance(vals[0],int) and isinstance(vals[1],str):
            found = re.match(r"(P[A-I]\d+)", vals[1].strip())
            if found:
                alternates[found[1]] = {"packagePin":vals[0],"description":vals[1],"sourceSheet":row["sheet"],"sourceRow":row["row"]}
    ports=[]
    detailed=[]
    for ref,title,connector,page,signals in selected:
        if ref == "JACK1":
            signals = "DC_IN_CENTER_POS GND_OUTER_SLEEVE"
        port_id = LEGACY_485 if ref == "J15" else "J1" if ref == "J13" else f"{HID}.{ref}"
        pins=[]
        for index,signal in enumerate(signals.split(),1):
            pin_id=f"{port_id}.{index}"
            pins.append({"pinId":pin_id,"position":index,"label":signal})
        ports.append({"portId":port_id,"name":f"{ref} · {title}","pins":pins})
        detailed.append({"ref":ref,"portId":port_id,"title":title,"connectorType":connector,
                         "pinNumbering":"External contact labels: 1=center positive, 2=outer ground; schematic pads 2/3 both connect to ground" if ref == "JACK1" else "Connector contact/pin numbers as shown in the schematic; not an arbitrary photo viewing order",
                         "source":{"id":"schematic","page":page},"pins":[{**pin,"net":pin["label"].split('/')[0],
                         **({"mcu":alternates[pin["label"].split('/')[0]]} if pin["label"].split('/')[0] in alternates else {})} for pin in pins]})
    hardware={"formatVersion":2,"hardwareId":HID,"label":"野火 STM32F407 霸天虎 V2（STM32F407ZGT6）","kind":"passive","ports":ports}
    save(OUT / "hardware.json", hardware)
    configurations = [{"ref":ref,"name":title,"sourcePage":page,
                       "contacts":[{"position":i,"signal":s} for i,s in enumerate(signals.split(),1)]}
                      for ref,title,_,page,signals in PORTS if ref in JUMPER_REFS - {"J63","J64","J65"}]
    configurations.append({"ref":"BOOT","name":"BOOT 3x2 configuration area (J63/J64/J65)","sourcePage":5,
                           "rows":[{"ref":"J63","contacts":["3V3","3V3"]},{"ref":"J64","contacts":["BOOT0 via 10k","PB2/BOOT1 via 10k"]},{"ref":"J65","contacts":["GND","GND"]}],
                           "rule":"Bridge vertically to select BOOT0/BOOT1 levels; BOOT0=0 selects user Flash. Do not bridge horizontally between BOOT0 and BOOT1."})
    selected_resources = [r for r in RESOURCES if r["ref"] in {"U19","U24","U21","U7","U8","U6","U5","SW1","SW3","SW2","U1","D6","D48","D4","PZ1","RA1","TPAD1","Y8/Y7"}]
    save(OUT / "model.json", {"modelVersion":1,"hardwareId":HID,"boardRevision":"V2; connector map from supplied 2025 schematic",
         "scope":{"phase":"common connectors only","excluded":["LCD/video/camera","audio","Ethernet connector","TF card","USB HOST","RTC battery holder"],"configurationRecordsAreNotWiringPorts":True},
         "manufacturer":"Embedfire / 野火","mcu":"STM32F407ZGT6","dimensionsMm":[176,125],
         "modelBoundary":"Physical connector/contact map + onboard resources, shared nets and configurable jumper routes. Not a firmware behavior simulation.",
         "power":{"logicVolts":3.3,"usbInputVolts":5,"dcInputVolts":[6,12],"barrel":"5.5x2.1 mm, center positive","sourcePage":3},
         "boot":{"BOOT0=0":"internal Flash; BOOT1 don't care","BOOT0=1,BOOT1=0":"system bootloader / ISP","BOOT0=1,BOOT1=1":"SRAM",
                 "jumperRule":"Boot header is physically a 3x2 arrangement J63/J64/J65; bridge vertically from J64 to 3V3 or GND, not across BOOT0/BOOT1."},
         "ports":detailed,"boardConfigurations":configurations,"resources":selected_resources,
         "constraints":[c for c in CONSTRAINTS if c["pins"] not in [["PC8","PC9"],["PC6"],["SPK_P","SPK_N"],["FSMC data/address/control"]]],
         "constraintScope":"Excluded peripherals are named only where they electrically share a modeled signal; their interfaces/behavior are not modeled.",
         "mcuAlternateFunctions":alternates,"vendorIoRows":io_rows,"sources":sources,
         "discrepancies":[
             "Specification p12 table says W25Q64/8MB, but p18 text and schematic p8 U24 say W25Q128/16MB. Model uses U24 schematic; confirm actual chip marking/JEDEC ID if necessary.",
             "Specification p12 says ESP8266 Flash 1MB, schematic p6 U22 is W25Q64 (8MiB); model records schematic, actual fitted variant not electronically verified.",
             "Specification p18 calls AT24C02 2KB (256 bytes). Correct capacity is 2Kbit=256 bytes, also stated in schematic p8.",
             "Latest supplied schematic history adds SIT CAN/485/232 replacement parts (2024-08-26). Header title remains V2.0; several drawing dates are January 2026 despite 2025 filename. Sources identified by SHA-256.",
             "STM32F407 has no dedicated CTSU; capacitive key uses external RC and GPIO/timer.",
             "Schematic p4 U19A symbol prints PC1 at package pin27 and PC0 at pin26, but net labels PC0/PC1 and the vendor IO sheet match ST package pins27=PC0,26=PC1. Model follows net labels and package datasheet.",
             "Existing testStand CAN portId J1 is retained for compatibility; physical SWD J1 uses portId DUT_1.J1. Existing RS485 IDs retained, labels corrected to physical 1=A,2=B.",
             "RJ45 pins use cable contact J1..J8, not the magnetics' PCB pad numbers. Audio jacks use original schematic solder-pad numbers; those are not TRS contact positions.",
         ]})
    with zipfile.ZipFile(OUT / "stm32-batianhu-v2.tshw", "w",zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("bundle.json",json.dumps({"formatVersion":2,"kind":"hardware","id":HID}))
        archive.writestr("hardware.json",json.dumps({k:v for k,v in hardware.items() if k!='kind'},ensure_ascii=False))
    print(f"Built {len(ports)} ports / {sum(len(p['pins']) for p in ports)} pins / {len(selected_resources)} resources / {len(configurations)} configuration records")


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--docs",type=Path,default=Path("E:/Project/learnSTM32/doc"))
    build(parser.parse_args().docs)
