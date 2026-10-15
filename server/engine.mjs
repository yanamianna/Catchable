import { request } from 'node:https';
import { ACTIVE_TASK_STATUSES, BOOKING_CONTACT_DEFAULTS, HttpError, PENDING_ATTEMPT_STATUSES, TERMINAL_TASK_STATUSES, VERIFIABLE_ATTEMPT_STATUSES, createTask, intervalMs, matchingSlots, restaurantUrl, safeMessage, localDate, validateBookingContactSettings, validateWebhookUrl } from './domain.mjs';

export class Engine {
  constructor({ store, adapter, now = Date.now, deliverWebhook = defaultWebhookDelivery, managed = false }) {
    this.store = store;
    this.adapter = adapter;
    this.now = now;
    this.deliverWebhook = deliverWebhook;
    this.managed = managed;
    this.timer = null;
    this.notificationTimer = null;
    this.sessionTimer = null;
    this.sessionRefreshPending = false;
    this.deliveryPromise = null;
    this.tail = Promise.resolve();
    this.pending = 0;
    this.tickPending = false;
    this.stopped = false;
    this.schedulerActive = false;
    this.nextWakeAt = null;
    this.lastTickAt = null;
    this.currentTaskId = null;
    this.session = { status: 'closed', connected: false, browserOpen: false, browserMode: 'manual', checkedAt: this.timestamp(), message: '尚未打开专用浏览器。', guidance: ['点击「打开普通登录窗口」，手动登录并关闭专用窗口后，点击「连接并核验登录」。'] };
    const settings=store.settings();
    const contactDefaults=Object.fromEntries(Object.entries(BOOKING_CONTACT_DEFAULTS).filter(([key])=>!Object.hasOwn(settings,key)));
    if(Object.keys(contactDefaults).length)store.saveSettings(contactDefaults);
    const browserIntegration=['extension','dedicated'].includes(settings.browserIntegration)?settings.browserIntegration:adapter.defaultIntegration || 'dedicated';
    if(!Object.hasOwn(settings,'browserIntegration'))store.saveSettings({browserIntegration});
    if(typeof adapter.configureIntegration==='function')adapter.configureIntegration(browserIntegration);
    const browserChannel=browserIntegration==='extension'?'chrome':['chrome','msedge'].includes(settings.browserChannel)?settings.browserChannel:adapter.browserChannel || 'msedge';
    if(settings.browserChannel!==browserChannel)store.saveSettings({browserChannel});
    if(typeof adapter.configureBrowser==='function')adapter.configureBrowser(browserChannel);
    Object.assign(this.session,typeof adapter.browserInfo==='function'?adapter.browserInfo():{});
    if(browserIntegration==='extension')Object.assign(this.session,{browserMode:'extension',message:'Chrome 扩展尚未核验。请在平常使用的 Chrome 中加载扩展并完成本机配对。',guidance:['保持当前 Chrome 打开，在扩展中连接本机控制台后核验登录。无需关闭浏览器。']});
    store.recover(this.timestamp());
    this.initialiseVerifications();
  }
  timestamp() { return new Date(this.now()).toISOString(); }
  enqueue(fn) {
    this.pending += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextWakeAt = null;
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {}).finally(() => { this.pending -= 1; this.schedule(); });
    return result;
  }
  state() {
    return { running: !this.stopped, paused: this.store.settings().enginePaused, busy: this.pending > 0, currentTaskId: this.currentTaskId, queuedActions: this.pending, currentDate: localDate(this.now()),
      lastTickAt: this.lastTickAt, nextWakeAt: this.nextWakeAt, accountWriteBlocked: this.store.hasUncertainLiveAttempt() };
  }
  start() {
    this.stopped = false;
    this.schedulerActive = true;
    this.schedule();
    if (!this.managed && !this.notificationTimer) this.notificationTimer = setInterval(() => {
      if (!this.deliveryPromise && !this.stopped) {
        this.deliveryPromise = this.deliverOneNotification().catch(() => {}).finally(() => { this.deliveryPromise = null; });
      }
    }, 2000);
    if (!this.managed && !this.sessionTimer) this.sessionTimer = setInterval(() => {
      this.refreshSession().catch(() => {});
    }, 10000);
    this.timer?.unref();
    this.notificationTimer?.unref();
    this.sessionTimer?.unref();
  }
  async stop() {
    this.stopped = true;
    this.schedulerActive = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.notificationTimer) clearInterval(this.notificationTimer);
    if (this.sessionTimer) clearInterval(this.sessionTimer);
    this.timer = null;
    this.nextWakeAt = null;
    this.notificationTimer = null;
    this.sessionTimer = null;
    await this.tail;
    await this.deliveryPromise;
    await this.adapter.close?.();
  }
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextWakeAt = null;
    if (!this.schedulerActive || this.stopped || this.pending > 0 || this.tickPending) return;
    const paused = this.store.settings().enginePaused;
    const pendingTaskIds=new Set(this.store.listPendingAttempts().map(attempt=>attempt.taskId));
    let earliest = Infinity;
    for (const task of this.store.listTasks()) {
      if (!TERMINAL_TASK_STATUSES.has(task.status) && !pendingTaskIds.has(task.id)) earliest = Math.min(earliest, Date.parse(task.deadline));
      if (!paused && !pendingTaskIds.has(task.id) && task.source === 'live' && ACTIVE_TASK_STATUSES.has(task.status) && task.nextCheckAt) earliest = Math.min(earliest, Date.parse(task.nextCheckAt));
    }
    if(!paused)for(const attempt of this.store.listPendingAttempts()) {
      if(this.verificationEnabled(attempt) && attempt.nextVerificationAt)earliest=Math.min(earliest,Date.parse(attempt.nextVerificationAt));
    }
    if (!Number.isFinite(earliest)) return;
    const delay = Math.max(1, Math.min(2147483647, earliest - this.now()));
    this.nextWakeAt = new Date(this.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextWakeAt = null;
      this.tick().catch((error) => {
        this.store.addEvent({ type: 'engine_error', level: 'error', message: safeMessage(error), createdAt: this.timestamp() });
      });
    }, delay);
    this.timer.unref();
  }
  task(id) {
    const task = this.store.getTask(id);
    if (!task) throw new HttpError(404, '找不到这条任务。');
    return task;
  }
  event(task, type, message, level = 'info', extra = {}) {
    return this.store.addEvent({ taskId: task?.id || null, source: task?.source || 'live', type, message, level, createdAt: this.timestamp(), ...extra });
  }
  notify(task, type, message, extra = {}) {
    const event = this.event(task, type, message, type === 'auth_required' ? 'warning' : 'info', { restaurantUrl: task.restaurantUrl, ...extra });
    this.store.addNotification(event, 'in_app', this.timestamp());
    if (task.source !== 'demo' && this.store.settings().webhookUrl) this.store.addNotification(event, 'webhook', this.timestamp());
    return event;
  }

  async tick() {
    if (this.stopped || this.tickPending) return;
    this.tickPending = true;
    try {
      await this.enqueue(async () => {
        this.lastTickAt = this.timestamp();
        const pendingTaskIds=new Set(this.store.listPendingAttempts().map(attempt=>attempt.taskId));
        for (const task of this.store.listTasks()) {
          if (!TERMINAL_TASK_STATUSES.has(task.status) && !pendingTaskIds.has(task.id) && Date.parse(task.deadline) <= this.now()) {
            this.store.patchTask(task.id, { status: 'expired', nextCheckAt: null, lastMessage: '已到截止时间，任务自动结束。' }, this.timestamp());
            this.event(task, 'expired', '已到截止时间，任务自动结束。');
          }
        }
        if (!this.store.settings().enginePaused) {
          const verification=this.store.listPendingAttempts().filter(attempt=>this.verificationEnabled(attempt) && attempt.nextVerificationAt && Date.parse(attempt.nextVerificationAt)<=this.now())
            .sort((a,b)=>a.nextVerificationAt.localeCompare(b.nextVerificationAt))[0];
          if(verification) {await this.verifyAttempt(verification);return;}
          const due = this.store.listTasks().filter((task) => ACTIVE_TASK_STATUSES.has(task.status)
            && !pendingTaskIds.has(task.id) && task.source === 'live' && task.nextCheckAt && Date.parse(task.nextCheckAt) <= this.now())
            .sort((a, b) => a.nextCheckAt.localeCompare(b.nextCheckAt));
          if (due[0]) await this.checkTask(due[0].id);
        }
      });
    } finally { this.tickPending = false; this.schedule(); }
  }

  async taskAction(id, action, input = {}) {
    const task = this.task(id);
    if (action === 'pause') {
      const updated = this.store.patchTask(id, { status: TERMINAL_TASK_STATUSES.has(task.status) ? task.status : 'paused', nextCheckAt: null, resumeAfterAuth: false, lastMessage: '任务已暂停。' }, this.timestamp());
      this.event(task, 'paused', '用户暂停了任务。');
      this.schedule();
      return { task: updated };
    }
    if (!['start', 'check', 'handoff', 'reconcile', 'abandon', 'continue_auto'].includes(action)) throw new HttpError(400, '不支持的任务操作。');
    return this.enqueue(async () => {
      const current = this.task(id);
      if (action === 'abandon') return this.abandonTask(current, input);
      if (action === 'reconcile') return this.reconcileTask(current);
      if (action === 'continue_auto') return this.continueAutoTask(current);
      if (TERMINAL_TASK_STATUSES.has(current.status)) throw new HttpError(409, '任务已结束，不能再次启动或提交。');
      if (Date.parse(current.deadline) <= this.now()) throw new HttpError(409, '任务已超过截止时间。');
      if (action === 'start') {
        const waiting=this.store.attemptsForTask(id).find(attempt=>PENDING_ATTEMPT_STATUSES.has(attempt.status));
        if(waiting) {
          if(current.status!=='paused' || waiting.status==='submitting' || !this.autoVerificationAuthorised(waiting))throw new HttpError(409,'这条任务有等待核验的预约，请先核验。');
          const timestamp=this.timestamp();
          this.store.saveAttempt({...waiting,nextVerificationAt:timestamp});
          const updated=this.store.patchTask(id,{status:waiting.status==='pending_restaurant'?'awaiting_confirmation':'user_action_required',nextCheckAt:null,nextVerificationAt:timestamp,lastMessage:'已恢复只读预约结果核验，不会重复提交。'},timestamp);
          this.event(updated,'verification_resumed','已恢复只读预约结果核验，不会重复提交。');
          return {task:updated};
        }
        const updated = this.store.patchTask(id, { status: 'active', nextCheckAt: this.timestamp(), resumeAfterAuth: false, lastMessage: '任务已启动，正在等待下一次检查。' }, this.timestamp());
        this.event(updated, 'started', '任务已启动。');
        return { task: updated };
      }
      if (current.source === 'demo') throw new HttpError(409, '演练任务仅展示已完成的测试记录，不访问餐厅网站。');
      if (action === 'check') {
        await this.checkTask(id, { manual: true });
        return { task: this.task(id) };
      }
      if (!current.slots?.length) throw new HttpError(409, '尚未发现匹配空位，请先检查。');
      await this.prepareTask(current, current.slots[0], { handoff: true });
      return { task: this.task(id), url: current.restaurantUrl };
    });
  }

  async checkTask(id, { manual = false, adapter = this.adapter } = {}) {
    if (this.stopped) return;
    const original = this.task(id);
    if (!manual && !ACTIVE_TASK_STATUSES.has(original.status)) return;
    if (this.store.attemptsForTask(id).some((attempt) => PENDING_ATTEMPT_STATUSES.has(attempt.status))) return;
    this.currentTaskId = id;
    const startedAtMs = this.now();
    const metrics = { lastCheckStartedAt: new Date(startedAtMs).toISOString(),
      effectiveIntervalMs: original.lastCheckStartedAt ? Math.max(0, startedAtMs - Date.parse(original.lastCheckStartedAt)) : null };
    let observation;
    try { observation = await adapter.inspect(original,{firstMatch:original.source==='live' && original.mode==='auto' && original.autoConsent===true}); }
    catch (error) { observation = { status: 'unknown', slots: [], message: safeMessage(error, '页面检查失败。') }; }
    finally { this.currentTaskId = null; }
    metrics.lastCheckDurationMs = Math.max(0, this.now() - startedAtMs);
    const task = this.task(id);
    const timestamp = this.timestamp();
    if (Date.parse(task.deadline) <= this.now()) {
      this.store.patchTask(id, { ...metrics, status: 'expired', nextCheckAt: null, lastMessage: '检查期间已到截止时间，没有继续提交。', lastCheckedAt: timestamp, checkCount: task.checkCount + 1 }, timestamp);
      this.event(task, 'expired', '检查期间已到截止时间，没有继续提交。');
      return;
    }
    const stillRunning = ACTIVE_TASK_STATUSES.has(task.status);
    const preservePaused = task.status === 'paused';
    const count = task.checkCount + 1;
    if (observation?.status === 'auth_required') {
      if(this.adapter.lastSession)this.applySession(this.adapter.lastSession);
      const message = observation.message || '登录已失效，请在专用浏览器登录并检查会话。';
      this.store.patchTask(id, { ...metrics, status: preservePaused ? 'paused' : 'auth_required', resumeAfterAuth: stillRunning, nextCheckAt: null,
        lastCheckedAt: timestamp, lastObservationStatus: 'auth_required', lastMessage: message, checkCount: count }, timestamp);
      if (task.lastObservationStatus !== 'auth_required') this.notify(task, 'auth_required', message);
      this.applySession({ status:'unauthenticated', connected:false, browserOpen:this.session.browserOpen, browserMode:this.session.browserMode, checkedAt:timestamp, message, guidance:['请在专用浏览器重新登录，然后点击「连接并核验登录」。'] });
      return;
    }
    if (!['available', 'unavailable'].includes(observation?.status)) {
      const failures = (task.failureCount || 0) + 1;
      const delay = Math.min(600000, Math.max(1000, task.pollIntervalMs) * 2 ** Math.min(failures - 1, 4));
      const message = observation?.message || '目前无法判断空位，保留上次有效结果并延后重试。';
      this.store.patchTask(id, { ...metrics, status: preservePaused ? 'paused' : 'backoff', lastCheckedAt: timestamp, lastObservationStatus: 'unknown',
        nextCheckAt: preservePaused ? null : new Date(this.now() + delay).toISOString(), failureCount: failures, lastMessage: message, checkCount: count }, timestamp);
      this.event(task, 'observation_unknown', message, 'warning', { diagnostics: observation?.diagnostics ?? null });
      if (failures === 3) this.notify(task, 'attention_required', '连续三次未能读取有效空位，请检查浏览器或登录状态。');
      return;
    }
    const slots = matchingSlots(task, observation.slots).filter((slot) => slot.date >= localDate(this.now()));
    const observedDates = observation.complete === false ? (Array.isArray(observation.observedDates) ? observation.observedDates : []) : null;
    const displayedSlots = observedDates === null ? slots : matchingSlots(task, [...slots, ...(task.slots || []).filter((slot) => !observedDates.includes(slot.date))]);
    const message = observation.message || (slots.length ? `发现 ${slots.length} 个匹配空位。` : '暂时没有匹配空位。');
    this.store.transaction(() => {
      const fresh = this.store.recordSlots(task.id, slots, { observedDates });
      this.store.patchTask(id, { ...metrics, slots: displayedSlots, lastCheckedAt: timestamp, lastSuccessfulAt: timestamp, lastObservationStatus: slots.length ? 'available' : 'unavailable', lastObservationComplete: observation.complete !== false,
        status: preservePaused ? 'paused' : 'active', nextCheckAt: preservePaused ? null : new Date(this.now() + task.pollIntervalMs).toISOString(),
        failureCount: 0, checkCount: count, lastMessage: message }, timestamp);
      this.event(task, 'checked', message);
      for (const { slot, eventKey } of fresh) this.notify(task, 'slot_available', `${task.source === 'demo' ? '【演练】' : ''}${task.restaurantName} 出现匹配空位：${slot.date} ${slot.time}（韩国时间），${slot.partySize} 人。`, { slot, eventKey });
    });
    if (!slots.length || (!stillRunning && !manual) || preservePaused || this.stopped || this.store.settings().enginePaused) return;
    if (task.mode === 'assist') {
      this.store.patchTask(id, { status: 'user_action_required', nextCheckAt: null, lastMessage: '发现匹配空位。点击继续预约进入官方页面，尚未创建订单。' }, timestamp);
    } else if (task.mode === 'auto') {
      if (task.source === 'live' && this.store.hasUncertainLiveAttempt()) {
        this.store.patchTask(id, { lastMessage: '发现匹配空位，但账户有待核验的提交，暂不执行新预订。' }, timestamp);
        return;
      }
      if (this.groupHasPending(task)) {
        this.store.patchTask(id, { lastMessage: '发现匹配空位，但同组另有预约等待核验；监控继续，暂不创建第二桌。' }, timestamp);
        return;
      }
      await this.prepareTask(this.task(id), slots[0], { adapter, inspectionId:observation.inspectionId });
    }
  }

  async prepareTask(task, slot, { adapter = this.adapter, handoff = false, inspectionId } = {}) {
    if (Date.parse(task.deadline) <= this.now() || slot.date < localDate(this.now())) throw new HttpError(409, '任务已过期或空位日期已过去，不能继续预约。');
    if (task.source === 'live' && this.store.hasUncertainLiveAttempt()) throw new HttpError(409, '账户有结果不明的提交，新预订已阻止。请先核验已有预约。');
    const pending = this.store.attemptsForTask(task.id).find((attempt) => PENDING_ATTEMPT_STATUSES.has(attempt.status));
    if (pending) throw new HttpError(409, '这条任务的预约结果尚未确认，不能重复提交。');
    if (this.groupHasPending(task)) throw new HttpError(409, '同组有预约等待核验，暂时不能创建第二桌。');
    if (task.groupId && this.store.listAttempts(10000).some((attempt) => attempt.source === task.source && attempt.groupId === task.groupId && attempt.status === 'confirmed')) {
      this.store.patchTask(task.id, { status: 'paused', nextCheckAt: null, lastMessage: '同组已确认一桌，已停止新预订。' }, this.timestamp());
      return;
    }
    const attempt = this.store.addAttempt(task, slot, 'submitting', handoff ? '正在准备官方预约页面，等待核验结果。' : undefined, this.timestamp());
    this.event(task, 'booking_started', '已记录本次预约尝试，结果确认前不会重复提交。', 'info', { bookingId: attempt.id, slot });
    let result;
    this.currentTaskId=task.id;
    try { result = await adapter.prepare(task, slot, {onBeforeSubmit:this.beforeSubmit(attempt),...this.bookingContactOptions(task,attempt),...(typeof inspectionId==='string'?{inspectionId}:{})}); }
    catch (error) { result = { status: 'outcome_unknown', message: safeMessage(error, '提交结果不明，请核验已有预约。') }; }
    finally {this.currentTaskId=null;}
    if(result?.phase==='authentication' && this.adapter.lastSession)this.applySession(this.adapter.lastSession);
    this.finishAttempt(this.store.getAttempt(attempt.id) || attempt, result);
  }

  finishAttempt(attempt, result, { verification = false, verificationFailed = false } = {}) {
    const allowed = ['confirmed', 'rejected', 'outcome_unknown', 'user_action_required', 'pending_restaurant'];
    let status = allowed.includes(result?.status) ? result.status : 'outcome_unknown';
    // Pending requests and confirmations both need an identified, matching official order.
    if (['confirmed','pending_restaurant'].includes(status) && (typeof result.reservationId!=='string' || !result.reservationId.trim() || !sameReservedSlot(result.slot, attempt.slot)
      || (verification && attempt.reservationId && result.reservationId!==attempt.reservationId))) {
      status = 'outcome_unknown';
      result = { ...result, message: '返回的预约缺少可核对的订单号或条件不一致，继续只读核验，不会重复提交。' };
    }
    const uncertainRead=verification && (verificationFailed || status==='outcome_unknown');
    const beforeSubmitRead=uncertainRead && ['before_submit','required_fields','agreement','captcha','holding_expired','authentication'].includes(attempt.phase)
      && attempt.submitted===false && !attempt.reservationId && result?.submitted!==true && !result?.reservationId;
    if(beforeSubmitRead)status='user_action_required';
    if(uncertainRead && attempt.status==='pending_restaurant' && attempt.reservationId)status='pending_restaurant';
    const timestamp = this.timestamp();
    const readMessage = result?.message || ({ confirmed: '预约已确认。', rejected: '本次预约未成功。', outcome_unknown: '结果不明，继续只读核验。', user_action_required: '请在官方页面完成登录、确认或支付；当前尚未确认预约。',pending_restaurant:'预约申请已提交，等待餐厅确认；尚未预约成功。' }[status]);
    const message=uncertainRead && (attempt.status==='pending_restaurant' || beforeSubmitRead)?attempt.message:readMessage;
    const task = this.store.getTask(attempt.taskId);
    const count=(attempt.verificationCount || 0)+(verification?1:0);
    const failures=verification?(uncertainRead?(attempt.verificationFailureCount || 0)+1:0):(attempt.verificationFailureCount || 0);
    const delay=verification?(uncertainRead?Math.min(300000,30000*2**Math.min(failures-1,4)):30000):10000;
    const updated={...attempt,status,message,reservationId:['confirmed','pending_restaurant'].includes(status)?(uncertainRead?attempt.reservationId:result.reservationId):attempt.reservationId || null,
      phase:beforeSubmitRead?attempt.phase:uncertainRead && attempt.status==='pending_restaurant'?(attempt.phase || 'awaiting_restaurant'):(typeof result?.phase==='string'?result.phase.slice(0,100):({pending_restaurant:'awaiting_restaurant',user_action_required:'awaiting_user',outcome_unknown:'outcome_unknown',confirmed:'confirmed',rejected:'rejected'}[status])),
      submitted:result?.submitted===true || attempt.submitted===true || ['confirmed','pending_restaurant'].includes(status),
      diagnostics:result?.diagnostics && typeof result.diagnostics==='object'?diagnosticFields({...attempt.diagnostics,...result.diagnostics}):attempt.diagnostics || null,
      verificationCount:count,verificationFailureCount:failures,
      lastVerifiedAt:verification?timestamp:attempt.lastVerifiedAt || null,lastVerificationMessage:verification?readMessage:attempt.lastVerificationMessage || null,
      nextVerificationAt:VERIFIABLE_ATTEMPT_STATUSES.has(status) && this.autoVerificationAuthorised(attempt)?new Date(this.now()+delay).toISOString():null,updatedAt:timestamp};
    this.store.transaction(() => {
      this.store.saveAttempt(updated);
      if (task) {
        const nextStatus=status==='confirmed'?'confirmed':status==='rejected'?(Date.parse(task.deadline)<=this.now()?'expired':task.status==='paused' || verification || updated.submitted?'paused':'active')
          :task.status==='paused'?'paused':status==='pending_restaurant'?'awaiting_confirmation':'user_action_required';
        this.store.patchTask(task.id, { status: nextStatus, nextCheckAt: nextStatus === 'active' ? new Date(this.now() + task.pollIntervalMs).toISOString() : null,
          nextVerificationAt:updated.nextVerificationAt,verificationCount:count,lastVerifiedAt:updated.lastVerifiedAt,lastMessage: message }, timestamp);
        if(status!==attempt.status)this.notify(task, `booking_${status}`, message, { bookingId: attempt.id, slot: attempt.slot,phase:updated.phase });
        if (status === 'confirmed' && task.groupId) {
          for (const other of this.store.listTasks()) {
            if (other.id !== task.id && other.groupId === task.groupId && other.source === task.source && !TERMINAL_TASK_STATUSES.has(other.status)) {
              this.store.patchTask(other.id, { status: 'paused', nextCheckAt: null, lastMessage: `${task.restaurantName} 已确认，同组停止新预订。` }, timestamp);
              this.event(other, 'group_paused', `${task.restaurantName} 已确认，同组已暂停。`);
            }
          }
        }
      }
    });
    return status;
  }

  async reconcileTask(task, adapter = this.adapter) {
    if (task.source === 'demo') throw new HttpError(409, '演练记录不可使用真实会话核验。');
    const attempt = this.store.attemptsForTask(task.id).find((item) => VERIFIABLE_ATTEMPT_STATUSES.has(item.status));
    if (!attempt) throw new HttpError(409, '这条任务没有等待核验的预约。');
    await this.verifyAttempt(attempt,adapter);
    return { task: this.task(task.id) };
  }

  autoVerificationAuthorised(attempt) {
    const task=attempt.taskSnapshot || this.store.getTask(attempt.taskId);
    return attempt.source==='live' && task?.mode==='auto' && task.autoConsent===true;
  }
  verificationEnabled(attempt) {
    const task=this.store.getTask(attempt.taskId);
    return this.adapter.hasContext!==false && Boolean(task) && VERIFIABLE_ATTEMPT_STATUSES.has(attempt.status) && this.autoVerificationAuthorised(attempt) && task.status!=='paused';
  }
  initialiseVerifications() {
    for(const attempt of this.store.listPendingAttempts()) {
      if(!VERIFIABLE_ATTEMPT_STATUSES.has(attempt.status) || !this.autoVerificationAuthorised(attempt))continue;
      const updated={submitted:false,verificationCount:0,verificationFailureCount:0,lastVerifiedAt:null,lastVerificationMessage:null,...attempt,
        nextVerificationAt:attempt.nextVerificationAt || new Date(this.now()+10000).toISOString()};
      this.store.saveAttempt(updated);
      this.store.patchTask(attempt.taskId,{nextVerificationAt:updated.nextVerificationAt,verificationCount:updated.verificationCount,lastVerifiedAt:updated.lastVerifiedAt},this.timestamp());
    }
  }
  async verifyAttempt(attempt,adapter=this.adapter) {
    const task=this.store.getTask(attempt.taskId) || attempt.taskSnapshot;
    let result;
    let failed=false;
    this.currentTaskId=attempt.taskId;
    try { result = await adapter.reconcile({ ...attempt, task: attempt.taskSnapshot || task }); }
    catch (error) {failed=true;result = { status: 'outcome_unknown', message: safeMessage(error, '暂时无法核验预约。') }; }
    finally {this.currentTaskId=null;}
    this.finishAttempt(attempt,result,{verification:true,verificationFailed:failed});
    if(!failed && this.automaticContinuationAllowed(attempt,result,adapter)) {
      await this.continueAutoTask(this.task(attempt.taskId),adapter,{automatic:true,attemptId:attempt.id});
    }
  }

  automaticContinuationAllowed(attempt,result,adapter=this.adapter) {
    const current=this.store.getAttempt(attempt.id);
    const task=this.store.getTask(attempt.taskId);
    const before=record=>record?.status==='user_action_required' && ['before_submit','authentication'].includes(record.phase) && record.submitted===false && !record.reservationId;
    return attempt.legacyIdentityUnverified!==true && result?.resumeAllowed===true && before(attempt) && before(current) && before(result)
      && task?.source==='live' && task.mode==='auto' && task.autoConsent===true && task.status!=='paused' && task.status!=='expired'
      && Date.parse(task.deadline)>this.now() && current.slot.date>=localDate(this.now()) && !this.stopped && !this.store.settings().enginePaused
      && this.session.status==='authenticated' && this.session.connected===true && adapter.hasContext===true && typeof adapter.continueAttempt==='function';
  }

  beforeSubmit(attempt) {
    let used=false;
    return async()=>{
      if(used)throw new HttpError(409,'提交前登记只能执行一次，禁止重复提交。');
      used=true;
      const task=this.task(attempt.taskId);
      const current=this.store.getAttempt(attempt.id);
      if(current?.legacyIdentityUnverified===true)throw new HttpError(409,'旧预约尚未保存原账号身份，只能先在官网核验并处理，不能自动继续提交。');
      if(!current || current.source!=='live' || task.source!=='live' || task.mode!=='auto' || task.autoConsent!==true)throw new HttpError(409,'这次尝试没有真实自动预约授权，不能提交。');
      if(this.session.status!=='authenticated' || this.session.connected!==true || this.adapter.hasContext!==true)throw Object.assign(new HttpError(409,'请先连接并核验官方登录会话；会话有效且专用浏览器已连接时才能提交。'),{code:'AUTH_REQUIRED'});
      if(typeof this.adapter.isBookingAuthenticated==='function' && !this.adapter.isBookingAuthenticated(task.id)) {
        this.applySession(this.adapter.lastSession || {status:'unknown',browserOpen:true,browserMode:'controlled',message:'当前订座页尚未通过新的官方会话核验。'});
        throw Object.assign(new HttpError(409,'当前订座页尚未通过新的官方会话核验，未提交预约。'),{code:'AUTH_REQUIRED'});
      }
      if(this.stopped || this.store.settings().enginePaused || task.status==='paused' || task.status==='expired' || Date.parse(task.deadline)<=this.now() || current.slot.date<localDate(this.now()))throw new HttpError(409,'任务已暂停或过期，不能提交。');
      if(current.status==='pending_restaurant' || current.status==='confirmed' || current.submitted===true || current.reservationId)throw new HttpError(409,'本次尝试已有提交或订单证据，只允许核验，不会再次提交。');
      if(!PENDING_ATTEMPT_STATUSES.has(current.status))throw new HttpError(409,'本次尝试状态已改变，不能提交。');
      const others=this.store.listPendingAttempts().filter(other=>other.id!==current.id && other.source==='live');
      if(others.some(other=>['submitting','outcome_unknown'].includes(other.status) || (other.status==='user_action_required' && other.submitted===true && !other.reservationId)))throw new HttpError(409,'账户另有结果不明的提交，新提交已阻止。');
      if(task.groupId && (others.some(other=>other.groupId===task.groupId) || this.store.listAttempts(10000).some(other=>other.id!==current.id && other.source==='live' && other.groupId===task.groupId && other.status==='confirmed')))throw new HttpError(409,'同组另有待核验或已确认订单，不能提交第二桌。');
      const timestamp=this.timestamp();
      this.store.transaction(()=>{
        this.store.saveAttempt({...current,status:'submitting',submitted:true,phase:'submitting',nextVerificationAt:null,updatedAt:timestamp,message:'已持久记录即将提交的本次订单，结果核验前禁止重复提交。'});
        this.event(task,'booking_submitting','即将提交原有预约尝试，已先持久保存提交状态。','info',{bookingId:current.id,slot:current.slot});
      });
    };
  }

  bookingContactOptions(task,attempt) {
    if(task.source!=='live' || task.mode!=='auto' || task.autoConsent!==true)return {};
    if(attempt && Object.hasOwn(attempt,'contactSnapshot')) {
      const contact=attempt.contactSnapshot;
      if(!contact || contact.autoFill!==true)return {};
      return {bookingContact:{countryCode:contact.countryCode,phoneNumber:contact.phoneNumber,...(contact.name?{fullName:contact.name}:{})}};
    }
    const settings=this.store.settings();
    if(settings.bookingPhoneAutoFill!==true)return {};
    const contact=validateBookingContactSettings({},settings);
    return {bookingContact:{countryCode:contact.bookingPhoneCountryCode,phoneNumber:contact.bookingPhoneNumber,...(settings.bookingName?{fullName:settings.bookingName}:{})}};
  }

  async continueAutoTask(task,adapter=this.adapter,{automatic=false,attemptId=null}={}) {
    if(task.source!=='live' || task.mode!=='auto' || task.autoConsent!==true)throw new HttpError(409,'只有明确授权的真实自动预约任务可以继续。');
    if(this.session.status!=='authenticated' || this.session.connected!==true || adapter.hasContext!==true)throw new HttpError(409,'请先连接并核验官方登录会话；会话有效且专用浏览器已连接时才能继续预约。');
    const attempt=attemptId?this.store.getAttempt(attemptId):this.store.attemptsForTask(task.id).find(item=>VERIFIABLE_ATTEMPT_STATUSES.has(item.status));
    if(!attempt || attempt.taskId!==task.id || !VERIFIABLE_ATTEMPT_STATUSES.has(attempt.status))throw new HttpError(409,'没有可继续处理的原预约尝试。');
    if(typeof adapter.continueAttempt!=='function')throw new HttpError(409,'当前适配器尚未支持继续原表单，请先只读核验。');
    if(automatic) {
      this.store.saveAttempt({...attempt,autoContinueCount:(attempt.autoContinueCount || 0)+1,updatedAt:this.timestamp()});
      this.event(task,'booking_auto_continuing','官方已完整核对没有同条件订单，自动继续原有、明确未提交的预约尝试。','info',{bookingId:attempt.id,slot:attempt.slot});
    }
    this.currentTaskId=task.id;
    let result;
    try {result=await adapter.continueAttempt({...attempt,task:attempt.taskSnapshot || task,legacyBeforeSubmit:automatic?false:this.legacyBeforeSubmit(attempt)},{onBeforeSubmit:this.beforeSubmit(attempt),...this.bookingContactOptions(task,attempt)});}
    catch(error){
      const current=this.store.getAttempt(attempt.id);
      result=error.code==='AUTH_REQUIRED' && current?.submitted===false && !current.reservationId
        ?{status:'user_action_required',phase:'authentication',submitted:false,message:safeMessage(error)}
        :{status:'outcome_unknown',message:safeMessage(error,'继续处理结果不明，仅核验原尝试，不会创建第二单。')};
    }
    finally {this.currentTaskId=null;}
    if(result?.phase==='authentication' && adapter.lastSession)this.applySession(adapter.lastSession);
    this.finishAttempt(this.store.getAttempt(attempt.id) || attempt,result,{verification:attempt.status==='pending_restaurant'});
    return {task:this.task(task.id)};
  }

  legacyBeforeSubmit(attempt) {
    if(attempt.source!=='live' || attempt.submitted===true || attempt.reservationId)return false;
    const message='已打开匹配时间。请在浏览器核对套餐、条款及支付要求后完成预订。';
    const events=this.store.eventsForBooking(attempt.id);
    let lastEvidence=-1;
    events.forEach((event,index)=>{if(event.source==='live' && event.type==='booking_user_action_required' && event.message===message)lastEvidence=index;});
    if(lastEvidence<0)return false;
    return !events.slice(lastEvidence+1).some(event=>['booking_submitting','booking_confirmed','booking_pending_restaurant'].includes(event.type));
  }

  groupHasPending(task) {
    return Boolean(task.groupId) && this.store.listAttempts(10000).some((attempt) => attempt.taskId !== task.id && attempt.source === task.source
      && attempt.groupId === task.groupId && PENDING_ATTEMPT_STATUSES.has(attempt.status));
  }

  abandonTask(task, input) {
    if (input.noReservationConfirmed !== true) throw new HttpError(400, '请先在官方 My Dining 核对确实没有订单，再明确确认未预约。');
    if (task.source === 'demo') throw new HttpError(409, '演练记录无需人工处理。');
    const attempt = this.store.attemptsForTask(task.id).find((item) => ['outcome_unknown', 'user_action_required'].includes(item.status));
    if (!attempt) throw new HttpError(409, '这条任务没有可人工处理的待核验预约。');
    const timestamp = this.timestamp();
    const message = '用户已人工核对官方 My Dining，确认没有预约；本次尝试记为未成功。该结论来自用户确认。';
    this.store.transaction(() => {
      this.store.saveAttempt({ ...attempt, status: 'rejected', phase:'rejected',nextVerificationAt:null,reservationId: null, resolutionOrigin: 'user', message, updatedAt: timestamp });
      this.store.patchTask(task.id, { status: Date.parse(task.deadline) <= this.now() ? 'expired' : 'paused', nextCheckAt: null,nextVerificationAt:null, resumeAfterAuth: false, lastMessage: '已按用户确认清除待核验状态。任务已暂停，点击启动恢复监控。' }, timestamp);
      this.notify(task, 'booking_abandoned', message, { bookingId: attempt.id, resolutionOrigin: 'user', slot: attempt.slot });
    });
    return { task: this.task(task.id), message };
  }

  applySession(value, { resumeAuth = false } = {}) {
    const status = ['closed','manual_login','profile_in_use','connecting','authenticated','unauthenticated','oauth_blocked','identity_mismatch','unknown'].includes(value?.status) ? value.status : 'unknown';
    this.session = { status, connected:status==='authenticated', browserOpen:value?.browserOpen===true,
      browserMode:['controlled','extension'].includes(value?.browserMode)?value.browserMode:'manual', checkedAt:value?.checkedAt || this.timestamp(),
      message:value?.message || '登录状态尚未核验。', guidance:Array.isArray(value?.guidance)?value.guidance:[],
      ...(status==='authenticated' && typeof value.accountLabel==='string' ? {accountLabel:value.accountLabel} : {}) };
    if(status==='authenticated' && value?.newTabVerified===true) {
      this.session.newTabVerified=true;
      if(typeof value.newTabCheckedAt==='string' && Number.isFinite(Date.parse(value.newTabCheckedAt)))this.session.newTabCheckedAt=value.newTabCheckedAt;
    }
    for(const key of ['browserName','profileLabel'])if(typeof value?.[key]==='string')this.session[key]=value[key].slice(0,100);
    if(['chrome','msedge'].includes(value?.browserChannel))this.session.browserChannel=value.browserChannel;
    if(['extension','dedicated'].includes(value?.browserIntegration))this.session.browserIntegration=value.browserIntegration;
    if (resumeAuth && this.session.status === 'authenticated' && !this.store.settings().enginePaused) {
      for (const task of this.store.listTasks()) {
        if (task.source === 'live' && task.status === 'auth_required' && task.resumeAfterAuth && Date.parse(task.deadline) > this.now()) {
          this.store.patchTask(task.id, { status: 'active', nextCheckAt: this.timestamp(), resumeAfterAuth: false, lastMessage: '官方账户会话已核验，重新验证任务。' }, this.timestamp());
        }
      }
    }
    return this.session;
  }
  async refreshSession() {
    if (this.stopped || this.sessionRefreshPending || this.pending > 0 || this.tickPending)return;
    if(!this.adapter.hasContext) {
      if(this.adapter.lastSession && this.adapter.lastSession.status!==this.session.status)this.applySession(this.adapter.lastSession);
      return;
    }
    if(typeof this.adapter.observeSession!=='function')return;
    this.sessionRefreshPending=true;
    try {await this.enqueue(async()=>this.applySession(await this.adapter.observeSession(),{resumeAuth:true}));}
    finally {this.sessionRefreshPending=false;}
  }
  async sessionAction(action, input = {}) {
    if(!['open','check'].includes(action))throw new HttpError(400,'不支持的会话操作。');
    if(action==='open' && input.mode!==undefined && !['manual','controlled'].includes(input.mode))throw new HttpError(400,'浏览器模式须为 manual 或 controlled。');
    return this.enqueue(async () => {
      this.session={...this.session,status:'connecting',connected:false,checkedAt:this.timestamp(),message:action==='open'?(this.store.settings().browserIntegration==='extension'?'正在通过扩展打开当前 Chrome 中的 Catchtable。':'正在打开专用登录浏览器。'):'正在连接并核验官方登录状态。'};
      try {this.applySession(action==='open'?await this.adapter.openSession({mode:input.mode || 'manual'}):await this.adapter.getSessionStatus(),{resumeAuth:action==='check'});}
      catch(error) {this.applySession({...this.session,status:'unknown',connected:false,message:safeMessage(error),guidance:this.store.settings().browserIntegration==='extension'?['请检查 Chrome 扩展已连接本机控制台，保持 Chrome 打开后重新核验登录。']:['请关闭占用专用浏览器资料的窗口后再连接，或使用普通浏览器手动登录。']});}
      return { session: this.session };
    });
  }
  async restaurantResolve(value) {
    const url=restaurantUrl(value);
    if(typeof this.adapter.resolveRestaurant!=='function')throw new HttpError(502,'当前适配器尚未提供公开餐厅核验；可手动填写名称。');
    return this.enqueue(async()=>({restaurant:await this.adapter.resolveRestaurant(url)}));
  }
  globalAction(action) {
    if (!['pause_all', 'resume_all'].includes(action)) throw new HttpError(400, '不支持的引擎操作。');
    const paused = action === 'pause_all';
    this.store.saveSettings({ enginePaused: paused });
    this.event(null, 'engine_state', paused ? '已暂停全部自动检查。' : '已恢复自动检查。');
    this.schedule();
    return { engine: this.state() };
  }
  updateSettings(changes, { applyToExistingTasks = false } = {}) {
    if (typeof applyToExistingTasks !== 'boolean') throw new HttpError(400, 'applyToExistingTasks 须为布尔值。');
    if (changes.pollIntervalMs !== undefined) intervalMs(changes.pollIntervalMs);
    if(changes.browserChannel!==undefined && !['chrome','msedge'].includes(changes.browserChannel))throw new HttpError(400,'专用浏览器须选择 chrome 或 msedge。');
    if(changes.browserIntegration!==undefined && !['extension','dedicated'].includes(changes.browserIntegration))throw new HttpError(400,'浏览器执行方式须选择 extension 或 dedicated。');
    const contact=validateBookingContactSettings(changes,this.store.settings());
    let settings;
    this.store.transaction(() => {
      settings = this.store.saveSettings({...changes,...contact});
      if (applyToExistingTasks) {
        const now = this.now();
        for (const task of this.store.listTasks()) {
          if (task.source !== 'live' || TERMINAL_TASK_STATUSES.has(task.status)) continue;
          const patch = { pollIntervalMs: settings.pollIntervalMs };
          if (task.status === 'active') {
            const completion = task.lastCheckedAt ? Date.parse(task.lastCheckedAt) : now;
            patch.nextCheckAt = new Date(Math.max(now + 1, completion + settings.pollIntervalMs)).toISOString();
          } else if (task.status === 'backoff') {
            patch.nextCheckAt = new Date(Math.max(now + 1000, Date.parse(task.nextCheckAt || this.timestamp()))).toISOString();
          }
          this.store.patchTask(task.id, patch, this.timestamp());
        }
      }
      this.event(null, 'settings_updated', applyToExistingTasks ? '毫秒检查间隔与通知设置已保存，已应用到已有真实任务。' : '毫秒检查间隔与通知设置已保存。');
    });
    this.schedule();
    return settings;
  }
  async changeBrowser(channel) {
    if(!['chrome','msedge'].includes(channel))throw new HttpError(400,'专用浏览器须选择 chrome 或 msedge。');
    return this.enqueue(async()=>{
      if(this.store.hasUncertainLiveAttempt())throw new HttpError(409,'账户有提交结果不明的预约，先完成只读核验再更换浏览器。');
      if(typeof this.adapter.selectBrowser!=='function')throw new HttpError(409,'当前适配器不支持更换专用浏览器。');
      const session=await this.adapter.selectBrowser(channel);
      this.store.saveSettings({browserChannel:channel});
      this.applySession(session);
      this.event(null,'browser_changed','已保存专用浏览器选择，登录、核验和订座将使用同一浏览器会话。');
      return {session:this.session};
    });
  }
  async changeIntegration(mode) {
    if(!['extension','dedicated'].includes(mode))throw new HttpError(400,'浏览器执行方式须选择 extension 或 dedicated。');
    return this.enqueue(async()=>{
      if(this.store.hasUncertainLiveAttempt())throw new HttpError(409,'账户有提交结果不明的预约，先完成只读核验再更换执行方式。');
      if(typeof this.adapter.selectIntegration!=='function')throw new HttpError(409,'当前适配器不支持更换浏览器执行方式。');
      const session=await this.adapter.selectIntegration(mode);
      this.store.saveSettings({browserIntegration:mode});this.applySession(session);
      this.event(null,'browser_integration_changed',mode==='extension'?'已切换 Chrome 扩展，将使用当前 Chrome 的登录会话。':'已切换专用浏览器执行方式。');
      return {session:this.session};
    });
  }
  deleteTask(id) {
    const task = this.task(id);
    if (this.currentTaskId === id || this.store.attemptsForTask(id).some((attempt) => PENDING_ATTEMPT_STATUSES.has(attempt.status))) throw new HttpError(409, '任务正在运行或有待核验的预约，请先处理待办后再删除。');
    this.store.deleteTask(id);
    this.event(task, 'deleted', '任务已删除，历史预约和运行记录保留。');
    this.schedule();
  }

  async deliverOneNotification() {
    const notice = this.store.nextNotification(this.timestamp());
    if (!notice) return;
    const url = this.store.settings().webhookUrl;
    const updated = { ...notice, attempts: notice.attempts + 1, updatedAt: this.timestamp() };
    try {
      if (!url) throw new Error('通知渠道已移除。');
      await this.deliverWebhook(url, { eventId: notice.eventId, ...(notice.accountId?{accountId:notice.accountId,accountLabel:this.store.getAccount?.()?.label || '默认账号'}:{}), message: notice.message, slot: notice.slot, restaurantUrl: notice.restaurantUrl, observedAt: notice.createdAt,
        deliveryMeaning: '发送入口接受请求不代表手机已收到。' });
      this.store.saveNotification({ ...updated, status: 'accepted', nextAttemptAt: null, acceptedAt: this.timestamp(), lastError: null });
    } catch (error) {
      const failed = updated.attempts >= 5;
      this.store.saveNotification({ ...updated, status: failed ? 'failed' : 'queued', nextAttemptAt: failed ? null : new Date(this.now() + Math.min(600, 15 * 2 ** (updated.attempts - 1)) * 1000).toISOString(), lastError: safeMessage(error) });
      if (failed) this.store.addEvent({ type: 'notification_failed', level: 'warning', taskId: notice.taskId, source: notice.source, message: '外部通知重试五次仍失败；站内通知保留。', createdAt: this.timestamp() });
    }
  }

  async runDemo() {
    return this.enqueue(async () => {
      if (this.store.listTasks().filter((task) => task.source === 'demo').length >= 3) throw new HttpError(409, '已保存三次演练，请先删除旧演练任务。');
      const task = createTask({ restaurantName: '演练餐厅 · Zest', restaurantUrl: 'https://www.catchtable.net/shop/zest_seoul', dates: [localDate(this.now())], partySize: 2, timeStart: '18:00', timeEnd: '20:00', mode: 'auto', autoConsent: true }, this.store.settings(), this.now());
      task.source = 'demo';
      task.status = 'active';
      task.groupId = task.id;
      this.store.saveTask(task);
      const slot = { date: task.dates[0], time: '19:00', partySize: 2, label: '固定演练数据' };
      let reads = 0;
      let writes = 0;
      const fake = {
        inspect: async () => ++reads === 1 ? { status: 'unavailable', slots: [], message: '【演练】第一次观察：暂无空位。' } : { status: 'available', slots: [slot], message: '【演练】固定脚本产生一个匹配空位，不代表真实库存。' },
        prepare: async () => ++writes === 1 ? { status: 'rejected', message: '【演练】第一次尝试被拒绝；继续监控。' } : { status: 'outcome_unknown', message: '【演练】模拟提交响应丢失；已阻止重复提交，等待核验。' },
        reconcile: async () => ({ status: 'confirmed', message: '【演练】核验确认成功。没有访问网站、创建真实预约或扣款。', reservationId: `DEMO-${task.id.slice(-8)}`, slot }),
      };
      this.event(task, 'demo_started', '开始固定脚本演练：无位 → 有位 → 拒绝 → 结果不明 → 核验成功。全部数据来自本地脚本。');
      await this.checkTask(task.id, { adapter: fake });
      await this.checkTask(task.id, { adapter: fake });
      await this.checkTask(task.id, { adapter: fake });
      const pending = this.store.attemptsForTask(task.id).find((attempt) => attempt.status === 'outcome_unknown');
      this.finishAttempt(pending, await fake.reconcile(pending));
      return { task: this.task(task.id), message: '演练完成。全部记录标记为演练，没有访问外部网站。' };
    });
  }
}

function sameReservedSlot(actual, intended) {
  return actual && actual.date === intended.date && actual.time === intended.time && actual.partySize === intended.partySize
    && (!intended.seatType || actual.seatType === intended.seatType);
}

function diagnosticFields(value) {
  const primitive=item=>typeof item==='string'?item.slice(0,500):typeof item==='boolean' || (typeof item==='number' && Number.isFinite(item))?item:null;
  return Object.fromEntries(Object.entries(value).slice(0,24).filter(([key])=>!/(?:password|cookie|token|authorization|creditcard|emailaddress|phonenumber)/i.test(key))
    .map(([key,item])=>[key.slice(0,80),Array.isArray(item)?item.slice(0,20).map(primitive).filter(item=>item!==null):primitive(item)]));
}

async function defaultWebhookDelivery(url, payload) {
  const validated = await validateWebhookUrl(url);
  const selected = validated.addresses[0];
  const body = JSON.stringify(payload);
  await new Promise((resolve, reject) => {
    const req = request(validated.url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      // Pin the validated public IP, preserving HTTPS hostname verification and refusing redirects.
      lookup: (_host, options, callback) => options.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
    }, (response) => {
      clearTimeout(deadline);
      response.resume();
      if (response.statusCode >= 200 && response.statusCode < 300) resolve();
      else reject(new Error(`通知服务返回 HTTP ${response.statusCode}。`));
    });
    const deadline = setTimeout(() => req.destroy(new Error('通知服务请求超时。')), 5000);
    req.setTimeout(5000, () => req.destroy(new Error('通知服务请求超时。')));
    req.on('error', (error) => { clearTimeout(deadline); reject(error); });
    req.end(body);
  });
}
