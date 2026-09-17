# Peripheral integration reference

Use the exact MCU reference manual/DMA mapping already captured here and in the bundled headers. For every feature, record pins/AF, clocks, DMA, IRQ, jumpers, electrical mode, and shared-resource conflicts before code generation.

## GPIO and EXTI

- Enable the GPIO port clock before configuring a pin. Establish an inactive output level before exposing an output to a peripheral or transceiver.
- RGB LED PF6/PF7/PF8 is active low. KEY1 PA0 maps to EXTI0; KEY2 PC13 maps to EXTI15_10.
- Clear/handle bounce outside the interrupt handler. The ISR should call `HAL_GPIO_EXTI_IRQHandler(pin)`; application work belongs in the callback/task.
- Only one port can own a given EXTI line number at a time.

## UART, USART DMA, RS485, and RS232

- The bundled UART DMA example uses USART1 PA9 TX/PA10 RX, AF7, DMA2 Stream7 Channel4 for TX, and USART1_IRQn.
- For receive-to-idle, re-arm DMA promptly and make cache/ownership rules explicit. F407 has no D-cache, but buffers still require `volatile`/synchronization where ISR and tasks share state.
- RS485 uses USART2 PA2/PA3 and PC0 direction. Assert transmit direction before starting TX and return to receive only after transmission-complete, not merely DMA-complete.
- J40 routes PA2/PA3 and transceiver power. Ethernet RMII uses PA2 for MDIO, so Ethernet and this USART2 TX route cannot coexist.

## ADC and timers/PWM

- Board potentiometer is PB0, ADC1 channel 8. Bundled continuous ADC DMA uses DMA2 Stream0 Channel0.
- Choose ADC prescaler and sample time for source impedance; calibration assumptions from other STM32 families do not apply blindly to F407.
- Timer clocks are doubled when the relevant APB prescaler is not 1: APB1 timers normally run at 84 MHz and APB2 timers at 168 MHz under the default tree.
- Reserve TIM6 if using the bundled basic-timer example (`TIM6_DAC_IRQn`) or a HAL time base. Do not silently take SysTick from FreeRTOS.
- For PWM, derive PSC/ARR from the actual timer input clock and state frequency, duty resolution, polarity, and preload behavior.

## I2C1 devices

I2C1 uses PB8 SCL/PB9 SDA, AF4, open-drain. It is shared by AT24C02, MPU6050, AP3216C, WM8978 control and camera-control routes.

| Device | Address convention | Notes |
|---|---|---|
| AT24C02 | 7-bit `0x50`; HAL shifted `0xA0` | Page writes need boundary handling and acknowledge polling |
| MPU6050 | 7-bit `0x68`; HAL shifted `0xD0` | Verify AD0 state; sample-rate/DLPF configuration affects timing |
| WM8978 | 7-bit `0x1A`; HAL shifted `0x34` | Register protocol is write-oriented; pair with I2S2 audio |
| AP3216C | Verify address constant in integrated driver | Interrupt input is PE3 in bundled BSP |

Use one shared `I2C_HandleTypeDef` and a mutex under an RTOS. Recover a stuck bus only after confirming that toggling SCL will not disturb another active client.

## SPI1 NOR Flash

- PB3 SCK, PB4 MISO, PB5 MOSI use AF5; PG6 is software-controlled CS.
- Full JTAG/SWO can seize PB3/PB4. Prefer SWD-only; do not diagnose this as an SPI timing error until debug-port ownership is checked.
- Read JEDEC ID before choosing density-dependent erase/address limits. Wait on WIP with a bounded timeout and preserve 4 KiB erase-sector semantics.
- If adding DMA, choose legal SPI1 DMA2 mappings and check them against ADC, SDIO and UART allocations.

## FSMC SRAM and LCD

- Enable GPIOD/E/F/G and FSMC clocks, set AF12, very-high speed, push-pull, no pull unless board signal integrity requires otherwise.
- LCD: Bank1 NOR/SRAM3, command `0x68000000`, data `0x68000002`, NE3 PG10, A0 PF0, NOE PD4, NWE PD5, backlight PF9, reset PF11.
- SRAM: Bank1 NOR/SRAM4 at `0x6C000000`, NE4 PG12, 16-bit bus with byte lanes PE0/PE1.
- The bundled directory named `fsmc-sram` contains a vendor file with historical SDRAM naming. Treat active definitions around `Bank1_SRAM4_ADDR` as asynchronous SRAM; do not enable the commented FMC SDRAM section on F407.
- Verify FSMC address/data setup and hold times against actual display/memory. Avoid compiler-reordered memory-mapped I/O; use `volatile` accessors.

## SDIO and FatFs

- SDIO pins: PC8..PC11 D0..D3, PC12 CK, PD2 CMD, AF12.
- Bundled DMA mapping: RX DMA2 Stream3 Channel4; TX DMA2 Stream6 Channel4; IRQs for both streams plus SDIO_IRQn.
- Keep DMA buffers in SRAM1/SRAM2, aligned as required; never CCM. Check card-detect semantics if a detect switch is used.
- Initialize low-speed/1-bit as required, then negotiate width and clock. Propagate media removal/write-protect errors to FatFs.
- FatFs must have exactly one disk I/O adapter for the selected medium. Keep vendor license/version headers and avoid mixing incompatible `ff.h`, `ffconf.h`, and `diskio.h` revisions.

## I2S2 / WM8978

- Pins: PB12 LRCLK/WS, PB13 BCLK/CK, PB14 I2S2ext RX, PB15 SD TX, PC6 MCLK.
- Bundled DMA: I2S2 TX DMA1 Stream4 Channel0; I2S2ext RX DMA1 Stream3 Channel3.
- PB12/PB13 conflict with CAN2. Reject simultaneous board-level CAN2 and WM8978 audio unless hardware is rerouted.
- Derive PLLI2S and prescaler for the sample family. State achieved sample-rate error; do not assume the 168 MHz system PLL alone produces exact audio clocks.
- Use double buffers or half/full callbacks; keep audio DMA buffers out of CCM.

## CAN2

- PB12 RX/PB13 TX, AF9, `CAN2_RX0_IRQn`. CAN2 depends on the CAN1 peripheral clock even when CAN1 pins are unused.
- Configure bit timing from APB1=42 MHz and state bitrate/sample point. Allocate filter banks with the CAN1/CAN2 split correctly.
- Check transceiver power/routing and 120-ohm termination before blaming firmware. CAN2 conflicts with I2S2 WS/CK.

## RTC

- Prefer the 32.768 kHz LSE for calendar accuracy. Backup-domain writes require PWR clock and backup access.
- Preserve RTC/backup registers across normal reset unless the user explicitly wants reinitialization. Use magic/version markers rather than resetting the domain at every boot.

## USB OTG FS

- PA11 DM/PA12 DP, AF10. PLLQ must produce 48 MHz.
- Host and device sockets share one OTG FS data pair; select only one role and verify VBUS drive/sense hardware and jumper state.
- Host mode needs controlled 5 V VBUS sourcing and over-current handling. Do not source VBUS merely by enabling PA9 or a generic GPIO without board confirmation.
- Enable OTG_FS_IRQn and keep USB middleware, HAL PCD/HCD, and clock configuration versions compatible.

## MPU6050

- Use I2C1 and 7-bit address `0x68` unless AD0 changes it. Validate `WHO_AM_I` before configuration.
- Configure clock source, full-scale range, DLPF and sample divider explicitly. Treat DMP firmware/interrupt examples as optional integration, not a board requirement.
- Under FreeRTOS, timestamp samples and avoid blocking indefinitely on I2C inside a high-priority task.
