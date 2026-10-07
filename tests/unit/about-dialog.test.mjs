import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bindAboutDialog } from "../../src/about-dialog.ts";

const DISCLAIMER = "PoB Codes is an unofficial fan-made Path of Exile tool. Path of Exile and related assets are © Grinding Gear Games. Not affiliated with or endorsed by Grinding Gear Games. Privacy · Terms";
const html = await readFile("index.html", "utf8");
const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
const dialogMarkup = html.match(/<dialog id="about-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? "";
const entities = { copy: "©", middot: "·", iacute: "í", amp: "&", nbsp: " " };
const text = (markup) => markup.replace(/<[^>]+>/g, "").replace(/&(\w+);/g, (_, name) => entities[name] ?? `&${name};`).replace(/\s+/g, " ").trim();
const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

test("About sits between Launch and the PoB toolbar with an accessible icon button", () => {
  const actions = html.match(/<div class="site-header-actions">([\s\S]*?)\n {8}<\/div>/)?.[1] ?? "";
  const launch = actions.indexOf('id="launch-build"');
  const about = actions.indexOf('id="about-legal"');
  const toolbar = actions.indexOf('id="editor-accessibility"');
  assert.ok(launch >= 0 && launch < about && about < toolbar, "About must follow Launch and precede the toolbar");
  const button = actions.match(/<button id="about-legal"[^>]*>/)[0];
  assert.equal(attribute(button, "type"), "button");
  assert.equal(attribute(button, "aria-haspopup"), "dialog");
  assert.equal(attribute(button, "aria-controls"), "about-dialog");
  assert.equal(attribute(button, "aria-label"), "About, disclaimer and open-source notices");
  assert.equal(attribute(button, "title"), "About, disclaimer and open-source notices");
  assert.match(actions, /<button id="about-legal"[^>]*><svg [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><\/button>/);
});

test("About dialog shows the exact disclaimer and policy links", () => {
  assert.ok(dialogMarkup, "index.html must contain the About dialog");
  assert.match(dialogMarkup, /aria-labelledby="about-dialog-title"/);
  assert.match(dialogMarkup, /<form method="dialog"><button id="about-dialog-close"[^>]*aria-label="Close"/);
  const disclaimer = dialogMarkup.match(/<p id="about-disclaimer"[^>]*>([\s\S]*?)<\/p>/)[1];
  assert.equal(text(disclaimer), DISCLAIMER);
  assert.match(disclaimer, /<a href="https:\/\/pob\.codes\/content\/privacy" target="_blank" rel="noopener noreferrer">Privacy<\/a>/);
  assert.match(disclaimer, /<a href="https:\/\/pob\.codes\/content\/terms" target="_blank" rel="noopener noreferrer">Terms<\/a>/);
});

test("About dialog is static markup with safe external links", () => {
  assert.doesNotMatch(dialogMarkup, /<script|\son[a-z]+=|javascript:/i);
  const links = dialogMarkup.match(/<a\s[^>]*>/g);
  assert.ok(links.length > 20);
  for (const link of links) {
    assert.match(attribute(link, "href"), /^https:\/\/[a-z0-9.-]+\//, link);
    assert.equal(attribute(link, "target"), "_blank", link);
    assert.equal(attribute(link, "rel"), "noopener noreferrer", link);
  }
});

// Every shipped third-party component must be named in both the dialog and
// THIRD_PARTY_NOTICES.md; the editor's own notice is LICENSE.
const shippedComponents = [
  "pob-web", "Path of Building Community",
  "base64.lua", "dkjson.lua", "lua-profiler.lua", "sha1", "xml.lua",
  "Lua 5.2.4", "luautf8", "Emscripten", "WasmFS", "musl libc", "libc++", "mimalloc", "zlib",
  "Liberation Sans", "Bitstream Vera Sans Mono", "Fontin", "Jos Buivenga",
  "React", "React DOM", "Scheduler", "react-icons", "Circum Icons", "Heroicons 2", "Material Design icons", "Phosphor Icons",
  "ZenFS", "@zenfs/dom", "@zenfs/archives", "memium", "utilium", "kerium", "Comlink", "fflate",
  "@bokuweb/zstd-wasm", "Zstandard", "texture2ddecoder-wasm", "buffer", "safe-buffer", "ieee754", "base64-js",
  "readable-stream", "string_decoder", "events", "process", "eventemitter3", "abort-controller",
  "missionlog", "Tailwind CSS", "daisyUI", "Vite",
];

test("About notices and THIRD_PARTY_NOTICES.md name every shipped component", async () => {
  const dialogText = text(dialogMarkup);
  const license = await readFile("LICENSE", "utf8");
  for (const holder of ["2026 PoB Codes contributors", "2024 Koji AGAWA"]) {
    assert.ok(license.includes(`Copyright (c) ${holder}`) && dialogText.includes(`© ${holder}`), holder);
  }
  for (const name of shippedComponents) {
    assert.ok(dialogText.includes(name), `About dialog is missing ${name}`);
    assert.ok(notices.includes(name), `THIRD_PARTY_NOTICES.md is missing ${name}`);
  }
  // ZenFS asks for this exact attribution form (its COPYING.md web-app exception).
  for (const [name, repository] of [["ZenFS", "core"], ["@zenfs/dom", "dom"], ["@zenfs/archives", "archives"]]) {
    assert.ok(dialogText.includes(`${name}, Licensed under the LGPL 3.0 or later and COPYING.md, Copyright © James Prevett and other ZenFS contributors`), name);
    assert.match(dialogMarkup, new RegExp(`href="https://github.com/zen-fs/${repository}/blob/main/COPYING.md"`));
  }
});

const browserDependencies = {
  // Bundled into the shipped shell, worker, CSS, or static texture decoder.
  shipped: ["@bokuweb/zstd-wasm", "@zenfs/archives", "@zenfs/core", "@zenfs/dom", "comlink", "daisyui", "react", "react-dom", "react-icons", "tailwindcss", "texture2ddecoder-wasm", "vite"],
  // Build, packer, test, or type-only tooling; missionlog is adapted in source and listed by name.
  notShipped: ["@tailwindcss/typography", "@tailwindcss/vite", "@types/adm-zip", "@types/emscripten", "@types/react", "@types/react-dom", "@vitejs/plugin-react", "adm-zip", "image-dimensions", "missionlog", "vite-plugin-static-copy"],
};

test("every pob-web dependency is classified for the About notices", async () => {
  const { imports } = JSON.parse(await readFile("upstream/deno.json", "utf8"));
  const npm = Object.entries(imports).filter(([, specifier]) => specifier.startsWith("npm:")).map(([name]) => name).sort();
  assert.deepEqual(npm, [...browserDependencies.shipped, ...browserDependencies.notShipped].sort(),
    "Classify new upstream/deno.json dependencies and add shipped ones to the About dialog and THIRD_PARTY_NOTICES.md");
});

test("versioned license links match the locked packages", async () => {
  const lock = JSON.parse(await readFile("upstream/deno.lock", "utf8"));
  const locked = new Set(Object.keys(lock.npm).map((key) => key.replace(/_.*$/, "")));
  const versioned = [...dialogMarkup.matchAll(/href="https:\/\/(?:unpkg\.com\/((?:@[^/@"]+\/)?[^/@"]+)@([^/"]+)\/([^"#]+)|www\.npmjs\.com\/package\/((?:@[^/"]+\/)?[^/"]+)\/v\/([^/"]+))"/g)]
    .map((match) => ({ name: match[1] ?? match[4], version: match[2] ?? match[5], file: match[3] }));
  assert.ok(versioned.length >= 15);
  const nodeModules = "upstream/node_modules/.deno";
  for (const { name, version, file } of versioned) {
    assert.ok(locked.has(`${name}@${version}`), `${name}@${version} is not the locked version`);
    const packageRoot = `${nodeModules}/${name.replace("/", "+")}@${version}/node_modules/${name}`;
    if (file && existsSync(nodeModules)) assert.ok(existsSync(`${packageRoot}/${file}`), `${name}@${version} ships no ${file}`);
  }
});

class FakeElement extends EventTarget {
  focused = 0;
  focus() { this.focused++; }
}

class FakeDialog extends EventTarget {
  open = false;
  opened = 0;
  showModal() { this.open = true; this.opened++; }
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event("close"));
  }
}

function pointer(target, type, eventTarget) {
  const event = new Event(type);
  Object.defineProperty(event, "target", { value: eventTarget });
  target.dispatchEvent(event);
}

test("About opens once, closes from the backdrop only, and returns focus", () => {
  const trigger = new FakeElement();
  const dialog = new FakeDialog();
  const content = new FakeElement();
  bindAboutDialog({ trigger, dialog });

  trigger.dispatchEvent(new Event("click"));
  trigger.dispatchEvent(new Event("click"));
  assert.equal(dialog.opened, 1);
  assert.equal(dialog.open, true);

  pointer(dialog, "pointerdown", content);
  pointer(dialog, "click", content);
  assert.equal(dialog.open, true, "Clicks inside the content keep it open");
  pointer(dialog, "pointerdown", content);
  pointer(dialog, "click", dialog);
  assert.equal(dialog.open, true, "A selection dragged onto the backdrop keeps it open");

  pointer(dialog, "pointerdown", dialog);
  pointer(dialog, "click", dialog);
  assert.equal(dialog.open, false, "Backdrop clicks close it");
  assert.equal(trigger.focused, 1, "Closing returns focus to the About button");

  trigger.dispatchEvent(new Event("click"));
  dialog.close();
  assert.equal(trigger.focused, 2, "Escape and the close button also return focus");
});
