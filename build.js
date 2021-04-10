const {
  watch,
  copyFile,
  mkdir,
  readFile,
  writeFile,
  readdir,
} = require("fs/promises");
const { promisify } = require("util");
const path = require("path");
const rimraf = promisify(require("rimraf"));
const { render } = require("mustache");
const csso = require("csso");
const htmlMinifier = require("html-minifier");

async function copy(file) {
  const src = path.join("src", "content", file);
  const dist = path.join("dist", file);

  await copyFile(src, dist);
}

function minifyHTML(content) {
  return htmlMinifier.minify(content, {
    collapseBooleanAttributes: true,
    collapseWhitespace: true,
    decodeEntities: true,
    removeAttributeQuotes: true,
    removeComments: true,
    removeEmptyAttributes: true,
    removeOptionalTags: true,
    removeRedundantAttributes: true,
    useShortDoctype: true,
    sortAttributes: true,
    sortClassName: true,
  });
}

async function processHTML(file, context) {
  const src = path.join("src", "content", file);
  const dist = path.join("dist", file);

  const template = await readFile(src, "utf-8");
  const result = minifyHTML(render(template, context));

  await writeFile(dist, result);
}

async function processCSS(file, context) {
  const src = path.join("src", "content", file);
  const dist = path.join("dist", file);

  const template = await readFile(src, "utf-8");
  const result = csso.minify(template, context).css;

  await writeFile(dist, result);
}

async function processPost({ post, templates }) {
  const result = minifyHTML(
    render(templates.post, {
      ...post,
      ym: templates.ym,
      links: templates.links,
    })
  );

  await writeFile(post.dist, result);
}

// https://stevemorse.org/russian/rus2eng.html
// https://markdowntohtml.com/

function parseMeta(content) {
  const meta = {};
  const rows = content.split("\n");

  if (rows[0] === "---") {
    const till = rows.slice(1).indexOf("---");

    if (till >= 0) {
      const metaContent = rows.slice(1, till + 1);
      content = rows.slice(till + 2).join("\n");

      for (const row of metaContent) {
        const matches = /^([^:]+):(.*)$/.exec(row);
        if (matches) {
          meta[matches[1].trim()] = matches[2].trim();
        }
      }
    }
  }

  return {
    meta,
    content,
  };
}

async function parsePosts() {
  const posts = [];

  const files = (await readdir("src/content/posts")).reverse();

  for (const file of files) {
    const matches = /^(\d{4}-\d{2}-\d{2})-(.+)\.html$/.exec(file);

    if (matches) {
      const src = path.join("src", "content", "posts", file);
      const dist = path.join("dist", "posts", file);

      const fileContent = await readFile(src, "utf-8");
      const { meta, content } = parseMeta(fileContent);

      const date = matches[1];
      const slug = matches[2];

      posts.push({
        ...meta,
        src,
        dist,
        url: `/posts/${date}-${slug}.html`,
        canonicalUrl: `https://vslinko.com/${meta.lang}/posts/${date}-${slug}.html`,
        date,
        content,
      });
    }
  }

  return posts;
}

async function buildCommand() {
  console.log("Building");

  const templates = {
    post: await readFile("src/templates/post.html", "utf-8"),
    links: await readFile("src/templates/links.html", "utf-8"),
    ym: await readFile("src/templates/ym.html", "utf-8"),
  };

  await rimraf("dist");

  await mkdir("dist");
  await mkdir("dist/css");
  await mkdir("dist/posts");
  await mkdir("dist/resume");
  await mkdir("dist/media");

  await copy("CNAME");
  await copy("css/normalize.css");
  await copy("css/hljs.css");
  await processCSS("css/screen.css");
  await copy("resume/developer.html");
  await copy("media/john-fowler-7Ym9rpYtSdA-unsplash.webp");
  await processHTML("resume/manager.html", {
    ym: templates.ym,
  });

  const posts = await parsePosts();

  for (const post of posts) {
    await processPost({ post, templates });
  }

  await processHTML("posts/index.html", {
    posts,
    ym: templates.ym,
    links: templates.links,
  });

  await processHTML("index.html", {
    ym: templates.ym,
    links: templates.links,
  });
}

async function watchCommand() {
  const watcher = watch("src", { recursive: true });

  for await (const _ of watcher) {
    await buildCommand();
  }
}

module.exports.build = buildCommand;
module.exports.watch = watchCommand;

if (require.main === module) {
  buildCommand();
}
