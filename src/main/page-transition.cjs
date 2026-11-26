'use strict';

// Animate the real page surface without fading through the native canvas.
// Scaling starts above1 so no unpainted border is uncovered. The additive
// individual scale leaves a site's own transform/scale and layout intact.
const PAGE_ENTER_SCRIPT = `(() => {
  const root=document.documentElement;
  if(!root)return false;
  for(const motion of root.getAnimations())if(motion.id==='aster-page-enter')motion.cancel();
  if(matchMedia('(prefers-reduced-motion: reduce)').matches||document.fullscreenElement)return false;
  const motion=root.animate([{scale:'1.012'},{scale:'1'}],{duration:200,easing:'cubic-bezier(.22,.8,.25,1)',composite:'add'});
  motion.id='aster-page-enter';
  return true;
})()`;

module.exports = { PAGE_ENTER_SCRIPT };
