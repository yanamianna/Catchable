import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CatchtableAdapter } from '../server/catchtable.mjs';

const accountUrl='https://www.catchtable.net/zh-CN/my/myMain';
const userUrl='https://api.catchtable.net/api/v5/user/info?localeCode=zh-CN';

class ProfilePage extends EventEmitter {
  constructor(context){super();this.context=context;this.address='about:blank';this.closed=false;this.frame={};}
  isClosed(){return this.closed;}
  mainFrame(){return this.frame;}
  url(){return this.address;}
  waitForResponse(){assert.fail('persistent page waits must be cancellable');}
  async bringToFront(){this.context.activations++;}
  async close(){this.closed=true;this.emit('close');}
  async evaluate(){this.context.domReads++;return {url:this.address,text:this.context.snapshotText || 'Cached nickname',loading:false,accountEvidence:{kind:'profile',label:'Cached nickname'}};}
  async goto(url){
    this.context.navigations++;this.address=url;
    const documentRequest={url:()=>url,method:()=> 'GET',isNavigationRequest:()=>true,frame:()=>this.frame};
    this.emit('request',documentRequest);
    const request={url:()=>userUrl,method:()=> 'GET',isNavigationRequest:()=>false,frame:()=>this.frame};
    this.emit('request',request);this.context.accountReads++;
    this.emit('response',{url:()=>userUrl,request:()=>request,status:()=>this.context.httpStatus,finished:async()=>null,json:async()=>this.context.identity?{isLogin:true,ctUserIdentifier:this.context.identity,displayName:'Synthetic fixture account'}:{isLogin:false}});
    if(url.endsWith('/my-dining/scheduled'))this.emit('response',{url:()=> 'https://api.catchtable.net/api/v6/my-dining/scheduled?page=0&size=10',status:()=>200,finished:async()=>null,json:async()=>({hasNext:false,list:[]})});
  }
}
class ProfileContext extends EventEmitter {
  constructor(){super();this.created=[];this.identity='synthetic-original-user';this.httpStatus=200;this.activations=0;this.navigations=0;this.accountReads=0;this.domReads=0;}
  pages(){return this.created.filter(page=>!page.isClosed());}
  async newPage(){const page=new ProfilePage(this);this.created.push(page);this.emit('page',page);return page;}
  async close(){for(const page of this.pages())await page.close();this.emit('close');}
}

test('repeated manual login checks reuse a separately created verification page and keep fresh official identity checks',async()=>{
  const context=new ProfileContext();let boundIdentity;
  const adapter=new CatchtableAdapter({identityVerifier:async fingerprint=>{
    if(boundIdentity && boundIdentity!==fingerprint)throw Object.assign(new Error('Synthetic identity changed'),{code:'IDENTITY_MISMATCH'});
    boundIdentity=fingerprint;
  }});
  adapter.context=context;
  try {
    for(let index=0;index<3;index++) {
      const session=await adapter.getSessionStatus();
      assert.equal(session.status,'authenticated');assert.equal(session.newTabVerified,true);
      assert.equal(context.created.length,2,'the account page and independent probe are created once');
      assert.equal(context.accountReads,(index+1)*2,'both pages obtain new official responses');
    }
    assert.equal(context.activations,0);assert.equal(adapter.sessionPage.url(),accountUrl);
    const probe=adapter.readOnlyPages.get('shared').page;
    assert.notEqual(probe,adapter.sessionPage);assert.equal(probe.listenerCount('close'),0);
    const baseline={pages:context.created.length,accountReads:context.accountReads,domReads:context.domReads};
    assert.equal((await adapter.observeSession()).status,'authenticated');
    assert.equal(context.created.length,baseline.pages);assert.equal(context.accountReads,baseline.accountReads);
    assert.equal(context.domReads-baseline.domReads,0,'routine health uses official response state without reading rendered text');
    assert.equal(context.domReads,0);
    context.identity='synthetic-different-user';
    assert.equal((await adapter.getSessionStatus()).status,'identity_mismatch');
    assert.equal(context.created.length,2);assert.equal(adapter.lastSession.connected,false);
  }finally {await adapter.close();}
  assert.equal(context.pages().length,0);assert.equal(adapter.readOnlyPages.size,0);
});

test('official guest, denied and navigation-reset states remain fail-closed without DOM reads',async()=>{
  for(const [httpStatus,identity,expected] of [[200,null,'unauthenticated'],[401,'synthetic-original-user','unauthenticated'],[403,'synthetic-original-user','unknown']]) {
    const context=new ProfileContext();context.httpStatus=httpStatus;context.identity=identity;
    const adapter=new CatchtableAdapter({identityVerifier:async()=>{}});adapter.context=context;
    try {const session=await adapter.getSessionStatus();assert.equal(session.status,expected);assert.equal(session.connected,false);assert.equal(context.domReads,0);}
    finally {await adapter.close();}
  }
  const context=new ProfileContext();const adapter=new CatchtableAdapter({identityVerifier:async()=>{}});adapter.context=context;
  try {
    assert.equal((await adapter.getSessionStatus()).status,'authenticated');
    const page=adapter.sessionPage;
    page.emit('request',{url:()=>accountUrl,method:()=> 'GET',isNavigationRequest:()=>true,frame:()=>page.mainFrame()});
    const session=await adapter.observeSession();assert.equal(session.status,'unknown');assert.equal(session.connected,false);assert.equal(context.domReads,0);
  }finally {await adapter.close();}
});

test('a dedicated OAuth rejection still reads the external login page and classifies its error text',async()=>{
  const context=new ProfileContext();context.snapshotText='This browser or app may not be secure';
  const page=await context.newPage();page.address='https://accounts.google.com/signin/v2/identifier';
  const adapter=new CatchtableAdapter();adapter.context=context;
  try {
    const session=await adapter.getSessionStatus();assert.equal(session.status,'oauth_blocked');assert.equal(session.connected,false);
    assert.equal(context.domReads,1);assert.equal(context.accountReads,0);assert.equal(context.created.length,1);
  }finally {await adapter.close();}
});

test('closing a verification page or replacing the browser context requires a new independent page',async()=>{
  const first=new ProfileContext(),second=new ProfileContext();const adapter=new CatchtableAdapter();adapter.context=first;
  try {
    assert.equal((await adapter.getSessionStatus()).newTabVerified,true);
    await adapter.readOnlyPages.get('shared').page.close();
    assert.equal((await adapter.getSessionStatus()).newTabVerified,true);assert.equal(first.created.length,3);
    const oldProbe=adapter.readOnlyPages.get('shared').page;
    adapter.context=second;adapter.sessionPage=null;adapter.newTabAuth=null;
    assert.equal((await adapter.getSessionStatus()).newTabVerified,true);
    assert.equal(second.created.length,2);assert.equal(second.accountReads,2);
    assert.equal(oldProbe.isClosed(),true);assert.equal(adapter.readOnlyPages.get('shared').context,second);
  }finally {await adapter.close();await first.close();}
});

test('login verification and order reconciliation share one independently authenticated read-only helper',async()=>{
  const context=new ProfileContext();const adapter=new CatchtableAdapter({identityVerifier:async()=>{}});adapter.context=context;
  const task={id:'shared-page-task',restaurantName:'Synthetic fixture restaurant',restaurantUrl:'https://www.catchtable.net/shop/fixture',dates:['2030-01-02'],partySize:2,timeStart:'13:00',timeEnd:'14:00',mode:'auto',autoConsent:true};
  try {
    assert.equal((await adapter.getSessionStatus()).newTabVerified,true);
    const helper=adapter.readOnlyPages.get('shared').page;
    const reconciled=await adapter.reconcile({id:'shared-attempt',taskSnapshot:task,slot:{date:'2030-01-02',time:'13:00',partySize:2},status:'user_action_required',phase:'before_submit',submitted:false});
    assert.equal(reconciled.resumeAllowed,true);assert.equal(adapter.readOnlyPages.get('shared').role,'orders');
    assert.equal(adapter.readOnlyPages.get('shared').page,helper);assert.equal(context.created.length,2);
    assert.equal((await adapter.getSessionStatus()).newTabVerified,true);
    assert.equal(adapter.readOnlyPages.get('shared').role,'verification');assert.equal(adapter.readOnlyPages.get('shared').page,helper);
    assert.equal(context.created.length,2);assert.equal(context.accountReads,5);assert.equal(context.activations,0);
    assert.equal(adapter.readOnlyPages.size,1);
  }finally {await adapter.close();}
});
