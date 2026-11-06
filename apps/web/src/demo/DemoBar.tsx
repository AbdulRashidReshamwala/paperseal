import { useEffect, useState, type ChangeEvent } from 'react';

import { activeKey, activePersona, becomePersona, personas } from './personas';
import { newUserAction, setTouchEnabled, touchEnabled } from './touch';

/** The bar across the top of every page in demo mode: who you are, and that the keys are simulated. */
export default function DemoBar() {
  const [touch, setTouch] = useState(() => touchEnabled());
  const persona = activePersona();

  useEffect(() => {
    // Capture, so a click counts as a new action before the page's own handler starts a ceremony.
    document.addEventListener('click', newUserAction, true);
    // Storage holds one person at a time, so another tab has to follow a switch.
    const follow = (event: StorageEvent) => {
      if (event.key === activeKey) globalThis.location.reload();
    };
    globalThis.addEventListener('storage', follow);
    return () => {
      document.removeEventListener('click', newUserAction, true);
      globalThis.removeEventListener('storage', follow);
    };
  }, []);

  const choose = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = personas.find(({ id }) => id === event.target.value);
    if (next && next.id !== persona.id) becomePersona(next);
  };
  const toggle = (event: ChangeEvent<HTMLInputElement>) => {
    setTouchEnabled(event.target.checked);
    setTouch(event.target.checked);
  };

  return (
    <div
      role="region"
      aria-label="Demo"
      data-demo-label="true"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 2147483000,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '4px 20px',
        padding: '6px 16px',
        font: '500 13px/1.3 var(--ps-sans, system-ui, sans-serif)',
        color: 'var(--ps-ink, #191a23)',
        background: 'var(--ps-paper-deep, #e8dfcd)',
        borderBottom: '1px dashed var(--ps-rule-strong, #85796a)',
      }}
    >
      <label style={{ fontWeight: 600 }}>
        Acting as{' '}
        <select value={persona.id} onChange={choose} style={{ font: 'inherit', fontWeight: 500 }}>
          {personas.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input type="checkbox" checked={touch} onChange={toggle} /> Ask for a touch
      </label>
      <span>Demo keys: every key here is simulated, and the touch is only for show.</span>
    </div>
  );
}
