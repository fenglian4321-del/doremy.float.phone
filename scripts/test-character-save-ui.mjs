// Actual character editor + storage + world/version stores in a fresh browser.
// Only KV durability failures and unrelated model generators are synthetic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.resolve(process.env.FLOAT_TEST_WORK_DIR || path.join(repo, 'work/character-save-ui'));
mkdirSync(scratch, { recursive: true });
const require = createRequire(path.join(repo, 'package.json')), webpack = require('next/dist/compiled/webpack/webpack'); webpack.init();
writeFileSync(path.join(scratch, 'ts.cjs'), `const ts=require(${JSON.stringify(path.join(repo, 'node_modules/typescript'))});module.exports=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;`);
writeFileSync(path.join(scratch, 'kv.js'), `exports.kvGet=k=>localStorage.getItem(k);exports.kvSet=(k,v)=>localStorage.setItem(k,v);exports.kvSetAsync=async(k,v)=>{localStorage.setItem(k,v);if(window.__failSave)throw Error('SYNTHETIC_IDB_FAILURE');};exports.kvRemove=k=>localStorage.removeItem(k);exports.registerKvMigration=()=>{};exports.registerDynamicPrefix=()=>{};`);
writeFileSync(path.join(scratch, 'noop.js'), `exports.notifyMascotPageContext=()=>{};exports.isBriefPersonaStale=()=>false;exports.loadMomentsConfig=()=>({});exports.saveMomentsConfig=()=>{};exports.removeCharacterChatReferences=async()=>{};exports.generateBriefPersonaText=async()=>{throw Error('No model allowed');};exports.generateSupportingCharacters=async()=>{throw Error('No model allowed');};`);
writeFileSync(path.join(scratch, 'entry.js'), `const React=require('react'),{createRoot}=require('react-dom/client');const {PhoneCharacterApp}=require(${JSON.stringify(path.join(repo,'components/phone-character-app.tsx'))});function App(){const[note,setNote]=React.useState('');return React.createElement(React.Fragment,null,React.createElement(PhoneCharacterApp,{onClose:()=>{},onNotice:setNote}),React.createElement('output',{'data-testid':'notice'},note));}createRoot(document.getElementById('root')).render(React.createElement(App));`);
let browser, server; const errors = [];
try {
    const aliases = { '@/lib/kv-db': path.join(scratch,'kv.js'), './kv-db': path.join(scratch,'kv.js'), '@/components': path.join(repo,'components'), '@/lib': path.join(repo,'lib') };
    for (const name of ['brief-persona','npc-generator','moments-storage','mascot-events','character-chat-cleanup']) aliases['@/lib/'+name] = path.join(scratch,'noop.js');
    await new Promise((resolve,reject)=>{const compiler=webpack.webpack({mode:'development',target:'web',optimization:{minimize:false,minimizer:[]},entry:path.join(scratch,'entry.js'),output:{path:scratch,filename:'bundle.js'},resolve:{alias:aliases,extensions:['.ts','.tsx','.js'],modules:[path.join(repo,'node_modules'),'node_modules']},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:[{loader:path.join(scratch,'ts.cjs')}]}]}});compiler.run((error,stats)=>compiler.close(close=>error||close||stats.hasErrors()?reject(error||close||Error(stats.toString({all:false,errors:true}))):resolve()));});
    server = createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(readFileSync(path.join(scratch,'bundle.js')));return;}res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial}button{min-height:30px}textarea{width:90%;min-height:100px}.page-shell{position:relative;background:white}.char-bottom-bar{position:relative}.char-canvas{height:500px}.char-polaroid{width:130px;height:170px}.char-polaroid-img-wrapper{height:130px}output{display:block;position:fixed;bottom:0;background:white;padding:8px;z-index:99999999}</style><div id="root"></div><script>window.process={env:{NODE_ENV:"development"}};</script><script src="/bundle.js"></script></html>');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const pw=process.env.FLOAT_TEST_PLAYWRIGHT?createRequire(path.join(process.env.FLOAT_TEST_PLAYWRIGHT,'package.json')):require;
    browser=await pw('playwright').chromium.launch({headless:true,...(process.env.FLOAT_TEST_BROWSER?{executablePath:process.env.FLOAT_TEST_BROWSER}:{})});
    const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',e=>{errors.push(e.message);console.error('Character browser error:',e.message);});
    const origin='http://127.0.0.1:'+server.address().port;await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await page.goto(origin);await page.getByRole('button',{name:'CREATE',exact:true}).click();await page.getByRole('button',{name:'正方',exact:true}).click();
    await page.getByPlaceholder('Name or Codename').fill('合成测试角色');await page.getByPlaceholder('Describe background, personality...').fill('合成人设；保存不调用模型。');
    await page.evaluate(()=>{window.__failSave=true;});await page.getByRole('button',{name:'保存角色／助手',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'角色未能保存到本机'}).waitFor();assert.equal(await page.getByPlaceholder('Name or Codename').inputValue(),'合成测试角色');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('ai_phone_characters_v1')||'[]').length),0);
    await page.evaluate(()=>{window.__failSave=false;});await page.getByRole('button',{name:'保存角色／助手',exact:true}).click();await page.getByTestId('notice').filter({hasText:'角色已保存'}).waitFor();
    assert.equal(await page.getByPlaceholder('Name or Codename').count(),0);
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('ai_phone_characters_v1')));assert.equal(saved.length,1);assert.equal(saved[0].name,'合成测试角色');assert.equal(saved[0].persona,'合成人设；保存不调用模型。');
    await page.reload();assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('ai_phone_characters_v1')).length),1);await page.getByText('合成测试角色',{exact:true}).first().click();await page.getByRole('button',{name:'编辑角色卡',exact:true}).waitFor();
    await page.getByRole('button',{name:'编辑角色卡',exact:true}).click();await page.getByPlaceholder('Name or Codename').fill('修改后的角色');await page.getByRole('button',{name:'保存角色／助手',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'保存角色卡',exact:true});await dialog.waitFor();await dialog.getByRole('button',{name:/覆盖/}).click();await page.getByTestId('notice').filter({hasText:'已覆盖旧版本'}).waitFor();
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('ai_phone_characters_v1'))[0].name),'修改后的角色');assert.deepEqual(errors,[]);
    console.log('Actual character editor: create immediately persists without canvas placement; failed write displays reason and keeps draft; retry succeeds once; reload and edit/overwrite persist. Fresh synthetic storage; no model/device/user data used.');
} finally {await browser?.close();if(server){const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;}}
