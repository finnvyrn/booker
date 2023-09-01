const proxy = require("node-global-proxy").default;
const libgen = require("libgen");

(async () => {
  proxy.setConfig({
    http: "http://127.0.0.1:7890",
    https: "http://127.0.0.1:7890",
  });
  proxy.start();

  const urlString = await libgen.mirror();
  console.log(`${urlString} is currently fastest`);
})();
