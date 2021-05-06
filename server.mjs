import express from "express";
import { buildCommand, watchCommand } from "./lib.mjs";

async function main() {
  await buildCommand();

  const app = express();

  app.use(
    express.static("dist", {
      cacheControl: true,
      maxAge: "10m",
      immutable: true,
    })
  );

  app.listen(3000, "0.0.0.0", () => {
    console.log("Listening 0.0.0.0:3000");
    watchCommand();
  });
}

main();
