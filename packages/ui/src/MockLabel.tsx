/**
 * "Mock data", fixed to the top of the window. The e2e mock suite's dev servers show it on every screen,
 * so no recording from them can be taken for a real run. It is a plain element with inline styles, and
 * the apps decide whether to render it.
 */
export function MockLabel() {
  return (
    <div
      role="note"
      data-mock-label="true"
      style={{
        position: 'fixed',
        top: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2147483000,
        padding: '4px 14px',
        font: '600 var(--ps-text-meta, 13px)/1.3 var(--ps-sans, system-ui, sans-serif)',
        color: 'var(--ps-ink, #191a23)',
        background: 'var(--ps-paper-deep, #e8dfcd)',
        border: '1px dashed var(--ps-rule-strong, #85796a)',
        borderTop: 0,
        pointerEvents: 'none',
      }}
    >
      Mock data
    </div>
  );
}
