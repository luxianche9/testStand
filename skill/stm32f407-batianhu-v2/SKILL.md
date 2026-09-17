---
name: stm32f407-batianhu-v2
description: Create, maintain, review, and troubleshoot firmware for the Embedfire STM32F407 Batianhu V2 board (STM32F407ZGT6), including Keil MDK/ARMCC5 HAL projects, board pin mapping, jumpers and multiplexing, GPIO/EXTI/UART/DMA/ADC/TIM/I2C/SPI/FSMC/SDIO/I2S/CAN/RS485/RTC/USB, FreeRTOS, LwIP, BSP integration, and FireDAP/Keil build preparation. Use for explicit $stm32f407-batianhu-v2 requests and implicit Batianhu V2 firmware tasks. Do not use for Batianhu V1 or other STM32 boards.
---

# STM32F407 霸天虎 V2

Use this self-contained skill for the 野火/Embedfire 霸天虎 V2 board with STM32F407ZGT6. Never open, search, or quote an external board PDF, the original documentation directory, or another absolute documentation path at runtime. Use only this skill's `references/`, `assets/`, and `scripts/`. If a needed fact is absent, state that the skill does not contain it and ask for a schematic excerpt or measurement; do not silently return to the source material.

## Preserve Existing Projects

Inspect an existing project's compiler, HAL/SPL/LL choice, directory layout, clock tree, middleware versions, scatter file, and coding conventions before editing. Preserve that stack unless the user explicitly requests migration. The defaults below apply only when creating a new project.

## New-Project Defaults

- Board: Batianhu V2 only; MCU `STM32F407ZGT6` / Keil device `STM32F407ZGTx`.
- Toolchain: Keil MDK, ARMCC 5.06 update 7 build 960, STM32F4xx DFP 3.1.1.
- Firmware: STM32Cube HAL; use the bundled local CMSIS and HAL sources.
- Clock: 25 MHz HSE, PLLM 25, PLLN 336, PLLP 2, PLLQ 7; SYSCLK/HCLK 168 MHz, APB1 42 MHz, APB2 84 MHz.
- Memory: internal Flash 1 MiB; SRAM1 112 KiB, SRAM2 16 KiB, CCM 64 KiB. Never place DMA buffers in CCM.
- Baseline: LED on PF6, active low. Prefer SWD over full JTAG so PB3/PB4 remain usable.

Run `scripts/new_project.ps1 -Destination <directory> -ProjectName <name>` for a fresh project. Run `scripts/check_environment.ps1` before promising a local Keil build, and `scripts/build_project.ps1 -Project <uvprojx>` to build. Do not install the bundled pack automatically.

## Required Hardware Preflight

Before generating or changing peripheral code, explicitly check:

1. Voltage and electrical mode: 3.3 V logic, input tolerance, pull-ups, open-drain requirements, analog limits, and external transceiver power.
2. Jumpers and routes: BOOT, CAN/RS485 power/routing, serial selection, USB host/device, LCD/touch/audio/camera choices, and termination.
3. Shared pins and buses: compare every requested signal with `references/board-model.json` and the conflict tables in `references/board.md` and `references/peripherals.md`.
4. Clock tree: source frequency, APB timer doubling, USB/SDIO/RNG 48 MHz domain, Ethernet reference clock, and audio sample-clock requirements.
5. DMA: exact controller/stream/channel, direction, alignment, FIFO/burst settings, priority, and buffer memory region. Check conflicts between simultaneously enabled streams.
6. Interrupts: vector name, handler linkage, NVIC priority, HAL handler call, shared-vector interactions, and FreeRTOS maximum-syscall priority rules.
7. Timers and memory: timer/channel ownership, PWM polarity, tick source, stack/heap sizes, and linker regions.

Report unresolved conflicts before writing code. Do not invent a jumper state or board revision.

## Route the Task

- Read `references/board.md` for power, boot, clocks, memories, LEDs/buttons, connector groups, jumpers, shared nets, and known source contradictions.
- Query `references/board-model.json` for structured connector contacts, the complete vendor MCU pin/alternate-function rows, board resources, constraints, and source records.
- Read `references/peripherals.md` for HAL configuration, GPIO/EXTI/UART/DMA/ADC/TIM/PWM/I2C/SPI Flash/FSMC SRAM and LCD/SD/FatFs/I2S/CAN2/RS485/RTC/MPU6050/USB details.
- Read `references/keil-hal.md` when creating or modifying Keil projects, startup files, scatter files, compiler settings, HAL modules, or bundled BSP components.
- Read `references/rtos-network.md` for FreeRTOS, Ethernet RMII, LwIP, cache/buffer ownership, task priorities, and the bundled integration example.
- Read `references/debugging-flashing.md` for clock failures, interrupts, DMA, HardFault, HAL timeouts, bus conflicts, linker overflow, Keil build, FireDAP, and programming diagnosis.
- Read `references/source-provenance.md` only for source versions, licenses, hashes, and known conversion limits.

Load only the references relevant to the task. Use `assets/bsp/<module>` as board-specific source material and `assets/asset-manifest.json` to understand each module's dependencies, pins, DMA/IRQ needs, and provenance. Adapt vendor BSP code to the current project instead of blindly copying every module.

## Project and Code Rules

- Keep initialization deterministic: clocks, GPIO safe states, peripheral clocks, DMA, peripheral init, NVIC, then application start.
- Enable only required HAL modules in `stm32f4xx_hal_conf.h`.
- Pair every DMA setup with MSP initialization, IRQ handler, HAL DMA handler, and peripheral handle linkage.
- Make active-low signals explicit in names/comments; initialize outputs to an inactive state before switching GPIO mode when practical.
- Preserve vendor and third-party copyright/license headers.
- For combined features, provide a resource table listing pins, AFs, DMA streams/channels, IRQs, timers, jumpers, and conflicts.
- Treat examples as integration references, not proof that a combination is conflict-free.

## Side-Effect Boundary

Environment checks, project generation, and local compilation are allowed when requested by the task. Installing a device pack, changing drivers, flashing, erasing, resetting hardware, modifying option bytes, or changing BOOT jumpers requires explicit user authorization. The included DFP pack is an offline asset only.

## Scope

Support only Batianhu V2. Exclude Batianhu V1, uCOS, RT-Thread, LiteOS, emWin/emXGUI, and motor-control tutorial stacks. When asked for an excluded stack, explain the boundary and continue only if the user supplies an existing project whose stack must be preserved.
