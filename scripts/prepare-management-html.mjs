import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const distDir = path.resolve(process.cwd(), 'dist');
const sourceFile = path.join(distDir, 'index.html');
const targetFile = path.join(distDir, 'management.html');

if (!existsSync(sourceFile)) {
  console.error(`Build output not found: ${sourceFile}`);
  process.exit(1);
}

copyFileSync(sourceFile, targetFile);
console.log(`Created ${targetFile}`);
