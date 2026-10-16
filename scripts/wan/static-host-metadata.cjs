const path = require("path");
const os = require("os");
const cache = require(path.resolve(__dirname, "../../runtime/wan/host-cpus.json"));
os.cpus = () => cache.cpus;
