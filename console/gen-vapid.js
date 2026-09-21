/* Generate a VAPID key pair for Web Push:  node gen-vapid.js
   Paste the two lines into .env. Changing them invalidates every existing
   subscription, so generate once and keep them. */
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
