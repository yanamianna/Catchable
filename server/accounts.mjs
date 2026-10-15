import { join } from 'node:path';
import os from 'node:os';
import { Engine } from './engine.mjs';
import { CatchtableAdapter } from './catchtable.mjs';
import { HttpError, TASK_LIMIT, createTask, localDate } from './domain.mjs';

export const DEFAULT_ACCOUNT = 'default';
const CONTACT_KEYS=['bookingName','bookingPhoneCountryCode','bookingPhoneNumber','bookingPhoneAutoFill'];
function inputSettings(input) {
  return Object.fromEntries([...CONTACT_KEYS,'pollIntervalMs'].filter(key=>Object.hasOwn(input,key)).map(key=>[key,input[key]]));
}
function noPrivateFields(value) {
  const {identityFingerprint,accountIdentityFingerprint,contactSnapshot,taskSnapshot,...publicValue}=value;
  return publicValue;
}

// A single registry owns independent engines. There is deliberately no global
// browser-operation queue or permit pool: one slow account cannot stall others.
export class AccountCoordinator {
  constructor({store,broker,dataDir,adapterFactory,now=Date.now}) {
    this.store=store;this.broker=broker;this.dataDir=dataDir;this.now=now;
    this.adapterFactory=adapterFactory;this.engines=new Map();this.sessionDue=new Map();
    this.started=false;this.deliveryBusy=false;this.deliveryPromise=null;this.healthTimer=null;this.notificationTimer=null;
  }
  async init() {
    this.store.initializeAccounts();
    await Promise.all(this.store.listAccounts().map(account=>this.ensureAccount(account.id)));
    return this;
  }
  account(id=DEFAULT_ACCOUNT) {
    if(typeof id!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))throw new HttpError(400,'账号编号格式无效。');
    const account=this.store.getAccount(id);
    if(!account)throw new HttpError(404,'找不到这个账号。');
    return account;
  }
  async ensureAccount(id) {
    if(this.engines.has(id))return this.engines.get(id);
    const account=this.account(id);
    await this.broker?.ensureAccount(id);
    const bridge=this.broker?.getBridge(id);
    bridge?.setLabel?.(account.label);
    const identityVerifier=async fingerprint=>{
      try {this.store.bindAccountIdentity(id,fingerprint);}
      catch(error) {
        this.store.updateAccount(id,{enabled:false});
        const engine=this.engines.get(id);
        engine?.applySession({status:'unknown',browserOpen:true,browserMode:'extension',message:'登录身份与账号绑定不一致或已被其他账号使用，请核对浏览器资料。'});
        engine?.event(null,'identity_mismatch','登录身份核验失败，已停用本账号，其他账号继续运行。','warning');
        throw Object.assign(new Error('登录身份核验失败，请恢复原账号登录或使用对应的账号资料。'),{code:'IDENTITY_MISMATCH'});
      }
    };
    const adapter=this.adapterFactory
      ?await this.adapterFactory({account,bridge,identityVerifier})
      :new CatchtableAdapter({dataDir:id===DEFAULT_ACCOUNT?this.dataDir:join(this.dataDir,'accounts',id),extensionBridge:bridge,identityVerifier});
    const engine=new Engine({store:this.store.forAccount(id),adapter,now:this.now,managed:true});
    this.engines.set(id,engine);
    this.sessionDue.set(id,this.now()+((this.engines.size-1)%50)*200);
    if(this.started)engine.start();
    return engine;
  }
  engine(id=DEFAULT_ACCOUNT) {
    this.account(id);
    const engine=this.engines.get(id);
    if(!engine)throw new HttpError(503,'账号正在初始化，请稍后重试。');
    return engine;
  }
  start() {
    this.started=true;
    for(const engine of this.engines.values())engine.start();
    this.healthTimer=setInterval(()=>{
      for(const [id,engine] of this.engines) {
        if(this.sessionDue.get(id)>this.now())continue;
        this.sessionDue.set(id,this.now()+10000);
        if(this.account(id).enabled)void engine.refreshSession().catch(()=>{});
      }
    },250);
    this.healthTimer.unref();
    this.notificationTimer=setInterval(()=>{void this.deliverNotification().catch(()=>{});},2000);
    this.notificationTimer.unref();
  }
  async deliverNotification() {
    if(this.deliveryBusy || !this.started)return;
    const notice=this.store.nextNotification(new Date(this.now()).toISOString());
    if(!notice)return;
    this.deliveryBusy=true;
    this.deliveryPromise=this.engine(notice.accountId || DEFAULT_ACCOUNT).deliverOneNotification();
    try {await this.deliveryPromise;}finally {this.deliveryBusy=false;this.deliveryPromise=null;}
  }
  async stop() {
    this.started=false;clearInterval(this.healthTimer);clearInterval(this.notificationTimer);
    await Promise.allSettled([...this.engines.values()].map(engine=>engine.stop()));
    await this.deliveryPromise?.catch(()=>{});
  }
  async createAccount(input) {
    const account=this.store.createAccount({label:input.label,settings:inputSettings(input)});
    await this.ensureAccount(account.id);
    return this.publicAccount(account.id);
  }
  updateAccount(id,input) {
    this.account(id);
    this.store.updateAccount(id,{...(input.label!==undefined?{label:input.label}:{}),settings:inputSettings(input)});
    this.broker?.getBridge(id)?.setLabel?.(this.account(id).label);
    return this.publicAccount(id);
  }
  accountAction(id,action) {
    if(!['enable','disable'].includes(action))throw new HttpError(400,'账号操作须为 enable 或 disable。');
    this.account(id);this.store.updateAccount(id,{enabled:action==='enable'});this.engine(id).schedule();
    return {account:this.publicAccount(id)};
  }
  publicAccount(id) {
    const account=this.account(id),engine=this.engine(id),scoped=this.store.forAccount(id);
    return {id,label:account.label,enabled:account.enabled,settings:{...account.settings},
      session:engine.session,extension:this.broker?.state(id) || {connected:false,status:'disconnected'},engine:engine.state(),
      taskCount:scoped.listTasks().filter(task=>task.source==='live').length};
  }
  state(scope='all') {
    if(scope!=='all')this.account(scope);
    const scoped=scope==='all'?this.store:this.store.forAccount(scope);
    const accounts=this.store.listAccounts().map(account=>this.publicAccount(account.id));
    const stores=scope==='all'?accounts.map(account=>this.store.forAccount(account.id)):[scoped];
    const records=method=>stores.flatMap(store=>store[method]()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,120);
    const stats={};for(const store of stores)for(const [key,value] of Object.entries(store.stats()))stats[key]=(stats[key] || 0)+value;
    const labels=new Map(accounts.map(account=>[account.id,account.label]));
    const tag=record=>({...noPrivateFields(record),accountLabel:labels.get(record.accountId || DEFAULT_ACCOUNT) || '默认账号'});
    const chosen=scope==='all'?DEFAULT_ACCOUNT:scope;
    const runtimes=scope==='all'?[...this.engines.values()].map(engine=>engine.state()):[this.engine(scope).state()];
    const paused=this.store.settings().enginePaused===true;
    return {accounts,tasks:scoped.listTasks().map(tag),events:records('listEvents').map(tag),
      bookings:records('listVisibleAttempts').map(tag),notifications:records('listNotifications').map(tag),
      settings:this.store.settings(),session:this.engine(chosen).session,extension:this.broker?.state(chosen),
      engine:{running:this.started,paused,globalPaused:paused,busy:runtimes.some(value=>value.busy),
        accountWriteBlocked:runtimes.some(value=>value.accountWriteBlocked),currentDate:localDate(this.now()),
        currentTaskId:scope==='all'?null:runtimes[0].currentTaskId,queuedActions:runtimes.reduce((sum,value)=>sum+(value.queuedActions||0),0),
        accountCount:accounts.length,connectedAccounts:accounts.filter(account=>account.extension.connected).length,
        authenticatedAccounts:accounts.filter(account=>account.session.status==='authenticated'
          && (account.settings.browserIntegration!=='extension' || account.extension.connected)).length,
        processMemoryMB:Math.round(process.memoryUsage().rss/1048576),systemFreeMemoryMB:Math.round(os.freemem()/1048576)},stats};
  }
  createTask(input) {
    const id=input.accountId || DEFAULT_ACCOUNT,engine=this.engine(id),scoped=this.store.forAccount(id);
    if(scoped.listTasks().filter(task=>task.source==='live').length>=TASK_LIMIT)throw new HttpError(409,`每个账号最多保存 ${TASK_LIMIT} 条真实任务。`);
    const task={...createTask(input,scoped.settings(),this.now()),accountId:id};
    scoped.saveTask(task);engine.event(task,'created','任务已保存，等待用户启动。');engine.schedule();return {task};
  }
  taskEngine(taskId,accountId) {
    const task=this.store.getTask(taskId);
    if(!task)throw new HttpError(404,'找不到这条任务。');
    const id=accountId || DEFAULT_ACCOUNT;
    if(task.accountId!==id)throw new HttpError(409,'任务不属于指定账号，请刷新后重试。');
    return this.engine(id);
  }
  engineAction(action,scope='all') {
    const paused=['pause','pause_all'].includes(action);
    if(!['pause','resume','pause_all','resume_all'].includes(action))throw new HttpError(400,'不支持的引擎操作。');
    if(scope==='all')this.store.saveSettings({enginePaused:paused});
    else {this.account(scope);this.store.forAccount(scope).saveSettings({enginePaused:paused});}
    for(const [id,engine] of this.engines)if(scope==='all'||id===scope)engine.schedule();
    return {engine:this.state(scope).engine};
  }
  clearRecords(kind,scope=DEFAULT_ACCOUNT) {
    if(!['events','notifications','bookings','all'].includes(kind))throw new HttpError(400,'无效的记录类型。');
    const scopes=scope==='all'?this.store.listAccounts().map(account=>account.id):[this.account(scope).id];
    const cleared={events:0,notifications:0,bookings:0};
    // Synchronous SQLite work is atomic with respect to pending JS browser
    // callbacks. No cross-account browser queue is needed for display clearing.
    for(const id of scopes)for(const [key,value] of Object.entries(this.store.forAccount(id).clearRecords(kind)))cleared[key]+=value;
    return {ok:true,cleared};
  }
}
