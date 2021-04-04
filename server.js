const express = require("express");
const { build, watch } = require("./build");

async function main() {
  await build();

  const app = express();

  app.use(express.static("dist"));

  app.listen(3000, "0.0.0.0", () => {
    console.log("Listening 0.0.0.0:3000");
    watch();
  });
}

main();
