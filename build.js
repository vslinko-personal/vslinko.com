require("dotenv").config();
const {
  copyFile,
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
} = require("fs/promises");
const { watch } = require("fs");
const { promisify } = require("util");
const path = require("path");
const rimraf = promisify(require("rimraf"));
const { render } = require("mustache");
const csso = require("csso");
const htmlMinifier = require("html-minifier");
const glob = promisify(require("glob"));
const unified = require("unified");
const markdown = require("remark-parse");
const remark2rehype = require("remark-rehype");
const format = require("rehype-format");
const html = require("rehype-stringify");
const footnotes = require("remark-footnotes");
const mdastToString = require("mdast-util-to-string");
const { wikiLinkPlugin } = require("remark-wiki-link");
const remarkTypograf = require("@mavrin/remark-typograf");
const slugify = require("slugify");
const YAML = require("yaml");
const Typograf = require("typograf");

if (!process.env.GARDEN_ROOT) {
  console.error(`Unconfigured GARDEN_ROOT`);
  process.exit(1);
}

const typograf = new Typograf({ locale: ["ru"] });

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

async function processXML(file, context) {
  const src = path.join("src", "content", file);
  const dist = path.join("dist", file);

  const template = await readFile(src, "utf-8");
  const result = render(template, context);

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

async function parseGardenMeta({ link, src }) {
  const title = path.basename(src, ".md");

  const fileContent = await readFile(src, "utf-8");
  const { meta, content } = parseMeta(fileContent);

  const tags = Array.from(
    (Array.isArray(meta.tags)
      ? meta.tags
      : meta.tags
      ? [meta.tags]
      : []
    ).reduce((acc, tag) => {
      acc.add(tag.trimLeft("#"));
      return acc;
    }, new Set())
  );

  const isPublic = tags.includes("public") || fileContent.includes("#public");

  return {
    link,
    title,
    meta,
    tags,
    isPublic,
    content,
  };
}

async function parseGardenFile(file, { permalinks }) {
  let title = file.title;
  const links = [];

  const res = await unified()
    .use(markdown)
    .use(() => (root) => {
      const titleNode = root.children.find(
        (n) => n.type === "heading" && n.depth === 1
      );

      if (!titleNode) {
        return;
      }

      title = typograf.execute(mdastToString(titleNode));
      root.children.splice(root.children.indexOf(titleNode), 1);
    })
    .use(wikiLinkPlugin, {
      pageResolver: (name) => {
        if (!permalinks.has(name)) {
          return [];
        }

        const permalink = permalinks.get(name);

        links.push(permalink);

        return [permalink];
      },
      hrefTemplate: (permalink) => permalink,
      aliasDivider: "||||||",
    })
    .use(footnotes)
    .use(remarkTypograf, {
      typograf,
      builtIn: false,
    })
    .use(remark2rehype)
    .use(format)
    .use(html)
    .process(file.content);

  return {
    ...file,
    title,
    content: res.contents,
    links,
  };
}

async function saveGardenFile(
  { link, meta, title, content },
  { templates, backlinks }
) {
  const dist = path.join("dist", link);

  const result = minifyHTML(
    render(templates.garden, {
      lang: meta.lang || "ru",
      title,
      summary: meta.summary || "",
      content,
      canonicalUrl: "https://vslinko.com" + link,
      backlinks: backlinks ? render(templates.backlinks, { backlinks }) : "",
      ym: templates.ym,
      links: templates.links,
    })
  );

  await writeFile(dist, result);
}

// https://stevemorse.org/russian/rus2eng.html
// https://markdowntohtml.com/

function parseMeta(content) {
  let meta = {};
  const rows = content.split("\n");

  if (rows[0] === "---") {
    const till = rows.slice(1).indexOf("---");

    if (till >= 0) {
      const metaContent = rows.slice(1, till + 1);
      content = rows.slice(till + 2).join("\n");

      meta = YAML.parse(metaContent.join("\n"));
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
      const { mtime } = await stat(src);

      const date = matches[1];
      const slug = matches[2];

      posts.push({
        ...meta,
        src,
        dist,
        mtime,
        url: `/posts/${date}-${slug}.html`,
        canonicalUrl: `https://vslinko.com/${meta.lang}/posts/${date}-${slug}.html`,
        date,
        content,
      });
    }
  }

  return posts;
}

function formatGardenUrl(filePath) {
  const dir = path.dirname(filePath).toLowerCase();
  const slug = slugify(path.basename(filePath, ".md"), {
    lower: true,
    locale: "ru",
  });

  return path.join(dir, slug + ".html");
}

async function buildGarden({ templates }) {
  const gardenSrcRoot = process.env.GARDEN_ROOT;

  const gardenFiles = await glob("**/*.md", {
    cwd: gardenSrcRoot,
  });

  const gardenPermalinks = new Map();
  const publicGardenFiles = [];

  for (const file of gardenFiles) {
    const parsed = await parseGardenMeta({
      link: "/garden" + formatGardenUrl("/" + file),
      src: gardenSrcRoot + "/" + file,
    });

    if (!parsed.isPublic) {
      continue;
    }

    gardenPermalinks.set(parsed.title, parsed.link);
    publicGardenFiles.push(parsed);
  }

  const backlinks = new Map();
  const parsedGardenFiles = [];

  for (const file of publicGardenFiles) {
    const parsedGardenFile = await parseGardenFile(file, {
      permalinks: gardenPermalinks,
    });

    for (const linkTo of parsedGardenFile.links) {
      if (!backlinks.has(linkTo)) {
        backlinks.set(linkTo, []);
      }

      backlinks.get(linkTo).push(parsedGardenFile);
    }

    parsedGardenFiles.push(parsedGardenFile);
  }

  for (const file of parsedGardenFiles) {
    await saveGardenFile(file, {
      templates,
      backlinks: backlinks.get(file.link),
    });
  }
}

async function buildCommand() {
  console.log("Building");

  const templates = {
    garden: await readFile("src/templates/garden.html", "utf-8"),
    backlinks: await readFile("src/templates/backlinks.html", "utf-8"),
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
  await mkdir("dist/garden");
  await mkdir("dist/garden/moc");
  await mkdir("dist/garden/thoughts");

  await copy("CNAME");
  await copy("robots.txt");
  await copy("css/normalize.css");
  await copy("css/a11y-dark.min.css");
  await copy("css/a11y-light.min.css");
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

  const urls = posts.map((p) => {
    return {
      loc: `https://vslinko.com${p.url}`,
      lastmod: p.mtime.toISOString(),
      changefreq: "monthly",
    };
  });

  const maxPostLastmod = posts.reduce((acc, post) => {
    if (acc === null) {
      return post.mtime;
    }
    if (post.mtime > acc) {
      return post.mtime;
    }
    return acc;
  }, null);
  const postsIndexLastmod = (await stat("src/content/posts/index.html")).mtime;
  const postsLastmod =
    postsIndexLastmod > maxPostLastmod ? postsIndexLastmod : maxPostLastmod;

  urls.unshift({
    loc: "https://vslinko.com/posts/",
    lastmod: postsLastmod.toISOString(),
    changefreq: "daily",
  });

  const indexLastmod = (await stat("src/content/index.html")).mtime;

  urls.unshift({
    loc: "https://vslinko.com/",
    lastmod: indexLastmod.toISOString(),
    changefreq: "monthly",
  });

  const resumeLastmod = (await stat("src/content/resume/manager.html")).mtime;

  urls.push({
    loc: "https://vslinko.com/resume/manager.html",
    lastmod: resumeLastmod.toISOString(),
    changefreq: "monthly",
  });

  await buildGarden({
    templates,
  });

  await processXML("sitemap.xml", {
    urls,
  });
}

async function watchCommand() {
  const watcher1 = watch("src", { recursive: true });
  const watcher2 = watch(process.env.GARDEN_ROOT, { recursive: true });

  let processing = false;
  let scheduled = false;

  const cb = async () => {
    if (processing) {
      scheduled = true;
      return;
    }

    try {
      processing = true;
      await buildCommand();
    } finally {
      processing = false;
      if (scheduled) {
        scheduled = false;
        cb();
      }
    }
  };

  watcher1.on("change", cb);
  watcher2.on("change", cb);
}

module.exports.build = buildCommand;
module.exports.watch = watchCommand;

if (require.main === module) {
  buildCommand();
}
