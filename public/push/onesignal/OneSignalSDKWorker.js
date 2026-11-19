// OneSignal's push service worker, in its own scope (/push/onesignal/) so it never
// replaces Kaunta's offline service worker (/sw.js). See src/lib/push.ts.
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
