// Run with the repository's Electron executable, after closing TestForge.
// Uses TestForge's own schema/storage and Electron safeStorage, never plaintext library tokens.
const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { pathToFileURL } = require('node:url');

const root = __dirname;
const workspace = path.resolve(root, '../../..');
const userData = process.env.TESTFORGE_USER_DATA || path.join(process.env.APPDATA, '@testforge', 'desktop');
const modelRoot = path.resolve(root, '../../hardware-manuals/stm32-batianhu-v2');
app.setPath('userData', userData);

async function portOpen(port) {
  return await new Promise((resolve) => {
    const socket = net.connect({host:'127.0.0.1',port});
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

async function run() {
  let gatewayPort = 8000;
  try {
    const settings = JSON.parse(await fs.readFile(path.join(userData,'settings.json'),'utf8'));
    gatewayPort = settings.gateway?.port ?? settings.agentGateway?.port ?? 8000;
  } catch { /* empty installation */ }
  if (await portOpen(gatewayPort)) throw new Error('Close TestForge before registration so its in-memory credential store cannot overwrite this change.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron credential encryption unavailable');
  const config = JSON.parse((await fs.readFile(path.join(root,'server.json'),'utf8')).replace(/^\uFEFF/,''));
  const { DeviceStore } = await import(pathToFileURL(path.join(workspace,'testForge/packages/devices/dist/device-store.js')));
  const { SecretStore } = await import(pathToFileURL(path.join(workspace,'testForge/packages/storage/dist/secrets.js')));
  const store = new DeviceStore(path.join(userData,'devices'));
  await store.initialize();
  const bundle = new Uint8Array(await fs.readFile(path.join(modelRoot,'stm32-batianhu-v2.tfhw')));
  const preview = await store.inspectBundle(bundle);
  if (preview.hardwareId !== 'DUT_1' || preview.ports.length !== 14) throw new Error('Unexpected board model scope');
  const existingComputer = store.getComputer('LOCAL_PC');
  if (existingComputer && existingComputer.execution !== 'local') throw new Error('LOCAL_PC is already a different computer; resolve the identity before registration');
  const existingServer = store.getServer(config.serverId);
  if (existingServer && existingServer.hardwareId !== config.hardwareId) throw new Error('Server ID already controls another hardware');
  if (store.listServers().some(s => s.hardwareId === 'DUT_1')) throw new Error('DUT_1 must remain passive');
  const backup = path.join(userData,'backups',`firedap-${new Date().toISOString().replace(/[:.]/g,'-')}`);
  await fs.mkdir(backup,{recursive:true});
  for (const relative of ['secrets.json','devices/computers/LOCAL_PC.json','devices/servers/FIREDAP_MCP.json',
                          'devices/hardware/DUT_1','devices/hardware/LOCAL_MCP.FIREDAP_0']) {
    const source=path.join(userData,relative);
    try { await fs.stat(source); } catch { continue; }
    await fs.cp(source,path.join(backup,relative),{recursive:true});
  }
  const secrets = new SecretStore(path.join(userData,'secrets.json'), {
    encrypt:value=>safeStorage.encryptString(value), decrypt:value=>safeStorage.decryptString(value)
  });
  await secrets.initialize();
  await store.saveComputer({id:'LOCAL_PC',label:'本机 · FireDAP',address:'127.0.0.1',execution:'local',
                            ssh:{port:22,username:'local',shell:'powershell'}});
  const command = name => `& '${path.join(root,name).replace(/'/g,"''")}'`;
  const server = {transport:'mcp-http',serverId:config.serverId,computerId:'LOCAL_PC',
    label:'FireDAP STM32 烧录服务（本机）',hardwareId:config.hardwareId,
    url:`http://127.0.0.1:${config.port}/mcp`,enabled:true,
    lifecycle:{statusCommand:command('status.ps1'),startCommand:command('start.ps1'),stopCommand:command('stop.ps1'),logPath:path.join(root,'logs')}};
  await secrets.set(`mcp:${config.serverId}`,{token:config.token});
  await store.saveServer(server);
  const firedap = JSON.parse(await fs.readFile(path.join(modelRoot,'firedap.hardware.json'),'utf8'));
  await store.saveHardware(firedap);
  await store.putImageBytes(firedap.hardwareId,undefined,new Uint8Array(await fs.readFile(path.join(modelRoot,'images/firedap-appearance.png'))),'appearance.png');
  await store.importBundle(bundle);
  // Store the richer board configuration alongside the catalog. The v2 catalog schema itself
  // carries ports/pins/images only; the reference MCP tool exposes this document to agents.
  await fs.copyFile(path.join(modelRoot,'model.json'),path.join(userData,'devices/hardware/DUT_1/model.json'));
  await secrets.flush();
  console.log(JSON.stringify({ok:true,hardwareIds:[preview.hardwareId,firedap.hardwareId],serverId:server.serverId,
                             boardPorts:preview.ports.length,backup},null,2));
}

app.whenReady().then(run).then(()=>app.exit(0)).catch(error=>{console.error(error.message);app.exit(1);});
