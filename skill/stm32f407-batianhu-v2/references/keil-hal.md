# Keil MDK and HAL project rules

## Bundled baseline

`assets/keil-hal-template` is a local-source Keil project for STM32F407ZG. It contains CMSIS device/core headers, `startup_stm32f407xx.s`, STM32F4 HAL sources, a scatter file/project configuration, and an LED baseline. It intentionally excludes compiler output and per-user Keil state.

The baseline clock configuration assumes a 25 MHz HSE and generates 168 MHz SYSCLK with PLLM=25, PLLN=336, PLLP=2, PLLQ=7. `HSE_VALUE` must remain 25000000 unless the physical oscillator differs. The LED baseline toggles PF6 active-low.

Use:

```powershell
scripts/new_project.ps1 -Destination E:\work\demo -ProjectName demo
scripts/build_project.ps1 -Project E:\work\demo\Project\demo.uvprojx
```

## Existing project rule

Do not replace an existing project with this template. First inspect `.uvprojx`, device, compiler version, defines, include paths, memory map, HAL configuration, startup file, system clock, middleware, source groups, and post-build commands. Preserve them unless migration is explicit.

## Required Keil settings for new projects

- Device `STM32F407ZGTx`; define `STM32F407xx` and `USE_HAL_DRIVER`.
- ARMCC 5.06 update 7 build 960, ARM mode settings appropriate for Cortex-M4F, hardware FPU where project/library ABI matches.
- DFP metadata version 3.1.1. The sources required for the baseline build are local; the bundled pack is for offline installation only.
- Startup file must be `startup_stm32f407xx.s`, not F405/F429 or a generic mismatched vector table.
- Output names follow the project name; generate AXF and HEX. Keep listing/object output below the project and removable.
- Default internal Flash is `0x08000000` size `0x00100000`; main SRAM is `0x20000000` size `0x00020000`. CCM needs an explicit execution/data region and cannot contain DMA objects.

## Adding a BSP module

1. Read `assets/asset-manifest.json` and the module header/source.
2. Copy only required files into the project's BSP area, preserving license headers.
3. Add include paths and sources to a coherent Keil group.
4. Enable required HAL modules in `stm32f4xx_hal_conf.h`.
5. Add MSP clock/GPIO/DMA/NVIC setup and IRQ handlers.
6. Reconcile legacy HAL macro names and encoding before compiling; vendor files span tutorial revisions.
7. Build with warnings visible. Do not suppress type, format, alignment, or implicit-declaration warnings to make old code pass.

## HAL dependencies

Common dependencies include RCC/CORTEX/GPIO for nearly every peripheral, DMA for streamed transfers, EXTI through GPIO, and PCD/HCD/ETH/SD/FSMC/I2S/CAN as feature-specific modules. HAL peripheral source files often depend on the matching `_ex.c` file. Let compile/link errors guide missing modules, but never add the entire HAL library without reviewing footprint and handlers.

## Startup and interrupt checklist

- Vector spelling exactly matches the startup file.
- `stm32f4xx_it.c` handler calls the correct `HAL_*_IRQHandler` using the same handle initialized by the BSP.
- DMA handle is linked using `__HAL_LINKDMA` before enabling transfers.
- Clear pending flags before NVIC enable when reconfiguring active peripherals.
- With FreeRTOS, priority grouping and numerical priorities obey `configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY`.

## Template maintenance

Never commit `Objects`, `Listings`, `Output`, `.uvoptx`, `.uvguix.*`, build logs, or debugger state into the template. The generation script removes these patterns after copying. Keep the template restricted to STM32F407ZG even if upstream CMSIS directories contain headers for sibling STM32F4 devices.
