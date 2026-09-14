// Launch the built TestForge desktop and exercise its real preload/application APIs.
// No debugging listener is opened. The verified desktop remains open for the user.
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const desktop = path.resolve(__dirname,'../../../testForge/apps/desktop');
app.setAppPath(desktop);
app.setPath('userData',process.env.TESTFORGE_USER_DATA || path.join(process.env.APPDATA,'@testforge','desktop'));
let checked=false;
app.on('browser-window-created',(_event,window)=>{
  window.webContents.once('did-finish-load',async()=>{
    if (checked) return;
    checked=true;
    try {
      const result=await window.webContents.executeJavaScript(`(async()=>{
        const server=await window.testforge.devices.refreshServer('FIREDAP_MCP');
        const computer=await window.testforge.devices.refreshComputer('LOCAL_PC');
        const hardware=await window.testforge.devices.listHardware();
        const dashboard=await window.testforge.system.dashboard();
        const board=hardware.find(h=>h.hardwareId==='DUT_1');
        const probe=hardware.find(h=>h.hardwareId==='LOCAL_MCP.FIREDAP_0');
        const tools=dashboard.tools.filter(t=>t.serverId==='FIREDAP_MCP');
        return {server,computer,board,probe,tools:tools.map(t=>({name:t.externalName,kind:t.kind})),execution:dashboard.execution};
      })()`);
      if (result.server.transport.state!=='online' || result.computer.ssh.state!=='online'
          || result.board?.kind!=='passive' || result.board?.ports.length!==14 || result.probe?.kind!=='managed'
          || !result.tools.some(t=>t.name==='FIREDAP_MCP__firedap_flash')) throw new Error('Desktop registration verification failed: '+JSON.stringify(result));
      const report={ok:true,checkedAt:new Date().toISOString(),...result};
      await fs.mkdir(path.join(__dirname,'run'),{recursive:true});
      await fs.writeFile(path.join(__dirname,'run/desktop-verification.json'),JSON.stringify(report,null,2));
      console.log('FireDAP desktop integration verified: MCP online, local lifecycle online, 14 passive board ports, programmer managed.');
      window.show();
      // Keep the normal TestForge window available after checks.
    } catch(error) {
      await fs.writeFile(path.join(__dirname,'run/desktop-verification.json'),JSON.stringify({ok:false,error:String(error)}));
      console.error(error);
    }
  });
});
import(pathToFileURL(path.join(desktop,'out/main/index.js'))).catch(error=>{console.error(error);app.exit(1);});
