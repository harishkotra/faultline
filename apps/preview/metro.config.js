const { getDefaultConfig } = require('expo/metro-config');

// Faultline lives inside the older Kairo workspace. Pin Metro to this Expo app
// so it does not inherit Kairo's Expo 57 configuration and dependencies.
module.exports = getDefaultConfig(__dirname);
