# 通用通信链路设备插件

包 `teststand_adapter_comm_link`，设备类型 `comm_link`（入口点组 `teststand.devices`），由 testStand 后端作为插件加载。`isolation = "inproc"`：只用 Python 标准库的 socket 和 SDK 的 Windows 串口封装（`SerialPort`，kernel32），不加载厂商 DLL。不需要预装任何驱动；USB 转串口线要装它自己的驱动（CH340、CP210x、FTDI 等），装好后在设备管理器里是一个 COM 口即可。

一个插件实例就是一条链路，连到一个被测件。四种方式：

| `link` | 用途 |
|---|---|
| `serial` | 电脑自带的 COM 口、USB 转串口、串口卡的虚拟 COM 口 |
| `tcp_client` | 被测件在监听（网络模块、控制器、DUT 上的服务），本机去连 |
| `tcp_server` | 本机监听，被测件来连（一次一个客户端，新的顶替旧的） |
| `udp` | 本机绑定一个端口收任何来源的报文；发往指定地址，没指定就回给最后一个发送方 |

公共工具（`get_device_info`、`list_hardware`、`get_hardware_info`、`link_stream_read`、`link_transact`）、信封格式、`/device` 声明和流读取由 SDK 提供，见 `devices/README.md`。插件只报告收发的字节和链路状态，不判定通过 / 失败。

## `settings`

写了 `link` 就在设备打开时建立链路；建不起来（COM 口不存在或被占用、对方没在监听）设备显示离线并给出原因，SDK 自动重试。不写就不连，用下面的工具连。

```json
{"link": "serial", "port": "COM3", "baudrate": 115200, "bytesize": 8, "parity": "N", "stopbits": 1}
{"link": "tcp_client", "host": "192.168.1.10", "port": 502}
{"link": "tcp_server", "port": 9000, "bind": "0.0.0.0"}
{"link": "udp", "localPort": 9000, "host": "192.168.1.10", "port": 9001}
```

| 键 | 默认 | 说明 |
|---|---|---|
| `rxBufferBytes` | `1048576` | 流保留的字节数，超出丢最旧的 |

## 工具

- 建立链路（`configure`，替换当前链路，不发送）：`open_serial(port, baudrate, bytesize, parity, stopbits)`、`connect_tcp(host, port)`、`listen_tcp(port, bind)`、`open_udp(local_port, host, port)`；`disconnect` 关闭。
- `write_text` / `write_hex`（`actuate`）：发送，返回链路接受的字节数，不代表对方收到；不加换行，需要时把 `\r\n` 写进文本。`clear_rx=true` 先丢弃已收数据。`link_transact`（SDK 提供）：发送并等待匹配的回复。没有链路、TCP 服务端还没有客户端、UDP 没有目的地时报 `not_configured`。
- `read_rx`：上次清除以来收到的字节（不消耗），证据类型 measurement；`clear_rx` 清除。
- `link_status`：当前链路类型、端口参数或地址、TCP 服务端的客户端、UDP 最后的发送方。`connected` 只说明端口或套接字开着，不说明对方在应答。
- `list_serial_ports`：Windows 现有的 COM 口。
- `safe_state`：丢弃串口待发数据；套接字没有可丢弃的。链路保持，不发送任何字节。
- `self_test`（只读，不发送）：链路已配置、已建立。

## 流

- `link`（bytes，可写）：收到的数据（`rx`，读线程每 10 ms 轮询，每次读空后 `idle()`）、发送的数据（`tx`）、标记（`connect …`、`disconnect`、`clear_rx`、TCP 服务端的 `client … connected / disconnected`、TCP 客户端的 `disconnected: …` / `reconnected …`）。TCP 客户端断线后每 2 秒自动重连。
- 在 testStand「变量」面板里给这条流「解析协议」，按 ICD 切帧后每个字段就是一个变量。

## 现场验收（由用户执行）

1. 串口：两根 USB 转串口线 TX/RX 交叉、GND 相连，添加两个实例分别 `open_serial`，一边 `write_hex("55 aa 00 ff")`，另一边 `read_rx` 应收到同样 4 字节；再在被测件实际用的波特率下重复。
2. TCP：用网络调试助手开一个 TCP 服务端，`connect_tcp` 连上，双向各发一次；关掉调试助手，流上应出现 `disconnected`，重新打开后 2 秒内出现 `reconnected`。
3. UDP：调试助手向 `local_port` 发一包，`read_rx` 收到；`write_text` 不给地址时应回到调试助手。

## 构建与测试

```powershell
.\devices\test.ps1 -Target comm_link        # pytest（含本机 TCP/UDP 回环）+ 合规检查
python devices\pack.py comm_link             # devices\dist\comm_link-1.0.0.tsdev
```
