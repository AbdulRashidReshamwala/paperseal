import type { Paper } from '@paperseal/protocol';

import './paper.css';

/**
 * The paper, grouped by topic in the order each topic first appears and numbered straight through.
 * It only ever receives what `unlockPaper` returned, so there is no unchecked way to reach it.
 */
export function PaperSheet(props: { paper: Paper }) {
  const { questions } = props.paper;
  const topics = [...new Set(questions.map((question) => question.topic))];
  let number = 1;
  return (
    <article className="paper-sheet" aria-label="The examination paper">
      <h2 className="paper-sheet-title">Examination paper</h2>
      {topics.map((topic) => {
        const inTopic = questions.filter((question) => question.topic === topic);
        const start = number;
        number += inTopic.length;
        return (
          <section key={topic} className="paper-sheet-topic">
            <h3>{topic}</h3>
            <ol start={start}>
              {inTopic.map((question, index) => (
                <li key={index}>{question.text}</li>
              ))}
            </ol>
          </section>
        );
      })}
    </article>
  );
}
