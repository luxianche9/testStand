# Batianhu V2 board reference

This reference covers only the Embedfire/野火 霸天虎 V2 fitted with STM32F407ZGT6. The structured companion is `board-model.json`; its `vendorIoRows` section is the machine-readable MCU/package pin and alternate-function table.

## Core device, power, boot, and clocks

| Item | Board fact |
|---|---|
| MCU | STM32F407ZGT6, LQFP144, Cortex-M4F, 1 MiB internal Flash |
| Logic | 3.3 V; do not apply 5 V unless the selected MCU pin and board circuit are explicitly 5-V tolerant |
| Inputs | USB 5 V or 6–12 V center-positive barrel input; use one intended source and inspect jumper/power-switch state |
| HSE / LSE | 25 MHz / 32.768 kHz |
| Default tree | SYSCLK/HCLK 168 MHz, PCLK1 42 MHz, PCLK2 84 MHz, PLL48 48 MHz |
| SRAM | SRAM1 112 KiB at `0x20000000`; SRAM2 16 KiB at `0x2001C000`; contiguous main SRAM ends at `0x20020000` |
| CCM | 64 KiB at `0x10000000`; CPU-only for normal use, not reachable by DMA |
| Backup SRAM | 4 KiB at `0x40024000`, powered from backup domain when configured |
| Boot | BOOT0=0: user Flash; BOOT0=1/BOOT1=0: system bootloader; both 1: SRAM |

The BOOT header is a physical 3-by-2 J63/J64/J65 arrangement. Bridge each BOOT selector vertically to 3V3 or GND; never short BOOT0 to BOOT1 horizontally.

## On-board resources

| Function | Connection / behavior |
|---|---|
| RGB LED | PF6 red, PF7 green, PF8 blue; common anode, active low |
| User keys | KEY1/WKUP PA0, KEY2/TAMPER PC13; verify idle level before selecting EXTI edge |
| Potentiometer | PB0 / ADC1 channel 8 |
| Active buzzer | Consult `board-model.json` resource/constraint entry before allocation; it shares board GPIO resources |
| SPI NOR | W25Q128-class device: SPI1 PB3 SCK, PB4 MISO, PB5 MOSI, PG6 CS |
| EEPROM | AT24C02 on I2C1 PB8/PB9; 2 Kbit = 256 bytes; HAL 8-bit address form `0xA0` |
| Sensors | MPU6050 and AP3216C use I2C1 PB8/PB9; AP3216C interrupt is PE3 in the bundled BSP |
| CAN2 | PB12 RX, PB13 TX through on-board transceiver; 120-ohm termination is board-routed |
| RS485 | USART2 PA2 TX, PA3 RX, PC0 DE/RE; J40 selects routing and transceiver power |
| RS232 | USART2/USART3 routes are selected by jumpers; do not drive an RS232 transceiver and another module from the same TX net |
| USB serial | CH340C route supplies a UART/power path; confirm selected UART route before enabling another use |
| SD/TF | SDIO PC8 D0, PC9 D1, PC10 D2, PC11 D3, PC12 CK, PD2 CMD |
| USB FS | PA11 DM, PA12 DP; host and device connectors share the same FS pair |
| Ethernet | RMII PHY: PA1 REF_CLK, PA2 MDIO, PA7 CRS_DV, PC1 MDC, PC4 RXD0, PC5 RXD1, PG11 TX_EN, PG13 TXD0, PG14 TXD1 |
| Audio | WM8978 control on I2C1; I2S2 PB12 WS, PB13 CK, PB14 SDext/RX, PB15 SD/TX, PC6 MCLK |

WM8978 has 7-bit I2C address `0x1A`; many HAL calls and the bundled BSP express the shifted 8-bit value `0x34`. MPU6050 likewise appears as 7-bit `0x68` or shifted `0xD0`. Keep address convention explicit.

## FSMC LCD and external SRAM

The 16-bit FSMC data bus is shared by display and external memory:

| Bus bit | Pin | Bus bit | Pin |
|---|---|---|---|
| D0..D3 | PD14, PD15, PD0, PD1 | D4..D7 | PE7, PE8, PE9, PE10 |
| D8..D12 | PE11, PE12, PE13, PE14, PE15 | D13..D15 | PD8, PD9, PD10 |

Common control pins are PD4 NOE and PD5 NWE. The LCD uses FSMC Bank1 NOR/SRAM3 (NE3 PG10) and A0 PF0 as register select. Its command address is `0x68000000`, data address `0x68000002`; PF9 controls backlight and PF11 resets the panel. Supported bundled panel drivers are ILI9806G and NT35510. Touch and panel identification signals share the LCD/camera expansion area; allocate them from the exact connector record before use.

The external asynchronous SRAM BSP uses Bank1 NOR/SRAM4 at `0x6C000000`, NE4 PG12, address A0..A18, the same D0..D15, PD4/PD5 and byte lanes PE0/PE1. LCD and SRAM can coexist as different FSMC banks but share timing-relevant bus wires; initialize both consistently and avoid concurrent unsynchronized access.

## High-risk multiplexing

| Shared resource | Collision to report |
|---|---|
| PB3/PB4/PB5 | SPI1 Flash collides with full JTAG/SWO functions; use SWD-only and disable trace/JTAG remap as required |
| PB8/PB9 | EEPROM, MPU6050, AP3216C, WM8978 control, and camera control share I2C1; coordinate addresses, pull-ups, bus speed, and task locking |
| PB12/PB13 | CAN2 conflicts electrically and functionally with I2S2 WS/CK; do not enable both on their board routes |
| PA2 | USART2 TX/RS485/RS232 collides with Ethernet RMII MDIO |
| PA11/PA12 | USB host and USB device connectors share one OTG FS peripheral and D-/D+ pair |
| PC8..PC12, PD2 | SDIO owns six pins and DMA2 streams; check other alternate functions and DMA allocations |
| FSMC D0..D15/control | LCD and SRAM share the external bus; external connector use of these pins is not independent |
| USART3 PB10/PB11 | RS232, ESP8266 and EBF expansion routes are jumper-selected; never connect multiple transmitters |
| PC6 | WM8978 MCLK can collide with timer/camera functions |

## Connector and jumper workflow

`board-model.json` contains contact-by-contact records for SWD/JTAG, GPIO expansion, power, USB serial, USB OTG FS, CAN2, RS485, RS232, EBF module, and sensor sockets. It also preserves J40 and other configuration-header contact maps. For any cable or fixture:

1. Select the connector by reference designator, not by photo orientation.
2. Use its `position`, `label`, `net`, voltage, and direction metadata.
3. Resolve every `constraints` entry containing those MCU pins.
4. State required jumper bridges in the result; if the skill lacks a definite default, ask the user to inspect the physical board.

## Known source contradictions

- Flash capacity is described once as W25Q64/8 MiB, while the board resource and later description indicate W25Q128/16 MiB. Read JEDEC ID when capacity matters.
- AT24C02 is sometimes called “2 KB”; its actual capacity is 2 Kbit, 256 bytes.
- One Ethernet source comment labels TX_EN as PB11, but the routed net and driver header use PG11. Use PG11.
- Replacement CAN/RS485/RS232 transceiver part numbers vary across revisions; firmware-facing MCU pins are unchanged, but verify the fitted device for electrical limits.
- Source drawing dates and the nominal filename year differ. Provenance is anchored by SHA-256, not by the displayed year alone.

Do not resolve a contradiction by assumption when it affects hardware safety or data integrity.
