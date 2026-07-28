#!/usr/bin/env node
/*
 * Bundles src/ into a single self-contained index.html.
 *
 * The output has no external dependencies of any kind, so it runs from a
 * file:// URL (double-click on macOS) just as happily as it does from a web
 * server. The PWA files sitting next to it — manifest, service worker, icons —
 * only come into play when it is served over http(s).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');

const SCRIPTS = ['engine.js', 'render.js', 'audio.js', 'main.js'];

function read(file) {
  return fs.readFileSync(path.join(SRC, file), 'utf8');
}

/**
 * Replace a placeholder without letting `$` sequences in the payload be
 * interpreted as replacement patterns.
 */
function inject(haystack, needle, payload) {
  const at = haystack.indexOf(needle);
  if (at === -1) throw new Error(`template is missing the ${needle} placeholder`);
  return haystack.slice(0, at) + payload + haystack.slice(at + needle.length);
}

function build() {
  const template = fs.readFileSync(path.join(SRC, 'index.template.html'), 'utf8');
  const css = read('style.css');

  const js = SCRIPTS.map((name) => {
    const body = read(name);
    if (body.includes('</script')) {
      throw new Error(`${name} contains a literal </script> which would break the bundle`);
    }
    return `/* ===== src/${name} ===== */\n${body}`;
  }).join('\n');

  let html = inject(template, '/*__CSS__*/', '\n' + css + '\n');
  html = inject(html, '/*__JS__*/', '\n' + js + '\n');

  const out = path.join(ROOT, 'index.html');
  fs.writeFileSync(out, html);

  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`built index.html (${kb} kB, ${SCRIPTS.length} modules inlined)`);
}

build();
