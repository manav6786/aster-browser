'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const E = escapeHTML;
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const glyphs = {
  back:'<path d="m12 5-7 7 7 7"/>',forward:'<path d="m8 5 7 7-7 7"/>',reload:'<path d="M18 8a7 7 0 1 0 1 7M18 3v5h-5"/>',stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',
  search:'<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8.5 11.5 2.3 2.3 4.7-5"/>',
  grid:'<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',sidebar:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  bookmark:'<path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4Z"/>',history:'<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6m3-4v6l4 2"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  settings:'<path d="m9.5 3-.7 2.2-2.2 1-2.1-.6L3 8.2l1.5 1.7v2.5L3 14l1.5 2.7 2.2-.6 2.1 1 .7 2.3h3l.7-2.3 2.1-1 2.2.6L19 14l-1.5-1.6V10L19 8.2l-1.5-2.6-2.1.6-2.2-1L12.5 3Z"/><circle cx="11" cy="11.2" r="3"/>',
  team:'<path d="M5 17v-1a4 4 0 0 1 4-4h3a4 4 0 0 1 4 4v1M16 7a3 3 0 0 1 0 6m3 4v-1a4 4 0 0 0-2-3"/><circle cx="10.5" cy="7" r="3"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/>',lock:'<rect x="6" y="10" width="12" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',plus:'<path d="M12 5v14M5 12h14"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',external:'<path d="M14 3h7v7m0-7-11 11M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/>',code:'<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20"/>',
  moon:'<path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z"/>',sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  pin:'<path d="m8 3 8 0-1 6 3 3v2H6v-2l3-3ZM12 14v7"/>',mute:'<path d="M11 4 6 8H3v8h3l5 4ZM16 9l6 6m0-6-6 6"/>',volume:'<path d="M11 4 6 8H3v8h3l5 4Zm5 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  folder:'<path d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/>',trash:'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  edit:'<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14Z"/>',private:'<path d="M3 12s3-5 9-5 9 5 9 5-3 5-9 5-9-5-9-5Z"/><path d="M3 3l18 18"/>',check:'<path d="m5 12 4 4L19 6"/>',
  spark:'<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z"/>',keyboard:'<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M7 16h10"/>',warning:'<path d="m12 3 10 18H2ZM12 9v5m0 3h.01"/>',pip:'<rect x="3" y="4" width="18" height="16" rx="3"/><rect x="11" y="11" width="8" height="6" rx="1"/>',vpn:'<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z"/><rect x="9" y="10" width="6" height="5" rx="1"/><path d="M10 10V8a2 2 0 0 1 4 0v2"/>'
};
const icon = (name, attrs = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${attrs}>${glyphs[name] || glyphs.globe}</svg>`;
let S = {tabs:[], activeTabId:null, activeWorkspace:'personal',workspaces:[],bookmarks:[],history:[],downloads:[],agents:[],activity:[],settings:{},shields:{},automation:{},missionOpen:false};
let floating = null, paletteOpen = false, dialogOpen = false, overlaySent = false, pageKey = '', missionPage = 0, missionWorkspace = 'all', missionQuery = '', pageQuery = '', draggedTab = null, paletteIndex = 0, paletteItems = [], toastTimer;
let transientGeneration = 0;
let transientFocusAnchor = null;
let missionRenderKey = '';
let sidebarMode = null, sidebarIntent = null, sidebarMutation = 0, sidebarMotion = [], sidebarMotionFrame = 0, sidebarMotionNumber = 0;
let searchSession = null, searchGeneration = 0, searchTimer = 0, searchOpenPromise = null;
let restoringFieldFocus = false;
let addressEdited = false;
let sidebarRenderKey = '', mediaTabId = null, mediaInfo = null, mediaGeneration = 0, mediaPoll = 0, mediaVideoId = null;
let volumeTimer = 0, volumeRequest = 0, pendingVolume = null;
const interactionAnimations = new Set(), elementMotions = new WeakMap(), closingTabs = new Set();
const accentColors = {
  purple:['#7655cf','#bca0ff','118,85,207'], blue:['#2868c7','#8ab8ff','40,104,199'],
  teal:['#087d79','#70dbd4','8,125,121'], green:['#2b7b47','#8bdda4','43,123,71'],
  amber:['#976215','#e9bd6b','151,98,21'], rose:['#b23d68','#f4a3c0','178,61,104']
};
const api = window.aster;
const macOS = (api.platform || 'darwin') === 'darwin';
const shortcut = label => macOS ? label : label.replace(/⌘\s*/g, 'Ctrl+').replace(/⇧\s*/g, 'Shift+');
document.documentElement.dataset.windowFrame = macOS ? 'custom' : 'system';
for (const element of $$('[title*="⌘"]')) element.title = shortcut(element.title);
for (const hint of $$('kbd, .palette-footer span')) hint.textContent = shortcut(hint.textContent);
const activeTab = () => S.tabs.find(t => t.id === S.activeTabId);
const currentWorkspace = () => S.workspaces.find(w => w.id === S.activeWorkspace) || S.workspaces[0];
const host = url => { try { return new URL(url).hostname.replace(/^www\./,''); } catch { return url || ''; } };
const initial = value => (value || 'A').replace(/^https?:\/\//,'').replace(/^www\./,'').charAt(0).toUpperCase();
const relative = value => {const n = Date.now() - new Date(value || Date.now()).getTime(); return n < 60000 ? 'Just now' : n < 3600000 ? `${Math.floor(n/60000)}m ago` : n < 86400000 ? `${Math.floor(n/3600000)}h ago` : new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric'});};
const number = value => Number(value || 0).toLocaleString();
const bytes = value => value > 1048576 ? `${(value/1048576).toFixed(1)} MB` : `${Math.round((value||0)/1024)} KB`;
const internalRoute = () => {const u = activeTab()?.url || 'aster://newtab';return u.startsWith('aster://') ? u.slice(8).split(/[/?#]/)[0] || 'newtab' : null;};
const cssColor = value => /^#[\da-f]{3,8}$/i.test(value || '') ? value : '#a18acb';
const agentColor = id => {let h=0;for(const c of String(id))h=(h*31+c.charCodeAt(0))>>>0;return ['#a38ac6','#709bb1','#bf9981','#84a693','#bc83a7','#8d99c7'][h%6];};
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(()=>$('#toast').classList.remove('visible'),4200); }
async function invoke(command, payload = {}) { try { return await api.invoke(command,payload); } catch (error) { toast(error?.message || String(error)); return null; } }
async function syncOverlay() {const open=!!(floating||paletteOpen||dialogOpen);if(open!==overlaySent){overlaySent=open;await invoke('ui:overlay',{open});renderPage(true);}}
async function go(url, newTab = false) { await closeFloating(); if(paletteOpen) await closePalette(); await invoke(newTab?'tab:new':'tab:navigate',{url}); }
function fillStaticIcons() { const names={'mission':'grid','back':'back','forward':'forward','reload':'reload','bookmark':'bookmark','shields':'shield','menu':'more'};for(const [action,name]of Object.entries(names))for(const el of $$(`.icon-button[data-action="${action}"]`))el.innerHTML=icon(name);$('#sidebar-toggle').innerHTML=`<span class="toggle-panel-glyph">${icon('sidebar')}</span><span class="toggle-star-glyph">${icon('spark')}</span>`;for(const el of $$('.sidebar-tools [data-route]'))el.innerHTML=icon({bookmarks:'bookmark',history:'history',downloads:'download',settings:'settings'}[el.dataset.route]);$('.team-symbol').innerHTML=icon('team');$('.palette-icon').innerHTML=icon('search'); }
function setTheme() {
  const dark=S.settings.theme==='dark'||(S.settings.theme!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches);
  document.documentElement.classList.toggle('dark',dark);
  const accent=Object.hasOwn(accentColors,S.settings.accent)?S.settings.accent:'purple',colors=accentColors[accent];
  const root=document.documentElement;root.dataset.accent=accent;root.dataset.transparency=S.settings.transparency===true&&!S.nativeGlass?.reducedTransparency?'on':'off';
  root.style.setProperty('--accent',colors[dark?1:0]);root.style.setProperty('--accent-rgb',colors[2]);
  root.style.setProperty('--accent-soft',`rgba(${colors[2]},${dark?.2:.1})`);
  root.style.setProperty('--on-accent',dark?'#080808':'#fff');
  const collapsed=!!S.settings.sidebarCollapsed, changed=sidebarMode!==null&&sidebarMode!==collapsed;
  $('#app').classList.toggle('collapsed',collapsed);
  if(sidebarMode===null||changed) positionSidebarToggle(changed);
  if(changed)requestAnimationFrame(()=>$('#spaces .space-chip.active')?.scrollIntoView({block:'nearest'}));
  sidebarMode=collapsed;
}
function animateElement(element,frames,options={}) {
  if(!element||matchMedia('(prefers-reduced-motion: reduce)').matches)return null;
  elementMotions.get(element)?.cancel();
  const animation=element.animate(frames,{duration:280,easing:'cubic-bezier(.2,.8,.25,1)',...options});
  elementMotions.set(element,animation);interactionAnimations.add(animation);
  animation.finished.then(()=>interactionAnimations.delete(animation),()=>interactionAnimations.delete(animation));return animation;
}
function cartoonEnter(element,kind='popover') {
  const frames=kind==='dialog'?[{opacity:0,transform:'translateY(18px) scale(.86,.94) rotate(-1.5deg)'},{opacity:1,transform:'translateY(-3px) scale(1.025,.99)',offset:.7},{opacity:1,transform:'none'}]
    :kind==='tab'?[{opacity:.25,transform:'translateY(10px) scale(.86,1.06)'},{opacity:1,transform:'translateY(-2px) scale(1.035,.98)',offset:.7},{opacity:1,transform:'none'}]
    :[{opacity:0,transform:'translateY(-7px) scale(.9,.96) rotate(-1deg)'},{opacity:1,transform:'translateY(1px) scale(1.015,1.025)',offset:.7},{opacity:1,transform:'none'}];
  return animateElement(element,frames,{duration:kind==='dialog'?340:290});
}
function starBurst(rect,variation=0) {
  if(!rect||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const layer=$('#interaction-motion-layer');for(const node of [...layer.children].slice(0,Math.max(0,layer.children.length-9))){elementMotions.get(node)?.cancel();node.remove();}
  for(let i=0;i<5;i++){
    const star=document.createElement('span');star.className='interaction-spark';star.textContent=i%2?'✧':'✦';
    const angle=i*Math.PI*.4+variation*.6,x=Math.max(8,Math.min(innerWidth-8,rect.x+rect.width/2)),y=Math.max(8,Math.min(innerHeight-8,rect.y+rect.height/2));
    Object.assign(star.style,{left:`${x}px`,top:`${y}px`,fontSize:`${8+i%3*3}px`});layer.append(star);
    const animation=animateElement(star,[{opacity:0,transform:'translate(-50%,-50%) scale(.25)'},{opacity:.85,offset:.2},{opacity:0,transform:`translate(calc(-50% + ${Math.cos(angle)*30}px),calc(-50% + ${Math.sin(angle)*24}px)) rotate(${i*20}deg) scale(1)`}],{duration:360+i*20});
    animation?.finished.then(()=>star.remove(),()=>star.remove());
  }
}
function stopInteractionMotion(){for(const animation of interactionAnimations)animation.cancel();interactionAnimations.clear();$('#interaction-motion-layer').replaceChildren();}
async function closeTabWithMotion(id) {
  if(closingTabs.has(id))return;closingTabs.add(id);
  try{const node=$$('[data-tab-id]').find(el=>el.dataset.tabId===id);starBurst(node?.getBoundingClientRect(),1);
    const animation=animateElement(node,[{opacity:1,transform:'none'},{opacity:0,transform:'translateX(-18px) scale(.82,.6) rotate(-3deg)'}],{duration:150,easing:'ease-in'});
    if(animation)await animation.finished.catch(()=>{});await invoke('tab:close',{id});
  }finally{closingTabs.delete(id);}
}
function stopSidebarMotion() {
  cancelAnimationFrame(sidebarMotionFrame);sidebarMotionFrame=0;
  for(const animation of sidebarMotion)animation.cancel();sidebarMotion=[];
  $('#sidebar-motion-layer').replaceChildren();
  $('#sidebar-toggle').classList.remove('in-flight');
}
function positionSidebarToggle(animate=false) {
  const button=$('#sidebar-toggle'), first=button.getBoundingClientRect(), app=$('#app').getBoundingClientRect();
  stopSidebarMotion();
  const collapsed=!!S.settings.sidebarCollapsed, sidebar=$('.sidebar'), toolbar=$('.toolbar');
  const slot=$(collapsed?'#sidebar-toolbar-slot':'#sidebar-brand-slot'), target=slot.getBoundingClientRect();
  const width=parseFloat(getComputedStyle($('#app')).getPropertyValue('--sidebar-width'))||(collapsed?76:246);
  const sideStyle=getComputedStyle(sidebar),slotStyle=getComputedStyle(slot);
  const left=collapsed?target.left-app.left+width-parseFloat(getComputedStyle(toolbar).left)
    :width-parseFloat(sideStyle.paddingRight)-parseFloat(sideStyle.borderRightWidth)-parseFloat(slotStyle.right)-target.width;
  const top=target.top-app.top;
  Object.assign(button.style,{left:`${left}px`,top:`${top}px`});
  if(!animate||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const dx=first.left-app.left+first.width/2-left-16,dy=first.top-app.top+first.height/2-top-16,variation=sidebarMotionNumber++%3,turn=collapsed?-1:1;
  button.classList.add('in-flight');
  const travel=button.animate([
    {transform:`translate(${dx}px,${dy}px) rotate(0deg) scale(1)`},
    {transform:`translate(${dx*.38}px,${dy*.38-5}px) rotate(${turn*(9+variation*3)}deg) scale(1.12)`,offset:.52},
    {transform:'translate(0,0) rotate(0deg) scale(1)'}
  ],{duration:420,easing:'cubic-bezier(.18,.8,.28,1)',fill:'none'});
  sidebarMotion.push(travel,
    $('.toggle-panel-glyph',button).animate([{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(.45)',offset:.42},{opacity:1,transform:'scale(1)'}],{duration:420}),
    $('.toggle-star-glyph',button).animate([{opacity:0,transform:'scale(.2) rotate(-70deg)'},{opacity:1,transform:`scale(${1.15+variation*.08}) rotate(30deg)`,offset:.5},{opacity:0,transform:'scale(.45) rotate(150deg)'}],{duration:420}),
    $('.brand-symbol').animate([{transform:'rotate(0) scale(1)'},{transform:`rotate(${turn*19}deg) scale(${collapsed?.88:1.12})`,offset:.42},{transform:'rotate(0) scale(1)'}],{duration:480,easing:'cubic-bezier(.2,.8,.3,1)'}));
  const layer=$('#sidebar-motion-layer');
  for(let i=0;i<7;i++){
    const star=document.createElement('span');star.className='sidebar-spark';star.textContent=i%3===0?'✧':'✦';
    const progress=(i+1)/8,x=left+16+dx*(1-progress),y=top+16+dy*(1-progress),angle=(i*2.4+variation)*turn;
    Object.assign(star.style,{left:`${x}px`,top:`${y}px`,fontSize:`${7+(i%3)*3}px`});layer.append(star);
    sidebarMotion.push(star.animate([{opacity:0,transform:'translate(-50%,-50%) scale(.2)'},{opacity:.8,offset:.25},{opacity:0,transform:`translate(calc(-50% + ${Math.cos(angle)*17}px),calc(-50% + ${Math.sin(angle)*15}px)) rotate(${turn*65}deg) scale(1.1)`}],{duration:350+i*13,delay:25+i*19,fill:'both',easing:'ease-out'}));
  }
  const until=performance.now()+560;
  const follow=()=>{positionSuggestions();if(performance.now()<until)sidebarMotionFrame=requestAnimationFrame(follow);else stopSidebarMotion();};
  sidebarMotionFrame=requestAnimationFrame(follow);
}
async function updateSidebar(collapsed) {
  const request=++sidebarMutation;
  sidebarIntent=collapsed;S.settings.sidebarCollapsed=collapsed;setTheme();renderToolbar();
  await invoke('settings:update',{sidebarCollapsed:collapsed});
  if(request!==sidebarMutation)return;
  sidebarIntent=null;
  api.invoke('state:get').then(next=>{if(request===sidebarMutation)renderState(next);}).catch(()=>{});
}
function hideTransientUI() {
  $('#floating').classList.add('hidden');
  $('#floating').removeAttribute('style');
  $('#palette').classList.add('hidden');
  $('#dialog').classList.add('hidden');
  $('#search-suggestions').classList.add('hidden');
}
function captureFocusAnchor(element=document.activeElement,inheritTransient=true) {
  if(inheritTransient&&element?.closest?.('#floating,#palette,#dialog'))return transientFocusAnchor;
  if(!element||element===document.body||element===document.documentElement||!element.getClientRects().length)return null;
  return {element,id:element.id,data:{...element.dataset}};
}
function resolveFocusAnchor(anchor) {
  if(!anchor)return null;
  const matches=element=>element?.isConnected&&!element.disabled&&element.getClientRects().length;
  if(matches(anchor.element))return anchor.element;
  const byId=anchor.id&&document.getElementById(anchor.id);if(matches(byId))return byId;
  const entries=Object.entries(anchor.data||{});
  return entries.length?$$('[data-action],[data-tab-id],[data-mission-tab]').find(element=>matches(element)&&entries.every(([key,value])=>element.dataset[key]===value)):null;
}
async function restoreTransientFocus(anchor,owner) {
  const current=()=>owner===transientGeneration&&!floating&&!paletteOpen&&!dialogOpen&&!S.missionOpen;
  const target=()=>resolveFocusAnchor(anchor)||(anchor?.data.action==='workspace-delete'?$('#space-add'):null);
  if(!anchor||!current()||!target())return;
  await invoke('ui:focus-chrome');
  if(current())target()?.focus({preventScroll:true});
}
function dismissTransientUI() {
  transientGeneration++;
  transientFocusAnchor=null;
  resetSuggestions();
  cancelMedia();
  floating = null; paletteOpen = false; dialogOpen = false;
  hideTransientUI();
  closeFind(false);
}
async function beginTransient(kind) {
  const anchor=kind==='suggestions'?null:captureFocusAnchor();
  if(kind!=='suggestions')resetSuggestions();
  if(kind!=='audio')cancelMedia();
  const request = ++transientGeneration;
  transientFocusAnchor=anchor;
  floating = ['palette','dialog'].includes(kind) ? null : kind;
  paletteOpen = kind === 'palette'; dialogOpen = kind === 'dialog';
  hideTransientUI();
  for(const attribute of ['role','aria-modal','aria-label'])$('#floating').removeAttribute(attribute);
  $('#floating').classList.toggle('audio-floating',kind==='audio');
  if (S.missionOpen) {
    await closeMission();
    if (request !== transientGeneration) return null;
    overlaySent = false; // The native Mission command resets its overlay flag.
  }
  await syncOverlay();
  return request === transientGeneration ? request : null;
}
function resetSuggestions() {
  searchGeneration++;clearTimeout(searchTimer);searchTimer=0;searchSession=null;searchOpenPromise=null;
  $('#search-suggestions').classList.add('hidden');
  for(const input of $$('#address,#home-search')){input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}
  api.invoke('suggestions:cancel').catch(()=>{});
  return searchGeneration;
}
async function closeSuggestions(keepChrome=false) {
  const tabId=S.activeTabId,owned=floating==='suggestions',generation=resetSuggestions();
  if(owned){transientGeneration++;floating=null;await syncOverlay();}
  if(keepChrome&&generation===searchGeneration&&tabId===S.activeTabId&&!floating&&!paletteOpen&&!dialogOpen&&!S.missionOpen)await invoke('ui:focus-chrome');
}
function currentSearch(generation) {
  const session=searchSession,input=session&&document.getElementById(session.inputId);
  return !!(session&&generation===searchGeneration&&input?.isConnected&&document.activeElement===input&&S.activeTabId===session.tabId&&input.value.trim()===session.query);
}
const suggestionKey=item=>item.kind==='tab'?`tab:${item.tabId}`:`${item.kind}:${item.url||item.text}`;
function scheduleSuggestions(input,force=false) {
  if(!['address','home-search'].includes(input?.id)||document.activeElement!==input||input.isComposing)return;
  const query=input.value.trim();
  if(!query){closeSuggestions(true);return;}
  if(!force&&searchSession?.inputId===input.id&&searchSession.query===query&&searchSession.tabId===S.activeTabId)return;
  const generation=++searchGeneration;clearTimeout(searchTimer);api.invoke('suggestions:cancel').catch(()=>{});
  searchSession={inputId:input.id,tabId:S.activeTabId,query,requestId:`search-${generation}`,items:[{kind:'search',text:query,detail:`Search with ${searchEngineName()}`}],index:-1,stage:0};
  showSuggestions(generation);
  querySuggestions(generation,true);
  if(S.settings.searchSuggestions===true&&!activeTab()?.private)searchTimer=setTimeout(()=>querySuggestions(generation,false),120);
}
function searchEngineName(){return {brave:'Brave Search',duckduckgo:'DuckDuckGo',google:'Google'}[S.settings.searchEngine]||'Google';}
async function querySuggestions(generation,localOnly) {
  if(!currentSearch(generation))return;
  const {query,requestId}=searchSession;
  let result;try{result=await api.invoke('suggestions:query',{query,requestId,localOnly});}catch{return;}
  if(!currentSearch(generation)||!result||(result.requestId!==undefined?result.requestId!==requestId:String(result.query).replace(/\s+/g,' ').trim()!==query.replace(/\s+/g,' ').trim()))return;
  const stage=localOnly?1:2;if(stage<searchSession.stage)return;
  const selected=searchSession.index>=0?suggestionKey(searchSession.items[searchSession.index]):null,seen=new Set();
  const items=(Array.isArray(result.items)?result.items:[]).filter(item=>{
    if(!item||typeof item.text!=='string'||!item.text.trim()||!['search','history','bookmark','tab','url'].includes(item.kind))return false;
    const key=suggestionKey(item);if(seen.has(key))return false;seen.add(key);return true;
  }).slice(0,8);
  if(!items.length)return;
  searchSession.items=items;searchSession.stage=stage;searchSession.index=selected?items.findIndex(item=>suggestionKey(item)===selected):-1;
  showSuggestions(generation);
}
async function showSuggestions(generation) {
  if(!currentSearch(generation))return;
  if(floating!=='suggestions')searchOpenPromise=beginTransient('suggestions');
  if(!searchOpenPromise)searchOpenPromise=Promise.resolve(transientGeneration);
  const owner=await searchOpenPromise;
  if(owner===null||owner!==transientGeneration||!currentSearch(generation)||floating!=='suggestions')return;
  renderSuggestions();
}
function renderSuggestions() {
  if(!searchSession||floating!=='suggestions')return;
  const labels={search:'Search',history:'History',bookmark:'Bookmark',tab:'Switch to tab',url:'Go to address'};
  const glyph={search:'search',history:'history',bookmark:'bookmark',tab:'grid',url:'globe'};
  const privateTab=activeTab()?.private,remote=S.settings.searchSuggestions===true&&!privateTab;
  $('#search-suggestions').innerHTML=`<div class="suggestions-list" role="presentation">${searchSession.items.map((item,i)=>`<button type="button" class="suggestion-option ${i===searchSession.index?'active':''}" id="suggestion-${searchGeneration}-${i}" role="option" aria-selected="${i===searchSession.index}" tabindex="-1" data-suggestion-index="${i}"><span class="suggestion-icon">${icon(glyph[item.kind])}</span><span class="suggestion-copy"><strong>${E(item.text)}</strong><small>${E(item.detail||item.url||labels[item.kind])}</small></span><span class="suggestion-kind">${E(labels[item.kind])}</span></button>`).join('')}</div><div class="suggestions-footer" role="presentation"><span>${privateTab?'Private tab · local results':remote?`Local results & ${E(searchEngineName())}`:'Local results'}</span><span>↑ ↓ to explore <kbd>↵</kbd> to open</span></div>`;
  $('#search-suggestions').classList.remove('hidden');
  const input=document.getElementById(searchSession.inputId);input?.setAttribute('aria-expanded','true');
  setSuggestionIndex(searchSession.index,false);positionSuggestions();
}
function setSuggestionIndex(index,scroll=true) {
  if(!searchSession)return;searchSession.index=index;
  for(const [i,option]of $$('.suggestion-option').entries()){option.classList.toggle('active',i===index);option.setAttribute('aria-selected',String(i===index));}
  const input=document.getElementById(searchSession.inputId),option=index>=0?$(`#suggestion-${searchGeneration}-${index}`):null;
  if(option){input?.setAttribute('aria-activedescendant',option.id);if(scroll)option.scrollIntoView({block:'nearest'});}else input?.removeAttribute('aria-activedescendant');
}
function positionSuggestions() {
  const list=$('#search-suggestions');if(!searchSession||list.classList.contains('hidden'))return;
  const input=document.getElementById(searchSession.inputId),form=input?.closest('form');if(!input||!form)return;
  const r=form.getBoundingClientRect(),width=Math.min(650,Math.max(310,r.width)),left=Math.max(12,Math.min(innerWidth-width-12,r.left));
  const below=innerHeight-r.bottom-20,height=Math.min(380,Math.max(120,below>=160?below:r.top-20));
  const top=below>=160?r.bottom+8:Math.max(12,r.top-height-8);
  Object.assign(list.style,{left:`${left}px`,top:`${top}px`,width:`${width}px`,maxHeight:`${height}px`});
  list.dataset.source=searchSession.inputId==='address'?'address':'home';
  input.setAttribute('aria-expanded','true');
}
async function selectSuggestion(index) {
  const item=searchSession?.items[index];if(!item)return;
  if(searchSession.inputId==='address')addressEdited=false;
  await closeSuggestions();
  if(item.kind==='tab'&&item.tabId)await invoke('tab:activate',{id:item.tabId});else await go(item.url||item.text);
}
function cancelMedia() {
  mediaGeneration++;clearTimeout(mediaPoll);mediaPoll=0;
  if(pendingVolume)flushTabVolume();
  mediaTabId=null;mediaInfo=null;mediaVideoId=null;
  for(const button of $$('[data-action="audio"]'))button.setAttribute('aria-expanded','false');
}
async function closeAudio(restoreFocus=false) {
  const id=mediaTabId,owned=floating==='audio';cancelMedia();$('#floating').classList.add('hidden');
  if(!owned)return;transientGeneration++;floating=null;const owner=transientGeneration;await syncOverlay();
  if(restoreFocus&&owner===transientGeneration&&!floating&&!paletteOpen&&!dialogOpen&&!S.missionOpen){await invoke('ui:focus-chrome');if(owner===transientGeneration)document.getElementById('tab-audio-'+id)?.focus({preventScroll:true});}
}
async function openAudio(id) {
  if(floating==='audio'&&mediaTabId===id)return closeAudio(true);
  const tab=S.tabs.find(t=>t.id===id);if(!tab)return;
  cancelMedia();mediaTabId=id;const generation=mediaGeneration;
  const owner=await beginTransient('audio');if(owner===null||generation!==mediaGeneration||mediaTabId!==id)return;
  renderAudioPopover();cartoonEnter($('#floating'));positionAudioPopover();
  document.getElementById('tab-audio-'+id)?.setAttribute('aria-expanded','true');
  await invoke('ui:focus-chrome');if(owner!==transientGeneration||generation!==mediaGeneration)return;
  $('#media-volume')?.focus();refreshMedia(generation,owner);
}
async function refreshMedia(generation=mediaGeneration,owner=transientGeneration) {
  if(floating!=='audio'||!mediaTabId||generation!==mediaGeneration||owner!==transientGeneration)return;
  const id=mediaTabId;
  try{const result=await api.invoke('media:get',{id});if(generation!==mediaGeneration||owner!==transientGeneration||floating!=='audio')return;mediaInfo=result&&typeof result==='object'?result:{error:'Media information is unavailable.'};}
  catch(error){if(generation!==mediaGeneration||owner!==transientGeneration)return;mediaInfo={error:error?.message||'Media information is unavailable.'};}
  updateAudioPopover();positionAudioPopover();clearTimeout(mediaPoll);mediaPoll=setTimeout(()=>refreshMedia(generation,owner),900);
}
function renderAudioPopover() {
  const tab=S.tabs.find(t=>t.id===mediaTabId);if(!tab)return;
  $('#floating').innerHTML=`<section class="audio-popover" role="dialog" aria-labelledby="audio-heading"><div class="audio-header"><span class="audio-emblem">${icon('volume')}</span><div><h2 id="audio-heading">Audio & video</h2><p title="${E(tab.title)}">${E(tab.title||host(tab.url))}</p></div><button class="icon-button" data-action="audio-close" aria-label="Close audio controls">${icon('close')}</button></div><div class="audio-readout"><output id="media-volume-output" for="media-volume"></output><button class="button" id="media-mute" data-action="media-mute" data-id="${E(tab.id)}"></button></div><label class="volume-label" for="media-volume">Tab volume</label><input id="media-volume" type="range" min="0" max="100" step="1" data-id="${E(tab.id)}" aria-label="Tab volume"><div class="media-video-section"><p id="media-playback-status" role="status">Checking media…</p><label class="media-video-label hidden" id="media-video-label" for="media-video-select">Video<select id="media-video-select" aria-label="Video for Picture in Picture"></select></label><button id="media-pip" class="button media-pip" data-action="media-pip" data-id="${E(tab.id)}" disabled>${icon('pip')}<span>Picture in Picture</span></button><p id="media-note" class="media-note"></p></div></section>`;
  $('#floating').classList.remove('hidden');updateAudioPopover();
}
function updateAudioPopover() {
  if(floating!=='audio'||!$('#media-volume'))return;
  const tab=S.tabs.find(t=>t.id===mediaTabId);if(!tab)return;
  const info=mediaInfo||tab,slider=$('#media-volume'),volume=Math.max(0,Math.min(1,Number.isFinite(Number(info.volume))?Number(info.volume):1));
  if(document.activeElement!==slider)slider.value=String(Math.round(volume*100));
  const percent=Math.round(Number(slider.value));slider.setAttribute('aria-valuetext',`${percent}%${info.muted?' · muted':''}`);slider.style.setProperty('--volume-fill',`${percent}%`);
  $('#media-volume-output').textContent=info.muted?'Muted':`${percent}%`;
  $('#media-mute').innerHTML=`${icon(info.muted?'volume':'mute')} ${info.muted?'Unmute':'Mute'}`;$('#media-mute').setAttribute('aria-label',info.muted?'Unmute tab':'Mute tab');
  const videos=Array.isArray(mediaInfo?.videos)?mediaInfo.videos:[],select=$('#media-video-select'),key=videos.map(v=>v.id).join('|');
  if(select.dataset.videos!==key&&document.activeElement!==select){select.innerHTML=videos.map((video,i)=>`<option value="${E(video.id)}">${E(video.title||`Video ${i+1}`)}${video.playing?' · playing':''}</option>`).join('');select.dataset.videos=key;if(videos.some(v=>v.id===mediaVideoId))select.value=mediaVideoId;else mediaVideoId=select.value||null;}
  $('#media-video-label').classList.toggle('hidden',videos.length<2);
  const selected=videos.find(v=>v.id===mediaVideoId)||videos[0],available=selected?selected.pipAvailable!==false:mediaInfo?.pipAvailable===true;
  $('#media-pip').disabled=!available;$('#media-pip span').textContent=(selected?.pipActive||(!selected&&info.pipActive))?'Return video to tab':'Picture in Picture';
  $('#media-pip').setAttribute('aria-label',$('#media-pip span').textContent);
  $('#media-playback-status').textContent=mediaInfo?.error?'Media unavailable':mediaInfo?(info.playing?'Media is playing':videos.length?'Video is paused':'No video in this tab'):'Checking media…';
  $('#media-note').textContent=mediaInfo?.error?String(mediaInfo.error?.message||mediaInfo.error):available?'Keep a video visible while you browse other tabs.':'Picture in Picture becomes available when this tab has a supported video.';
}
function positionAudioPopover() {
  if(floating!=='audio')return;const popup=$('#floating'),tab=document.getElementById('browser-tab-'+mediaTabId),rect=tab?.getBoundingClientRect();
  const width=Math.min(320,innerWidth-24),left=Math.min(innerWidth-width-12,(S.settings.sidebarCollapsed?76:246)+10),top=Math.max(90,Math.min(innerHeight-popup.offsetHeight-12,rect?.top||100));
  Object.assign(popup.style,{left:`${left}px`,right:'auto',top:`${top}px`,width:`${width}px`});
}
function setTabVolume(id,value,immediate=false) {
  const volume=Math.max(0,Math.min(1,Number(value)));if(!Number.isFinite(volume))return;
  pendingVolume={id,volume};const tab=S.tabs.find(t=>t.id===id);if(tab)tab.volume=volume;if(mediaInfo)mediaInfo.volume=volume;updateAudioPopover();
  clearTimeout(volumeTimer);if(immediate)flushTabVolume();else volumeTimer=setTimeout(flushTabVolume,35);
}
async function flushTabVolume() {
  clearTimeout(volumeTimer);volumeTimer=0;const value=pendingVolume;pendingVolume=null;if(!value)return;
  const request=++volumeRequest;try{await api.invoke('tab:volume',value);if(request===volumeRequest&&floating==='audio'&&mediaTabId===value.id)refreshMedia();}catch(error){toast(error?.message||'Could not change tab volume.');}
}
function renderState(next) {
  const previousTab = S.activeTabId, previousWorkspace=S.activeWorkspace, previousMission = S.missionOpen, previousSearchSettings=JSON.stringify([S.settings.searchEngine,S.settings.searchSuggestions]);
  S = {...S, ...next};
  for (const key of ['tabs','workspaces','bookmarks','history','downloads','agents','activity']) S[key] ||= [];
  S.settings ||= {}; S.shields ||= {};
  if(sidebarIntent!==null){if(!!S.settings.sidebarCollapsed===sidebarIntent)sidebarIntent=null;else S.settings={...S.settings,sidebarCollapsed:sidebarIntent};}
  const changedTab = previousTab && previousTab !== S.activeTabId;
  if (changedTab || (!previousMission && S.missionOpen)) dismissTransientUI();
  setTheme(); renderSidebar(); renderToolbar(); renderPage();
  if((changedTab||previousWorkspace!==S.activeWorkspace)&&internalRoute())cartoonEnter($('#content').firstElementChild,'tab');
  if (changedTab && activeTab()?.url === 'aster://newtab') { if(!addressEdited)$('#address').value = ''; $('#address').focus(); }
  if (S.missionOpen) { renderMission(); if (!previousMission) $('#mission-filter')?.focus(); } else $('#mission').classList.add('hidden');
  if (floating === 'shields') renderShields();
  if(floating==='audio'){if(!S.tabs.some(t=>t.id===mediaTabId))closeAudio();else{updateAudioPopover();positionAudioPopover();}}
  if (paletteOpen) renderPalette();
  if(searchSession&&previousSearchSettings!==JSON.stringify([S.settings.searchEngine,S.settings.searchSuggestions]))scheduleSuggestions(document.getElementById(searchSession.inputId),true);
  syncOverlay();syncOrbMotion();
}
function tabIcon(tab) {if(tab.isLoading)return '<span class="tab-loading"></span>';if(tab.private)return icon('private');if(tab.url?.startsWith('aster://'))return icon(({settings:'settings',history:'history',bookmarks:'bookmark',downloads:'download',agents:'team'})[tab.url.slice(8)]||'spark');return E(initial(host(tab.url)||tab.title));}
function renderSidebar() {
  const previous=new Map($$('#tabs [data-tab-id]').map(el=>[el.dataset.tabId,el.getBoundingClientRect()]));
  const spacesScroll=$('#spaces').scrollTop,tabsScroll=$('#tabs').scrollTop,previousSpace=$('#spaces .space-chip.active')?.dataset.id,previousActive=$('#tabs .tab.active')?.dataset.tabId;
  const focus=document.activeElement,focusedId=focus?.closest('#tabs,#spaces')?focus.id:null;
  $('#spaces').innerHTML=S.workspaces.map(w=>`<button id="space-${E(w.id)}" class="space-chip ${w.id===S.activeWorkspace?'active':''}" data-action="workspace" data-id="${E(w.id)}" title="${E(w.name)}" aria-label="${E(w.name)} space" aria-pressed="${w.id===S.activeWorkspace}" style="--space-color:${cssColor(w.color)}"><i class="space-dot" aria-hidden="true"></i><span class="space-label">${E(w.name)}</span></button>`).join('')+`<button id="space-add" class="space-chip space-add" data-action="workspace-new" title="New space" aria-label="New space"><span aria-hidden="true">＋</span><span class="space-label">New</span></button>`;
  const tabs=S.tabs.filter(t=>t.workspace===S.activeWorkspace||t.pinned),ordered=[...tabs.filter(t=>t.pinned),...tabs.filter(t=>!t.pinned)];
  const key=JSON.stringify([S.activeWorkspace,S.activeTabId,ordered.map(t=>[t.id,t.pinned])]),changed=!!sidebarRenderKey&&key!==sidebarRenderKey;sidebarRenderKey=key;
  $('#tabs').innerHTML=ordered.map(t=>`<div id="browser-tab-${E(t.id)}" class="tab ${t.id===S.activeTabId?'active':''}" data-tab-id="${E(t.id)}" role="tab" tabindex="0" aria-selected="${t.id===S.activeTabId}" draggable="true" title="${E(t.title||'New tab')}\n${E(t.url||'')}"><span class="tab-icon">${tabIcon(t)}</span><span class="tab-text">${E(t.title||'New tab')}</span>${t.pinned?'<span class="tab-pin">⌁</span>':''}${/^https?:/.test(t.url||'')?`<button id="tab-audio-${E(t.id)}" class="icon-button tiny tab-audio ${t.audible?'playing':''} ${t.pipActive?'pip-active':''}" data-action="audio" data-id="${E(t.id)}" title="Audio & video controls for ${E(t.title||'tab')}" aria-label="Audio controls for ${E(t.title||'tab')}" aria-haspopup="dialog" aria-expanded="${floating==='audio'&&mediaTabId===t.id}">${icon(t.muted||t.volume===0?'mute':'volume')}</button>`:''}<button id="tab-close-${E(t.id)}" class="tab-close" data-action="close-tab" data-id="${E(t.id)}" title="Close tab" aria-label="Close ${E(t.title||'tab')}">×</button>${S.agents.some(a=>(a.tabs||[]).includes(t.id))?'<i class="tab-agent"></i>':''}</div>`).join('');
  if(!ordered.length)$('#tabs').innerHTML='<div class="empty-tabs"><p>A fresh space.<br>Open a tab to begin.</p></div>';
  $('#spaces').scrollTop=spacesScroll;$('#tabs').scrollTop=tabsScroll;
  if(previousSpace!==S.activeWorkspace)$('#spaces .space-chip.active')?.scrollIntoView({block:'nearest'});
  if(previousActive!==S.activeTabId||previousSpace!==S.activeWorkspace)$('#tabs .tab.active')?.scrollIntoView({block:'nearest',inline:'nearest'});
  const clientCount = S.agents.length;
  $('#team-description').textContent = !S.automation?.endpoint ? 'Off' : `${clientCount} client${clientCount === 1 ? '' : 's'} connected`;
  if(changed)for(const [i,el]of $$('#tabs [data-tab-id]').entries()){
    if(i>=10)break;const old=previous.get(el.dataset.tabId),rect=el.getBoundingClientRect();
    if(old&&Math.abs(old.y-rect.y)>1)animateElement(el,[{transform:`translateY(${old.y-rect.y}px)`},{transform:'translateY(-2px)',offset:.75},{transform:'none'}],{duration:280});
    else if(!old)cartoonEnter(el,'tab');
    else if(el.dataset.tabId===S.activeTabId)animateElement(el,[{transform:'scale(.96,1.03)'},{transform:'scale(1.015,.985)',offset:.6},{transform:'none'}]);
  }
  if(focusedId&&!focus.isConnected&&document.activeElement===document.body)document.getElementById(focusedId)?.focus({preventScroll:true});
}
function renderToolbar() {const tab=activeTab();for(const toggle of $$('[data-action=sidebar]')){toggle.setAttribute('aria-expanded',String(!S.settings.sidebarCollapsed));toggle.title=shortcut((S.settings.sidebarCollapsed?'Show':'Hide')+' sidebar · ⌘⇧S');toggle.setAttribute('aria-label',(S.settings.sidebarCollapsed?'Show':'Hide')+' sidebar');}if(document.activeElement!==$('#address'))$('#address').value=internalRoute()?'':tab?.url||'';$('#address-icon').innerHTML=icon(internalRoute()?'search':tab?.url?.startsWith('https:')?'lock':'globe');$('#back').disabled=!tab?.canGoBack;$('#forward').disabled=!tab?.canGoForward;$('#reload').innerHTML=icon(tab?.isLoading?'stop':'reload');$('#reload').setAttribute('aria-label',tab?.isLoading?'Stop loading':'Reload');const protection=S.shields.enabled===false?'Protection paused':S.shields.status==='loading'?'Loading protection':S.shields.status==='ready'?'Protection on':'Protection unavailable';$('#shields-button').title=protection+' · Privacy controls';$('#shields-button').setAttribute('aria-label',protection+' · Privacy controls');$('#shields-button').dataset.protection=S.shields.enabled===false||S.shields.status!=='ready'?'attention':'ready';$('.address-bookmark').classList.toggle('selected',S.bookmarks.some(b=>b.url===tab?.url));$('#address-shortcut').style.display=document.activeElement===$('#address')?'none':'';$('#browser-status').textContent=tab?.isLoading?'Loading '+host(tab.url):tab?.private?'Private tab · browsing history is not saved':tab?.error?'This page could not be reached.':'';}
function restoreFocus(render, preserve) {
  const el = document.activeElement;
  const id = preserve ? el?.id : null;
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  const value = field ? el.value : null;
  const selection = field ? [el.selectionStart, el.selectionEnd] : null;
  const scroll = preserve ? $('#content').firstElementChild?.scrollTop || 0 : 0;
  render();
  if (preserve && $('#content').firstElementChild) $('#content').firstElementChild.scrollTop = scroll;
  const next = id ? document.getElementById(id) : null;
  if (next) {
    if (field && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) next.value = value;
    restoringFieldFocus=true;next.focus({preventScroll: true});restoringFieldFocus=false;
    if (selection && field) try { next.setSelectionRange(...selection); } catch {}
  }
}
function renderPage(force = false) {
  const route = internalRoute(), tab = activeTab();
  const data = route === 'newtab' ? [S.bookmarks,tab?.private]
    : route === 'history' ? [S.history,pageQuery]
    : route === 'bookmarks' ? [S.bookmarks,pageQuery]
    : route === 'downloads' ? [S.downloads]
    : route === 'agents' ? [S.agents,S.activity,S.automation]
    : route === 'settings' ? [S.settings,S.workspaces,S.shields,S.vpn]
    : [tab?.id,tab?.error,tab?.url,tab?.thumbnail,!!(floating||paletteOpen||dialogOpen)];
  const key = JSON.stringify([tab?.id,route,data]);
  if ((!force || route === 'newtab') && key === pageKey) return;
  pageKey = key;
  const content = $('#content');
  const preserve = content.dataset.renderTabId === tab?.id && content.dataset.route === (route || 'remote');
  content.dataset.renderTabId = tab?.id || '';
  content.dataset.route = route || 'remote';
  content.className = 'content' + (!route ? ' remote' : '') + (tab?.error ? ' error-state' : '');
  restoreFocus(() => { content.innerHTML = tab?.error ? errorPage(tab) : route === 'newtab' ? newTabPage()
    : route === 'settings' ? settingsPage() : route === 'history' ? historyPage()
    : route === 'bookmarks' ? bookmarksPage() : route === 'downloads' ? downloadsPage()
    : route === 'agents' ? agentsPage() : remoteUnderlay(tab); }, preserve);
  if(searchSession){setSuggestionIndex(searchSession.index,false);positionSuggestions();}
  syncOrbMotion();
}
function remoteUnderlay(tab){return (floating||paletteOpen||dialogOpen)&&tab?.thumbnail?`<img class="remote-underlay" src="${E(tab.thumbnail)}" alt="" aria-hidden="true">`:'';}
let observedOrb=null,orbIntersects=true,hostVisible=true;
const orbObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.target===observedOrb)orbIntersects=entry.isIntersecting;syncOrbMotion();});
function syncOrbMotion(){
  const orb=$('.generated-orb');
  if(orb!==observedOrb){orbObserver.disconnect();observedOrb=orb;orbIntersects=true;if(orb)orbObserver.observe(orb);}
  $('#app').classList.toggle('orb-paused',!hostVisible||document.hidden||!orbIntersects||S.missionOpen||internalRoute()!=='newtab');
}
document.addEventListener('visibilitychange',syncOrbMotion);addEventListener('focus',syncOrbMotion);addEventListener('blur',syncOrbMotion);
function newTabPage() {
  const bookmarks=S.bookmarks.slice(0,6),privateTab=!!activeTab()?.private;
  return `<section class="newtab-page" aria-label="${privateTab?'Private tab':'New tab'}">
    <h1 class="sr-only">${privateTab?'Private tab':'New tab'}</h1>
    ${privateTab?`<span class="private-badge">${icon('private')}Private tab</span>`:''}
    <div class="ambient-art generated-orb" aria-hidden="true"><img class="orb-image" src="art/orb-glass.webp" alt="" decoding="async" draggable="false"></div>
    <div class="welcome">
      <form class="search-form" id="home-search-form"><span>${icon('search')}</span><input id="home-search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="search-suggestions" aria-label="Search the web" placeholder="Search or enter address" autocomplete="off" spellcheck="false"><button type="submit" aria-label="Search">↗</button></form>
      <div class="favorites">${bookmarks.map(b=>`<button class="favorite" data-action="open" data-url="${E(b.url)}" title="${E(b.title)}"><span class="favorite-icon" style="--favorite-color:${agentColor(b.url)}">${E(initial(b.title||host(b.url)))}</span><span class="favorite-label">${E(b.title||host(b.url))}</span></button>`).join('')}<button class="favorite favorite-add" data-action="favorite-add" title="Add a favorite"><span class="favorite-icon">＋</span><span class="favorite-label">Add favorite</span></button></div>
    </div>
  </section>`;
}
function pageHeader(eyebrow,title,subtitle,actions='') {return `<div class="page-header"><div><div class="page-eyebrow">${icon(eyebrow[0])}${E(eyebrow[1])}</div><h1>${E(title)}</h1><p>${E(subtitle)}</p></div>${actions?`<div class="page-actions">${actions}</div>`:''}</div>`;}
function switchButton(setting,on,label) {return `<button class="switch ${on?'on':''}" role="switch" aria-checked="${!!on}" aria-label="${E(label)}" data-action="setting-toggle" data-setting="${setting}"></button>`;}
function settingRow(title,desc,control) {return `<div class="setting-row"><div class="setting-copy"><strong>${E(title)}</strong><small>${E(desc)}</small></div>${control}</div>`;}
function appearanceSettings() {
  const accent=Object.hasOwn(accentColors,S.settings.accent)?S.settings.accent:'purple';
  return `<div class="section-card"><h2>Look & feel</h2>${settingRow('Appearance','Follow your system, or choose light or absolute black.',`<div class="segmented">${['system','light','dark'].map(t=>`<button class="${(S.settings.theme||'system')===t?'active':''}" data-action="theme" data-value="${t}">${t.charAt(0).toUpperCase()+t.slice(1)}</button>`).join('')}</div>`)}${settingRow('Accent color','A little color, exactly where you want it.',`<div class="accent-options" role="radiogroup" aria-label="Accent color">${Object.entries(accentColors).map(([name,color])=>`<button id="accent-${name}" class="accent-choice ${accent===name?'active':''}" data-action="accent" data-value="${name}" role="radio" aria-checked="${accent===name}" aria-label="${name.charAt(0).toUpperCase()+name.slice(1)}" tabindex="${accent===name?'0':'-1'}" style="--choice-color:${color[0]}"><i aria-hidden="true">${accent===name?'✓':''}</i><span>${name.charAt(0).toUpperCase()+name.slice(1)}</span></button>`).join('')}</div>`)}${macOS ? settingRow('Transparency','Translucent sidebar and toolbar. Page surfaces stay solid.',switchButton('transparency',S.settings.transparency===true,'Transparency')) : ''}${settingRow('Compact sidebar','Keep your tabs close and your page in focus.',switchButton('sidebarCollapsed',S.settings.sidebarCollapsed,'Compact sidebar'))}${settingRow('Search engine','Choose where your curiosity starts.',`<select id="search-engine" aria-label="Search engine" data-setting="searchEngine">${[['google','Google'],['brave','Brave Search'],['duckduckgo','DuckDuckGo']].map(([value,label])=>`<option value="${value}" ${(S.settings.searchEngine||'google')===value?'selected':''}>${label}</option>`).join('')}</select>`)}${settingRow('Search suggestions','Send typed searches to your selected provider. Private tabs always use local results.',switchButton('searchSuggestions',S.settings.searchSuggestions===true,'Search suggestions'))}</div>`;
}
function vpnSettings() {
  if (!macOS) return '';
  const vpn=S.vpn||{status:'checking',message:'Checking the VPN provider on this Mac.'},labels={checking:'Checking provider',unavailable:'Not installed',untrusted:'Client could not be verified','setup-required':'Setup required',disconnected:'Tunnel disconnected',connecting:'Connecting…',connected:'Tunnel connected',disconnecting:'Disconnecting…',error:'Provider error',unknown:'Status unknown','dns-only':'DNS only · no VPN tunnel','proxy-only':'Proxy only · no device tunnel'};
  const connected=vpn.status==='connected'&&vpn.connected===true&&vpn.modeKind==='tunnel';
  const connect=!!(vpn.installed&&vpn.trusted&&!vpn.locked&&vpn.modeKind==='tunnel'&&['disconnected','error'].includes(vpn.status));
  const disconnect=!!(vpn.installed&&vpn.trusted&&!vpn.locked&&['connected','connecting'].includes(vpn.providerStatus));
  return `<div class="section-card vpn-card" data-vpn-status="${E(vpn.status)}"><h2>${icon('vpn')} Free device VPN <span class="vpn-badge ${connected?'connected':''}">${E(labels[vpn.status]||'Status unknown')}</span></h2><div class="vpn-body"><strong>Cloudflare WARP</strong><p>A free encrypted tunnel for this Mac. It affects every app, has no country picker, and does not guarantee anonymity or faster browsing.</p><p class="vpn-provider-message" role="status">${E(vpn.message||'Refresh to check the provider.')}</p>${vpn.error?`<p class="vpn-error">${E(vpn.error.message||vpn.error)}</p>`:''}${vpn.locked?'<p class="vpn-error">Your device policy controls this connection.</p>':''}<div class="vpn-actions"><button class="button" data-action="vpn-action" data-command="vpn:refresh">${icon('reload')} Refresh</button>${!vpn.installed||!vpn.trusted||vpn.status==='setup-required'?'<button class="button primary" data-action="vpn-action" data-command="vpn:install">Review WARP setup</button>':`<button class="button ${connected?'':'primary'}" data-action="vpn-action" data-command="${disconnect?'vpn:disconnect':'vpn:connect'}" ${disconnect||connect?'':'disabled'}>${disconnect?'Disconnect':'Connect'}</button>`}</div><small>Installation and first-run setup require your review. Connection status comes from the installed provider.</small></div></div>`;
}
function settingsPage() {
  return `<section class="internal-page">${pageHeader(['settings','Make it yours'],'A space that feels like you.','Thoughtful defaults. Just enough control.')}${appearanceSettings()}<div class="section-card"><h2>Tabs & movement</h2>${settingRow('Restore your session','Pick up where you left off. Private tabs stay private.',switchButton('restoreSession',S.settings.restoreSession!==false,'Restore your session'))}${settingRow('Keep Mission Control tidy','Tab cards flow into the next page as your space grows.',switchButton('autoTidy',S.settings.autoTidy!==false,'Keep Mission Control tidy'))}</div><div class="section-card"><h2>Privacy & protection</h2>${settingRow('Block ads & trackers',S.shields.status==='ready'?'Network filters and cosmetic filtering protect every normal and private tab.':S.shields.status==='loading'?'Loading protection. Open the shield for details.':'Protection is unavailable. No filtering is active.',`<button class="switch ${S.shields.enabled!==false?'on':''}" role="switch" aria-checked="${S.shields.enabled!==false}" aria-label="Block ads and trackers" data-action="shield-toggle"></button>`)}<div class="privacy-row">${number(S.shields.filterCount)} filtering rules · ${number(S.shields.blocked)} requests blocked<br>Protection reduces ads and tracking. It does not guarantee that every ad will be removed or reproduce all Brave Shields features.</div></div>${vpnSettings()}<div class="section-card"><h2 class="spaces-heading">Your spaces <button class="button" data-action="workspace-new">＋ New space</button></h2>${S.workspaces.map(w=>`<div class="setting-row workspace-setting" style="--space-color:${cssColor(w.color)}"><i class="space-dot"></i><button class="workspace-name" data-action="workspace" data-id="${E(w.id)}">${E(w.name)}</button><button class="icon-button" data-action="workspace-rename" data-id="${E(w.id)}" title="Rename space" aria-label="Rename ${E(w.name)}">${icon('edit')}</button>${w.id!==S.workspaces[0]?.id?`<button class="icon-button" data-action="workspace-delete" data-id="${E(w.id)}" title="Remove space" aria-label="Remove ${E(w.name)}">${icon('trash')}</button>`:''}</div>`).join('')}</div><div class="section-card"><h2>A few useful shortcuts</h2>${[['New tab','⌘ T'],['New private tab','⌘ ⇧ N'],['Address bar','⌘ L'],['Command palette','⌘ K'],['Mission Control','⌘ ⇧ M'],['Reopen closed tab','⌘ ⇧ T'],['Bookmark page','⌘ D']].map(([a,b])=>`<div class="shortcut-line"><span>${a}</span><kbd>${shortcut(b)}</kbd></div>`).join('')}</div><p class="info-note">Aster · A personal Chromium browser, with a native macOS window and a shared local automation interface.</p></section>`;
}
function emptyState(name,title,desc,action='') {return `<div class="section-card empty-state"><div class="empty-icon">${icon(name)}</div><h2>${E(title)}</h2><p>${E(desc)}</p>${action}</div>`;}
function listFilter(placeholder) {return `<label class="list-filter">${icon('search')}<input id="page-filter" placeholder="${E(placeholder)}" aria-label="${E(placeholder)}" value="${E(pageQuery)}"></label>`;}
function historyPage() {const items=S.history.filter(t=>(t.title+' '+t.url).toLowerCase().includes(pageQuery.toLowerCase())).slice(0,300);return `<section class="internal-page">${pageHeader(['history','Your footsteps'],'A little way back.','Find the pages you have visited. Private tabs never appear here.',S.history.length?'<button class="button danger" data-action="history-clear">Clear history</button>':'')}${S.history.length?listFilter('Search your history'):''}${items.length?`<div class="section-card">${items.map(t=>`<div class="list-row"><button class="list-open" data-action="open" data-url="${E(t.url)}"><span class="list-leading">${E(initial(host(t.url)))}</span><span class="list-copy"><strong>${E(t.title||host(t.url))}</strong><small>${E(t.url)}</small></span></button><span class="time">${relative(t.visitedAt)}</span></div>`).join('')}</div>`:emptyState('history',pageQuery?'No pages found':'Your next adventure starts here.',pageQuery?'Try another search.':'The places you explore will appear here, ready to revisit.','<button class="button" data-action="new">Open a new tab</button>')}</section>`;}
function bookmarksPage() {const items=S.bookmarks.filter(t=>(t.title+' '+t.url).toLowerCase().includes(pageQuery.toLowerCase()));return `<section class="internal-page">${pageHeader(['bookmark','Worth keeping'],'Good things, saved.','A small collection of places you want to come back to.','<button class="button primary" data-action="favorite-add">＋ Add bookmark</button>')}${S.bookmarks.length?listFilter('Search your bookmarks'):''}${items.length?`<div class="section-card">${items.map(t=>`<div class="list-row"><button class="list-open" data-action="open" data-url="${E(t.url)}"><span class="list-leading" style="color:${agentColor(t.url)}">${E(initial(t.title||host(t.url)))}</span><span class="list-copy"><strong>${E(t.title||host(t.url))}</strong><small>${E(t.url)}</small></span></button><button class="icon-button" data-action="bookmark-remove" data-url="${E(t.url)}" title="Remove bookmark" aria-label="Remove ${E(t.title)}">${icon('close')}</button></div>`).join('')}</div>`:emptyState('bookmark',pageQuery?'Nothing by that name.':'Keep a little inspiration.',pageQuery?'Try another search.':`Save any page with ${shortcut('⌘D')}, or add a favorite to your new tab page.`)}</section>`;}
function downloadsPage() {return `<section class="internal-page">${pageHeader(['download','Brought home'],'Your little collection.','Files you download from the web, all in one place.')}${S.downloads.length?`<div class="section-card">${S.downloads.map(d=>`<div class="list-row"><span class="list-leading">${icon('download')}</span><span class="list-copy"><strong>${E(d.name||'Download')}</strong><small>${E(d.state||'in progress')} · ${bytes(d.received)}${d.total?' of '+bytes(d.total):''}</small>${d.state==='progressing'?`<span class="progress-track"><i style="width:${Math.min(100,Math.max(0,((d.received||0)/(d.total||1))*100))}%"></i></span>`:''}</span>${d.state==='completed'?`<button class="button" data-action="download-open" data-id="${E(d.id)}">Open</button><button class="icon-button" data-action="download-reveal" data-id="${E(d.id)}" title="Show in Finder" aria-label="Show ${E(d.name)} in Finder">${icon('folder')}</button>`:''}</div>`).join('')}</div>`:emptyState('download','A clean slate.','Your downloads will appear here as you collect things from the web.')}</section>`;}
function codeBlock(code,id) {return `<div class="connection-code"><code>${E(code)}</code><button class="copy-code" data-action="copy-code" data-code-id="${E(id)}" title="Copy" aria-label="Copy command">${icon('copy')}</button></div>`;}
const connectionCodes = {};
function agentsPage() {
  const automation = S.automation || {};
  if (!automation.endpoint) {
    return `<section class="internal-page">${pageHeader(['team', 'Local automation'], 'Local automation is off', '')}
      <div class="section-card"><h2>Enable local control</h2>
        <p class="card-description">Quit Aster and run <code>npm run start:automation</code> from the project folder. The interface listens on this Mac and uses a session token.</p>
      </div></section>`;
  }
  connectionCodes.mcp = JSON.stringify({ mcpServers: { aster: { command: 'node', args: [automation.mcpPath] } } }, null, 2);
  connectionCodes.cli = `node ${shellQuote(automation.cliPath)} tabs.list\nnode ${shellQuote(automation.cliPath)} --agent Researcher session`;
  connectionCodes.api = `${automation.endpoint}\nToken file: ${automation.tokenPath}`;
  const count = S.agents.length;
  return `<section class="internal-page">${pageHeader(['team', 'Local automation'], 'Local automation', 'Connect trusted scripts and tools to the tabs in this window.')}
    <div class="agent-hero"><div class="agent-hero-top"><i class="live-dot"></i><strong>${count} client${count === 1 ? '' : 's'} connected</strong></div>
      <div class="protocol-tags"><span>MCP</span><span>CLI</span><span>LOCAL API</span></div>
    </div>
    ${count ? `<div class="section-card"><h2>Connected clients <span class="inline-count">${count}</span></h2>${S.agents.map(client => `<div class="list-row"><span class="agent-avatar" style="--agent-color:${agentColor(client.id)}">${E(initial(client.name))}</span><span class="list-copy"><strong>${E(client.name || client.id)}</strong><small>${E(client.transport || 'Local API')} · ${(client.tabs || []).length} active tabs</small></span><span class="time">${relative(client.lastSeen || client.connectedAt)}</span></div>`).join('')}</div>` : ''}
    <div class="two-column"><div class="section-card"><h2>MCP connection</h2>${codeBlock(connectionCodes.mcp, 'mcp')}<div style="padding:0 19px 18px"><button class="button" data-action="copy-code" data-code-id="mcp">${icon('copy')} Copy configuration</button></div></div>
    <div class="section-card"><h2>Terminal commands</h2>${codeBlock(connectionCodes.cli, 'cli')}<div style="padding:0 19px 18px"><button class="button" data-action="copy-code" data-code-id="cli">${icon('copy')} Copy commands</button></div></div></div>
    <div class="section-card"><h2>Local connection</h2><p class="card-description">Connected clients can access every tab, including private tabs. Keep the token with trusted tools.</p>${codeBlock(connectionCodes.api, 'api')}<div style="padding:0 19px 18px"><button class="button" data-action="open-path" data-kind="token">${icon('folder')} Show token file</button></div></div>
    <div class="section-card"><h2>Activity</h2>${S.activity.length ? S.activity.slice(0, 30).map(event => `<div class="list-row activity-row"><i class="activity-dot" style="background:${agentColor(event.agentId)}"></i><span class="list-copy"><strong>${E(event.agentName || 'Client')} <span style="color:var(--muted);font-weight:400">${E(event.action || 'used the browser')}</span></strong></span><span class="time">${relative(event.at)}</span></div>`).join('') : '<p class="card-description" style="padding-bottom:20px">Connection activity will appear here.</p>'}</div></section>`;
}
function errorPage(tab) {
  const reason = typeof tab.error === 'object' ? tab.error.description || tab.error.code : tab.error;
  const stopped = String(reason || '').startsWith('Page stopped:');
  return `<section class="error-page"><span class="empty-icon">${icon(stopped ? 'warning' : 'globe')}</span><h1>${stopped ? 'This tab stopped.' : 'This page could not load.'}</h1><p>${stopped ? 'Your browser and other tabs are still available. Reload this tab to continue.' : `We couldn't reach ${E(host(tab.url) || 'this page')}. Check your connection, or try again.`}</p><span class="error-code">${E(reason)}</span><button class="button primary" data-action="reload">${icon('reload')} Reload page</button></section>`;
}
function missionTabs() {return S.tabs.filter(t=>(missionWorkspace==='all'||t.workspace===missionWorkspace)&&(t.title+' '+t.url).toLowerCase().includes(missionQuery.toLowerCase()));}
function missionGeometry() {const width=innerWidth-(S.settings.sidebarCollapsed?76:246)-84;const columns=Math.max(2,Math.min(4,Math.floor(width/245)));const height=innerHeight-330;const rows=height>200?2:1;return {columns,capacity:S.settings.autoTidy===false?Math.max(8,S.tabs.length+1):Math.min(8,columns*rows)};}
function missionPageButtons(pages) {
  const indices=pages<=7?Array.from({length:pages},(_,i)=>i):[...new Set([0,missionPage-1,missionPage,missionPage+1,pages-1].filter(i=>i>=0&&i<pages))].sort((a,b)=>a-b);
  return indices.map((i,index)=>`${index&&i-indices[index-1]>1?'<span class="mission-page-gap" aria-hidden="true">…</span>':''}<button class="${i===missionPage?'active':''}" data-action="mission-page" data-page="${i}" aria-label="Page ${i+1}"${i===missionPage?' aria-current="page"':''}></button>`).join('');
}
function renderMission() {const {columns,capacity}=missionGeometry();const tabs=missionTabs(),pages=Math.max(1,Math.ceil((tabs.length+1)/capacity));missionPage=Math.max(0,Math.min(missionPage,pages-1));const start=missionPage*capacity,subset=tabs.slice(start,start+capacity);
  // Unrelated state updates must not replace cards and restart their entry animations.
  const renderKey=JSON.stringify([innerWidth,innerHeight,columns,capacity,missionPage,missionWorkspace,missionQuery,S.settings.autoTidy!==false,S.tabs.length,tabs.length,S.activeTabId,S.workspaces.map(w=>[w.id,w.name,w.color]),subset.map(t=>[t.id,t.title,t.url,t.thumbnail,t.workspace,t.private])]);
  if(renderKey===missionRenderKey&&$('#mission .mission-grid')){$('#mission').classList.remove('hidden');return;}
  let cards=subset.map((t,i)=>{const w=S.workspaces.find(w=>w.id===t.workspace);const preview=t.thumbnail&&!t.url?.startsWith('aster://')?`<img src="${E(t.thumbnail)}" alt="Preview of ${E(t.title||'tab')}">`:t.url?.startsWith('aster://newtab')?'<div class="mission-mini-bar"><i></i><i></i><i></i></div><div class="mission-newtab"><div class="mini-orb"></div><strong>Room to explore.</strong></div>':`<div class="mission-fallback"><span>${t.url?.startsWith('aster://')?'✳':E(initial(host(t.url)))}</span>${E(host(t.url)||t.title||'New tab')}</div>`;return `<article class="mission-card ${t.id===S.activeTabId?'active':''}" data-mission-tab="${E(t.id)}" tabindex="0" role="button" aria-label="Open ${E(t.title||'tab')}" draggable="true" style="animation-delay:${i*25}ms"><button class="mission-close" data-action="close-tab" data-id="${E(t.id)}" aria-label="Close ${E(t.title||'tab')}" title="Close tab">×</button><div class="mission-preview">${preview}</div><div class="mission-card-meta"><i class="space-dot" style="--space-color:${cssColor(w?.color)}"></i><strong>${E(t.title||'New tab')}</strong>${t.private?icon('private','style="width:11px;height:11px;color:#a68cbe"'):''}</div></article>`;}).join('');if(start+subset.length===tabs.length&&subset.length<capacity)cards+='<button class="mission-new" data-action="mission-new"><span>＋</span>Open a new tab</button>';
  const missionFocus=$('#mission').contains(document.activeElement)?captureFocusAnchor():null;
  const queryFocus=document.activeElement?.id==='mission-filter';const selection=queryFocus?[$('#mission-filter').selectionStart,$('#mission-filter').selectionEnd]:null;
  $('#mission').innerHTML=`<div class="mission-header"><div><div class="mission-eyebrow">A little perspective</div><h1>Everything, in its place.</h1><p>${tabs.length} tab${tabs.length===1?'':'s'} · Drag to rearrange. Drop on a space to move.</p></div><button class="icon-button" data-action="mission-close" title="Close Mission Control · Esc" aria-label="Close Mission Control">${icon('close')}</button></div><div class="mission-spacebar"><button class="mission-space ${missionWorkspace==='all'?'active':''}" data-action="mission-space" data-id="all">All spaces <span style="opacity:.5">${S.tabs.length}</span></button>${S.workspaces.map(w=>`<button class="mission-space ${missionWorkspace===w.id?'active':''}" data-action="mission-space" data-id="${E(w.id)}" data-drop-workspace="${E(w.id)}"><i class="space-dot" style="--space-color:${cssColor(w.color)}"></i>${E(w.name)}</button>`).join('')}<label class="mission-search">${icon('search')}<input id="mission-filter" placeholder="Find a tab…" aria-label="Find a tab" value="${E(missionQuery)}"></label></div><div class="mission-grid" style="--mission-columns:${columns}">${cards}</div><div class="mission-footer"><span>${S.settings.autoTidy!==false?'Your tabs flow. Your space stays clear.':'Drag cards to make this space your own.'}</span><div class="mission-page-control"><button data-action="mission-prev" ${missionPage===0?'disabled':''} title="Previous page" aria-label="Previous page">${icon('back')}</button><div class="mission-page-dots">${missionPageButtons(pages)}</div><button data-action="mission-next" ${missionPage>=pages-1?'disabled':''} title="Next page" aria-label="Next page">${icon('forward')}</button><span>${missionPage+1} / ${pages}</span></div><span>Press <kbd>esc</kbd> to return</span></div>`;missionRenderKey=renderKey;$('#mission').classList.remove('hidden');if(queryFocus){$('#mission-filter').focus();$('#mission-filter').setSelectionRange(...selection);}else if(missionFocus)(resolveFocusAnchor(missionFocus)||$('#mission-filter')).focus({preventScroll:true});}
async function openMission() {dismissTransientUI();await syncOverlay();missionPage=0;missionQuery='';await invoke('ui:mission',{open:true});}
async function closeMission() {await invoke('ui:mission',{open:false});}
async function closeFloating(restoreFocus=false) {if(floating==='audio')return closeAudio(restoreFocus);if(floating==='suggestions'||searchSession)return closeSuggestions(restoreFocus);$('#floating').classList.add('hidden');if(!floating)return;const anchor=transientFocusAnchor;transientFocusAnchor=null;transientGeneration++;floating=null;const owner=transientGeneration;await syncOverlay();if(restoreFocus)await restoreTransientFocus(anchor,owner);}
async function openFloating(type) {if(floating===type)return closeFloating(true);const request=await beginTransient(type);if(request===null)return;if(type==='shields')renderShields();else renderMenu();$('#floating').setAttribute('role','dialog');$('#floating').setAttribute('aria-modal','true');$('#floating').setAttribute('aria-label',type==='shields'?'Privacy protection':'Browser menu');$('#floating').classList.remove('hidden');cartoonEnter($('#floating'));await invoke('ui:focus-chrome');if(request===transientGeneration&&floating===type)$('#floating button:not(:disabled)')?.focus({preventScroll:true});}
function renderShields() {const focused=$('#floating').contains(document.activeElement)?captureFocusAnchor(document.activeElement,false):null;$('#floating').innerHTML=`<div class="shield-popover"><div class="shield-title"><span>${icon('shield')}</span><div><h2>A little peace of mind.</h2><small>${S.shields.enabled===false?'Protection paused':'Aster protection'}</small></div><button class="switch ${S.shields.enabled!==false?'on':''}" data-action="shield-toggle" role="switch" aria-checked="${S.shields.enabled!==false}" aria-label="Toggle protection"></button></div><div class="shield-stats"><strong>${number(S.shields.blocked)}</strong><span>ads & tracking requests blocked</span></div><div class="shield-detail"><span>Filtering engine</span><strong>${S.shields.status==='ready'?'Ready':S.shields.status==='loading'?'Loading filters':'Unavailable'}</strong></div><div class="shield-detail"><span>Rules available</span><strong>${number(S.shields.filterCount)}</strong></div><div class="shield-detail"><span>This tab</span><strong>${number(activeTab()?.blocked)} blocked</strong></div><p class="info-note">${S.shields.status==='ready'?'Filtering helps keep distractions and trackers away. Some ads may still appear. Protection is shared across all tabs.':S.shields.status==='loading'?'Filter protection is loading. Blocking starts when the engine is ready.':'The filtering engine is unavailable. Ads and tracking requests are not being filtered.'}</p><button class="menu-item" style="margin-top:8px" data-action="route" data-route="settings">${icon('settings')} Privacy settings ${icon('arrow')}</button></div>`;resolveFocusAnchor(focused)?.focus({preventScroll:true});}
function renderMenu() {const items=[['new','plus','New tab','⌘T'],['private','private','New private tab','⌘⇧N'],['restore','history','Reopen closed tab','⌘⇧T'],null,['mission','grid','Mission Control','⌘⇧M'],['palette','search','Search tabs & commands','⌘K'],null,['route','bookmark','Bookmarks','', 'bookmarks'],['route','history','History','','history'],['route','download','Downloads','','downloads'],['route','team','Agent connections','','agents'],null,['route','settings','Settings','⌘,','settings']];$('#floating').innerHTML=items.map(i=>i?`<button class="menu-item" data-action="${i[0]}" ${i[4]?`data-route="${i[4]}"`:''}>${icon(i[1])}${E(i[2])}<kbd>${E(shortcut(i[3]))}</kbd></button>`:'<div class="menu-divider"></div>').join('');}
async function openPalette() {const request=await beginTransient('palette');if(request===null)return;paletteIndex=0;$('#palette').classList.remove('hidden');$('#palette-input').value='';renderPalette();cartoonEnter($('.palette'));await invoke('ui:focus-chrome');if(request===transientGeneration&&paletteOpen)$('#palette-input').focus();}
async function closePalette(restoreFocus=false) {$('#palette').classList.add('hidden');if(!paletteOpen)return;const anchor=transientFocusAnchor;transientFocusAnchor=null;transientGeneration++;paletteOpen=false;const owner=transientGeneration;await syncOverlay();if(restoreFocus)await restoreTransientFocus(anchor,owner);}
function renderPalette() {const query=$('#palette-input').value.toLowerCase().trim();const commands=[{title:'Open a new tab',subtitle:'A fresh space for your next idea',icon:'plus',action:'new'},{title:'Mission Control',subtitle:'See all your tabs at a glance',icon:'grid',action:'mission'},{title:'Connect an agent',subtitle:'Bring your harness into Aster',icon:'team',action:'route',route:'agents'},{title:'Settings',subtitle:'Make Aster feel like you',icon:'settings',action:'route',route:'settings'},{title:'Bookmarks',subtitle:'Your saved little collection',icon:'bookmark',action:'route',route:'bookmarks'},{title:'History',subtitle:'Find your way back',icon:'history',action:'route',route:'history'},{title:'Downloads',subtitle:'Things you brought home',icon:'download',action:'route',route:'downloads'},{title:'New private tab',subtitle:'Explore without saving browsing history',icon:'private',action:'private'}];paletteItems=[...S.tabs.filter(t=>(t.title+' '+t.url).toLowerCase().includes(query)).slice(0,6).map(t=>({title:t.title||'New tab',subtitle:t.url,tab:t.id,icon:t.private?'private':'globe'})),...commands.filter(c=>(c.title+' '+c.subtitle).toLowerCase().includes(query))];if(query)paletteItems.push({title:`Search or go to “${$('#palette-input').value}”`,subtitle:'Open in the current tab',icon:'search',url:$('#palette-input').value});paletteIndex=Math.min(paletteIndex,Math.max(0,paletteItems.length-1));$('#palette-results').innerHTML='<div class="palette-category">'+(query?'Matches':'Your tabs & quick actions')+'</div>'+paletteItems.map((item,i)=>`<button class="palette-item ${i===paletteIndex?'active':''}" data-action="palette-select" data-index="${i}"><span>${icon(item.icon)}</span><div><strong>${E(item.title)}</strong><small>${E(item.subtitle)}</small></div>${i===paletteIndex?'<kbd>↵</kbd>':''}</button>`).join('');}
async function selectPalette(index) {const item=paletteItems[index];if(!item)return;await closePalette();if(item.tab){await invoke('tab:activate',{id:item.tab});if(S.missionOpen)await closeMission();}else if(item.url)await go(item.url);else await action(item.action,{route:item.route});}
async function openDialog(type,id) {const request=await beginTransient('dialog');if(request===null)return;const workspace=S.workspaces.find(w=>w.id===id);const contents=type==='favorite'?`<h2>Save a little inspiration.</h2><p>Add a favorite to your bookmarks and new tab page.</p><input id="dialog-title" placeholder="Name" aria-label="Bookmark name" required><input id="dialog-url" placeholder="https://example.com" aria-label="Bookmark URL" required>`:type==='workspace-delete'?`<h2>A little less space?</h2><p>Remove “${E(workspace?.name)}”? Its tabs will move to your first space.</p>`:type==='history-clear'?'<h2>A fresh start.</h2><p>Clear your browsing history? Bookmarks and downloaded files stay where they are.</p>':`<h2>${type==='workspace-rename'?'Rename your space.':'Make room for something.'}</h2><p>${type==='workspace-rename'?'A little name for the things you are working on.':'Keep a project, a purpose, or a passion in its own space.'}</p><input id="dialog-name" placeholder="Name your space" aria-label="Space name" value="${E(workspace?.name||'')}" required maxlength="40">`;$('#dialog').innerHTML=`<form class="dialog" id="dialog-form" data-type="${type}" data-id="${E(id||'')}">${contents}<div class="dialog-actions"><button type="button" class="button" data-action="dialog-close">Cancel</button><button class="button primary" type="submit">${type==='workspace-delete'?'Remove space':type==='history-clear'?'Clear history':type==='favorite'?'Add favorite':type==='workspace-rename'?'Save':'Create space'}</button></div></form>`;$('#dialog').classList.remove('hidden');cartoonEnter($('#dialog .dialog'),'dialog');await invoke('ui:focus-chrome');if(request!==transientGeneration||!dialogOpen)return;$('#dialog h2')?.setAttribute('id','dialog-heading');$('#dialog').setAttribute('aria-labelledby','dialog-heading');if(!$('#dialog').contains(document.activeElement))$('#dialog input, #dialog button')?.focus();}
async function closeDialog(restoreFocus=true){if(dialogOpen)starBurst($('#dialog .dialog')?.getBoundingClientRect(),2);$('#dialog').classList.add('hidden');if(!dialogOpen)return;const anchor=transientFocusAnchor;transientFocusAnchor=null;transientGeneration++;dialogOpen=false;const owner=transientGeneration;await syncOverlay();if(restoreFocus)await restoreTransientFocus(anchor,owner);}
async function action(name,data={}) {switch(name){case'new':await closeFloating();await invoke('tab:new',{});break;case'private':await closeFloating();await invoke('tab:new',{private:true});break;case'restore':await closeFloating();await invoke('tab:restore',{});break;case'sidebar':await updateSidebar(!S.settings.sidebarCollapsed);break;case'workspace':pageQuery='';await invoke('workspace:activate',{id:data.id});break;case'workspace-new':await openDialog('workspace-new');break;case'workspace-rename':await openDialog('workspace-rename',data.id);break;case'workspace-delete':await openDialog('workspace-delete',data.id);break;case'close-tab':await closeTabWithMotion(data.id);break;case'mute':await invoke('tab:mute',{id:data.id});break;case'audio':await openAudio(data.id);break;case'audio-close':await closeAudio(true);break;case'media-mute':{const result=await invoke('tab:mute',{id:data.id});if(result?.id){const tab=S.tabs.find(t=>t.id===result.id);if(tab)Object.assign(tab,result);}await refreshMedia();break;}case'media-pip':{const button=$('#media-pip');if(button)button.disabled=true;await invoke('tab:pip',{id:data.id,...(mediaVideoId?{videoId:mediaVideoId}:{})});await refreshMedia();break;}case'back':await invoke('tab:back',{});break;case'forward':await invoke('tab:forward',{});break;case'reload':await invoke('tab:reload',{});break;case'bookmark':await invoke('bookmark:toggle',{});break;case'bookmark-remove':await invoke('bookmark:toggle',{url:data.url});break;case'route':pageQuery='';await go('aster://'+data.route);break;case'open':await go(data.url);break;case'mission':S.missionOpen?await closeMission():await openMission();break;case'mission-close':await closeMission();break;case'mission-new':await invoke('tab:new',{});await closeMission();break;case'mission-space':missionWorkspace=data.id;missionPage=0;renderMission();break;case'mission-prev':missionPage--;renderMission();break;case'mission-next':missionPage++;renderMission();break;case'mission-page':missionPage=Number(data.page);renderMission();break;case'shields':await openFloating('shields');break;case'shield-toggle':await invoke('shields:toggle',{});break;case'menu':await openFloating('menu');break;case'palette':await openPalette();break;case'palette-select':await selectPalette(Number(data.index));break;case'theme':await invoke('settings:update',{theme:data.value});break;case'accent':await invoke('settings:update',{accent:data.value});break;case'vpn-action':{if(!['vpn:refresh','vpn:connect','vpn:disconnect','vpn:install'].includes(data.command))break;const result=await invoke(data.command);if(result?.status){S.vpn=result;renderPage(true);}break;}case'setting-toggle':{const value=!S.settings[data.setting];if(data.setting==='sidebarCollapsed'){await updateSidebar(value);break;}S.settings[data.setting]=value;await invoke('settings:update',{[data.setting]:value});break;}case'favorite-add':await openDialog('favorite');break;case'dialog-close':await closeDialog();break;case'history-clear':await openDialog('history-clear');break;case'download-open':await invoke('download:open',{id:data.id});break;case'download-reveal':await invoke('download:reveal',{id:data.id});break;case'copy-code':await invoke('clipboard:write',{text:connectionCodes[data.codeId]||''});toast('Copied. Ready for your next connection.');break;case'open-path':await invoke('app:open-path',{kind:data.kind});break;}}
document.addEventListener('click',async event=>{const actionEl=event.target.closest('[data-action]');if(actionEl&&['new','private','workspace','menu','shields','palette','favorite-add','workspace-new','audio'].includes(actionEl.dataset.action))starBurst(actionEl.getBoundingClientRect(),actionEl.dataset.action==='workspace'?1:0);if(floating&&!event.target.closest('#floating')&&!(floating==='suggestions'&&event.target.closest('#search-suggestions,#address-form,#home-search-form'))&&!['menu','shields','audio'].includes(actionEl?.dataset.action))await closeFloating();if(floating==='tabmenu'&&actionEl)await closeFloating();if(actionEl){event.preventDefault();event.stopPropagation();await action(actionEl.dataset.action,actionEl.dataset);return;}const tab=event.target.closest('[data-tab-id]');if(tab){starBurst(tab.getBoundingClientRect(),1);await invoke('tab:activate',{id:tab.dataset.tabId});return;}const card=event.target.closest('[data-mission-tab]');if(card){await invoke('tab:activate',{id:card.dataset.missionTab});await closeMission();return;}if(event.target===$('#palette'))await closePalette(true);else if(event.target===$('#dialog'))await closeDialog();else if(floating&&!event.target.closest('#floating')&&!(floating==='suggestions'&&event.target.closest('#search-suggestions,#address-form,#home-search-form')))await closeFloating();});
document.addEventListener('submit',async event=>{event.preventDefault();if(event.target.id==='address-form'){const value=$('#address').value.trim();addressEdited=false;if(value){$('#address').blur();await go(value);}}else if(event.target.id==='home-search-form'){const value=$('#home-search').value.trim();if(value)await go(value);}else if(event.target.id==='palette-form')await selectPalette(paletteIndex);else if(event.target.id==='dialog-form'){const type=event.target.dataset.type,id=event.target.dataset.id;if(type==='favorite'){let url=$('#dialog-url').value.trim();const title=$('#dialog-title').value.trim();if(url&&title){if(!/^https?:\/\//i.test(url))url='https://'+url;try{const parsed=new URL(url);if(!['https:','http:'].includes(parsed.protocol))throw new Error('scheme');url=parsed.href;}catch{toast('Enter a valid web address.');return;}await invoke('bookmark:toggle',{url,title});await closeDialog();toast('Saved to your favorites.');}}else if(type==='history-clear'){await invoke('history:clear',{});await closeDialog();}else if(type==='workspace-delete'){await invoke('workspace:delete',{id});await closeDialog();}else{const name=$('#dialog-name').value.trim();if(!name)return;await invoke(type==='workspace-rename'?'workspace:rename':'workspace:add',type==='workspace-rename'?{id,name}:{name,color:agentColor(name)});await closeDialog();}}});
document.addEventListener('input',event=>{if(event.target.id==='palette-input'){paletteIndex=0;renderPalette();}else if(event.target.id==='mission-filter'){missionQuery=event.target.value;missionPage=0;renderMission();}else if(event.target.id==='page-filter'){pageQuery=event.target.value;renderPage(true);}});
document.addEventListener('change',event=>{if(event.target.matches('select[data-setting]'))invoke('settings:update',{[event.target.dataset.setting]:event.target.value});});
document.addEventListener('input',event=>{if(event.target.id==='media-volume')setTabVolume(event.target.dataset.id,Number(event.target.value)/100);});
document.addEventListener('change',event=>{if(event.target.id==='media-volume')setTabVolume(event.target.dataset.id,Number(event.target.value)/100,true);else if(event.target.id==='media-video-select'){mediaVideoId=event.target.value;updateAudioPopover();}});
document.addEventListener('keydown',event=>{
  const choice=event.target.closest?.('[data-action="accent"]');if(!choice||!['ArrowRight','ArrowLeft','ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();event.stopImmediatePropagation();const choices=$$('[data-action="accent"]'),index=choices.indexOf(choice);
  const next=event.key==='Home'?0:event.key==='End'?choices.length-1:(index+(['ArrowLeft','ArrowUp'].includes(event.key)?choices.length-1:1))%choices.length;
  choices[next].focus();action('accent',choices[next].dataset);
},true);
$('#address').addEventListener('focus',()=>{$('#address-shortcut').style.display='none';$('#address').select();});$('#address').addEventListener('blur',()=>{addressEdited=false;$('#address-shortcut').style.display='';});
$('#address').addEventListener('input',()=>{addressEdited=true;});
document.addEventListener('input',event=>{if(['address','home-search'].includes(event.target.id)&&!event.isComposing)scheduleSuggestions(event.target);});
document.addEventListener('compositionend',event=>{if(['address','home-search'].includes(event.target.id))scheduleSuggestions(event.target);});
document.addEventListener('focusin',event=>{if(!restoringFieldFocus&&['address','home-search'].includes(event.target.id)&&event.target.value.trim())scheduleSuggestions(event.target);});
document.addEventListener('focusout',event=>{if(['address','home-search'].includes(event.target.id))queueMicrotask(()=>{if(searchSession&&document.activeElement?.id!==searchSession.inputId)closeSuggestions();});});
document.addEventListener('keydown',event=>{
  if(!searchSession||document.activeElement?.id!==searchSession.inputId)return;
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    event.preventDefault();event.stopImmediatePropagation();
    const count=searchSession.items.length,index=searchSession.index;
    setSuggestionIndex(event.key==='ArrowDown'?(index+1)%count:(index<0?count-1:(index-1+count)%count));
  }else if(event.key==='Escape'){
    event.preventDefault();event.stopImmediatePropagation();closeSuggestions(true);
  }else if(event.key==='Enter'&&searchSession.index>=0){
    event.preventDefault();event.stopImmediatePropagation();selectSuggestion(searchSession.index);
  }else if(event.key==='Tab')closeSuggestions(true);
},true);
$('#search-suggestions').addEventListener('pointerdown',event=>{if(event.button===0&&event.target.closest('[data-suggestion-index]'))event.preventDefault();});
$('#search-suggestions').addEventListener('click',event=>{const option=event.target.closest('[data-suggestion-index]');if(!option)return;event.preventDefault();event.stopPropagation();selectSuggestion(Number(option.dataset.suggestionIndex));});
$('#search-suggestions').addEventListener('pointermove',event=>{const option=event.target.closest('[data-suggestion-index]');if(option&&Number(option.dataset.suggestionIndex)!==searchSession?.index)setSuggestionIndex(Number(option.dataset.suggestionIndex),false);});
document.addEventListener('scroll',positionSuggestions,true);
addEventListener('blur',()=>{if(searchSession)closeSuggestions();});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{positionSidebarToggle(false);stopInteractionMotion();});
async function focusAddress(){if(S.missionOpen)await invoke('ui:mission',{open:false});if(paletteOpen)await closePalette();if(dialogOpen)await closeDialog(false);await closeFloating();await invoke('ui:focus-chrome');$('#address').focus();$('#address').select();}
document.addEventListener('keydown',async event=>{if(event.key==='Tab'){const modal=dialogOpen?$('#dialog'):paletteOpen?$('#palette'):S.missionOpen?$('#mission'):['audio','menu','shields','tabmenu'].includes(floating)?$('#floating'):null;if(modal){const items=$$('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',modal).filter(el=>el.getClientRects().length);const first=items[0],last=items.at(-1);if(items.length&&(!modal.contains(document.activeElement)||(event.shiftKey&&document.activeElement===first)||(!event.shiftKey&&document.activeElement===last))){event.preventDefault();(event.shiftKey?last:first).focus();return;}}}if(event.key==='Escape'){if(dialogOpen)await closeDialog();else if(paletteOpen)await closePalette(true);else if(floating==='audio')await closeAudio(true);else if(floating)await closeFloating(true);else if(S.missionOpen)await closeMission();else{$('#address').blur();await invoke('ui:focus-page');}event.preventDefault();return;}if(['menu','tabmenu'].includes(floating)&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)){const items=$$('button:not(:disabled)',$('#floating')),index=items.indexOf(event.target.closest('button'));if(items.length){const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowUp'?items.length-1:1))%items.length;items[next].focus();event.preventDefault();return;}}if(paletteOpen&&['ArrowDown','ArrowUp'].includes(event.key)){paletteIndex=Math.max(0,Math.min(paletteItems.length-1,paletteIndex+(event.key==='ArrowDown'?1:-1)));renderPalette();$('.palette-item.active')?.scrollIntoView({block:'nearest'});event.preventDefault();return;}const tab=event.target.closest?.('[data-tab-id]');if(tab&&['Enter',' '].includes(event.key)&&!event.target.closest('button')){event.preventDefault();await invoke('tab:activate',{id:tab.dataset.tabId});return;}const mission=event.target.closest?.('[data-mission-tab]');if(mission&&['Enter',' '].includes(event.key)&&!event.target.closest('button')){event.preventDefault();await invoke('tab:activate',{id:mission.dataset.missionTab});await closeMission();return;}if(!(event.metaKey||event.ctrlKey))return;const key=event.key.toLowerCase();if(key==='l'){event.preventDefault();focusAddress();}else if(key==='k'){event.preventDefault();await openPalette();}else if(key==='m'&&event.shiftKey){event.preventDefault();await action('mission');}else if(key==='d'){event.preventDefault();await invoke('bookmark:toggle',{});}else if(key===','){event.preventDefault();await go('aster://settings');}});
document.addEventListener('contextmenu',async event=>{const tab=event.target.closest('[data-tab-id],[data-mission-tab]');if(!tab)return;event.preventDefault();const id=tab.dataset.tabId||tab.dataset.missionTab,anchor=captureFocusAnchor(tab);const request=await beginTransient('tabmenu');if(request===null)return;transientFocusAnchor=anchor;const item=S.tabs.find(t=>t.id===id);if(!item){await closeFloating();return;}$('#floating').classList.remove('hidden');$('#floating').innerHTML=`${/^https?:/.test(item.url||'')?`<button class="menu-item" data-action="audio" data-id="${E(id)}">${icon('volume')}Audio & video controls</button><div class="menu-divider"></div>`:''}<button class="menu-item" data-action="pin-tab" data-id="${E(id)}">${icon('pin')}${item?.pinned?'Unpin tab':'Pin tab'}</button><button class="menu-item" data-action="mute" data-id="${E(id)}">${icon(item?.muted?'volume':'mute')}${item?.muted?'Unmute tab':'Mute tab'}</button><div class="menu-divider"></div>${S.workspaces.filter(w=>w.id!==item?.workspace).map(w=>`<button class="menu-item" data-action="move-tab" data-id="${E(id)}" data-workspace="${E(w.id)}">${icon('folder')}Move to ${E(w.name)}</button>`).join('')}<div class="menu-divider"></div><button class="menu-item" data-action="close-tab" data-id="${E(id)}">${icon('close')}Close tab<kbd>${shortcut('⌘W')}</kbd></button>`;$('#floating').setAttribute('role','dialog');$('#floating').setAttribute('aria-modal','true');$('#floating').setAttribute('aria-label','Tab actions');await invoke('ui:focus-chrome');if(request===transientGeneration&&floating==='tabmenu')$('#floating button:not(:disabled)')?.focus({preventScroll:true});});
const originalAction=action;
action=async function(name,data={}){if(name==='pin-tab'){await invoke('tab:pin',{id:data.id});await closeFloating();}else if(name==='move-tab'){await invoke('tab:move',{id:data.id,workspace:data.workspace});await closeFloating();}else if(name==='reload'&&activeTab()?.isLoading){await invoke('tab:stop',{});}else if(name==='find'){openFind();}else if(name==='find-next'){await invoke('page:find',{text:$('#find-text')?.value||'',next:true});}else if(name==='find-prev'){await invoke('page:find',{text:$('#find-text')?.value||'',next:true,backwards:true});}else if(name==='find-close'){closeFind();}else await originalAction(name,data);};
async function openFind(){if(internalRoute()){toast('Open a web page to find text.');return;}if(!$('#find-bar')){const bar=document.createElement('form');bar.id='find-bar';bar.className='find-bar';bar.innerHTML=`${icon('search')}<input id="find-text" aria-label="Find in page" placeholder="Find in page…" autocomplete="off"><button type="button" data-action="find-prev" title="Previous match" aria-label="Previous match">${icon('back')}</button><button type="submit" title="Next match" aria-label="Next match">${icon('forward')}</button><button type="button" data-action="find-close" title="Close find" aria-label="Close find">${icon('close')}</button>`;$('.toolbar').append(bar);bar.addEventListener('submit',e=>{e.preventDefault();invoke('page:find',{text:$('#find-text').value,next:true});});$('#find-text').addEventListener('input',()=>invoke('page:find',{text:$('#find-text').value}));$('#find-text').addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeFind();}});}const findBar=$('#find-bar'),findTab=S.activeTabId;await invoke('ui:focus-chrome');if($('#find-bar')!==findBar||S.activeTabId!==findTab)return;$('#find-text').focus();$('#find-text').select();}
function closeFind(restorePage=true){const bar=$('#find-bar');if(!bar)return;bar.remove();invoke('page:find',{text:''});if(restorePage)invoke('ui:focus-page');}
document.addEventListener('dragstart',event=>{const tab=event.target.closest('[data-tab-id],[data-mission-tab]');if(!tab)return;draggedTab=tab.dataset.tabId||tab.dataset.missionTab;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',draggedTab);requestAnimationFrame(()=>tab.classList.add('dragging'));});
document.addEventListener('dragover',event=>{const target=event.target.closest('[data-tab-id],[data-mission-tab],[data-drop-workspace],.space-chip[data-id]');if(!target||!draggedTab)return;event.preventDefault();event.dataTransfer.dropEffect='move';target.classList.add('drop-target');});
document.addEventListener('dragleave',event=>{const target=event.target.closest('.drop-target');if(target&&!target.contains(event.relatedTarget))target.classList.remove('drop-target');});
document.addEventListener('drop',async event=>{const target=event.target.closest('[data-tab-id],[data-mission-tab],[data-drop-workspace],.space-chip[data-id]');if(!target||!draggedTab)return;event.preventDefault();const moved=draggedTab;draggedTab=null;$$('.dragging,.drop-target').forEach(e=>e.classList.remove('dragging','drop-target'));const workspace=target.dataset.dropWorkspace||(target.classList.contains('space-chip')?target.dataset.id:null);if(workspace)await invoke('tab:move',{id:moved,workspace});else{const before=target.dataset.tabId||target.dataset.missionTab;if(before===moved)return;const ids=S.tabs.map(t=>t.id).filter(id=>id!==moved);ids.splice(ids.indexOf(before),0,moved);await invoke('tab:reorder',{ids});}});
document.addEventListener('dragend',()=>{draggedTab=null;$$('.dragging,.drop-target').forEach(e=>e.classList.remove('dragging','drop-target'));});
let wheelLock=false;$('#mission').addEventListener('wheel',event=>{if(!S.missionOpen||Math.abs(event.deltaX)<35||wheelLock)return;const {capacity}=missionGeometry(),pages=Math.max(1,Math.ceil((missionTabs().length+1)/capacity));missionPage=Math.max(0,Math.min(pages-1,missionPage+(event.deltaX>0?1:-1)));renderMission();wheelLock=true;setTimeout(()=>wheelLock=false,500);});
addEventListener('resize',()=>{positionSidebarToggle(false);positionSuggestions();positionAudioPopover();if(S.missionOpen)renderMission();});matchMedia('(prefers-color-scheme:dark)').addEventListener('change',setTheme);
fillStaticIcons();
api.onState(renderState);
api.onCommand(command=>{const name=typeof command==='string'?command:command.command;const payload=typeof command==='object'?command:{};if(['focus-address','address','focusAddress'].includes(name))focusAddress();else if(['palette','command-palette'].includes(name))openPalette();else if(['mission','mission-control'].includes(name))action('mission');else if(['settings','history','bookmarks','downloads','agents'].includes(name))go('aster://'+name);else if(name==='window-visibility'){hostVisible=payload.visible===true;syncOrbMotion();}else if(name==='toast')toast(payload.message||'');else if(name==='new-tab')action('new');else if(name==='find')openFind();});
api.invoke('state:get').then(renderState).catch(error=>toast(error.message));
