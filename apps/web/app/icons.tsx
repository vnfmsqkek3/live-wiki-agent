import type { SVGProps } from 'react';

const paths = {
  home: 'M3 10 12 3l9 7v11h-6v-7H9v7H3z',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5',
  library: 'M4 4h16v5H4zM5 9v12h14V9M9 13h6',
  upload: 'M5 3h10l4 4v14H5zM15 3v5h4M12 18v-7m-3 3 3-3 3 3',
  approval: 'M8 4H5v17h14V4h-3M8 3h8v4H8zM8 12l2 2 5-5M8 18h7',
  guide: 'M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1m0-15c3-2 6-2 10-1v15c-4-1-7-1-10 1V5',
  shield: 'M12 2 3 6v6c0 5 5 8 9 10 4-2 9-5 9-10V6zM8 12l3 3 5-6',
  check: 'M4 12l5 5L20 6',
  alert: 'm12 3 10 18H2L12 3ZM12 9v5m0 3v1',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  user: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 21v-2a8 8 0 0 1 16 0v2',
  edit: 'M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4',
  download: 'M12 3v12m-5-5 5 5 5-5M4 19h16',
  message: 'M4 4h16v12H8l-4 4V4ZM8 9h8M8 12h5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}><path d={paths[name]} /></svg>;
}
