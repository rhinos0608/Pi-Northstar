import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { UPSTREAM_TOOLS, type UpstreamTool } from './desktop-contract.js';
import { assertDriverTrusted, loadBundledManifest } from './driver-manifest.js';
import { resolveCliCommand, windowsPathValue } from '../process/cli-command.js';

export const CUA_DRIVER_VERSION='0.7.1';
export const CUA_DRIVER_COMMAND='cua-driver';
const BASE_ENV=['PATH','HOME','USERPROFILE','TMPDIR','TEMP','TMP','LANG','LC_ALL'];
const LINUX_ENV=['DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'];
const BLOCKED_ENV=/^(?:.*(?:TOKEN|KEY|SECRET|COOKIE|PASSWORD|PROXY|API).*)$|^(?:npm_config_|NODE_OPTIONS$|NODE_PATH$|PYTHONPATH$|GIT_CONFIG_|SSL_CERT_|LD_PRELOAD$|DYLD_)/i;
export function buildCuaEnvironment(env:Record<string,string|undefined>=process.env, platform=process.platform):Record<string,string> { const keys=new Set([...BASE_ENV,...(platform==='linux'?LINUX_ENV:[])]); const out:Record<string,string>={}; for(const key of keys){const value=env[key]; if(typeof value==='string'&&!BLOCKED_ENV.test(key)) out[key]=value;} return out; }
export function cuaServerParameters(env:Record<string,string|undefined>=process.env):StdioServerParameters { return { command:CUA_DRIVER_COMMAND,args:['mcp'],env:buildCuaEnvironment(env),stderr:'pipe' }; }
export interface CuaCallOptions { signal?:AbortSignal; timeout?:number; resource?:string; mutation?:boolean; }
export interface CuaTransport { callTool(name:string,args:Record<string,unknown>, options?:{signal?:AbortSignal;timeout?:number}):Promise<unknown>; listTools?():Promise<unknown>; close():Promise<void>; status?():Promise<unknown>; }
export interface CuaClientDeps { verifyDriver?:(command:string)=>Promise<void>; createTransport?:(params:cuaServerParametersLike)=>StdioClientTransport; createClient?:()=>Client; }
export class CuaClient implements CuaTransport {
 private client:Client|undefined; private transport:StdioClientTransport|undefined; private connecting:Promise<void>|undefined; private closed=false; private readonly queues=new Map<string,Promise<void>>(); private readonly factoryTransports=new Set<CuaTransport>();
 constructor(private readonly params:cuaServerParametersLike=cuaServerParameters(), private readonly factory?:()=>CuaTransport, private readonly deps:CuaClientDeps={}) {}
 async callTool(name:string,args:Record<string,unknown>,options:CuaCallOptions={}):Promise<unknown> { if(!UPSTREAM_TOOLS.includes(name as UpstreamTool)) throw new Error(`ACTION_DENIED: upstream tool ${name}`); const run=async()=>{if(options.mutation){try{return await this.rawCall(name,args,options);}catch(error){if(isDispatchLoss(error)) throw new Error('OUTCOME_UNKNOWN: mutation dispatch status unknown'); throw error;}} return this.rawCall(name,args,options);}; if(!options.resource)return run(); const previous=this.queues.get(options.resource)??Promise.resolve(); let release!:()=>void; const current=new Promise<void>(r=>{release=r}); this.queues.set(options.resource,current); await previous; try{return await run();}finally{release();if(this.queues.get(options.resource)===current)this.queues.delete(options.resource);} }
 async status():Promise<unknown>{ if(this.factory){ if(this.closed)throw new Error('Cua client is closed.'); const transport=this.factory(); this.factoryTransports.add(transport); try{return await transport.status?.();}finally{this.factoryTransports.delete(transport);} } return this.rawCall('health_report',{},{});}
 async close():Promise<void>{this.closed=true; const connecting=this.connecting; if(connecting){try{await connecting;}catch{/* open error belongs to the connect caller; close still reaps */}} const transport=this.transport; this.transport=undefined; this.client=undefined; try{await transport?.close();}catch{/* primary close is best-effort; continue factory cleanup */} const pending=[...this.factoryTransports]; this.factoryTransports.clear(); await Promise.allSettled(pending.map(t=>t.close())); this.queues.clear();}
 private async rawCall(name:string,args:Record<string,unknown>,options:CuaCallOptions):Promise<unknown>{ if(this.factory){ if(this.closed)throw new Error('Cua client is closed.'); const transport=this.factory(); this.factoryTransports.add(transport); try{return await transport.callTool(name,args,options);}finally{this.factoryTransports.delete(transport);} } const client=await this.connect(); return client.callTool({name,arguments:args},undefined,{...(options.signal?{signal:options.signal}:{}),timeout:options.timeout??15000,resetTimeoutOnProgress:true}); }
 private async connect():Promise<Client>{ if(this.closed)throw new Error('Cua client is closed.'); if(this.client)return this.client; if(this.connecting){await this.connecting; if(this.closed)throw new Error('Cua client is closed.'); return this.client!;} this.connecting=this.open(); try{await this.connecting; if(this.closed)throw new Error('Cua client is closed.'); return this.client!;}finally{this.connecting=undefined;} }
 private async open():Promise<void>{ const verify=this.deps.verifyDriver??verifyCuaDriverVersion; await verify(this.params.command); const transport=(this.deps.createTransport??((params)=>new StdioClientTransport(params)))(this.params); try{ const client=this.deps.createClient?.()??new Client({name:'pi-northstar-cua-desktop',version:'0.1.0'}); transport.stderr?.on('data',()=>undefined); await client.connect(transport); const listed=await client.listTools(); const names=new Set(listed.tools.map(tool=>tool.name)); for(const required of ['health_report','list_apps','list_windows','get_window_state']) if(!names.has(required)) throw new Error(`DRIVER_UNAVAILABLE: missing required tool ${required}`); if(this.closed){ try{await transport.close();}catch{/* already closing; drop the late transport */} throw new Error('Cua client is closed.'); } this.transport=transport;this.client=client; }catch(error){ try{await transport.close();}catch{/* preserve original open error; close is best-effort child reaping */} throw error; } }
}
type cuaServerParametersLike=StdioServerParameters;
export function resolveCuaDriverExecutable(
  command = CUA_DRIVER_COMMAND,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : undefined;
  }
  const pathValue = platform === 'win32' ? windowsPathValue(env) : (env.PATH ?? '');
  if (platform === 'win32') {
    const resolved = resolveCliCommand(command, { platform, pathValue });
    if (resolved !== command && existsSync(resolved)) return resolved;
    return undefined;
  }
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function verifyCuaDriverVersion(command: string): Promise<void> {
  // Gate B Slice 10: verify driver binary against artifact manifest before spawn.
  // Missing manifest or unenrolled entry skips gate silently; enrolled mismatch throws.
  // Resolve executable via sanitized PATH logic.
  const resolvedPath = resolveCuaDriverExecutable(command);
  if (resolvedPath) {
    const manifest = loadBundledManifest();
    if (manifest) {
      const platform = `${process.platform}-${process.arch}`;
      assertDriverTrusted(manifest, 'cua-driver', platform, resolvedPath);
    }
  }

  return new Promise((resolve, reject) => {
    execFile(command, ['--version'], { timeout: 10000, env: { PATH: process.env.PATH ?? '' } }, (error, stdout) => {
      if (error) { reject(new Error(`DRIVER_UNAVAILABLE: version check failed: ${error.message}`)); return; }
      const output = String(stdout).trim();
      const expected = CUA_DRIVER_VERSION;
      const valid = output === expected || output === `cua-driver ${expected}`;
      if (!valid) { reject(new Error(`DRIVER_UNAVAILABLE: expected exact Cua Driver ${expected}`)); return; }
      resolve();
    });
  });
}
function isDispatchLoss(error: unknown): boolean { return error instanceof Error && /closed|disconnect|transport|abort|timeout/i.test(error.message); }
