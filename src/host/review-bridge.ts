/** Build the capability-scoped script used by live page review. */

import { isPreviewToken } from './http.ts'

export function reviewBridgeScript(reviewToken: string | undefined, nonce?: string): string {
  if (!isPreviewToken(reviewToken ?? null)) return ''
  const nonceAttribute = nonce === undefined ? '' : ` nonce="${nonce}"`
  return `<script${nonceAttribute} data-dsh-browser-review data-review-token="${reviewToken}">(function(){
var token=${JSON.stringify(reviewToken)},active=false,suppressClick=false,scrollFrame=0;
function context(){var root=document.documentElement,body=document.body;return{viewportWidth:window.innerWidth,viewportHeight:window.innerHeight,devicePixelRatio:window.devicePixelRatio||1,scrollX:window.scrollX||0,scrollY:window.scrollY||0,documentWidth:Math.max(root?root.scrollWidth:0,body?body.scrollWidth:0),documentHeight:Math.max(root?root.scrollHeight:0,body?body.scrollHeight:0)};}
function send(kind,value){window.parent.postMessage(Object.assign({source:'dsh-browser',kind:kind,reviewToken:token},value||{}),'*');}
function setActive(value){active=value===true;var root=document.documentElement;if(root){if(active)root.setAttribute('data-dsh-browser-review-active','');else root.removeAttribute('data-dsh-browser-review-active');}}
function selector(element){if(element.id&&window.CSS&&CSS.escape)return'#'+CSS.escape(element.id);var parts=[],node=element,depth=0;while(node&&node.nodeType===1&&depth<8){var part=node.tagName.toLowerCase(),parent=node.parentElement;if(parent){var same=Array.prototype.filter.call(parent.children,function(child){return child.tagName===node.tagName;});if(same.length>1)part+=':nth-of-type('+(same.indexOf(node)+1)+')';}parts.unshift(part);if(part==='html')break;node=parent;depth++;}return parts.join(' > ');}
function attributes(element){var result={},items=element.attributes||[];for(var i=0;i<items.length&&i<64;i++){var item=items[i];result[String(item.name).slice(0,256)]=String(item.value).slice(0,1000);}return result;}
function positiveInteger(value){var number=Number(value);return Number.isInteger(number)&&number>0?number:undefined;}
function source(element){var file=element.getAttribute('data-source-file')||element.getAttribute('data-file');if(!file)return undefined;return{file:String(file).slice(0,4096),line:positiveInteger(element.getAttribute('data-source-line')||element.getAttribute('data-line')),column:positiveInteger(element.getAttribute('data-source-column')||element.getAttribute('data-column'))};}
function target(element,x,y){var rect=element.getBoundingClientRect(),pointX=Number.isFinite(x)?x:rect.left+rect.width/2,pointY=Number.isFinite(y)?y:rect.top+rect.height/2;return{kind:'element',source:source(element),selector:selector(element).slice(0,4096),textQuote:String(element.textContent||'').replace(/\\s+/g,' ').trim().slice(0,2000),tagName:String(element.tagName||'element').toLowerCase().slice(0,128),attributes:attributes(element),outerHTML:String(element.outerHTML||'').slice(0,16000),rect:{x:pointX,y:pointY,width:1,height:1}};}
function stop(event){if(event.cancelable)event.preventDefault();event.stopImmediatePropagation();}
function pick(event){if(!active||event.button!==0)return;suppressClick=true;stop(event);var element=event.target&&event.target.nodeType===1?event.target:document.elementFromPoint(event.clientX,event.clientY);if(!element)return;setActive(false);send('review-pick',{target:target(element,event.clientX,event.clientY),context:context()});}
function finish(event){if(!active&&!suppressClick)return;stop(event);if(event.type==='click')suppressClick=false;}
window.addEventListener('message',function(event){var data=event.data;if(event.source!==window.parent||!data||data.source!=='dsh-browser-parent'||data.kind!=='review-mode'||data.reviewToken!==token)return;setActive(data.enabled);send('review-ready',{active:active,context:context()});});
document.addEventListener('pointerdown',pick,true);document.addEventListener('pointerup',finish,true);document.addEventListener('click',finish,true);
window.addEventListener('scroll',function(){if(scrollFrame)return;scrollFrame=requestAnimationFrame(function(){scrollFrame=0;send('review-scroll',{context:context()});});},{passive:true});
var style=document.createElement('style');style.textContent='html[data-dsh-browser-review-active],html[data-dsh-browser-review-active] *{cursor:crosshair!important}';(document.head||document.documentElement).appendChild(style);
send('review-ready',{active:false,context:context()});
})();</script>`
}
