// Mock DOM bridge regression suite; run with node tests/game-bridge.cjs.
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
let checks=0;function check(condition,label){assert.ok(condition,label);checks++;}
function newApp({storage=new Map()}={}){
const idMap=new Map(),callbacks=[],intervals=[];let clock=0,hosted=false,allow=true,started=false,elapsed=null,switchAllowed=true,events=0,lastEvent=null,showCalls=0,blocked=false;
class E{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={setProperty(k,v){this[k]=v;}};this.attributes={};this.listeners={};this.hidden=false;this.disabled=false;this.open=false;this.value='';this.scrollTop=0;this.clientHeight=400;this.scrollHeight=1000;this.parentElement=null;this._class='';this._text='';const self=this;this.classList={add(...xs){let z=new Set(self._class.split(' ').filter(Boolean));xs.forEach(x=>z.add(x));self._class=[...z].join(' ');},remove(...xs){self._class=self._class.split(' ').filter(x=>!xs.includes(x)).join(' ');},toggle(x,f){const val=f===undefined?!this.contains(x):f;val?this.add(x):this.remove(x);return val;},contains(x){return self._class.split(' ').includes(x);}};}
 set className(v){this._class=v;}get className(){return this._class;}set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
 set innerHTML(v){this._text='';this.children=[];if(String(v).includes('<svg'))this.append(new E('svg'));}get innerHTML(){return '';}
 append(...items){for(const x of items){if(x==null)continue;x.parentElement=this;this.children.push(x);}}appendChild(x){this.append(x);return x;}replaceChildren(...xs){this.children=[];this._text='';this.append(...xs);}remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(c=>c!==this);}
 setAttribute(k,v){this.attributes[k]=String(v);if(k==='class')this.className=String(v);if(k==='id'){this.id=String(v);idMap.set(this.id,this);}if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,a)=>a.toUpperCase())]=String(v);}getAttribute(k){return this.attributes[k]??null;}hasAttribute(k){return k.startsWith('data-')?Object.hasOwn(this.dataset,k.slice(5).replace(/-([a-z])/g,(_,a)=>a.toUpperCase())):Object.hasOwn(this.attributes,k);}removeAttribute(k){delete this.attributes[k];}
 addEventListener(name,cb){(this.listeners[name]??=[]).push(cb);}dispatch(name,extra={}){const event={target:this,currentTarget:this,preventDefault(){},stopPropagation(){},...extra};for(const cb of this.listeners[name]??[])cb(event);return event;}
 matches(sel){sel=sel.trim();if(sel.startsWith('.'))return this.classList.contains(sel.slice(1));if(sel.startsWith('#'))return this.id===sel.slice(1);const attr=sel.match(/^\[([^=\]]+)(?:="?([^"\]]+)"?)?\]$/);if(attr){const name=attr[1];const v=name.startsWith('data-')?this.dataset[name.slice(5).replace(/-([a-z])/g,(_,a)=>a.toUpperCase())]:this.getAttribute(name);return v!==undefined&&v!==null&&(attr[2]===undefined||String(v)===attr[2]);}return this.tagName===sel.toUpperCase();}
 querySelectorAll(sel){const result=[];const visit=e=>{for(const c of e.children){if(sel.split(',').some(s=>c.matches(s)))result.push(c);visit(c);}};visit(this);return result;}querySelector(sel){return this.querySelectorAll(sel)[0]??null;}closest(sel){let e=this;while(e){if(sel.split(',').some(s=>e.matches(s)))return e;e=e.parentElement;}return null;}contains(e){return this===e||this.children.some(c=>c.contains(e));}
 focus(){}showModal(){this.open=true;}close(){this.open=false;this.dispatch('close');}getBoundingClientRect(){return {left:0,top:0,width:600,height:400,right:600,bottom:400};}scrollIntoView(){}scrollBy(){}setPointerCapture(){}releasePointerCapture(){}hasPointerCapture(){return false;}
}
const body=new E('body');for(const m of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){const e=new E(m[1]);e.setAttribute('id',m[3]);for(const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g))e.setAttribute(a[1],a[2]);body.append(e);}
idMap.get('jigsawProgress').parentElement.setAttribute('role','progressbar');const preview=new E('span');preview.setAttribute('data-preview-label','');idMap.get('previewButton').append(preview);
const docListeners={};const winListeners={};const local=storage;
const document={body,documentElement:new E('html'),getElementById:id=>idMap.get(id)||null,createElement:t=>new E(t),createElementNS:(_,t)=>new E(t),addEventListener(n,cb){(docListeners[n]??=[]).push(cb);},querySelector:sel=>body.querySelector(sel),querySelectorAll:sel=>body.querySelectorAll(sel),elementFromPoint(){return null;}};
const LiveParty={canInteract:()=>allow,canSwitch:()=>switchAllowed,isMatch:()=>hosted,elapsedFor:()=>elapsed,blocksGameInput:()=>blocked,onGameRender(game,result){events++;lastEvent={game,result};},showScoreboard(){showCalls++;}};
const window={LiveParty,addEventListener(n,cb){(winListeners[n]??=[]).push(cb);}};
const context=vm.createContext({window,document,localStorage:{getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,v)},performance:{now:()=>clock},Date,Math,JSON,Set,Map,Number,String,Array,Object,Uint32Array,console,crypto:{randomUUID:()=>Math.random().toString()},setInterval:cb=>intervals.push(cb),setTimeout:cb=>callbacks.push(cb),clearTimeout(){},requestAnimationFrame:cb=>cb(),cancelAnimationFrame(){},matchMedia:()=>({matches:true}),getComputedStyle:()=>({}),navigator:{},URL,Blob,TextEncoder});
const script=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).sort((a,b)=>b.length-a.length)[0];vm.runInContext(script,context);
return {run:s=>vm.runInContext(s,context),bridge:window.PartyGameBridge,el:id=>idMap.get(id),context,window,local,tick(ms){clock+=ms;intervals.forEach(cb=>cb());},getEvent:()=>lastEvent,eventCount:()=>events,set(p){if('hosted'in p)hosted=p.hosted;if('allow'in p)allow=p.allow;if('elapsed'in p)elapsed=p.elapsed;if('switchAllowed'in p)switchAllowed=p.switchAllowed;if('blocked'in p)blocked=p.blocked;},getShowCalls:()=>showCalls,key(key){for(const cb of docListeners.keydown??[])cb({key,target:body,preventDefault(){}});}};
}
const app=newApp();
check(app.run('activeGame')==='words','Game 1 still default');
check(app.bridge.score('words').score===0&&app.bridge.score('jigsaw').score===0,'Both games start empty');
check(app.bridge.begin('bad')===false,'Unknown game rejected');
app.run('hint()');check(app.bridge.snapshot('words').states[0].hint,'Standalone hint works');
app.bridge.begin('words');app.set({hosted:true,allow:false,switchAllowed:false,blocked:true});
const locked=JSON.stringify(app.bridge.snapshot('words'));app.run('hint();reveal();next();goTo(4);WordArrange.clear();WordArrange.submit();startGame();switchGame("jigsaw");');app.key('r');
check(JSON.stringify(app.bridge.snapshot('words'))===locked,'Hosted words all interactions blocked while waiting');check(app.run('activeGame')==='words','Hosted game switch blocked');
app.bridge.begin('jigsaw');const jl=JSON.stringify(app.bridge.snapshot('jigsaw'));app.run('Jigsaw.togglePreview();Jigsaw.next();Jigsaw.previous();Jigsaw.goTo(4);Jigsaw.resetAll();Jigsaw.resetCurrent();');
check(JSON.stringify(app.bridge.snapshot('jigsaw'))===jl,'Hosted jigsaw hints navigation and resets blocked while waiting');
app.bridge.begin('words');check(app.run('activeGame')==='words','Bridge begin bypasses switch lock');
app.set({allow:true,blocked:false});app.run('hint();goTo(2);');check(app.bridge.snapshot('words').index===2,'Hosted gameplay works after start');
const snap=app.bridge.snapshot('words');snap.states[2].arrangement[0]=0;app.bridge.begin('words',snap);check(app.bridge.snapshot('words').states[2].arrangement[0]===0,'Valid word arrangement restores');
snap.states[2].arrangement[0]=null;check(app.bridge.snapshot('words').states[2].arrangement[0]===0,'Restored words are detached from saved objects');
let bad=app.bridge.snapshot('words');bad.states[2].checked=true;app.bridge.begin('words',bad);check(app.bridge.score('words').score===0&&app.bridge.snapshot('words').index===0,'Forged checked flag rejected');
for(const tamper of [s=>s.states[0].arrangement[0]=999,s=>s.states[0].arrangement[0]=-1,s=>s.states[0].arrangement=[0,0,2,3,4,5],s=>s.states[0].scrambled='ZZZZZZ',s=>s.index=21,s=>s.states.pop()]){let value=app.bridge.snapshot('words');tamper(value);app.bridge.begin('words',value);check(app.bridge.snapshot('words').index===0&&app.bridge.score('words').score===0,'Malformed word snapshot rejected');}
app.bridge.begin('words');
const beforeTile=app.eventCount();
app.el('letters').dispatch('click',{target:app.el('letters').children[0],detail:0});
app.el('answerSlots').dispatch('click',{target:app.el('answerSlots').children[0],detail:0});
check(app.bridge.snapshot('words').states[0].arrangement[0]===0,'Hosted tap can place a scrambled letter');
check(app.eventCount()>beforeTile&&app.getEvent().result.snapshot.states[0].arrangement[0]===0,'Tile movement emits snapshot hook before answer submission');
const all=app.bridge.snapshot('words');const answers=JSON.parse(app.run('JSON.stringify(WORDS)'));for(let i=0;i<all.states.length;i++){const s=all.states[i],used=new Set();s.arrangement=[...answers[i]].map(letter=>{const id=[...s.scrambled].findIndex((c,j)=>c===letter&&!used.has(j));used.add(id);return id;});s.checked=true;s.submission='correct';}
all.index=19;all.states[19].checked=false;all.states[19].submission=null;all.states[19].revealed=false;
app.bridge.begin('words',all);check(app.bridge.score('words').score===19,'Final word prepared without awarding a point');
app.run('WordArrange.submit()');check(app.bridge.score('words').score===20&&app.bridge.score('words').finished,'All correct words finish automatically');check(app.getEvent().result.finished&&app.getEvent().result.score===20,'Completion hook fires before Finish click');
const events=app.eventCount();app.bridge.showResult('words');check(app.bridge.snapshot('words').finished&&app.eventCount()===events,'showResult hides play without recursive callback');
check(app.el('wordsResultPanel').hidden,'Normal result panel stays hidden after hosted showResult');
app.set({allow:false});const complete=JSON.stringify(app.bridge.snapshot('words'));app.run('goTo(0);startGame();WordArrange.clear();');check(JSON.stringify(app.bridge.snapshot('words'))===complete,'Finished hosted word state cannot restart');
app.el('wordsPlayerName').value='Test';app.el('wordsNameForm').dispatch('submit');check(app.local.size===0,'Hosted results cannot save to public local leaderboard');
app.el('scoreboardButton').dispatch('click');check(app.getShowCalls()===1&&!app.el('scoreboardDialog').open,'Scoreboard delegates to hidden/revealed room results');
app.set({elapsed:123450});app.tick(1000);check(app.el('wordsTimer').textContent==='02:03','Hosted clock uses shared elapsed while local timer stopped');
app.bridge.setHostedClock('words',98760);check(app.el('wordsTimer').textContent==='01:38'&&app.el('wordsResultTime').textContent==='01:38.76','Bridge can paint hosted clock precisely');
app.set({allow:true});app.bridge.begin('jigsaw');let j=app.bridge.snapshot('jigsaw');j.index=7;j.states[7].placed=[0,4];j.states[7].preview=true;app.bridge.begin('jigsaw',j);check(app.bridge.score('jigsaw').score===2&&app.bridge.snapshot('jigsaw').index===7,'Jigsaw snapshot restores pieces and index');j.states[7].placed.push(5);check(app.bridge.score('jigsaw').score===2,'Jigsaw restored arrays detached');
for(const tamper of [s=>s.states[0].placed=[0,0],s=>s.states[0].placed=[6],s=>s.states[0].order=[0,1,2,3,4,4],s=>s.states[0].order=[0,1],s=>s.states[0].preview='yes',s=>s.index=-1]){let value=app.bridge.snapshot('jigsaw');tamper(value);app.bridge.begin('jigsaw',value);check(app.bridge.score('jigsaw').score===0&&app.bridge.snapshot('jigsaw').index===0,'Malformed jigsaw snapshot rejected');}
j=app.bridge.snapshot('jigsaw');for(const s of j.states)s.placed=[0,1,2,3,4,5];j.index=19;j.states[19].placed.pop();app.bridge.begin('jigsaw',j);
check(app.bridge.score('jigsaw').score===119,'Final puzzle piece prepared without awarding its point');
app.el('pieceTray').dispatch('click',{target:app.el('pieceTray').children[0],detail:0});
app.el('boardSlots').dispatch('click',{target:app.el('boardSlots').children[5],detail:0});
check(app.bridge.score('jigsaw').score===120&&app.getEvent().result.finished,'Final real piece placement automatically emits completed 120-piece score');
app.set({hosted:false,allow:true,elapsed:null,switchAllowed:true});app.run('startGame();switchGame("words");hint();');check(app.bridge.score('words').score===0&&app.bridge.snapshot('words').states[0].hint,'Standalone play works after leaving hosted room');
// Legacy v1 saves are deliberately in the old time-first order. Slow full scores
// occur beyond the 100-run retention limit, so ranking must precede truncation.
const leaderboardKey='genderReveal.leaderboard.v1';
const oldEntries=['words','jigsaw'].flatMap(game=>{
 const maxScore=game==='words'?20:120;
 const make=(id,name,score,timeMs)=>({game,id:game+'-'+id,name,score,maxScore,timeMs,savedAt:1000,updatedAt:1000});
 return [
  ...Array.from({length:103},(_,i)=>make('quick-'+i,'Quick partial '+i,maxScore-5,1000+i*10)),
  make('best-fast','Best faster',maxScore,100000),
  make('best-slow','Best slower',maxScore,200000)
 ];
});
const oldStorageValue=JSON.stringify({version:1,entries:oldEntries});
const localApp=newApp({storage:new Map([[leaderboardKey,oldStorageValue]])});
const localNames=body=>body.children.map(row=>row.children[1].textContent);
for(const game of ['words','jigsaw']){
 const body=localApp.el(game+'LeaderboardBody');
 check(body.children.length===10,'Existing '+game+' leaderboard still displays top 10');
 check(localNames(body).slice(0,3).join('|')==='Best faster|Best slower|Quick partial 0',
  'Existing '+game+' finish board puts full scores before quicker partial scores and breaks equal scores by time');
}
localApp.el('scoreboardButton').dispatch('click');
for(const button of ['scoreboardWordsButton','scoreboardJigsawButton']){
 localApp.el(button).dispatch('click');
 check(localNames(localApp.el('scoreboardLeaderboardBody')).slice(0,3).join('|')==='Best faster|Best slower|Quick partial 0',
  button+' uses score-first order for previously saved results');
}
check(localApp.local.get(leaderboardKey)===oldStorageValue,'Reading and reordering existing saves requires no migration or storage rewrite');
localApp.el('scoreboardBackButton').dispatch('click');
for(const game of ['words','jigsaw']){
 const maxScore=game==='words'?20:120;
 // Exercise the result controller, name form, persisted save, rank notice and
 // both rendered boards; use a slower new score to distinguish rank from time.
 localApp.run('PartyResults.reset('+JSON.stringify(game)+');switchGame('+JSON.stringify(game)+');PartyResults.start('+JSON.stringify(game)+');');
 localApp.tick(300000);
 localApp.run('PartyResults.finish('+JSON.stringify(game)+',{score:'+(maxScore-4)+',maxScore:'+maxScore+',eligible:true})');
 localApp.el(game+'PlayerName').value='New partial';
 localApp.el(game+'NameForm').dispatch('submit');
 check(localNames(localApp.el(game+'LeaderboardBody')).slice(0,4).join('|')==='Best faster|Best slower|New partial|Quick partial 0',
  'Saving '+game+' keeps slower higher score above faster lower scores');
 check(localApp.el(game+'ResultMessage').textContent.includes('#3'),'Saved '+game+' notice uses score-first rank');
 const saved=JSON.parse(localApp.local.get(leaderboardKey));
 const gameEntries=saved.entries.filter(entry=>entry.game===game);
 check(saved.version===1&&gameEntries.length===100&&gameEntries[0].name==='Best faster'&&gameEntries[2].name==='New partial',
  'Saving '+game+' retains best 100 using existing schema');
 localApp.el('scoreboardButton').dispatch('click');
 check(localNames(localApp.el('scoreboardLeaderboardBody')).slice(0,4).join('|')==='Best faster|Best slower|New partial|Quick partial 0',
  'Direct '+game+' scoreboard immediately matches saved result ranking');
 localApp.el('scoreboardBackButton').dispatch('click');
}
console.log(`${checks} game bridge and local leaderboard checks passed.`);
