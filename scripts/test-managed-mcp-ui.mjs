// 390px React/client/session -> real Next handler/gateway -> synthetic loopback MCP.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { createManagedMcpFixture,repo } from './managed-mcp-fixture.mjs';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--workdir'||args[2]!=='--outdir'||!path.isAbsolute(args[1])||!path.isAbsolute(args[3]))throw Error('Use --workdir <absolute scratch> --outdir <absolute screenshots>');
const scratch=args[1],output=args[3];mkdirSync(scratch,{recursive:true});mkdirSync(output,{recursive:true});
const require=createRequire(path.join(repo,'package.json')),webpack=require('next/dist/compiled/webpack/webpack');webpack.init();
const css=readFileSync(path.join(repo,'components/memory/workspace.module.css'),'utf8'),names=[...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match=>match[1]);
writeFileSync(path.join(scratch,'css.cjs'),'module.exports=function(){return '+JSON.stringify('module.exports='+JSON.stringify(Object.fromEntries(names.map(name=>[name,name])))+';')+';};');
writeFileSync(path.join(scratch,'ts.cjs'),`const ts=require(${JSON.stringify(path.join(repo,'node_modules/typescript'))});module.exports=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;`);
writeFileSync(path.join(scratch,'kv.js'),'const cache=new Map();window.__mcpKv=cache;exports.kvGet=k=>cache.get(k);exports.kvSet=(k,v)=>cache.set(k,v);exports.kvRemove=k=>cache.delete(k);exports.registerDynamicPrefix=()=>{};');
writeFileSync(path.join(scratch,'entry.js'),`
const React=require('react'),{createRoot}=require('react-dom/client'),{ManagedMcpPanel}=require(${JSON.stringify(path.join(repo,'components/memory/managed-mcp-panel.tsx'))}),mcp=require(${JSON.stringify(path.join(repo,'lib/managed-mcp-session.ts'))});
function Fixture(){const[kind,setKind]=React.useState('work'),[busy,setBusy]=React.useState(false),[trace,setTrace]=React.useState([]),[note,setNote]=React.useState('');const scope={mode:kind,workspaceId:kind+'-fixture'};
async function run(){const session=mcp.getManagedMcpSession(scope);if(!session){setNote('请先明确启用本次AI服务');return;}setBusy(true);setTrace([]);setNote('');const runId=crypto.randomUUID();session.begin(runId);try{const call={id:'ui-mcp-call',name:session.tools()[0].name,args:{query:'UI_MCP_PRIVATE_ARG'}};session.validateBatch([call]);await session.execute(call,new AbortController().signal,t=>setTrace(old=>[...old,t]));mcp.clearManagedMcpRun(scope,runId);setNote('合成AI查询已完成');}catch{setNote('合成AI查询已停止');}finally{mcp.disableManagedMcpSession(scope);setBusy(false);}}
return React.createElement('main',{className:'page '+(kind==='private'?'privatePage':'')},React.createElement('p',null,'本地模拟 · '+(kind==='work'?'工作区':'私人空间')+' · 无真实服务或模型'),React.createElement('div',{className:'row'},React.createElement('button',{disabled:busy,onClick:()=>{setKind(kind==='work'?'private':'work');setTrace([]);setNote('');}},'切换测试空间'),React.createElement('button',{disabled:busy,onClick:run},'模拟本区AI查询')),React.createElement(ManagedMcpPanel,{key:kind,kind,workspaceId:scope.workspaceId,disabled:busy,trace}),React.createElement('p',{'aria-label':'模拟MCP状态'},note));}createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`);
await new Promise((resolve,reject)=>{const compiler=webpack.webpack({mode:'development',optimization:{minimize:false,minimizer:[]},target:'web',entry:path.join(scratch,'entry.js'),output:{path:scratch,filename:'bundle.js'},resolve:{alias:{'./kv-db':path.join(scratch,'kv.js'),'@/lib':path.join(repo,'lib')},extensions:['.ts','.tsx','.js'],modules:[path.join(repo,'node_modules'),'node_modules']},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:[{loader:path.join(scratch,'ts.cjs')}]},{test:/workspace\.module\.css$/,use:[{loader:path.join(scratch,'css.cjs')}]}]}});compiler.run((error,stats)=>compiler.close(close=>error||close||stats.hasErrors()?reject(error||close||Error(stats.toString({all:false,errors:true}))):resolve()));});
let fixture;
const server=createServer(async(request,response)=>{
    if(request.url==='/api/shared-memory/mcp'){
        const chunks=[];for await(const chunk of request)chunks.push(chunk);
        const result=await fixture.route.POST(new Request(origin+request.url,{method:'POST',headers:{'Content-Type':'application/json',Origin:request.headers.origin||'','x-float-memory-access-token':fixture.ownerToken},body:Buffer.concat(chunks)}));
        response.writeHead(result.status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(await result.text());return;
    }
    if(request.url==='/bundle.js'){response.setHeader('Content-Type','application/javascript');response.end(readFileSync(path.join(scratch,'bundle.js')));return;}
    response.setHeader('Content-Type','text/html;charset=utf-8');response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#141721;font-family:Arial,sans-serif}'+css+'</style><div id="root"></div><script src="/bundle.js"></script></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
fixture=await createManagedMcpFixture(origin);
const pw=process.env.FLOAT_TEST_PLAYWRIGHT?createRequire(path.join(process.env.FLOAT_TEST_PLAYWRIGHT,'package.json')):require;
let browser;
try{
 browser=await pw('playwright').chromium.launch({headless:true,...(process.env.FLOAT_TEST_BROWSER?{executablePath:process.env.FLOAT_TEST_BROWSER}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}),page=await context.newPage(),errors=[],outside=[];
 page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();outside.push(route.request().url());return route.abort();});
 await page.goto(origin);await page.getByText('受控外部工具 · 管理员配置',{exact:true}).click();assert.equal(fixture.requests.length,0);assert.equal(fixture.wire.length,0);
 await page.getByRole('button',{name:'读取本区外部工具目录',exact:true}).click();await page.getByLabel('授权 fixture lookup',{exact:true}).waitFor();assert.equal(await page.getByLabel('授权 fixture lookup',{exact:true}).isChecked(),false);assert.equal(fixture.wire.length,0);
 await page.getByLabel('授权 fixture lookup',{exact:true}).check();await page.getByRole('button',{name:'保存本区工具授权',exact:true}).click();await page.getByText('本区授权已保存；尚未连接或调用外部服务。',{exact:true}).waitFor();assert.equal(fixture.wire.length,0);
 await page.getByLabel('外部MCP服务',{exact:true}).selectOption('fixture');await page.getByLabel('外部MCP工具',{exact:true}).selectOption('lookup');
 await page.getByLabel('外部MCP参数JSON',{exact:true}).fill('{"query":"UI_MCP_MANUAL_ARG"}');await page.getByRole('button',{name:'明确执行一次只读工具',exact:true}).click();await page.getByLabel('外部MCP返回资料',{exact:true}).filter({hasText:'UI_MCP_MANUAL_ARG'}).waitFor();assert.equal(fixture.counts.call,1);
 const ai=page.getByLabel('本次新消息使用外部MCP服务',{exact:true});assert.equal(await ai.isChecked(),false);const prior=fixture.wire.length;
 await ai.check();await page.getByRole('button',{name:'停用AI外部工具并停止本轮',exact:true}).waitFor();assert.equal(fixture.wire.length,prior);
 await page.getByRole('button',{name:'模拟本区AI查询',exact:true}).click();await page.getByLabel('模拟MCP状态',{exact:true}).filter({hasText:'合成AI查询已完成'}).waitFor();assert.equal(await ai.isChecked(),false);assert.equal(fixture.counts.call,2);assert.equal(await page.getByLabel('AI外部MCP回执',{exact:true}).getByRole('listitem').count(),1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(output,'managed-mcp-work-mobile.png'),fullPage:true});
 fixture.behavior.delay=true;await ai.check();await page.getByRole('button',{name:'模拟本区AI查询',exact:true}).click();const waitStarted=Date.now();while(fixture.counts.call<3){if(Date.now()-waitStarted>5000)throw Error('UI tool call fixture did not start');await page.waitForTimeout(20);}
 await page.getByRole('button',{name:'停用AI外部工具并停止本轮',exact:true}).click();await page.getByLabel('模拟MCP状态',{exact:true}).filter({hasText:'合成AI查询已停止'}).waitFor();fixture.release();delete fixture.behavior.delay;
 await page.getByRole('button',{name:'核对原MCP回执',exact:true}).click();await page.getByText(/原调用状态：/).waitFor();assert.equal(fixture.counts.call,3);
 await page.getByRole('button',{name:'关闭本区外部工具授权',exact:true}).click();await page.getByText('本区外部工具授权已关闭；已提交请求无法撤回。',{exact:true}).waitFor();assert.equal(await ai.isDisabled(),true);
 await page.getByRole('button',{name:'切换测试空间',exact:true}).click();await page.getByText('受控外部工具 · 管理员配置',{exact:true}).click();await page.getByRole('button',{name:'读取本区外部工具目录',exact:true}).click();await page.getByLabel('授权 fixture lookup',{exact:true}).waitFor();assert.equal(await page.getByLabel('授权 fixture lookup',{exact:true}).isChecked(),false);
 await page.getByLabel('外部MCP服务',{exact:true}).selectOption('fixture');assert.equal(await ai.isChecked(),false);assert.equal(await ai.isDisabled(),true);await page.screenshot({path:path.join(output,'managed-mcp-private-mobile.png'),fullPage:true});
 const cache=JSON.stringify(await page.evaluate(()=>[...window.__mcpKv]));for(const marker of ['UI_MCP_PRIVATE_ARG','UI_MCP_MANUAL_ARG','SYNTHETIC_MCP_RESULT','SYNTHETIC_MCP_SERVER_TOKEN'])assert.ok(!cache.includes(marker));
 fixture.setEnabled(false);const disabledPage=await context.newPage();await disabledPage.goto(origin);await disabledPage.getByText('受控外部工具 · 管理员配置',{exact:true}).click();await disabledPage.getByRole('button',{name:'读取本区外部工具目录',exact:true}).click();await disabledPage.getByText('管理员尚未配置或启用受控MCP；没有连接外部服务。',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
 console.log('Managed MCP 390px React: no automatic API/MCP, explicit scoped grants and service, manual real gateway call, per-message AI opt-in/auto-off, interrupt while busy, receipt-only recovery, revoke, private scope reset/default off, disabled server, no body KV/external browser network/overflow passed. Synthetic MCP/session AI fixture only.');
}finally{await browser?.close();await fixture.close();const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;}
