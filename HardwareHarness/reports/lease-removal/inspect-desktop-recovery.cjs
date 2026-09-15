const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');
app.setPath('userData', process.env.HARDWAREHARNESS_USER_DATA_DIR || path.join(process.env.APPDATA, 'HardwareHarness'));
app.whenReady().then(async () => {
  const userData = process.env.HARDWAREHARNESS_USER_DATA_DIR || path.join(process.env.APPDATA, 'HardwareHarness');
  const secrets = JSON.parse(await fs.readFile(path.join(userData, 'secrets.json'), 'utf8'));
  const token = JSON.parse(safeStorage.decryptString(Buffer.from(secrets.entries.gateway, 'base64'))).token;
  const sdk = path.join(root, 'HardwareHarness/apps/desktop/node_modules/@modelcontextprotocol/sdk/dist/esm/client');
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import(pathToFileURL(path.join(sdk, 'index.js')).href),
    import(pathToFileURL(path.join(sdk, 'streamableHttp.js')).href)
  ]);
  const client = new Client({ name: 'desktop-recovery-inspection', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8000/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    }));
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError || !result.structuredContent?.ok) throw new Error(`${name} failed`);
      return result.structuredContent.data;
    };
    const project = await call('get_project');
    const hardware = await call('list_managed_hardware');
    const runs = project ? await call('list_python_runs', { status: 'running' }) : [];
    const report = { checkedAt: new Date().toISOString(), project, hardware, runs };
    await fs.writeFile(path.join(__dirname, 'desktop-before-status-update.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ project: project ? { rootPath: project.rootPath, dirty: project.dirty } : null, hardware, runs }));
  } finally { await client.close(); }
}).then(() => app.exit(0), error => { console.error(String(error)); app.exit(1); });
