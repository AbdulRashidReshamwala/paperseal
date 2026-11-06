import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * Playwright's recordVideo encodes with an ffmpeg that it normally downloads, and the brief is no
 * browser downloads. So Playwright is pointed at a private folder whose ffmpeg is a link to the ffmpeg
 * already installed here. Chrome itself is the installed Chrome (channel "chrome"). The folder name
 * carries Playwright's ffmpeg revision, from playwright-core/browsers.json.
 */
export const browsersPath = resolve(import.meta.dirname, '.browsers');

export function linkInstalledFfmpeg(): void {
  const which = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (which.status !== 0) return;
  const platform = process.platform === 'darwin' ? 'ffmpeg-mac' : process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux';
  const dir = resolve(browsersPath, 'ffmpeg-1013');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(resolve(dir, platform))) symlinkSync(which.stdout.trim(), resolve(dir, platform));
}
