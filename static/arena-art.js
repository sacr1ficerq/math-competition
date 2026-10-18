/* Each illustration has its own spring; controls never enter the motion tree. */
(() => {
 const scene=document.querySelector('.math-arena');if(!scene)return;
 const pieces=[...scene.querySelectorAll('[data-parallax-depth]')].map(el=>({el,depth:Number(el.dataset.parallaxDepth),spring:Number(el.dataset.parallaxSpring),x:0,y:0,vx:0,vy:0}));
 const pointer=matchMedia('(hover: hover) and (pointer: fine)'),reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let targetX=0,targetY=0,frame=0,last=0;
 function reset(){cancelAnimationFrame(frame);frame=0;last=0;targetX=targetY=0;for(const p of pieces){p.x=p.y=p.vx=p.vy=0;p.el.style.transform='';}}
 function tick(time){const dt=last?Math.min((time-last)/16.667,2):1;last=time;let moving=false;for(const p of pieces){p.vx=(p.vx+(targetX*p.depth-p.x)*p.spring*dt)*Math.pow(.72,dt);p.vy=(p.vy+(targetY*p.depth-p.y)*p.spring*dt)*Math.pow(.72,dt);p.x+=p.vx*dt;p.y+=p.vy*dt;p.el.style.transform=`translate3d(${p.x.toFixed(3)}px,${p.y.toFixed(3)}px,0) rotate(${(p.x*.12).toFixed(3)}deg)`;moving ||=Math.abs(targetX*p.depth-p.x)+Math.abs(targetY*p.depth-p.y)+Math.abs(p.vx)+Math.abs(p.vy)>.025;}if(moving)frame=requestAnimationFrame(tick);else{frame=0;last=0;}}
 function start(){if(!frame)frame=requestAnimationFrame(tick);}
 document.addEventListener('pointermove',e=>{if(!pointer.matches||reduced.matches||scene.closest('[hidden]'))return;const r=scene.getBoundingClientRect();targetX=Math.max(-1,Math.min(1,(e.clientX-(r.left+r.width/2))/(innerWidth*.55)));targetY=Math.max(-1,Math.min(1,(e.clientY-(r.top+r.height/2))/(innerHeight*.65)));start();},{passive:true});
 document.documentElement.addEventListener('pointerleave',()=>{targetX=targetY=0;if(pointer.matches&&!reduced.matches)start();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});pointer.addEventListener('change',reset);reduced.addEventListener('change',reset);
})();
