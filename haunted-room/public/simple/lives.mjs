export class Lives {
  constructor(max=5){this.max=max;this.reset();}
  reset(){this.remaining=this.max;this.hits=new Set();}
  attack(id,looking){
    if(this.remaining===0||this.hits.has(id))return false;
    this.hits.add(id);
    if(looking)return false;
    this.remaining--;return true;
  }
}
