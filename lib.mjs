import dotenv from "dotenv";
import { copyFile, readFile, writeFile, stat } from "fs/promises";
import { watch } from "fs";
import { promisify } from "util";
import mkdirp from "mkdirp";
import path from "path";
import _rimraf from "rimraf";
import UglifyJS from "uglify-js";
import nunjucks from "nunjucks";
import csso from "csso";
import htmlMinifier from "html-minifier";
import _glob from "glob";
import unified from "unified";
import markdown from "remark-parse";
import remark2rehype from "remark-rehype";
import slug from "remark-slug";
import format from "rehype-format";
import html from "rehype-stringify";
import gfm from "remark-gfm";
import footnotes from "remark-footnotes";
import externalLinks from "remark-external-links";
import highlight from "remark-highlight.js";
import { toString as mdastToString } from "mdast-util-to-string";
import visit from "unist-util-visit";
import { wikiLinkPlugin } from "remark-wiki-link";
import remarkTypograf from "@mavrin/remark-typograf";
import slugify from "slugify";
import YAML from "yaml";
import Typograf from "typograf";

const glob = promisify(_glob);
const rimraf = promisify(_rimraf);

dotenv.config();

if (!process.env.GARDEN_ROOT) {
  console.error(`Unconfigured GARDEN_ROOT`);
  process.exit(1);
}

const GARDEN_ROOT = process.env.GARDEN_ROOT;

nunjucks.configure("./src/templates", { autoescape: true, noCache: true });

const typograf = new Typograf({ locale: ["ru"] });

async function copy(file) {
  const src = path.join("src", "content", file);
  const dist = path.join("dist", file);

  await mkdirp(path.dirname(dist));
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
    minifyCSS: (text, type) => {
      return csso.minify(text).css;
    },
    minifyJS: (text, inline) => {
      return UglifyJS.minify(text).code;
    },
  });
}

async function processHTML(file) {
  const src = path.join("src", "content", file);
  const dist = path.join("dist", file);

  const template = await readFile(src, "utf-8");
  const result = minifyHTML(nunjucks.renderString(template));

  await mkdirp(path.dirname(dist));
  await writeFile(dist, result);
}

async function processCSS(file) {
  const src = path.join("src", "content", file);
  const dist = path.join("dist", file);

  const template = await readFile(src, "utf-8");
  const result = csso.minify(template).css;

  await mkdirp(path.dirname(dist));
  await writeFile(dist, result);
}

async function processJS(file) {
  const src = path.join("src", "content", file);
  const dist = path.join("dist", file);

  const template = await readFile(src, "utf-8");
  const result = UglifyJS.minify(template).code;

  await mkdirp(path.dirname(dist));
  await writeFile(dist, result);
}

async function processPost({ post }) {
  const result = minifyHTML(
    nunjucks.render("post.html", { post, backlinks: post.backlinks })
  );

  await mkdirp(path.dirname(post.dist));
  await mkdirp(path.dirname(post.canonicalDist));
  await writeFile(post.dist, result);
  await writeFile(post.canonicalDist, result);
  await writeFile(post.dist.replace(/\.html$/, ".md"), post.originalContent);
  await writeFile(
    post.canonicalDist.replace(/\.html$/, ".md"),
    post.originalContent
  );
}

async function processPosts({ posts }) {
  const result = minifyHTML(nunjucks.render("posts.html", { posts }));

  await mkdirp("dist/posts");
  await writeFile("dist/posts/index.html", result);
}

async function processSitemap({ urls }) {
  const result = nunjucks.render("sitemap.xml", { urls });

  await mkdirp("dist");
  await writeFile("dist/sitemap.xml", result);
}

async function processRss({ posts }) {
  const result = nunjucks.render("rss.xml", { posts });

  await mkdirp("dist/posts");
  await writeFile("dist/posts/rss.xml", result);
}

async function parseGardenFileMeta({ src }) {
  const title = path.basename(src, ".md");

  const fileContent = await readFile(path.join(GARDEN_ROOT, src), "utf-8");
  const { meta, content } = parseMeta(fileContent);
  const { mtime } = await stat(path.join(GARDEN_ROOT, src));

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

  const dirs = path
    .dirname(src)
    .split("/")
    .filter((x) => x !== ".");

  const slug =
    meta.slug ||
    slugify(path.basename(src, ".md"), {
      lower: true,
      locale: "ru",
    });

  const url = "/garden" + formatGardenFileUrl("/" + src, slug);
  const fullUrl = "https://vslinko.com" + url;

  return {
    url,
    fullUrl,
    canonicalUrl: url,
    canonicalFullUrl: fullUrl,
    title,
    mtime,
    dirs,
    meta,
    tags,
    content,
    originalContent: fileContent,
    collection: meta.collection || null,
    slug,
    lang: meta.lang || "ru",
    summary: typograf.execute(meta.summary || ""),
  };
}

async function parseMarkdown({ content, permalinks }) {
  let title;
  let titleId;
  const links = [];
  const toc = [];
  let hasCodeBlocks = false;

  const cutIndex = content.indexOf("<!--hidden-->");
  if (cutIndex >= 0) {
    content = content.slice(0, cutIndex);
  }

  const res = await unified()
    .use(markdown)
    .use(slug)
    .use(() => (root) => {
      for (const child of root.children) {
        if (child.type === "heading") {
          toc.push({
            title: typograf.execute(mdastToString(child)),
            id: child.data.id,
            depth: child.depth,
          });
        }
      }
    })
    .use(() => (root) => {
      const titleNode = root.children.find(
        (n) => n.type === "heading" && n.depth === 1
      );

      if (!titleNode) {
        return;
      }

      title = typograf.execute(mdastToString(titleNode));
      titleId = titleNode.data.id;
      root.children.splice(root.children.indexOf(titleNode), 1);
    })
    .use(wikiLinkPlugin, {
      pageResolver: (name) => {
        if (!permalinks || !permalinks.has(name)) {
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
    .use(externalLinks, { rel: ["noopener"] })
    .use(() => (root) => {
      visit(root, "code", (n) => {
        hasCodeBlocks = true;
      });
    })
    .use(highlight)
    .use(remarkTypograf, {
      typograf,
      builtIn: false,
    })
    .use(gfm)
    .use(remark2rehype)
    .use(format)
    .use(html)
    .process(content);

  return {
    title,
    titleId,
    links,
    toc,
    hasCodeBlocks,
    content: res.contents,
  };
}

async function parseGardenFile(file, { permalinks }) {
  const res = await parseMarkdown({
    content: file.content,
    permalinks,
  });

  return {
    ...file,
    title: res.title || file.title,
    titleId: res.titleId || "",
    content: res.contents,
    links: res.links,
    toc: res.toc,
    content: res.content,
    hasCodeBlocks: res.hasCodeBlocks,
  };
}

async function processGardenFile(file, { gardenTree }) {
  const dist = path.join("dist", file.url);
  const distMd = path.join("dist", file.url.replace(/\.html$/, ".md"));

  const result = minifyHTML(
    nunjucks.render("garden.html", {
      ...file,
      tree: gardenTree,
    })
  );

  await mkdirp(path.dirname(dist));
  await writeFile(dist, result);
  await writeFile(distMd, file.originalContent);
}

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

function parsePost(gardenFile) {
  const date = gardenFile.meta.date;
  const slug = gardenFile.slug;
  const fileName = `${date}-${slug}.html`;

  const dist = path.join("dist", "posts", fileName);
  const canonicalDist = path.join("dist", gardenFile.lang, "posts", fileName);

  return {
    ...gardenFile,
    dateFormatted: gardenFile.meta.dateFormatted || "",
    dist,
    canonicalDist,
    url: `/posts/${fileName}`,
    fullUrl: `https://vslinko.com/posts/${fileName}`,
    canonicalUrl: `/${gardenFile.lang}/posts/${fileName}`,
    canonicalFullUrl: `https://vslinko.com/${gardenFile.lang}/posts/${fileName}`,
    date,
    pubDate: new Date(date).toGMTString(),
  };
}

function formatGardenFileUrl(filePath, slug) {
  const dir = path.dirname(filePath).toLowerCase();

  return path.join(dir, slug + ".html");
}

async function parseGarden() {
  const gardenFiles = await glob("**/*.md", {
    cwd: GARDEN_ROOT,
    nodir: true,
  });

  const gardenPermalinks = new Map();
  const publicGardenFiles = [];

  for (const file of gardenFiles) {
    let parsed = await parseGardenFileMeta({
      src: file,
    });

    if (!parsed.tags.includes("public")) {
      continue;
    }

    if (parsed.collection === "posts") {
      parsed = parsePost(parsed);
    }

    gardenPermalinks.set(parsed.title, parsed.canonicalUrl);
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
    const fileBacklinks = backlinks.get(file.url);
    file.backlinks = fileBacklinks;
    file.lastmod = new Date(
      Math.max(file.mtime, ...(fileBacklinks || []).map((f) => f.mtime))
    ).toISOString();
  }

  return parsedGardenFiles;
}

function buildGardenTree(gardenFiles) {
  const tree = { folders: [], files: [] };
  for (const file of gardenFiles) {
    let current = tree;
    for (const dir of file.dirs) {
      let next = current.folders.find((f) => f.name === dir);
      if (!next) {
        next = { name: dir, folders: [], files: [] };
        current.folders.push(next);
      }
      current = next;
    }
    current.files.push({
      url: file.url,
      title: file.title,
    });
  }
  return tree;
}

export async function buildCommand() {
  console.log("Building");

  await rimraf("dist");

  const contentFiles = await glob("**/*", {
    cwd: "src/content",
    dot: true,
    nodir: true,
  });

  for (const file of contentFiles) {
    if (file.includes(".DS_Store")) {
      continue;
    }

    const ext = path.extname(file);
    switch (ext) {
      case ".js":
        await processJS(file);
        break;
      case ".css":
        await processCSS(file);
        break;
      case ".html":
        await processHTML(file);
        break;
      default:
        await copy(file);
        break;
    }
  }

  const allGardenFiles = await parseGarden();

  const { gardenFiles, posts } = allGardenFiles.reduce(
    (acc, file) => {
      if (file.collection === "posts") {
        acc.posts.push(file);
      } else {
        acc.gardenFiles.push(file);
      }
      return acc;
    },
    { gardenFiles: [], posts: [] }
  );

  const gardenTree = buildGardenTree(gardenFiles);
  const urls = [];

  posts.sort((a, b) => new Date(b.date) - new Date(a.date));

  for (const post of posts) {
    urls.push({
      loc: post.canonicalFullUrl,
      lastmod: post.mtime.toISOString(),
      changefreq: "monthly",
    });

    await processPost({ post });
  }

  for (const file of gardenFiles) {
    urls.push({
      loc: file.canonicalFullUrl,
      lastmod: file.lastmod,
      changefreq: file.meta.changefreq || "monthly",
    });

    await processGardenFile(file, { gardenTree });
  }

  await processPosts({ posts });

  await processRss({
    posts,
  });

  await processHTML("index.html");

  const maxPostLastmod = posts.reduce((acc, post) => {
    if (acc === null) {
      return post.mtime;
    }
    if (post.mtime > acc) {
      return post.mtime;
    }
    return acc;
  }, null);
  const postsIndexLastmod = (await stat("src/templates/posts.html")).mtime;
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

  await processSitemap({
    urls,
  });
}

export async function watchCommand() {
  const watcher1 = watch("src", { recursive: true });
  const watcher2 = watch(GARDEN_ROOT, { recursive: true });

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
