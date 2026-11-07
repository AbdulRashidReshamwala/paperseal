#!/usr/bin/env node
// Builds the static homepage into dist/. No dependencies: it copies files and fills in the clip list.
// Videos only ever land in dist/, which is gitignored.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { videos } from '../videos.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const dist = resolve(app, 'dist');
const videoDir = process.env.VIDEO_DIR ?? resolve(repo, 'e2e/videos');
const fontsource = resolve(repo, 'packages/ui/node_modules/@fontsource');

// A paused player's controls sit on top of the burned-in caption, so the still drops the caption band.
const coverCaption = 'drawbox=x=0:y=ih*0.8:w=iw:h=ih*0.2:color=0xf3ecdf:t=fill';

const pagesFileLimit = 25 * 1024 * 1024; // Cloudflare Pages refuses a file over 25 MiB.

const fonts = [
  ['libre-caslon-display', 'latin-400-normal'],
  ['libre-caslon-text', 'latin-400-normal'],
  ['libre-caslon-text', 'latin-400-italic'],
  ['public-sans', 'latin-400-normal'],
  ['public-sans', 'latin-500-normal'],
  ['public-sans', 'latin-600-normal'],
  ['ibm-plex-mono', 'latin-400-normal'],
  ['ibm-plex-mono', 'latin-500-normal'],
];

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Seconds in a clip. 0 when ffprobe isn't installed, null when the file can't be read as a video. */
function durationOf(file) {
  if (run('ffprobe', ['-version']) === null) return 0;
  const seconds = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]));
  return seconds > 0 ? seconds : null;
}

function ready(video) {
  const file = resolve(videoDir, `${video.id}.mp4`);
  if (/\.(mock|dry)$|^mock-/.test(video.id)) return console.warn(`skip ${video.id}: test recording`);
  if (!existsSync(file)) return console.log(`skip ${video.id}: not recorded yet`);
  const { size } = statSync(file);
  if (size > pagesFileLimit) return console.warn(`skip ${video.id}: ${size} bytes is over the Pages limit`);
  const duration = durationOf(file);
  if (duration === null) return console.warn(`skip ${video.id}: not a readable video`);
  return { ...video, file, size, duration };
}

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function clipHtml(video, index, posters) {
  const poster = posters.has(video.id) ? ` poster="posters/${video.id}.jpg"` : '';
  const time = video.duration ? `<span>${clock(video.duration)}</span>` : '';
  return `
        <article class="clip" id="v-${video.id}">
          <div class="clip-text">
            <p class="clip-no">Clip ${index + 1}${time}</p>
            <h3>${escape(video.title)}</h3>
            <p>${escape(video.line)}</p>
          </div>
          <div class="clip-frame">
            <video controls preload="metadata" playsinline width="1280" height="800"${poster} src="videos/${video.id}.mp4" aria-label="${escape(`Screen recording with captions: ${video.title}`)}"></video>
          </div>
        </article>`;
}

function page(clips, posters) {
  const total = clips.reduce((sum, clip) => sum + clip.duration, 0);
  const count = ['No clips', 'One short clip', 'Two short clips', 'Three short clips', 'Four short clips', 'Five short clips', 'Six short clips'][clips.length] ?? `${clips.length} short clips`;
  const summary = `${count}, recorded from the real apps in a browser${total ? `. Under ${Math.ceil(total / 60)} minutes in all` : ''}.`;

  let html = readFileSync(resolve(app, 'src/index.html'), 'utf8');
  html = html.replace('<!-- clips -->', clips.map((clip, index) => clipHtml(clip, index, posters)).join('\n'));
  html = html.replace('<!-- clip summary -->', summary);
  // A step's "Watch this step" link goes when its clip isn't on the page.
  const shown = new Set(clips.map((clip) => clip.id));
  html = html.replace(/\s*<a class="watch" data-clip="([^"]+)"[^>]*>.*?<\/a>/g, (link, id) => (shown.has(id) ? link.replace(/ data-clip="[^"]+"/, '') : ''));
  return html;
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(resolve(dist, 'fonts'), { recursive: true });
mkdirSync(resolve(dist, 'videos'));
mkdirSync(resolve(dist, 'posters'));

cpSync(resolve(app, 'public'), dist, { recursive: true });
for (const file of ['style.css', 'site.js']) copyFileSync(resolve(app, 'src', file), resolve(dist, file));
copyFileSync(resolve(repo, 'packages/ui/src/assets/seal.svg'), resolve(dist, 'seal.svg'));
for (const [family, cut] of fonts) {
  const name = `${family}-${cut}.woff2`;
  copyFileSync(resolve(fontsource, family, 'files', name), resolve(dist, 'fonts', name));
}

const clips = videos.map(ready).filter(Boolean);
const posters = new Set();
for (const clip of clips) {
  copyFileSync(clip.file, resolve(dist, 'videos', `${clip.id}.mp4`));
  const at = String(clip.duration ? Math.min(clip.poster, clip.duration * 0.8) : clip.poster);
  const out = resolve(dist, 'posters', `${clip.id}.jpg`);
  if (run('ffmpeg', ['-v', 'error', '-y', '-ss', at, '-i', clip.file, '-frames:v', '1', '-vf', coverCaption, '-q:v', '4', out]) !== null) posters.add(clip.id);
}

writeFileSync(resolve(dist, 'index.html'), page(clips, posters));
console.log(`built ${dist} with ${clips.length} of ${videos.length} clips: ${clips.map((clip) => clip.id).join(', ')}`);
