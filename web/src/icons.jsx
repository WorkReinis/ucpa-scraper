// Small inline glyphs for the icon-led metadata rows (week cards, trip cost
// cards) -- thin stroke, currentColor, matched to the SF-Symbols-ish weight
// used across the rest of the UI. Plain constants, not components: they're
// static markup with no per-instance props, so there's no need to pay for a
// function call per render.

export const IconCalendar = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="2" y="3.5" width="12" height="10.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
    <path d="M2 6.5h12" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5.5 2v3M10.5 2v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export const IconPin = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 14.5s5-4.35 5-8A5 5 0 0 0 3 6.5c0 3.65 5 8 5 8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <circle cx="8" cy="6.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

export const IconLevel = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3 12V9M8 12V6M13 12V3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const IconCoaching = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3 9v-1a5 5 0 0 1 10 0v1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <rect x="2" y="9" width="2.6" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
    <rect x="11.4" y="9" width="2.6" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

export const IconClock = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
    <path d="M8 4.8V8l2.4 1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconSeat = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="4.5" r="2.3" stroke="currentColor" strokeWidth="1.4" />
    <path d="M3.5 13.5v-1a4.5 4.5 0 0 1 9 0v1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export const IconPlane = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M14.5 8 9.4 5.2V2.4C9.4 1.6 8.8.9 8 .9s-1.4.7-1.4 1.5v2.8L1.5 8v1.3l5.1-1.5v3.3l-1.5 1v1l2.9-.7 2.9.7v-1l-1.5-1V7.8l5.1 1.5V8Z" fill="currentColor" />
  </svg>
);

export const IconTicket = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2.5 4.5A1.5 1.5 0 0 0 4 3h8a1.5 1.5 0 0 0 1.5 1.5v1a1.5 1.5 0 0 1 0 3v1A1.5 1.5 0 0 0 12 11H4a1.5 1.5 0 0 0-1.5-1.5v-1a1.5 1.5 0 0 1 0-3v-1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M8 5v6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeDasharray="1.5 1.5" />
  </svg>
);

export const IconPeak = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2 12.5 L6 6.3 L8.3 9.7 L10.6 5.8 L14 12.5 Z" fill="currentColor" />
  </svg>
);

// Fill state varies per card (favorited or not), so this one's a function
// rather than a static const like the icons above.
export function IconHeart(filled) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} aria-hidden="true">
      <path
        d="M12 20.5S3.5 14.6 3.5 8.9A4.4 4.4 0 0 1 12 6.5a4.4 4.4 0 0 1 8.5 2.4c0 5.7-8.5 11.6-8.5 11.6Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const IconLayoutCompact = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="2" y="3" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.4" />
    <rect x="2" y="10" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

export const IconLayoutDetailed = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5 6h6M5 9h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export const IconSearch = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
    <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
