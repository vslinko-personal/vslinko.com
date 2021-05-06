import dotenv from "dotenv";
import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
} from "fs/promises";
import { watch } from "fs";
import { promisify } from "util";
import path from "path";
import _rimraf from "rimraf";
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
import footnotes from "remark-footnotes";
import externalLinks from "remark-external-links";
import highlight from "remark-highlight.js";
import { toString as mdastToString } from "mdast-util-to-string";
import visit from 'unist-util-visit';
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

nunjucks.configure("./src/templates", { autoescape: true, noCache: true });

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

async function processHTML(file) {
  const src = path.join("src", "content", file);
  const dist = path.join("dist", file);

  const template = await readFile(src, "utf-8");
  const result = minifyHTML(nunjucks.renderString(template));

  await writeFile(dist, result);
}

async function processCSS(file) {
  const src = path.join("src", "content", file);
  const dist = path.join("dist", file);

  const template = await readFile(src, "utf-8");
  const result = csso.minify(template).css;

  await writeFile(dist, result);
}

async function processPost({ post }) {
  const result = minifyHTML(nunjucks.render("post.html", { post }));

  await writeFile(post.dist, result);
}

async function processPosts({ posts }) {
  const result = minifyHTML(nunjucks.render("posts.html", { posts }));

  await writeFile("dist/posts/index.html", result);
}

async function processSitemap({ urls }) {
  const result = nunjucks.render("sitemap.xml", { urls });

  await writeFile("dist/sitemap.xml", result);
}

async function parseGardenMeta({ src }) {
  const title = path.basename(src, ".md");
  const link = "/garden" + formatGardenUrl("/" + src);
  const canonicalUrl = "https://vslinko.com" + link;

  const fileContent = await readFile(
    path.join(process.env.GARDEN_ROOT, src),
    "utf-8"
  );
  const { meta, content } = parseMeta(fileContent);
  const { mtime } = await stat(path.join(process.env.GARDEN_ROOT, src));

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

  const dirs = path
    .dirname(src)
    .split("/")
    .filter((x) => x !== ".");

  return {
    link,
    canonicalUrl,
    title,
    mtime,
    dirs,
    meta,
    tags,
    isPublic,
    content,
  };
}

async function parseMarkdown({ content, permalinks }) {
  let title;
  let titleId;
  const links = [];
  const toc = [];
  let hasCodeBlocks = false;

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
    .use(() => root => {
      visit(root, 'code', (n) => {
        hasCodeBlocks = true;
      });
    })
    .use(highlight)
    .use(remarkTypograf, {
      typograf,
      builtIn: false,
    })
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
  };
}

async function saveGardenFile(
  { link, meta, title, titleId, content, toc, canonicalUrl },
  { tree, backlinks }
) {
  const dist = path.join("dist", link);

  const result = minifyHTML(
    nunjucks.render("garden.html", {
      lang: meta.lang || "ru",
      title,
      titleId,
      summary: typograf.execute(meta.summary || ""),
      content,
      canonicalUrl,
      backlinks,
      tree,
      toc,
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

  const files = (await readdir("src/posts")).reverse();

  for (const file of files) {
    const matches = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(file);

    if (matches) {
      const src = path.join("src", "posts", file);
      const dist = path.join("dist", "posts", file.replace(/\.md$/, ".html"));

      const fileContent = await readFile(src, "utf-8");
      const { meta, content } = parseMeta(fileContent);
      const { mtime } = await stat(src);

      const res = await parseMarkdown({
        content: content,
      });

      const date = matches[1];
      const slug = matches[2];

      posts.push({
        title: res.title || meta.title || "",
        titleId: res.titleId || meta.titleId || "",
        hasCodeBlocks: res.hasCodeBlocks,
        summary: typograf.execute(meta.summary || ""),
        dateFormatted: meta.dateFormatted || "",
        lang: meta.lang || "",
        src,
        dist,
        mtime,
        url: `/posts/${date}-${slug}.html`,
        canonicalUrl: `https://vslinko.com/${meta.lang}/posts/${date}-${slug}.html`,
        date,
        content: res.content,
        meta,
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

async function buildGarden({ urls }) {
  const gardenFiles = await glob("**/*.md", {
    cwd: process.env.GARDEN_ROOT,
  });

  const gardenPermalinks = new Map();
  const publicGardenFiles = [];

  for (const file of gardenFiles) {
    const parsed = await parseGardenMeta({
      src: file,
    });

    if (!parsed.isPublic) {
      continue;
    }

    gardenPermalinks.set(parsed.title, parsed.link);
    publicGardenFiles.push(parsed);
  }

  const tree = { folders: [], files: [] };
  for (const file of publicGardenFiles) {
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
      link: file.link,
      title: file.title,
    });
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
    const fileBacklinks = backlinks.get(file.link);

    urls.push({
      loc: file.canonicalUrl,
      lastmod: new Date(
        Math.max(file.mtime, ...(fileBacklinks || []).map((f) => f.mtime))
      ).toISOString(),
      changefreq: "weekly",
    });

    await saveGardenFile(file, {
      tree,
      backlinks: fileBacklinks,
    });
  }
}

export async function buildCommand() {
  console.log("Building");

  await rimraf("dist");

  await mkdir("dist");
  await mkdir("dist/css");
  await mkdir("dist/js");
  await mkdir("dist/posts");
  await mkdir("dist/resume");
  await mkdir("dist/media");
  await mkdir("dist/garden");
  await mkdir("dist/garden/moc");
  await mkdir("dist/garden/thoughts");

  await copy("CNAME");
  await copy("robots.txt");

  await copy("android-chrome-192x192.png");
  await copy("android-chrome-512x512.png");
  await copy("apple-touch-icon.png");
  await copy("browserconfig.xml");
  await copy("favicon-16x16.png");
  await copy("favicon-32x32.png");
  await copy("favicon.ico");
  await copy("mstile-144x144.png");
  await copy("mstile-150x150.png");
  await copy("mstile-310x150.png");
  await copy("mstile-310x310.png");
  await copy("mstile-70x70.png");
  await copy("safari-pinned-tab.svg");
  await copy("site.webmanifest");

  await copy("css/normalize.css");
  await copy("css/a11y-dark.min.css");
  await copy("css/a11y-light.min.css");
  await processCSS("css/screen.css");
  await copy("js/main.js");
  await copy("resume/developer.html");
  await copy("media/john-fowler-7Ym9rpYtSdA-unsplash.webp");
  await processHTML("resume/manager.html");
  await processHTML("comments-iframe.html");

  const posts = await parsePosts();

  for (const post of posts) {
    await processPost({ post });
  }

  await processPosts({ posts });

  await processHTML("index.html");

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

  await buildGarden({
    urls,
  });

  await processSitemap({
    urls,
  });
}

export async function watchCommand() {
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
