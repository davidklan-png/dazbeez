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
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const report=[];
for(const width of [375,1024]){
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
}
fs.writeFileSync(path.join(artifacts, "results.json"),JSON.stringify(report,null,2));
console.log("PASS: two-tab receipt, roster, inline category, sealed refresh, synthetic IME at 375/1024", artifacts);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
