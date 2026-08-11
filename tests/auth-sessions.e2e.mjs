const B='http://localhost:3000/api/v1';
let pass=0,fail=0;
const chk=(name,ok,extra='')=>{ok?pass++:fail++;console.log(`${ok?'✅':'❌'} ${name}${extra?'  ['+extra+']':''}`)};
async function call(m,p,body,token){
  const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json','Accept-language':'en',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  let j=null; try{j=await r.json()}catch{}
  return {status:r.status,json:j};
}

// ── 1. Existing admin can still sign in (backfill worked, login delegation works)
const admin=await call('POST','/users/login',{email:process.env.SEED_ADMIN_EMAIL||'super_admin@admin.com',password:process.env.SEED_ADMIN_PASSWORD||'P@ssw0rd@123',device_info:'e2e-suite'});
chk('admin login still works after session-hash migration',admin.status===200,`status ${admin.status}`);
const T=admin.json?.data?.token;
chk('login returns a token',typeof T==='string'&&T.length===64);
chk('login still carries permission_keys',Array.isArray(admin.json?.data?.permission_keys));
chk('user DTO exposes email_verified',admin.json?.data?.user?.email_verified===true,String(admin.json?.data?.user?.email_verified));

// ── 2. Wrong password is indistinguishable from unknown address
const wrong=await call('POST','/users/login',{email:'super_admin@admin.com',password:'definitely-wrong-1'});
const unknown=await call('POST','/users/login',{email:'nobody-at-all@example.com',password:'definitely-wrong-1'});
chk('wrong password and unknown address return the same status',wrong.status===unknown.status&&wrong.status===401,`${wrong.status}/${unknown.status}`);
chk('...and the same message',wrong.json?.message===unknown.json?.message,wrong.json?.message);

// ── 3. Sessions endpoints
const sess=await call('GET','/auth/sessions',null,T);
chk('GET /auth/sessions lists my devices',sess.status===200&&Array.isArray(sess.json?.data),`status ${sess.status}`);
const cur=sess.json?.data?.find(s=>s.is_current);
chk('current session is flagged',!!cur,JSON.stringify(sess.json?.data?.map(s=>({id:s.id,cur:s.is_current}))));
chk('session never exposes a token',JSON.stringify(sess.json).includes(T)===false);
chk('session carries provider + expiry',cur?.provider==='local'&&!!cur?.expires_at,`${cur?.provider} ${cur?.expires_at}`);

// ── 4. Refresh: young token must NOT rotate
const ref=await call('POST','/auth/refresh',null,T);
chk('POST /auth/refresh succeeds',ref.status===200,`status ${ref.status}`);
chk('a fresh token is not rotated',ref.json?.data?.rotated===false,String(ref.json?.data?.rotated));
chk('refresh returns the same token when not rotated',ref.json?.data?.token===T);

// ── 5. Refresh with a dead token is 401, not a new session
const dead=await call('POST','/auth/refresh',null,'0'.repeat(64));
chk('refresh with an unknown token is 401',dead.status===401,`status ${dead.status}`);

// ── 6. Revoking someone else's / nonexistent session is 404 (no enumeration)
const ghost=await call('DELETE','/auth/sessions/999999',null,T);
chk('revoking a nonexistent session is 404',ghost.status===404,`status ${ghost.status}`);

// ── 7. forgot-password: identical answer for registered and unregistered
const f1=await call('POST','/auth/forgot-password',{email:'super_admin@admin.com'});
const f2=await call('POST','/auth/forgot-password',{email:'nobody-at-all@example.com'});
chk('forgot-password answers identically for both',f1.status===f2.status&&f1.json?.message===f2.json?.message,`${f1.status}/${f2.status}`);

// ── 8. reset-password with a bogus code is a generic 422
const bad=await call('POST','/auth/reset-password',{email:'super_admin@admin.com',code:'ZZZZZZZZ',new_password:'Newpass123'});
chk('a wrong reset code is 422',bad.status===422,`status ${bad.status}`);
chk('...with the generic message_key',bad.json?.data?.message_key==='reset_code_invalid',bad.json?.data?.message_key);

// ── 9. Legacy alias still routes
const legacy=await call('POST','/users/forgot-password',{email:'super_admin@admin.com'});
chk('deprecated /users/forgot-password still works',legacy.status===200,`status ${legacy.status}`);

// ── 10. change-password now requires auth BEFORE validating the body
const anon=await call('POST','/users/change-password',{current_password:'x',new_password:'Newpass123'});
chk('unauthenticated change-password is 401',anon.status===401,`status ${anon.status}`);

// ── 11. Logout kills only this session, and the token stops working
const l=await call('POST','/users/logout',null,T);
chk('logout succeeds',l.status===200,`status ${l.status}`);
const after=await call('GET','/auth/sessions',null,T);
chk('the token is dead afterwards',after.status===401,`status ${after.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
