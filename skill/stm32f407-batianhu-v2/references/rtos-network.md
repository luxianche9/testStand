# FreeRTOS and LwIP integration

The pinned integration material is under `assets/middleware/tutorial_code/LwIP_iperf`: FreeRTOS kernel, LwIP, and Batianhu board adaptation files only. Treat it as a version-fixed reference and preserve upstream license headers. Do not mix individual headers/sources with a different FreeRTOS or LwIP release.

## Ethernet RMII

| Signal | Pin |
|---|---|
| REF_CLK | PA1 |
| MDIO | PA2 |
| CRS_DV | PA7 |
| MDC | PC1 |
| RXD0/RXD1 | PC4/PC5 |
| TX_EN | PG11 |
| TXD0/TXD1 | PG13/PG14 |

Use AF11 for ETH signals. PA2 collides with USART2 TX and the RS485/RS232 route. The correct TX_EN pin is PG11 despite a stale PB11 comment in one historical source.

Before enabling ETH, verify PHY address/reset, RMII 50 MHz reference-clock source/direction, strap pins, link LEDs and connector route. Configure `ETH_IRQn` and ensure descriptors and packet buffers live in DMA-accessible SRAM, not CCM.

## FreeRTOS rules

- Make `configCPU_CLOCK_HZ` match 168 MHz and keep interrupt-priority bit definitions consistent with STM32F407.
- Choose `configLIBRARY_LOWEST_INTERRUPT_PRIORITY` and `configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY`; any ISR calling `...FromISR` must have a numerically equal-or-lower urgency allowed by the latter.
- Use one time base deliberately. If SysTick drives FreeRTOS, do not also rely on a conflicting HAL tick setup without a defined integration.
- Size task stacks from measured high-water marks. Network/TCPIP and application parsing tasks need more than trivial LED tasks.
- Protect shared I2C/SPI/UART and LwIP raw-API access. Do not call raw LwIP APIs from arbitrary tasks; marshal work to the TCPIP thread or use netconn/socket APIs.
- Prefer static allocation only when all control blocks/stacks are explicitly owned; otherwise instrument heap and malloc-failed hook.

## LwIP configuration

- Keep `lwipopts.h`, `sys_arch.c`, `ethernetif.c`, ETH driver and core version together.
- Set checksum/offload options to match the STM32 ETH driver. Incorrect mixed software/hardware checksum configuration causes packets that look valid locally but are dropped remotely.
- Size `PBUF_POOL`, memory pools, TCP windows and mailbox depths against the 128 KiB DMA-capable SRAM budget. CCM may hold task stacks or CPU-only data but not ETH descriptors/buffers.
- Use zero-copy only with explicit ownership transitions and alignment. Do not reuse a TX buffer until DMA completion.
- On RX, invalidate/ownership rules must match the platform. STM32F407 has no data cache, so do not paste F7/H7 cache maintenance code as a substitute for correct descriptor ownership.
- Link changes should stop/restart the netif state cleanly. DHCP needs timeout/fallback behavior; static IP settings must include mask and gateway.

## Bring-up sequence

1. Validate 25 MHz HSE/168 MHz clock and the RMII reference clock.
2. Bring up PHY and read ID/status before starting the scheduler-heavy application.
3. Initialize descriptor rings in DMA SRAM with required alignment.
4. Create TCPIP/LwIP context and netif, then start DHCP or assign static addressing.
5. Confirm ARP and ICMP before TCP/iperf.
6. Add application tasks only after link, packet counters, and error counters are observable.

## Common combined-feature conflicts

- Ethernet consumes PA2, so board-routed USART2/RS485 cannot run simultaneously.
- ETH DMA and SDIO/other DMA do not share the same DMA controller implementation, but interrupt load and SRAM bandwidth still require priority/buffer analysis.
- LwIP plus FatFs/audio can exhaust internal SRAM. Produce a map-file budget for heaps, stacks, packet pools, audio buffers, and filesystem buffers.
