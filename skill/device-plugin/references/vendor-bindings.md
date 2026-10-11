# 厂商驱动绑定

`driver.py` 只做一件事：把厂商调用包成有类型的 Python 方法。它返回原始返回码和数据，不判断成败、不重试、不维护业务状态；这些都在 `adapter.py` 里做。`sim.py` 实现同一个接口，适配器通过 `select_driver(real, simulated)` 二选一。

有两种模式：

| 模式 | 何时用 | 参考 |
|---|---|---|
| ctypes 直接调 DLL | 厂商提供 C 头文件和 DLL，函数签名简单（整数、指针、缓冲） | `pci6208v`、`cp118u_i` |
| hwcli JSON 行子进程 | 厂商只有 C++/COM/.NET SDK，或调用需要回调、结构体嵌套、独立进程隔离 | `pci1710l`、`pci1762` |

## 模式一：ctypes

### 调用约定

| 头文件写法 | 加载方式 |
|---|---|
| `WINAPI`、`__stdcall`、`PASCAL`、`CALLBACK` | `ctypes.WinDLL(path)` |
| 没有修饰或 `__cdecl` | `ctypes.CDLL(path)` |

64 位 Windows 只有一种调用约定，两者都能用；32 位进程选错会在返回时破坏栈，表现为随机崩溃。按头文件选，不要试出来。

**位数必须一致**：64 位 Python 只能加载 64 位 DLL。`OSError: [WinError 193]` 就是位数不匹配。厂商只提供 32 位 DLL 时，改用模式二，用 32 位 hwcli 做桥。

### 结构

```python
DLL_CANDIDATES = ("PCOMM.DLL", r"C:\Program Files\Moxa\...\PCOMM.DLL")   # 仅手册写明的位置

class VendorBackend(Protocol):                     # driver 和 sim 共用的接口
    def open(self, card: int) -> int: ...
    def read(self, port: int, max_len: int) -> tuple[int, bytes]: ...

class Vendor:
    def __init__(self, dll_path: str | None = None) -> None:
        self._dll_path = dll_path
        self._dll: Any = None

    @property
    def dll(self) -> Any:                          # 懒加载：构造对象不碰硬件，import 不失败
        if self._dll is None:
            path = self.resolve()
            try:
                self._dll = ctypes.WinDLL(str(path))   # type: ignore[attr-defined]
            except OSError as exc:
                raise DeviceError(f"cannot load {path}: {exc}", category=DEVICE_UNREACHABLE) from exc
            self._declare(self._dll)
        return self._dll

    def resolve(self) -> Path:                     # settings → 环境变量 → 候选位置
        for candidate in (self._dll_path, os.environ.get("VENDOR_DLL"), *DLL_CANDIDATES):
            ...
        raise DeviceError("VENDOR.DLL not found; set settings.dllPath", category=DEVICE_UNREACHABLE)
```

- 找不到 DLL、加载失败都是 `DEVICE_UNREACHABLE`：SDK 会按 5/10/30 s 重开，插件照样加载，`list_hardware` 和设备页报告 `unreachable`。
- 路径来源只有三处：`settings.dllPath`、一个厂商相关的环境变量、手册写明的安装位置。不要扫描磁盘。

### 声明签名

每个用到的函数都声明 `argtypes` 和 `restype`，集中在一个表里：

```python
SIGNATURES = {
    "sio_open":  ([ctypes.c_int], ctypes.c_int),
    "sio_write": ([ctypes.c_int, ctypes.c_char_p, ctypes.c_int], ctypes.c_int),
    "sio_read":  ([ctypes.c_int, ctypes.c_char_p, ctypes.c_int], ctypes.c_int),
    "AO_VWriteChannel": ([ctypes.c_ushort, ctypes.c_ushort, ctypes.c_double], ctypes.c_short),
}

def _declare(self, dll: Any) -> None:
    for name, (args, result) in SIGNATURES.items():
        fn = getattr(dll, name)
        fn.argtypes, fn.restype = args, result
```

不声明时 ctypes 默认按 `int` 传参和返回，`double`、64 位句柄和指针都会被截断，而且不报错。头文件类型对照：`U16`/`WORD` → `c_ushort`，`I16` → `c_short`，`U32`/`DWORD` → `c_uint32`，`HANDLE`/指针 → `c_void_p`，`F64` → `c_double`，`char*` → `c_char_p`。

### 输出参数与缓冲

```python
def ai_read(self, card: int, channel: int) -> tuple[int, float]:
    value = ctypes.c_double()
    rc = int(self.dll.AI_VReadChannel(card, channel, ctypes.byref(value)))
    return rc, value.value

def sio_read(self, port: int, max_len: int) -> tuple[int, bytes]:
    buffer = ctypes.create_string_buffer(max_len)
    count = int(self.dll.sio_read(port, buffer, max_len))
    return (count, b"") if count < 0 else (count, buffer.raw[:count])
```

- 标量输出用 `ctypes.byref(c_xxx())`；数组用 `(c_uint16 * n)()`；字节用 `create_string_buffer`，按实际长度切片。
- 返回 `(rc, data)`，由适配器检查 `rc` 再决定用不用 `data`。
- 方法统一返回 `int(rc)`；错误码到文字的映射放在适配器或 `driver.py` 的常量表里，写进 `DeviceError.details["rc"]`。

### 线程

同一个句柄上的厂商调用一般不是线程安全的。工具调用已被 SDK 串行；后台线程（串口读线程）调用驱动时必须持有 `self.io_lock`。不要在驱动里自己加锁。

## 模式二：hwcli JSON 行子进程

用 C/C++ 写一个小的命令行程序 `hwcli_<model>.exe`，链接厂商 SDK，从 stdin 每行读一个 JSON 请求，向 stdout 每行写一个 JSON 响应：

```
→ {"cmd": "read_voltage", "channel": 3}
← {"ok": true, "reachable": true, "message": "", "data": {"channel": 3, "volts": 1.234}}
← {"ok": false, "reachable": false, "message": "DeviceOpen failed: 0xE0000000", "data": {}}
```

- `reachable=false` 表示板卡打不开，映射为 `DEVICE_UNREACHABLE`；`ok=false, reachable=true` 映射为 `DEVICE_ERROR`。
- 一行一个完整 JSON，用 `\n` 结尾，每个请求之后刷新 stdout。日志只写 stderr。
- 进程常驻，第一次调用时启动；`close()` 里停止。

Python 端用 SDK 的 `JsonLineCli`：

```python
from teststand_device_sdk import JsonLineBackend, JsonLineCli, find_executable, unwrap

EXECUTABLE = "hwcli_pci1710l.exe"

def hwcli(settings: Mapping[str, Any]) -> JsonLineCli:
    path = find_executable(EXECUTABLE, explicit=settings.get("hwcliPath"),
                           env_names=("PCI1710L_HWCLI_PATH", "HWCLI_PATH"))
    return JsonLineCli(path, name=EXECUTABLE, missing_hint="Build native/ or set settings.hwcliPath.")

# adapter.py
self.cli: JsonLineBackend = self.select_driver(lambda: hwcli(settings), SimulatedHwcli)
data = unwrap(self.cli.call({"cmd": "read_voltage", "channel": channel}))
```

`find_executable` 依次查找 `settings.hwcliPath`、环境变量、`<root>/native/build/{Release,Debug,.}`（`roots=` 给出的目录），找不到返回 `None`；`JsonLineCli` 在第一次调用时对 `None` 抛 `DEVICE_UNREACHABLE`，附带 `missing_hint`，所以插件照样能加载。响应不是合法 JSON 或进程退出，分别得到 `INVALID_RESPONSE` 和 `DEVICE_UNREACHABLE`。

模拟器 `SimulatedHwcli` 实现同一个 `JsonLineBackend` 协议（`call()`、`stop()`），返回与原生程序字段完全一致的负载（`sim.py` 顶部注明"与 native/hwcli_<model>.cpp 逐字段一致"）。原生源码放在适配器的 `native/` 下并提交到仓库；编译好的 exe 不进仓库，台架电脑上用 `settings.hwcliPath` 指向它。

## 厂商 stdout 与隔离

插件默认在后端进程里运行，后端 stdout 的第一行是给桌面应用的启动握手，之后也只作日志。一些厂商 DLL 加载或调用时会直接往 stdout 打印（例：ADLINK PCIS-DASK），会破坏握手，而且 ctypes 下没有可靠的办法只屏蔽 DLL 的输出。这种驱动：

- 在设备类上设 `isolation = "subprocess"`。SDK 在子进程里运行设备，导入适配器之前把文件描述符 1 指向 stderr，原 stdout 只留给父子之间的 JSON 行协议；驱动打印的内容进 stderr 日志。
- 不要在适配器里自己重定向文件描述符 1、替换 `sys.stdout` 或用 `contextlib.redirect_stdout` 包驱动调用：这在 `inproc` 下会影响整个后端，在 `subprocess` 下 SDK 已经处理。
- 可能崩溃（访问违例）或泄漏句柄的驱动同样选 `subprocess`：子进程崩溃时调用失败为 `device_unreachable`（结果未知），后端不受影响。

hwcli 模式的 exe 本身就是独立进程，适配器保持 `inproc`；但 hwcli 自己的 stdout 就是协议通道，原生程序里要把厂商输出关掉或改到 stderr。

## 常见错误

| 现象 | 原因 |
|---|---|
| `OSError: [WinError 193]` | DLL 位数和 Python 不一致 |
| `OSError: [WinError 126]` | DLL 或它依赖的 DLL 找不到；把厂商目录加到 `os.add_dll_directory` 或用绝对路径 |
| 读回的 `double` 是巨大整数或 0 | 没声明 `restype`/`argtypes` |
| 随机崩溃、返回后栈异常 | 32 位下 `WinDLL`/`CDLL` 选错 |
| 串口数据偶发错乱 | 后台线程调用驱动时没持有 `io_lock` |
| hwcli 调用卡住 | 原生程序没有刷新 stdout，或把日志写到了 stdout |
