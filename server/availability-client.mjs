// Serialized into the selected account's existing official shop page. Only
// the site's already loaded encoder and HTTP client perform this read query.
export async function readOfficialAvailabilityQuery(input) {
  const unsupported=()=>({kind:'unsupported'});
  const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
  if(!object(input) || Object.keys(input).sort().join(',')!=='alias,date,partySize,shopRef,visitTime'
    || typeof input.alias!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.alias)
    || typeof input.shopRef!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.shopRef)
    || typeof input.date!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
    || typeof input.visitTime!=='string' || !/^(?:[01]\d|2[0-3])[0-5]\d$/.test(input.visitTime)
    || !Number.isInteger(input.partySize) || input.partySize<1 || input.partySize>12)return unsupported();
  const parsedDate=new Date(`${input.date}T00:00:00Z`);
  if(Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0,10)!==input.date)return unsupported();
  const pageUrl=new URL(location.href);
  const shopPath=pageUrl.pathname.match(/^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?(?:explore\/)?shop\/([A-Za-z0-9_-]+)\/?$/);
  if(pageUrl.protocol!=='https:' || !['www.catchtable.net','catchtable.net'].includes(pageUrl.hostname)
    || pageUrl.port || pageUrl.username || pageUrl.password || shopPath?.[1]!==input.alias)return unsupported();
  const patterns={
    client:/^https:\/\/www\.catchtable\.net\/static\/appjs\/prod\/(\d{14})\/build\/locale\.util_[A-Za-z0-9_-]+\.js$/,
    encoder:/^https:\/\/www\.catchtable\.net\/static\/appjs\/prod\/(\d{14})\/build\/apiDataEncrypt\.util_[A-Za-z0-9_-]+\.js$/,
  };
  const resources=performance.getEntriesByType('resource').filter(entry=>['script','link','other'].includes(entry.initiatorType));
  const clientSources=[...new Set(resources.filter(entry=>patterns.client.test(entry.name)).map(entry=>entry.name))];
  const encoderSources=[...new Set(resources.filter(entry=>patterns.encoder.test(entry.name)).map(entry=>entry.name))];
  if(clientSources.length!==1 || encoderSources.length!==1
    || clientSources[0].match(patterns.client)[1]!==encoderSources[0].match(patterns.encoder)[1])return unsupported();
  let client,encode;
  try {
    const modules=await Promise.all([import(clientSources[0]),import(encoderSources[0])]);
    client=modules[0].V;encode=modules[1].t;
  } catch {return unsupported();}
  if(!client || typeof client.post!=='function' || typeof encode!=='function')return unsupported();
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),10000);
  try {
    const body=encode({shopRef:input.shopRef,searchDate:input.date,visitTime:input.visitTime,personCount:input.partySize});
    const response=await client.post('/api/v5/shop/timeslot-enc',body,{headers:{shopRef:input.shopRef},timeout:10000,signal:controller.signal});
    if(controller.signal.aborted)return {kind:'error'};
    const data=response?.data;
    if(!object(data) || typeof data.timeSlotState!=='string' || data.timeSlotState.length>100
      || !Array.isArray(data.timeSlotList) || data.timeSlotList.length>500)return {kind:'error'};
    const fields=['date','time','personCount','shopRef','isAvailable','tableType'];
    const rows=[];
    for(const row of data.timeSlotList) {
      if(!object(row))return {kind:'error'};
      const safe={};
      for(const field of fields) {
        const value=row[field];
        if(value===undefined)continue;
        if(!['string','number','boolean'].includes(typeof value) || (typeof value==='string' && value.length>200))return {kind:'error'};
        safe[field]=value;
      }
      rows.push(safe);
    }
    return {kind:'result',data:{timeSlotState:data.timeSlotState,timeSlotList:rows}};
  } catch(error) {
    const httpStatus=[error?.response?.status,error?.status,error?.statusCode].find(value=>Number.isInteger(value) && value>=100 && value<=599);
    return {kind:httpStatus===401?'auth_required':'error',...(httpStatus?{httpStatus}:{})};
  } finally {clearTimeout(timeout);}
}
