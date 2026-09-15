// Launch the actual desktop after deployment and verify read-only hardware access.
// Credentials stay in memory; the report contains no tokens or passwords.
const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../../..');
const desktop = path.join(root, 'HardwareHarness/apps/desktop');
const userData = process.env.HARDWAREHARNESS_USER_DATA_DIR || path.join(process.env.APPDATA, 'HardwareHarness');
const reportPath = path.join(__dirname, 'live-verification.json');
app.setAppPath(desktop);
app.setPath('userData', userData);
const report = { ok: false, checkedAt: new Date().toISOString(), servers: [] };
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');

async function clientFor(url, token) {
  const sdk = path.join(desktop, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client');
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import(pathToFileURL(path.join(sdk, 'index.js')).href),
    import(pathToFileURL(path.join(sdk, 'streamableHttp.js')).href)
  ]);
  const client = new Client({ name: 'hardwareharness-deployment-verification', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return client;
}

function unwrap(result) {
  const value = result.structuredContent;
  if (result.isError || !value || value.ok === false) {
    throw new Error(value?.error?.message || 'Hardware tool returned an unsuccessful response');
  }
  return value.data ?? value;
}

async function verify(window) {
  const document = JSON.parse(await fs.readFile(path.join(userData, 'secrets.json'), 'utf8'));
  function secret(key) {
    const encrypted = document.entries[key];
    if (!encrypted) throw new Error(`Credential entry missing: ${key}`);
    return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
  }
  const config = JSON.parse(await fs.readFile(path.join(root, 'mcp_servers/servers.json'), 'utf8'));
  const reads = {
    pci1710l: ['pci1710l_read_bit', { channel: 0, kind: 'DI' }],
    pci1762: ['pci1762_read_bit', { channel: 0, kind: 'DI' }],
    pci6208v: ['pci6208v_read_last', { channel: 0 }],
    cp118u_i: ['cp118u_get_line_status', { channel: 1 }]
  };
  for (const server of config.servers) {
    const client = await clientFor(server.mcpUrl, secret(server.mcpCredentialKey).token);
    try {
      const { tools } = await client.listTools();
      if (tools.some(tool => /occupancy/i.test(tool.name))) throw new Error(`${server.id}: old occupancy tool remains`);
      const hardware = unwrap(await client.callTool({ name: 'list_hardware', arguments: {} }));
      if (hardware.length !== 1 || hardware[0].state !== 'open') throw new Error(`${server.id}: hardware is not open`);
      const [name, args] = reads[server.id];
      const output = unwrap(await client.callTool({ name, arguments: { hardwareId: server.hardwareId, ...args } }));
      report.servers.push({ id: server.id, hardwareId: server.hardwareId, state: hardware[0].state,
        toolCount: tools.length, occupancyToolAbsent: true, directRead: { name, output } });
      await save();
    } finally { await client.close(); }
  }
  const firedap = JSON.parse(await fs.readFile(path.join(root, 'mcp_servers/servers/firedap/server.json'), 'utf8'));
  const probeClient = await clientFor(`http://127.0.0.1:${firedap.port}/mcp`, firedap.token);
  try {
    const { tools } = await probeClient.listTools();
    if (tools.some(tool => /occupancy/i.test(tool.name))) throw new Error('FireDAP: old occupancy tool remains');
    const probes = unwrap(await probeClient.callTool({ name: 'firedap_list_probes', arguments: {} }));
    if (!probes.probes?.some(probe => probe.serialNumber === firedap.probeSerial)) throw new Error('FireDAP USB probe is not connected');
    const hardware = unwrap(await probeClient.callTool({ name: 'list_hardware', arguments: {} }));
    // Preserve the completed target diagnostic. Do not repeat the hardware operation.
    const diagnostic = JSON.parse((await fs.readFile(path.join(__dirname, 'firedap-diagnostic.json'), 'utf8')).replace(/^\uFEFF/, ''));
    report.servers.push({ id: 'firedap', hardwareId: firedap.hardwareId, state: hardware[0].state,
      toolCount: tools.length, occupancyToolAbsent: true, usbProbePresent: true, targetDiagnostic: diagnostic });
    report.physicalChecksPassed = diagnostic.state === 'succeeded';
  } finally { await probeClient.close(); }
  report.desktop = await window.webContents.executeJavaScript(`(async () => {
    const api = window.hardwareharness;
    const initial = await api.system.dashboard();
    const statuses = [];
    for (const server of initial.servers.filter(server => server.enabled)) {
      const status = await api.devices.refreshServer(server.serverId);
      statuses.push({ serverId: server.serverId, transport: status.transport.state });
    }
    const dashboard = await api.system.dashboard();
    return { statuses, occupancyApiAbsent: !('occupancy' in api), occupancySnapshotAbsent: !('occupancy' in dashboard),
      gateway: { running: dashboard.gateway.running, endpoint: dashboard.gateway.endpoint } };
  })()`);
  if (!report.desktop.occupancyApiAbsent || !report.desktop.occupancySnapshotAbsent ||
      report.desktop.statuses.length !== 5 || report.desktop.statuses.some(item => item.transport !== 'online')) {
    throw new Error('Desktop hardware/API verification failed');
  }
  const gateway = await clientFor(report.desktop.gateway.endpoint, secret('gateway').token);
  try {
    const { tools } = await gateway.listTools();
    if (tools.some(tool => /occupancy/i.test(tool.name))) throw new Error('Gateway still exposes occupancy tools');
    const output = unwrap(await gateway.callTool({ name: 'PCI6208V_MCP__pci6208v_read_last', arguments: { channel: 0 } }));
    report.gateway = { occupancyToolsAbsent: true, toolCount: tools.length,
      directRead: { name: 'PCI6208V_MCP__pci6208v_read_last', output } };
  } finally { await gateway.close(); }
  report.ok = true;
  report.completedAt = new Date().toISOString();
  await save();
  console.log('All 5 services and desktop deployed; see targetDiagnostic for the STM32 communication result.');
  window.show();
}

let checked = false;
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    if (checked) return;
    checked = true;
    try { await verify(window); }
    catch (error) { report.error = String(error); await save(); console.error(report.error); window.show(); }
  });
});
import(pathToFileURL(path.join(desktop, 'out/main/index.js'))).catch(async error => {
  report.error = String(error); await save(); app.exit(1);
});
