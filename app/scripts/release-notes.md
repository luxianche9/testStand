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
3. 打开 testStand，在“测试台架”点“+ → 添加设备…”，选择这台设备的 `.tsdev`。
   弹窗显示设备、所需厂商驱动和 SHA-256；填名称，点“添加”，设备连接真实硬件后就能直接调用。

## 新增设备

新设备不需要重新安装 testStand：按 `skill/device-plugin` 写适配器，用
`python devices/pack.py <adapter>` 生成 `.tsdev`，用“添加设备…”添加即可。
驱动升级在重启 testStand 后生效。

## 变更

{{changes}}
