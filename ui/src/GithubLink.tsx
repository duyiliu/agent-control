import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { githubLink } from './api';

/**
 * Normal taps navigate with window.location.assign so iOS/Android see a
 * browser-initiated navigation, not a universal-link tap. The anchor href is
 * the same-origin redirector, which keeps long-press/copy-link in the browser.
 */
export default function GithubLink({
  url,
  children,
  onClick,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { url: string | null | undefined; children: ReactNode }) {
  if (!url) return null;
  return (
    <a
      {...rest}
      href={githubLink(url)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        window.location.assign(url);
      }}
    >
      {children}
    </a>
  );
}
