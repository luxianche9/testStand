// One explicit attach-only target check; no programming, halt or reset.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');
const sdk = path.join(root, 'HardwareHarness/apps/desktop/node_modules/@modelcontextprotocol/sdk/dist/esm/client');
const report = { checkedAt: new Date().toISOString(), ok: false };
async function main() {
  const config = JSON.parse(await fs.readFile(path.join(root, 'mcp_servers/servers/firedap/server.json'), 'utf8'));
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import(pathToFileURL(path.join(sdk, 'index.js')).href),
    import(pathToFileURL(path.join(sdk, 'streamableHttp.js')).href)
  ]);
  const client = new Client({ name: 'firedap-recovery-check', version: '1.0.0' });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const value = response.structuredContent;
    if (response.isError || !value?.ok) throw new Error(value?.error?.message || 'MCP call failed');
    return value.data;
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } }
    }));
    report.before = await call('list_hardware');
    const job = await call('firedap_target_info', { hardwareId: config.hardwareId });
    report.job = await call('firedap_wait_job', { hardwareId: config.hardwareId, job_id: job.jobId, timeout_seconds: 60 });
    report.after = await call('list_hardware');
    report.ok = report.job.state === 'succeeded' && report.after[0].state === 'open';
  } finally { await client.close(); }
}
main().catch(error => { report.error = String(error); process.exitCode = 1; }).finally(async () => {
  await fs.writeFile(path.join(__dirname, 'firedap-recovery.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
});
