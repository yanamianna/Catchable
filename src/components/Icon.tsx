import type { CSSProperties, ReactNode } from 'react';

const paths: Record<string, ReactNode> = {
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></>,
  record: <><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
  settings: <><path d="m9 3-1 3-3 1v3l-2 2 2 2v3l3 1 1 3h6l1-3 3-1v-3l2-2-2-2V7l-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></>,
  external: <><path d="M14 3h7v7M21 3l-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></>,
  monitor: <><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M12 16v5M8 21h8"/></>,
  link: <><path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 9l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(0 -1)"/></>,
  plus: <path d="M12 4v16M4 12h16"/>,
  search: <><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></>,
  pause: <path d="M8 5v14M16 5v14"/>,
  play: <path d="m8 4 13 8-13 8Z"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  refresh: <><path d="M20 7a8 8 0 1 0 1 7M20 3v5h-5"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 7v.1"/></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></>,
  arrow: <path d="M12 4v16m-5-5 5 5 5-5"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  fork: <><path d="M7 3v18M4 3v6h6V3M16 3v18M16 3c-3 3-3 7 0 9"/></>,
};

export function Icon({ name, size = 20, style, className }: { name: string; size?: number; style?: CSSProperties; className?: string }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>{paths[name] ?? paths.info}</svg>;
}

export function EmptyTable() {
  return <svg aria-hidden="true" className="empty-illustration" width="132" height="116" viewBox="0 0 132 116" fill="none" strokeLinecap="round" strokeLinejoin="round">
    <path d="M66 6v16" stroke="#dadce0" strokeWidth="2"/><path d="M53 37c0-18 26-18 26 0H53Z" stroke="#ffc5a5" strokeWidth="2.5"/>
    <path d="M43 64h47M67 65v34M56 100h21M15 50l5 29h21l2 21M20 79l-4 21M117 50l-5 29H93l-2 21M112 79l4 21" stroke="#858992" strokeWidth="2.5"/>
  </svg>;
}
