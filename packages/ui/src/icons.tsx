import type { ReactNode } from 'react';

function Icon(props: { children: ReactNode }) {
  return (
    <svg
      className="ps-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  );
}

export const CheckIcon = () => (
  <Icon>
    <path d="M2.5 8.5 6.25 12 13.5 4" />
  </Icon>
);

export const CrossIcon = () => (
  <Icon>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </Icon>
);

export const ClockIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5V8l2.5 1.5" />
  </Icon>
);

export const DashIcon = () => (
  <Icon>
    <path d="M3 8h10" />
  </Icon>
);

export const CopyIcon = () => (
  <Icon>
    <path d="M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3" />
  </Icon>
);

export const KeyIcon = () => (
  <Icon>
    <circle cx="5" cy="11" r="3" />
    <path d="M7.25 8.75 13 3M10.5 5.5l2 2" />
  </Icon>
);
