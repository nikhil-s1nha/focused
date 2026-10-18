// Scene-space start control: works in stereo without a DOM overlay.
export function createVrStart(THREE, scene) {
  const canvas=typeof document==='undefined'?null:document.createElement('canvas');
  if(canvas){canvas.width=1024;canvas.height=384;}
  const ctx=canvas?.getContext('2d');
  const texture=canvas?new THREE.CanvasTexture(canvas):null;
  if(texture)texture.colorSpace=THREE.SRGBColorSpace;
  const material=new THREE.MeshBasicMaterial({map:texture,color:0xffffff,depthTest:false,depthWrite:false,toneMapped:false});
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(1.65,.62),material);
  mesh.name='vr-start-button';mesh.renderOrder=100;mesh.visible=false;scene.add(mesh);
  const ray=new THREE.Raycaster();const direction=new THREE.Vector3();const position=new THREE.Vector3();
  let previous='';
  function paint(replay,hover){
    const key=`${replay}/${hover}`;if(previous===key)return;previous=key;
    if(!ctx)return;
    ctx.fillStyle=hover?'#ecd29a':'#c9aa6c';ctx.fillRect(0,0,1024,384);
    ctx.strokeStyle='#fff1cb';ctx.lineWidth=12;ctx.strokeRect(8,8,1008,368);
    ctx.textAlign='center';ctx.fillStyle='#17130b';ctx.font='bold 66px sans-serif';
    ctx.fillText(replay?'PLAY AGAIN':'START NIGHT WATCH',512,145);
    ctx.font='32px sans-serif';ctx.fillText('Point here • squeeze INDEX TRIGGER',512,225);
    ctx.font='27px sans-serif';ctx.fillText('Starts a 2-minute round with sound',512,290);
    texture.needsUpdate=true;
  }
  function show(camera,replay=false){
    camera.getWorldPosition(position);camera.getWorldDirection(direction);direction.y=0;
    if(direction.lengthSq()<.01)direction.set(0,0,-1);direction.normalize();
    mesh.position.copy(position).addScaledVector(direction,2);mesh.position.y=position.y-.12;
    mesh.lookAt(position);mesh.visible=true;mesh.updateMatrixWorld(true);paint(replay,false);
  }
  function hit(controller){
    if(!mesh.visible)return false;
    controller.updateWorldMatrix(true,false);mesh.updateWorldMatrix(true,false);
    ray.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    ray.ray.direction.set(0,0,-1).transformDirection(controller.matrixWorld);
    return ray.intersectObject(mesh,false).length>0;
  }
  return {mesh,show,hit,paint,hide(){mesh.visible=false;},dispose(){scene.remove(mesh);mesh.geometry.dispose();material.dispose();texture?.dispose();}};
}
