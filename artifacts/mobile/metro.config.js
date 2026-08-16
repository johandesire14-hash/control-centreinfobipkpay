const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);

// Replit : ne pas faire surveiller tout le monorepo ni les caches générés.
config.watchFolders = [
  projectRoot,
  path.join(workspaceRoot, "lib"),
];

config.resolver.blockList = [
  /\/\.git\/.*$/,
  /\/\.expo\/.*$/,
  /\/node_modules\/.*\/node_modules\/.*$/,
];

config.maxWorkers = 2;

module.exports = config;
