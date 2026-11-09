// Separate-process persistence test only. Every network dependency throws.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(import.meta.url);
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());
function load(relative,mocks={}){const module={exports:{}},code=ts.transpileModule(readFileSync(path.join(root,relative),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;vm.runInNewContext(code,{module,exports:module.exports,require:name=>{if(mocks[name])return mocks[name];if(name.startsWith('node:'))return require(name);throw Error('Unexpected test worker dependency');},process:{env:{},platform:process.platform},Buffer,URL,TextDecoder,AbortController,AbortSignal,setInterval,clearInterval});return module.exports;}
const policy=load('lib/managed-mcp-policy.ts'),transport=load('lib/server/managed-mcp-transport.ts',{'../managed-mcp-policy':policy}),gateway=load('lib/server/managed-mcp.ts',{'../managed-mcp-policy':policy,'./managed-mcp-transport':transport});
const noNetwork=()=>{throw Error('Persistence recovery attempted network');};
const handle=gateway.createManagedMcpGateway(gateway.readManagedMcpConfig(input.env),'https://float.fixture',async()=>{}, {lookup:noNetwork,request:noNetwork});
const result=await handle(input.body,new AbortController().signal);if(!result.replayed)throw Error('Expected persisted receipt, no replay');process.stdout.write(JSON.stringify(result));
