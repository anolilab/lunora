// Default Metro config for a standalone Expo project. `expo start` reads this to
// bundle the app for iOS, Android, and web. Add `watchFolders` / custom resolver
// settings here if you later move the app into a monorepo.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
