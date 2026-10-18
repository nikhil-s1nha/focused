// Import into the game. No token belongs in browser code.
export function connectSignals({onSignal, onStatus=()=>{}, url='/signal-link/events'}) {
  const stream=new EventSource(url);
  onStatus('connecting');
  stream.onopen=()=>onStatus('connected');
  stream.onerror=()=>onStatus('reconnecting');
  const seen=new Set();
  stream.onmessage=message=>{
    let event;try{event=JSON.parse(message.data);}catch{return;}
    if(event.schema!=='signal-scope.event.v1' || !['manual_test','manual_marker'].includes(event.source) || seen.has(event.id))return;
    seen.add(event.id);if(seen.size>1000)seen.delete(seen.values().next().value);
    onSignal(event);
  };
  return ()=>{stream.close();onStatus('disconnected');};
}
