import { firstRun } from "../src/config.mjs";
const config = firstRun();
console.log(`Command Centre configuration ready: ${config.home}/config.json`);
