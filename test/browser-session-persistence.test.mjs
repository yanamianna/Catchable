import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { officialBrowserCandidates } from '../server/browser-launch.mjs';

const sessionCookie='catchable_fixture_session=synthetic-session';
const persistentCookie='catchable_fixture_persistent=synthetic-persistent';

async function installed(channel) {
  for(const candidate of officialBrowserCandidates(process.env,channel)) {
    try {await access(candidate.path);return true;}catch{}
  }
  return false;
}

async function fixtureServer() {
  const observed=new Map();
  const server=createServer((request,response)=>{
    const url=new URL(request.url,'http://127.0.0.1');
    if(url.pathname==='/login')response.setHeader('Set-Cookie',[
      `${sessionCookie}; Path=/; HttpOnly; SameSite=Lax`,
      `${persistentCookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
    ]);
    if(url.pathname==='/observe')observed.set(url.searchParams.get('stage'),request.headers.cookie || '');
    response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    response.end('<!doctype html><html><head><title>Local synthetic cookie fixture</title></head><body><p>Only invented local fixture state.</p></body></html>');
  });
  await new Promise((done,failed)=>{server.once('error',failed);server.listen(0,'127.0.0.1',done);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  return {origin,observed,close:()=>new Promise(done=>server.close(done))};
}

async function persistenceCase(channel,restore,t) {
  const fixture=await fixtureServer();
  const root=await mkdtemp(join(tmpdir(),'catchable-session-fixture-'));
  const profile=resolve(root,'profile');
  let context;
  const launch=async()=>{
    context=await chromium.launchPersistentContext(profile,{channel,headless:true,args:restore?['--restore-last-session']:[]});
    await context.route('**/*',route=>{
      try {return new URL(route.request().url()).origin===fixture.origin?route.continue():route.abort('blockedbyclient');}
      catch {return route.abort('blockedbyclient');}
    });
    return context.pages()[0] || await context.newPage();
  };
  try {
    let page=await launch();
    await page.goto(`${fixture.origin}/login`,{waitUntil:'load',timeout:10000});
    await page.goto(`${fixture.origin}/observe?stage=before`,{waitUntil:'load',timeout:10000});
    assert.ok(fixture.observed.get('before')?.includes(sessionCookie));
    assert.ok(fixture.observed.get('before')?.includes(persistentCookie));
    await context.close();context=null;
    page=await launch();
    await page.goto(`${fixture.origin}/observe?stage=after`,{waitUntil:'load',timeout:10000});
    const cookies=fixture.observed.get('after') || '';
    const sessionRetained=cookies.includes(sessionCookie);
    const persistentRetained=cookies.includes(persistentCookie);
    assert.equal(persistentRetained,true,'the persistent fixture cookie is the control for reusing the same fresh profile');
    t.diagnostic(JSON.stringify({channel,restoreLastSession:restore,sessionRetained,persistentRetained}));
    return {sessionRetained,persistentRetained};
  }finally {
    if(context)await context.close();
    await fixture.close();
    const tempRoot=resolve(tmpdir());
    const absolute=resolve(root);
    assert.ok(absolute.startsWith(`${tempRoot}${sep}`) && absolute.split(sep).at(-1).startsWith('catchable-session-fixture-'));
    assert.equal(profile,resolve(absolute,'profile'));
    // Remove only this test's mkdtemp result, after both browser instances close.
    await rm(absolute,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}

for(const channel of ['chrome','msedge']) {
  test(`${channel}: isolated session-cookie persistence across a normal close and restart`,{timeout:120000},async t=>{
    if(!await installed(channel)){t.skip(`Official ${channel} installation is unavailable.`);return;}
    const baseline=await persistenceCase(channel,false,t);
    const restored=await persistenceCase(channel,true,t);
    assert.equal(restored.sessionRetained,true,'restore-last-session must preserve the local synthetic session cookie');
    t.diagnostic(JSON.stringify({channel,baselineSessionRetained:baseline.sessionRetained,restoreSessionRetained:restored.sessionRetained,improved:!baseline.sessionRetained && restored.sessionRetained}));
  });
}
