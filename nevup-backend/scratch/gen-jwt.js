const crypto = require('crypto');
const SECRET = '97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02';
function base64url(str) {
  return Buffer.from(str).toString('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function signJWT(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET)
  .update(`${header}.${body}`).digest('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${body}.${sig}`;
}
const now = Math.floor(Date.now() / 1000);
console.log(signJWT({ sub: '11111111-1111-1111-1111-111111111111', iat: now, exp: now + 86400, role: 'trader' }));
