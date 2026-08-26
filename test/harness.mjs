/*
   Boots the real bundle in a stubbed DOM.

   This goes through esbuild rather than importing src/ directly, so the thing
   under test is the same graph the browser gets -- a missing import or a
   broken hook registration fails here rather than in the browser.
*/
import * as esbuild from 'esbuild';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './dom.mjs';
import { flatten } from './util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function bootApp() {
  const result = await esbuild.build({
    entryPoints: [path.join(here, 'expose.js')],
    bundle: true,
    format: 'iife',
    globalName: '__T',
    target: 'es2020',
    write: false,
    outfile: 'expose.bundle.js',
  });
  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  vm.runInContext(result.outputFiles[0].text, sandbox, { filename: 'app.bundle.js' });
  return flatten(sandbox.__T);
}
