/* =====================================================================
   Captcha — Cloudflare Turnstile before an anonymous sign-in (QR page first
   visit, counter pairing). OFF while CCCC_CONFIG.CAPTCHA_SITE_KEY is empty:
   then nothing is loaded and getToken() gives null straight away.

   Usage (load after config.js and cloud.js):
     const token = await Captcha.getToken(document.getElementById('captchaBox'));
     await cloud.signInAnonymously({captchaToken: token});   // token null = off
   getToken rejects with a CloudError:
     code 'CAPTCHA_FAILED'  - the check failed or took too long (default 60 s)
     offline: true          - the Turnstile script could not be loaded
   The Turnstile script is the only outside script the apps may load
   (CLAUDE.md decision 10). The service worker never caches it.
   ===================================================================== */
(function(){
  const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  const DEFAULT_TIMEOUT_MS = 60000;
  const FAIL_TEXT = 'We couldn\'t confirm you\'re a person. Check your internet and try again.';
  let loading = null;   // one shared promise while the script loads

  function siteKey(){
    const c = window.CCCC_CONFIG || {};
    return typeof c.CAPTCHA_SITE_KEY === 'string' ? c.CAPTCHA_SITE_KEY.trim() : '';
  }
  function enabled(){ return !!siteKey(); }

  function makeError(message, info){
    const CE = window.Cloud && window.Cloud.CloudError;
    if(CE) return new CE(message, info);
    const e = new Error(message);
    e.name = 'CloudError'; e.code = info.code || null; e.offline = !!info.offline; e.status = 0;
    return e;
  }
  const failed = () => makeError(FAIL_TEXT, {code: 'CAPTCHA_FAILED'});
  const offline = () => makeError(navigator.onLine === false ? 'No internet connection.'
    : 'Could not reach the CAPTCHA check. Check the internet connection.', {offline: true});

  // Adds the Turnstile script once. Resolves with window.turnstile.
  function loadScript(){
    if(window.turnstile && typeof window.turnstile.render === 'function') return Promise.resolve(window.turnstile);
    if(loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT_URL;
      s.async = true;
      s.onload = () => {
        if(window.turnstile && typeof window.turnstile.render === 'function') resolve(window.turnstile);
        else { loading = null; reject(offline()); }
      };
      s.onerror = () => {
        loading = null;   // allow another try later
        try{ s.parentNode && s.parentNode.removeChild(s); }catch(e){}
        reject(offline());
      };
      (document.head || document.body || document.documentElement).appendChild(s);
    });
    return loading;
  }

  // container: the element the page reserves for the widget (most people see
  // nothing; a few see a single tick box). opts.timeoutMs: default 60000.
  function getToken(container, opts){
    if(!enabled()) return Promise.resolve(null);
    opts = opts || {};
    const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    if(navigator.onLine === false) return Promise.reject(offline());

    return new Promise((resolve, reject) => {
      let done = false, widgetId = null, ts = null, ownBox = null;
      const box = (container && container.nodeType === 1) ? container
        : (ownBox = document.createElement('div'), document.body.appendChild(ownBox), ownBox);

      function cleanup(){
        clearTimeout(timer);
        if(ts && widgetId != null){ try{ ts.remove(widgetId); }catch(e){} }
        if(ownBox){ try{ ownBox.parentNode && ownBox.parentNode.removeChild(ownBox); }catch(e){} }
      }
      function finish(err, token){
        if(done) return;
        done = true;
        cleanup();
        if(err) reject(err); else resolve(token);
      }
      const timer = setTimeout(() => finish(failed()), timeoutMs);

      loadScript().then(t => {
        if(done) return;
        ts = t;
        try{
          widgetId = ts.render(box, {
            sitekey: siteKey(),
            appearance: 'interaction-only',     // shows only if a person must tick
            'refresh-expired': 'manual',
            callback: token => token ? finish(null, String(token)) : finish(failed()),
            'error-callback': () => { finish(failed()); return true; },
            'timeout-callback': () => finish(failed()),
            'unsupported-callback': () => finish(failed()),
          });
          if(widgetId === undefined || widgetId === null) finish(failed());
          else if(done){ try{ ts.remove(widgetId); }catch(e){} }   // finished during render
        }catch(e){ finish(failed()); }
      }, err => finish(err && err.offline ? err : offline()));
    });
  }

  window.Captcha = {enabled, getToken, SCRIPT_URL};
})();
