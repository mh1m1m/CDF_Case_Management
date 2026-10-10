"use client";
/**
 * Horizontally scrollable container that becomes a focusable, labelled region only while its content
 * overflows (WCAG 2.1.1: keyboard users can scroll it; 2.4.3: no extra tab stop when nothing scrolls).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

export function CDFScrollRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScrollable(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return scrollable ? (
    <div ref={ref} role="region" aria-label={label} tabIndex={0} data-scrollable="true" className={className}>
      {children}
    </div>
  ) : (
    <div ref={ref} data-scrollable="false" className={className}>
      {children}
    </div>
  );
}
