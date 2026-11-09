// Local React + actual phone tool runtime. Fake Native only; never opens device UI.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2);
if (args[0] !== '--workdir' || args[2] !== '--outdir' || args.length !== 4 || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) throw Error('Use --workdir <absolute scratch path> --outdir <absolute screenshot path>');
const fixture = args[1], output = args[3]; mkdirSync(fixture, { recursive: true }); mkdirSync(output, { recursive: true });
const require = createRequire(path.join(root, 'package.json')), webpack = require('next/dist/compiled/webpack/webpack'); webpack.init();
const css = readFileSync(path.join(root, 'components/memory/workspace.module.css'), 'utf8'), names = [...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match => match[1]);
writeFileSync(path.join(fixture, 'css-loader.cjs'), 'module.exports=function(){return ' + JSON.stringify('module.exports=' + JSON.stringify(Object.fromEntries(names.map(name => [name, name]))) + ';') + ';};');
writeFileSync(path.join(fixture, 'ts-loader.cjs'), `const ts=require(${JSON.stringify(path.join(root, 'node_modules/typescript'))});module.exports=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;`);
writeFileSync(path.join(fixture, 'kv.js'), 'const cache=new Map();window.__fixtureKv=cache;exports.kvGet=k=>cache.get(k);exports.kvSet=(k,v)=>cache.set(k,v);exports.kvRemove=k=>cache.delete(k);exports.registerDynamicPrefix=()=>{};');
const body = '合成手机资料 · 不是真实文件', created = '合成另存内容 · 只用于测试', sha = text => createHash('sha256').update(text).digest('hex');
writeFileSync(path.join(fixture, 'entry.js'), `
const React=require('react'),{createRoot}=require('react-dom/client');
const {PhoneDirectoryPanel}=require(${JSON.stringify(path.join(root, 'components/memory/phone-directory-panel.tsx'))});
const tools=require(${JSON.stringify(path.join(root, 'lib/phone-file-tools.ts'))});
const wire=data=>JSON.stringify({protocol:'float-shell-files/v1',location:'android_device',...data}),done=result=>wire({ok:true,state:'complete',result}),jobs=new Map();
window.__ops=[];window.__wait=false;window.__ready=false;window.__schemas=[];
const grant=scope=>({id:scope.mode+'-grant',label:'合成手机目录 · '+scope.mode,readable:true,writable:true});
if(!window.__legacy)window.AndroidShell={
 getScopedFilesCapabilities:()=>wire({ok:true,createOnly:true,maxTextBytes:32768}),
 requestScopedDirectory:()=>{throw Error('No picker expected');},
 submitScopedFiles:raw=>{const op=JSON.parse(raw);window.__ops.push(op);let result;
 if(op.operation==='grants')result=done({grants:[grant(op.scope)]});
 else if(op.grantId!==grant(op.scope).id)result=wire({ok:false,code:'grant_scope'});
 else if(op.operation==='list')result=done({path:op.path,files:[{name:'note.md',directory:false,bytes:${Buffer.byteLength(body)}}]});
 else if(op.operation==='read')result=done({path:op.path,content:${JSON.stringify(body)},bytes:${Buffer.byteLength(body)},digest:${JSON.stringify(sha(body))}});
 else if(op.operation==='create')result=done({created:true,path:op.path,bytes:${Buffer.byteLength(created)},digest:${JSON.stringify(sha(created))}});
 else if(op.operation==='revoke')result=done({revoked:true});
 else throw Error('Unexpected fixture operation');
 jobs.set(op.requestId,{scope:op.scope,result});return window.__wait&&op.operation==='read'?wire({ok:true,state:'pending'}):result;},
 getScopedFilesResult:(scope,id)=>window.__wait?wire({ok:true,state:'pending'}):jobs.get(id)?.result||wire({ok:false,code:'request_missing'}),
 verifyScopedFiles:(scope,id)=>jobs.get(id)?.result||wire({ok:false,code:'request_missing'}),
 cancelScopedFiles:(scope,id)=>{window.__ops.push({operation:'cancel'});if(jobs.has(id))jobs.get(id).result=wire({ok:false,code:'cancelled'});return wire({ok:false,code:'cancelled'});}
};
function Fixture(){
 const[kind,setKind]=React.useState('work'),[busy,setBusy]=React.useState(false),[trace,setTrace]=React.useState([]),[note,setNote]=React.useState('');
 const scope={mode:kind,workspaceId:'synthetic-ui-space'};
 async function run(wait){const session=tools.getPhoneToolSession(scope);if(!session){setNote('请先明确启用本区AI手机目录');return;}setBusy(true);setTrace([]);setNote('');window.__wait=wait;window.__schemas=session.tools().map(t=>t.name);session.begin(crypto.randomUUID());
  const calls=[{id:'ui-list',name:'phone_list_files',args:{path:''}},{id:'ui-read',name:'phone_read_file',args:{path:'note.md'}}];
  if(!wait&&window.__schemas.includes('phone_create_file'))calls.push({id:'ui-create',name:'phone_create_file',args:{path:'new.md',content:${JSON.stringify(created)}}});
  try{session.validateBatch(calls);for(const call of calls)await session.execute(call,new AbortController().signal,t=>setTrace(old=>[...old,t]));setNote('合成任务完成，已核对手机回执');}
  catch{setNote('合成任务已停止，没有继续新建');}
  finally{window.__wait=false;tools.disablePhoneTools(scope);setBusy(false);}
 }
 return React.createElement('main',{className:'page '+(kind==='private'?'privatePage':'')},React.createElement('p',null,'本地模拟 · '+(kind==='private'?'私人空间':'工作区')+' · 未连接真实手机'),
 React.createElement('div',{className:'row'},React.createElement('button',{disabled:busy,onClick:()=>{setKind(kind==='work'?'private':'work');setTrace([]);setNote('');}},'切换测试空间'),React.createElement('button',{disabled:busy,onClick:()=>run(false)},'模拟AI先读后另存'),React.createElement('button',{disabled:busy,onClick:()=>run(true)},'模拟AI等待中')),
 React.createElement(PhoneDirectoryPanel,{key:kind,kind,workspaceId:scope.workspaceId,disabled:busy,trace}),React.createElement('p',{'aria-label':'模拟任务状态'},note));
}createRoot(document.getElementById('root')).render(React.createElement(Fixture));window.__ready=true;
`);
await new Promise((resolve, reject) => {
    const compiler = webpack.webpack({ mode: 'development', optimization: { minimize: false, minimizer: [] }, target: 'web', entry: path.join(fixture, 'entry.js'), output: { path: fixture, filename: 'bundle.js' }, resolve: { alias: { './kv-db': path.join(fixture, 'kv.js'), '@/lib': path.join(root, 'lib') }, extensions: ['.ts', '.tsx', '.js'], modules: [path.join(root, 'node_modules'), 'node_modules'] }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: [{ loader: path.join(fixture, 'ts-loader.cjs') }] }, { test: /workspace\.module\.css$/, use: [{ loader: path.join(fixture, 'css-loader.cjs') }] }] } });
    compiler.run((error, stats) => compiler.close(close => error || close || stats.hasErrors() ? reject(error || close || Error(stats.toString({ all: false, errors: true }))) : resolve()));
});
const server = createServer((req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(readFileSync(path.join(fixture, 'bundle.js'))); return; }
    res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#151822}' + css + '</style><div id="root"></div><script src="/bundle.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const pwRequire = process.env.FLOAT_TEST_PLAYWRIGHT ? createRequire(path.join(process.env.FLOAT_TEST_PLAYWRIGHT, 'package.json')) : require;
let browser;
try {
    browser = await pwRequire('playwright').chromium.launch({ headless: true, ...(process.env.FLOAT_TEST_BROWSER ? { executablePath: process.env.FLOAT_TEST_BROWSER } : {}) });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 FloatShell/1.0.30 synthetic', locale: 'zh-CN' });
    const page = await context.newPage(), errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); external.push(route.request().url()); return route.abort(); });
    await page.goto(origin); await page.getByText('手机授权目录 · 仅此设备', { exact: true }).click();
    const enabled = page.getByLabel('本次新消息使用AI手机目录', { exact: true }), write = page.getByLabel('允许AI另存手机新文件', { exact: true });
    assert.equal(await enabled.isChecked(), false); assert.equal(await write.isChecked(), false); assert.equal(await enabled.isDisabled(), true);
    assert.equal((await page.evaluate(() => window.__ops)).length, 0);
    await page.getByRole('button', { name: '查看本区目录授权', exact: true }).click(); await page.getByLabel('当前手机目录', { exact: true }).selectOption('work-grant');
    await write.check(); await enabled.check(); await page.getByRole('button', { name: '停用AI手机工具并停止本轮', exact: true }).waitFor();
    assert.ok((await page.evaluate(() => window.__ops)).every(op => op.operation === 'grants'));
    await page.getByRole('button', { name: '模拟AI先读后另存', exact: true }).click();
    await page.getByLabel('模拟任务状态', { exact: true }).filter({ hasText: '合成任务完成' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__schemas), ['phone_list_files', 'phone_read_file', 'phone_create_file']);
    assert.equal(await enabled.isChecked(), false); assert.equal(await write.isChecked(), false);
    assert.equal(await page.getByLabel('AI手机操作回执', { exact: true }).getByRole('listitem').count(), 3);
    assert.ok(!JSON.stringify(await page.evaluate(() => [...window.__fixtureKv])).includes(body));
    assert.ok(!JSON.stringify(await page.evaluate(() => [...window.__fixtureKv])).includes(created));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, 'float-ai-phone-tools-mobile.png'), fullPage: true });
    await enabled.check(); await page.getByRole('button', { name: '模拟AI等待中', exact: true }).click();
    await page.waitForFunction(() => window.__ops.filter(op => op.operation === 'read').length === 2);
    assert.equal(await page.getByRole('button', { name: '停用AI手机工具并停止本轮', exact: true }).isEnabled(), true);
    const creates = (await page.evaluate(() => window.__ops)).filter(op => op.operation === 'create').length;
    await page.getByRole('button', { name: '停用AI手机工具并停止本轮', exact: true }).click();
    await page.getByLabel('模拟任务状态', { exact: true }).filter({ hasText: '合成任务已停止' }).waitFor();
    assert.equal((await page.evaluate(() => window.__ops)).filter(op => op.operation === 'create').length, creates);
    await page.getByRole('button', { name: '切换测试空间', exact: true }).click(); await page.getByText('手机授权目录 · 仅此设备', { exact: true }).click();
    assert.equal(await enabled.isChecked(), false); assert.equal(await enabled.isDisabled(), true);
    await page.getByRole('button', { name: '查看本区目录授权', exact: true }).click(); await page.getByLabel('当前手机目录', { exact: true }).selectOption('private-grant');
    await enabled.check(); await page.getByRole('button', { name: '模拟AI先读后另存', exact: true }).click(); await page.getByLabel('模拟任务状态', { exact: true }).filter({ hasText: '合成任务完成' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__schemas), ['phone_list_files', 'phone_read_file']);
    await page.screenshot({ path: path.join(output, 'float-ai-phone-tools-private-mobile.png'), fullPage: true });
    const legacy = await context.newPage(); await legacy.addInitScript(() => { window.__legacy = true; }); await legacy.goto(origin); await legacy.getByText('手机授权目录 · 仅此设备', { exact: true }).click();
    assert.equal(await legacy.getByLabel('本次新消息使用AI手机目录', { exact: true }).isDisabled(), true); assert.deepEqual(await legacy.evaluate(() => window.__ops), []);
    assert.deepEqual(external, []); assert.deepEqual(errors, []);
    console.log('390px React phone AI UI: default off, explicit directory, create opt-in, one-message auto-off, receipt projection, interrupt enabled while busy, no new write after disable, work/private reset, read-only schema, old bridge refusal, no body KV/network and layout passed. Fake Native; no device/APK.');
} finally { await browser?.close(); const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; }
