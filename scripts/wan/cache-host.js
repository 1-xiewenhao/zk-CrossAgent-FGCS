const fs = require("fs");
const path = require("path");
const os = require("os");
const target = path.resolve(__dirname, "../../runtime/wan/host-cpus.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify({ cpus: os.cpus() }) + "\n");
console.log("Cached host metadata before timing");
