/* Game illustration is separate from score and consent controls. */
(() => {
 const comparison=document.getElementById('result-comparison');if(!comparison)return;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const make=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text!==undefined)e.textContent=text;return e;};
 const board=`<svg viewBox="0 0 180 150" fill="none" aria-hidden="true"><path d="M23 121h132M38 132V20" stroke="currentColor" opacity=".25"/><path d="M35 106c28 0 29-66 57-66s29 66 57 66" stroke="var(--rose)" stroke-width="2"/><circle cx="92" cy="40" r="4" fill="var(--rose)"/><path d="m64 108 44-42 35 42H64Z" stroke="var(--foam)" stroke-width="1.5" opacity=".7"/><path d="M17 21h24m-12-12v24M137 25l11 6-11 6m-6-6h23" stroke="currentColor" opacity=".4" stroke-linecap="round"/></svg>`;
 const laurel=`<svg viewBox="0 0 80 80" fill="none" aria-hidden="true"><path d="M31 66C7 53 10 29 21 17M49 66c24-13 21-37 10-49" stroke="currentColor" stroke-width="2"/><path d="M18 26c-9-1-11-6-10-12 7 0 11 5 10 12Zm-4 14C4 39 2 33 3 27c8 1 12 6 11 13Zm4 14C8 54 4 48 5 42c8 0 13 5 13 12Zm8 10c-10 4-15 0-17-6 8-3 14-2 17 6ZM62 26c9-1 11-6 10-12-7 0-11 5-10 12Zm4 14c10-1 12-7 11-13-8 1-12 6-11 13Zm-4 14c10 0 14-6 13-12-8 0-13 5-13 12Zm-8 10c10 4 15 0 17-6-8-3-14-2-17 6Z" fill="currentColor"/></svg>`;
 let scene=document.getElementById('victory-scene');let signature='';const awarded=new Set();
 function draw(next){
  if(!next||next.phase!=='finished'||document.body.dataset.roundReview==='true')return;
  const players=[next.players.find(p=>p.id===next.me),next.players.find(p=>p.id!==next.me)].filter(Boolean);
  const key=JSON.stringify([next.code,next.round,next.result?.winner,next.appeals_pending,players.map(p=>[p.id,p.name])]);if(signature===key&&scene?.isConnected)return;signature=key;
  if(!scene){scene=make('div','victory-scene');scene.id='victory-scene';scene.setAttribute('aria-hidden','true');comparison.before(scene);}
  const winner=next.appeals_pending?null:next.result?.winner;
  scene.dataset.outcome=next.appeals_pending?'pending':winner?'winner':'draw';
  const floor=make('div','podium-floor');const art=make('div','victory-maths');art.innerHTML=board;
  const award=make('div','game-award');const image=document.createElement('img');image.src='/static/sandwich.svg';image.alt='';award.append(image);
  const caption=make('span','game-award-caption',next.appeals_pending?'Ждём решения по апелляции':winner?winner===next.me?'Бутерброд — ваш':`Бутерброд получает ${players.find(p=>p.id===winner)?.name || 'победитель'}`:'В этот раз — ничья');award.append(caption);
  const podiums=make('div','podium-pair');
  for(const p of players){
   const won=p.id===winner;const place=make('div','podium-place'+(won?' is-winner':''));place.dataset.player=p.id;place.style.setProperty('--step-height',winner?(won?'92px':'48px'):'66px');
   const person=make('div','podium-person');const name=make('span','podium-name',p.name+(p.id===next.me?' (вы)':''));person.append(name);
   const step=make('div','podium-step');if(won){const wreath=make('span','podium-laurel');wreath.innerHTML=laurel;step.append(wreath);}
   const stamp=make('span','podium-stamp',won?'Победа':next.appeals_pending?'Раунд завершён':winner?'Раунд завершён':'Ничья');step.append(stamp);place.append(person,step);podiums.append(place);
  }
  scene.replaceChildren(art,floor,podiums,award);
  const awardKey=`math-award:${next.code}:${next.round}`;let seen=awarded.has(awardKey);try{seen ||=sessionStorage.getItem(awardKey)==='1';}catch{}
  if(winner&&!seen){awarded.add(awardKey);try{sessionStorage.setItem(awardKey,'1');}catch{}
   if(!reduced.matches){image.animate([{transform:'translateY(-18px) rotate(-8deg)',opacity:0},{transform:'translateY(0) rotate(0)',opacity:1}],{duration:280,easing:'cubic-bezier(.23,1,.32,1)'});scene.querySelectorAll('.podium-person').forEach((e,i)=>e.animate([{transform:'translateY(8px)',opacity:0},{transform:'translateY(0)',opacity:1}],{duration:220+i*30,easing:'cubic-bezier(.23,1,.32,1)'}));}
  }
 }
 const match=document.querySelector('.match-strip');if(match){const sketch=make('div','lobby-sketch');sketch.setAttribute('aria-hidden','true');sketch.innerHTML=board;match.prepend(sketch);}
 window.addEventListener('math:state',event=>draw(event.detail));if(typeof state!=='undefined'&&state)draw(state);
 reduced.addEventListener('change',event=>{if(event.matches)scene?.getAnimations({subtree:true}).forEach(animation=>animation.cancel());});
})();
