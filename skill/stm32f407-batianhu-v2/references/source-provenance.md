# Provenance and conversion record

This skill is a self-contained conversion. Runtime use must rely on the Markdown, JSON, source, template and middleware files stored inside the skill. Source filenames below are identifiers for audit only, not instructions to retrieve or open external files.

| Source identifier | Version/name | SHA-256 |
|---|---|---|
| Board schematic | `野火STM32F407_霸天虎V2开发板原理图2025.pdf` | `1285275b9dc3f546cdedcb0d93bcd2476eaea47300451be65a3ac19480aeb095` |
| Hardware specification | `[野火]STM32F407_霸天虎V2开发板硬件规格书.pdf` | `6ec987786f94e11110026668d10ddf426bc96a6b51871cce628ff77116fceb43` |
| IO allocation table | `野火F407霸天虎V2开发板IO分配表.xlsx` | `ff37d14fce450ed69ebcfd2513d27f53cbd3d69c0eea7b8bb130ba913e6e494f` |
| FireDAP guide | `1-DAP高速款使用说明.pdf` | `e327c946de56ac6390b15817e27613636562bf757daf71554d88cc3f2fe079cd` |
| Device family pack | `Keil.STM32F4xx_DFP.3.1.1.pack` | `345231106fe697df24bbe9133aeeec1b0383d7891c4adf4f47bbb8b478e9f2f0` |

## Asset policy

- No source document, video, slide deck, installer, or broad tutorial archive is retained.
- `board-model.json` and the Markdown references are the normalized board knowledge.
- `assets/keil-hal-template` is a trimmed STM32F407ZG HAL/Keil baseline.
- `assets/bsp` contains selected board modules. Files preserve their original copyright/license headers and may use tutorial-era encodings or HAL spellings.
- `assets/middleware/tutorial_code/LwIP_iperf` contains only the pinned FreeRTOS, LwIP and necessary user adaptation sources extracted from a vendor example.
- The DFP package is retained byte-for-byte for optional offline installation; scripts only hash/report it.

## Conversion limits

The connector and MCU pin tables are normalized from supplied sources, but fitted component variants can change. Flash capacity, transceiver replacements, one Ethernet comment, and a few source dates conflict; these are recorded in `board.md` and `board-model.json`. When a result depends on the fitted silicon or jumper population, read an electronic ID or inspect the board rather than guessing.
