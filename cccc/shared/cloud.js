/* =====================================================================
   Cloud — a small, dependency-free client for Supabase:
   login (email, anonymous), database API (read + call functions) and
   file storage. Written in-house instead of loading supabase-js from a
   CDN so the counter keeps working from its offline cache.

   Each page creates its own client with its own storage key, so a staff
   login and a customer login on the same browser never mix:
     const cloud = Cloud.createClient({storageKey: 'cccc.staff.session'});
   ===================================================================== */
(function(){
  const CFG = window.CCCC_CONFIG;

  class CloudError extends Error {
    constructor(message, info){
      super(message);
      info = info || {};
      this.name = 'CloudError';
      this.status = info.status || 0;
      this.code = info.code || null;
      this.details = info.details || null;
      this.hint = info.hint || null;
      this.offline = !!info.offline;
    }
  }

  function authErrorMessage(data, status){
    const errCode = data && typeof data === 'object' ? (data.error_code || '') : '';
    if(errCode === 'over_email_send_rate_limit') return 'Too many emails were sent. Please wait up to an hour, then try again.';
    if(status === 429) return 'Too many attempts from this network. Please wait a few minutes and try again.';
    if(!data) return 'Login failed (' + status + ')';
    if(typeof data === 'string') return data;
    if(errCode === 'same_password') return 'Your new password must be different from your old one.';
    if(errCode === 'reauthentication_needed') return 'For your safety, sign out and sign in again, then change your password.';
    const msg = data.msg || data.error_description || data.message || data.error || ('Login failed (' + status + ')');
    if(/anonymous sign-ins are disabled/i.test(msg)) return 'Anonymous sign-ins are turned off in Supabase (Authentication → Sign In / Providers → Anonymous).';
    if(/email not confirmed/i.test(msg)) return 'Please confirm your email first (check your inbox), then sign in.';
    if(/invalid login credentials/i.test(msg)) return 'Wrong email or password.';
    return msg;
  }

  async function parseBody(res){
    const text = await res.text();
    if(!text) return null;
    try{ return JSON.parse(text); }catch(e){ return text; }
  }

  // Keys Supabase Auth puts in the page address after an email link
  // (password reset, sign-up confirmation, magic link, invite, email change).
  const AUTH_URL_KEYS = ['access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type', 'type',
    'provider_token', 'provider_refresh_token', 'error', 'error_code', 'error_description'];

  function linkErrorText(code, description){
    if(code === 'otp_expired' || /expired|invalid/i.test(description || ''))
      return 'This email link has expired or was already used. Ask for a new email and use the newest link.';
    return description || 'This email link did not work. Ask for a new email and try again.';
  }

  // Reads the login (or the error) Supabase put in a page address. Pure: does not
  // touch the page. hash = location.hash, search = location.search.
  // Returns null (nothing there), {type, session, from:'hash'} or
  // {type, error, error_code, error_description, from:'hash'|'search'}.
  function parseAuthRedirect(hash, search){
    const h = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const q = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const access = h.get('access_token');
    if(access){
      const expiresIn = Number(h.get('expires_in'));
      const expiresAt = Number(h.get('expires_at'));
      return {
        type: h.get('type') || null,
        from: 'hash',
        session: {
          access_token: access,
          refresh_token: h.get('refresh_token') || null,
          expires_at: expiresAt > 0 ? Math.floor(expiresAt)
            : Math.floor(Date.now()/1000) + (expiresIn > 0 ? Math.floor(expiresIn) : 3600),
          user: null,
        },
      };
    }
    const isErr = p => !!(p.get('error') || p.get('error_code') || p.get('error_description'));
    const src = isErr(h) ? 'hash' : (q.get('error_code') || q.get('error_description')) ? 'search' : null;
    if(!src) return null;
    const p = src === 'hash' ? h : q;
    const code = p.get('error_code') || p.get('error') || 'link_error';
    return {type: p.get('type') || null, from: src, error: linkErrorText(code, p.get('error_description')),
            error_code: code, error_description: p.get('error_description') || null};
  }

  // Removes the login / error from the address bar (so it is not bookmarked,
  // shared or left in the history). Other parts of the address are kept.
  function clearAuthFromAddress(from){
    try{
      if(!window.history || !history.replaceState) return;
      let search = location.search;
      if(from === 'search'){
        const q = new URLSearchParams(search.replace(/^\?/, ''));
        AUTH_URL_KEYS.forEach(k => q.delete(k));
        search = q.toString() ? '?' + q.toString() : '';
      }
      const hash = from === 'hash' ? '' : location.hash;
      history.replaceState(history.state, document.title, location.pathname + search + hash);
    }catch(e){ /* very old browser: the address keeps the fragment, nothing else breaks */ }
  }

  function createClient(options){
    const storageKey = (options && options.storageKey) || 'cccc.session';
    let session = readSession();
    let staffToken = null;
    const listeners = new Set();
    const netListeners = new Set();
    let reachable = true;
    function setReachable(v){
      if(reachable === v) return;
      reachable = v;
      netListeners.forEach(fn => { try{ fn(v); }catch(e){} });
    }

    function readSession(){
      try{ return JSON.parse(localStorage.getItem(storageKey)) || null; }catch(e){ return null; }
    }
    function writeSession(s){
      session = s || null;
      try{
        if(session) localStorage.setItem(storageKey, JSON.stringify(session));
        else localStorage.removeItem(storageKey);
      }catch(e){ /* private mode: session lives in memory only */ }
      listeners.forEach(fn => { try{ fn(session); }catch(e){} });
    }
    window.addEventListener('storage', (e)=>{ if(e.key === storageKey) session = readSession(); });

    async function rawFetch(url, opts, timeoutMs){
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(()=>ctrl.abort(), timeoutMs || 20000) : null;
      try{
        const res = await fetch(url, Object.assign({}, opts, ctrl ? {signal: ctrl.signal} : {}));
        setReachable(true);
        return res;
      }catch(e){
        setReachable(false);
        throw new CloudError(navigator.onLine === false ? 'No internet connection.' : 'Could not reach the server. Check the internet connection.', {offline: true});
      }finally{
        if(timer) clearTimeout(timer);
      }
    }

    function sessionFrom(body){
      return {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: body.expires_at || (Math.floor(Date.now()/1000) + (body.expires_in || 3600)),
        user: body.user || null,
      };
    }

    // method defaults to POST; GET sends no body.
    async function authRequest(path, body, bearer, method){
      method = method || 'POST';
      const headers = {'apikey': CFG.SUPABASE_ANON_KEY};
      if(method !== 'GET') headers['Content-Type'] = 'application/json';
      if(bearer) headers.Authorization = 'Bearer ' + bearer;
      const res = await rawFetch(CFG.SUPABASE_URL + '/auth/v1' + path,
        {method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {})});
      const data = await parseBody(res);
      if(!res.ok){
        throw new CloudError(authErrorMessage(data, res.status), {status: res.status, code: data && (data.error_code || data.error || data.code)});
      }
      return data;
    }

    function isExpiring(s){
      return !s || !s.expires_at || (s.expires_at * 1000 - Date.now() < 60 * 1000);
    }

    async function refreshSession(){
      const run = async () => {
        const latest = readSession() || session;
        // Another tab may have refreshed already.
        if(latest && session && latest.access_token !== session.access_token && !isExpiring(latest)){
          session = latest; return latest;
        }
        if(!latest || !latest.refresh_token){
          writeSession(null);
          throw new CloudError('Your login has ended. Please sign in again.', {status: 401, code: 'NO_SESSION'});
        }
        try{
          const data = await authRequest('/token?grant_type=refresh_token', {refresh_token: latest.refresh_token});
          const s = sessionFrom(data);
          writeSession(s);
          return s;
        }catch(e){
          if(!e.offline && e.status >= 400 && e.status < 500 && e.status !== 429) writeSession(null);
          throw e;
        }
      };
      if(navigator.locks && navigator.locks.request){
        return navigator.locks.request('cccc-auth-refresh:' + storageKey, run);
      }
      return run();
    }

    async function accessToken(){
      if(!session) return null;
      if(isExpiring(session)){
        try{ await refreshSession(); }
        catch(e){ if(e.offline) return session ? session.access_token : null; throw e; }
      }
      return session ? session.access_token : null;
    }

    async function apiHeaders(extra){
      const token = await accessToken();
      const h = Object.assign({
        'apikey': CFG.SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + (token || CFG.SUPABASE_ANON_KEY),
      }, extra || {});
      if(staffToken) h['x-staff-token'] = staffToken;
      return h;
    }

    async function rest(method, path, opts){
      opts = opts || {};
      const headers = await apiHeaders(Object.assign({'Content-Type': 'application/json'}, opts.headers || {}));
      const res = await rawFetch(CFG.SUPABASE_URL + '/rest/v1' + path, {
        method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }, opts.timeout);
      if(res.status === 401 && session && opts.retry !== false){
        await refreshSession();
        return rest(method, path, Object.assign({}, opts, {retry: false}));
      }
      const data = await parseBody(res);
      if(!res.ok){
        const msg = (data && (data.message || data.msg)) || ('Request failed (' + res.status + ')');
        throw new CloudError(msg, {status: res.status, code: data && data.code, details: data && data.details, hint: data && data.hint});
      }
      return data;
    }

    function enc(v){ return encodeURIComponent(v); }
    function buildQuery(q){
      q = q || {};
      const parts = ['select=' + enc(q.select || '*')];
      const ops = ['eq','neq','gt','gte','lt','lte','like','ilike'];
      ops.forEach(op => {
        const m = q[op]; if(!m) return;
        Object.keys(m).forEach(col => parts.push(enc(col) + '=' + op + '.' + enc(m[col])));
      });
      if(q.in) Object.keys(q.in).forEach(col => {
        const vals = (q.in[col] || []).map(v => '"' + String(v).replace(/"/g, '\\"') + '"').join(',');
        parts.push(enc(col) + '=in.(' + enc(vals) + ')');
      });
      if(q.is) Object.keys(q.is).forEach(col => parts.push(enc(col) + '=is.' + (q.is[col] === null ? 'null' : q.is[col])));
      if(q.order) parts.push('order=' + enc(q.order));
      if(q.limit != null) parts.push('limit=' + Number(q.limit));
      if(q.offset) parts.push('offset=' + Number(q.offset));
      return parts.join('&');
    }

    const api = {
      CloudError,
      storageKey,
      get session(){ return session; },
      user(){ return session ? session.user : null; },
      userId(){ return session && session.user ? session.user.id : null; },
      isAnonymous(){ return !!(session && session.user && session.user.is_anonymous); },
      onChange(fn){ listeners.add(fn); return () => listeners.delete(fn); },
      // Real connectivity: false after a request fails to reach the server, true after one succeeds.
      onNetwork(fn){ netListeners.add(fn); return () => netListeners.delete(fn); },
      isReachable(){ return reachable && navigator.onLine !== false; },
      setStaffToken(t){ staffToken = t || null; },
      getStaffToken(){ return staffToken; },

      async signInAnonymously(){
        const data = await authRequest('/signup', {data: {}});
        if(!data || !data.access_token) throw new CloudError('Anonymous login did not return a session.');
        writeSession(sessionFrom(data));
        return session;
      },
      async signInWithPassword(email, password){
        const data = await authRequest('/token?grant_type=password', {email, password});
        writeSession(sessionFrom(data));
        return session;
      },
      // Returns {session} when logged in straight away, or {needsConfirmation:true} when
      // Supabase is set to require email confirmation first.
      async signUp(email, password, metadata){
        const data = await authRequest('/signup', {email, password, data: metadata || {}});
        if(data && data.access_token){ writeSession(sessionFrom(data)); return {session}; }
        return {needsConfirmation: true};
      },
      async resetPassword(email, redirectTo){
        const path = '/recover' + (redirectTo ? '?redirect_to=' + enc(redirectTo) : '');
        return authRequest(path, {email});
      },
      // Call once when the page loads (Back Office). When the owner arrives from an
      // email link (e.g. "Reset password"), Supabase puts a login in the page address:
      //   #access_token=…&refresh_token=…&expires_in=3600&expires_at=…&type=recovery
      // This saves it as this client's session, removes it from the address bar and returns
      //   null                      nothing in the address
      //   {type, session}           logged in; type = 'recovery' for a password reset
      //   {type, error, error_code} the link failed (e.g. expired) - error is a plain sentence
      async sessionFromUrl(){
        const parsed = parseAuthRedirect(location.hash, location.search);
        if(!parsed) return null;
        clearAuthFromAddress(parsed.from);
        if(parsed.error) return {type: parsed.type, error: parsed.error, error_code: parsed.error_code};
        const s = parsed.session;
        try{
          s.user = await authRequest('/user', null, s.access_token, 'GET');
        }catch(e){
          // A token the server refuses is not kept. Offline / server trouble: keep it,
          // the user details are filled in by the next refresh.
          if(!e.offline && (e.status === 401 || e.status === 403)){
            return {type: parsed.type, error: linkErrorText('otp_expired'), error_code: e.code || 'bad_jwt'};
          }
        }
        writeSession(s);
        return {type: parsed.type, session};
      },
      // Sets a new password for the logged-in user (after sessionFromUrl() returned
      // type 'recovery', or from a "Change password" screen). Returns the updated user.
      async updatePassword(newPassword){
        if(typeof newPassword !== 'string' || !newPassword) throw new CloudError('Enter a new password.', {code: 'NO_PASSWORD'});
        if(!session) throw new CloudError('Your login has ended. Please sign in again.', {status: 401, code: 'NO_SESSION'});
        const send = async () => authRequest('/user', {password: newPassword}, await accessToken(), 'PUT');
        let user;
        try{ user = await send(); }
        catch(e){
          if(e.status !== 401 || !session) throw e;
          await refreshSession();
          user = await send();
        }
        if(user && user.id && session) writeSession(Object.assign({}, session, {user}));
        return user;
      },
      async signOut(){
        const token = session ? session.access_token : null;
        writeSession(null);
        staffToken = null;
        if(token){ try{ await authRequest('/logout', {}, token); }catch(e){ /* already gone */ } }
      },
      // Makes sure the saved login is still valid (refreshing it if needed).
      // Returns the session, or null if there is no usable login. Offline keeps the saved one.
      async ensureSession(){
        if(!session) return null;
        try{ await accessToken(); }
        catch(e){ if(!e.offline) return null; }
        return session;
      },

      rpc(name, args, opts){
        return rest('POST', '/rpc/' + name, Object.assign({body: args || {}}, opts || {}));
      },
      select(table, query, opts){
        return rest('GET', '/' + table + '?' + buildQuery(query), opts || {});
      },
      async selectAll(table, query, pageSize){
        pageSize = pageSize || 1000;
        const out = [];
        for(let offset = 0; ; offset += pageSize){
          const page = await api.select(table, Object.assign({}, query, {limit: pageSize, offset}));
          out.push.apply(out, page || []);
          if(!page || page.length < pageSize) break;
        }
        return out;
      },

      async upload(bucket, path, blob, contentType){
        const headers = await apiHeaders({'Content-Type': contentType || blob.type || 'application/octet-stream', 'x-upsert': 'true', 'cache-control': '3600'});
        delete headers['x-staff-token'];
        const res = await rawFetch(CFG.SUPABASE_URL + '/storage/v1/object/' + bucket + '/' + path, {method: 'POST', headers, body: blob}, 60000);
        const data = await parseBody(res);
        if(!res.ok) throw new CloudError((data && (data.message || data.error)) || ('Upload failed (' + res.status + ')'), {status: res.status});
        return api.publicUrl(bucket, path);
      },
      publicUrl(bucket, path){
        return CFG.SUPABASE_URL + '/storage/v1/object/public/' + bucket + '/' + path;
      },
    };
    return api;
  }

  // RFC 4122 v4 UUIDs (falls back when crypto.randomUUID is unavailable, e.g. plain http)
  function uuid(){
    if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
  }

  window.Cloud = {createClient, CloudError, uuid, parseAuthRedirect};
})();
