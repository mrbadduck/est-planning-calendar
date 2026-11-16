/* ui.js — toasts and the shared data-tip tooltip bubble (with its document listeners).
   Owns: toast, hideToast, showTip, hideTip, _toastEl, _toastT, _tip, _tipFor, _tipMuted
   Reads: nothing
   Writes: nothing
   Loaded after: feedback.js (file-map order; its listeners keep their original order relative to those in app.js) */

let _toastEl=null, _toastT=null;
function toast(msg, kind){
  if(!_toastEl){ _toastEl=document.createElement('div'); _toastEl.className='toast'; document.body.appendChild(_toastEl); }
  _toastEl.textContent=msg; _toastEl.className='toast show'+(kind?' '+kind:'');
  clearTimeout(_toastT);
  if(kind!=='busy') _toastT=setTimeout(()=>{ if(_toastEl) _toastEl.className='toast'; }, 2200);
}
function hideToast(){ clearTimeout(_toastT); if(_toastEl) _toastEl.className='toast'; }
/* ---- tooltips: any element with data-tip gets one shared bubble, shown at once
   on hover or keyboard focus (title= is slow and never shows for keyboards).
   Fixed-position so a modal can't clip it; touch gets none (there's no hover). */
const _tip=document.createElement('div'); _tip.className='tip'; _tip.setAttribute('role','tooltip'); _tip.hidden=true;
document.body.appendChild(_tip);
let _tipFor=null;
let _tipMuted=null;   // the element just clicked — no bubble again until the pointer leaves it
function showTip(el){
  const text=el.dataset.tip; if(!text) return;
  _tipFor=el; _tip.textContent=text; _tip.hidden=false;
  const r=el.getBoundingClientRect(), w=_tip.offsetWidth, h=_tip.offsetHeight, vw=document.documentElement.clientWidth;   // (not innerWidth: that includes a scrollbar)
  const left=Math.max(6, Math.min(r.left + r.width/2 - w/2, vw - w - 6));
  const top=(r.bottom + 6 + h > innerHeight - 6) ? r.top - h - 6 : r.bottom + 6;   // flip above near the bottom edge
  _tip.style.left=left+'px'; _tip.style.top=top+'px';
}
function hideTip(){ _tipFor=null; _tip.hidden=true; }
document.addEventListener('pointerover', e=>{
  if(e.pointerType==='touch') return;
  if(_tipFor && !_tipFor.isConnected) hideTip();   // its element was re-rendered away
  const el=e.target.closest('[data-tip]');
  if(el && el===_tipMuted) return;
  _tipMuted=null;
  if(el){ if(el!==_tipFor) showTip(el); } else if(_tipFor) hideTip();
});
document.addEventListener('pointerout', e=>{ if(!e.relatedTarget) hideTip(); });   // left the window
document.addEventListener('focusin', e=>{ const el=e.target.closest('[data-tip]'); if(el && el.matches(':focus-visible')) showTip(el); });
document.addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', e=>{ _tipMuted=e.target.closest('[data-tip]'); hideTip(); });
document.addEventListener('scroll', hideTip, true);
document.addEventListener('keydown', e=>{ if(e.key==='Escape') hideTip(); });
