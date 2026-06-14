const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const JS_DIRS = ['api', 'lib', 'scripts'];
const JS_FILES = ['script.js'];

function walkJsFiles(dir) {
  const fullDir = path.join(ROOT, dir);
  if (!fs.existsSync(fullDir)) return [];

  return fs.readdirSync(fullDir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(fullDir, entry.name);
    const relativePath = path.relative(ROOT, fullPath);

    if (entry.isDirectory()) return walkJsFiles(relativePath);
    if (entry.isFile() && entry.name.endsWith('.js')) return [relativePath];
    return [];
  });
}

function checkNodeSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error([result.stdout, result.stderr].filter(Boolean).join('\n').trim());
  }
}

function checkInlineScripts(file) {
  const fullPath = path.join(ROOT, file);
  const html = fs.readFileSync(fullPath, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);

  scripts.forEach((code, index) => {
    new vm.Script(code, { filename: file + '#script' + (index + 1) });
  });

  return scripts.length;
}

function main() {
  const files = [
    ...JS_FILES,
    ...JS_DIRS.flatMap(walkJsFiles),
  ].filter(file => fs.existsSync(path.join(ROOT, file)));

  files.forEach(checkNodeSyntax);

  const htmlFiles = ['order/index.html', 'team/index.html'].filter(file =>
    fs.existsSync(path.join(ROOT, file)),
  );
  const inlineScriptCount = htmlFiles.reduce((sum, file) => sum + checkInlineScripts(file), 0);

  console.log('JS syntax OK:', files.length, 'files');
  console.log('Inline scripts OK:', inlineScriptCount, 'scripts in', htmlFiles.length, 'HTML files');
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
