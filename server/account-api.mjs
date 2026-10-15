import { DEFAULT_ACCOUNT } from './accounts.mjs';
import { HttpError, resolvePollInterval, validateWebhookUrl } from './domain.mjs';

export function trustedPairingRead(request,port) {
  const origins=new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`,'http://127.0.0.1:4173','http://localhost:4173']);
  let refererOrigin;try {refererOrigin=new URL(request.headers.referer).origin;}catch{}
  const site=request.headers['sec-fetch-site'];
  return request.headers.origin?origins.has(request.headers.origin)&&(!site||site==='same-origin'):site==='same-origin'&&origins.has(refererOrigin);
}

export async function accountApi({coordinator:c,url,method,body,request,port}) {
  const path=url.pathname;
  if(Object.hasOwn(body,'accountId') && (typeof body.accountId!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.accountId)))throw new HttpError(400,'账号编号格式无效。');
  const accountId=body.accountId || DEFAULT_ACCOUNT;
  if(method==='GET' && path==='/api/state')return {value:c.state(url.searchParams.get('accountId') || 'all')};
  if(method==='GET' && path==='/api/accounts')return {value:{accounts:c.store.listAccounts().map(account=>c.publicAccount(account.id))}};
  if(method==='POST' && path==='/api/accounts')return {status:201,value:{account:await c.createAccount(body)}};
  const accountRoute=path.match(/^\/api\/accounts\/([^/]+)(?:\/(action|pairing|session\/(?:check|open)))?$/);
  if(accountRoute) {
    const id=decodeURIComponent(accountRoute[1]),action=accountRoute[2];c.account(id);
    if(!action && method==='POST')return {value:{account:c.updateAccount(id,body)}};
    if(action==='action' && method==='POST')return {value:c.accountAction(id,body.action)};
    if(action==='pairing' && method==='GET') {
      if(!trustedPairingRead(request,port))throw new HttpError(403,'配对信息只能从本机系统页面读取。');
      return {value:typeof c.broker.simplePairingInfo==='function'?c.broker.simplePairingInfo(id):c.broker.pairingInfo(id)};
    }
    if(action?.startsWith('session/') && method==='POST')return {value:await c.engine(id).sessionAction(action.endsWith('open')?'open':'check',body)};
  }
  if(path==='/api/extension/pairing' && method==='GET') {
    if(!trustedPairingRead(request,port))throw new HttpError(403,'配对信息只能从本机系统页面读取。');
    return {value:c.broker.pairingInfo(DEFAULT_ACCOUNT)};
  }
  if(method==='POST' && path==='/api/tasks')return {status:201,value:c.createTask(body)};
  const taskAction=path.match(/^\/api\/tasks\/([^/]+)\/action$/);
  if(method==='POST' && taskAction) {
    const id=decodeURIComponent(taskAction[1]);
    return {value:await c.taskEngine(id,accountId).taskAction(id,body.action,body)};
  }
  const taskRoute=path.match(/^\/api\/tasks\/([^/]+)$/);
  if(method==='DELETE' && taskRoute) {
    const id=decodeURIComponent(taskRoute[1]);c.taskEngine(id,accountId).deleteTask(id);return {value:{ok:true}};
  }
  if(method==='POST' && path==='/api/records/clear')return {value:c.clearRecords(body.kind,accountId)};
  if(method==='POST' && path==='/api/engine/action')return {value:c.engineAction(body.action,body.accountId || 'all')};
  if(method==='POST' && path==='/api/restaurants/resolve')return {value:await c.engine(accountId).restaurantResolve(body.restaurantUrl)};
  if(method==='POST' && ['/api/session/open','/api/session/check'].includes(path))return {value:await c.engine(accountId).sessionAction(path.endsWith('open')?'open':'check',body)};
  if(method==='POST' && path==='/api/demo/run')return {value:await c.engine(accountId).runDemo()};
  if(method==='POST' && path==='/api/settings') {
    const changes={};
    if(Object.hasOwn(body,'pollIntervalMs') || Object.hasOwn(body,'pollIntervalSeconds'))changes.pollIntervalMs=resolvePollInterval(body);
    if(body.webhookUrl!==undefined)changes.webhookUrl=(await validateWebhookUrl(body.webhookUrl)).url;
    if(body.applyToExistingTasks!==undefined && typeof body.applyToExistingTasks!=='boolean')throw new HttpError(400,'applyToExistingTasks 须为布尔值。');
    // The old endpoint's contact/browser controls always refer to the default
    // account. They never follow the dashboard's current visual selection.
    const legacyKeys=['bookingName','bookingPhoneCountryCode','bookingPhoneNumber','bookingPhoneAutoFill'];
    if(legacyKeys.some(key=>Object.hasOwn(body,key)))c.updateAccount(DEFAULT_ACCOUNT,body);
    if(body.browserIntegration!==undefined)await c.engine(DEFAULT_ACCOUNT).changeIntegration(body.browserIntegration);
    if(body.browserChannel!==undefined)await c.engine(DEFAULT_ACCOUNT).changeBrowser(body.browserChannel);
    c.store.saveSettings(changes);
    if(body.applyToExistingTasks && changes.pollIntervalMs!==undefined)for(const account of c.store.listAccounts())c.engine(account.id).updateSettings({pollIntervalMs:changes.pollIntervalMs},{applyToExistingTasks:true});
    return {value:{settings:c.store.settings()}};
  }
  return null;
}
