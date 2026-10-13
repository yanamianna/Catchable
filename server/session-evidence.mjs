export function isOfficialUserInfo(value) {
  try {
    const url=new URL(value);
    if(url.origin!=='https://api.catchtable.net' || url.username || url.password || url.hash || url.pathname!=='/api/v5/user/info')return false;
    for(const key of url.searchParams.keys())if(key!=='localeCode' || url.searchParams.getAll(key).length!==1)return false;
    const locale=url.searchParams.get('localeCode');
    return locale===null || /^[A-Za-z0-9_-]{1,20}$/.test(locale);
  }catch{return false;}
}

// Read only the normal document bootstrap's account response. Never export
// cookies, auth tokens, or the user's private identifier to application state.
export function parseSessionEvidence(url,status,body) {
  if(!isOfficialUserInfo(url))return null;
  if(status===401 || status===403)return {status:'unauthenticated'};
  if(status!==200 || !body || typeof body!=='object' || Array.isArray(body))return {status:'unknown'};
  if(body.isLogin===false)return {status:'unauthenticated'};
  const identity=body.ctUserIdentifier;
  const identified=(typeof identity==='string' && identity.trim().length>0 && identity.length<=200)
    || (typeof identity==='number' && Number.isSafeInteger(identity) && identity>0);
  if(body.isLogin!==true || !identified)return {status:'unknown'};
  const name=typeof body.displayName==='string' && body.displayName.trim()?body.displayName:body.name;
  return {status:'authenticated',...(typeof name==='string' && name.trim()?{accountLabel:name.trim().slice(0,100)}:{})};
}
