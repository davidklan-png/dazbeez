/* eslint-disable @typescript-eslint/no-require-imports -- standalone Node verifier */
// Manual synthetic browser gate; NODE_PATH may point at an external playwright-core.
// Run after build:cf. Only the test HTTP server is mutated; no app/API auth bypass.
const { chromium } = require("playwright-core");
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { createServer } = require("node:http");
const assert = require("node:assert/strict");

async function main() {
const artifacts = fs.mkdtempSync(path.join(tmpdir(), "receipt-revision-browser-"));
esbuild.buildSync({ entryPoints: ["tests/receipts/fixture/revision.tsx"], bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: path.join(artifacts, "app.js"), alias: {
  "next/navigation": path.resolve("tests/receipts/fixture/nav-shim.ts"),
  "next/link": path.resolve("tests/receipts/fixture/link-shim.tsx"),
}, define: { "process.env.NODE_ENV": '"production"' } });
const cssFiles = fs.readdirSync(".next/static", { recursive: true }).filter(f => f.endsWith(".css"));
assert.ok(cssFiles.length, "Build the current app styles first");
fs.writeFileSync(path.join(artifacts, "app.css"), cssFiles.map(f => fs.readFileSync(path.join(".next/static",f),"utf8")).join("\n"));
fs.writeFileSync(path.join(artifacts,"index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Receipt revision synthetic fixture</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
let state={revision:0,merchant:'Original'}, log=[], delay=0;
const server=createServer(async(req,res)=>{
 const send=(body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body))};
 if(req.url==='/reset'){state={revision:0,merchant:'Original'};log=[];delay=0;return send(state)}
 if(req.url==='/slow'){delay=900;return send({ok:true})}
 if(req.url==='/state')return send({...state,log});
 if(req.url==='/api/receipts/attendee-directory')return send({entries:[]});
 if(req.url==='/api/receipts/r1'){
  let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);log.push({method:req.method,body});
  if(delay)await new Promise(r=>setTimeout(r,delay));
  if(body.expectedRevision!==state.revision)return send({code:'receipt_revision_conflict',error:'Receipt changed elsewhere.'},409);
  state={...state,...body,revision:state.revision+1};return send({ok:true,revision:state.revision,warnings:[]});
 }
 const file=req.url==='/'?'index.html':req.url.slice(1);
 if(!['index.html','app.js','app.css'].includes(file)){res.writeHead(404);return res.end()}
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(artifacts,file)));
});
const pendingResponses=[];
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const report=[];
for(const width of [375,1024]){
 // Clean/idle composition clears the debounce: it must still protect tab close.
 const imeContext=await browser.newContext({viewport:{width,height:1000}});
 const ime=await imeContext.newPage();
 await ime.request.get(base+'/reset');await ime.goto(base);
 const composing=ime.locator('label').filter({hasText:'Business purpose'}).locator('..').locator('input');
 await composing.dispatchEvent('compositionstart',{data:'に'});
 await composing.fill('日本語の未確定入力');
 await ime.waitForTimeout(550);
 assert.equal((await ime.request.get(base+'/state').then(r=>r.json())).log.length,0);
 assert.equal(await ime.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented}),true,'idle IME composition must block unload');
 await composing.dispatchEvent('compositionend',{data:'日本語の未確定入力'});
 await ime.waitForTimeout(650);
 assert.equal((await ime.request.get(base+'/state').then(r=>r.json())).businessPurpose,'日本語の未確定入力');
 await imeContext.close();
 const context=await browser.newContext({viewport:{width,height:1000}});
 const a=await context.newPage(),b=await context.newPage();
 a.setDefaultTimeout(7000); b.setDefaultTimeout(7000);
 const getState=()=>a.request.get(base + '/state').then(r=>r.json());
 await a.request.get(base + '/reset');
 await Promise.all([a.goto(base + ''),b.goto(base + '')]);

 // Fields use the existing Field's visible label as their container label.
 const input=(p,label)=>p.locator('label').filter({hasText:label}).locator('..').locator('input').first();

 await input(a,'Merchant').fill('Winner');
 await a.waitForTimeout(650);
 assert.equal((await getState()).merchant,'Winner');
 await input(b,'Merchant').fill('私の未保存ドラフト');
 await b.locator('button').filter({hasText:'Add attendee'}).click();
 await b.getByPlaceholder('Attendee name').fill('未保存の参加者');
 await b.waitForTimeout(650);
 await b.getByRole('button',{name:'Reload and review'}).waitFor();
 assert.equal(await input(b,'Merchant').inputValue(),'私の未保存ドラフト');
 const before=(await getState()).log.length;
 await input(b,'Merchant').fill('さらに編集');await b.waitForTimeout(650);
 assert.equal((await getState()).log.length,before);
 await b.locator('#refresh-props').click();
 assert.equal(await input(b,'Merchant').inputValue(),'さらに編集');
 assert.equal(await b.getByPlaceholder('Attendee name').inputValue(),'未保存の参加者');
 b.once('dialog',d=>d.dismiss());await b.getByRole('button',{name:'Reload and review'}).click();
 assert.equal(await input(b,'Merchant').inputValue(),'さらに編集');
 await b.locator('#seal-props').click();
 assert.equal(await input(b,'Merchant').inputValue(),'さらに編集');
 assert.equal(await input(b,'Merchant').isDisabled(),true);
 await b.getByRole('button',{name:'Reload and review'}).waitFor();
 const pushes=await b.evaluate(()=>window.fixtureNavigation.length);
 await b.getByRole('link',{name:'Go to export'}).click();
 assert.equal(await b.evaluate(()=>window.fixtureNavigation.length),pushes);
 assert.equal(await input(b,'Merchant').inputValue(),'さらに編集');
 assert.equal(await b.evaluate(() => { const e = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; }),true);
 await b.screenshot({path:`${artifacts}/conflict-${width}.png`,fullPage:true});
 // A slow acknowledgement must not include uncommitted synthetic IME text.
 await a.request.get(base + '/slow');
 await input(a,'Merchant').fill('Slow first');await a.waitForTimeout(550);
 const purpose=input(a,'Business purpose');
 await purpose.dispatchEvent('compositionstart',{data:'に'});
 await purpose.fill('日本語の目的');
 await purpose.dispatchEvent('input',{inputType:'insertCompositionText',data:'日本語の目的',isComposing:true});
 await a.waitForTimeout(1100);
 assert.equal((await getState()).log.length,before+1);
 await purpose.dispatchEvent('compositionend',{data:'日本語の目的'});
 await a.waitForTimeout(1600);
 const state=await getState();
 assert.equal(state.businessPurpose,'日本語の目的');
 const aSaves=state.log.filter(r=>r.body.merchant==='Slow first');
 assert.equal(aSaves.length,2);
 assert.equal(aSaves[1].body.expectedRevision,aSaves[0].body.expectedRevision+1);
 await a.screenshot({path:`${artifacts}/ime-${width}.png`,fullPage:true});
 report.push({width,twoTabs:'pass',draftOnConflict:'pass',refreshPreservesDraft:'pass',reloadCancelPreservesDraft:'pass',conflictStopsRequests:'pass',slowNetworkAndSyntheticIME:'pass',state});
 await context.close();
 // Exercise the real inline receipt category caller in two independent tabs.
 const inlineContext=await browser.newContext({viewport:{width,height:1000}});
 const c=await inlineContext.newPage(),d=await inlineContext.newPage();
 c.setDefaultTimeout(7000);d.setDefaultTimeout(7000);
 await c.request.get(base + '/reset');
 await Promise.all([c.goto(base + '/#inline'),d.goto(base + '/#inline')]);
 await c.locator('select').selectOption('communications');
 await c.waitForTimeout(250);
 await d.locator('select').selectOption('research_development');
 await d.getByRole('button',{name:'Reload and review'}).waitFor();
 assert.equal(await d.locator('select').inputValue(),'research_development');
 assert.equal(await d.locator('select').isDisabled(),true);
 assert.equal(await d.evaluate(() => { const e = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; }),true);
 report.at(-1).inlineCategoryConflict='pass'; report.at(-1).sealedRefreshRetainsDraft='pass';
 await d.screenshot({path:`${artifacts}/inline-${width}.png`,fullPage:true});
 await inlineContext.close();
 // Actual ReviewScreen rows: reorder while A saves, then remove A. B must retain its own queue/draft.
 const reorderContext=await browser.newContext({viewport:{width,height:1000}});
 const r=await reorderContext.newPage();r.setDefaultTimeout(7000);
 const writes=[]; const revisions={a:4,b:9};
 let finishOld;
 await r.route('**/api/receipts/*', async route => {
   const id=new URL(route.request().url()).pathname.split('/').at(-1);
   const body=route.request().postDataJSON(); writes.push({id,body});
   assert.equal(body.expectedRevision,revisions[id]);
   revisions[id]++;
   if(id==='a')await new Promise(resolve=>{finishOld=resolve;pendingResponses.push(resolve)});
   await route.fulfill({json:{ok:true,revision:revisions[id],warnings:[]}});
 });
 await r.goto(base+'/#reorder');
 await r.locator('#reverse').click();
 await r.locator('select').nth(0).selectOption('research_development');await r.waitForTimeout(100);
 assert.deepEqual(writes.map(w=>[w.id,w.body.expectedRevision]),[['b',9]],'displayed B must never PATCH unchanged A');
 await r.locator('#reverse').click();
 await r.locator('select').nth(0).selectOption('communications');
 await r.waitForFunction(()=>document.querySelector('select').disabled);
 await r.waitForTimeout(50);
 await r.locator('#reverse').click();
 assert.equal(await r.locator('select').nth(0).inputValue(),'research_development');
 await r.locator('select').nth(0).selectOption('insurance');
 await r.waitForTimeout(100);
 assert.deepEqual(writes.map(w=>[w.id,w.body.expectedRevision]),[['b',9],['a',4],['b',10]]);
 await r.locator('#remove-a').click();
 assert.equal(await r.locator('select').inputValue(),'insurance');
 const refreshes=await r.evaluate(()=>window.fixtureNavigation.length);
 finishOld();await r.waitForTimeout(150);
 assert.equal(await r.evaluate(()=>window.fixtureNavigation.length),refreshes,'unmounted A must not refresh displayed B');
 assert.equal(await r.locator('select').inputValue(),'insurance');
 await r.locator('select').selectOption('communications');await r.waitForTimeout(100);
 assert.equal(writes.at(-1).id,'b');assert.equal(writes.at(-1).body.expectedRevision,11);
 await r.screenshot({path:`${artifacts}/reorder-${width}.png`,fullPage:true});
 await reorderContext.close();
 report.at(-1).mountedReviewReorder='pass';
 // Reuse one public cell without a parent key: receipt/line/no-route transitions reset state.
 const identityContext=await browser.newContext({viewport:{width,height:1000}});
 const identity=await identityContext.newPage();identity.setDefaultTimeout(7000);
 const identityWrites=[];let finishReceipt;let finishLine;
 let bCalls=0;let lineCalls=0;
 await identity.route('**/api/receipts/**',async route=>{
   const url=new URL(route.request().url()).pathname;
   const body=route.request().postDataJSON();identityWrites.push({url,body});
   if(url==='/api/receipts/a'){
     await new Promise(resolve=>{finishReceipt=resolve;pendingResponses.push(resolve)});
     return route.fulfill({status:409,json:{code:'receipt_revision_conflict',error:'old A conflict'}});
   }
   if(url==='/api/receipts/amex/lines/b'){
     lineCalls++;const failed=lineCalls===2;
     await new Promise(resolve=>{finishLine=resolve;pendingResponses.push(resolve)});
     return route.fulfill(failed ? {status:500,json:{error:'old line failure'}} : {json:{ok:true}});
   }
   bCalls++;
   assert.equal(url,'/api/receipts/b');
   assert.equal(body.expectedRevision,bCalls===2 ? 10 : 9);
   return route.fulfill(bCalls>1 ? {status:409,json:{code:'receipt_revision_conflict',error:'B conflict'}} : {json:{ok:true,revision:10,warnings:[]}});
 });
 await identity.goto(base+'/#identity');
 await identity.locator('select').selectOption('communications');
 await identity.waitForTimeout(100);
 await identity.locator('#target-b').click();
 assert.equal(await identity.locator('select').inputValue(),'');
 assert.equal(await identity.locator('select').isDisabled(),false);
 await identity.locator('select').selectOption('research_development');await identity.waitForTimeout(100);
 assert.deepEqual(identityWrites.map(w=>[w.url,w.body.expectedRevision]),[['/api/receipts/a',4],['/api/receipts/b',9]]);
 const beforeOld=await identity.evaluate(()=>window.fixtureNavigation.length);
 finishReceipt();await identity.waitForTimeout(100);
 assert.equal(await identity.evaluate(()=>window.fixtureNavigation.length),beforeOld);
 assert.equal(await identity.getByRole('button',{name:'Reload and review'}).count(),0);
 assert.equal(await identity.locator('select').inputValue(),'research_development');
 await identity.locator('#same-target-new-token').click();
 await identity.locator('select').selectOption('communications');
 await identity.getByRole('button',{name:'Reload and review'}).waitFor();
 await identity.locator('#same-target-new-token').click();
 assert.equal(await identity.locator('select').inputValue(),'communications');
 assert.equal(await identity.locator('select').isDisabled(),true,'same-target token refresh cannot clear conflict');
 await identity.locator('#target-line').click();
 assert.equal(await identity.locator('select').inputValue(),'');
 await identity.locator('select').selectOption('insurance');await identity.waitForTimeout(100);
 assert.equal(identityWrites.at(-1).url,'/api/receipts/amex/lines/b');
 assert.equal(identityWrites.at(-1).body.expectedRevision,undefined);
 await identity.locator('#target-none').click();
 assert.equal(await identity.locator('select').inputValue(),'');
 const beforeLine=await identity.evaluate(()=>window.fixtureNavigation.length);
 finishLine();await identity.waitForTimeout(100);
 assert.equal(await identity.evaluate(()=>window.fixtureNavigation.length),beforeLine);
 assert.equal(await identity.locator('select').inputValue(),'');
 const beforeNone=identityWrites.length;
 await identity.locator('select').selectOption('supplies');await identity.waitForTimeout(100);
 assert.equal(identityWrites.length,beforeNone,'no-route cell sends nothing');
 await identity.locator('#target-b').click();
 assert.equal(await identity.locator('select').inputValue(),'');
 await identity.locator('select').selectOption('insurance');await identity.waitForTimeout(100);
 assert.equal(identityWrites.at(-1).url,'/api/receipts/b');
 assert.equal(identityWrites.at(-1).body.expectedRevision,9,'new identity mount uses its loaded token');
 await identity.getByRole('button',{name:'Reload and review'}).waitFor();
 await identity.locator('#target-line').click();
 await identity.locator('select').selectOption('insurance');await identity.waitForTimeout(100);
 await identity.locator('#target-b').click();
 assert.equal(await identity.locator('select').inputValue(),'');
 const beforeFailedLine=await identity.evaluate(()=>window.fixtureNavigation.length);
 finishLine();await identity.waitForTimeout(100);
 assert.equal(await identity.evaluate(()=>window.fixtureNavigation.length),beforeFailedLine);
 assert.equal(await identity.getByRole('button',{name:'Reload and review'}).count(),0);
 assert.equal(await identity.locator('select').isDisabled(),false,'line failure cannot leak to new receipt editor');

 await identity.screenshot({path:`${artifacts}/identity-${width}.png`,fullPage:true});
 await identityContext.close();
 report.at(-1).receiptLineNoRouteIdentity='pass';report.at(-1).idleIMEUnload='pass';


}
fs.writeFileSync(path.join(artifacts, "results.json"),JSON.stringify(report,null,2));
console.log("PASS: two-tab conflict, mounted export reorder, receipt/line/no-target identity, late results, idle/slow IME at 375/1024", artifacts);
} finally {
  for(const finish of pendingResponses)finish();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
