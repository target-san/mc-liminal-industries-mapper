/*
   Bundles src/ into the single self-contained mapper.html.

   The output stays one file with no external requests, so it can be opened
   straight off disk -- which is also why development does not use ES modules
   in the browser: file:// blocks module imports, and this avoids needing a
   local web server just to try a change.
*/
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { watch as watchFile } from 'node:fs';

const OUT_DIR = 'dist';
const OUT = `${OUT_DIR}/mapper.html`;
const ASSETS = ['src/index.html', 'src/styles.css'];
const watching = process.argv.includes('--watch');

async function emit(js) {
  const [template, css] = await Promise.all(ASSETS.map((f) => readFile(f, 'utf8')));
  /* Function replacements: the bundle can contain $& and friends, which the
     string form of replace() would expand. */
  const html = template
    .replace('/* @CSS@ */', () => css.trimEnd())
    .replace('/* @JS@ */', () => js.trimEnd());
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`${new Date().toTimeString().slice(0, 8)}  wrote ${OUT}  ${kb} kB`);
}

const emitPlugin = {
  name: 'emit-html',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      const js = result.outputFiles.find((f) => f.path.endsWith('.js'));
      if (js) await emit(js.text);
    });
  },
};

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  charset: 'utf8',
  legalComments: 'none',
  /* Readable output: this is a tool to be poked at, not shipped to millions.
     Inline maps only while watching, so the released file stays lean. */
  minify: false,
  sourcemap: watching ? 'inline' : false,
  write: false,
  outfile: 'bundle.js',
  plugins: [emitPlugin],
};

if (watching) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  for (const asset of ASSETS) {
    watchFile(asset, () => ctx.rebuild().catch(() => {}));
  }
  console.log('watching src/ ...');
} else {
  await esbuild.build(options);
}
