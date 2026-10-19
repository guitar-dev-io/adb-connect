'use strict';
const vscode = require('vscode');
const { runAdb, parseDevices, parseMdns, validEndpoint } = require('./adb');
const { showManager } = require('./ui');
let output, status, timer, manager, devices = [], busy = false;
const config = () => vscode.workspace.getConfiguration('adbConnect');
const run = (args, ms) => runAdb(config().get('adbPath') || 'adb',args,ms);
function log(msg) { output.appendLine(`[${new Date().toISOString()}] ${msg}`); }
function setStatus() {
  if (!status) return;
  const connected = devices.filter(d => d.status === 'device');
  status.text = connected.length ? `$(device-mobile) ${connected.length === 1 ? connected[0].model : `${connected.length} devices`}` : '$(device-mobile) ADB: Disconnected';
  status.tooltip = `${connected.length} connected Android device(s)\nClick for Quick Actions`;
  status.showStatusBar = true;
  config().get('showStatusBar',true) ? status.show() : status.hide();
  if (manager) manager.refresh();
}
async function refresh() {
  try {
    const result = await run(['devices','-l'],8000);
    if (result.code !== 0) throw new Error(result.text);
    devices = parseDevices(result.stdout); setStatus();
  } catch(e) { log(e.message); devices = []; setStatus(); }
}
async function action(title, args, timeout=15000) {
  if (busy) { vscode.window.showInformationMessage('ADB operation already running'); return null; }
  busy = true; status.text = `$(sync~spin) ${title}`;
  try {
    const r = await run(args,timeout);
    log(`adb ${args.map((a,i) => args[0] === 'pair' && i === 2 ? '[REDACTED]' : a).join(' ')} : exit ${r.code}`);
    if(r.code !== 0 || /failed to|cannot connect|error:/i.test(r.text)) throw new Error(r.text || 'ADB command failed');
    if(r.text) vscode.window.showInformationMessage(r.text.slice(0,500));
    return r;
  } catch(e) { vscode.window.showErrorMessage(`${title}: ${e.message}`); log(`${title} failed: ${e.message}`); return null; }
  finally { busy = false; await refresh(); }
}
async function connect(endpoint) {
  if (!endpoint) endpoint = await vscode.window.showInputBox({title:'ADB Connect: IP and connect port',prompt:'Use the Wireless debugging device address (not the pairing port)',placeHolder:'192.168.1.20:37123',validateInput:v=>validEndpoint(v)?null:'Enter a valid host:port'});
  if (!endpoint) return;
  const r = await action('Connect', ['connect',endpoint]);
  if(r && /connected to|already connected to/i.test(r.text)) await remember(endpoint);
}
async function remember(endpoint) {
  const cfg=config();let saved=cfg.get('knownEndpoints',[]);
  if(!saved.includes(endpoint)) await cfg.update('knownEndpoints',[...saved,endpoint].slice(-30),vscode.ConfigurationTarget.Global);
}
async function pairCode() {
  const endpoint=await vscode.window.showInputBox({title:'Pair Android with pairing code',prompt:'On your phone: Developer options > Wireless debugging > Pair device with pairing code',placeHolder:'192.168.1.20:42761',validateInput:v=>validEndpoint(v)?null:'Enter pairing IP:port shown on Android'});
  if(!endpoint)return;
  const code=await vscode.window.showInputBox({title:'6-digit pairing code',placeHolder:'123456',password:true,validateInput:v=>/^\d{6}$/.test(v)?null:'Enter exactly 6 digits'});
  if(!code)return;
  // adb pair accepts code as argument. Never log code, persist it, or print full error credentials.
  const result=await action('Pair',['pair',endpoint,code],30000);
  if(result){vscode.window.showInformationMessage('Pairing completed. Discover or enter your device connect IP:port (which differs from the pairing port).','Discover').then(x=>x==='Discover'&&discover());}
}
async function discover() {
  const r=await run(['mdns','services'],10000).catch(e=>({code:1,text:e.message,stdout:''}));
  if(r.code !== 0) return vscode.window.showWarningMessage(`mDNS discovery unavailable: ${r.text}`);
  const found=parseMdns(r.stdout).filter(x=>x.service.includes('connect'));
  if(!found.length)return vscode.window.showInformationMessage('No discoverable ADB connect services. Check Wi-Fi and Wireless debugging, or use IP:Port.');
  const choice=await vscode.window.showQuickPick(found.map(x=>({label:x.name,description:x.endpoint,endpoint:x.endpoint})),{placeHolder:'Select an Android device'});
  if(choice)await connect(choice.endpoint);
}
async function reconnect() {
  const known=config().get('knownEndpoints',[]).filter(validEndpoint);
  if(!known.length)return vscode.window.showInformationMessage('No saved endpoints yet. Connect once by IP:Port or discover devices.');
  for(const endpoint of known){const r=await run(['connect',endpoint],9000).catch(e=>({text:e.message,code:1}));log(`Reconnect ${endpoint}: ${r.code===0?'attempted':'failed'}`);}
  await refresh();
}
async function disconnect(serial) {
  const candidates=devices.filter(d=>d.transport==='Wi-Fi');
  if (!serial) {
    const choice=await vscode.window.showQuickPick(candidates.map(d=>({label:d.model,description:d.serial,serial:d.serial})),{placeHolder:'Disconnect which wireless Android device?'});
    if(!choice)return;serial=choice.serial;
  }
  if(!validEndpoint(serial))return vscode.window.showWarningMessage('Only wireless ADB endpoints can be disconnected here.');
  await action('Disconnect',['disconnect',serial]);
}
function qrGuide() {
  vscode.window.showInformationMessage('QR pairing requires an ADB QR pairing server and mDNS advertisement; this preview does not generate a nonfunctional QR. Use Pair with 6-digit Code instead.','Pair with Code').then(v=>v==='Pair with Code'&&pairCode());
}
async function menu() {
  const items=[['$(device-mobile) Device Manager','devices'],['$(key) Pair with 6-digit Code','pairCode'],['$(qr-code) QR Pairing (Guide)','pairQr'],['$(plug) Connect by IP:Port','connect'],['$(search) Discover Devices','discover'],['$(sync) Reconnect Saved Devices','reconnect'],['$(debug-disconnect) Disconnect','disconnect'],['$(output) Show ADB Logs','logs']];
  const p=await vscode.window.showQuickPick(items.map(([label,id])=>({label,id})),{placeHolder:'ADB Connect • Select an action'});
  if(p) await dispatch(p.id);
}
function dispatch(id, serial) {
  switch(id){case 'devices':if(manager){manager.panel.reveal();manager.refresh();}else{manager=showManager(()=>devices,(a,s)=>dispatch(a,s));manager.panel.onDidDispose(()=>manager=null);}return;
    case 'pairCode':return pairCode();case 'pairQr':return qrGuide();case 'connect':return connect();case 'discover':return discover();case 'reconnect':return reconnect();case 'disconnect':return disconnect(serial);case 'logs':return output.show(true);case 'menu':return menu();}
}
async function activate(context) {
  output=vscode.window.createOutputChannel('ADB Connect');
  status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,80);
  status.command='adbConnect.menu';context.subscriptions.push(output,status);
  for(const name of ['menu','devices','pairCode','pairQr','connect','discover','reconnect','disconnect','logs']) context.subscriptions.push(vscode.commands.registerCommand(`adbConnect.${name}`,()=>dispatch(name)));
  await refresh();
  if(config().get('autoReconnect',true))await reconnect();
  const seconds=Math.max(5,Math.min(300,Number(config().get('refreshIntervalSeconds',15))||15));
  timer=setInterval(()=>{if(!busy) refresh();},seconds*1000);
  context.subscriptions.push({dispose:()=>clearInterval(timer)});
  log('ADB Connect ready');
}
function deactivate(){if(timer)clearInterval(timer);}
module.exports={activate,deactivate};
