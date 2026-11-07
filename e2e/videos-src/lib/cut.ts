import { spawnSync } from 'node:child_process';

/*
 * Cuts a raw recording down to what a viewer needs. Nothing is generated: every frame is a frame of
 * the recording. The start and the middle of each long wait are left out, and the last frame is held so
 * it can be read.
 */

/** Seconds kept at the start and end of a wait, so the viewer sees it begin and finish. */
const KEEP_HEAD = 1.8;
const KEEP_TAIL = 0.8;
const FPS = 25;
/** The finished video plays this much faster than real time, unless a video sets its own `speed`. */
export const SPEED = 1.25;
/** Seconds the last frame stays on screen. */
const END_HOLD = 1;

export interface Media {
  width: number;
  height: number;
  seconds: number;
}

export function probe(file: string): Media {
  const run = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_packets,avg_frame_rate:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`ffprobe could not read ${file}: ${run.stderr}`);
  const out = JSON.parse(run.stdout) as { streams: { width: number; height: number; nb_read_packets: string; avg_frame_rate: string }[]; format: { duration?: string } };
  const stream = out.streams[0];
  if (!stream) throw new Error(`${file} has no video`);
  const [top = 0, bottom = 1] = stream.avg_frame_rate.split('/').map(Number);
  const seconds = Number(out.format.duration ?? Number.NaN);
  return { width: stream.width, height: stream.height, seconds: Number.isFinite(seconds) ? seconds : Number(stream.nb_read_packets) / (top / bottom) };
}

export interface Wait {
  start: number;
  end: number;
  /** Seconds kept at its start and end, instead of the usual. */
  keep?: readonly [number, number] | undefined;
}

/** The parts of [from, to] to keep, given the waits inside it. All in seconds. */
export function keptRanges(from: number, to: number, waits: readonly Wait[]): [number, number][] {
  const kept: [number, number][] = [];
  let at = from;
  for (const { start, end, keep } of waits) {
    const [head, tail] = keep ?? [KEEP_HEAD, KEEP_TAIL];
    if (end - start <= head + tail) continue;
    if (start + head > at) kept.push([at, start + head]);
    at = end - tail;
  }
  kept.push([at, to]);
  return kept;
}

export function cut(raw: string, out: string, ranges: readonly (readonly [number, number])[], speed = SPEED): void {
  const keep = ranges.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join('+');
  const run = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', raw, '-vf', `select='${keep}',setpts=N/${String(FPS * speed)}/TB,fps=${String(FPS)},tpad=stop_mode=clone:stop_duration=${String(END_HOLD)}`, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
    { stdio: 'inherit' },
  );
  if (run.status !== 0) throw new Error(`ffmpeg could not cut ${raw}`);
}
