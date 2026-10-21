// Original photographic surface atlas, cropped in-browser to prevent quadrant
// bleed. All textures are owned/disposed by the room, including async loads.
export function loadRoomSurfaces(THREE, { keepTexture, apply, alive }) {
  if (typeof document === "undefined") return;
  const image = new Image();
  image.onload = () => {
    if (!alive()) return;
    const crop = (x,y) => {
      const c=document.createElement("canvas"); c.width=c.height=627;
      c.getContext("2d").drawImage(image,x*627,y*627,627,627,0,0,627,627);
      return c;
    };
    const sources={plaster:crop(0,0),tile:crop(1,0),steel:crop(0,1),concrete:crop(1,1)};
    const make = (source, repeatsX=1,repeatsY=1) => {
      const t=keepTexture(new THREE.CanvasTexture(source));
      t.colorSpace=THREE.SRGBColorSpace;
      t.wrapS=t.wrapT=THREE.MirroredRepeatWrapping;
      t.repeat.set(repeatsX,repeatsY);t.anisotropy=4;return t;
    };
    const c=document.createElement("canvas");c.width=2560;c.height=1024;
    const ctx=c.getContext("2d");
    // Continuous plaster at ~270 px/m. Lower panel is dark painted steel.
    for(let x=0;x<c.width;x+=1024) {
      ctx.save();ctx.translate(x,0);if((x/1024)%2){ctx.translate(1024,0);ctx.scale(-1,1);}
      ctx.drawImage(sources.plaster,0,0,1024,1024);ctx.restore();
    }
    for(let x=0;x<c.width;x+=800)ctx.drawImage(sources.steel,x,660,800,364);
    // Photograph plus baked contact occlusion: no vector blood, lettering,
    // fake highlights, handprint stamps or cartoon random surface markings.
    const band=(a,b,opacity)=>{const g=ctx.createLinearGradient(0,a,0,b);g.addColorStop(0,`rgba(8,9,6,${opacity})`);g.addColorStop(1,"rgba(8,9,6,0)");ctx.fillStyle=g;ctx.fillRect(0,Math.min(a,b),2560,Math.abs(b-a));};
    band(0,160,.67);band(1024,875,.7);band(672,720,.5);
    for(const [a,b] of [[0,210],[2560,2350]]){const g=ctx.createLinearGradient(a,0,b,0);g.addColorStop(0,"rgba(6,7,5,.57)");g.addColorStop(1,"rgba(6,7,5,0)");ctx.fillStyle=g;ctx.fillRect(Math.min(a,b),0,Math.abs(a-b),1024);}
    // Independent linear microheight, based on photographed aggregate only.
    const height=(source)=>{
      const h=document.createElement("canvas");h.width=h.height=627;
      const hc=h.getContext("2d");hc.drawImage(source,0,0);
      const pixels=hc.getImageData(0,0,627,627);
      for(let i=0;i<pixels.data.length;i+=4){const v=128+(pixels.data[i]*.22+pixels.data[i+1]*.65+pixels.data[i+2]*.13-128)*.32;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=v;}
      hc.putImageData(pixels,0,0);
      const t=make(h);t.colorSpace=THREE.NoColorSpace;return t;
    };
    apply({ wall:make(c), plaster:make(sources.plaster,2,2), floor:make(sources.tile,2.33,2.33), steel:make(sources.steel), concrete:make(sources.concrete), plasterBump:height(sources.plaster), steelBump:height(sources.steel) });
  };
  // Keep procedural fallback on network/image failure; never break room startup.
  image.src=new URL("../materials/room-surface-atlas.png",import.meta.url).href;
}
