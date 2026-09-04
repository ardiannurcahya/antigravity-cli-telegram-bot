#!/usr/bin/env node

import dns from "node:dns";
import { createRequire } from "node:module";
import { defaultEnvFile, loadEnvFile, runSetup } from "./setup.js";

dns.setDefaultResultOrder?.("ipv4first");

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { name: string; version: string };

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(packageJson.version);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`${packageJson.name} ${packageJson.version}

Start the AGY Telegram gateway.

Usage:
  agy-telegram
  agy-telegram --setup
  agy-telegram --version
  agy-telegram --help

Configure the gateway through environment variables. See the README for the
complete configuration and deployment guide.`);
  process.exit(0);
}

const envFile = process.env.AGY_ENV_FILE || defaultEnvFile();
const savedEnv = await loadEnvFile(envFile);
const explicitEnv = Boolean(process.env.AGY_ENV_FILE);
for (const [key, value] of Object.entries(savedEnv)) {
  if (explicitEnv || process.env[key] === undefined) process.env[key] = value;
}
if (process.argv.includes("--setup") || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ALLOWED_USER_IDS) {
  const configured = await runSetup(process.env, envFile);
  for (const [key, value] of Object.entries(configured)) process.env[key] = value;
}

await import("./index.js");
