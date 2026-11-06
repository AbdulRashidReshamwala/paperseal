import type { Paper, Question } from '@paperseal/protocol';

/** A4 at the browser's 96 pixels to the inch, in the same units the pages are measured in. */
export const A4_WIDTH_PX = (210 * 96) / 25.4;
export const A4_HEIGHT_PX = (297 * 96) / 25.4;

export interface PaperItem {
  question: Question;
  /** Numbered straight through the paper. */
  number: number;
  /** The first question of its topic, so the topic's heading sits above it. */
  opensTopic: boolean;
}

/** The questions grouped by topic, in the order each topic first appears. */
export function paperItems(paper: Paper): PaperItem[] {
  const topics = [...new Set(paper.questions.map((question) => question.topic))];
  return topics
    .flatMap((topic) => paper.questions.filter((question) => question.topic === topic))
    .map((question, index, ordered) => ({
      question,
      number: index + 1,
      opensTopic: ordered[index - 1]?.topic !== question.topic,
    }));
}

export interface PaperPage {
  /** The items on this page: `start` up to, not including, `end`. */
  start: number;
  end: number;
  /** Set only on a page holding one question too tall for A4: its body's height, which the page grows to fit. */
  tallBy?: number;
}

/**
 * Fills pages in order, with `heights[i]` the whole height of item `i`, so nothing splits. A question that
 * is taller than a page gets a page of its own and that page grows, because cutting it off would lose the question.
 */
export function paginate(heights: number[], room: number): PaperPage[] {
  const pages: PaperPage[] = [];
  let start = 0;
  let used = 0;
  const close = (end: number) => {
    pages.push({ start, end, ...(used > room ? { tallBy: used } : {}) });
    start = end;
    used = 0;
  };
  heights.forEach((height, index) => {
    if (index > start && used + height > room) close(index);
    used += height;
  });
  close(heights.length);
  return pages;
}
