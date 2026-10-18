// Refresh static UI assets without touching recording, serial, or acquisition APIs.
export const DRAFT_IDS = Object.freeze(['custom-event', 'bench-custom-marker']);
const STORAGE_KEY='signal-scope-ui-refresh-drafts-v1';

export function saveDraftState({document,storage,scrollX=0,scrollY=0,now=Date.now()}) {
  try {
    const drafts={};
    for(const id of DRAFT_IDS){const input=document.getElementById(id);if(input && input.type!=='checkbox' && typeof input.value==='string')drafts[id]=input.value.slice(0,80);}
    storage.setItem(STORAGE_KEY,JSON.stringify({drafts,scrollX,scrollY,savedAt:now}));
    return true;
  }catch{return false;}
}

export function restoreDraftState({document,storage,scrollTo=()=>{},afterPaint=fn=>fn(),now=Date.now()}) {
  try {
    const raw=storage.getItem(STORAGE_KEY);storage.removeItem(STORAGE_KEY);
    if(!raw)return false;
    const value=JSON.parse(raw);
    if(!Number.isFinite(value.savedAt) || now-value.savedAt>30*60*1000 || value.savedAt>now+1000)return false;
    for(const id of DRAFT_IDS){const input=document.getElementById(id);if(input && input.type!=='checkbox' && typeof value.drafts?.[id]==='string')input.value=value.drafts[id].slice(0,80);}
    if(Number.isFinite(value.scrollX) && Number.isFinite(value.scrollY) && value.scrollX>=0 && value.scrollY>=0)afterPaint(()=>scrollTo(value.scrollX,value.scrollY));
    return true;
  }catch{return false;}
}

export function createVersionWatcher({getVersion,onChange,schedule=setTimeout,interval=1500}) {
  let initialVersion=null,stopped=false,reloading=false,inFlight=false;
  async function poll(){
    if(stopped || reloading || inFlight)return;
    inFlight=true;
    try {
      const version=await getVersion();
      if(typeof version!=='string' || !version || version.length>200)return;
      if(initialVersion===null)initialVersion=version;
      else if(version!==initialVersion){reloading=true;onChange();}
    }catch{
      // A temporary server restart/network failure is not a version change.
    }finally{
      inFlight=false;
      if(!stopped && !reloading)schedule(poll,interval);
    }
  }
  return {poll,stop(){stopped=true;}};
}

if(typeof window!=='undefined' && typeof document!=='undefined'){
  const storage={getItem:key=>sessionStorage.getItem(key),setItem:(key,value)=>sessionStorage.setItem(key,value),removeItem:key=>sessionStorage.removeItem(key)};
  restoreDraftState({document,storage,scrollTo:(x,y)=>window.scrollTo(x,y),afterPaint:fn=>requestAnimationFrame(()=>requestAnimationFrame(fn))});
  const watcher=createVersionWatcher({
    async getVersion(){
      const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),2000);
      try{const response=await fetch('/api/ui-version',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('UI version unavailable');return (await response.json()).version;}
      finally{clearTimeout(timeout);}
    },
    onChange(){saveDraftState({document,storage,scrollX:window.scrollX,scrollY:window.scrollY});location.reload();}
  });
  watcher.poll();
  window.addEventListener('pagehide',()=>watcher.stop(),{once:true});
}
