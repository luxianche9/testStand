# Build, runtime, and programming troubleshooting

## First evidence to collect

Capture the `.uvprojx` target, compiler banner, complete build log, map file, actual board revision, power/BOOT/jumper state, debugger type, reset mode, and the smallest failing feature. Do not change several clock/pin/DMA settings at once.

## Clock failures

Symptoms: stuck in `HAL_RCC_OscConfig`, wrong UART baud, USB/SDIO failure, timers off by a constant factor.

- Confirm physical HSE is 25 MHz and both `HSE_VALUE` and PLLM are 25 MHz-aware.
- Inspect RCC ready flags and `HAL_RCC_GetSysClockFreq/HCLK/PCLK` under debugger.
- Check flash latency, voltage scale, OverDrive expectations, APB prescalers, PLLQ=7 for 48 MHz.
- Remember APB timers receive 2x PCLK when APB prescaler is not 1.

## Interrupt never enters

- Verify peripheral event/interrupt enable, NVIC enable, pending flag, exact vector symbol, startup file, and that the handler calls the right HAL IRQ handler.
- Check EXTI line-to-port selection, edge polarity, pull resistor and switch idle level.
- Under FreeRTOS, validate priority grouping and maximum-syscall priority; an illegal priority often fails later rather than at NVIC setup.

## DMA failure or corruption

- Confirm controller, stream and channel against the feature table; then direction, increment, data width, FIFO/burst and peripheral request enable.
- Link the DMA handle and implement the stream IRQ. Clear old flags before reuse.
- Ensure buffer resides in SRAM1/SRAM2, not CCM, and remains alive/aligned for the whole transfer.
- Check stream collisions: ADC1 commonly DMA2 S0 C0; SDIO RX S3 C4/TX S6 C4; USART1 TX S7 C4; I2S2 TX DMA1 S4 C0 and RX S3 C3.

## HardFault

Read stacked R0-R3, R12, LR, PC, xPSR plus SCB CFSR/HFSR/MMFAR/BFAR. Resolve the faulting instruction from the AXF/map. Frequent causes are invalid function pointers, stack overflow, unaligned/wrong-width FSMC access, DMA memory misuse, use-after-return, and calling RTOS APIs from an illegal interrupt priority. Enable MemManage/BusFault/UsageFault during diagnosis.

## Bus conflict and HAL timeout

- For I2C busy: inspect SDA/SCL levels, address convention, pull-ups and another client holding the bus.
- For SPI ID mismatch: release full JTAG ownership of PB3/PB4 and verify PG6 CS.
- For CAN/audio failure: PB12/PB13 cannot serve both board routes.
- For RS485/Ethernet failure: PA2 is shared; inspect J40 and transceiver power.
- For USB: verify 48 MHz, connector role and VBUS behavior.
- A HAL timeout is a symptom. Determine which status flag did not change and whether its clock, pin, DMA/IRQ, electrical peer, or lock state is missing.

## Linker or region overflow

- Use the map file to sort largest code/data objects. Remove unused HAL modules/debug tables before changing memory regions.
- Internal main SRAM is 128 KiB total; CCM is separate 64 KiB. Place CPU-only stacks/heaps/tables in CCM only with a deliberate scatter region.
- Never move ETH/SDIO/SPI/UART/ADC/audio DMA buffers to CCM to silence an overflow.
- Check FreeRTOS heap, LwIP pools, audio buffers, LCD frame buffers and FatFs buffers together. A full LCD framebuffer usually requires external memory or reduced format/tiling.

## Keil build failures

Run `scripts/check_environment.ps1`, then `scripts/build_project.ps1`. If the pack is missing, the bundled project should still compile from local CMSIS/HAL sources, but Keil device metadata or debug algorithms may be unavailable. Do not install the bundled pack without explicit authorization. ARMCC error L6218 normally means a missing source/handler; region errors L6406/L6407 require scatter/map inspection rather than arbitrary size changes.

## FireDAP / programming failure

These actions have hardware side effects and require explicit user authorization.

1. Verify 3.3 V target reference, common ground, SWDIO PA13, SWCLK PA14, optional NRST, and that the board is powered exactly once.
2. Start with SWD at a low clock and “connect under reset” if user code disables debug pins, enters low power, or corrupts clocks.
3. Confirm device `STM32F407ZG`, Flash algorithm for 1 MiB internal Flash, and address `0x08000000`.
4. If readout protection or option bytes are involved, stop and explain erase/data-loss consequences before changing them.
5. BOOT0=0 is required to run flashed user code after reset; system bootloader mode is different from SWD programming.

Never erase, program, reset, install a driver/pack, or modify option bytes merely to test whether the skill is correct.
