/* Shared start-up helpers: Supabase connection, error toasts, phone numbers. */

// Each app keeps its own sign-in (storageKey), so the Back Office login, the
// counter tablet's device login and a customer's phone login never overwrite
// each other, even on the same browser.
function createSupabase(storageKey, {detectSessionInUrl=false}={}){
  if(!window.supabase || !window.supabase.createClient){
    throw Object.assign(new Error('supabase-js not loaded'), {friendly:'Could not load the database library. Check the internet connection and reload the page.'});
  }
  const c = window.CCCC_CONFIG || {};
  return window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, {
    auth: {storageKey, persistSession:true, autoRefreshToken:true, detectSessionInUrl},
  });
}

// Any save that fails without its own error handling shows up as a readable toast.
function setupGlobalErrorToasts(){
  window.addEventListener('unhandledrejection', (e)=>{
    console.error(e.reason);
    if(typeof toast==='function') toast(friendlyError(e.reason), 'error');
  });
}

// Same rules as public.normalize_phone() in the database (PH mobile numbers).
function normalizePhone(p){
  let d = String(p||'').replace(/[^0-9]/g,'');
  if(!d) return null;
  if(d.startsWith('09') && d.length===11) d = '63' + d.slice(1);
  if(d.startsWith('9') && d.length===10) d = '63' + d;
  if(d.length<10 || d.length>15) return null;
  return d;
}
function formatPhone(d){
  if(!d) return '';
  d = String(d);
  if(d.startsWith('63') && d.length===12) return `0${d.slice(2,5)} ${d.slice(5,8)} ${d.slice(8)}`;
  return '+'+d;
}

// Interpret an RPC answer of the form {ok:false, error, message}.
function rpcFailed(res){
  return !res || res.ok === false;
}
function rpcMessage(res, fallback){
  return (res && (res.message || res.error)) || fallback || 'Something went wrong.';
}

// Resize an uploaded photo to a small JPEG data URL (keeps menus fast on phones).
function resizeImageToJpeg(file, maxDim, quality){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onerror = ()=> reject(new Error('Could not read file'));
    reader.onload = ()=>{
      const img = new Image();
      img.onerror = ()=> reject(new Error('Could not decode image'));
      img.onload = ()=>{
        let {width, height} = img;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        width = Math.round(width*scale); height = Math.round(height*scale);
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,width,height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality||0.72));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Base address of this website (works on GitHub Pages sub-folders too).
function siteBaseUrl(){
  const here = location.href.split('#')[0].split('?')[0];
  return here.replace(/\/(backoffice|frontoffice|order)(\/[^/]*)?$/, '/').replace(/[^/]*$/, '');
}
