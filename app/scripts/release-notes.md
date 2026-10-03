# testStand {{version}}

## 文件

- `{{installer}}`：testStand 安装程序（64 位 Windows，按用户安装，未签名）
{{packages}}
- `SHA256SUMS.txt`：以上文件的 SHA-256

## 安装

1. 先在台架电脑上装好用到的厂商驱动：
   - PCI-1710L、PCI-1762：Advantech DAQNavi
   - PCI-6208V：ADLINK PCIS-DASK
   - CP-118U-I：Moxa PComm Lite（以及 MXSER 串口驱动）
2. 运行安装程序。安装程序未签名，Windows SmartScreen 提示时选“更多信息 → 仍要运行”。
3. 打开 testStand，进入“设备管理 → 设备类型 → 安装设备包…”，逐个选择 `devices/` 下的 `.tsdev`。
   安装前会显示设备包清单（型号、版本、运行方式、所需厂商驱动、文件与 SHA-256），确认后安装。
4. 在“添加测试资源”中选择设备类型，先用模拟模式确认，再切换到真机模式。

## 新增设备

新设备不需要重新安装 testStand：按 `skill/device-plugin` 写适配器，用
`python devices/pack.py <adapter>` 生成 `.tsdev`，在“设备类型”里安装即可。
已安装类型的升级和卸载在重启 testStand 后生效。

## 变更

{{changes}}
