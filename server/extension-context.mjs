import {EventEmitter} from 'node:events';

// Connect to the extension's ordinary Chrome profile, but expose only tabs
// created by this controller. Closing this facade never closes personal tabs
// or the browser's default context.
export async function connectExtensionContext({bridge,browserType} = {}) {
  if(!bridge?.state().connected)throw new Error('Chrome 扩展尚未连接。请在平常使用的 Chrome 中加载扩展并完成本机配对。');
  const chromium=browserType || (await import('playwright')).chromium;
  let browser;
  try {browser=await chromium.connectOverCDP(await bridge.getCdpEndpoint(),{noDefaults:true,timeout:15000});}
  catch {throw new Error('扩展页面连接未完成。请检查 Chrome 中的扩展与调试连接，再重新核验；本次没有启动专用浏览器。');}
  const context=browser.contexts()[0];
  if(!context){await browser.close();throw new Error('扩展没有提供当前 Chrome 的普通浏览器会话。');}
  const events=new EventEmitter();
  const owned=new Set();
  let timeout=10000;
  let closed=false;
  browser.on('disconnected',()=>{
    if(closed)return;
    closed=true;owned.clear();events.emit('close');
  });
  return {
    pages:()=>[...owned].filter(page=>!page.isClosed()),
    on:(event,listener)=>{events.on(event,listener);},
    setDefaultTimeout:value=>{timeout=value;for(const page of owned)page.setDefaultTimeout(value);},
    newPage:async()=>{
      if(closed)throw new Error('Chrome 扩展连接已断开，请重新核验连接。');
      const page=await context.newPage();owned.add(page);page.setDefaultTimeout(timeout);
      page.on('close',()=>owned.delete(page));events.emit('page',page);return page;
    },
    close:async()=>{
      if(closed)return;
      closed=true;
      await Promise.allSettled([...owned].map(page=>page.close()));owned.clear();
      // connectOverCDP's Browser.close disconnects its transport. It does not
      // call the default BrowserContext.close or terminate ordinary Chrome.
      await browser.close();events.emit('close');
    },
  };
}
