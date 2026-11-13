// The deployed build version, e.g. 'abc1234-20261113T1530' (short commit sha + UTC build time).
// scripts/build-site.mjs replaces the placeholder below at deploy time; locally it stays 'dev'.
// The service worker cache name uses the same version.
export const APP_VERSION = /* __APP_VERSION__ */ 'dev';
