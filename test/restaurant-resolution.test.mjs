import test from 'node:test';
import assert from 'node:assert/strict';
import { CatchtableAdapter } from '../server/catchtable.mjs';

const restaurantUrl='https://www.catchtable.net/zh-CN/shop/mongtan_jeju';
const snapshot={url:restaurantUrl,canonicalUrl:restaurantUrl,headings:[{level:2,text:'Mongtan Jeju'}],jsonLd:[]};

function pageFixture({failure,status=200,details=false,invalid=false}={}) {
  const visits=[];
  let closes=0;
  const page={
    goto:async url=>{visits.push(url);if(failure)throw failure;return {status:()=>status};},
    locator:()=>({first:()=>({waitFor:async()=>{}})}),
    evaluate:async()=>visits.at(-1)?.endsWith('/info')
      ?{url:`${restaurantUrl}/info`,restaurantName:'Mongtan Jeju',address:'Fixture address, Jeju',bookingNotes:[]}
      :{...snapshot,...(details?{informationLink:`${restaurantUrl}/info`}:{}),...(invalid?{url:'https://www.catchtable.net/shop/another'}:{})},
    close:async()=>{closes+=1;},
  };
  return {page,visits,get closes(){return closes;}};
}

test('connected account restaurant lookup uses its own Chrome connection and closes only the new page',async()=>{
  const lookup=pageFixture({details:true});
  const sessionPage={isClosed:()=>false};
  const watchPage={isClosed:()=>false};
  const bookingPage={isClosed:()=>false};
  let contextCloses=0,publicLaunches=0,accountLaunches=0;
  const bridge={state:()=>({connected:true})};
  const context={
    pages:()=>[sessionPage,watchPage,bookingPage],on:()=>{},setDefaultTimeout:()=>{},
    newPage:async()=>lookup.page,close:async()=>{contextCloses+=1;},
    route:async()=>{throw new Error('Shared extension context must not enable Fetch interception');},
  };
  const adapter=new CatchtableAdapter({extensionBridge:bridge,
    contextFactory:async options=>{accountLaunches+=1;assert.equal(options.bridge,bridge);assert.equal(options.browserIntegration,'extension');return context;},
    publicContextFactory:async()=>{publicLaunches+=1;throw new Error('Unexpected anonymous launch');},
  });
  adapter.sessionPage=sessionPage;adapter.watchPages.set('watch-task',watchPage);adapter.bookingPages.set('booking-task',bookingPage);
  const resolved=await adapter.resolveRestaurant(restaurantUrl);
  assert.equal(resolved.restaurantName,'Mongtan Jeju');
  assert.equal(resolved.address,'Fixture address, Jeju');
  assert.deepEqual(lookup.visits,[restaurantUrl,`${restaurantUrl}/info`]);
  assert.equal(accountLaunches,1);assert.equal(publicLaunches,0);
  assert.equal(contextCloses,0);assert.equal(lookup.closes,1);
  assert.equal(adapter.context,context);assert.equal(adapter.sessionPage,sessionPage);
  assert.equal(adapter.watchPages.get('watch-task'),watchPage);assert.equal(adapter.bookingPages.get('booking-task'),bookingPage);
});

test('restaurant navigation and mismatched-page failures preserve the account connection and other pages',async()=>{
  for(const options of [{failure:new Error('net::ERR_NETWORK_ACCESS_DENIED')},{invalid:true}]) {
    const lookup=pageFixture(options);
    let contextCloses=0,newPages=0;
    const context={newPage:async()=>{newPages+=1;return lookup.page;},close:async()=>{contextCloses+=1;}};
    const adapter=new CatchtableAdapter({extensionBridge:{state:()=>({connected:true})}});
    adapter.context=context;
    const watch={};adapter.watchPages.set('unchanged',watch);
    await assert.rejects(()=>adapter.resolveRestaurant(restaurantUrl),error=>error.status===502);
    assert.equal(newPages,1);assert.equal(lookup.closes,1);assert.equal(contextCloses,0);
    assert.equal(adapter.context,context);assert.equal(adapter.watchPages.get('unchanged'),watch);
  }
});

test('a disconnected extension keeps the independent public fallback and never closes a stale account context',async()=>{
  const lookup=pageFixture();let publicCloses=0,publicLaunches=0;
  const adapter=new CatchtableAdapter({extensionBridge:{state:()=>({connected:false})},
    publicContextFactory:async()=>{publicLaunches+=1;return {newPage:async()=>lookup.page,close:async()=>{publicCloses+=1;}};},
    contextFactory:async()=>{throw new Error('Disconnected account must not be launched');},
  });
  const stale={newPage:async()=>{throw new Error('Stale account must not be used');},close:async()=>{throw new Error('Stale account must not be closed');}};
  adapter.context=stale;
  assert.equal((await adapter.resolveRestaurant(restaurantUrl)).restaurantName,'Mongtan Jeju');
  assert.equal(publicLaunches,1);assert.equal(publicCloses,1);assert.equal(adapter.context,stale);
});

test('HTTP error pages cannot supply a verified restaurant name even when their URL and heading match',async()=>{
  for(const status of [404,403,503]) {
    const lookup=pageFixture({status});
    const context={newPage:async()=>lookup.page,close:async()=>{throw new Error('Must keep shared context');}};
    const adapter=new CatchtableAdapter({extensionBridge:{state:()=>({connected:true})}});adapter.context=context;
    await assert.rejects(()=>adapter.resolveRestaurant(restaurantUrl),error=>error.status===502 && (status===404?/没有找到/.test(error.message):error.message.includes(String(status))));
    assert.equal(lookup.closes,1);assert.equal(adapter.context,context);
  }
});

test('an unavailable connected account transport fails visibly instead of silently using another browser',async()=>{
  let publicLaunches=0;
  const adapter=new CatchtableAdapter({extensionBridge:{state:()=>({connected:true})},
    contextFactory:async()=>{throw new Error('Chrome transport unavailable');},
    publicContextFactory:async()=>{publicLaunches+=1;throw new Error('Wrong browser');},
  });
  await assert.rejects(()=>adapter.resolveRestaurant(restaurantUrl),error=>error.status===502);
  assert.equal(publicLaunches,0);
});
