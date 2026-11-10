import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir='android-shell/app/src/main/java/app/floatphone/shell/';
const read=name=>readFileSync(path.join(root,name),'utf8'),main=read(dir+'MainActivity.kt'),auth=read(dir+'SiteHttpAuth.kt');
assert.match(main,/override fun onReceivedHttpAuthRequest[\s\S]{0,300}siteHttpAuth\?\.challenge/);
assert.match(main,/override fun shouldInterceptRequest[\s\S]{0,240}siteHttpAuth\?\.resource/);
assert.match(main,/response.statusCode == 401 && siteHttpAuth\?\.authenticationFailure/);
assert.match(main,/override fun onDestroy\(\)[\s\S]{0,150}siteHttpAuth\?\.close/);
assert.match(main,/siteHttpAuth\?\.started\(url\)/);assert.match(main,/siteHttpAuth\?\.navigationRequested\(\)/);
const loader=main.match(/private fun loadMainPage\(url: String\) \{([\s\S]*?)\n    \}/)?.[1];
assert.ok(loader && loader.indexOf('siteHttpAuth?.requested(url)') < loader.indexOf('webView.loadUrl(url)'));
assert.equal((main.match(/webView\.loadUrl\(/g)||[]).length,1,'Every native main-frame load must use the pre-armed loader');
assert.match(main,/loadMainPage\(consumeOpenUrl\(intent\) \?: SITE_URL\)/);
assert.match(main,/loadMainPage\(target\)/);
assert.match(main,/siteHttpAuth\?\.requested\(url.toString\(\)\)/);
assert.match(auth,/policy\.started\(url.orEmpty\(\)\)/);
assert.match(auth,/policy\.submit\(value.epoch, host, view.url\)/);assert.match(auth,/handler.proceed\(user, pass\)/);
assert.match(auth,/if \(!value.settled\)[\s\S]{0,100}value.handler.cancel\(\)/);
assert.match(auth,/TYPE_TEXT_VARIATION_PASSWORD/);assert.match(auth,/FLAG_SECURE/);assert.match(auth,/IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS/);
assert.match(auth,/username\?\.text\?\.clear\(\)/);assert.match(auth,/password\?\.text\?\.clear\(\)/);
assert.ok(!/getHttpAuthUsernamePassword\s*\(|setHttpAuthUsernamePassword\s*\(|getSharedPreferences\(|evaluateJavascript\(|loadUrl\(|Log\.[a-z]\(|writeText\(/.test(auth));
assert.match(auth,/pending == null && policy.belongs\(epoch\)/);
if(process.argv.includes('--compile-policy')){
 const home=process.env.FLOAT_TEST_JAVA_HOME||process.env.JAVA_HOME;assert.ok(home,'Use task-local JDK');
 const work=path.resolve(process.env.FLOAT_TEST_WORK_DIR||path.join(root,'work'));mkdirSync(work,{recursive:true});const out=mkdtempSync(path.join(work,'http-auth-policy-')),exe=process.platform==='win32'?'.exe':'';
 const compiled=spawnSync(path.join(home,'bin','javac'+exe),['-encoding','UTF-8','-d',out,path.join(root,dir+'SiteHttpAuthPolicy.java'),path.join(root,'android-shell/policy-test/SiteHttpAuthPolicyTest.java')],{encoding:'utf8',windowsHide:true});assert.equal(compiled.status,0,compiled.stderr);
 const result=spawnSync(path.join(home,'bin','java'+exe),['-cp',out,'SiteHttpAuthPolicyTest'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);process.stdout.write(result.stdout);
}
const saved=read(dir+'SiteCredentialStore.kt');
assert.match(saved,/AndroidKeyStore/);assert.match(saved,/SiteCredentialCodec.encrypt/);assert.match(saved,/setRandomizedEncryptionRequired\(true\)/);
assert.ok(!/getEncoded\(|evaluateJavascript|@JavascriptInterface|Log\.[a-z]\(/.test(saved));
assert.match(auth,/candidate.epoch == epoch && candidate.remember && !candidate.automatic/);
assert.match(auth,/if \(complete\)[\s\S]{0,500}saved.save/);
assert.match(auth,/automaticEpoch != policy.epoch\(\) && previous == null/);
assert.match(auth,/if \(previous.automatic\) saved.reject\(previous.realm\)/);
assert.match(main,/challenge\(view, handler, host, realm\)/);
assert.match(main,/fun getRememberedSiteLoginStatus\(\)/);assert.match(main,/fun forgetRememberedSiteLogin\(\)/);
if(process.argv.includes('--compile-policy')) {
 const home=process.env.FLOAT_TEST_JAVA_HOME||process.env.JAVA_HOME,work=path.resolve(process.env.FLOAT_TEST_WORK_DIR||path.join(root,'work')),out=mkdtempSync(path.join(work,'saved-login-')),exe=process.platform==='win32'?'.exe':'';
 const compiled=spawnSync(path.join(home,'bin','javac'+exe),['-encoding','UTF-8','-d',out,path.join(root,dir+'SiteCredentialCodec.java'),path.join(root,'android-shell/policy-test/SiteCredentialCodecTest.java')],{encoding:'utf8',windowsHide:true});assert.equal(compiled.status,0,compiled.stderr);
 const result=spawnSync(path.join(home,'bin','java'+exe),['-cp',out,'SiteCredentialCodecTest'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);process.stdout.write(result.stdout);
}
console.log('Primary WebView auth fences, save-after-success, encrypted native remembering, one automatic attempt and manual fallback wiring passed; real Android restart/login remains unverified.');
