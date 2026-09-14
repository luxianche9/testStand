// Run with the repository's Electron executable, after closing HardwareHarness.
// Uses HardwareHarness's own schema/storage and Electron safeStorage, never plaintext library tokens.
const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const root = __dirname;
const workspace = path.resolve(root, '../../..');
const userData = process.env.HARDWAREHARNESS_USER_DATA || path.join(process.env.APPDATA, 'HardwareHarness');
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
  if (await portOpen(gatewayPort)) throw new Error('Close HardwareHarness before registration so its in-memory credential store cannot overwrite this change.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron credential encryption unavailable');
  const pythonRoot = path.join(workspace, 'HardwareHarness', 'python');
  const executable = process.env.HARDWAREHARNESS_PYTHON || path.join(pythonRoot, '.venv', 'Scripts', 'python.exe');
  await new Promise((resolve, reject) => {
    let result;
    const child = spawn(executable, ['-u', '-m', 'hardwareharness_backend.host.register_firedap', userData, root, modelRoot], {
      cwd: pythonRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONPATH: path.join(pythonRoot, 'src') }
    });
    const lines = createInterface({ input: child.stdout });
    child.stderr.pipe(process.stderr);
    lines.on('line', line => {
      try {
        const frame = JSON.parse(line);
        if (!frame.method) { result = frame.result; return; }
        let value;
        if (frame.method === 'encrypt') value = safeStorage.encryptString(frame.value).toString('base64');
        else if (frame.method === 'decrypt') value = safeStorage.decryptString(Buffer.from(frame.value, 'base64'));
        else throw new Error('Unknown credential callback');
        child.stdin.write(JSON.stringify({ result: value }) + '\n');
      } catch (error) {
        child.stdin.write(JSON.stringify({ error: error.message }) + '\n');
      }
    });
    child.once('error', reject);
    child.once('close', code => {
      lines.close();
      if (code !== 0 || !result?.ok) reject(new Error(`Python registration failed (${code})`));
      else { console.log(JSON.stringify(result, null, 2)); resolve(); }
    });
  });
}

app.whenReady().then(run).then(()=>app.exit(0)).catch(error=>{console.error(error.message);app.exit(1);});
